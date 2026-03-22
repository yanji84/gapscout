/**
 * reviews.mjs — G2/Capterra review scraper source for pain-point-finder
 *
 * Scrapes 1-3 star reviews from G2 (and optionally Capterra) via Puppeteer.
 * Connects to an existing Chrome instance using the same connectBrowser
 * pattern as reddit-browser.mjs.
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { connectBrowser, politeDelay as politeDelayBase, detectBlockInPage, createBlockTracker } from '../lib/browser.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PAGE_DELAY_MS = 2500;
const JITTER_MS = 500;
const MAX_PRODUCTS = 5;
const MAX_REVIEW_PAGES = 3;

async function politeDelay() {
  await politeDelayBase(PAGE_DELAY_MS, JITTER_MS);
}

// ─── G2 scraping ────────────────────────────────────────────────────────────

/**
 * Search G2 for products matching the domain query.
 * Returns array of { name, slug, url } objects.
 */
async function searchG2Products(page, domain, maxProducts = MAX_PRODUCTS) {
  const searchUrl = `https://www.g2.com/search?query=${encodeURIComponent(domain)}`;
  log(`[reviews] searching G2: ${searchUrl}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Check for anti-bot block on the search page itself
    const blockResult = await detectBlockInPage(page);
    if (blockResult.blocked) {
      log(`[reviews] G2 search page is blocked (${blockResult.reason})`);
      return [];
    }

    const products = await page.evaluate((maxP) => {
      var results = [];
      // Product links in search results — try multiple selector patterns for G2's evolving markup
      var selectors = [
        'a[href*="/products/"][href*="/reviews"]',
        'a[href*="g2.com/products/"]',
        '.product-listing__product-name a',
        '[data-testid="product-listing"] a',
        '.product-name a',
        '[class*="product"] a[href*="/products/"]',
      ];
      var seen = new Set();
      for (var sel of selectors) {
        var els = document.querySelectorAll(sel);
        for (var i = 0; i < els.length && results.length < maxP; i++) {
          var el = els[i];
          var href = el.href || '';
          var match = href.match(/\/products\/([^/?#]+)/);
          if (!match) continue;
          var slug = match[1];
          // Skip non-product slugs
          if (['search', 'categories', 'compare', 'software'].includes(slug)) continue;
          if (seen.has(slug)) continue;
          seen.add(slug);
          var name = el.textContent.trim() || slug;
          results.push({
            name: name,
            slug: slug,
            url: 'https://www.g2.com/products/' + slug + '/reviews',
          });
        }
        if (results.length >= maxP) break;
      }
      return results;
    }, maxProducts);

    if (products.length === 0) {
      log(`[reviews] no G2 products found via selectors (G2 blocked or DOM changed)`);
      return [];
    }

    log(`[reviews] found ${products.length} G2 products`);
    return products;
  } catch (err) {
    log(`[reviews] G2 search failed: ${err.message}`);
    return [];
  }
}

/**
 * Scrape low-star reviews from a G2 product reviews page.
 * G2 URL: https://www.g2.com/products/<slug>/reviews?filters[star_rating][]=1&filters[star_rating][]=2&filters[star_rating][]=3
 */
async function scrapeG2Reviews(page, productUrl, productName, maxPages = MAX_REVIEW_PAGES, blockTracker = null) {
  // Filter for 1-3 star reviews
  const baseUrl = productUrl.replace(/\?.*$/, '');
  const lowStarUrl = `${baseUrl}?filters[star_rating][]=1&filters[star_rating][]=2&filters[star_rating][]=3`;

  log(`[reviews] scraping G2 low-star reviews: ${productName}`);

  const allReviews = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const url = pageNum === 1 ? lowStarUrl : `${lowStarUrl}&page=${pageNum}`;
    log(`[reviews]   page ${pageNum}: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);

      // Check for anti-bot / captcha using shared detector
      const blockResult = await detectBlockInPage(page);
      if (blockResult.blocked) {
        log(`[reviews]   anti-bot detected (${blockResult.reason}) on page ${pageNum}, skipping product`);
        if (blockTracker) blockTracker.recordBlock(blockResult.reason);
        break;
      }
      if (blockTracker) blockTracker.recordSuccess();

      const reviews = await page.evaluate((prodName, prodUrl) => {
        var results = [];

        // G2 review cards — try multiple selector patterns
        var cardSelectors = [
          '[itemprop="review"]',
          '.review-card',
          '.paper.paper--white.paper--box',
          '[data-testid="review-card"]',
          '.review',
        ];

        var cards = [];
        for (var sel of cardSelectors) {
          var found = document.querySelectorAll(sel);
          if (found.length > 0) { cards = Array.from(found); break; }
        }

        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];

          // Star rating
          var ratingEl = card.querySelector(
            '[itemprop="ratingValue"], .stars--existing, [class*="star-rating"], [aria-label*="out of 5"]'
          );
          var stars = 0;
          if (ratingEl) {
            // Try numeric content first
            var ratingText = ratingEl.textContent.trim();
            var numMatch = ratingText.match(/(\d(?:\.\d)?)/);
            if (numMatch) {
              stars = parseFloat(numMatch[1]);
            }
            // Try aria-label: "4.5 out of 5 stars"
            var ariaLabel = ratingEl.getAttribute('aria-label') || '';
            var ariaMatch = ariaLabel.match(/^(\d(?:\.\d)?)/);
            if (ariaMatch) stars = parseFloat(ariaMatch[1]);
          }

          // Count filled star SVGs as fallback
          if (stars === 0) {
            var filledStars = card.querySelectorAll('[class*="star"][class*="full"], .star-on, [data-star]');
            if (filledStars.length > 0) stars = filledStars.length;
          }

          // Only keep 1-3 star reviews (pain reviews)
          if (stars > 3 || stars === 0) continue;

          // Review title
          var titleEl = card.querySelector(
            '[itemprop="name"], .review-title, h3, .paper__title'
          );
          var title = titleEl ? titleEl.textContent.trim() : '';

          // Review body
          var bodySelectors = [
            '[itemprop="reviewBody"]',
            '.review-body',
            '.review__body',
            '.formatted-text',
          ];
          var bodyText = '';
          for (var bs of bodySelectors) {
            var bodyEl = card.querySelector(bs);
            if (bodyEl) { bodyText = bodyEl.textContent.trim(); break; }
          }

          if (!bodyText) {
            // Fallback: grab all <p> text in card
            var paras = card.querySelectorAll('p');
            bodyText = Array.from(paras).map(p => p.textContent.trim()).filter(Boolean).join(' ');
          }

          if (!bodyText || bodyText.length < 20) continue;

          // Helpful votes
          var helpfulEl = card.querySelector('[class*="helpful"], [class*="vote"]');
          var helpfulVotes = 0;
          if (helpfulEl) {
            var hvMatch = helpfulEl.textContent.match(/(\d+)/);
            if (hvMatch) helpfulVotes = parseInt(hvMatch[1], 10);
          }

          // Review URL / ID
          var reviewLink = card.querySelector('a[href*="/reviews/"]');
          var reviewUrl = reviewLink ? reviewLink.href : prodUrl;
          var reviewId = reviewUrl.match(/\/reviews\/([^?#/]+)/);
          var id = reviewId ? reviewId[1] : ('g2-' + prodName.toLowerCase().replace(/\s+/g, '-') + '-' + i);

          results.push({
            id: id,
            stars: stars,
            title: title || (prodName + ' — ' + stars + '-star review'),
            body: bodyText,
            url: reviewUrl,
            helpfulVotes: helpfulVotes,
          });
        }
        return results;
      }, productName, productUrl);

      log(`[reviews]   found ${reviews.length} low-star reviews on page ${pageNum}`);

      if (reviews.length === 0) {
        // No more reviews or selector mismatch
        if (pageNum === 1) {
          log(`[reviews]   no reviews found — G2 may have changed their markup`);
        }
        break;
      }

      allReviews.push(...reviews);

      // Check if there's a next page
      const hasNext = await page.evaluate(() => {
        var nextLink = document.querySelector('a[rel="next"], .pagination__next:not(.disabled), [aria-label="Next page"]');
        return !!nextLink;
      });

      if (!hasNext) break;

      await politeDelay();
    } catch (err) {
      log(`[reviews]   page ${pageNum} failed: ${err.message}`);
      break;
    }
  }

  return allReviews;
}

