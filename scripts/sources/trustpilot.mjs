/**
 * trustpilot.mjs — Trustpilot review scraper source for pain-point-finder
 *
 * Primary: HTTP-based scraping (no browser required). Trustpilot pages are
 * server-side rendered, so we fetch HTML and parse JSON-LD / __NEXT_DATA__.
 * Fallback: Puppeteer browser scraping (legacy behavior).
 *
 * Usage:
 *   pain-points trustpilot scan --domain "ticketmaster" --limit 100
 *   pain-points trustpilot scan --companies "ticketmaster.com,stubhub.com" --limit 200
 *   pain-points trustpilot scan --domain "stubhub" --api-only
 *   pain-points trustpilot scan --domain "stubhub" --browser-only
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { RateLimiter } from '../lib/http.mjs';
import { createBlockTracker } from '../lib/browser.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const TRUSTPILOT_BASE = 'https://www.trustpilot.com';
const TRUSTPILOT_HOST = 'www.trustpilot.com';
const PAGE_DELAY_MS = 2500;
const JITTER_MS = 700;
const MAX_PAGES_PER_COMPANY = 150; // up to 150 pages × 20 reviews = 3000 reviews
const REVIEWS_PER_PAGE = 20;
const HTTP_TIMEOUT_MS = 20000;

// Standard browser-like headers to avoid blocks
const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
};

// Built-in domain → Trustpilot company slug mapping
const DOMAIN_MAP = {
  ticketmaster:  'ticketmaster.com',
  stubhub:       'stubhub.com',
  seatgeek:      'seatgeek.com',
  vividseats:    'vividseats.com',
  axs:           'axs.com',
  eventbrite:    'eventbrite.com',
  viagogo:       'viagogo.com',
  livenation:    'livenation.com',
  gametime:      'gametime.co',
  goldstar:      'goldstar.com',
};

// ─── polite delay ────────────────────────────────────────────────────────────

async function politeDelay() {
  await sleep(PAGE_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

// ─── domain → company slug resolution ────────────────────────────────────────

/**
 * Resolve a domain keyword (e.g. "ticketmaster") to a list of Trustpilot
 * company slugs (e.g. ["ticketmaster.com"]).
 * Supports fuzzy matching against the DOMAIN_MAP keys.
 */
function resolveCompanies(domain) {
  const key = domain.toLowerCase().trim();

  // Exact match in map
  if (DOMAIN_MAP[key]) return [DOMAIN_MAP[key]];

  // Fuzzy: map key contains domain term or domain term contains map key
  const matches = [];
  for (const [mapKey, slug] of Object.entries(DOMAIN_MAP)) {
    if (mapKey.includes(key) || key.includes(mapKey)) {
      matches.push(slug);
    }
  }
  if (matches.length > 0) return matches;

  // Fall back: treat the domain itself as a Trustpilot slug (e.g. "acme.com")
  return [key.includes('.') ? key : `${key}.com`];
}

// ─── HTTP fetching ──────────────────────────────────────────────────────────

/**
 * Fetch raw HTML from a URL via HTTPS GET.
 * Returns { statusCode, body, headers } or throws on network error.
 */
function fetchHtml(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: TRUSTPILOT_HOST,
      path: urlPath,
      headers: HTTP_HEADERS,
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      // Follow redirects (301/302/307/308)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        // If relative URL, recurse; if absolute, parse and recurse
        if (loc.startsWith('/')) {
          return fetchHtml(loc).then(resolve, reject);
        }
        try {
          const u = new URL(loc);
          return fetchHtml(u.pathname + u.search).then(resolve, reject);
        } catch {
          return reject(new Error(`Bad redirect: ${loc}`));
        }
      }

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.on('error', reject);
  });
}

// ─── HTML parsing helpers ───────────────────────────────────────────────────

/**
 * Extract reviews from __NEXT_DATA__ JSON embedded in the page.
 * Returns { reviews: [...], hasNext: bool } or null if not found.
 */
