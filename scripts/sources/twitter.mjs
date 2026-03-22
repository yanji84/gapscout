/**
 * twitter.mjs — Twitter/X source for pain-point-finder
 *
 * Strategy (tried in order):
 *   1. Nitter instances — public Twitter mirrors, no login required
 *   2. Browser scraping x.com — Puppeteer fallback via connectBrowser
 *
 * Exports { name: 'twitter', commands: ['scan'], run, help }
 */

import https from 'node:https';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PAGE_DELAY_MS = 2500;
const JITTER_MS = 800;
const REQUEST_TIMEOUT_MS = 15000;

// Known Nitter instances to try in order
const NITTER_INSTANCES = [
  'nitter.privacydev.net',
  'nitter.poast.org',
  'nitter.catsarch.com',
  'nitter.1d4.us',
  'nitter.kavin.rocks',
];

// Pain-revealing search query templates
const PAIN_QUERY_TEMPLATES = [
  '{domain} frustrated OR hate OR terrible',
  '{domain} broken OR unusable OR nightmare',
  '{domain} alternative OR switched OR "wish there was"',
  '{domain} overpriced OR expensive OR "not worth"',
  '{domain} scam OR ripoff OR "giving up"',
  '{domain} bot OR scalper OR unfair',
  '{domain} "can\'t believe" OR ridiculous OR insane',
  '{domain} worst OR garbage OR awful',
];

async function politeDelay() {
  await sleep(PAGE_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

// ─── browser connection (copied from reddit-browser.mjs) ────────────────────

async function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.webSocketDebuggerUrl || null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

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
          const port = parseInt(lines[0].trim(), 10);
          const wsPath = lines[1].trim();
          const wsUrl = await probePort(port);
          if (wsUrl) {
            log(`[twitter] found Chrome at ws://127.0.0.1:${port}${wsPath}`);
            return wsUrl;
          }
        }
      }
    }
  }
  return null;
}

async function getWSFromPort(port) {
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
    log(`[twitter] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }
  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[twitter] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }
  const wsUrl = await findChromeWSEndpoint();
  if (wsUrl) {
    try { return await puppeteer.connect({ browserWSEndpoint: wsUrl }); }
    catch (err) { log(`[twitter] auto-detect failed: ${err.message}`); }
  }
  fail('No Chrome browser found. Start puppeteer-mcp-server, or pass --ws-url / --port');
}

// ─── Nitter scraping ─────────────────────────────────────────────────────────

function httpGetNitter(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname,
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; pain-point-finder/3.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        reject(new Error(`redirect:${res.headers.location}`));
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function probeNitterInstance(hostname) {
  try {
    const html = await httpGetNitter(hostname, '/search?q=test&f=tweets');
    // Check for Nitter-specific markers
    if (html.includes('class="tweet-') || html.includes('class="timeline-item"') || html.includes('nitter')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function findWorkingNitterInstance() {
  for (const instance of NITTER_INSTANCES) {
    log(`[twitter/nitter] probing ${instance}...`);
    const works = await probeNitterInstance(instance);
    if (works) {
      log(`[twitter/nitter] using ${instance}`);
      return instance;
    }
  }
  return null;
}

/**
 * Parse tweet HTML from a Nitter search results page.
 * Returns array of raw tweet objects.
 */
function parseNitterSearchPage(html, query) {
  const tweets = [];

  // Match timeline items — Nitter uses <div class="timeline-item"> or <div class="tweet-body">
  // We use regex since we can't run a DOM parser in Node without a dependency
  const itemPattern = /<div class="timeline-item[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  const tweetBodyPattern = /<div class="tweet-body">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;

  // Simpler approach: extract tweet-content blocks
  const contentPattern = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const statsPattern = /class="icon-(?:heart|retweet|reply)[^"]*"[\s\S]*?<span[^>]*>([\d,KMk.]+)<\/span>/g;
  const tweetLinkPattern = /href="\/([^/]+)\/status\/(\d+)"/g;
  const datePattern = /<span[^>]*title="([^"]+)"[^>]*>[^<]+<\/span>/g;
  const usernamePattern = /class="username"[^>]*>\s*@?([^<\s]+)\s*</g;

  // Split by timeline items
  const segments = html.split(/class="timeline-item/);
  if (segments.length <= 1) {
    // Try alternate structure
    return parseNitterAlternate(html);
  }

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];

    // Skip "show more" items
    if (seg.includes('show-more')) continue;

    // Extract tweet text
    const textMatch = seg.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const rawText = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';

    if (!rawText) continue;

    // Extract tweet URL and ID
    const linkMatch = seg.match(/href="\/([^/]+)\/status\/(\d+)"/);
    const author = linkMatch ? linkMatch[1] : '';
    const tweetId = linkMatch ? linkMatch[2] : `nitter_${i}`;

    // Extract engagement stats
    const likesMatch = seg.match(/class="icon-heart[^"]*"[\s\S]{0,200}?<span[^>]*>([\d,KMk.]+)<\/span>/);
    const retweetsMatch = seg.match(/class="icon-retweet[^"]*"[\s\S]{0,200}?<span[^>]*>([\d,KMk.]+)<\/span>/);
    const repliesMatch = seg.match(/class="icon-reply[^"]*"[\s\S]{0,200}?<span[^>]*>([\d,KMk.]+)<\/span>/);

    const likes = parseEngagementNum(likesMatch ? likesMatch[1] : '0');
    const retweets = parseEngagementNum(retweetsMatch ? retweetsMatch[1] : '0');
    const replies = parseEngagementNum(repliesMatch ? repliesMatch[1] : '0');

    tweets.push({
      id: tweetId,
      title: excerpt(rawText, 200),
      selftext: rawText,
      subreddit: 'twitter',
      score: likes + retweets,
      num_comments: replies,
      author,
      url: author ? `https://twitter.com/${author}/status/${tweetId}` : '',
      created_utc: 0,
      upvote_ratio: 0,
      flair: '',
    });
  }

  return tweets;
}

