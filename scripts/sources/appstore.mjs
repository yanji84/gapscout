/**
 * appstore.mjs — Google Play Store + Apple App Store review scraper
 *
 * Scrapes Google Play Store (Android) and/or Apple App Store (iOS) via Puppeteer.
 * Connects to an existing Chrome instance (e.g. from puppeteer-mcp-server) or
 * accepts --ws-url / --port.
 * Focuses on 1-star and 2-star reviews as pain signal sources.
 *
 * New in v2:
 *  - Infinite scroll: loads more reviews up to --max-reviews-per-app (default 50)
 *  - Sort by "Most critical" (lowest-rated first)
 *  - Curated app list for 50+ popular domains (ticketing, sneakers, marketplace, restaurant)
 *  - --apps flag to specify custom package IDs
 *  - --platform flag: android (default), ios, both
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { connectBrowser, politeDelay as politeDelayBase } from '../lib/browser.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PLAY_STORE_BASE = 'https://play.google.com';
const APPLE_STORE_BASE = 'https://apps.apple.com';
const PAGE_DELAY_MS = 3000;
const JITTER_MS = 800;
const DEFAULT_MAX_REVIEWS_PER_APP = 50;

// Pain language patterns to look for in reviews
const PAIN_PATTERNS = [
  'i would pay for',
  'i wish',
  "doesn't work",
  'does not work',
  'broken',
  'not working',
  'crashes',
  'crash',
  'freezes',
  'freeze',
  'bug',
  'glitch',
  'unusable',
  'terrible',
  'awful',
  'horrible',
  'hate',
  'frustrated',
  'annoying',
  'useless',
  'waste',
  'refund',
  'disappointed',
  'fix',
  'please add',
  'missing feature',
];

// ─── curated app list ────────────────────────────────────────────────────────
// Keyed by domain keyword (lowercase). Values: { android, ios } package/app IDs.
// android: Play Store package ID
// ios: App Store app ID (numeric) + slug for URL construction

const CURATED_APPS = {
  // ── Ticketing ──────────────────────────────────────────────────────────────
  ticketmaster: {
    android: 'com.ticketmaster.mobile.android.na',
    ios: { id: '364541137', slug: 'ticketmaster-buy-sell-tickets' },
  },
  stubhub: {
    android: 'com.stubhub',
    ios: { id: '343091577', slug: 'stubhub-tickets-to-events' },
  },
  seatgeek: {
    android: 'com.seatgeek.android',
    ios: { id: '487285990', slug: 'seatgeek-tickets-to-events' },
  },
  axs: {
    android: 'com.axs.android',
    ios: { id: '662018791', slug: 'axs' },
  },
  eventbrite: {
    android: 'com.eventbrite.attendee',
    ios: { id: '487922291', slug: 'eventbrite' },
  },
  dice: {
    android: 'fm.dice.app',
    ios: { id: '1041605261', slug: 'dice-buy-event-tickets' },
  },
  'vivid seats': {
    android: 'com.vividseats',
    ios: { id: '468577957', slug: 'vivid-seats-buy-sell-tickets' },
  },
  gametime: {
    android: 'com.gametime.gametime',
    ios: { id: '711795885', slug: 'gametime-tickets-events' },
  },

  // ── Sneakers ───────────────────────────────────────────────────────────────
  snkrs: {
    android: 'com.nike.snkrs',
    ios: { id: '911455128', slug: 'nike-snkrs-sneaker-release' },
  },
  goat: {
    android: 'com.goat.app',
    ios: { id: '966758597', slug: 'goat-sneakers-apparel' },
  },
  stockx: {
    android: 'com.stockx.stockx',
    ios: { id: '1181101318', slug: 'stockx-buy-sell-sneakers' },
  },
  'foot locker': {
    android: 'com.footlocker.approved',
    ios: { id: '388609285', slug: 'foot-locker' },
  },
  'adidas confirmed': {
    android: 'com.adidas.confirmed',
    ios: { id: '1142753763', slug: 'adidas-confirmed' },
  },
  'finish line': {
    android: 'com.finishline.finishlineandroid',
    ios: { id: '354545807', slug: 'finish-line-shoes-sneakers' },
  },

  // ── Marketplace ────────────────────────────────────────────────────────────
  offerup: {
    android: 'com.offerup',
    ios: { id: '719923678', slug: 'offerup-buy-sell-simple' },
  },
  mercari: {
    android: 'com.kouzoh.mercari',
    ios: { id: '896130944', slug: 'mercari-buy-and-sell-app' },
  },
  'facebook marketplace': {
    android: 'com.facebook.katana',
    ios: { id: '284882215', slug: 'facebook' },
  },

  // ── Restaurant / Reservations ──────────────────────────────────────────────
  resy: {
    android: 'com.resy.android',
    ios: { id: '866163372', slug: 'resy' },
  },
  opentable: {
    android: 'com.opentable',
    ios: { id: '296581815', slug: 'opentable-restaurant-reservations' },
  },
  yelp: {
    android: 'com.yelp.android',
    ios: { id: '284910350', slug: 'yelp-food-delivery-reviews' },
  },
};

/**
 * Given a domain string, find matching curated apps. Returns array of
 * { appName, packageId/appId, appUrl, platform }.
 */
