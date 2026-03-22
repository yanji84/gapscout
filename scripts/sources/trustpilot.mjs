/**
 * trustpilot.mjs — Trustpilot review scraper source for pain-point-finder
 *
 * Scrapes 1-3 star reviews from Trustpilot via Puppeteer. Connects to an
 * existing Chrome instance using the same connectBrowser pattern as
 * reddit-browser.mjs.
 *
 * Usage:
 *   pain-points trustpilot scan --domain "ticketmaster" --limit 100
 *   pain-points trustpilot scan --companies "ticketmaster.com,stubhub.com" --limit 200
 */

import { sleep, log, ok, fail } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { connectBrowser, politeDelay as politeDelayBase } from '../lib/browser.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const TRUSTPILOT_BASE = 'https://www.trustpilot.com';
const PAGE_DELAY_MS = 2500;
const JITTER_MS = 700;
const MAX_PAGES_PER_COMPANY = 150; // up to 150 pages × 20 reviews = 3000 reviews
const REVIEWS_PER_PAGE = 20;

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

async function politeDelay() {
  await politeDelayBase(PAGE_DELAY_MS, JITTER_MS);
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

// ─── Trustpilot scraping ─────────────────────────────────────────────────────

/**
 * Scrape one page of Trustpilot reviews.
 * Returns array of raw review objects.
 */
async function scrapeTrustpilotPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // Check for anti-bot / CAPTCHA — only flag if it's a real challenge page, not
    // Trustpilot's own page which embeds reCaptcha site keys in its JSON scripts.
    const blocked = await page.evaluate(() => {
      var title = (document.title || '').toLowerCase();
      // Title-based checks are reliable
      if (title.includes('blocked') || title.includes('captcha') || title.includes('access denied')) return true;
      // Check for visible challenge elements (not just text in scripts)
      if (document.querySelector('#challenge-form, .cf-challenge-running, .cf-error-code, [id*="captcha-container"], iframe[src*="captcha"]')) return true;
      // Check body text but only for phrases that wouldn't appear in normal page scripts
      var bodyText = document.body ? document.body.textContent : '';
      if (bodyText.includes('you have been blocked') ||
          bodyText.includes('verify you are human') ||
          bodyText.includes('unusual traffic') ||
          bodyText.includes('Access denied')) return true;
      return false;
    });

    if (blocked) {
      log(`[trustpilot]   anti-bot protection detected, stopping pagination`);
      return { reviews: [], blocked: true };
    }

    const result = await page.evaluate(() => {
      var reviews = [];

      // Trustpilot uses data-service-review-card-paper or article[data-service-review-*]
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

      // Fallback: grab all <article> tags on the page
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll('article'));
      }

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];

        // ── Star rating ──────────────────────────────────────────────────────
        var stars = 0;

        // data-service-review-rating attribute on the card itself
        var cardRating = card.getAttribute('data-service-review-rating');
        if (cardRating) stars = parseInt(cardRating, 10);

        // img alt text: "Rated 2 out of 5 stars."
        if (!stars) {
          var starImgs = card.querySelectorAll('img[alt*="out of 5"], img[alt*="star"]');
          for (var si = 0; si < starImgs.length; si++) {
            var alt = starImgs[si].getAttribute('alt') || '';
            var altMatch = alt.match(/rated\s+(\d)/i) || alt.match(/^(\d)/);
            if (altMatch) { stars = parseInt(altMatch[1], 10); break; }
          }
        }

        // aria-label on star container
        if (!stars) {
          var starEl = card.querySelector('[class*="star"], [data-star-rating], [aria-label*="star"]');
          if (starEl) {
            var aria = starEl.getAttribute('aria-label') || '';
            var ariaMatch = aria.match(/(\d)/);
            if (ariaMatch) stars = parseInt(ariaMatch[1], 10);
            // Count filled SVG stars as fallback
            if (!stars) {
              var filled = card.querySelectorAll('[class*="star"][class*="filled"], [class*="starFilled"]');
              if (filled.length > 0) stars = filled.length;
            }
          }
        }

        // Only keep 1-3 star reviews
        if (stars === 0 || stars > 3) continue;

        // ── Review title ─────────────────────────────────────────────────────
        var titleEl = card.querySelector(
          'h2[data-service-review-title-typography], [class*="reviewTitle"], h2, h3'
        );
        var title = titleEl ? titleEl.textContent.trim() : '';

        // ── Review body ──────────────────────────────────────────────────────
        var bodyEl = card.querySelector(
          '[data-service-review-text-typography], [class*="reviewBody"], [class*="reviewContent"], p'
        );
        var body = bodyEl ? bodyEl.textContent.trim() : '';

        // Fallback: gather all <p> text
        if (!body) {
          var paras = Array.from(card.querySelectorAll('p'));
          body = paras.map(function(p) { return p.textContent.trim(); }).filter(Boolean).join(' ');
        }

        if (!body || body.length < 10) continue;

        // ── Date ─────────────────────────────────────────────────────────────
        var dateEl = card.querySelector('time');
        var dateStr = dateEl ? (dateEl.getAttribute('datetime') || dateEl.textContent.trim()) : '';

        // ── Useful votes ─────────────────────────────────────────────────────
        var usefulVotes = 0;
        var usefulEl = card.querySelector('[class*="useful"], [class*="helpful"], [class*="vote"]');
        if (usefulEl) {
          var uvMatch = usefulEl.textContent.match(/(\d+)/);
          if (uvMatch) usefulVotes = parseInt(uvMatch[1], 10);
        }

        // ── Review URL / ID ──────────────────────────────────────────────────
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

      // Also detect if next page exists
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

    return { reviews: result.reviews, hasNext: result.hasNext, blocked: false };
  } catch (err) {
    log(`[trustpilot]   page error: ${err.message}`);
    return { reviews: [], hasNext: false, blocked: false };
  }
}