/**
 * Scrape low-star reviews from Capterra for a given domain search.
 */
async function scrapeCapterraReviews(page, domain, maxProducts = 3, blockTracker = null) {
  const searchUrl = `https://www.capterra.com/search/?query=${encodeURIComponent(domain)}`;
  log(`[reviews] searching Capterra: ${searchUrl}`);

  const allReviews = [];

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Check for anti-bot block on Capterra search page
    const blockResult = await detectBlockInPage(page);
    if (blockResult.blocked) {
      log(`[reviews] Capterra search page is blocked (${blockResult.reason})`);
      if (blockTracker) blockTracker.recordBlock(blockResult.reason);
      return allReviews;
    }

    const products = await page.evaluate((maxP) => {
      var results = [];
      var seen = new Set();
      var links = document.querySelectorAll('a[href*="/software/"], a[href*="/p/"]');
      for (var i = 0; i < links.length && results.length < maxP; i++) {
        var href = links[i].href;
        if (!href.includes('capterra.com')) continue;
        var match = href.match(/capterra\.com\/(software|p)\/(\d+)\/([^/?#]+)/);
        if (!match) continue;
        var id = match[2];
        if (seen.has(id)) continue;
        seen.add(id);
        var name = links[i].textContent.trim() || match[3];
        results.push({
          name: name,
          id: id,
          category: match[3],
          url: 'https://www.capterra.com/' + match[1] + '/' + id + '/' + match[3] + '/reviews/',
        });
      }
      return results;
    }, maxProducts);

    log(`[reviews] found ${products.length} Capterra products`);

    for (const product of products.slice(0, maxProducts)) {
      log(`[reviews] scraping Capterra: ${product.name}`);
      const reviewUrl = product.url + '?sort=rating&order=asc'; // lowest ratings first
      try {
        await page.goto(reviewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);

        const blockResult2 = await detectBlockInPage(page);
        if (blockResult2.blocked) {
          log(`[reviews]   Capterra blocked (${blockResult2.reason}), skipping`);
          if (blockTracker) blockTracker.recordBlock(blockResult2.reason);
          if (blockTracker && blockTracker.shouldStop) break;
          continue;
        }
        if (blockTracker) blockTracker.recordSuccess();

        const reviews = await page.evaluate((prodName, prodUrl) => {
          var results = [];
          var cards = document.querySelectorAll('[data-testid="review-card"], .review-card, .review');
          for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var ratingEl = card.querySelector('[data-rating], [aria-label*="stars"], [class*="rating"]');
            var stars = 0;
            if (ratingEl) {
              var ariaLabel = ratingEl.getAttribute('aria-label') || '';
              var ariaMatch = ariaLabel.match(/^(\d(?:\.\d)?)/);
              if (ariaMatch) stars = parseFloat(ariaMatch[1]);
              var dataRating = ratingEl.getAttribute('data-rating');
              if (dataRating) stars = parseFloat(dataRating);
            }
            if (stars > 3 || stars === 0) continue;

            var titleEl = card.querySelector('h3, .review-title, [class*="title"]');
            var title = titleEl ? titleEl.textContent.trim() : '';
            var bodyEl = card.querySelector('[class*="body"], [class*="content"], p');
            var body = bodyEl ? bodyEl.textContent.trim() : '';
            if (!body || body.length < 20) continue;

            var reviewLink = card.querySelector('a[href*="/reviews/"]');
            var reviewUrl2 = reviewLink ? reviewLink.href : prodUrl;
            var reviewId = 'capterra-' + prodName.toLowerCase().replace(/\s+/g, '-') + '-' + i;

            results.push({
              id: reviewId,
              stars: stars,
              title: title || (prodName + ' — ' + stars + '-star review'),
              body: body,
              url: reviewUrl2,
              helpfulVotes: 0,
            });
          }
          return results;
        }, product.name, product.url);

        log(`[reviews]   found ${reviews.length} low-star reviews`);

        // Tag with source
        for (const r of reviews) {
          r.source = 'capterra';
          r.productName = product.name;
        }
        allReviews.push(...reviews);
      } catch (err) {
        log(`[reviews]   Capterra product failed: ${err.message}`);
      }
      await politeDelay();
    }
  } catch (err) {
    log(`[reviews] Capterra search failed: ${err.message}`);
  }

  return allReviews;
}

// ─── normalize reviews to common post shape ─────────────────────────────────

/**
 * Convert a raw review object to the common post shape expected by enrichPost().
 * Inverts star rating: 1-star = score 5, 2-star = 4, 3-star = 3.
 */
function normalizeReview(review, source = 'g2', productName = '') {
  const invertedScore = Math.max(1, 6 - Math.round(review.stars));
  const title = review.title || `${productName} — ${review.stars}-star review`;

  return {
    id: review.id || `${source}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: title,
    selftext: review.body || '',
    subreddit: source,        // source name acts as subreddit equivalent
    url: review.url || '',
    score: invertedScore,     // inverted: 1-star pain = 5, 2-star = 4, 3-star = 3
    num_comments: review.helpfulVotes || 0,
    upvote_ratio: 0,
    created_utc: 0,
    flair: review.stars ? `${review.stars}-star` : '',
  };
}

// ─── main scan command ───────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain || '';
  if (!domain) fail('--domain is required (e.g., --domain "project management")');

  const limit = args.limit || 30;
  const sources = (args.sources || 'g2').split(',').map(s => s.trim().toLowerCase());
  const maxProducts = args.maxProducts ? parseInt(args.maxProducts, 10) : MAX_PRODUCTS;

  log(`[reviews-scan] domain="${domain}", sources=${sources.join(',')}, limit=${limit}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();

  // Stealth: realistic user-agent, viewport, and extra headers to reduce bot detection
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  });

  const rawReviews = [];
  const blockTracker = createBlockTracker('reviews');

  try {
    // ── G2 ──────────────────────────────────────────────────────────────────
    if (sources.includes('g2') && !blockTracker.shouldStop) {
      log(`[reviews-scan] searching G2...`);
      const products = await searchG2Products(page, domain, maxProducts);
      await politeDelay();

      for (const product of products) {
        if (blockTracker.shouldStop) break;
        log(`[reviews-scan] scraping G2 product: ${product.name} (${product.slug})`);
        try {
          const reviews = await scrapeG2Reviews(page, product.url, product.name, MAX_REVIEW_PAGES, blockTracker);
          for (const r of reviews) {
            r.source = 'g2';
            r.productName = product.name;
          }
          rawReviews.push(...reviews);
          log(`[reviews-scan]   ${reviews.length} low-star reviews collected`);
        } catch (err) {
          log(`[reviews-scan]   failed for ${product.name}: ${err.message}`);
        }
        await politeDelay();
      }
    }

    // ── Capterra ─────────────────────────────────────────────────────────────
    if (sources.includes('capterra') && !blockTracker.shouldStop) {
      log(`[reviews-scan] searching Capterra...`);
      const reviews = await scrapeCapterraReviews(page, domain, maxProducts, blockTracker);
      rawReviews.push(...reviews);
      log(`[reviews-scan]   ${reviews.length} Capterra low-star reviews collected`);
    }

    log(`[reviews-scan] total raw reviews: ${rawReviews.length}`);

    // Deduplicate by id
    const seenIds = new Set();
    const uniqueReviews = [];
    for (const r of rawReviews) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        uniqueReviews.push(r);
      }
    }

    // Normalize and enrich
    const scored = [];
    for (const review of uniqueReviews) {
      const post = normalizeReview(review, review.source || 'g2', review.productName || domain);
      let enriched = enrichPost(post, domain);

      // For low-star reviews (1-2 stars), bypass the hard pain signal filter:
      // a 1-2 star rating is itself a strong pain indicator even if the text
      // doesn't contain PAIN_SIGNALS keywords. Build a minimal enriched object.
      if (!enriched && review.stars <= 2 && (post.selftext || '').length >= 20) {
        enriched = {
          id: post.id,
          title: post.title || '',
          subreddit: post.subreddit || '',
          url: post.url || '',
          score: post.score || 0,
          num_comments: post.num_comments || 0,
          upvote_ratio: 0,
          created_utc: 0,
          date: null,
          selftext_excerpt: post.selftext ? post.selftext.slice(0, 200) : '',
          // Star-based pain score: 1-star=6, 2-star=5 baseline minus slight engagement gap
          painScore: post.score + 3.0,
          painSignals: [],
          bodyPainSignals: [],
          painCategories: [],
          painSubcategories: [],
          wtpSignals: [],
          intensity: 0,
          flair: post.flair || null,
        };
        log(`[reviews]   star-bypass: kept ${review.stars}-star review (no signal keywords in text)`);
      }

      if (enriched) {
        // Attach source metadata
        enriched.source = review.source || 'g2';
        enriched.productName = review.productName || domain;
        enriched.starRating = review.stars;
        scored.push(enriched);
      }
    }

    scored.sort((a, b) => b.painScore - a.painScore);

    ok({
      mode: 'reviews',
      domain,
      posts: scored.slice(0, limit),
      stats: {
        sources: sources,
        raw_reviews: rawReviews.length,
        unique_reviews: uniqueReviews.length,
        after_filter: Math.min(scored.length, limit),
        blocked: blockTracker.stats.blocked,
        rateLimitWarnings: blockTracker.stats.rateLimitWarnings,
      },
    });
  } finally {
    await page.close();
  }
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'reviews',
  description: 'G2/Capterra review scraper — low-star (1-3 star) pain point extraction',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
reviews source — G2/Capterra low-star review scraper

Commands:
  scan        Scrape 1-3 star reviews from G2 and/or Capterra for a domain

scan options:
  --domain <str>        Product domain to search (required, e.g. "project management")
  --sources <list>      Comma-separated sources: g2,capterra (default: g2)
  --limit <n>           Max reviews to return (default: 30)
  --maxProducts <n>     Max products to scrape per source (default: 5)

Connection options:
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  pain-points reviews scan --domain "project management"
  pain-points reviews scan --domain "CRM software" --sources g2,capterra --limit 50
  pain-points reviews scan --domain "video editing" --maxProducts 3
`,
};