function parseNextData(html, companySlug) {
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!nextDataMatch) return null;

  try {
    const data = JSON.parse(nextDataMatch[1]);
    const pageProps = data?.props?.pageProps;
    if (!pageProps) return null;

    // Trustpilot stores reviews in pageProps.reviews or pageProps.reviewList
    const reviewList = pageProps.reviews || pageProps.reviewList || [];
    if (!Array.isArray(reviewList) || reviewList.length === 0) return null;

    const reviews = [];
    for (const r of reviewList) {
      const stars = r.rating || r.stars || 0;
      if (stars === 0 || stars > 3) continue;

      const title = r.title || r.heading || '';
      const body = r.text || r.content || r.body || '';
      if (!body || body.length < 10) continue;

      const dateStr = r.createdAt || r.dates?.publishedDate || r.date || '';
      const reviewId = r.id || `tp-next-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const reviewUrl = r.id ? `${TRUSTPILOT_BASE}/reviews/${r.id}` : '';

      reviews.push({
        id: reviewId,
        stars,
        title,
        body,
        date: dateStr,
        usefulVotes: r.likes || r.usefulCount || 0,
        url: reviewUrl,
        companySlug,
      });
    }

    // Check for pagination
    const pagination = pageProps.pagination || pageProps.pageInfo || {};
    const hasNext = !!(pagination.hasNextPage || pagination.nextPage ||
                       (pagination.currentPage && pagination.totalPages &&
                        pagination.currentPage < pagination.totalPages));

    return { reviews, hasNext };
  } catch (err) {
    log(`[trustpilot]   __NEXT_DATA__ parse error: ${err.message}`);
    return null;
  }
}

/**
 * Extract reviews from JSON-LD structured data.
 * Returns { reviews: [...] } or null if not found.
 */
function parseJsonLd(html, companySlug) {
  const jsonLdBlocks = [];
  const regex = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      jsonLdBlocks.push(JSON.parse(match[1]));
    } catch { /* skip malformed */ }
  }

  if (jsonLdBlocks.length === 0) return null;

  const reviews = [];

  for (const block of jsonLdBlocks) {
    // Could be an array or single object
    const items = Array.isArray(block) ? block : [block];
    for (const item of items) {
      // Look for Review type
      if (item['@type'] === 'Review') {
        extractJsonLdReview(item, companySlug, reviews);
      }
      // Look for reviews array inside an Organization/LocalBusiness
      if (item.review && Array.isArray(item.review)) {
        for (const r of item.review) {
          extractJsonLdReview(r, companySlug, reviews);
        }
      }
      // AggregateRating with individual reviews
      if (item['@graph'] && Array.isArray(item['@graph'])) {
        for (const g of item['@graph']) {
          if (g['@type'] === 'Review') {
            extractJsonLdReview(g, companySlug, reviews);
          }
        }
      }
    }
  }

  return reviews.length > 0 ? { reviews } : null;
}

function extractJsonLdReview(r, companySlug, out) {
  const stars = r.reviewRating?.ratingValue
    ? parseInt(r.reviewRating.ratingValue, 10)
    : 0;
  if (stars === 0 || stars > 3) return;

  const title = r.headline || r.name || '';
  const body = r.reviewBody || r.description || '';
  if (!body || body.length < 10) return;

  const dateStr = r.datePublished || '';
  const reviewId = r.url
    ? (r.url.match(/\/reviews\/([^?#/]+)/) || [])[1] || `tp-ld-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : `tp-ld-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  out.push({
    id: reviewId,
    stars,
    title,
    body,
    date: dateStr,
    usefulVotes: 0,
    url: r.url || '',
    companySlug,
  });
}

/**
 * Fallback: parse reviews from raw HTML using regex patterns on Trustpilot's
 * server-rendered review cards.
 */
function parseHtmlCards(html, companySlug) {
  const reviews = [];

  // Trustpilot SSR uses data-service-review-card-paper articles
  // Try to extract review blocks by looking for patterns
  const cardRegex = /<article[^>]*data-service-review-card-paper[^>]*>([\s\S]*?)<\/article>/gi;
  let cardMatch;
  let idx = 0;

  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const card = cardMatch[1];
    idx++;

    // Star rating from img alt text: "Rated 2 out of 5 stars"
    let stars = 0;
    const starAltMatch = card.match(/Rated\s+(\d)\s+out\s+of\s+5/i);
    if (starAltMatch) {
      stars = parseInt(starAltMatch[1], 10);
    }
    // Fallback: data-service-review-rating attribute
    if (!stars) {
      const ratingAttr = cardMatch[0].match(/data-service-review-rating="(\d)"/);
      if (ratingAttr) stars = parseInt(ratingAttr[1], 10);
    }

    if (stars === 0 || stars > 3) continue;

    // Title: h2 with data-service-review-title-typography
    let title = '';
    const titleMatch = card.match(/data-service-review-title-typography[^>]*>([^<]+)</);
    if (titleMatch) title = titleMatch[1].trim();
    // Fallback: first h2
    if (!title) {
      const h2Match = card.match(/<h2[^>]*>([^<]+)<\/h2>/i);
      if (h2Match) title = h2Match[1].trim();
    }

    // Body: data-service-review-text-typography
    let body = '';
    const bodyMatch = card.match(/data-service-review-text-typography[^>]*>([\s\S]*?)<\//);
    if (bodyMatch) body = bodyMatch[1].replace(/<[^>]+>/g, '').trim();
    // Fallback: first <p> inside the card
    if (!body) {
      const pMatch = card.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (pMatch) body = pMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    if (!body || body.length < 10) continue;

    // Date from <time datetime="...">
    let dateStr = '';
    const timeMatch = card.match(/<time[^>]*datetime="([^"]+)"/);
    if (timeMatch) dateStr = timeMatch[1];

    // Review URL
    let reviewUrl = '';
    let reviewId = `tp-html-${idx}-${Date.now()}`;
    const linkMatch = card.match(/href="(\/reviews\/[^"]+)"/);
    if (linkMatch) {
      reviewUrl = `${TRUSTPILOT_BASE}${linkMatch[1]}`;
      const idMatch = linkMatch[1].match(/\/reviews\/([^?#/]+)/);
      if (idMatch) reviewId = idMatch[1];
    }

    reviews.push({
      id: reviewId,
      stars,
      title,
      body,
      date: dateStr,
      usefulVotes: 0,
      url: reviewUrl,
      companySlug,
    });
  }

  // Detect next page
  let hasNext = false;
  if (html.includes('aria-label="Next page"') ||
      html.includes('rel="next"') ||
      html.includes('data-pagination-button-next-link') ||
      html.includes('paginationNext')) {
    hasNext = true;
  }

  return { reviews, hasNext };
}

// ─── HTTP-based page scraping ───────────────────────────────────────────────

/**
 * Scrape one page of Trustpilot reviews via HTTP.
 * Tries __NEXT_DATA__ first, then JSON-LD, then HTML card parsing.
 * Returns { reviews, hasNext, blocked, httpFailed }.
 */
async function scrapePageHttp(companySlug, stars, pageNum) {
  const urlPath = `/review/${companySlug}?stars=${stars}&page=${pageNum}`;
  log(`[trustpilot]   HTTP page ${pageNum}: ${TRUSTPILOT_BASE}${urlPath}`);

  try {
    const { statusCode, body } = await fetchHtml(urlPath);

    if (statusCode === 403 || statusCode === 429) {
      log(`[trustpilot]   HTTP ${statusCode} — blocked or rate-limited`);
      return { reviews: [], hasNext: false, blocked: true, httpFailed: true };
    }

    if (statusCode !== 200) {
      log(`[trustpilot]   HTTP ${statusCode} — unexpected status`);
      return { reviews: [], hasNext: false, blocked: false, httpFailed: true };
    }

    // Check for CAPTCHA / challenge pages
    if (body.includes('you have been blocked') ||
        body.includes('verify you are human') ||
        body.includes('unusual traffic') ||
        body.includes('id="challenge-form"') ||
        body.includes('cf-challenge-running')) {
      log(`[trustpilot]   anti-bot challenge detected in HTTP response`);
      return { reviews: [], hasNext: false, blocked: true, httpFailed: true };
    }

    // Strategy 1: __NEXT_DATA__
    const nextResult = parseNextData(body, companySlug);
    if (nextResult && nextResult.reviews.length > 0) {
      log(`[trustpilot]   parsed ${nextResult.reviews.length} reviews from __NEXT_DATA__`);
      return { reviews: nextResult.reviews, hasNext: nextResult.hasNext, blocked: false, httpFailed: false };
    }

    // Strategy 2: JSON-LD
    const ldResult = parseJsonLd(body, companySlug);
    if (ldResult && ldResult.reviews.length > 0) {
      log(`[trustpilot]   parsed ${ldResult.reviews.length} reviews from JSON-LD`);
      // JSON-LD doesn't reliably indicate pagination, fall back to HTML check
      const htmlParse = parseHtmlCards(body, companySlug);
      return { reviews: ldResult.reviews, hasNext: htmlParse.hasNext, blocked: false, httpFailed: false };
    }

    // Strategy 3: HTML card parsing
    const htmlResult = parseHtmlCards(body, companySlug);
    if (htmlResult.reviews.length > 0) {
      log(`[trustpilot]   parsed ${htmlResult.reviews.length} reviews from HTML cards`);
      return { reviews: htmlResult.reviews, hasNext: htmlResult.hasNext, blocked: false, httpFailed: false };
    }

    // Page loaded but no reviews found — may be end of results or empty star tier
    log(`[trustpilot]   no reviews parsed from HTTP response (page may be empty)`);
    return { reviews: [], hasNext: false, blocked: false, httpFailed: false };
  } catch (err) {
    log(`[trustpilot]   HTTP fetch error: ${err.message}`);
    return { reviews: [], hasNext: false, blocked: false, httpFailed: true };
  }
}

// ─── Puppeteer-based scraping (fallback) ────────────────────────────────────

/**
 * Scrape one page of Trustpilot reviews via Puppeteer.
 * Returns { reviews, hasNext, blocked }.
 */
async function scrapePageBrowser(page, url, companySlug) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // Check for anti-bot / CAPTCHA
    const blocked = await page.evaluate(() => {
      var title = (document.title || '').toLowerCase();
      if (title.includes('blocked') || title.includes('captcha') || title.includes('access denied')) return true;
      if (document.querySelector('#challenge-form, .cf-challenge-running, .cf-error-code, [id*="captcha-container"], iframe[src*="captcha"]')) return true;
      var bodyText = document.body ? document.body.textContent : '';
      if (bodyText.includes('you have been blocked') ||
          bodyText.includes('verify you are human') ||
          bodyText.includes('unusual traffic') ||
          bodyText.includes('Access denied')) return true;
      return false;
    });

    if (blocked) {
      log(`[trustpilot]   browser: anti-bot protection detected`);
      return { reviews: [], blocked: true };
    }

    const result = await page.evaluate(() => {
      var reviews = [];

      var cardSelectors = [
        'article[data-service-review-card-paper]',
        '[data-service-review-card-paper]',
        '.styles_reviewCard__hcAvl',
        '[class*="reviewCard"]',
        'article.review',
        '.review-card',
      ];

      var cards = [];
      for (var sel of cardSelectors) {
        var found = document.querySelectorAll(sel);
        if (found.length > 0) { cards = Array.from(found); break; }
      }
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll('article'));
      }

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];

        var stars = 0;
        var cardRating = card.getAttribute('data-service-review-rating');
        if (cardRating) stars = parseInt(cardRating, 10);

        if (!stars) {
          var starImgs = card.querySelectorAll('img[alt*="out of 5"], img[alt*="star"]');
          for (var si = 0; si < starImgs.length; si++) {
            var alt = starImgs[si].getAttribute('alt') || '';
            var altMatch = alt.match(/rated\s+(\d)/i) || alt.match(/^(\d)/);
            if (altMatch) { stars = parseInt(altMatch[1], 10); break; }
          }
        }

        if (!stars) {
          var starEl = card.querySelector('[class*="star"], [data-star-rating], [aria-label*="star"]');
          if (starEl) {
            var aria = starEl.getAttribute('aria-label') || '';
            var ariaMatch = aria.match(/(\d)/);
            if (ariaMatch) stars = parseInt(ariaMatch[1], 10);
            if (!stars) {
              var filled = card.querySelectorAll('[class*="star"][class*="filled"], [class*="starFilled"]');
              if (filled.length > 0) stars = filled.length;
            }
          }
        }

        if (stars === 0 || stars > 3) continue;

        var titleEl = card.querySelector(
          'h2[data-service-review-title-typography], [class*="reviewTitle"], h2, h3'
        );
        var title = titleEl ? titleEl.textContent.trim() : '';

        var bodyEl = card.querySelector(
          '[data-service-review-text-typography], [class*="reviewBody"], [class*="reviewContent"], p'
        );
        var body = bodyEl ? bodyEl.textContent.trim() : '';
        if (!body) {
          var paras = Array.from(card.querySelectorAll('p'));
          body = paras.map(function(p) { return p.textContent.trim(); }).filter(Boolean).join(' ');
        }
        if (!body || body.length < 10) continue;

        var dateEl = card.querySelector('time');
        var dateStr = dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent.trim()) : '';

        var usefulVotes = 0;
        var usefulEl = card.querySelector('[class*="useful"], [class*="helpful"], [class*="vote"]');
        if (usefulEl) {
          var uvMatch = usefulEl.textContent.match(/(\d+)/);
          if (uvMatch) usefulVotes = parseInt(uvMatch[1], 10);
        }

        var reviewLink = card.querySelector('a[href*="/reviews/"]');
        var reviewUrl = reviewLink ? reviewLink.href : '';
        var reviewIdMatch = reviewUrl.match(/\/reviews\/([^?#/]+)/);
        var reviewId = reviewIdMatch ? reviewIdMatch[1] : ('tp-' + i + '-' + Date.now());

        reviews.push({
          id: reviewId,
          stars: stars,
          title: title,
          body: body,
          date: dateStr,
          usefulVotes: usefulVotes,
          url: reviewUrl,
        });
      }

      var hasNext = !!(
        document.querySelector('a[data-pagination-button-next-link]') ||
        document.querySelector('a[aria-label="Next page"]') ||
        document.querySelector('button[aria-label="Next page"]') ||
        document.querySelector('.pagination-link--next') ||
        document.querySelector('[class*="paginationNext"]') ||
        document.querySelector('nav[aria-label*="pagination"] a[rel="next"]') ||
        document.querySelector('a[rel="next"]')
      );

      return { reviews: reviews, hasNext: hasNext };
    });

    // Tag with companySlug
    for (const r of result.reviews) {
      r.companySlug = companySlug;
    }

    return { reviews: result.reviews, hasNext: result.hasNext, blocked: false };
  } catch (err) {
    log(`[trustpilot]   browser page error: ${err.message}`);
    return { reviews: [], hasNext: false, blocked: false };
  }
}

// ─── company-level scraping orchestration ───────────────────────────────────

/**
 * Scrape all low-star reviews for a single company via HTTP.
 * Falls back to Puppeteer per-page if HTTP fails (unless apiOnly).
 */
async function scrapeCompanyHttp(companySlug, maxPages, targetLimit, { apiOnly, browserFallbackFn, blockTracker }) {
  const allReviews = [];
  const seenIds = new Set();
  let httpFailedConsecutive = 0;

  for (const stars of [1, 2, 3]) {
    if (allReviews.length >= targetLimit) break;
    if (blockTracker && blockTracker.shouldStop) break;

    log(`[trustpilot] HTTP scraping ${companySlug} — ${stars}-star reviews`);
    httpFailedConsecutive = 0;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (allReviews.length >= targetLimit) break;
      if (blockTracker && blockTracker.shouldStop) break;

      const { reviews, hasNext, blocked, httpFailed } = await scrapePageHttp(companySlug, stars, pageNum);

      if (blocked) {
        if (blockTracker) blockTracker.recordBlock('http-blocked');
        if (apiOnly) {
          log(`[trustpilot]   blocked and --api-only set, stopping star tier`);
          break;
        }
        if (browserFallbackFn) {
          log(`[trustpilot]   HTTP blocked, falling back to browser for remaining pages`);
          const browserReviews = await browserFallbackFn(companySlug, stars, pageNum, maxPages, targetLimit - allReviews.length);
          for (const r of browserReviews) {
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              allReviews.push(r);
            }
          }
        }
        break;
      }

      if (httpFailed) {
        httpFailedConsecutive++;
        if (httpFailedConsecutive >= 3) {
          log(`[trustpilot]   3 consecutive HTTP failures, stopping star tier`);
          break;
        }
        await politeDelay();
        continue;
      }

      httpFailedConsecutive = 0;
      if (blockTracker) blockTracker.recordSuccess();
      let newCount = 0;
      for (const r of reviews) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          allReviews.push(r);
          newCount++;
        }
      }

      log(`[trustpilot]   +${newCount} new reviews (total: ${allReviews.length})`);

      if (!hasNext || reviews.length === 0) {
        log(`[trustpilot]   no more pages for ${stars}-star`);
        break;
      }

      await politeDelay();
    }

    await politeDelay();
  }

  return allReviews;
}

/**
 * Scrape all low-star reviews for a single company via Puppeteer (legacy).
 */
async function scrapeCompanyBrowser(page, companySlug, maxPages, targetLimit) {
  const allReviews = [];
  const seenIds = new Set();

  for (const stars of [1, 2, 3]) {
    if (allReviews.length >= targetLimit) break;

    log(`[trustpilot] browser scraping ${companySlug} — ${stars}-star reviews`);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (allReviews.length >= targetLimit) break;

      const url = `${TRUSTPILOT_BASE}/review/${companySlug}?stars=${stars}&page=${pageNum}`;
      log(`[trustpilot]   browser page ${pageNum}: ${url}`);

      const { reviews, hasNext, blocked } = await scrapePageBrowser(page, url, companySlug);

      if (blocked) break;

      let newCount = 0;
      for (const r of reviews) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          r.companySlug = companySlug;
          allReviews.push(r);
          newCount++;
        }
      }

      log(`[trustpilot]   +${newCount} new reviews (total: ${allReviews.length})`);

      if (!hasNext || reviews.length === 0) {
        log(`[trustpilot]   no more pages for ${stars}-star`);
        break;
      }

      await politeDelay();
    }

    await politeDelay();
  }

  return allReviews;
}

/**
 * Browser fallback function: scrape remaining pages of a star tier via Puppeteer.
 * Used when HTTP is blocked mid-scrape.
 */
async function makeBrowserFallback(args) {
  let page = null;

  return async function browserFallback(companySlug, stars, startPage, maxPages, remainingLimit) {
    // Lazy-connect browser only when actually needed
    if (!page) {
      try {
        const { connectBrowser } = await import('../lib/browser.mjs');
        const browser = await connectBrowser(args, { throwOnFail: true });
        page = await browser.newPage();
        await page.setUserAgent(HTTP_HEADERS['User-Agent']);
        await page.setViewport({ width: 1280, height: 900 });
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
        });
        log(`[trustpilot]   browser fallback: connected`);
      } catch (err) {
        log(`[trustpilot]   browser fallback failed: ${err.message}`);
        return [];
      }
    }

    const reviews = [];
    for (let pageNum = startPage; pageNum <= maxPages; pageNum++) {
      if (reviews.length >= remainingLimit) break;

      const url = `${TRUSTPILOT_BASE}/review/${companySlug}?stars=${stars}&page=${pageNum}`;
      log(`[trustpilot]   browser fallback page ${pageNum}: ${url}`);

      const result = await scrapePageBrowser(page, url, companySlug);
      if (result.blocked) break;

      for (const r of result.reviews) {
        r.companySlug = companySlug;
        reviews.push(r);
      }

      if (!result.hasNext || result.reviews.length === 0) break;
      await politeDelay();
    }

    return reviews;
  };
}

// ─── normalize to common post shape ──────────────────────────────────────────

/**
 * Convert a raw Trustpilot review to the common post shape expected by enrichPost().
 * score = inverted star rating (1-star pain = 5, 2-star = 4, 3-star = 3).
 */
function normalizeReview(review, companyName) {
  const invertedScore = Math.max(1, 6 - Math.round(review.stars || 1));
  const titlePrefix = companyName || review.companySlug || 'trustpilot';
  const starsLabel = review.stars ? `${review.stars}-star` : 'low-star';
  const titleText = review.title
    ? `${titlePrefix} ${starsLabel}: ${review.title}`
    : `${titlePrefix} ${starsLabel} review`;

  return {
    id: review.id || `tp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: titleText,
    selftext: review.body || '',
    subreddit: 'trustpilot',
    url: review.url || `${TRUSTPILOT_BASE}/review/${review.companySlug || ''}`,
    score: invertedScore,
    num_comments: 0,
    upvote_ratio: 0,
    created_utc: review.date ? Math.floor(new Date(review.date).getTime() / 1000) || 0 : 0,
    flair: starsLabel,
  };
}