function parseNitterAlternate(html) {
  // Fallback: look for tweet-container or individual tweet blocks
  const tweets = [];
  const blocks = html.split(/class="tweet-(?:body|container)/);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const textMatch = block.match(/<div[^>]*class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!textMatch) continue;
    const rawText = textMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (!rawText) continue;
    const linkMatch = block.match(/href="\/([^/]+)\/status\/(\d+)"/);
    const author = linkMatch ? linkMatch[1] : '';
    const tweetId = linkMatch ? linkMatch[2] : `nitter_alt_${i}`;
    tweets.push({
      id: tweetId,
      title: excerpt(rawText, 200),
      selftext: rawText,
      subreddit: 'twitter',
      score: 0,
      num_comments: 0,
      author,
      url: author ? `https://twitter.com/${author}/status/${tweetId}` : '',
      created_utc: 0,
      upvote_ratio: 0,
      flair: '',
    });
  }
  return tweets;
}

function parseEngagementNum(str) {
  if (!str) return 0;
  const s = str.trim().toUpperCase();
  if (s.endsWith('K')) return Math.round(parseFloat(s) * 1000);
  if (s.endsWith('M')) return Math.round(parseFloat(s) * 1000000);
  return parseInt(s.replace(/,/g, ''), 10) || 0;
}

function extractNitterCursor(html) {
  // Nitter pagination: look for "Load more" link with cursor param
  const cursorMatch = html.match(/href="\/search\?[^"]*cursor=([^"&]+)/);
  if (cursorMatch) return decodeURIComponent(cursorMatch[1]);
  return null;
}

async function nitterSearchQuery(hostname, query, cursor = null) {
  let path = `/search?q=${encodeURIComponent(query)}&f=tweets`;
  if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
  const html = await httpGetNitter(hostname, path);
  const tweets = parseNitterSearchPage(html, query);
  const nextCursor = extractNitterCursor(html);
  return { tweets, nextCursor, html };
}

// ─── Browser (x.com) scraping ────────────────────────────────────────────────

async function scrapeXcomSearch(page, query, scrollCount = 5) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  log(`[twitter/browser] navigating to x.com search: "${query.substring(0, 50)}"`);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(3000);

  const tweets = [];
  const seenIds = new Set();

  for (let scroll = 0; scroll <= scrollCount; scroll++) {
    if (scroll > 0) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await sleep(2500);
    }

    const batch = await page.evaluate(() => {
      const results = [];
      // x.com tweet articles
      const articles = document.querySelectorAll('article[data-testid="tweet"]');

      for (const article of articles) {
        // Tweet text
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.textContent.trim() : '';
        if (!text) continue;

        // Tweet link / ID
        const timeLink = article.querySelector('time')?.closest('a');
        const href = timeLink ? timeLink.href : '';
        const idMatch = href.match(/\/status\/(\d+)/);
        const tweetId = idMatch ? idMatch[1] : '';
        const authorMatch = href.match(/x\.com\/([^/]+)\/status/);
        const author = authorMatch ? authorMatch[1] : '';

        // Engagement stats
        function getStat(testId) {
          const el = article.querySelector(`[data-testid="${testId}"]`);
          if (!el) return 0;
          const span = el.querySelector('span[data-testid="app-text-transition-container"] span');
          const text = span ? span.textContent.trim() : '0';
          if (!text || text === '') return 0;
          const upper = text.toUpperCase();
          if (upper.endsWith('K')) return Math.round(parseFloat(upper) * 1000);
          if (upper.endsWith('M')) return Math.round(parseFloat(upper) * 1000000);
          return parseInt(text.replace(/,/g, ''), 10) || 0;
        }

        const likes = getStat('like');
        const retweets = getStat('retweet');
        const replies = getStat('reply');

        results.push({
          id: tweetId || `xcom_${Date.now()}_${results.length}`,
          title: text.substring(0, 200),
          selftext: text,
          subreddit: 'twitter',
          score: likes + retweets,
          num_comments: replies,
          author,
          url: href || '',
          created_utc: 0,
          upvote_ratio: 0,
          flair: '',
        });
      }
      return results;
    });

    for (const t of batch) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        tweets.push(t);
      }
    }

    log(`[twitter/browser]   scroll ${scroll}: ${batch.length} tweets (${tweets.length} total)`);
  }

  return tweets;
}

