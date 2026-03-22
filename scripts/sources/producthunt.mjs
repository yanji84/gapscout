/**
 * producthunt.mjs — Product Hunt source for pain-point-finder
 *
 * Scrapes producthunt.com via Puppeteer. Connects to an existing Chrome
 * instance (e.g. from puppeteer-mcp-server) or accepts --ws-url / --port.
 * Falls back to launching its own Chrome when none is found.
 *
 * Strategy:
 *   1. Navigate to PH homepage and type in search box to trigger GraphQL
 *      search, then intercept the response.
 *   2. Alternatively, use known category slug URL for fixed domains.
 *   3. For each product: navigate to /products/<slug>/reviews and scrape
 *      review text for pain signals.
 *
 * Selectors updated for PH's 2024/2025 React app structure:
 *   - Products on listing pages: data-test="post-item-*" + links to /products/
 *   - Product page: data-test="header", h1, /products/<slug>/reviews
 *   - Reviews: data-test contains "review"
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { connectBrowser as connectBrowserBase, politeDelay as politeDelayBase } from '../lib/browser.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PH_BASE = 'https://www.producthunt.com';
const PAGE_DELAY_MS = 1500;

// Well-known PH category slugs for common domains
const DOMAIN_TO_CATEGORY = {
  'project management': 'project-management',
  'task management': 'task-management',
  'productivity': 'productivity',
  'email': 'email-clients',
  'crm': 'crm',
  'analytics': 'analytics',
  'marketing': 'marketing',
  'design': 'design-tools',
  'developer tools': 'developer-tools',
  'ai': 'artificial-intelligence',
  'chatbot': 'chatbots',
  'writing': 'writing',
  'sales': 'sales',
  'customer support': 'customer-support',
  'finance': 'finance',
  'hr': 'hr-tools',
  'note taking': 'note-taking',
};

async function politeDelay(ms = PAGE_DELAY_MS) {
  await politeDelayBase(ms, 0);
}

let _launchedBrowser = null;

async function connectBrowser(args) {
  const browser = await connectBrowserBase(args, { logTag: 'ph', canLaunch: true });
  // Track if we launched it ourselves so we can close it later
  if (!args.wsUrl && !args.port) {
    _launchedBrowser = browser;
  }
  return browser;
}

// ─── realistic browser helpers ───────────────────────────────────────────────

async function preparePage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  });
  return page;
}

/**
 * Navigate to a URL and wait for React to hydrate.
 * Handles Cloudflare challenge page by waiting extra time.
 * Returns true if page loaded with real content, false if blocked.
 */
