/**
 * appstore.mjs — Google Play Store + Apple App Store review scraper
 *
 * Uses `google-play-scraper` and `app-store-scraper` npm packages.
 * No browser/Puppeteer dependency — pure HTTP API calls.
 * Focuses on 1-star and 2-star reviews as pain signal sources.
 */

import gplay from 'google-play-scraper';
import store from 'app-store-scraper';
import { log, ok, fail } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

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

const CURATED_APPS = {
  // ── Ticketing ──────────────────────────────────────────────────────────────
  ticketmaster: {
    android: 'com.ticketmaster.mobile.android.na',
    ios: { id: 364541137, name: 'ticketmaster-buy-sell-tickets' },
  },
  stubhub: {
    android: 'com.stubhub',
    ios: { id: 343091577, name: 'stubhub-tickets-to-events' },
  },
  seatgeek: {
    android: 'com.seatgeek.android',
    ios: { id: 487285990, name: 'seatgeek-tickets-to-events' },
  },
  axs: {
    android: 'com.axs.android',
    ios: { id: 662018791, name: 'axs' },
  },
  eventbrite: {
    android: 'com.eventbrite.attendee',
    ios: { id: 487922291, name: 'eventbrite' },
  },
  dice: {
    android: 'fm.dice.app',
    ios: { id: 1041605261, name: 'dice-buy-event-tickets' },
  },
  'vivid seats': {
    android: 'com.vividseats',
    ios: { id: 468577957, name: 'vivid-seats-buy-sell-tickets' },
  },
  gametime: {
    android: 'com.gametime.gametime',
    ios: { id: 711795885, name: 'gametime-tickets-events' },
  },

  // ── Sneakers ───────────────────────────────────────────────────────────────
  snkrs: {
    android: 'com.nike.snkrs',
    ios: { id: 911455128, name: 'nike-snkrs-sneaker-release' },
  },
  goat: {
    android: 'com.goat.app',
    ios: { id: 966758597, name: 'goat-sneakers-apparel' },
  },
  stockx: {
    android: 'com.stockx.stockx',
    ios: { id: 1181101318, name: 'stockx-buy-sell-sneakers' },
  },
  'foot locker': {
    android: 'com.footlocker.approved',
    ios: { id: 388609285, name: 'foot-locker' },
  },
  'adidas confirmed': {
    android: 'com.adidas.confirmed',
    ios: { id: 1142753763, name: 'adidas-confirmed' },
  },
  'finish line': {
    android: 'com.finishline.finishlineandroid',
    ios: { id: 354545807, name: 'finish-line-shoes-sneakers' },
  },

  // ── Marketplace ────────────────────────────────────────────────────────────
  offerup: {
    android: 'com.offerup',
    ios: { id: 719923678, name: 'offerup-buy-sell-simple' },
  },
  mercari: {
    android: 'com.kouzoh.mercari',
    ios: { id: 896130944, name: 'mercari-buy-and-sell-app' },
  },
  'facebook marketplace': {
    android: 'com.facebook.katana',
    ios: { id: 284882215, name: 'facebook' },
  },

  // ── Restaurant / Reservations ──────────────────────────────────────────────
  resy: {
    android: 'com.resy.android',
    ios: { id: 866163372, name: 'resy' },
  },
  opentable: {
    android: 'com.opentable',
    ios: { id: 296581815, name: 'opentable-restaurant-reservations' },
  },
  yelp: {
    android: 'com.yelp.android',
    ios: { id: 284910350, name: 'yelp-food-delivery-reviews' },
  },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Given a domain string, find matching curated apps.
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
          platform: 'android',
        });
      }
      if ((platform === 'ios' || platform === 'both') && entry.ios) {
        results.push({
          appName: key.charAt(0).toUpperCase() + key.slice(1),
          appId: entry.ios.id,
          platform: 'ios',
        });
      }
    }
  }

  return results;
}

/**
 * Check if a review contains pain language patterns.
 */
function hasPainLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PAIN_PATTERNS.some(p => lower.includes(p));
}

/**
 * Convert a raw review into the standard post shape expected by the pipeline.
 */
