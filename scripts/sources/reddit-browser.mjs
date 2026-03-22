/**
 * reddit-browser.mjs — Puppeteer browser source for pain-point-finder
 *
 * Scrapes old.reddit.com via Puppeteer. Connects to an existing Chrome
 * instance (e.g. from puppeteer-mcp-server) or accepts --ws-url / --port.
 */

import { readFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import {
  computePainScore, analyzeComments, enrichPost,
  matchSignals, getPostPainCategories,
} from '../lib/scoring.mjs';
import { connectBrowser, politeDelay } from '../lib/browser.mjs';
import { REDDIT_USER_AGENT } from '../lib/http.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const OLD_REDDIT = 'https://old.reddit.com';
const PAGE_DELAY_MS = 1500;   // increased from 1000 to be more polite
const JITTER_MS = 500;        // increased from 300 for more natural spacing
const MAX_PAGES_PER_RUN = 200;
const BACKOFF_BASE_MS = 3000;
const MAX_RETRIES_PER_PAGE = 3;

/** Track rate limit state across the browser session */
let _rateLimitWarning = false;
let _consecutiveErrors = 0;
let _totalRequests = 0;
let _blockedDetected = false;

function emitBrowserRateLimitWarning(message) {
  _rateLimitWarning = true;
  process.stderr.write(`\n⚠ RATE LIMIT WARNING [browser]: ${message}\n\n`);
}

async function politeDelayLocal() {
  // Increase delay if we're seeing errors (adaptive backoff)
  const multiplier = _consecutiveErrors > 0 ? Math.pow(2, Math.min(_consecutiveErrors, 4)) : 1;
  const effectiveDelay = PAGE_DELAY_MS * multiplier;
  if (multiplier > 1) {
    log(`[browser-scan] adaptive backoff: ${effectiveDelay}ms delay (${_consecutiveErrors} consecutive errors)`);
  }
  await politeDelay(effectiveDelay, JITTER_MS);
}

/**
 * Check if a page shows a Reddit rate-limit, ban, or block page.
 * Returns { blocked: boolean, reason: string }
 */
async function checkForBlock(page) {
  try {
    const result = await page.evaluate(() => {
      const body = document.body ? document.body.textContent : '';
      const title = document.title || '';
      // Reddit rate limit / "too many requests" page
      if (title.includes('Too Many Requests') || body.includes('you are doing that too much')
          || body.includes('try again in') || document.querySelector('.error-page')) {
        return { blocked: true, reason: 'rate-limited (too many requests)' };
      }
      // Reddit ban / forbidden page
      if (title.includes('Forbidden') || title.includes('403')
          || body.includes('you are not allowed') || body.includes('banned')) {
        return { blocked: true, reason: 'forbidden/banned (403)' };
      }
      // Cloudflare challenge
      if (title.includes('Just a moment') || body.includes('Checking your browser')) {
        return { blocked: true, reason: 'Cloudflare challenge — detected as bot' };
      }
      // CAPTCHA
      if (body.includes('captcha') || body.includes('CAPTCHA') || document.querySelector('#captcha')) {
        return { blocked: true, reason: 'CAPTCHA challenge — detected as bot' };
      }
      return { blocked: false, reason: '' };
    });
    return result;
  } catch {
    return { blocked: false, reason: '' };
  }
}

// ─── scraping functions ─────────────────────────────────────────────────────

async function scrapeSearchResults(page, url) {
  _totalRequests++;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1000);

  // Check for rate limit / ban pages
  const blockCheck = await checkForBlock(page);
  if (blockCheck.blocked) {
    emitBrowserRateLimitWarning(blockCheck.reason);
    _blockedDetected = true;
    throw new Error(`Blocked: ${blockCheck.reason}`);
  }
  _consecutiveErrors = 0; // reset on success

  return await page.evaluate(() => {
    // Parse relative time string (e.g. "3 hours ago", "2 days ago") to approximate unix timestamp
    function relativeToUnix(text) {
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
      // Extract flair from search result
      var flairEl = el.querySelector('.linkflair-text, .search-result-flair');
      var flair = flairEl ? flairEl.textContent.trim() : '';
      // Extract relative time from <time> element
      var timeEl = el.querySelector('time');
      var relTime = timeEl ? timeEl.textContent.trim() : '';
      var createdUtc = relativeToUnix(relTime);
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
}

/**
 * Get the "next page" URL from old.reddit.com search results.
 * Returns null if there is no next page.
 */
async function getNextPageUrl(page) {
  return await page.evaluate(() => {
    var nextEl = document.querySelector('a[rel="nofollow next"], .nav-buttons .next-button a');
    return nextEl ? nextEl.href : null;
  });
}

/**
 * Scrape multiple pages of search results for a single query URL.
 * Follows pagination up to maxPages pages.
 */
async function scrapeSearchResultsAllPages(page, startUrl, maxPages, postsById, label) {
  let url = startUrl;
  let pageNum = 0;
  let totalNewPosts = 0;

  while (url && pageNum < maxPages) {
    log(`[browser-scan] ${label} page ${pageNum + 1}${maxPages > 1 ? `/${maxPages}` : ''} ${url.substring(0, 80)}`);
    try {
      const posts = await scrapeSearchResults(page, url);
      pageNum++;
      let newCount = 0;
      for (const p of posts) {
        if (p.id && !postsById.has(p.id)) {
          postsById.set(p.id, p);
          newCount++;
        }
      }
      totalNewPosts += newCount;
      _consecutiveErrors = 0;
      log(`[browser-scan]   ${posts.length} posts on page (${newCount} new, ${postsById.size} total unique)`);

      if (posts.length === 0) break; // empty page, stop paginating

      if (pageNum < maxPages) {
        url = await getNextPageUrl(page);
        if (!url) {
          log(`[browser-scan]   no next page found, stopping pagination`);
          break;
        }
        await politeDelayLocal();
      }
    } catch (err) {
      _consecutiveErrors++;
      log(`[browser-scan]   failed: ${err.message}`);

      // If blocked/banned, stop immediately and return partial results
      if (_blockedDetected || err.message.includes('Blocked:')) {
        log(`[browser-scan]   blocked detected — returning partial results (${postsById.size} posts so far)`);
        break;
      }

      // Exponential backoff on errors before retrying next page
      if (_consecutiveErrors <= MAX_RETRIES_PER_PAGE) {
        const backoff = BACKOFF_BASE_MS * Math.pow(2, _consecutiveErrors - 1);
        log(`[browser-scan]   backing off ${backoff}ms before next attempt`);
        await sleep(backoff);
        // Retry the same URL
        continue;
      }

      // Too many consecutive errors, stop pagination
      log(`[browser-scan]   ${_consecutiveErrors} consecutive errors — stopping pagination`);
      break;
    }
  }

  return pageNum;
}

async function scrapePostPage(page, postUrl, maxComments = 200) {
  let url = postUrl.replace('www.reddit.com', 'old.reddit.com');
  if (!url.includes('old.reddit.com')) url = url.replace('reddit.com', 'old.reddit.com');
  url = url.replace(/\?.*$/, '') + '?limit=500';

  _totalRequests++;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  // Check for rate limit / ban pages
  const blockCheck = await checkForBlock(page);
  if (blockCheck.blocked) {
    emitBrowserRateLimitWarning(blockCheck.reason);
    _blockedDetected = true;
    throw new Error(`Blocked: ${blockCheck.reason}`);
  }

  return await page.evaluate((maxC) => {
    var postBody = '';
    var expandoEl = document.querySelector('.expando .md');
    if (expandoEl) postBody = expandoEl.textContent.trim();
    var flairEl = document.querySelector('.linkflair-text, .flair');
    var flair = flairEl ? flairEl.textContent.trim() : '';
    var titleEl = document.querySelector('a.title');
    var title = titleEl ? titleEl.textContent.trim() : '';
    var scoreEl = document.querySelector('.score .number');
    var score = 0;
    if (scoreEl) score = parseInt(scoreEl.textContent.replace(/,/g, ''), 10) || 0;
    else {
      var s2 = document.querySelector('.score');
      if (s2) { var m = s2.textContent.match(/([\d,]+)/); if (m) score = parseInt(m[1].replace(/,/g, ''), 10); }
    }
    var subEl = document.querySelector('.redditname a');
    var subreddit = subEl ? subEl.textContent.trim() : '';
    var comments = [];
    var els = document.querySelectorAll('.comment');
    for (var i = 0; i < Math.min(els.length, maxC); i++) {
      var el = els[i];
      var mdEl = el.querySelector('.md');
      if (!mdEl) continue;
      var scEl = el.querySelector('.score.unvoted');
      var scText = scEl ? scEl.textContent.trim() : '1 point';
      var scMatch = scText.match(/([\-\d]+)\s+point/);
      comments.push({ body: mdEl.textContent.trim().substring(0, 500), score: scMatch ? parseInt(scMatch[1], 10) : 1 });
    }
    return { title: title, selftext: postBody, flair: flair, score: score, subreddit: subreddit, comments: comments };
  }, maxComments);
}

// ─── parallel tab worker ─────────────────────────────────────────────────────

/**
 * Run one worker: opens a new page on the browser, scrapes all assigned
 * (subreddit, sortMode, query) triples with pagination, and closes the page.
 */
async function runWorker(browser, workItems, maxPages, postsById, globalMode, timeFilter, domain) {
  const page = await browser.newPage();
  // Set a proper User-Agent — Reddit blocks default Puppeteer UA
  await page.setUserAgent(REDDIT_USER_AGENT);
  let pagesLoaded = 0;
  try {
    for (const item of workItems) {
      // Stop immediately if a block was detected in any worker
      if (_blockedDetected) {
        log(`[browser-scan] worker stopping — block detected`);
        break;
      }
      const { sub, sortMode, query } = item;
      const encodedQuery = encodeURIComponent(query);
      let startUrl;
      if (globalMode) {
        startUrl = `${OLD_REDDIT}/search?q=${encodedQuery}&sort=${sortMode}&t=${timeFilter}`;
      } else {
        startUrl = `${OLD_REDDIT}/r/${sub}/search?q=${encodedQuery}&restrict_sr=on&sort=${sortMode}&t=${timeFilter}`;
      }
      const label = globalMode
        ? `global sort=${sortMode} q="${query.substring(0, 35)}"`
        : `r/${sub} sort=${sortMode} q="${query.substring(0, 35)}"`;

      const pages = await scrapeSearchResultsAllPages(page, startUrl, maxPages, postsById, label);
      pagesLoaded += pages;

      if (pagesLoaded >= MAX_PAGES_PER_RUN) {
        log(`[browser-scan] worker hit MAX_PAGES_PER_RUN (${MAX_PAGES_PER_RUN})`);
        break;
      }
    }
  } finally {
    await page.close();
  }
  return pagesLoaded;
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const subreddits = args.subreddits;
  const domain = args.domain || '';

  // --subreddits is required unless --domain is provided (coordinator mode: global Reddit search)
  if ((!subreddits || !subreddits.length) && !domain) {
    fail('--subreddits or --domain is required');
  }

  const limit = args.limit || 30;
  const timeFilter = args.time || 'year';
  const minComments = args.minComments || 3;
  const globalMode = !subreddits || !subreddits.length;
  const maxPages = args.maxPages || 10;       // pagination depth per query (default 10 = up to 250 results)
  const parallelTabs = Math.max(1, Math.min(args.parallelTabs || 1, 5)); // 1–5 tabs

  if (globalMode) {
    log(`[browser-scan] global domain mode: domain="${domain}", time=${timeFilter}, maxPages=${maxPages}, parallelTabs=${parallelTabs}`);
  } else {
    log(`[browser-scan] subreddits=${subreddits.join(',')}, domain="${domain}", time=${timeFilter}, maxPages=${maxPages}, parallelTabs=${parallelTabs}`);
  }

  const browser = await connectBrowser(args);

  try {
    const searchQueries = [];

    if (globalMode) {
      // In global mode, use domain-focused queries only
      if (domain) {
        searchQueries.push(`${domain} frustrated OR terrible OR hate`);
        searchQueries.push(`${domain} alternative OR switched OR wish`);
        searchQueries.push(`${domain} expensive OR overpriced OR not worth`);
        searchQueries.push(`${domain} broken OR unusable OR giving up`);
      }
    } else {
      searchQueries.push(
        'frustrated OR annoying OR terrible OR hate OR overpriced',
        'alternative OR switched OR wish OR looking for',
        'expensive OR ripoff OR gouging OR not worth',
        'nightmare OR broken OR unusable OR giving up',
        'worst OR garbage OR awful OR horrible',
        'quit OR quitting OR done with OR leaving',
      );
      if (domain) {
        searchQueries.push(`${domain} frustrated OR terrible OR hate`);
        searchQueries.push(`${domain} alternative OR switched OR wish`);
        searchQueries.push(`${domain} expensive OR overpriced OR not worth`);
        searchQueries.push(`${domain} broken OR unusable OR nightmare`);
      }
    }

    const sortModes = ['comments', 'relevance'];
    const postsById = new Map();

    // Build full list of work items
    const workItems = [];
    if (globalMode) {
      for (const sortMode of sortModes) {
        for (const query of searchQueries) {
          workItems.push({ sub: null, sortMode, query });
        }
      }
    } else {
      for (const sub of subreddits) {
        for (const sortMode of sortModes) {
          for (const query of searchQueries) {
            workItems.push({ sub, sortMode, query });
          }
        }
      }
    }

    // Partition work items across tabs
    const workerChunks = Array.from({ length: parallelTabs }, () => []);
    workItems.forEach((item, i) => workerChunks[i % parallelTabs].push(item));

    log(`[browser-scan] ${workItems.length} query combinations across ${parallelTabs} tab(s)`);

    const pagesLoadedPerWorker = await Promise.all(
      workerChunks.map(chunk => runWorker(browser, chunk, maxPages, postsById, globalMode, timeFilter, domain))
    );
    const pagesLoaded = pagesLoadedPerWorker.reduce((a, b) => a + b, 0);

    log(`[browser-scan] ${postsById.size} unique posts after dedup (${pagesLoaded} pages loaded)`);

    const scored = [];
    for (const post of postsById.values()) {
      if ((post.num_comments || 0) < minComments) continue;
      const enriched = enrichPost(post, domain);
      if (enriched) scored.push(enriched);
    }

    scored.sort((a, b) => b.painScore - a.painScore);

    const warnings = [];
    if (_blockedDetected) warnings.push('Reddit blocked requests — results are partial (detected rate limit or ban page)');
    if (_rateLimitWarning) warnings.push('Rate limit warnings occurred during this scan');
    if (_consecutiveErrors > 0) warnings.push(`Scan ended with ${_consecutiveErrors} consecutive errors`);

    if (warnings.length > 0) {
      process.stderr.write(`\n⚠ SCAN COMPLETED WITH WARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}\n\n`);
    }

    ok({
      mode: globalMode ? 'browser-global' : 'browser',
      posts: scored.slice(0, limit),
      stats: {
        subreddits: globalMode ? 0 : subreddits.length,
        global_mode: globalMode,
        pages_loaded: pagesLoaded,
        raw_posts: postsById.size,
        after_filter: Math.min(scored.length, limit),
        max_pages_per_query: maxPages,
        parallel_tabs: parallelTabs,
        total_requests: _totalRequests,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } finally {
    await browser.disconnect();
  }
}

async function cmdDeepDive(args) {
  const postUrls = [];
  if (args.post) {
    let url = args.post;
    if (!url.startsWith('http')) url = `${OLD_REDDIT}/comments/${url}`;
    postUrls.push(url);
  } else if (args.fromScan) {
    let scanData;
    try { scanData = JSON.parse(readFileSync(args.fromScan, 'utf8')); }
    catch (err) { fail(`Cannot read scan file: ${err.message}`); }
    const posts = scanData?.data?.posts || scanData?.posts || [];
    for (const p of posts.slice(0, args.top || 10)) {
      if (p.url) postUrls.push(p.url);
      else if (p.id) postUrls.push(`${OLD_REDDIT}/comments/${p.id}`);
    }
  } else if (args.fromStdin) {
    let input = '';
    const { stdin } = await import('node:process');
    for await (const chunk of stdin) input += chunk;
    try {
      const scanData = JSON.parse(input);
      const posts = scanData?.data?.posts || scanData?.posts || [];
      for (const p of posts.slice(0, args.top || 10)) {
        if (p.url) postUrls.push(p.url);
        else if (p.id) postUrls.push(`${OLD_REDDIT}/comments/${p.id}`);
      }
    } catch (err) { fail(`Cannot parse stdin: ${err.message}`); }
  } else {
    fail('--post <url|id> or --from-scan <file> or --stdin is required');
  }

  const maxComments = args.maxComments || 200;
  log(`[browser-deep-dive] ${postUrls.length} post(s), maxComments=${maxComments}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();
  await page.setUserAgent(REDDIT_USER_AGENT);

  try {
    const results = [];
    for (const postUrl of postUrls) {
      // Stop if blocked
      if (_blockedDetected) {
        log(`[browser-deep-dive] blocked — stopping with ${results.length} results so far`);
        break;
      }
      log(`[browser-deep-dive] scraping ${postUrl}`);
      try {
        const data = await scrapePostPage(page, postUrl, maxComments);
        const idMatch = postUrl.match(/\/comments\/([a-z0-9]+)/i);
        const postId = idMatch ? idMatch[1] : '';

        const postMeta = {
          id: postId, title: data.title, selftext: data.selftext,
          subreddit: data.subreddit, url: postUrl,
          score: data.score, num_comments: data.comments.length,
          flair: data.flair, upvote_ratio: 0, created_utc: 0,
        };

        const postPainCats = getPostPainCategories(postMeta);
        const analysis = analyzeComments(data.comments, postPainCats, postUrl || '');

        results.push({
          post: {
            id: postId, title: data.title, subreddit: data.subreddit,
            url: postUrl, score: data.score, num_comments: data.comments.length,
            painScore: computePainScore(postMeta),
            selftext_excerpt: excerpt(data.selftext, 300), flair: data.flair,
          },
          analysis,
        });
      } catch (err) {
        log(`[browser-deep-dive] failed for ${postUrl}: ${err.message}`);
        results.push({ post: { url: postUrl }, error: err.message });
      }
      await politeDelayLocal();
    }

    const warnings = [];
    if (_blockedDetected) warnings.push('Reddit blocked requests — results may be incomplete');
    if (_rateLimitWarning) warnings.push('Rate limit warnings occurred during this scan');

    if (warnings.length > 0) {
      process.stderr.write(`\n⚠ DEEP-DIVE COMPLETED WITH WARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}\n\n`);
    }

    ok({
      mode: 'browser', results, pages_loaded: postUrls.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } finally {
    await page.close();
  }
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'reddit-browser',
  description: 'Puppeteer browser — real-time Reddit data via old.reddit.com scraping',
  commands: ['scan', 'deep-dive'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      case 'deep-dive': return cmdDeepDive(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
reddit-browser source — Puppeteer browser scraping

Commands:
  scan        Search subreddits for pain points (via old.reddit.com)
  deep-dive   Analyze comment threads of specific posts

scan options:
  --subreddits <list>   Comma-separated subreddits (required)
  --domain <str>        Domain for relevance boosting
  --time <period>       hour, day, week, month, year, all (default: year)
  --minComments <n>     Min comments (default: 3)
  --limit <n>           Max posts (default: 30)
  --max-pages <n>       Pages of results per query (default: 10 = ~250 results)
  --parallel-tabs <n>   Parallel browser tabs (default: 1, max: 5)

deep-dive options:
  --post <url|id>       Single post URL or ID
  --from-scan <file>    JSON file from scan
  --stdin               Read scan JSON from stdin
  --top <n>             Top N posts (default: 10)
  --maxComments <n>     Max comments per post (default: 200)

Connection options:
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)
`,
};