// ─── scan command ─────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = (args.domain || '').trim();
  const companiesArg = (args.companies || '').trim();

  if (!domain && !companiesArg) {
    fail('--domain or --companies is required (e.g., --domain "ticketmaster" or --companies "ticketmaster.com,stubhub.com")');
  }

  const limit = args.limit ? parseInt(args.limit, 10) : 100;
  const maxPages = args.maxPages ? parseInt(args.maxPages, 10) : MAX_PAGES_PER_COMPANY;
  const apiOnly = !!args.apiOnly;
  const browserOnly = !!args.browserOnly;

  if (apiOnly && browserOnly) {
    fail('Cannot use both --api-only and --browser-only');
  }

  // Build list of company slugs to scrape
  let companySlugs = [];
  if (companiesArg) {
    companySlugs = companiesArg.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    companySlugs = resolveCompanies(domain);
  }

  log(`[trustpilot] domain="${domain}", companies=${companySlugs.join(',')}, limit=${limit}, mode=${browserOnly ? 'browser-only' : apiOnly ? 'api-only' : 'http+fallback'}`);

  const rawReviews = [];
  const blockTracker = createBlockTracker('trustpilot');

  if (browserOnly) {
    // ── Browser-only mode (legacy) ────────────────────────────────────────
    const { connectBrowser } = await import('../lib/browser.mjs');
    const browser = await connectBrowser(args);
    const page = await browser.newPage();
    await page.setUserAgent(HTTP_HEADERS['User-Agent']);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    });

    try {
      for (const slug of companySlugs) {
        if (rawReviews.length >= limit * 3 || blockTracker.shouldStop) break;
        log(`[trustpilot] === company: ${slug} ===`);
        const perCompanyLimit = Math.ceil(limit / companySlugs.length) * 3;
        const reviews = await scrapeCompanyBrowser(page, slug, maxPages, perCompanyLimit);
        log(`[trustpilot] ${reviews.length} raw reviews from ${slug}`);
        rawReviews.push(...reviews);
      }
    } finally {
      await page.close();
    }
  } else {
    // ── HTTP mode (primary) with optional browser fallback ────────────────
    let browserFallbackFn = null;
    if (!apiOnly) {
      browserFallbackFn = await makeBrowserFallback(args);
    }

    for (const slug of companySlugs) {
      if (rawReviews.length >= limit * 3 || blockTracker.shouldStop) break;
      log(`[trustpilot] === company: ${slug} ===`);
      const perCompanyLimit = Math.ceil(limit / companySlugs.length) * 3;
      const reviews = await scrapeCompanyHttp(slug, maxPages, perCompanyLimit, {
        apiOnly,
        browserFallbackFn,
        blockTracker,
      });
      log(`[trustpilot] ${reviews.length} raw reviews from ${slug}`);
      rawReviews.push(...reviews);
    }
  }

  log(`[trustpilot] total raw reviews: ${rawReviews.length}`);

  // Deduplicate
  const seenIds = new Set();
  const uniqueReviews = [];
  for (const r of rawReviews) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      uniqueReviews.push(r);
    }
  }

  log(`[trustpilot] unique reviews: ${uniqueReviews.length}`);

  // Save ALL raw reviews before filtering for LLM batch-evaluation
  try {
    const allRawPosts = uniqueReviews.map(r => {
      const companyName = r.companySlug ? r.companySlug.replace(/\.com$/, '').replace(/[.-]/g, ' ') : domain;
      return normalizeReview(r, companyName);
    });
    const rawOutput = { ok: true, data: { source: 'trustpilot', posts: allRawPosts, stats: { raw: true, total: allRawPosts.length } } };
    writeFileSync('/tmp/ppf-trustpilot-raw.json', JSON.stringify(rawOutput));
    log(`[trustpilot] saved ${allRawPosts.length} raw posts to /tmp/ppf-trustpilot-raw.json`);
  } catch (err) {
    log(`[trustpilot] failed to save raw posts: ${err.message}`);
  }

  // Normalize and enrich
  const scored = [];
  for (const review of uniqueReviews) {
    const companyName = review.companySlug
      ? review.companySlug.replace(/\.com$/, '').replace(/[.-]/g, ' ')
      : domain;
    const post = normalizeReview(review, companyName);
    let enriched = enrichPost(post, domain || companyName);

    // Star-bypass for 1-2 star reviews: rating alone signals pain
    if (!enriched && review.stars <= 2 && (post.selftext || '').length >= 10) {
      enriched = {
        id: post.id,
        title: post.title || '',
        subreddit: post.subreddit || 'trustpilot',
        url: post.url || '',
        score: post.score || 0,
        num_comments: 0,
        upvote_ratio: 0,
        created_utc: post.created_utc || 0,
        date: null,
        selftext_excerpt: post.selftext ? post.selftext.slice(0, 200) : '',
        painScore: post.score + 2.5,
        painSignals: [],
        bodyPainSignals: [],
        painCategories: [],
        painSubcategories: [],
        wtpSignals: [],
        intensity: 0,
        flair: post.flair || null,
      };
    }

    if (enriched) {
      enriched.source = 'trustpilot';
      enriched.companySlug = review.companySlug || '';
      enriched.starRating = review.stars;
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    mode: 'trustpilot',
    domain: domain || companySlugs.join(','),
    posts: scored.slice(0, limit),
    stats: {
      companies: companySlugs,
      raw_reviews: rawReviews.length,
      unique_reviews: uniqueReviews.length,
      after_filter: Math.min(scored.length, limit),
      blocked: blockTracker.stats.blocked,
      rateLimitWarnings: blockTracker.stats.rateLimitWarnings,
    },
  });
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'trustpilot',
  description: 'Trustpilot review scraper — HTTP-first with browser fallback for low-star (1-3 star) reviews',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
