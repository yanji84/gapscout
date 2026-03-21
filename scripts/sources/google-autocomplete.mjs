/**
 * google-autocomplete.mjs — Google autocomplete + People Also Ask source
 *
 * Scrapes Google Search autocomplete suggestions and "People also ask" boxes
 * using pain-revealing query patterns for a given domain.
 *
 * Connects to an existing Chrome instance (same pattern as reddit-browser.mjs).
 * Falls back to the suggestqueries HTTP API if browser scraping fails.
 */

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import https from 'node:https';
import { sleep, log, ok, fail } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const SEARCH_DELAY_MS = 3000;
const JITTER_MS = 2000;
const AUTOCOMPLETE_API = 'https://suggestqueries.google.com/complete/search?client=firefox&q=';

async function politeDelay() {
  await sleep(SEARCH_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

// ─── browser connection (copied from reddit-browser.mjs) ────────────────────

async function findChromeWSEndpoint() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpdir = os.default.tmpdir();
  const entries = fs.default.readdirSync(tmpdir);
  for (const entry of entries) {
    if (entry.startsWith('puppeteer_dev_chrome_profile')) {
      const portFile = path.default.join(tmpdir, entry, 'DevToolsActivePort');
      if (fs.default.existsSync(portFile)) {
        const content = fs.default.readFileSync(portFile, 'utf8').trim();
        const lines = content.split('\n');
        if (lines.length >= 2) {
          const port = lines[0].trim();
          const wsPath = lines[1].trim();
          const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
          log(`[browser] found Chrome at ${wsUrl}`);
          return wsUrl;
        }
      }
    }
  }
  return null;
}

function getWSFromPort(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body).webSocketDebuggerUrl); }
        catch (err) { reject(new Error(`Cannot parse Chrome debug info: ${err.message}`)); }
      });
    }).on('error', reject);
  });
}

