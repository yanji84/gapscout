/**
 * appstore.mjs — Google Play Store review scraper source for pain-point-finder
 *
 * Scrapes Google Play Store via Puppeteer. Connects to an existing Chrome
 * instance (e.g. from puppeteer-mcp-server) or accepts --ws-url / --port.
 * Focuses on 1-star and 2-star reviews as pain signal sources.
 */

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PLAY_STORE_BASE = 'https://play.google.com';
const PAGE_DELAY_MS = 3000;
const JITTER_MS = 800;

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

async function politeDelay() {
  await sleep(PAGE_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

// ─── browser connection ─────────────────────────────────────────────────────
// Copied from reddit-browser.mjs

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
          log(`[appstore] found Chrome at ${wsUrl}`);
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
    log(`[appstore] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }
  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[appstore] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }
  const wsUrl = await findChromeWSEndpoint();
  if (wsUrl) {
    try { return await puppeteer.connect({ browserWSEndpoint: wsUrl }); }
    catch (err) { log(`[appstore] auto-detect failed: ${err.message}`); }
  }
  fail('No Chrome browser found. Start puppeteer-mcp-server, or pass --ws-url / --port');
}

// ─── scraping functions ─────────────────────────────────────────────────────

/**
 * Search Play Store for apps matching the query.
 * Returns list of { appName, packageId, appUrl }.
 */
async function searchApps(page, query, maxApps = 5) {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `${PLAY_STORE_BASE}/store/search?q=${encodedQuery}&c=apps`;
  log(`[appstore] searching: ${searchUrl}`);

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const apps = await page.evaluate((max) => {
    var results = [];
    // Play Store search result cards
    var cards = document.querySelectorAll('[data-uitype="500"] a[href*="/store/apps/details"]');
    if (!cards || cards.length === 0) {
      // fallback selector
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

      // Try to find app name nearby
      var nameEl = a.querySelector('span') || a.closest('[data-uitype]')?.querySelector('[class*="name"], span');
      var name = nameEl ? nameEl.textContent.trim() : pkg;
      if (!name || name.length < 2) name = pkg;

      results.push({
        appName: name,
        packageId: pkg,
        appUrl: 'https://play.google.com/store/apps/details?id=' + pkg,
      });
    }
    return results;
  }, maxApps);

  log(`[appstore] found ${apps.length} apps for query "${query}"`);
  return apps;
}

/**
 * Scrape reviews from a Play Store app page.
 * Filters to 1-star and 2-star reviews.
 */
async function scrapeAppReviews(page, appUrl, appName, packageId, targetStars = [1, 2]) {
  log(`[appstore] loading app page: ${appUrl}`);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Click "See all reviews" — Play Store navigates to a /reviews sub-page.
  // We must wait for navigation, not just sleep, or the frame becomes detached.
  try {
    // Find the link/button and extract href if it's an anchor, otherwise click it.
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

  // Scrape reviews for each target star rating
  const allReviews = [];

  for (const stars of targetStars) {
    log(`[appstore] filtering for ${stars}-star reviews`);
    try {
      // Play Store uses a dropdown: aria-label="Star rating" div[role="button"]
      // Use puppeteer's native click (not evaluate) so the menu stays open,
      // then find and click the menu option.
      const starDropdown = await page.$('[aria-label="Star rating"]');
      if (starDropdown) {
        await starDropdown.click();
        await sleep(800);
        // Find the menu item for this star count (e.g. "1-star")
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
          // Close dropdown by pressing Escape
          await page.keyboard.press('Escape');
          await sleep(300);
        }
      } else {
        log('[appstore] star rating dropdown not found');
      }
    } catch (err) {
      log(`[appstore] star filter click failed: ${err.message}`);
    }

    // Extract reviews using current Play Store DOM structure (2025):
    // Cards: div.EGFGHd
    // Name:  .X5PpBb (inside header.c1bOId)
    // Rating: .iXRFPc[aria-label*="Rated"] (inside .Jx4nYe, inside header.c1bOId)
    // Text:  div.h3YV2d (sibling of header, child of .EGFGHd)
    // Thumbs: div.AJTPZc ("N people found this review helpful")
    const reviews = await page.evaluate((starFilter) => {
      var results = [];

      // Primary: EGFGHd cards (current Play Store structure)
      var cards = Array.from(document.querySelectorAll('div.EGFGHd'));

      // Fallback to older selectors if primary yields nothing
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll('div[class*="RHo1pe"]'));
      }

      for (var card of cards) {
        // Reviewer name
        var nameEl = card.querySelector('.X5PpBb') ||
                     card.querySelector('[class*="X43Kjb"]') ||
                     card.querySelector('[class*="rpg45e"]');
        var reviewerName = nameEl ? nameEl.textContent.trim() : 'Anonymous';

        // Star rating — inside .Jx4nYe or .iXRFPc
        var ratingEl = card.querySelector('.iXRFPc[aria-label], .Jx4nYe [aria-label*="Rated"], [aria-label*="Rated"]');
        var ratingText = ratingEl ? (ratingEl.getAttribute('aria-label') || '') : '';
        var ratingMatch = ratingText.match(/Rated (\d)/);
        var rating = ratingMatch ? parseInt(ratingMatch[1], 10) : 0;

        // Filter by desired star count
        if (starFilter > 0 && rating !== starFilter) continue;

        // Review text — div.h3YV2d is a direct child of EGFGHd, sibling of header
        var textEl = card.querySelector('div.h3YV2d') ||
                     card.querySelector('[class*="review-body"]');
        var reviewText = textEl ? textEl.textContent.trim() : '';

        if (!reviewText || reviewText.length < 5) continue;

        // Thumbs up — div.AJTPZc contains "N people found this review helpful"
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

    log(`[appstore] found ${reviews.length} ${stars}-star reviews`);
    allReviews.push(...reviews);

    await politeDelay();
  }

  return allReviews;
}

/**
 * Check if a review contains pain language patterns.
 */
function hasPainLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PAIN_PATTERNS.some(p => lower.includes(p));
}

// ─── normalize reviews to common post shape ─────────────────────────────────

function reviewToPost(review, appName, packageId, appUrl, reviewIndex) {
  const starLabel = `${review.rating} star`;
  // Embed rating in the title so pain signals from review text can score without
  // needing the engagement gate (score/num_comments) that Reddit posts use.
  // Reviews are standalone signals — set num_comments=10 so enrichPost's
  // low-engagement hard filter doesn't drop them.
  return {
    id: `${packageId}_r${reviewIndex}`,
    title: `${appName} - ${review.rating} star review`,
    selftext: review.reviewText,
    subreddit: 'playstore',
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
  const stars = [1, 2];

  log(`[appstore-scan] domain="${domain}", limit=${limit}, maxApps=${maxApps}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();

  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    // Search for apps related to the domain
    const apps = await searchApps(page, domain, maxApps);
    if (!apps.length) {
      ok({
        mode: 'appstore',
        posts: [],
        stats: { domain, apps_found: 0, reviews_scraped: 0, after_filter: 0 },
      });
      return;
    }

    log(`[appstore-scan] found ${apps.length} apps, scraping reviews...`);

    const postsRaw = [];
    let reviewIndex = 0;

    for (const app of apps) {
      log(`[appstore-scan] scraping: ${app.appName} (${app.packageId})`);
      try {
        const reviews = await scrapeAppReviews(page, app.appUrl, app.appName, app.packageId, stars);

        for (const review of reviews) {
          // Only include reviews with pain language for signal quality
          if (!hasPainLanguage(review.reviewText) && review.rating > 1) continue;

          const post = reviewToPost(review, app.appName, app.packageId, app.appUrl, reviewIndex++);
          postsRaw.push(post);
        }
        log(`[appstore-scan] ${app.appName}: ${reviews.length} reviews scraped`);
      } catch (err) {
        log(`[appstore-scan] failed for ${app.appName}: ${err.message}`);
      }
      await politeDelay();
    }

    log(`[appstore-scan] ${postsRaw.length} raw reviews, scoring...`);

    // Enrich and score
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
  description: 'Puppeteer browser — Google Play Store 1-2 star review scraper',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
appstore source — Google Play Store review scraping

Scrapes 1-star and 2-star reviews from Play Store apps related to a domain.
Looks for pain language: "I would pay for...", "I wish...", "doesn't work", "broken".

Commands:
  scan        Search Play Store for apps and scrape low-star reviews

scan options:
  --domain <str>        Search query / domain to find apps (required)
  --limit <n>           Max reviews to return (default: 30)
  --maxApps <n>         Max apps to scrape per search (default: 5)

Connection options:
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  pain-points appstore scan --domain "project management" --limit 20
  pain-points appstore scan --domain "todo list" --maxApps 3
`,
};
