/**
 * producthunt.mjs — Product Hunt source for pain-point-finder
 *
 * Scrapes producthunt.com via Puppeteer. Connects to an existing Chrome
 * instance (e.g. from puppeteer-mcp-server) or accepts --ws-url / --port.
 *
 * Searches for products related to a --domain, scrapes product pages,
 * and extracts pain-signal comments (feature requests, complaints,
 * switching mentions).
 */

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PH_BASE = 'https://www.producthunt.com';
const PAGE_DELAY_MS = 3000;

async function politeDelay() {
  await sleep(PAGE_DELAY_MS);
}

// ─── browser connection ──────────────────────────────────────────────────────
// Copied from reddit-browser.mjs — connects to an existing Chrome instance.

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
          log(`[ph] found Chrome at ${wsUrl}`);
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
    log(`[ph] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }
  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[ph] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }
  const wsUrl = await findChromeWSEndpoint();
  if (wsUrl) {
    try { return await puppeteer.connect({ browserWSEndpoint: wsUrl }); }
    catch (err) { log(`[ph] auto-detect failed: ${err.message}`); }
  }
  fail('No Chrome browser found. Start puppeteer-mcp-server, or pass --ws-url / --port');
}

// ─── scraping helpers ────────────────────────────────────────────────────────

/**
 * Search producthunt.com for products matching a query.
 * Returns an array of { slug, name, tagline, url, upvotes }.
 */
async function scrapeSearchResults(page, query) {
  const url = `${PH_BASE}/search?q=${encodeURIComponent(query)}`;
  log(`[ph] searching: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  return await page.evaluate((base) => {
    var results = [];
    // Product Hunt search renders product cards with data-test or role attributes.
    // We look for links that point to /posts/<slug>.
    var links = document.querySelectorAll('a[href^="/posts/"]');
    var seen = new Set();
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute('href');
      if (!href || seen.has(href)) continue;
      // Skip links that are just comment anchors or pagination
      if (href.includes('#') || href.split('/').length > 3) continue;
      seen.add(href);

      var slug = href.replace('/posts/', '').replace(/\/$/, '');
      // Try to find name — look for a heading or strong text near the link
      var card = a.closest('[class*="card"], [class*="item"], [class*="post"], li, article') || a;
      var nameEl = card.querySelector('h2, h3, strong, [class*="name"], [class*="title"]');
      var name = nameEl ? nameEl.textContent.trim() : a.textContent.trim();
      var taglineEl = card.querySelector('p, [class*="tagline"], [class*="description"]');
      var tagline = taglineEl ? taglineEl.textContent.trim() : '';
      // Upvote count
      var upvoteEl = card.querySelector('[class*="vote"], [class*="count"]');
      var upvotes = 0;
      if (upvoteEl) {
        var m = upvoteEl.textContent.match(/([\d,]+)/);
        if (m) upvotes = parseInt(m[1].replace(/,/g, ''), 10);
      }
      if (name && slug) {
        results.push({ slug: slug, name: name, tagline: tagline, url: base + href, upvotes: upvotes });
      }
    }
    return results;
  }, PH_BASE);
}

/**
 * Scrape a single product page for description and comments.
 * Returns { name, tagline, description, upvotes, comments: [{body, score}] }
 */
async function scrapeProductPage(page, productUrl, maxComments = 100) {
  log(`[ph] scraping product: ${productUrl}`);
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  return await page.evaluate((maxC) => {
    // Product name
    var nameEl = document.querySelector('h1');
    var name = nameEl ? nameEl.textContent.trim() : '';

    // Tagline — typically an h2 or subtitle near the header
    var taglineEl = document.querySelector('h2, [class*="tagline"], [class*="subtitle"]');
    var tagline = taglineEl ? taglineEl.textContent.trim() : '';

    // Description — look for a large text block in the "about" section
    var descEl = document.querySelector('[class*="description"], [class*="about"], [data-test*="description"]');
    var description = descEl ? descEl.textContent.trim() : '';

    // Upvote count
    var upvotes = 0;
    var upvoteEls = document.querySelectorAll('[class*="vote"] [class*="count"], [data-test*="vote"] span, button[class*="vote"] span');
    for (var i = 0; i < upvoteEls.length; i++) {
      var m = upvoteEls[i].textContent.match(/([\d,]+)/);
      if (m) { upvotes = parseInt(m[1].replace(/,/g, ''), 10); break; }
    }
    // Fallback: any element that looks like an upvote number
    if (!upvotes) {
      var allButtons = document.querySelectorAll('button');
      for (var j = 0; j < allButtons.length; j++) {
        var btn = allButtons[j];
        if (/upvote|vote/i.test(btn.getAttribute('aria-label') || '')) {
          var countEl = btn.querySelector('span, div');
          if (countEl) {
            var mv = countEl.textContent.match(/(\d+)/);
            if (mv) { upvotes = parseInt(mv[1], 10); break; }
          }
        }
      }
    }

    // Comments — Product Hunt renders them in a discussion section
    var comments = [];
    // Try multiple selectors that PH has used historically
    var commentEls = document.querySelectorAll(
      '[class*="comment"], [data-test*="comment"], [class*="review"], [class*="discussion"] > div'
    );
    for (var k = 0; k < Math.min(commentEls.length, maxC); k++) {
      var el = commentEls[k];
      // Skip tiny/empty nodes
      var text = el.textContent.trim();
      if (!text || text.length < 20) continue;
      // Try to find a score/upvote on the comment
      var scoreEl = el.querySelector('[class*="vote"] span, [class*="count"] span');
      var score = 1;
      if (scoreEl) {
        var sm = scoreEl.textContent.match(/(\d+)/);
        if (sm) score = parseInt(sm[1], 10);
      }
      comments.push({ body: text.substring(0, 500), score: score });
    }

    return {
      name: name,
      tagline: tagline,
      description: description,
      upvotes: upvotes,
      comments: comments,
    };
  }, maxComments);
}

