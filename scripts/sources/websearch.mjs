/**
 * websearch.mjs — Web search source for pain-point-finder
 *
 * Searches via SearXNG API (primary) or Google SERP scraping via Puppeteer
 * (fallback) to find complaints, frustrations, and pain points across blogs,
 * forums, and other web sources not covered by the platform-specific scanners.
 *
 * SearXNG priority:
 *   1. --searxng-url CLI arg or SEARXNG_URL env var (custom instance)
 *   2. Public SearXNG instance fallback list (probed automatically)
 *   3. Puppeteer Google scraping (last resort, requires Chrome)
 *
 * Use --api-only to skip browser fallback entirely.
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { connectBrowser as connectBrowserBase, politeDelay as politeDelayBase } from '../lib/browser.mjs';
import http from 'node:http';
import https from 'node:https';

// ─── constants ───────────────────────────────────────────────────────────────

const SEARCH_DELAY_MS = 2500;
const JITTER_MS = 1500;
const MAX_RETRIES = 2;
const PAGE_TIMEOUT_MS = 20000;
const SEARXNG_TIMEOUT_MS = 10000;
const SEARXNG_PROBE_TIMEOUT_MS = 5000;

let _tipShown = false;

const PUBLIC_SEARXNG_INSTANCES = [
  'https://searx.be/search',
  'https://search.sapti.me/search',
  'https://searx.tiekoetter.com/search',
];

async function politeDelay() {
  await politeDelayBase(SEARCH_DELAY_MS, JITTER_MS);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

/**
 * Simple HTTP(S) GET that returns a promise resolving to the response body string.
 * No external dependencies needed.
 */
function httpGet(url, timeoutMs = SEARXNG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); // drain
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

// ─── SearXNG API ─────────────────────────────────────────────────────────────

/**
 * Probe a SearXNG instance with a simple test query.
 * Returns the base search URL (without query params) if it responds, or null.
 */
async function probeSearxngInstance(searchUrl) {
  try {
    const separator = searchUrl.includes('?') ? '&' : '?';
    const testUrl = `${searchUrl}${separator}q=test&format=json&categories=general`;
    const body = await httpGet(testUrl, SEARXNG_PROBE_TIMEOUT_MS);
    const json = JSON.parse(body);
    if (json && Array.isArray(json.results)) {
      return searchUrl;
    }
  } catch {
    // Instance not reachable or not returning valid JSON
  }
  return null;
}

/**
 * Resolve the SearXNG search endpoint to use.
 * Priority: CLI arg > env var > public fallback list > null
 */
async function resolveSearxngUrl(args) {
  // 1. CLI arg --searxng-url
  const cliUrl = args.searxngUrl;
  if (cliUrl) {
    // Normalize: ensure it ends with /search if it looks like just a base URL
    const searchUrl = cliUrl.endsWith('/search') ? cliUrl : `${cliUrl.replace(/\/+$/, '')}/search`;
    log(`[websearch] probing custom SearXNG instance: ${searchUrl}`);
    const result = await probeSearxngInstance(searchUrl);
    if (result) {
      log(`[websearch] custom SearXNG instance is reachable`);
      return result;
    }
    log(`[websearch] custom SearXNG instance not reachable: ${searchUrl}`);
    return null;
  }

  // 2. Env var SEARXNG_URL
  const envUrl = process.env.SEARXNG_URL;
  if (envUrl) {
    const searchUrl = envUrl.endsWith('/search') ? envUrl : `${envUrl.replace(/\/+$/, '')}/search`;
    log(`[websearch] probing SearXNG from SEARXNG_URL env: ${searchUrl}`);
    const result = await probeSearxngInstance(searchUrl);
    if (result) {
      log(`[websearch] SearXNG from env is reachable`);
      return result;
    }
    log(`[websearch] SearXNG from env not reachable: ${searchUrl}`);
    return null;
  }

  // 3. Public fallback list — try each, use first that responds
  log(`[websearch] probing ${PUBLIC_SEARXNG_INSTANCES.length} public SearXNG instances...`);
  for (const instanceUrl of PUBLIC_SEARXNG_INSTANCES) {
    const result = await probeSearxngInstance(instanceUrl);
    if (result) {
      log(`[websearch] using public SearXNG instance: ${instanceUrl}`);
      return result;
    }
  }
  log(`[websearch] no public SearXNG instances reachable`);
  return null;
}