async function connectBrowser(args) {
  if (args.wsUrl) {
    log(`[browser] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }
  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[browser] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }
  const wsUrl = await findChromeWSEndpoint();
  if (wsUrl) {
    try { return await puppeteer.connect({ browserWSEndpoint: wsUrl }); }
    catch (err) { log(`[browser] auto-detect failed: ${err.message}`); }
  }
  fail('No Chrome browser found. Start puppeteer-mcp-server, or pass --ws-url / --port');
}

// ─── ID hashing ──────────────────────────────────────────────────────────────

function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

// ─── HTTP fallback: suggestqueries API ───────────────────────────────────────

function fetchAutocompleteAPI(query) {
  return new Promise((resolve) => {
    const url = AUTOCOMPLETE_API + encodeURIComponent(query);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          // Firefox client returns [query, [suggestions], ...]
          const suggestions = Array.isArray(parsed[1]) ? parsed[1] : [];
          resolve(suggestions);
        } catch {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

// ─── browser autocomplete scraping ──────────────────────────────────────────

async function scrapeAutocomplete(page, query) {
  try {
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(800);

    // Check for CAPTCHA
    const isCaptcha = await page.evaluate(() => {
      return document.title.toLowerCase().includes('sorry') ||
        !!document.querySelector('#captcha-form') ||
        !!document.querySelector('form[action*="sorry"]');
    });
    if (isCaptcha) {
      log(`[google-autocomplete] CAPTCHA detected, falling back to API for: ${query}`);
      return await fetchAutocompleteAPI(query);
    }

    // Find the search input and type the query
    const inputSel = 'textarea[name="q"], input[name="q"]';
    await page.waitForSelector(inputSel, { timeout: 10000 });
    await page.click(inputSel);
    await page.keyboard.selectAll();
    await page.keyboard.type(query, { delay: 60 });

    // Wait for suggestions to appear
    await sleep(1200);

    const suggestions = await page.evaluate(() => {
      // Google renders suggestions in a list; try multiple selector patterns
      const selectors = [
        'ul[role="listbox"] li[role="option"]',
        'ul[role="listbox"] li',
        '[role="option"]',
        '.sbct',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          return Array.from(els)
            .map(el => el.textContent.trim())
            .filter(t => t.length > 0)
            .slice(0, 10);
        }
      }
      return [];
    });

    if (suggestions.length > 0) return suggestions;

    // Fallback to API if browser gave nothing
    log(`[google-autocomplete] no browser suggestions for "${query}", trying API`);
    return await fetchAutocompleteAPI(query);
  } catch (err) {
    log(`[google-autocomplete] browser autocomplete error: ${err.message}`);
    return await fetchAutocompleteAPI(query);
  }
}

// ─── People Also Ask scraping ────────────────────────────────────────────────

async function scrapePeopleAlsoAsk(page, query) {
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(1500);

    // Check for CAPTCHA
    const isCaptcha = await page.evaluate(() => {
      return document.title.toLowerCase().includes('sorry') ||
        !!document.querySelector('#captcha-form') ||
        !!document.querySelector('form[action*="sorry"]');
    });
    if (isCaptcha) {
      log(`[google-autocomplete] CAPTCHA on SERP for: ${query}`);
      return [];
    }

    return await page.evaluate(() => {
      const questions = [];
      // PAA boxes use various selectors depending on Google's current layout
      const selectors = [
        '[data-q]',                            // data attribute approach
        '.related-question-pair',              // older layout
        'div[jsname] g-accordion-expander',    // newer accordion
        '[data-sgrd="q"]',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          for (const el of els) {
            const text = (el.getAttribute('data-q') || el.textContent || '').trim();
            if (text && text.length > 5 && text.endsWith('?')) {
              questions.push(text);
            }
          }
          if (questions.length > 0) break;
        }
      }
      // Broader fallback: look for question-shaped text in results
      if (questions.length === 0) {
        const allDivs = document.querySelectorAll('div[role="button"][aria-expanded]');
        for (const div of allDivs) {
          const text = div.textContent.trim();
          if (text.length > 10 && text.length < 200 && text.endsWith('?')) {
            questions.push(text);
          }
        }
      }
      return [...new Set(questions)].slice(0, 8);
    });
  } catch (err) {
    log(`[google-autocomplete] PAA scrape error: ${err.message}`);
    return [];
  }
}

// ─── normalize to common post shape ─────────────────────────────────────────

function makePost({ text, source, position, queryPattern }) {
  return {
    id: hashText(text),
    title: text,
    selftext: `Found via Google ${source === 'google-paa' ? '"People also ask"' : 'autocomplete'} for pattern: "${queryPattern}"`,
    subreddit: source,
    url: `https://www.google.com/search?q=${encodeURIComponent(text)}`,
    score: Math.max(1, 10 - position),  // position 0 = highest score
    num_comments: 0,
    upvote_ratio: 0,
    flair: queryPattern,
    created_utc: 0,
  };
}

// ─── main scan command ────────────────────────────────────────────────────────

async function cmdScan(args) {
  if (!args.domain) fail('--domain is required');
  const domain = args.domain;
  const limit = args.limit || 50;

  const queryPatterns = [
    `why is ${domain} so`,
    `${domain} problems`,
    `${domain} alternative`,
    `${domain} vs`,
    `${domain} complaints`,
    `${domain} not working`,
    `I hate ${domain}`,
  ];

  log(`[google-autocomplete] domain="${domain}", ${queryPatterns.length} query patterns`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();

  // Set a real user-agent to reduce bot detection
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const rawPosts = [];
  const seenIds = new Set();

  try {
    for (const pattern of queryPatterns) {
      // Autocomplete suggestions
      log(`[google-autocomplete] autocomplete: "${pattern}"`);
      try {
        const suggestions = await scrapeAutocomplete(page, pattern);
        log(`[google-autocomplete]   ${suggestions.length} suggestions`);
        for (let i = 0; i < suggestions.length; i++) {
          const text = suggestions[i];
          if (!text || text === pattern) continue;
          const post = makePost({ text, source: 'google-autocomplete', position: i, queryPattern: pattern });
          if (!seenIds.has(post.id)) {
            seenIds.add(post.id);
            rawPosts.push(post);
          }
        }
      } catch (err) {
        log(`[google-autocomplete] autocomplete failed for "${pattern}": ${err.message}`);
      }

      await politeDelay();

      // People Also Ask from the SERP
      log(`[google-autocomplete] people-also-ask: "${pattern}"`);
      try {
        const questions = await scrapePeopleAlsoAsk(page, pattern);
        log(`[google-autocomplete]   ${questions.length} PAA questions`);
        for (let i = 0; i < questions.length; i++) {
          const text = questions[i];
          if (!text) continue;
          const post = makePost({ text, source: 'google-paa', position: i, queryPattern: pattern });
          if (!seenIds.has(post.id)) {
            seenIds.add(post.id);
            rawPosts.push(post);
          }
        }
      } catch (err) {
        log(`[google-autocomplete] PAA failed for "${pattern}": ${err.message}`);
      }

      await politeDelay();
    }

    log(`[google-autocomplete] ${rawPosts.length} raw items, scoring...`);

    const scored = [];
    for (const post of rawPosts) {
      const enriched = enrichPost(post, domain);
      if (enriched) scored.push(enriched);
    }

    scored.sort((a, b) => b.painScore - a.painScore);

    ok({
      mode: 'google-autocomplete',
      posts: scored.slice(0, limit),
      stats: {
        query_patterns: queryPatterns.length,
        raw_items: rawPosts.length,
        after_filter: Math.min(scored.length, limit),
      },
    });
  } finally {
    await page.close();
  }
}

// ─── source export ───────────────────────────────────────────────────────────

export default {
  name: 'google-autocomplete',
  description: 'Google autocomplete + "People also ask" pain point discovery',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
google-autocomplete source — Google Search autocomplete & People Also Ask

Commands:
  scan        Scrape autocomplete suggestions and PAA boxes for a domain

scan options:
  --domain <str>    Domain or product name to investigate (required)
  --limit <n>       Max results (default: 50)

Connection options:
  --ws-url <url>    Chrome WebSocket URL (auto-detected if omitted)
  --port <n>        Chrome debug port (auto-detected if omitted)

Examples:
  pain-points google scan --domain "notion"
  pain-points google scan --domain "slack" --limit 30

Notes:
  - Uses Google autocomplete dropdown + PAA boxes from SERPs
  - Falls back to suggestqueries HTTP API if browser CAPTCHA is detected
  - Polite delays of 3-5 seconds between requests
`,
};