function getCuratedApps(domain, platform = 'android') {
  const lower = domain.toLowerCase();
  const results = [];

  for (const [key, entry] of Object.entries(CURATED_APPS)) {
    if (lower.includes(key) || key.includes(lower)) {
      if ((platform === 'android' || platform === 'both') && entry.android) {
        results.push({
          appName: key.charAt(0).toUpperCase() + key.slice(1),
          packageId: entry.android,
          appUrl: `${PLAY_STORE_BASE}/store/apps/details?id=${entry.android}`,
          platform: 'android',
        });
      }
      if ((platform === 'ios' || platform === 'both') && entry.ios) {
        const { id, slug } = entry.ios;
        results.push({
          appName: key.charAt(0).toUpperCase() + key.slice(1),
          packageId: id,
          appUrl: `${APPLE_STORE_BASE}/us/app/${slug}/id${id}`,
          platform: 'ios',
        });
      }
    }
  }

  return results;
}

async function politeDelay() {
  await politeDelayBase(PAGE_DELAY_MS, JITTER_MS);
}

// ─── Android / Play Store scraping ──────────────────────────────────────────

/**
 * Search Play Store for apps matching the query.
 * Returns list of { appName, packageId, appUrl, platform }.
 */
async function searchPlayStoreApps(page, query, maxApps = 5) {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `${PLAY_STORE_BASE}/store/search?q=${encodedQuery}&c=apps`;
  log(`[appstore] searching Play Store: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const apps = await page.evaluate((max) => {
    var results = [];
    var cards = document.querySelectorAll('[data-uitype="500"] a[href*="/store/apps/details"]');
    if (!cards || cards.length === 0) {
      cards = document.querySelectorAll('a[href*="/store/apps/details?id="]');
    }
    var seen = new Set();
    for (var i = 0; i < cards.length && results.length < max; i++) {
      var a = cards[i];
      var href = a.href || '';
      var idMatch = href.match(/[?&]id=([^&]+)/);
      if (!idMatch) continue;
      var pkg = idMatch[1];
      if (seen.has(pkg)) continue;
      seen.add(pkg);

      var nameEl = a.querySelector('span') || a.closest('[data-uitype]')?.querySelector('[class*="name"], span');
      var name = nameEl ? nameEl.textContent.trim() : pkg;
      if (!name || name.length < 2) name = pkg;

      results.push({
        appName: name,
        packageId: pkg,
        appUrl: 'https://play.google.com/store/apps/details?id=' + pkg,
        platform: 'android',
      });
    }
    return results;
  }, maxApps);

  log(`[appstore] found ${apps.length} Play Store apps for query "${query}"`);
  return apps;
}

/**
 * Attempt to sort reviews by "Most critical" (lowest-rated first).
 * Tries multiple approaches: aria-label dropdown, URL params.
 */
async function sortByMostCritical(page) {
  // Approach 1: Try the "Sort by" / "Most relevant" dropdown
  try {
    // Play Store has a button with text "Most relevant" or aria-label containing sort
    const sortBtn = await page.evaluateHandle(() => {
      var candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      for (var el of candidates) {
        var txt = (el.textContent || '').trim();
        var label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (
          txt === 'Most relevant' ||
          txt === 'Sort reviews by' ||
          label.includes('sort') ||
          label.includes('most relevant')
        ) {
          return el;
        }
      }
      return null;
    });

    const sortEl = sortBtn.asElement();
    if (sortEl) {
      await sortEl.click();
      await sleep(800);

      // Look for "Most critical" option in the opened menu
      const criticalItem = await page.evaluateHandle(() => {
        var items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], li, button'));
        for (var item of items) {
          var txt = (item.textContent || '').trim();
          if (txt === 'Most critical' || txt === 'Lowest rated' || txt === 'Newest') {
            return item;
          }
        }
        // Try "Most critical" specifically
        for (var item of items) {
          var txt = (item.textContent || '').trim().toLowerCase();
          if (txt.includes('critical') || txt.includes('lowest')) {
            return item;
          }
        }
        return null;
      });

      const critEl = criticalItem.asElement();
      if (critEl) {
        await critEl.click();
        log('[appstore] sorted by Most Critical');
        await sleep(2000);
        return true;
      } else {
        // Close dropdown
        await page.keyboard.press('Escape');
        await sleep(300);
      }
    }
  } catch (err) {
    log(`[appstore] sort dropdown attempt failed: ${err.message}`);
  }

  // Approach 2: Try appending sort params to the current URL
  try {
    const currentUrl = page.url();
    if (currentUrl.includes('play.google.com') && !currentUrl.includes('reviewSortOrder')) {
      const sortedUrl = currentUrl + (currentUrl.includes('?') ? '&' : '?') + 'reviewSortOrder=2';
      log(`[appstore] trying sort URL param: ${sortedUrl}`);
      await page.goto(sortedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      return true;
    }
  } catch (err) {
    log(`[appstore] sort URL param attempt failed: ${err.message}`);
  }

  log('[appstore] could not sort by most critical, proceeding with default order');
  return false;
}

/**
 * Scroll to load more reviews until maxReviews reached or no new reviews load.
 */
async function scrollForMoreReviews(page, maxReviews = DEFAULT_MAX_REVIEWS_PER_APP) {
  let previousCount = 0;
  let stableRounds = 0;
  const MAX_STABLE = 3;

  for (let round = 0; round < 20; round++) {
    const currentCount = await page.evaluate(() => {
      return document.querySelectorAll('div.EGFGHd, div[class*="RHo1pe"]').length;
    });

    log(`[appstore] scroll round ${round + 1}: ${currentCount} review cards visible`);

    if (currentCount >= maxReviews) {
      log(`[appstore] reached maxReviews=${maxReviews}, stopping scroll`);
      break;
    }

    if (currentCount === previousCount) {
      stableRounds++;
      if (stableRounds >= MAX_STABLE) {
        log('[appstore] no new reviews loaded after scrolling, stopping');
        break;
      }
    } else {
      stableRounds = 0;
    }

    previousCount = currentCount;

    // Scroll to the last review card to trigger lazy loading
    await page.evaluate(() => {
      var cards = document.querySelectorAll('div.EGFGHd, div[class*="RHo1pe"]');
      if (cards.length > 0) {
        cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
      } else {
        window.scrollBy(0, window.innerHeight * 2);
      }
    });

    await sleep(2000 + Math.floor(Math.random() * 500));

    // Also try clicking "Load more" / "See more reviews" buttons if present
    await page.evaluate(() => {
      var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (var b of btns) {
        var txt = (b.textContent || '').trim().toLowerCase();
        if (txt.includes('load more') || txt.includes('see more') || txt.includes('show more')) {
          b.click();
          return;
        }
      }
    });
  }
}

/**
 * Scrape reviews from a Play Store app page (Android).
 * Filters to 1-star and 2-star reviews with infinite scroll support.
 */
async function scrapePlayStoreReviews(page, appUrl, appName, packageId, targetStars = [1, 2], maxReviews = DEFAULT_MAX_REVIEWS_PER_APP) {
  log(`[appstore] loading Play Store app page: ${appUrl}`);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Navigate to reviews page
  try {
    const reviewsHref = await page.evaluate(() => {
      var btns = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      for (var b of btns) {
        var txt = b.textContent.trim();
        var label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (txt === 'See all reviews' || label.includes('see all reviews')) {
          if (b.tagName === 'A' && b.href) return b.href;
          return '__click__';
        }
      }
      return null;
    });

    if (reviewsHref && reviewsHref !== '__click__') {
      log(`[appstore] navigating to reviews page: ${reviewsHref}`);
      await page.goto(reviewsHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    } else if (reviewsHref === '__click__') {
      log('[appstore] clicking "See all reviews" and waiting for navigation');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        page.evaluate(() => {
          var btns = Array.from(document.querySelectorAll('a, button, [role="button"]'));
          for (var b of btns) {
            var txt = b.textContent.trim();
            var label = (b.getAttribute('aria-label') || '').toLowerCase();
            if (txt === 'See all reviews' || label.includes('see all reviews')) {
              b.click();
              return;
            }
          }
        }),
      ]);
      await sleep(2000);
    } else {
      log('[appstore] no "See all reviews" button found, scraping reviews in place');
    }
  } catch (err) {
    log(`[appstore] "See all reviews" click failed: ${err.message}`);
  }

  const allReviews = [];

  for (const stars of targetStars) {
    log(`[appstore] filtering for ${stars}-star reviews`);

    // Try to select star filter
    try {
      const starDropdown = await page.$('[aria-label="Star rating"]');
      if (starDropdown) {
        await starDropdown.click();
        await sleep(800);
        const label = `${stars}-star`;
        const menuItem = await page.evaluateHandle((lbl) => {
          var items = Array.from(document.querySelectorAll('[role="menuitem"]'));
          for (var item of items) {
            if (item.textContent.trim() === lbl) return item;
          }
          return null;
        }, label);
        const menuEl = menuItem.asElement();
        if (menuEl) {
          await menuEl.click();
          log(`[appstore] selected ${stars}-star filter`);
          await sleep(2000);
        } else {
          log(`[appstore] could not find "${label}" in dropdown menu`);
          await page.keyboard.press('Escape');
          await sleep(300);
        }
      } else {
        log('[appstore] star rating dropdown not found');
      }
    } catch (err) {
      log(`[appstore] star filter click failed: ${err.message}`);
    }

    // Try to sort by most critical
    await sortByMostCritical(page);

    // Scroll to load more reviews
    await scrollForMoreReviews(page, maxReviews);

    // Extract all loaded reviews
    const reviews = await page.evaluate((starFilter) => {
      var results = [];

      var cards = Array.from(document.querySelectorAll('div.EGFGHd'));
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll('div[class*="RHo1pe"]'));
      }

      for (var card of cards) {
        var nameEl = card.querySelector('.X5PpBb') ||
                     card.querySelector('[class*="X43Kjb"]') ||
                     card.querySelector('[class*="rpg45e"]');
        var reviewerName = nameEl ? nameEl.textContent.trim() : 'Anonymous';

        var ratingEl = card.querySelector('.iXRFPc[aria-label], .Jx4nYe [aria-label*="Rated"], [aria-label*="Rated"]');
        var ratingText = ratingEl ? (ratingEl.getAttribute('aria-label') || '') : '';
        var ratingMatch = ratingText.match(/Rated (\d)/);
        var rating = ratingMatch ? parseInt(ratingMatch[1], 10) : 0;

        if (starFilter > 0 && rating !== starFilter) continue;

        var textEl = card.querySelector('div.h3YV2d') ||
                     card.querySelector('[class*="review-body"]');
        var reviewText = textEl ? textEl.textContent.trim() : '';

        if (!reviewText || reviewText.length < 5) continue;

        var thumbsEl = card.querySelector('div.AJTPZc') ||
                       card.querySelector('[class*="jUL89d"]') ||
                       card.querySelector('[class*="ny2Vod"]');
        var thumbsText = thumbsEl ? thumbsEl.textContent.trim() : '0';
        var thumbsMatch = thumbsText.match(/([\d,]+)/);
        var thumbsUp = thumbsMatch ? parseInt(thumbsMatch[1].replace(/,/g, ''), 10) : 0;

        results.push({
          reviewerName,
          rating,
          reviewText: reviewText.substring(0, 2000),
          thumbsUp,
        });
      }
      return results;
    }, stars);

    log(`[appstore] found ${reviews.length} ${stars}-star reviews for ${appName}`);
    allReviews.push(...reviews);

    await politeDelay();
  }

  return allReviews;
}

// ─── iOS / Apple App Store scraping ─────────────────────────────────────────

/**
 * Search Apple App Store for apps matching the query.
 * Returns list of { appName, packageId, appUrl, platform }.
 */
async function searchAppleStoreApps(page, query, maxApps = 5) {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `${APPLE_STORE_BASE}/us/search?term=${encodedQuery}&entity=software`;
  log(`[appstore] searching Apple App Store: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const apps = await page.evaluate((max) => {
    var results = [];
    // Apple App Store search results
    var cards = Array.from(document.querySelectorAll('a[href*="/app/"]'));
    var seen = new Set();

    for (var i = 0; i < cards.length && results.length < max; i++) {
      var a = cards[i];
      var href = a.href || '';
      // Match /app/slug/idNUMBER pattern
      var idMatch = href.match(/\/id(\d+)/);
      if (!idMatch) continue;
      var appId = idMatch[1];
      if (seen.has(appId)) continue;
      seen.add(appId);

      var nameEl = a.querySelector('h3, .we-lockup__title, [class*="title"]') || a;
      var name = nameEl.textContent.trim();
      if (!name || name.length < 2) name = 'App ' + appId;

      results.push({
        appName: name,
        packageId: appId,
        appUrl: href,
        platform: 'ios',
      });
    }
    return results;
  }, maxApps);

  log(`[appstore] found ${apps.length} Apple App Store apps for query "${query}"`);
  return apps;
}

/**
 * Scrape reviews from an Apple App Store app page (iOS).
 * Apple's app pages display reviews with a different DOM structure.
 */
async function scrapeAppleStoreReviews(page, appUrl, appName, packageId, targetStars = [1, 2], maxReviews = DEFAULT_MAX_REVIEWS_PER_APP) {
  log(`[appstore] loading Apple App Store page: ${appUrl}`);

  // Apple App Store review pages: use the customer reviews section
  // Navigate to the app's reviews tab
  const reviewsUrl = appUrl.includes('/reviews')
    ? appUrl
    : appUrl.replace(/\?.*$/, '') + '?see-all=reviews';

  await page.goto(reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Try to click "See All Reviews" link
  try {
    const seeAllHref = await page.evaluate(() => {
      var links = Array.from(document.querySelectorAll('a'));
      for (var a of links) {
        var txt = (a.textContent || '').trim();
        var href = a.href || '';
        if (txt.includes('See All') && href.includes('see-all=reviews')) return href;
        if (href.includes('see-all=reviews')) return href;
      }
      return null;
    });

    if (seeAllHref) {
      log(`[appstore] navigating to Apple reviews: ${seeAllHref}`);
      await page.goto(seeAllHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    }
  } catch (err) {
    log(`[appstore] Apple "See All Reviews" failed: ${err.message}`);
  }

  // Scroll to load more reviews
  let previousCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < 15; round++) {
    const currentCount = await page.evaluate(() => {
      return document.querySelectorAll('.we-customer-review, [class*="customer-review"], .lockup').length;
    });

    log(`[appstore] Apple scroll round ${round + 1}: ${currentCount} reviews visible`);

    if (currentCount >= maxReviews) break;
    if (currentCount === previousCount) {
      stableRounds++;
      if (stableRounds >= 3) break;
    } else {
      stableRounds = 0;
    }
    previousCount = currentCount;

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await sleep(1500 + Math.floor(Math.random() * 500));
  }

  // Extract reviews from Apple App Store DOM
  const reviews = await page.evaluate((targetRatings) => {
    var results = [];

    // Apple App Store review selectors (2025 DOM)
    var cards = Array.from(document.querySelectorAll(
      '.we-customer-review, [class*="customer-review"], .lockup.product-lockup'
    ));

    // Fallback: look for review-structured blocks
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll('li[class*="review"], div[class*="review"]'));
    }

    for (var card of cards) {
      // Rating: Apple uses aria-label="X out of 5" or data stars
      var ratingEl = card.querySelector('[aria-label*="out of 5"], .we-star-rating, [class*="star-rating"]');
      var rating = 0;
      if (ratingEl) {
        var label = ratingEl.getAttribute('aria-label') || '';
        var m = label.match(/(\d+)\s+out\s+of/);
        if (m) rating = parseInt(m[1], 10);
        if (!rating) {
          // Try data-clump or class-based rating
          var clump = ratingEl.getAttribute('aria-label') || '';
          var clumpM = clump.match(/(\d)/);
          if (clumpM) rating = parseInt(clumpM[1], 10);
        }
      }

      if (targetRatings.length > 0 && !targetRatings.includes(rating)) continue;

      // Reviewer name
      var nameEl = card.querySelector('.we-customer-review__user, [class*="reviewer"], h4, .we-truncate');
      var reviewerName = nameEl ? nameEl.textContent.trim() : 'Anonymous';

      // Review title
      var titleEl = card.querySelector('.we-customer-review__title, h3, [class*="review-title"]');
      var reviewTitle = titleEl ? titleEl.textContent.trim() : '';

      // Review body text
      var bodyEl = card.querySelector('.we-customer-review__body, p, [class*="review-body"]');
      var reviewBody = bodyEl ? bodyEl.textContent.trim() : '';

      var reviewText = reviewTitle ? reviewTitle + '. ' + reviewBody : reviewBody;

      if (!reviewText || reviewText.length < 5) continue;

      results.push({
        reviewerName,
        rating,
        reviewText: reviewText.substring(0, 2000),
        thumbsUp: 0, // Apple doesn't show helpful count in scraping
      });
    }

    return results;
  }, targetStars);

  log(`[appstore] found ${reviews.length} Apple App Store reviews for ${appName}`);
  return reviews;
}