/**
 * Query SearXNG and return results in the same { url, title, snippet } format
 * as the Google scraper.
 */
async function querySearxng(searchUrl, query) {
  const separator = searchUrl.includes('?') ? '&' : '?';
  const url = `${searchUrl}${separator}q=${encodeURIComponent(query)}&format=json&categories=general`;

  const body = await httpGet(url);
  const json = JSON.parse(body);

  if (!json || !Array.isArray(json.results)) {
    return [];
  }

  return json.results.map((r) => ({
    url: r.url || '',
    title: r.title || '',
    snippet: r.content || '',
  })).filter((r) => r.url);
}

// ─── query generation ────────────────────────────────────────────────────────

/**
 * Build pain-point search queries for a domain.
 * Returns an array of query strings designed to surface complaints and frustrations.
 */
function buildSearchQueries(domain) {
  const patterns = [
    `"${domain}" frustrations`,
    `"${domain}" problems`,
    `"${domain}" complaints`,
    `"${domain}" alternative to`,
    `"${domain}" wish there was`,
    `why does "${domain}" suck`,
    `"${domain}" pain points`,
    `"${domain}" worst thing about`,
    `"${domain}" annoying`,
    `"${domain}" hate`,
    `"${domain}" broken`,
    `"${domain}" terrible experience`,
    `"${domain}" disappointed`,
    `"${domain}" overpriced`,
    `"${domain}" not working`,
    `"${domain}" issues`,
    `"${domain}" fails`,
    `"${domain}" looking for alternative`,
    `"${domain}" switched from`,
    `"${domain}" canceled because`,
    `"${domain}" left because`,
    `"${domain}" nightmare`,
    `"${domain}" ripoff`,
    `"${domain}" scam`,
    `"${domain}" too expensive`,
    `${domain} frustrations site:reddit.com OR site:news.ycombinator.com`,
    `${domain} complaints site:medium.com OR site:dev.to`,
    `${domain} problems forum`,
    `${domain} "I wish" OR "if only" OR "why can't"`,
    `${domain} "does anyone know" OR "looking for" alternative`,
  ];

  return patterns;
}

async function connectBrowser(args) {
  return connectBrowserBase(args, { logTag: 'websearch', tryPort9222: true, throwOnFail: true });
}

// ─── ID hashing ──────────────────────────────────────────────────────────────

function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

// ─── Google SERP scraping ────────────────────────────────────────────────────

/**
 * Scrape Google search results from a single query.
 * Returns array of { url, title, snippet } objects.
 */
async function scrapeGoogleResults(page, query) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    log(`[websearch] page load failed for query: ${err.message}`);
    return [];
  }

  // Wait briefly for results to render
  await sleep(800);

  // Check for CAPTCHA / consent page
  const pageContent = await page.content();
  if (pageContent.includes('detected unusual traffic') || pageContent.includes('recaptcha')) {
    log(`[websearch] CAPTCHA detected, skipping query`);
    return [];
  }

  // Extract search results using multiple selector strategies
  const results = await page.evaluate(() => {
    const items = [];

    // Strategy 1: Standard Google result divs
    const resultDivs = document.querySelectorAll('div.g');
    for (const div of resultDivs) {
      const linkEl = div.querySelector('a[href^="http"]');
      const titleEl = div.querySelector('h3');
      const snippetEl = div.querySelector('div[data-sncf], div.VwiC3b, span.aCOpRe, div[style*="-webkit-line-clamp"]');

      if (linkEl && titleEl) {
        const href = linkEl.getAttribute('href');
        // Skip Google's own pages
        if (href.includes('google.com/search') || href.includes('accounts.google.com')) continue;

        items.push({
          url: href,
          title: titleEl.textContent.trim(),
          snippet: snippetEl ? snippetEl.textContent.trim() : '',
        });
      }
    }

    // Strategy 2: Fallback — broader selector for search results
    if (items.length === 0) {
      const allLinks = document.querySelectorAll('a[href^="http"]');
      for (const link of allLinks) {
        const href = link.getAttribute('href');
        if (!href || href.includes('google.com') || href.includes('gstatic.com') || href.includes('googleapis.com')) continue;
        const h3 = link.querySelector('h3');
        if (h3) {
          const parent = link.closest('div');
          const snippetEl = parent ? parent.querySelector('span, div.VwiC3b') : null;
          items.push({
            url: href,
            title: h3.textContent.trim(),
            snippet: snippetEl ? snippetEl.textContent.trim() : '',
          });
        }
      }
    }

    return items;
  });

  return results;
}

