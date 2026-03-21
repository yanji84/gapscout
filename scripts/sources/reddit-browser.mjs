/**
 * reddit-browser.mjs — Puppeteer browser source for pain-point-finder
 *
 * Scrapes old.reddit.com via Puppeteer. Connects to an existing Chrome
 * instance (e.g. from puppeteer-mcp-server) or accepts --ws-url / --port.
 */

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import {
  computePainScore, analyzeComments, enrichPost,
  matchSignals, getPostPainCategories,
} from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const OLD_REDDIT = 'https://old.reddit.com';
const PAGE_DELAY_MS = 2000;
const JITTER_MS = 500;
const MAX_PAGES_PER_RUN = 50;

async function politeDelay() {
  await sleep(PAGE_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

// ─── browser connection ─────────────────────────────────────────────────────

async function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.webSocketDebuggerUrl || null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function findChromeWSEndpoint() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpdir = os.default.tmpdir();
  const entries = fs.default.readdirSync(tmpdir);
  const candidates = [];
  for (const entry of entries) {
    if (entry.startsWith('puppeteer_dev_chrome_profile')) {
      const portFile = path.default.join(tmpdir, entry, 'DevToolsActivePort');
      if (fs.default.existsSync(portFile)) {
        const content = fs.default.readFileSync(portFile, 'utf8').trim();
        const lines = content.split('\n');
        if (lines.length >= 2) {
          candidates.push({ port: lines[0].trim(), wsPath: lines[1].trim() });
        }
      }
    }
  }
  // Validate each candidate by probing the HTTP endpoint
  for (const { port, wsPath } of candidates) {
    const wsUrl = await probePort(parseInt(port, 10));
    if (wsUrl) {
      log(`[browser] found Chrome at ws://127.0.0.1:${port}${wsPath}`);
      return wsUrl;
    }
    log(`[browser] Chrome port ${port} not responding, skipping`);
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
    log(`[browser] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }
  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[browser] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }
  const wsUrl = await findChromeWSEndpoint();
  if (wsUrl) {
    try { return await puppeteer.connect({ browserWSEndpoint: wsUrl }); }
    catch (err) { log(`[browser] auto-detect failed: ${err.message}`); }
  }
  fail('No Chrome browser found. Start puppeteer-mcp-server, or pass --ws-url / --port');
}

// ─── scraping functions ─────────────────────────────────────────────────────

async function scrapeSearchResults(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1000);

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

async function scrapePostPage(page, postUrl, maxComments = 200) {
  let url = postUrl.replace('www.reddit.com', 'old.reddit.com');
  if (!url.includes('old.reddit.com')) url = url.replace('reddit.com', 'old.reddit.com');
  url = url.replace(/\?.*$/, '') + '?limit=500';

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

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

  if (globalMode) {
    log(`[browser-scan] global domain mode: domain="${domain}", time=${timeFilter}`);
  } else {
    log(`[browser-scan] subreddits=${subreddits.join(',')}, domain="${domain}", time=${timeFilter}`);
  }

  const browser = await connectBrowser(args);
  const page = await browser.newPage();
  let pagesLoaded = 0;

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

    if (globalMode) {
      // Global Reddit search — no subreddit restriction
      for (const sortMode of sortModes) {
        for (const query of searchQueries) {
          if (pagesLoaded >= MAX_PAGES_PER_RUN) {
            log(`[browser-scan] max pages reached (${MAX_PAGES_PER_RUN})`);
            break;
          }
          const encodedQuery = encodeURIComponent(query);
          const url = `${OLD_REDDIT}/search?q=${encodedQuery}&sort=${sortMode}&t=${timeFilter}`;
          log(`[browser-scan] global sort=${sortMode} q="${query.substring(0, 40)}..."`);
          try {
            const posts = await scrapeSearchResults(page, url);
            pagesLoaded++;
            for (const p of posts) {
              if (p.id && !postsById.has(p.id)) postsById.set(p.id, p);
            }
            log(`[browser-scan]   found ${posts.length} posts (${postsById.size} total unique)`);
          } catch (err) {
            log(`[browser-scan]   failed: ${err.message}`);
          }
          await politeDelay();
        }
      }
    } else {
      for (const sub of subreddits) {
        for (const sortMode of sortModes) {
          for (const query of searchQueries) {
            if (pagesLoaded >= MAX_PAGES_PER_RUN) {
              log(`[browser-scan] max pages reached (${MAX_PAGES_PER_RUN})`);
              break;
            }
            const encodedQuery = encodeURIComponent(query);
            const url = `${OLD_REDDIT}/r/${sub}/search?q=${encodedQuery}&restrict_sr=on&sort=${sortMode}&t=${timeFilter}`;
            log(`[browser-scan] r/${sub} sort=${sortMode} q="${query.substring(0, 40)}..."`);
            try {
              const posts = await scrapeSearchResults(page, url);
              pagesLoaded++;
              for (const p of posts) {
                if (p.id && !postsById.has(p.id)) postsById.set(p.id, p);
              }
              log(`[browser-scan]   found ${posts.length} posts (${postsById.size} total unique)`);
            } catch (err) {
              log(`[browser-scan]   failed: ${err.message}`);
            }
            await politeDelay();
          }
        }
      }
    }

    log(`[browser-scan] ${postsById.size} unique posts after dedup`);

    const scored = [];
    for (const post of postsById.values()) {
      if ((post.num_comments || 0) < minComments) continue;
      const enriched = enrichPost(post, domain);
      if (enriched) scored.push(enriched);
    }

    scored.sort((a, b) => b.painScore - a.painScore);
    ok({
      mode: globalMode ? 'browser-global' : 'browser',
      posts: scored.slice(0, limit),
      stats: {
        subreddits: globalMode ? 0 : subreddits.length,
        global_mode: globalMode,
        pages_loaded: pagesLoaded,
        raw_posts: postsById.size,
        after_filter: Math.min(scored.length, limit),
      },
    });
  } finally {
    await page.close();
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

  try {
    const results = [];
    for (const postUrl of postUrls) {
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
        const analysis = analyzeComments(data.comments, postPainCats);

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
      await politeDelay();
    }

    ok({ mode: 'browser', results, pages_loaded: postUrls.length });
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
