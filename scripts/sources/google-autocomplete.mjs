/**
 * google-autocomplete.mjs — Google autocomplete + People Also Ask source
 *
 * Scrapes Google Search autocomplete suggestions and "People also ask" boxes
 * using pain-revealing query patterns for a given domain.
 *
 * Default: uses the suggestqueries HTTP API (no browser needed).
 * With --browser: connects to Chrome for PAA & Related Searches scraping.
 *
 * Upgrades:
 *  - Recursive expansion (--depth, default 2): re-query each result + a-z letters
 *  - 200+ seed queries: 11 platforms × 10 patterns, programmatically generated
 *  - Multi-language seeds: Chinese, Japanese, Korean ticket-scalping terms
 *  - Related searches scraping from bottom of SERP
 */

import http from 'node:http';
import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { connectBrowser as connectBrowserBase, politeDelay as politeDelayBase, detectBlockInPage, createBlockTracker, enableResourceBlocking } from '../lib/browser.mjs';
import { Logger } from '../lib/logger.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const SEARCH_DELAY_MS = 1200;
const JITTER_MS = 800;
const AUTOCOMPLETE_API = 'https://suggestqueries.google.com/complete/search?client=firefox&q=';
const DEFAULT_MAX_REQUESTS = 200;

// Language-specific API endpoint that accepts hl param
const AUTOCOMPLETE_API_LANG = 'https://suggestqueries.google.com/complete/search?client=firefox&hl=';

async function politeDelay() {
  await politeDelayBase(SEARCH_DELAY_MS, JITTER_MS);
}

// ─── seed generation ──────────────────────────────────────────────────────────

const PLATFORMS = [
  'ticketmaster', 'stubhub', 'seatgeek', 'axs',
  'nike snkrs', 'adidas confirmed', 'goat', 'stockx',
  'foot locker', 'resy', 'opentable',
];

const QUERY_PATTERNS = [
  'why is X so',
  'X not working',
  'i hate X',
  'X alternative',
  'X complaints',
  'X vs',
  'X problems',
  'X bot',
  'X scam',
  'X unfair',
];

// Language seeds for ticket-scalping / bot pain signals
const LANG_SEEDS = {
  zh: [
    '抢票', '黄牛', '秒杀', '抢购机器人', '抢票软件',
    '抢票 怎么', '黄牛 投诉', '秒杀 失败', '抢票 不公平',
  ],
  ja: [
    '転売ヤー', 'チケット転売', 'ボット購入',
    'チケット 買えない', '転売 対策', 'チケット 不正',
  ],
  ko: [
    '티켓 봇', '리셀러', '티켓팅 실패',
    '암표 신고', '티켓 자동구매', '티켓 불공정',
  ],
};

/**
 * Build the full set of seed queries for a domain.
 * If domain matches one of PLATFORMS, it uses all 11; otherwise just the given domain.
 */
function buildSeeds(domain, langs) {
  const seeds = new Set();

  // Base: domain × patterns
  const platforms = PLATFORMS.includes(domain.toLowerCase())
    ? PLATFORMS
    : [domain];

  for (const platform of platforms) {
    for (const pattern of QUERY_PATTERNS) {
      seeds.add(pattern.replace('X', platform));
    }
  }

  // Multi-language seeds (always included when langs specified)
  if (langs && langs.length > 0) {
    for (const lang of langs) {
      const langSeeds = LANG_SEEDS[lang];
      if (langSeeds) {
        for (const s of langSeeds) seeds.add(s);
      }
    }
  }

  return [...seeds];
}

async function connectBrowser(args) {
  return connectBrowserBase(args, { logTag: 'google', throwOnFail: true });
}

// ─── ID hashing ──────────────────────────────────────────────────────────────

function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

// ─── SearXNG PAA/suggestions helper ──────────────────────────────────────────

const SEARXNG_TIMEOUT_MS = 10000;

/**
 * Simple HTTP(S) GET returning a promise that resolves to the response body string.
 */
function httpGetRaw(url, timeoutMs = SEARXNG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
}

/**
 * Query SearXNG for PAA-like data: suggestions and infobox content.
 * Returns { suggestions: string[], infoboxes: string[] }.
 */
