/**
 * Custom browser scraper for Pokemon TCG pain points.
 * Uses the existing active browser page (via browser.pages()) to avoid
 * the new tab context issue where reddit returns no results.
 */

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WS_URL = 'ws://localhost:9222/devtools/browser/1f7c8c9e-01d4-4490-b197-350aa037b687';
const OLD_REDDIT = 'https://old.reddit.com';
const DELAY_MS = 1500;
const SUBREDDITS = ['PokemonTCG', 'pkmntcg', 'PKMNTCGDeals'];
const TIME_FILTER = 'year';
const MAX_PAGES = 10;
const LIMIT = 2000;

const QUERIES = [
  'frustrated OR annoying OR terrible OR hate OR overpriced',
  'alternative OR switched OR wish OR looking for',
  'expensive OR ripoff OR gouging OR not worth',
  'nightmare OR broken OR unusable OR giving up',
  'worst OR garbage OR awful OR horrible',
  'quit OR quitting OR done with OR leaving',
  'pokemon tcg frustrated OR terrible OR hate',
  'pokemon tcg alternative OR switched OR wish',
  'pokemon tcg expensive OR overpriced OR not worth',
  'pokemon tcg broken OR unusable OR nightmare',
];

const SORT_MODES = ['comments', 'relevance'];

function log(...args) { process.stderr.write(args.join(' ') + '\n'); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeSearchPage(page, url) {
  log(`  Loading: ${url.substring(0, 100)}`);
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp ? resp.status() : 0;
    log(`  Status: ${status}`);
    if (status === 403 || status === 429) {
      log(`  Blocked (${status}), skipping`);
      return [];
    }
    await sleep(1000);
    return await page.evaluate(() => {
      function relToUnix(text) {
        var m = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
        if (!m) return 0;
        var n = parseInt(m[1], 10);
        var unit = m[2].toLowerCase();
        var secs = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[unit] || 0;
        return Math.floor(Date.now() / 1000) - n * secs;
      }
      var posts = [];
      var els = document.querySelectorAll('.search-result-link');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var a = el.querySelector('a.search-title');
        var meta = el.querySelector('.search-result-meta');
        var body = el.querySelector('.search-result-body');
        var metaText = meta ? meta.textContent.trim() : '';
        var pointsMatch = metaText.match(/([\d,]+)\s+point/);
        var commentsMatch = metaText.match(/([\d,]+)\s+comment/);
        var subredditMatch = metaText.match(/to\s+r\/(\w+)/);
        var flairEl = el.querySelector('.linkflair-text, .search-result-flair');
        var flair = flairEl ? flairEl.textContent.trim() : '';
        var timeEl = el.querySelector('time');
        var relTime = timeEl ? timeEl.textContent.trim() : '';
        var createdUtc = relToUnix(relTime);
        var href = a ? a.href : '';
        var idMatch = href.match(/\/comments\/([a-z0-9]+)/i);
        posts.push({
          id: idMatch ? idMatch[1] : '',
          title: a ? a.textContent.trim() : '',
          selftext: body ? body.textContent.trim() : '',
          subreddit: subredditMatch ? subredditMatch[1] : '',
          url: href,
          score: pointsMatch ? parseInt(pointsMatch[1].replace(/,/g, ''), 10) : 0,
          num_comments: commentsMatch ? parseInt(commentsMatch[1].replace(/,/g, ''), 10) : 0,
          upvote_ratio: 0,
          flair: flair,
          created_utc: createdUtc,
        });
      }
      return posts;
    });
  } catch (err) {
    log(`  Error: ${err.message}`);
    return [];
  }
}

async function getNextPage(page) {
  try {
    return await page.evaluate(() => {
      var el = document.querySelector('a[rel="nofollow next"], .nav-buttons .next-button a');
      return el ? el.href : null;
    });
  } catch { return null; }
}