// ─── scan command ─────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain || '';
  if (!domain) fail('--domain is required');

  const limit = args.limit || 100;
  const maxPages = args.pages || 10;  // pages per query for Nitter pagination

  log(`[twitter] scan domain="${domain}" limit=${limit} maxPages=${maxPages}`);

  // Build search queries
  const queries = PAIN_QUERY_TEMPLATES.map(t => t.replace('{domain}', domain));

  const postsById = new Map();

  // ── Strategy 1: Nitter ─────────────────────────────────────────────────────
  let nitterHost = null;
  if (!args.browserOnly) {
    nitterHost = await findWorkingNitterInstance();
  }

  if (nitterHost) {
    log(`[twitter/nitter] scraping via ${nitterHost}`);

    for (const query of queries) {
      log(`[twitter/nitter] query: "${query.substring(0, 60)}"`);
      let cursor = null;
      let pageCount = 0;

      while (pageCount < maxPages) {
        try {
          const { tweets, nextCursor } = await nitterSearchQuery(nitterHost, query, cursor);
          pageCount++;

          for (const t of tweets) {
            if (t.id && !postsById.has(t.id)) postsById.set(t.id, t);
          }
          log(`[twitter/nitter]   page ${pageCount}: ${tweets.length} tweets (${postsById.size} total)`);

          if (!nextCursor || tweets.length === 0) break;
          cursor = nextCursor;
          await politeDelay();
        } catch (err) {
          log(`[twitter/nitter]   error on page ${pageCount}: ${err.message}`);
          // If instance goes down mid-run, try next
          if (err.message.includes('503') || err.message.includes('timeout')) {
            log('[twitter/nitter] instance unhealthy, stopping Nitter queries');
            break;
          }
          break;
        }
      }

      await politeDelay();

      if (postsById.size >= limit * 3) {
        log(`[twitter/nitter] collected enough tweets, stopping early`);
        break;
      }
    }

    log(`[twitter/nitter] collected ${postsById.size} tweets via Nitter`);
  }

  // ── Strategy 2: Browser scraping x.com ────────────────────────────────────
  // Use browser if: Nitter not available, or user forces it, or we need more results
  const needsBrowser = !nitterHost || args.browser || postsById.size < 50;

  if (needsBrowser) {
    log(`[twitter/browser] falling back to x.com browser scraping`);
    let browser = null;
    let page = null;

    try {
      browser = await connectBrowser(args);
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });

      // Set a realistic user-agent
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      );

      const scrollsPerQuery = Math.max(3, Math.ceil(10 / queries.length));

      for (const query of queries) {
        if (postsById.size >= limit * 3) break;
        try {
          const tweets = await scrapeXcomSearch(page, query, scrollsPerQuery);
          for (const t of tweets) {
            if (t.id && !postsById.has(t.id)) postsById.set(t.id, t);
          }
          log(`[twitter/browser]   query done: ${tweets.length} new, ${postsById.size} total`);
          await politeDelay();
        } catch (err) {
          log(`[twitter/browser]   query failed: ${err.message}`);
        }
      }
    } finally {
      if (page) await page.close().catch(() => {});
    }

    log(`[twitter/browser] collected ${postsById.size} total tweets after browser pass`);
  }

  if (postsById.size === 0) {
    fail('No tweets collected. Check domain query or network access.');
  }

  // ── Score and output ───────────────────────────────────────────────────────
  const scored = [];
  for (const post of postsById.values()) {
    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    mode: nitterHost ? 'nitter' : 'browser',
    source: 'twitter',
    posts: scored.slice(0, limit),
    stats: {
      strategy: nitterHost ? `nitter:${nitterHost}` : 'x.com-browser',
      raw_tweets: postsById.size,
      after_scoring: scored.length,
      returned: Math.min(scored.length, limit),
    },
  });
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'twitter',
  description: 'Twitter/X — scrapes tweets via Nitter instances or x.com browser',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
twitter source — Twitter/X tweet scraping for pain points

Strategy (tried in order):
  1. Nitter public instances (no login required)
  2. Browser scraping x.com via Puppeteer

Commands:
  scan        Search Twitter for pain-revealing tweets about a domain

scan options:
  --domain <str>        Topic/product to search for (required)
  --limit <n>           Max tweets to return (default: 100)
  --pages <n>           Nitter pages per query (default: 10)
  --browser             Force browser scraping even if Nitter works
  --browser-only        Skip Nitter, use browser only

Connection options (browser fallback):
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  node scripts/cli.mjs twitter scan --domain "scalper bot" --limit 100
  node scripts/cli.mjs x scan --domain "ticket scalping" --limit 200
  node scripts/cli.mjs twitter scan --domain "SaaS billing" --browser
`,
};
