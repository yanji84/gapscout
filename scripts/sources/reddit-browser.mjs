/**
 * reddit-browser.mjs — Reddit JSON API source for gapscout
 *
 * Uses Reddit's .json HTTP API (appending .json to URLs) instead of
 * Puppeteer browser scraping. ~10-15x faster than browser-based approach.
 */

import { readFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import {
  computePainScore, analyzeComments, enrichPost,
  matchSignals, getPostPainCategories,
} from '../lib/scoring.mjs';
import {
  httpGetWithRetry, RateLimiter, REDDIT_USER_AGENT,
} from '../lib/http.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const REDDIT_HOST = 'old.reddit.com';
const OLD_REDDIT = 'https://old.reddit.com';
const MAX_PAGES_PER_RUN = 200;

/** Rate limiter: ~1 request/sec with jitter, max 30/min */
const rateLimiter = new RateLimiter({
  minDelayMs: 1000,
  jitterMs: 300,
  maxPerMin: 30,
});

/** Track error/block state across the session */
let _blockedDetected = false;
let _rateLimitWarning = false;
let _consecutiveErrors = 0;

function emitWarning(message) {
  _rateLimitWarning = true;
  process.stderr.write(`\n⚠ RATE LIMIT WARNING [reddit-browser]: ${message}\n\n`);
}

// ─── JSON API helpers ────────────────────────────────────────────────────────

const HEADERS = { 'User-Agent': REDDIT_USER_AGENT };

/**
 * Fetch a Reddit .json endpoint with rate limiting and retry.
 * Returns the parsed JSON body.
 */
async function redditGet(path) {
  // Ensure raw_json=1 is appended for unescaped HTML entities
  const separator = path.includes('?') ? '&' : '?';
  const fullPath = `${path}${separator}raw_json=1`;

  try {
    const result = await httpGetWithRetry(REDDIT_HOST, fullPath, {
      headers: HEADERS,
      rateLimiter,
    });
    _consecutiveErrors = 0;
    return result;
  } catch (err) {
    _consecutiveErrors++;
    if (err.statusCode === 429) {
      emitWarning(`Rate limited (429) — ${err.message}`);
    } else if (err.statusCode === 403) {
      emitWarning(`Blocked/forbidden (403) — ${err.message}`);
      _blockedDetected = true;
    }
    throw err;
  }
}

// ─── search results fetching ─────────────────────────────────────────────────

/**
 * Fetch one page of search results via the .json API.
 * Returns { posts: [...], after: string|null }.
 */
async function fetchSearchPage(path) {
  const json = await redditGet(path);
  const listing = json?.data;
  if (!listing || !listing.children) return { posts: [], after: null };

  const posts = listing.children
    .filter(child => child.kind === 't3') // t3 = link/post
    .map(child => {
      const d = child.data;
      return {
        id: d.id || '',
        title: d.title || '',
        selftext: d.selftext || '',
        subreddit: d.subreddit || '',
        url: d.permalink ? `${OLD_REDDIT}${d.permalink}` : '',
        score: d.score || 0,
        num_comments: d.num_comments || 0,
        upvote_ratio: d.upvote_ratio || 0,
        flair: d.link_flair_text || '',
        created_utc: d.created_utc || 0,
      };
    });

  return { posts, after: listing.after || null };
}

/**
 * Fetch multiple pages of search results, following pagination via `after`.
 */
async function fetchSearchAllPages(basePath, maxPages, postsById, label) {
  let after = null;
  let pageNum = 0;
  let totalNewPosts = 0;

  while (pageNum < maxPages) {
    const separator = basePath.includes('?') ? '&' : '?';
    const pagePath = after
      ? `${basePath}${separator}after=${after}`
      : basePath;

    log(`[reddit-json] ${label} page ${pageNum + 1}${maxPages > 1 ? `/${maxPages}` : ''}`);

    try {
      const { posts, after: nextAfter } = await fetchSearchPage(pagePath);
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
      log(`[reddit-json]   ${posts.length} posts on page (${newCount} new, ${postsById.size} total unique)`);

      if (posts.length === 0 || !nextAfter) break;
      after = nextAfter;
    } catch (err) {
      _consecutiveErrors++;
      log(`[reddit-json]   failed: ${err.message}`);

      if (_blockedDetected || err.statusCode === 403) {
        log(`[reddit-json]   blocked — returning partial results (${postsById.size} posts so far)`);
        break;
      }

      // On repeated failures, stop pagination
      if (_consecutiveErrors >= 3) {
        log(`[reddit-json]   ${_consecutiveErrors} consecutive errors — stopping pagination`);
        break;
      }

      // Backoff and retry next page
      const backoff = 3000 * Math.pow(2, _consecutiveErrors - 1);
      log(`[reddit-json]   backing off ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
  }

  return pageNum;
}

// ─── post/comments fetching ──────────────────────────────────────────────────

/**
 * Fetch a post and its comments via /comments/{id}.json.
 * Returns { title, selftext, flair, score, subreddit, comments: [{body, score}] }.
 */
async function fetchPostPage(postId, maxComments = 200) {
  const path = `/comments/${postId}.json?limit=${Math.min(maxComments, 500)}&sort=top`;
  const json = await redditGet(path);

  // Reddit returns an array: [postListing, commentsListing]
  if (!Array.isArray(json) || json.length < 2) {
    return { title: '', selftext: '', flair: '', score: 0, subreddit: '', comments: [] };
  }

  const postData = json[0]?.data?.children?.[0]?.data || {};
  const commentsListing = json[1]?.data?.children || [];

  const comments = [];
  collectComments(commentsListing, comments, maxComments);

  return {
    title: postData.title || '',
    selftext: postData.selftext || '',
    flair: postData.link_flair_text || '',
    score: postData.score || 0,
    subreddit: postData.subreddit || '',
    comments,
  };
}

/**
 * Recursively collect comments from a Reddit comment tree.
 */
function collectComments(children, out, maxComments) {
  for (const child of children) {
    if (out.length >= maxComments) break;
    if (child.kind !== 't1') continue; // t1 = comment

    const d = child.data;
    if (d.body && d.body !== '[deleted]' && d.body !== '[removed]') {
      out.push({
        body: d.body.substring(0, 500),
        score: d.score || 1,
      });
    }

    // Recurse into replies
    if (d.replies && d.replies.data && d.replies.data.children) {
      collectComments(d.replies.data.children, out, maxComments);
    }
  }
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const subreddits = args.subreddits;
  const domain = args.domain || '';

  if ((!subreddits || !subreddits.length) && !domain) {
    fail('--subreddits or --domain is required');
  }

  const limit = args.limit || 30;
  const timeFilter = args.time || 'year';
  const minComments = args.minComments || 3;
  const globalMode = !subreddits || !subreddits.length;
  const maxPages = args.maxPages || 10;

  if (globalMode) {
    log(`[reddit-json] global domain mode: domain="${domain}", time=${timeFilter}, maxPages=${maxPages}`);
  } else {
    log(`[reddit-json] subreddits=${subreddits.join(',')}, domain="${domain}", time=${timeFilter}, maxPages=${maxPages}`);
  }

  const searchQueries = [];

  if (globalMode) {
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

  log(`[reddit-json] ${workItems.length} query combinations`);

  let pagesLoaded = 0;

  for (const item of workItems) {
    if (_blockedDetected) {
      log(`[reddit-json] blocked — stopping`);
      break;
    }
    if (pagesLoaded >= MAX_PAGES_PER_RUN) {
      log(`[reddit-json] hit MAX_PAGES_PER_RUN (${MAX_PAGES_PER_RUN})`);
      break;
    }

    const { sub, sortMode, query } = item;
    const encodedQuery = encodeURIComponent(query);
    let basePath;
    if (globalMode) {
      basePath = `/search.json?q=${encodedQuery}&sort=${sortMode}&t=${timeFilter}&limit=100`;
    } else {
      basePath = `/r/${sub}/search.json?q=${encodedQuery}&restrict_sr=on&sort=${sortMode}&t=${timeFilter}&limit=100`;
    }

    const label = globalMode
      ? `global sort=${sortMode} q="${query.substring(0, 35)}"`
      : `r/${sub} sort=${sortMode} q="${query.substring(0, 35)}"`;

    const pages = await fetchSearchAllPages(basePath, maxPages, postsById, label);
    pagesLoaded += pages;
  }

  log(`[reddit-json] ${postsById.size} unique posts after dedup (${pagesLoaded} pages loaded)`);

  const scored = [];
  for (const post of postsById.values()) {
    if ((post.num_comments || 0) < minComments) continue;
    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  const warnings = [];
  if (_blockedDetected) warnings.push('Reddit blocked requests — results are partial (detected rate limit or ban)');
  if (_rateLimitWarning) warnings.push('Rate limit warnings occurred during this scan');
  if (_consecutiveErrors > 0) warnings.push(`Scan ended with ${_consecutiveErrors} consecutive errors`);

  if (warnings.length > 0) {
    process.stderr.write(`\n⚠ SCAN COMPLETED WITH WARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}\n\n`);
  }

  ok({
    mode: globalMode ? 'json-global' : 'json',
    posts: scored.slice(0, limit),
    stats: {
      subreddits: globalMode ? 0 : subreddits.length,
      global_mode: globalMode,
      pages_loaded: pagesLoaded,
      raw_posts: postsById.size,
      after_filter: Math.min(scored.length, limit),
      max_pages_per_query: maxPages,
      total_requests: rateLimiter.count,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  });
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
  log(`[reddit-json-deep-dive] ${postUrls.length} post(s), maxComments=${maxComments}`);

  const results = [];
  for (const postUrl of postUrls) {
    if (_blockedDetected) {
      log(`[reddit-json-deep-dive] blocked — stopping with ${results.length} results so far`);
      break;
    }

    // Extract post ID from URL
    const idMatch = postUrl.match(/\/comments\/([a-z0-9]+)/i);
    const postId = idMatch ? idMatch[1] : '';

    if (!postId) {
      log(`[reddit-json-deep-dive] cannot extract post ID from ${postUrl}`);
      results.push({ post: { url: postUrl }, error: 'Cannot extract post ID from URL' });
      continue;
    }

    log(`[reddit-json-deep-dive] fetching ${postId}`);
    try {
      const data = await fetchPostPage(postId, maxComments);

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
      log(`[reddit-json-deep-dive] failed for ${postUrl}: ${err.message}`);
      results.push({ post: { url: postUrl }, error: err.message });
    }
  }

  const warnings = [];
  if (_blockedDetected) warnings.push('Reddit blocked requests — results may be incomplete');
  if (_rateLimitWarning) warnings.push('Rate limit warnings occurred during this scan');

  if (warnings.length > 0) {
    process.stderr.write(`\n⚠ DEEP-DIVE COMPLETED WITH WARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}\n\n`);
  }

  ok({
    mode: 'json', results, pages_loaded: postUrls.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'reddit-browser',
  description: 'Reddit JSON API — fast structured data via .json endpoints (no browser needed)',
  commands: ['scan', 'deep-dive'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      case 'deep-dive': return cmdDeepDive(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
reddit-browser source — Reddit JSON API (no browser required)

Commands:
  scan        Search subreddits for pain points (via Reddit .json API)
  deep-dive   Analyze comment threads of specific posts

scan options:
  --subreddits <list>   Comma-separated subreddits (required unless --domain)
  --domain <str>        Domain for relevance boosting
  --time <period>       hour, day, week, month, year, all (default: year)
  --minComments <n>     Min comments (default: 3)
  --limit <n>           Max posts (default: 30)
  --max-pages <n>       Pages of results per query (default: 10)

deep-dive options:
  --post <url|id>       Single post URL or ID
  --from-scan <file>    JSON file from scan
  --stdin               Read scan JSON from stdin
  --top <n>             Top N posts (default: 10)
  --maxComments <n>     Max comments per post (default: 200)
`,
};