/**
 * Scrape all low-star reviews for a single Trustpilot company.
 * Paginates through stars=1, stars=2, stars=3 separately.
 */
async function scrapeTrustpilotCompany(page, companySlug, maxPages, targetLimit) {
  const allReviews = [];
  const seenIds = new Set();

  for (const stars of [1, 2, 3]) {
    if (allReviews.length >= targetLimit) break;

    log(`[trustpilot] scraping ${companySlug} — ${stars}-star reviews`);

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (allReviews.length >= targetLimit) break;

      const url = `${TRUSTPILOT_BASE}/review/${companySlug}?stars=${stars}&page=${pageNum}`;
      log(`[trustpilot]   page ${pageNum}: ${url}`);

      const { reviews, hasNext, blocked } = await scrapeTrustpilotPage(page, url);

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

  // Build list of company slugs to scrape
  let companySlugs = [];
  if (companiesArg) {
    companySlugs = companiesArg.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    companySlugs = resolveCompanies(domain);
  }

  log(`[trustpilot] domain="${domain}", companies=${companySlugs.join(',')}, limit=${limit}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();

  // Stealth headers to reduce bot detection
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

  try {
    for (const slug of companySlugs) {
      if (rawReviews.length >= limit * 3) break; // collect 3× limit before filtering
      log(`[trustpilot] === company: ${slug} ===`);
      const perCompanyLimit = Math.ceil(limit / companySlugs.length) * 3;
      const reviews = await scrapeTrustpilotCompany(page, slug, maxPages, perCompanyLimit);
      log(`[trustpilot] ${reviews.length} raw reviews from ${slug}`);
      rawReviews.push(...reviews);
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
      },
    });
  } finally {
    await page.close();
  }
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'trustpilot',
  description: 'Trustpilot review scraper — low-star (1-3 star) pain point extraction for consumer brands',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
trustpilot source — Trustpilot low-star review scraper

Commands:
  scan        Scrape 1-3 star reviews from Trustpilot for a domain

scan options:
  --domain <str>        Domain keyword to look up (e.g. "ticketmaster", "stubhub")
  --companies <list>    Comma-separated Trustpilot company slugs (e.g. "ticketmaster.com,stubhub.com")
  --limit <n>           Max reviews to return (default: 100)
  --maxPages <n>        Max pages to scrape per star tier per company (default: 150)

Built-in domain mappings:
  ticketmaster → ticketmaster.com    stubhub → stubhub.com
  seatgeek → seatgeek.com            vividseats → vividseats.com
  axs → axs.com                      eventbrite → eventbrite.com
  viagogo → viagogo.com              livenation → livenation.com
  gametime → gametime.co             goldstar → goldstar.com

Connection options:
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  pain-points trustpilot scan --domain "ticketmaster" --limit 100
  pain-points trustpilot scan --domain "stubhub" --limit 500
  pain-points trustpilot scan --companies "ticketmaster.com,stubhub.com" --limit 200
`,
};