// ─── pain-focused comment filter ────────────────────────────────────────────

const PAIN_PATTERNS = [
  /i wish (this|it) (did|had|could|would)/i,
  /missing feature/i,
  /doesn'?t work for/i,
  /switched from/i,
  /please add/i,
  /feature request/i,
  /wish (you|they) (would|could|had)/i,
  /not worth/i,
  /deal.?breaker/i,
  /can'?t figure out/i,
  /frustrat/i,
  /annoying/i,
  /too expensive/i,
  /overpriced/i,
  /terrible/i,
  /unusable/i,
  /hate (it|this|that)/i,
  /alternatives?/i,
  /compared to/i,
  /instead i (use|went|tried)/i,
  /stopped using/i,
  /still missing/i,
  /would be better if/i,
];

function hasPainSignal(text) {
  return PAIN_PATTERNS.some(p => p.test(text));
}

// ─── normalize to common post shape ─────────────────────────────────────────

function buildPost(productData, slug, productUrl) {
  const { name, tagline, description, upvotes, comments } = productData;

  // Filter to pain-focused comments only
  const painComments = comments.filter(c => hasPainSignal(c.body));

  // Concatenate description + pain comments as selftext
  const commentTexts = painComments.map(c => c.body).join('\n\n');
  const selftext = [description, commentTexts].filter(Boolean).join('\n\n---\n\n');

  return {
    id: slug,
    title: name + (tagline ? ` — ${tagline}` : ''),
    selftext,
    subreddit: 'producthunt',
    url: productUrl,
    score: upvotes,
    num_comments: comments.length,
    upvote_ratio: 0,
    flair: '',
    created_utc: 0,
    // Carry raw pain comments for analysis
    _painComments: painComments,
    _allComments: comments,
  };
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required for producthunt scan');

  const limit = args.limit || 20;
  const maxComments = args.maxComments || 100;

  log(`[ph-scan] domain="${domain}", limit=${limit}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();

  try {
    // Build search queries focused on the domain
    const queries = [
      domain,
      `${domain} alternative`,
      `${domain} tool`,
    ];

    const productsBySlug = new Map();

    for (const query of queries) {
      log(`[ph-scan] query="${query}"`);
      let results;
      try {
        results = await scrapeSearchResults(page, query);
      } catch (err) {
        log(`[ph-scan] search failed: ${err.message}`);
        await politeDelay();
        continue;
      }

      log(`[ph-scan] found ${results.length} products for query "${query}"`);
      for (const r of results) {
        if (!productsBySlug.has(r.slug)) productsBySlug.set(r.slug, r);
      }
      await politeDelay();
    }

    log(`[ph-scan] ${productsBySlug.size} unique products after dedup`);

    const scored = [];
    let count = 0;
    for (const product of productsBySlug.values()) {
      if (count >= limit * 2) break; // Fetch more than needed, filter below
      log(`[ph-scan] scraping ${product.url}`);
      try {
        const data = await scrapeProductPage(page, product.url, maxComments);
        // Merge upvotes from search result if page didn't return one
        if (!data.upvotes && product.upvotes) data.upvotes = product.upvotes;
        if (!data.name) data.name = product.name;
        if (!data.tagline) data.tagline = product.tagline;

        const post = buildPost(data, product.slug, product.url);
        const enriched = enrichPost(post, domain);
        if (enriched) {
          // Attach pain comment count for reference
          enriched.ph_pain_comments = post._painComments.length;
          enriched.ph_total_comments = post._allComments.length;
          scored.push(enriched);
        }
      } catch (err) {
        log(`[ph-scan] failed for ${product.url}: ${err.message}`);
      }
      count++;
      await politeDelay();
    }

    scored.sort((a, b) => b.painScore - a.painScore);
    ok({
      mode: 'producthunt',
      posts: scored.slice(0, limit),
      stats: {
        queries: queries.length,
        products_found: productsBySlug.size,
        products_scraped: count,
        after_filter: Math.min(scored.length, limit),
      },
    });
  } finally {
    await page.close();
  }
}

// ─── source export ───────────────────────────────────────────────────────────

export default {
  name: 'producthunt',
  description: 'Product Hunt — scrape product launches and comments for pain signals',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
producthunt source — Product Hunt scraping via Puppeteer

Commands:
  scan        Search Product Hunt for products matching --domain and score pain signals

scan options:
  --domain <str>        Domain / topic to search for (required)
  --limit <n>           Max products to return (default: 20)
  --maxComments <n>     Max comments per product page (default: 100)

Connection options:
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  pain-points ph scan --domain "project management"
  pain-points ph scan --domain "email marketing" --limit 10
`,
};