async function navigateAndWait(page, url, waitMs = 2500) {
  log(`[ph] navigate: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    log(`[ph] navigation error: ${err.message}`);
    return false;
  }
  await sleep(waitMs);
  // Check for Cloudflare / error
  const blocked = await page.evaluate(() => {
    const title = document.title.toLowerCase();
    const body = document.body.textContent.toLowerCase();
    return title.includes('just a moment') ||
      title.includes('checking your browser') ||
      body.includes('cf-browser-verification') ||
      document.querySelector('iframe[src*="recaptcha"]') !== null;
  });
  if (blocked) {
    log(`[ph] Cloudflare challenge detected — waiting 8s...`);
    await sleep(8000);
    const stillBlocked = await page.evaluate(() => {
      return document.title.toLowerCase().includes('just a moment');
    });
    if (stillBlocked) {
      log(`[ph] still blocked by Cloudflare`);
      return false;
    }
  }
  return true;
}

// ─── product discovery via search interception ───────────────────────────────

/**
 * Use the PH search input to type a query and intercept the GraphQL response.
 * Returns an array of { slug, name, tagline, url, upvotes }.
 */
async function searchViaInputAndIntercept(page, query) {
  const results = [];
  const searchDataReceived = [];

  // Set up response interception BEFORE navigating
  const interceptHandler = async (resp) => {
    const url = resp.url();
    if (!url.includes('graphql')) return;
    try {
      const text = await resp.text();
      const opMatch = url.match(/operationName=([^&]+)/);
      const op = opMatch ? decodeURIComponent(opMatch[1]) : '';
      // Look for search operations or post/product lists
      if (op.toLowerCase().includes('search') || text.includes('"posts"') ||
          text.includes('"products"') || text.includes('"post"')) {
        searchDataReceived.push({ op, text });
      }
    } catch { /* ignore */ }
  };
  page.on('response', interceptHandler);

  // Navigate to homepage
  const loaded = await navigateAndWait(page, PH_BASE + '/', 3000);
  if (!loaded) {
    page.off('response', interceptHandler);
    return results;
  }

  // Find and click the search input
  const searchSel = '[data-test="header-search-input"], input[name="q"], input[placeholder*="Search"]';
  const searchInput = await page.$(searchSel).catch(() => null);
  if (!searchInput) {
    log(`[ph-search] search input not found`);
    page.off('response', interceptHandler);
    return results;
  }

  await searchInput.click();
  await sleep(500);
  await page.keyboard.type(query, { delay: 60 });
  await sleep(3000); // Wait for GraphQL search response

  page.off('response', interceptHandler);

  // Parse GraphQL responses
  for (const { op, text } of searchDataReceived) {
    try {
      const data = JSON.parse(text);
      // Navigate through common PH GraphQL response shapes
      const nodes = data?.data?.search?.edges
        || data?.data?.posts?.edges
        || data?.data?.searchProducts?.edges
        || [];
      for (const edge of nodes) {
        const node = edge?.node || edge;
        if (!node) continue;
        const slug = node.slug || node.name?.toLowerCase().replace(/\s+/g, '-');
        if (!slug) continue;
        const url = node.url || `${PH_BASE}/products/${slug}`;
        results.push({
          slug,
          name: node.name || node.tagline || slug,
          tagline: node.tagline || node.description || '',
          url: url.startsWith('http') ? url : `${PH_BASE}${url}`,
          upvotes: node.votesCount || node.upvotesCount || 0,
        });
      }
    } catch { /* skip malformed */ }
  }

  // Also scrape any spotlight results rendered in the DOM
  const domResults = await page.evaluate((base) => {
    const items = [];
    // Spotlight result items
    const spotlightItems = document.querySelectorAll('[data-test^="spotlight-result-product"]');
    for (let i = 0; i < spotlightItems.length; i++) {
      const el = spotlightItems[i];
      const dt = el.getAttribute('data-test') || '';
      // Extract product slug from thumbnail data-test, e.g. "Notion-thumbnail"
      const thumbEl = el.querySelector('[data-test*="thumbnail"]');
      const thumbText = thumbEl ? thumbEl.getAttribute('data-test').replace('-thumbnail', '') : '';
      const link = el.querySelector('a[href*="/products/"]');
      const href = link ? link.getAttribute('href') : null;
      const nameEl = el.querySelector('a, span, div');
      const name = nameEl ? nameEl.textContent.trim().substring(0, 80) : thumbText;
      if (href) {
        const parts = href.split('/products/');
        const slug = parts[1] ? parts[1].replace(/\/$/, '').split('/')[0] : '';
        if (slug) {
          items.push({
            slug,
            name: name || slug,
            tagline: '',
            url: href.startsWith('http') ? href : base + href,
            upvotes: 0,
          });
        }
      }
    }
    return items;
  }, PH_BASE);

  for (const r of domResults) {
    if (!results.find(e => e.slug === r.slug)) results.push(r);
  }

  log(`[ph-search] query="${query}" → ${results.length} via interception, ${domResults.length} via DOM`);
  return results;
}

/**
 * Scrape product listing from a category or search results page.
 * Returns array of { slug, name, tagline, url, upvotes }.
 */
async function scrapeProductListing(page, listingUrl) {
  const loaded = await navigateAndWait(page, listingUrl, 4000);
  if (!loaded) return [];

  return await page.evaluate((base) => {
    const results = [];
    const seen = new Set();

    // PH 2024/2025: product cards on category/listing pages use data-test="product:<slug>"
    const productCards = document.querySelectorAll('[data-test^="product:"]');
    for (let i = 0; i < productCards.length; i++) {
      const el = productCards[i];
      const dt = el.getAttribute('data-test');
      const slug = dt.replace('product:', '');
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const nameEl = el.querySelector('h2, h3, [class*="name"], [class*="title"]') ||
        el.querySelector('a');
      const name = nameEl ? nameEl.textContent.trim().replace(/^\d+\.\s*/, '') : slug;
      const taglineEl = el.querySelector('p, [class*="tagline"], [class*="description"]');
      const tagline = taglineEl ? taglineEl.textContent.trim() : '';
      const ratingEl = el.querySelector('[data-test^="star"]');
      results.push({
        slug,
        name,
        tagline,
        url: base + '/products/' + slug,
        upvotes: 0,
      });
    }

    // Also collect from post-item cards (daily launches feed)
    const postItems = document.querySelectorAll('[data-test^="post-item"]');
    for (let i = 0; i < postItems.length; i++) {
      const el = postItems[i];
      const productLinks = Array.from(el.querySelectorAll('a[href*="/products/"]'));
      const nameEl = el.querySelector('[data-test^="post-name"]');
      for (const a of productLinks) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const parts = href.split('/products/');
        if (parts.length < 2) continue;
        const slug = parts[1].replace(/\/$/, '').split('/')[0];
        if (!slug || seen.has(slug) || slug === 'undefined') continue;
        seen.add(slug);
        const name = nameEl ? nameEl.textContent.trim().replace(/^\d+\.\s*/, '') : slug;
        const voteEl = el.querySelector('[data-test="vote-button"]');
        const upvotes = voteEl ? parseInt(voteEl.textContent.trim().replace(/[^0-9]/g, ''), 10) || 0 : 0;
        results.push({
          slug,
          name,
          tagline: '',
          url: href.startsWith('http') ? href : base + href,
          upvotes,
        });
      }
    }

    // Fallback: any /products/ links
    if (results.length === 0) {
      const allLinks = document.querySelectorAll('a[href*="/products/"]');
      for (let i = 0; i < allLinks.length && results.length < 20; i++) {
        const a = allLinks[i];
        const href = a.getAttribute('href') || '';
        // Skip review/alternative subpages
        if (href.includes('/reviews') || href.includes('/alternatives') ||
            href.includes('/launches') || href.includes('/customers')) continue;
        const parts = href.split('/products/');
        if (parts.length < 2) continue;
        const slug = parts[1].replace(/\/$/, '').split('/')[0];
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        results.push({
          slug,
          name: a.textContent.trim().substring(0, 60) || slug,
          tagline: '',
          url: href.startsWith('http') ? href : base + href,
          upvotes: 0,
        });
      }
    }

    return results;
  }, PH_BASE);
}

// ─── product page scraping ───────────────────────────────────────────────────

/**
 * Scrape a product's overview + reviews page for name, tagline, description,
 * upvote count, and review comments.
 * Returns { name, tagline, description, upvotes, comments: [{body, score}] }
 */
async function scrapeProductPage(page, slug, maxComments = 80) {
  const productUrl = `${PH_BASE}/products/${slug}`;
  const reviewsUrl = `${PH_BASE}/products/${slug}/reviews`;

  log(`[ph] scraping product overview: ${productUrl}`);
  const loadedOverview = await navigateAndWait(page, productUrl, 2000);

  const overview = await page.evaluate(() => {
    // Name
    const h1 = document.querySelector('h1');
    const name = h1 ? h1.textContent.trim() : '';

    // Tagline — the subtitle beneath the product name; skip metadata lines
    const taglineCandidates = Array.from(document.querySelectorAll('[data-test="header"] p, h1 + p, h1 ~ p'));
    let tagline = '';
    for (const el of taglineCandidates) {
      const t = el.textContent.trim();
      // Skip metadata lines like "262 followers", "5.0 • 37 reviews"
      if (/\d+\s*(followers|reviews|K followers)/i.test(t) || /^\d+\.?\d*\s*[•]/.test(t)) continue;
      if (t.length > 5 && t.length < 200) { tagline = t; break; }
    }

    // Description / about text
    const descEls = document.querySelectorAll('[data-test*="description"], [class*="about"] p, main p');
    let description = '';
    for (let i = 0; i < descEls.length; i++) {
      const t = descEls[i].textContent.trim();
      if (t.length > 80) { description = t.substring(0, 600); break; }
    }

    // Upvotes — vote button on product header
    let upvotes = 0;
    const voteBtn = document.querySelector('[data-test="vote-button"], button[class*="vote"]');
    if (voteBtn) {
      const m = voteBtn.textContent.match(/([\d,]+)/);
      if (m) upvotes = parseInt(m[1].replace(/,/g, ''), 10);
    }

    // Rating stars info
    const ratingEl = document.querySelector('[class*="rating"], [class*="stars"]');
    const ratingText = ratingEl ? ratingEl.textContent.trim().substring(0, 30) : '';

    return { name, tagline, description, upvotes, ratingText };
  });

  // Now get reviews
  log(`[ph] scraping reviews: ${reviewsUrl}`);
  const loadedReviews = await navigateAndWait(page, reviewsUrl, 2500);

  const comments = await page.evaluate((maxC) => {
    const results = [];
    const seen = new Set();

    // PH reviews page uses data-test="review-*" or similar patterns
    // Try several known selectors
    const reviewSelectors = [
      '[data-test^="review"]',
      '[class*="reviewCard"]',
      '[class*="ReviewCard"]',
      '[class*="review-item"]',
      '[class*="reviewItem"]',
    ];

    let reviewEls = [];
    for (const sel of reviewSelectors) {
      reviewEls = Array.from(document.querySelectorAll(sel));
      if (reviewEls.length > 0) break;
    }

    // Fallback: look for substantial text blocks in main content
    if (reviewEls.length === 0) {
      const main = document.querySelector('main');
      if (main) {
        const divs = Array.from(main.querySelectorAll('div, article, section'));
        reviewEls = divs.filter(el => {
          const t = el.textContent.trim();
          return t.length > 60 && t.length < 2000 && !el.querySelector('nav');
        }).slice(0, maxC);
      }
    }

    for (let k = 0; k < Math.min(reviewEls.length, maxC); k++) {
      const el = reviewEls[k];
      const text = el.textContent.trim();
      if (!text || text.length < 25 || text.length > 3000) continue;
      if (seen.has(text.substring(0, 50))) continue;
      seen.add(text.substring(0, 50));

      // Try to find a score/upvote on the review
      const scoreEl = el.querySelector('[class*="vote"] span, [class*="count"] span, [data-test*="vote"]');
      let score = 1;
      if (scoreEl) {
        const sm = scoreEl.textContent.match(/(\d+)/);
        if (sm) score = parseInt(sm[1], 10);
      }
      // Star rating on the review
      const starText = el.querySelector('[class*="rating"], [class*="star"]');
      const starVal = starText ? parseInt(starText.textContent.trim()[0] || '0', 10) : 0;

      results.push({
        body: text.substring(0, 500),
        score,
        stars: starVal,
      });
    }

    return results;
  }, maxComments);

  log(`[ph] product "${overview.name}" — upvotes:${overview.upvotes}, reviews:${comments.length}`);

  return {
    name: overview.name,
    tagline: overview.tagline,
    description: overview.description,
    upvotes: overview.upvotes,
    comments,
  };
}

// ─── pain-focused comment filter ─────────────────────────────────────────────

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
  /not great/i,
  /disappointed/i,
  /lacking/i,
  /needs improvement/i,
  /room for improvement/i,
  /could be better/i,
  /limitation/i,
  /bug|crash|broken/i,
  /slow|laggy/i,
  /confus/i,
  /hard to (use|understand|navigate)/i,
];

function hasPainSignal(text) {
  return PAIN_PATTERNS.some(p => p.test(text));
}

// ─── normalize to common post shape ──────────────────────────────────────────

function buildPost(productData, slug, productUrl) {
  const { name, tagline, description, upvotes, comments } = productData;

  // Separate pain-focused comments (for reference) vs all reviews
  const painComments = comments.filter(c => hasPainSignal(c.body));

  // Use ALL review text as selftext so enrichPost can run its own signal detection.
  // Truncate to avoid runaway selftext.
  const allCommentTexts = comments.map(c => c.body).join('\n\n');
  const selftext = [description, allCommentTexts].filter(Boolean).join('\n\n---\n\n').substring(0, 6000);

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
    _painComments: painComments,
    _allComments: comments,
  };
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required for producthunt scan');

  const limit = args.limit || 20;
  const maxComments = args.maxComments || 80;

  log(`[ph-scan] domain="${domain}", limit=${limit}`);

  const browser = await connectBrowser(args);
  const page = await preparePage(browser);

  try {
    const productsBySlug = new Map();

    // Strategy 1: Use PH category page if domain maps to a known category
    const domainLower = domain.toLowerCase();
    const categorySlug = Object.entries(DOMAIN_TO_CATEGORY).find(
      ([key]) => domainLower.includes(key) || key.includes(domainLower)
    )?.[1];

    if (categorySlug) {
      log(`[ph-scan] using category page: /categories/${categorySlug}`);
      const catUrl = `${PH_BASE}/categories/${categorySlug}`;
      const catResults = await scrapeProductListing(page, catUrl);
      log(`[ph-scan] category page: ${catResults.length} products`);
      for (const r of catResults) {
        if (!productsBySlug.has(r.slug)) productsBySlug.set(r.slug, r);
      }
      await politeDelay();
    }

    // Strategy 2: Use homepage feed + search input interception
    if (productsBySlug.size < limit) {
      log(`[ph-scan] searching via input interception...`);
      const searchResults = await searchViaInputAndIntercept(page, domain);
      for (const r of searchResults) {
        if (!productsBySlug.has(r.slug)) productsBySlug.set(r.slug, r);
      }
      await politeDelay();
    }

    // Strategy 3: If still not enough, try homepage products filtered by domain keywords
    if (productsBySlug.size < 3) {
      log(`[ph-scan] falling back to homepage listing...`);
      const homeResults = await scrapeProductListing(page, PH_BASE + '/');
      for (const r of homeResults) {
        if (!productsBySlug.has(r.slug)) productsBySlug.set(r.slug, r);
      }
      await politeDelay();
    }

    log(`[ph-scan] ${productsBySlug.size} unique products after discovery`);

    const scored = [];
    let count = 0;
    for (const product of productsBySlug.values()) {
      if (count >= limit + 5) break; // Fetch a few extras for filter buffer
      try {
        const data = await scrapeProductPage(page, product.slug, maxComments);
        // Merge fields from search result if page scrape was incomplete
        if (!data.upvotes && product.upvotes) data.upvotes = product.upvotes;
        if (!data.name) data.name = product.name;
        if (!data.tagline) data.tagline = product.tagline;

        const productUrl = `${PH_BASE}/products/${product.slug}`;
        const post = buildPost(data, product.slug, productUrl);
        const enriched = enrichPost(post, domain);
        if (enriched) {
          enriched.ph_pain_comments = post._painComments.length;
          enriched.ph_total_comments = post._allComments.length;
          scored.push(enriched);
        }
      } catch (err) {
        log(`[ph-scan] failed for ${product.slug}: ${err.message}`);
      }
      count++;
      await politeDelay();
    }

    scored.sort((a, b) => b.painScore - a.painScore);
    ok({
      mode: 'producthunt',
      posts: scored.slice(0, limit),
      stats: {
        products_found: productsBySlug.size,
        products_scraped: count,
        after_filter: Math.min(scored.length, limit),
      },
    });
  } finally {
    await page.close().catch(() => {});
    // Only close browser if we launched it
    if (_launchedBrowser) {
      await _launchedBrowser.close().catch(() => {});
      _launchedBrowser = null;
    }
  }
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'producthunt',
  description: 'Product Hunt — scrape product launches and reviews for pain signals',
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
  --maxComments <n>     Max reviews per product page (default: 80)

Connection options:
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)
                        Falls back to launching its own Chrome when none found.

Examples:
  pain-points ph scan --domain "project management"
  pain-points ph scan --domain "email marketing" --limit 10
`,
};