// ─── SearXNG-based scan ─────────────────────────────────────────────────────

/**
 * Run all search queries via SearXNG API (no browser needed).
 * Returns { results, stats } in the same shape as the browser path.
 */
async function scanViaSearxng(searxngUrl, domain, limit) {
  const queries = buildSearchQueries(domain);
  log(`[websearch] [searxng] running ${queries.length} search queries via ${searxngUrl}`);

  const seenUrls = new Set();
  const allResults = [];
  let queriesRun = 0;
  let errorCount = 0;

  for (const query of queries) {
    if (allResults.length >= limit) {
      log(`[websearch] [searxng] hit limit of ${limit}, stopping`);
      break;
    }

    if (errorCount >= 5) {
      log(`[websearch] [searxng] too many errors (${errorCount}), stopping early`);
      break;
    }

    log(`[websearch] [searxng] query ${queriesRun + 1}/${queries.length}: ${query}`);

    let results = [];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        results = await querySearxng(searxngUrl, query);
        break;
      } catch (err) {
        log(`[websearch] [searxng] query error (attempt ${attempt + 1}): ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(1000 * (attempt + 1));
      }
    }

    if (results.length === 0) {
      errorCount++;
    } else {
      errorCount = 0;
    }

    for (const r of results) {
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);

      allResults.push({
        id: `ws-${hashText(r.url)}`,
        title: r.title || '',
        body: r.snippet || '',
        url: r.url,
        source: 'websearch',
        sourceQuery: query,
        searchBackend: 'searxng',
        date: new Date().toISOString().split('T')[0],
      });
    }

    queriesRun++;

    // Be polite to the SearXNG instance
    await sleep(500 + Math.random() * 500);
  }

  return {
    results: allResults,
    stats: {
      queries_run: queriesRun,
      raw_results: seenUrls.size,
      backend: 'searxng',
      searxng_url: searxngUrl,
      errors: errorCount,
    },
  };
}

// ─── Browser-based scan (Google SERP) ────────────────────────────────────────

/**
 * Run all search queries via Puppeteer Google scraping.
 * Returns { results, stats } in the same shape as the SearXNG path.
 */
async function scanViaBrowser(args, domain, limit) {
  let browser;
  try {
    browser = await connectBrowser(args);
  } catch (err) {
    fail(`Cannot connect to Chrome: ${err.message}. Launch Chrome with: google-chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check --user-data-dir=/tmp/ppf-chrome`);
  }

  const page = await browser.newPage();

  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Set viewport
  await page.setViewport({ width: 1280, height: 900 });

  const queries = buildSearchQueries(domain);
  log(`[websearch] [browser] running ${queries.length} search queries via Google SERP`);

  const seenUrls = new Set();
  const allResults = [];
  let queriesRun = 0;
  let captchaCount = 0;

  for (const query of queries) {
    if (captchaCount >= 3) {
      log(`[websearch] [browser] too many CAPTCHAs, stopping early after ${queriesRun} queries`);
      break;
    }

    if (allResults.length >= limit) {
      log(`[websearch] [browser] hit limit of ${limit}, stopping`);
      break;
    }

    log(`[websearch] [browser] query ${queriesRun + 1}/${queries.length}: ${query}`);

    let results = [];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        results = await scrapeGoogleResults(page, query);
        break;
      } catch (err) {
        log(`[websearch] [browser] scrape error (attempt ${attempt + 1}): ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(3000 * (attempt + 1));
      }
    }

    if (results.length === 0) {
      captchaCount++;
    } else {
      captchaCount = 0;
    }

    for (const r of results) {
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);

      allResults.push({
        id: `ws-${hashText(r.url)}`,
        title: r.title || '',
        body: r.snippet || '',
        url: r.url,
        source: 'websearch',
        sourceQuery: query,
        searchBackend: 'google-scrape',
        date: new Date().toISOString().split('T')[0],
      });
    }

    queriesRun++;
    await politeDelay();
  }

  // Close the page but don't disconnect the browser (shared instance)
  await page.close();

  return {
    results: allResults,
    stats: {
      queries_run: queriesRun,
      raw_results: seenUrls.size,
      backend: 'google-scrape',
      captcha_hits: captchaCount,
    },
  };
}