function reviewToPost(review, appName, appIdOrPkg, reviewIndex, platform = 'android') {
  const rating = review.score || review.rating || 0;
  const text = review.text || '';
  const title = review.title || `${appName} - ${rating} star review`;
  const thumbsUp = review.thumbsUp || 0;
  const url = platform === 'android'
    ? `https://play.google.com/store/apps/details?id=${appIdOrPkg}`
    : `https://apps.apple.com/us/app/id${appIdOrPkg}`;

  // created_utc: reviews have a date string or Date object
  let createdUtc = 0;
  if (review.date) {
    const d = review.date instanceof Date ? review.date : new Date(review.date);
    if (!isNaN(d.getTime())) createdUtc = Math.floor(d.getTime() / 1000);
  }

  return {
    id: `${platform}_${appIdOrPkg}_r${reviewIndex}`,
    title: title === text ? `${appName} - ${rating} star review` : title,
    selftext: text.substring(0, 2000),
    subreddit: platform === 'ios' ? 'appstore' : 'playstore',
    url,
    score: Math.max(thumbsUp, 1),
    num_comments: 10,
    upvote_ratio: 0,
    created_utc: createdUtc,
    flair: `${rating} star`,
  };
}

// ─── Google Play scraping via google-play-scraper ────────────────────────────

/**
 * Search Play Store for apps matching a query.
 */