async function querySearxngForPAA(searxngUrl, query) {
  const baseUrl = searxngUrl.endsWith('/search') ? searxngUrl.replace(/\/search$/, '') : searxngUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;

  try {
    const body = await httpGetRaw(url);
    const json = JSON.parse(body);

    const suggestions = Array.isArray(json.suggestions) ? json.suggestions : [];
    const infoboxes = [];
    if (Array.isArray(json.infoboxes)) {
      for (const box of json.infoboxes) {
        if (box.content) infoboxes.push(box.content);
        if (box.title) infoboxes.push(box.title);
      }
    }

    return { suggestions, infoboxes };
  } catch (err) {
    log(`[google-autocomplete] SearXNG query failed for "${query}": ${err.message}`);
    return { suggestions: [], infoboxes: [] };
  }
}

// ─── HTTP fallback: suggestqueries API ───────────────────────────────────────

function fetchAutocompleteAPI(query, lang) {
  return new Promise((resolve) => {
    let url;
    if (lang && lang !== 'en') {
      url = `${AUTOCOMPLETE_API_LANG}${encodeURIComponent(lang)}&q=${encodeURIComponent(query)}`;
    } else {
      url = AUTOCOMPLETE_API + encodeURIComponent(query);
    }
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

// ─── recursive expansion ─────────────────────────────────────────────────────

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Fetch autocomplete for a query, then recursively expand each result by
 * appending each letter a-z, up to `maxDepth` levels.
 *
 * Returns a flat array of { text, queryPattern } objects.
 */
async function expandQuery(query, queryPattern, depth, maxDepth, seenQueries, lang, fetchFn, reqCounter) {
  if (reqCounter && reqCounter.count >= reqCounter.max) {
    if (!reqCounter.warned) {
      log(`[google-autocomplete] request cap reached (${reqCounter.max}), skipping further expansion`);
      reqCounter.warned = true;
    }
    return [];
  }

  if (seenQueries.has(query)) return [];
  seenQueries.add(query);

  if (reqCounter) reqCounter.count++;
  const suggestions = await fetchFn(query, lang);
  await politeDelay();

  const results = suggestions.map((text, i) => ({ text, queryPattern, position: i }));

  if (depth < maxDepth) {
    for (const suggestion of suggestions) {
      if (!suggestion) continue;
      if (reqCounter && reqCounter.count >= reqCounter.max) break;
      // Expand the suggestion itself with a-z appended
      for (const letter of ALPHABET) {
        if (reqCounter && reqCounter.count >= reqCounter.max) break;
        const subQuery = `${suggestion} ${letter}`;
        if (!seenQueries.has(subQuery)) {
          const subResults = await expandQuery(
            subQuery, queryPattern, depth + 1, maxDepth, seenQueries, lang, fetchFn, reqCounter
          );
          for (const r of subResults) results.push(r);
        }
      }
    }
  }

  return results;
}

// ─── browser autocomplete scraping ──────────────────────────────────────────

async function scrapeAutocomplete(page, query, blockTracker) {
  try {
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(600 + Math.floor(Math.random() * 400));

    // Check for block/CAPTCHA using shared detector
    const blockResult = await detectBlockInPage(page);
    if (blockResult.blocked) {
      log(`[google-autocomplete] ${blockResult.reason} detected, falling back to API for: ${query}`);
      if (blockTracker) blockTracker.recordBlock(blockResult.reason);
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

async function scrapePeopleAlsoAsk(page, query, blockTracker) {
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(1200 + Math.floor(Math.random() * 600));

    // Check for block/CAPTCHA using shared detector
    const blockResult = await detectBlockInPage(page);
    if (blockResult.blocked) {
      log(`[google-autocomplete] ${blockResult.reason} on SERP for: ${query}`);
      if (blockTracker) blockTracker.recordBlock(blockResult.reason);
      return { paa: [], related: [] };
    }
    if (blockTracker) blockTracker.recordSuccess();

    return await page.evaluate(() => {
      // ── People Also Ask ──
      const questions = [];
      const paaSelectors = [
        '[data-q]',
        '.related-question-pair',
        'div[jsname] g-accordion-expander',
        '[data-sgrd="q"]',
      ];
      for (const sel of paaSelectors) {
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
      // Broader PAA fallback
      if (questions.length === 0) {
        const allDivs = document.querySelectorAll('div[role="button"][aria-expanded]');
        for (const div of allDivs) {
          const text = div.textContent.trim();
          if (text.length > 10 && text.length < 200 && text.endsWith('?')) {
            questions.push(text);
          }
        }
      }

      // ── Related Searches (bottom of SERP) ──
      const related = [];
      const relatedSelectors = [
        // Modern Google layout
        '[data-xbu]',
        'div.oIk2Cb a',
        'div[jscontroller] .k8XOCe',
        // Older layouts
        '#brs .brs_col p a',
        '.brs_col p a',
        // Generic "searches related to" block
        'a[href*="/search?q="][data-ved]',
      ];
      const seenRelated = new Set();
      for (const sel of relatedSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = (el.textContent || '').trim();
          if (text && text.length > 5 && text.length < 150 && !seenRelated.has(text)) {
            seenRelated.add(text);
            related.push(text);
          }
        }
        if (related.length >= 8) break;
      }

      return {
        paa: [...new Set(questions)].slice(0, 8),
        related: related.slice(0, 8),
      };
    });
  } catch (err) {
    log(`[google-autocomplete] PAA scrape error: ${err.message}`);
    return { paa: [], related: [] };
  }
}

// ─── normalize to common post shape ─────────────────────────────────────────

function makePost({ text, source, position, queryPattern }) {
  return {
    id: hashText(text),
    title: text,
    selftext: `Found via Google ${source === 'google-paa' ? '"People also ask"' : source === 'google-related' ? '"Related searches"' : 'autocomplete'} for pattern: "${queryPattern}"`,
    subreddit: source,
    url: `https://www.google.com/search?q=${encodeURIComponent(text)}`,
    score: Math.max(1, 10 - position),  // position 0 = highest score
    num_comments: 0,
    upvote_ratio: 0,
    flair: queryPattern,
    created_utc: 0,
  };
}

// ─── shared scoring/output helper ────────────────────────────────────────────

function scoreAndOutput({ rawPosts, domain, limit, queryPatterns, blockStats, logger }) {
  log(`[google-autocomplete] ${rawPosts.length} raw items, scoring...`);

  // Save ALL raw posts before filtering for LLM batch-evaluation
  try {
    const rawOutput = { ok: true, data: { source: 'google-autocomplete', posts: rawPosts, stats: { raw: true, total: rawPosts.length } } };
    writeFileSync('/tmp/gapscout-google-raw.json', JSON.stringify(rawOutput));
    log(`[google-autocomplete] saved ${rawPosts.length} raw posts to /tmp/gapscout-google-raw.json`);
  } catch (err) {
    log(`[google-autocomplete] failed to save raw posts: ${err.message}`);
  }

  const scored = [];
  for (const post of rawPosts) {
    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }
  scored.sort((a, b) => b.painScore - a.painScore);

  if (blockStats?.blocked > 0) {
    logger?.warn(`${blockStats.blocked} request(s) were blocked`, { blocked: blockStats.blocked });
  }
  if (blockStats?.rateLimitWarnings > 0) {
    logger?.warn(`${blockStats.rateLimitWarnings} rate limit warning(s)`, { rateLimitWarnings: blockStats.rateLimitWarnings });
  }

  const _logEvents = logger ? logger.export() : [];

  ok({
    mode: 'google-autocomplete',
    posts: scored.slice(0, limit),
    stats: {
      query_patterns: queryPatterns.length,
      raw_items: rawPosts.length,
      after_filter: Math.min(scored.length, limit),
      blocked: blockStats?.blocked || 0,
      rateLimitWarnings: blockStats?.rateLimitWarnings || 0,
    },
    _observability: _logEvents,
  });
}

// ─── API-only scan (no browser required) ─────────────────────────────────────

async function cmdScanApiOnly({ domain, limit, queryPatterns, depth, langs, maxRequests, logger }) {
  const rawPosts = [];
  const seenIds = new Set();
  const seenQueries = new Set();
  const reqCounter = { count: 0, max: maxRequests || DEFAULT_MAX_REQUESTS, warned: false };

  const effectiveDepth = depth != null ? depth : 2;

  for (const pattern of queryPatterns) {
    if (reqCounter.count >= reqCounter.max) {
      log(`[google-autocomplete] request cap reached (${reqCounter.max}), stopping seed loop`);
      break;
    }

    log(`[google-autocomplete] API autocomplete (depth=${effectiveDepth}): "${pattern}"`);

    // Determine lang for this seed (lang seeds are passed individually)
    const lang = null; // seeds already contain the language text; API default is fine

    const expanded = await expandQuery(
      pattern, pattern, 0, effectiveDepth, seenQueries, lang,
      (q, l) => fetchAutocompleteAPI(q, l),
      reqCounter
    );

    log(`[google-autocomplete]   ${expanded.length} total expanded results`);
    for (const { text, queryPattern, position } of expanded) {
      if (!text || text === pattern) continue;
      const post = makePost({ text, source: 'google-autocomplete', position, queryPattern });
      if (!seenIds.has(post.id)) {
        seenIds.add(post.id);
        rawPosts.push(post);
      }
    }
  }

  log(`[google-autocomplete] total API requests made: ${reqCounter.count}`);
  scoreAndOutput({ rawPosts, domain, limit, queryPatterns, logger });
}

// ─── API + SearXNG scan (no browser required) ────────────────────────────────

/**
 * Combines Google autocomplete API for suggestions with SearXNG JSON API
 * for PAA-like data (suggestions + infoboxes). No browser needed.
 */
async function cmdScanApiWithSearxng({ domain, limit, queryPatterns, depth, langs, maxRequests, logger, searxngUrl }) {
  const rawPosts = [];
  const seenIds = new Set();
  const seenQueries = new Set();
  const reqCounter = { count: 0, max: maxRequests || DEFAULT_MAX_REQUESTS, warned: false };

  const effectiveDepth = depth != null ? depth : 2;

  for (const pattern of queryPatterns) {
    if (reqCounter.count >= reqCounter.max) {
      log(`[google-autocomplete] request cap reached (${reqCounter.max}), stopping seed loop`);
      break;
    }

    // 1. Google autocomplete API (same as API-only mode)
    log(`[google-autocomplete] API autocomplete (depth=${effectiveDepth}): "${pattern}"`);

    const expanded = await expandQuery(
      pattern, pattern, 0, effectiveDepth, seenQueries, null,
      (q, l) => fetchAutocompleteAPI(q, l),
      reqCounter
    );

    log(`[google-autocomplete]   ${expanded.length} total expanded results`);
    for (const { text, queryPattern, position } of expanded) {
      if (!text || text === pattern) continue;
      const post = makePost({ text, source: 'google-autocomplete', position, queryPattern });
      if (!seenIds.has(post.id)) {
        seenIds.add(post.id);
        rawPosts.push(post);
      }
    }

    // 2. SearXNG suggestions + infoboxes (replaces browser PAA)
    if (reqCounter.count < reqCounter.max) {
      log(`[google-autocomplete] SearXNG PAA/suggestions: "${pattern}"`);
      const { suggestions, infoboxes } = await querySearxngForPAA(searxngUrl, pattern);
      reqCounter.count++;

      log(`[google-autocomplete]   ${suggestions.length} SearXNG suggestions, ${infoboxes.length} infoboxes`);

      for (let i = 0; i < suggestions.length; i++) {
        const text = suggestions[i];
        if (!text) continue;
        const post = makePost({ text, source: 'searxng-suggestion', position: i, queryPattern: pattern });
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          rawPosts.push(post);
        }
      }

      for (let i = 0; i < infoboxes.length; i++) {
        const text = infoboxes[i];
        if (!text) continue;
        const post = makePost({ text, source: 'searxng-infobox', position: i, queryPattern: pattern });
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          rawPosts.push(post);
        }
      }

      // Polite delay between SearXNG requests
      await sleep(500 + Math.random() * 500);
    }
  }

  log(`[google-autocomplete] total requests made: ${reqCounter.count} (API + SearXNG)`);
  scoreAndOutput({ rawPosts, domain, limit, queryPatterns, logger });
}

// ─── main scan command ────────────────────────────────────────────────────────

async function cmdScan(args) {
  const logger = new Logger('google-autocomplete');

  if (!args.domain) fail('--domain is required');
  const domain = args.domain;
  const limit = args.limit || 50;
  const useBrowser = args.browser || false;
  const apiOnly = !useBrowser;
  const depth = args.depth != null ? Number(args.depth) : 2;

  // Parse --langs flag: comma-separated language codes (e.g. "zh,ja,ko")
  let langs = [];
  if (args.langs) {
    langs = String(args.langs).split(',').map(l => l.trim()).filter(Boolean);
  }

  const queryPatterns = buildSeeds(domain, langs);

  log(`[google-autocomplete] domain="${domain}", ${queryPatterns.length} seed patterns, depth=${depth}`);

  const maxRequests = args['max-requests'] != null ? Number(args['max-requests']) : undefined;
  const searxngUrl = process.env.SEARXNG_URL || null;

  // API-only mode (default when --browser is not set)
  if (apiOnly) {
    if (searxngUrl) {
      // SearXNG available: use API autocomplete + SearXNG for supplemental suggestions
      log(`[google-autocomplete] API mode with SearXNG supplement at ${searxngUrl}`);
      return cmdScanApiWithSearxng({ domain, limit, queryPatterns, depth, langs, maxRequests, logger, searxngUrl });
    }
    log(`[google-autocomplete] API mode (default): using suggestqueries HTTP API`);
    return cmdScanApiOnly({ domain, limit, queryPatterns, depth, langs, maxRequests, logger });
  }

  // If SEARXNG_URL is set, use SearXNG for PAA instead of browser
  if (searxngUrl) {
    log(`[google-autocomplete] SEARXNG_URL is set — using SearXNG for PAA/related data instead of browser`);
    return cmdScanApiWithSearxng({ domain, limit, queryPatterns, depth, langs, maxRequests, logger, searxngUrl });
  }

  // Try to connect browser; fall back to API-only if unavailable
  let browser, page;
  try {
    browser = await connectBrowser(args);
    page = await browser.newPage();
    await enableResourceBlocking(page);
  } catch (err) {
    logger.warn(`browser unavailable, falling back to HTTP API`, { error: err.message });
    return cmdScanApiOnly({ domain, limit, queryPatterns, depth, langs, maxRequests, logger });
  }

  // Set a real user-agent to reduce bot detection
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const rawPosts = [];
  const seenIds = new Set();
  const seenQueries = new Set();
  const blockTracker = createBlockTracker('google-autocomplete');
  const reqCounter = { count: 0, max: maxRequests || DEFAULT_MAX_REQUESTS, warned: false };

  // Browser fetch wrapper for recursive expansion
  const browserFetch = async (query, lang) => {
    if (blockTracker.shouldStop) return [];
    const results = await scrapeAutocomplete(page, query, blockTracker);
    if (results.length > 0) blockTracker.recordSuccess();
    await politeDelay();
    return results;
  };

  try {
    for (const pattern of queryPatterns) {
      if (blockTracker.shouldStop) {
        log(`[google-autocomplete] stopping early due to repeated blocks`);
        break;
      }
      if (reqCounter.count >= reqCounter.max) {
        log(`[google-autocomplete] request cap reached (${reqCounter.max}), stopping seed loop`);
        break;
      }

      // Autocomplete suggestions with recursive expansion
      log(`[google-autocomplete] autocomplete (depth=${depth}): "${pattern}"`);
      try {
        const expanded = await expandQuery(
          pattern, pattern, 0, depth, seenQueries, null, browserFetch, reqCounter
        );
        log(`[google-autocomplete]   ${expanded.length} expanded suggestions`);
        for (const { text, queryPattern, position } of expanded) {
          if (!text || text === pattern) continue;
          const post = makePost({ text, source: 'google-autocomplete', position, queryPattern });
          if (!seenIds.has(post.id)) {
            seenIds.add(post.id);
            rawPosts.push(post);
          }
        }
      } catch (err) {
        log(`[google-autocomplete] autocomplete failed for "${pattern}": ${err.message}`);
      }

      if (blockTracker.shouldStop) break;
      await politeDelay();

      // People Also Ask + Related Searches from the SERP
      log(`[google-autocomplete] SERP (PAA + related): "${pattern}"`);
      try {
        const { paa, related } = await scrapePeopleAlsoAsk(page, pattern, blockTracker);
        log(`[google-autocomplete]   ${paa.length} PAA, ${related.length} related`);
        for (let i = 0; i < paa.length; i++) {
          const text = paa[i];
          if (!text) continue;
          const post = makePost({ text, source: 'google-paa', position: i, queryPattern: pattern });
          if (!seenIds.has(post.id)) {
            seenIds.add(post.id);
            rawPosts.push(post);
          }
        }
        for (let i = 0; i < related.length; i++) {
          const text = related[i];
          if (!text) continue;
          const post = makePost({ text, source: 'google-related', position: i, queryPattern: pattern });
          if (!seenIds.has(post.id)) {
            seenIds.add(post.id);
            rawPosts.push(post);
          }
        }
      } catch (err) {
        log(`[google-autocomplete] SERP scrape failed for "${pattern}": ${err.message}`);
      }

      await politeDelay();
    }

    log(`[google-autocomplete] total requests made: ${reqCounter.count}`);
    scoreAndOutput({ rawPosts, domain, limit, queryPatterns, blockStats: blockTracker.stats, logger });
  } finally {
    try { await page.close(); } catch { /* ignore if already closed */ }
  }
}

// ─── source export ───────────────────────────────────────────────────────────

export default {
  name: 'google-autocomplete',
  description: 'Google autocomplete + "People also ask" + "Related searches" pain point discovery',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
google-autocomplete source — Google Search autocomplete, PAA & Related searches

Commands:
  scan        Scrape autocomplete suggestions, PAA boxes, and related searches

scan options:
  --domain <str>    Domain or product name to investigate (required)
  --limit <n>       Max results (default: 50)
  --depth <n>       Recursive expansion depth (default: 2, 0 = no expansion)
  --max-requests <n> Cap on total API/fetch requests (default: 200)
  --langs <codes>   Comma-separated language codes for extra seeds: zh,ja,ko
  --browser         Use browser mode for PAA & Related Searches (default: API-only)

Connection options (browser mode, requires --browser):
  --ws-url <url>    Chrome WebSocket URL (auto-detected if omitted)
  --port <n>        Chrome debug port (auto-detected if omitted)

Environment variables:
  SEARXNG_URL       Self-hosted SearXNG base URL (e.g., http://localhost:8080).
                    When set, SearXNG replaces browser for PAA/related data.
                    Autocomplete still uses Google suggestqueries API.

For best results, self-host SearXNG:
  docker run -p 8080:8080 searxng/searxng
  export SEARXNG_URL=http://localhost:8080

Examples:
  # With SearXNG (recommended — no browser needed for PAA)
  export SEARXNG_URL=http://localhost:8080
  pain-points google scan --domain "ticketmaster"

  pain-points google scan --domain "ticketmaster"
  pain-points google scan --domain "ticketmaster" --depth 1 --limit 200
  pain-points google scan --domain "ticketmaster" --langs zh,ja,ko --depth 2
  pain-points google scan --domain "ticketmaster" --browser
  pain-points google scan --domain "slack" --limit 30

Seed coverage:
  11 platforms × 10 patterns = 110 base seeds
  + multi-language seeds when --langs specified
  Recursive expansion: each seed × 26 letters × depth = ~1,300+ signals per seed

Notes:
  - Default: API-only mode using suggestqueries HTTP API (no browser needed)
  - When SEARXNG_URL is set: also queries SearXNG for suggestions/infoboxes (no browser)
  - With --browser (and no SEARXNG_URL): scrapes PAA boxes + Related searches from SERPs
  - Polite delays between requests to avoid rate-limiting
`,
};
