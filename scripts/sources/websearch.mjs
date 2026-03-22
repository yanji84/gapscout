/**
 * websearch.mjs — Web search source for pain-point-finder
 *
 * Scrapes Google search results via Puppeteer to find complaints,
 * frustrations, and pain points across blogs, forums, and other
 * web sources not covered by the platform-specific scanners.
 *
 * Connects to an existing Chrome instance (same pattern as google-autocomplete.mjs).
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { connectBrowser as connectBrowserBase, politeDelay as politeDelayBase } from '../lib/browser.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const SEARCH_DELAY_MS = 2500;
const JITTER_MS = 1500;
const MAX_RETRIES = 2;
const PAGE_TIMEOUT_MS = 20000;

async function politeDelay() {
  await politeDelayBase(SEARCH_DELAY_MS, JITTER_MS);
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

// ─── scan command ────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 200;

  log(`[websearch] domain="${domain}", limit=${limit}`);

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
  log(`[websearch] running ${queries.length} search queries`);

  const seenUrls = new Set();
  const allResults = [];
  let queriesRun = 0;
  let captchaCount = 0;

  for (const query of queries) {
    if (captchaCount >= 3) {
      log(`[websearch] too many CAPTCHAs, stopping early after ${queriesRun} queries`);
      break;
    }

    if (allResults.length >= limit) {
      log(`[websearch] hit limit of ${limit}, stopping`);
      break;
    }

    log(`[websearch] query ${queriesRun + 1}/${queries.length}: ${query}`);

    let results = [];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        results = await scrapeGoogleResults(page, query);
        break;
      } catch (err) {
        log(`[websearch] scrape error (attempt ${attempt + 1}): ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(3000 * (attempt + 1));
      }
    }

    if (results.length === 0) {
      // Could be CAPTCHA
      captchaCount++;
    } else {
      captchaCount = 0; // Reset on success
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
        date: new Date().toISOString().split('T')[0],
      });
    }

    queriesRun++;
    await politeDelay();
  }

  // Close the page but don't disconnect the browser (shared instance)
  await page.close();

  // Sort: prefer results with longer snippets (more info)
  allResults.sort((a, b) => (b.body?.length || 0) - (a.body?.length || 0));

  const finalResults = allResults.slice(0, limit);

  // Also write to /tmp/ppf-websearch.json
  const fs = await import('node:fs');
  const output = { ok: true, data: { source: 'websearch', posts: finalResults, stats: { queries_run: queriesRun, raw_results: seenUrls.size, after_dedup: finalResults.length, captcha_hits: captchaCount } } };
  fs.writeFileSync('/tmp/ppf-websearch.json', JSON.stringify(output, null, 2));
  log(`[websearch] saved ${finalResults.length} results to /tmp/ppf-websearch.json`);

  ok({
    source: 'websearch',
    posts: finalResults,
    stats: {
      queries_run: queriesRun,
      raw_results: seenUrls.size,
      after_dedup: finalResults.length,
      captcha_hits: captchaCount,
    },
  });
}

// ─── source export ───────────────────────────────────────────────────────────

export default {
  name: 'websearch',
  description: 'Web search — Google SERP scraping for pain points across blogs, forums, and the wider web',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
websearch source — Google search scraping for pain-point discovery

Captures blog posts, forum threads, and other web sources not covered
by the platform-specific scanners (Reddit, HN, Product Hunt, etc.).

Commands:
  scan       Search Google for pain-point content related to a domain

scan options:
  --domain <str>          Domain/niche to search (required)
  --limit <n>             Max results to return (default: 200)
  --port <n>              Chrome debug port (default: 9222)
  --ws-url <str>          Chrome WebSocket URL

Examples:
  node scripts/cli.mjs websearch scan --domain "project management" --limit 200
  node scripts/cli.mjs websearch scan --domain "SaaS billing"
`,
};