async function searchPlayStoreApps(query, maxApps = 5) {
  log(`[appstore] searching Play Store for: "${query}"`);
  try {
    const results = await gplay.search({
      term: query,
      num: maxApps,
    });
    const apps = results.slice(0, maxApps).map(r => ({
      appName: r.title,
      packageId: r.appId,
      platform: 'android',
    }));
    log(`[appstore] found ${apps.length} Play Store apps`);
    return apps;
  } catch (err) {
    log(`[appstore] Play Store search failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch reviews for a Play Store app. Sorted by rating (lowest first).
 */
async function fetchPlayStoreReviews(packageId, maxReviews = DEFAULT_MAX_REVIEWS_PER_APP) {
  log(`[appstore] fetching Play Store reviews for ${packageId}`);
  try {
    const reviews = await gplay.reviews({
      appId: packageId,
      sort: gplay.sort.RATING,   // lowest rating first
      num: maxReviews,
    });
    // google-play-scraper returns { data: [...] }
    const data = Array.isArray(reviews) ? reviews : (reviews.data || []);
    log(`[appstore] fetched ${data.length} Play Store reviews for ${packageId}`);
    return data;
  } catch (err) {
    log(`[appstore] Play Store reviews failed for ${packageId}: ${err.message}`);
    return [];
  }
}

// ─── Apple App Store scraping via app-store-scraper ──────────────────────────

/**
 * Search Apple App Store for apps matching a query.
 */
async function searchAppleStoreApps(query, maxApps = 5) {
  log(`[appstore] searching Apple App Store for: "${query}"`);
  try {
    const results = await store.search({
      term: query,
      num: maxApps,
    });
    const apps = results.slice(0, maxApps).map(r => ({
      appName: r.title,
      appId: r.id,
      platform: 'ios',
    }));
    log(`[appstore] found ${apps.length} Apple App Store apps`);
    return apps;
  } catch (err) {
    log(`[appstore] Apple App Store search failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch reviews for an Apple App Store app. Sorted by most critical.
 */
async function fetchAppleStoreReviews(appId, maxReviews = DEFAULT_MAX_REVIEWS_PER_APP) {
  log(`[appstore] fetching Apple App Store reviews for id=${appId}`);
  try {
    const reviews = await store.reviews({
      id: appId,
      sort: store.sort.RECENT,
      page: 1,
    });
    // app-store-scraper returns an array directly
    const data = Array.isArray(reviews) ? reviews : [];
    log(`[appstore] fetched ${data.length} Apple App Store reviews for id=${appId}`);
    return data.slice(0, maxReviews);
  } catch (err) {
    log(`[appstore] Apple App Store reviews failed for id=${appId}: ${err.message}`);
    return [];
  }
}

// ─── scan command ────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain || '';
  if (!domain) fail('--domain is required (e.g. --domain "project management")');

  const limit = args.limit || 30;
  const maxApps = args.maxApps || 5;
  const maxReviewsPerApp = args.maxReviewsPerApp
    ? parseInt(args.maxReviewsPerApp, 10)
    : DEFAULT_MAX_REVIEWS_PER_APP;
  const platform = (args.platform || 'android').toLowerCase();

  log(`[appstore-scan] domain="${domain}", limit=${limit}, maxApps=${maxApps}, maxReviewsPerApp=${maxReviewsPerApp}, platform=${platform}`);

  // --apps: comma-separated package IDs to scrape directly
  const customApps = args.apps
    ? args.apps.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  let apps = [];

  // Priority 1: --apps flag with explicit package IDs
  if (customApps && customApps.length > 0) {
    log(`[appstore-scan] using custom app list: ${customApps.join(', ')}`);
    for (const pkg of customApps) {
      if (pkg.startsWith('id') || /^\d+$/.test(pkg)) {
        apps.push({
          appName: pkg,
          appId: parseInt(pkg.replace(/^id/, ''), 10),
          platform: 'ios',
        });
      } else {
        apps.push({
          appName: pkg,
          packageId: pkg,
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
      const existingIds = new Set(apps.map(a => a.packageId || String(a.appId)));

      if (platform === 'android' || platform === 'both') {
        const playApps = await searchPlayStoreApps(domain, remaining);
        for (const a of playApps) {
          if (!existingIds.has(a.packageId)) {
            apps.push(a);
            existingIds.add(a.packageId);
          }
        }
      }
      if (platform === 'ios' || platform === 'both') {
        const appleApps = await searchAppleStoreApps(domain, remaining);
        for (const a of appleApps) {
          if (!existingIds.has(String(a.appId))) {
            apps.push(a);
            existingIds.add(String(a.appId));
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
    const label = app.appName || app.packageId || app.appId;
    log(`[appstore-scan] scraping: ${label} [${app.platform}]`);
    try {
      let reviews = [];

      if (app.platform === 'ios') {
        reviews = await fetchAppleStoreReviews(app.appId, maxReviewsPerApp);
      } else {
        reviews = await fetchPlayStoreReviews(app.packageId, maxReviewsPerApp);
      }

      for (const review of reviews) {
        const rating = review.score || review.rating || 0;
        const text = review.text || '';

        // Keep 1-star reviews unconditionally; 2-star only if pain language present
        if (rating > 2) continue;
        if (rating === 2 && !hasPainLanguage(text)) continue;

        const idOrPkg = app.platform === 'ios' ? app.appId : app.packageId;
        const post = reviewToPost(review, app.appName || String(idOrPkg), idOrPkg, reviewIndex++, app.platform);
        postsRaw.push(post);
      }
      log(`[appstore-scan] ${label}: ${reviews.length} reviews fetched, ${postsRaw.length} pain posts so far`);
    } catch (err) {
      log(`[appstore-scan] failed for ${label}: ${err.message}`);
    }
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
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'appstore',
  description: 'Google Play Store & Apple App Store review scraper (no browser required)',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
appstore source — Google Play Store & Apple App Store review scraping

Uses google-play-scraper and app-store-scraper npm packages (no browser needed).
Fetches 1-star and 2-star reviews from Play Store / App Store apps.
Includes curated app lists for ticketing, sneakers, marketplace, and restaurant domains.
Looks for pain language: "I would pay for...", "I wish...", "doesn't work", "broken".

Commands:
  scan        Search app stores for apps and scrape low-star reviews

scan options:
  --domain <str>             Search query / domain to find apps (required)
  --limit <n>                Max reviews to return (default: 30)
  --maxApps <n>              Max apps to scrape per search (default: 5)
  --max-reviews-per-app <n>  Max reviews to load per app (default: 50)
  --platform <str>           android, ios, or both (default: android)
  --apps <ids>               Comma-separated package IDs to scrape directly

Examples:
  pain-points appstore scan --domain "Ticketmaster" --max-reviews-per-app 30 --limit 100
  pain-points appstore scan --domain "sneakers" --platform both --maxApps 6
  pain-points appstore scan --domain "ticketing" --platform android --limit 50
  pain-points appstore scan --apps "com.ticketmaster.mobile.android.na,com.stubhub" --domain "ticketing"
`,
};