// ─── scan command ────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 200;
  const apiOnly = !!args.apiOnly;

  log(`[websearch] domain="${domain}", limit=${limit}, api-only=${apiOnly}`);

  // ── Try SearXNG first ──
  const searxngUrl = await resolveSearxngUrl(args);

  let scanResult;

  if (searxngUrl) {
    log(`[websearch] using SearXNG API: ${searxngUrl}`);
    scanResult = await scanViaSearxng(searxngUrl, domain, limit);
  } else if (apiOnly) {
    fail('No SearXNG instance available and --api-only was specified. Set SEARXNG_URL or pass --searxng-url.');
  } else {
    // ── Fall back to browser-based Google scraping ──
    if (!process.env.SEARXNG_URL && !_tipShown) {
      _tipShown = true;
      process.stderr.write('[websearch] tip: set SEARXNG_URL to skip browser requirement → docker run -p 8888:8080 searxng/searxng\n');
    }
    log(`[websearch] no SearXNG available, falling back to browser-based Google scraping`);
    scanResult = await scanViaBrowser(args, domain, limit);
  }

  const { results: allResults, stats } = scanResult;

  // Sort: prefer results with longer snippets (more info)
  allResults.sort((a, b) => (b.body?.length || 0) - (a.body?.length || 0));

  const finalResults = allResults.slice(0, limit);

  // Also write to /tmp/ppf-websearch.json
  const fs = await import('node:fs');
  const output = {
    ok: true,
    data: {
      source: 'websearch',
      posts: finalResults,
      stats: {
        ...stats,
        after_dedup: finalResults.length,
      },
    },
  };
  fs.writeFileSync('/tmp/ppf-websearch.json', JSON.stringify(output, null, 2));
  log(`[websearch] saved ${finalResults.length} results to /tmp/ppf-websearch.json`);

  ok({
    source: 'websearch',
    posts: finalResults,
    stats: {
      ...stats,
      after_dedup: finalResults.length,
    },
  });
}

// ─── source export ───────────────────────────────────────────────────────────

export default {
  name: 'websearch',
  description: 'Web search — SearXNG API (primary) or Google SERP scraping (fallback) for pain points',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
websearch source — SearXNG API + Google SERP scraping for pain-point discovery

Captures blog posts, forum threads, and other web sources not covered
by the platform-specific scanners (Reddit, HN, Product Hunt, etc.).

Search backend priority:
  1. SearXNG instance (via --searxng-url or SEARXNG_URL env var)
  2. Public SearXNG instances (auto-probed fallback list)
  3. Puppeteer Google SERP scraping (last resort, requires Chrome)

Commands:
  scan       Search for pain-point content related to a domain

scan options:
  --domain <str>          Domain/niche to search (required)
  --limit <n>             Max results to return (default: 200)
  --searxng-url <url>     SearXNG instance URL (e.g., http://localhost:8888)
  --api-only              Only use SearXNG API, skip browser fallback entirely
  --port <n>              Chrome debug port (default: 9222, browser fallback only)
  --ws-url <str>          Chrome WebSocket URL (browser fallback only)

Environment variables:
  SEARXNG_URL             SearXNG instance base URL (e.g., http://localhost:8888)

Examples:
  # Auto-detect SearXNG, fall back to browser
  node scripts/cli.mjs websearch scan --domain "project management" --limit 200

  # Use a specific SearXNG instance
  node scripts/cli.mjs websearch scan --domain "SaaS billing" --searxng-url http://localhost:8888

  # API only (no browser needed)
  node scripts/cli.mjs websearch scan --domain "SaaS billing" --api-only

  # Force browser fallback (no SearXNG)
  node scripts/cli.mjs websearch scan --domain "SaaS billing" --port 9222
`,
};