// Simple pain signal detection
function scorePain(post) {
  const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
  const signals = ['frustrated', 'annoying', 'terrible', 'hate', 'overpriced', 'ripoff', 'awful',
    'worst', 'broken', 'unusable', 'quit', 'quitting', 'nightmare', 'garbage', 'expensive',
    'scalper', 'scalping', 'gouge', 'gouging', 'impossible', 'can\'t find', 'sold out',
    'wish', 'alternative', 'switched', 'disappointed', 'scam', 'fake', 'counterfeit'];
  let score = 0;
  for (const s of signals) if (text.includes(s)) score += 10;
  score += Math.min(post.num_comments || 0, 500) * 0.05;
  score += Math.min(post.score || 0, 5000) * 0.01;
  return Math.round(score);
}

async function main() {
  log(`[ptcg-scraper] Connecting to ${WS_URL}`);
  const browser = await puppeteer.connect({ browserWSEndpoint: WS_URL });

  // Get existing pages instead of creating a new one
  const pages = await browser.pages();
  log(`[ptcg-scraper] Found ${pages.length} existing pages`);

  // Use existing page or create one if none
  let page;
  if (pages.length > 0) {
    // Find a page that's not the active one being used for something else,
    // or just use a new page since we confirmed new pages work with old.reddit
    page = await browser.newPage();
    log(`[ptcg-scraper] Created new page`);
  } else {
    page = await browser.newPage();
  }

  // Set a realistic user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Set extra headers to look more legitimate
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });

  const postsById = new Map();
  let totalPages = 0;

  try {
    for (const sub of SUBREDDITS) {
      for (const sortMode of SORT_MODES) {
        for (const query of QUERIES) {
          const encoded = encodeURIComponent(query);
          let url = `${OLD_REDDIT}/r/${sub}/search?q=${encoded}&restrict_sr=on&sort=${sortMode}&t=${TIME_FILTER}`;
          let pageNum = 0;
          const label = `r/${sub} sort=${sortMode} q="${query.substring(0, 40)}"`;

          while (url && pageNum < MAX_PAGES) {
            log(`[ptcg-scraper] ${label} page ${pageNum + 1}/${MAX_PAGES}`);
            const posts = await scrapeSearchPage(page, url);
            pageNum++;
            totalPages++;

            let newCount = 0;
            for (const p of posts) {
              if (p.id && !postsById.has(p.id)) {
                postsById.set(p.id, p);
                newCount++;
              }
            }
            log(`[ptcg-scraper]   ${posts.length} posts (${newCount} new, ${postsById.size} total)`);

            if (posts.length === 0) break;
            if (pageNum < MAX_PAGES) {
              const nextUrl = await getNextPage(page);
              if (!nextUrl) { log(`[ptcg-scraper]   no next page`); break; }
              url = nextUrl;
              await sleep(DELAY_MS + Math.floor(Math.random() * 300));
            }
          }
        }
      }
    }
  } finally {
    await page.close();
    await browser.disconnect();
  }

  log(`[ptcg-scraper] Total: ${postsById.size} unique posts, ${totalPages} pages loaded`);

  // Score and sort posts
  const scored = [];
  for (const post of postsById.values()) {
    if ((post.num_comments || 0) < 3) continue;
    post.painScore = scorePain(post);
    scored.push(post);
  }
  scored.sort((a, b) => b.painScore - a.painScore);

  const output = {
    ok: true,
    data: {
      mode: 'browser',
      posts: scored.slice(0, LIMIT),
      stats: {
        subreddits: SUBREDDITS.length,
        global_mode: false,
        pages_loaded: totalPages,
        raw_posts: postsById.size,
        after_filter: Math.min(scored.length, LIMIT),
        max_pages_per_query: MAX_PAGES,
        parallel_tabs: 1,
      }
    }
  };

  process.stdout.write(JSON.stringify(output, null, 2));
  log(`[ptcg-scraper] Done. ${scored.length} posts with pain signals.`);
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