// ─── shared helpers ──────────────────────────────────────────────────────────

/**
 * Check if a review contains pain language patterns.
 */
function hasPainLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PAIN_PATTERNS.some(p => lower.includes(p));
}

// ─── normalize reviews to common post shape ─────────────────────────────────

function reviewToPost(review, appName, packageId, appUrl, reviewIndex, platform = 'android') {
  const starLabel = `${review.rating} star`;
  return {
    id: `${platform}_${packageId}_r${reviewIndex}`,
    title: `${appName} - ${review.rating} star review`,
    selftext: review.reviewText,
    subreddit: platform === 'ios' ? 'appstore' : 'playstore',
    url: appUrl,
    score: Math.max(review.thumbsUp, 1),
    num_comments: 10,
    upvote_ratio: 0,
    created_utc: 0,
    flair: starLabel,
  };
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain || '';
  if (!domain) fail('--domain is required (e.g. --domain "project management")');

  const limit = args.limit || 30;
  const maxApps = args.maxApps || 5;
  const maxReviewsPerApp = args.maxReviewsPerApp
    ? parseInt(args.maxReviewsPerApp, 10)
    : DEFAULT_MAX_REVIEWS_PER_APP;
  const platform = (args.platform || 'android').toLowerCase();
  const stars = [1, 2];

  // --apps: comma-separated package IDs to scrape directly
  const customApps = args.apps
    ? args.apps.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  log(`[appstore-scan] domain="${domain}", limit=${limit}, maxApps=${maxApps}, maxReviewsPerApp=${maxReviewsPerApp}, platform=${platform}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    let apps = [];

    // Priority 1: --apps flag with explicit package IDs
    if (customApps && customApps.length > 0) {
      log(`[appstore-scan] using custom app list: ${customApps.join(', ')}`);
      for (const pkg of customApps) {
        if (pkg.startsWith('id') || /^\d+$/.test(pkg)) {
          // iOS numeric app ID
          apps.push({
            appName: pkg,
            packageId: pkg.replace(/^id/, ''),
            appUrl: `${APPLE_STORE_BASE}/us/app/app/id${pkg.replace(/^id/, '')}`,
            platform: 'ios',
          });
        } else {
          // Android package ID
          apps.push({
            appName: pkg,
            packageId: pkg,
            appUrl: `${PLAY_STORE_BASE}/store/apps/details?id=${pkg}`,
            platform: 'android',
          });
        }
      }
    } else {
      // Priority 2: curated list
      const curated = getCuratedApps(domain, platform);
      if (curated.length > 0) {
        log(`[appstore-scan] using ${curated.length} curated apps for domain "${domain}"`);
        apps = curated.slice(0, maxApps);
      }

      // Priority 3: dynamic search (supplement curated or fall back)
      if (apps.length < maxApps) {
        const remaining = maxApps - apps.length;
        const existingIds = new Set(apps.map(a => a.packageId));

        if (platform === 'android' || platform === 'both') {
          const playApps = await searchPlayStoreApps(page, domain, remaining);
          for (const a of playApps) {
            if (!existingIds.has(a.packageId)) {
              apps.push(a);
              existingIds.add(a.packageId);
            }
          }
        }
        if (platform === 'ios' || platform === 'both') {
          const appleApps = await searchAppleStoreApps(page, domain, remaining);
          for (const a of appleApps) {
            if (!existingIds.has(a.packageId)) {
              apps.push(a);
              existingIds.add(a.packageId);
            }
          }
        }
      }
    }

    if (!apps.length) {
      ok({
        mode: 'appstore',
        posts: [],
        stats: { domain, apps_found: 0, reviews_scraped: 0, after_filter: 0 },
      });
      return;
    }

    log(`[appstore-scan] scraping ${apps.length} apps...`);

    const postsRaw = [];
    let reviewIndex = 0;

    for (const app of apps) {
      log(`[appstore-scan] scraping: ${app.appName} (${app.packageId}) [${app.platform}]`);
      try {
        let reviews = [];

        if (app.platform === 'ios') {
          reviews = await scrapeAppleStoreReviews(page, app.appUrl, app.appName, app.packageId, stars, maxReviewsPerApp);
        } else {
          reviews = await scrapePlayStoreReviews(page, app.appUrl, app.appName, app.packageId, stars, maxReviewsPerApp);
        }

        for (const review of reviews) {
          if (!hasPainLanguage(review.reviewText) && review.rating > 1) continue;

          const post = reviewToPost(review, app.appName, app.packageId, app.appUrl, reviewIndex++, app.platform);
          postsRaw.push(post);
        }
        log(`[appstore-scan] ${app.appName}: ${reviews.length} reviews scraped`);
      } catch (err) {
        log(`[appstore-scan] failed for ${app.appName}: ${err.message}`);
      }
      await politeDelay();
    }

    log(`[appstore-scan] ${postsRaw.length} raw reviews, scoring...`);

    const scored = [];
    for (const post of postsRaw) {
      const enriched = enrichPost(post, domain);
      if (enriched) scored.push(enriched);
    }

    scored.sort((a, b) => b.painScore - a.painScore);

    ok({
      mode: 'appstore',
      posts: scored.slice(0, limit),
      stats: {
        domain,
        platform,
        apps_found: apps.length,
        reviews_scraped: postsRaw.length,
        after_filter: Math.min(scored.length, limit),
      },
    });
  } finally {
    await page.close();
  }
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'appstore',
  description: 'Puppeteer browser — Google Play Store & Apple App Store 1-2 star review scraper',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
appstore source — Google Play Store & Apple App Store review scraping

Scrapes 1-star and 2-star reviews from Play Store / App Store apps.
Includes curated app lists for ticketing, sneakers, marketplace, and restaurant domains.
Looks for pain language: "I would pay for...", "I wish...", "doesn't work", "broken".

Commands:
  scan        Search app stores for apps and scrape low-star reviews

scan options:
  --domain <str>             Search query / domain to find apps (required)
  --limit <n>                Max reviews to return (default: 30)
  --maxApps <n>              Max apps to scrape per search (default: 5)
  --max-reviews-per-app <n>  Max reviews to load per app via infinite scroll (default: 50)
  --platform <str>           android, ios, or both (default: android)
  --apps <ids>               Comma-separated package IDs to scrape directly

Connection options:
  --ws-url <url>             Chrome WebSocket URL (auto-detected if omitted)
  --port <n>                 Chrome debug port (auto-detected if omitted)

Curated app domains (auto-matched from --domain):
  Ticketing:   ticketmaster, stubhub, seatgeek, axs, eventbrite, dice, vivid seats, gametime
  Sneakers:    snkrs, goat, stockx, foot locker, adidas confirmed, finish line
  Marketplace: offerup, mercari, facebook marketplace
  Restaurant:  resy, opentable, yelp

Examples:
  pain-points appstore scan --domain "Ticketmaster" --max-reviews-per-app 30 --limit 100
  pain-points appstore scan --domain "sneakers" --platform both --maxApps 6
  pain-points appstore scan --domain "ticketing" --platform android --limit 50
  pain-points appstore scan --apps "com.ticketmaster.mobile.android.na,com.stubhub" --domain "ticketing"
`,
};