trustpilot source — Trustpilot low-star review scraper

  Primary: HTTP-based scraping (no browser/Chrome required)
  Fallback: Puppeteer browser scraping if HTTP is blocked

Commands:
  scan        Scrape 1-3 star reviews from Trustpilot for a domain

scan options:
  --domain <str>        Domain keyword to look up (e.g. "ticketmaster", "stubhub")
  --companies <list>    Comma-separated Trustpilot company slugs (e.g. "ticketmaster.com,stubhub.com")
  --limit <n>           Max reviews to return (default: 100)
  --maxPages <n>        Max pages to scrape per star tier per company (default: 150)
  --api-only            Use HTTP scraping only — skip browser fallback entirely
  --browser-only        Use Puppeteer only — legacy behavior, requires Chrome

Built-in domain mappings:
  ticketmaster → ticketmaster.com    stubhub → stubhub.com
  seatgeek → seatgeek.com            vividseats → vividseats.com
  axs → axs.com                      eventbrite → eventbrite.com
  viagogo → viagogo.com              livenation → livenation.com
  gametime → gametime.co             goldstar → goldstar.com

Connection options (for --browser-only or fallback):
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  pain-points trustpilot scan --domain "ticketmaster" --limit 100
  pain-points trustpilot scan --domain "stubhub" --limit 500 --api-only
  pain-points trustpilot scan --companies "ticketmaster.com,stubhub.com" --limit 200
  pain-points trustpilot scan --domain "ticketmaster" --browser-only
`,
};
