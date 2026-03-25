/**
 * reddit-api.mjs — Arctic Shift + PullPush API source for gapscout
 *
 * Data sources (tried in order):
 *   1. Arctic Shift API — high-throughput historical Reddit archive (~2000 req/min)
 *   2. PullPush API — historical Reddit data archive (fallback)
 *   3. Reddit OAuth API — official Reddit API (second fallback, requires
 *      REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET env vars)
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt, unixNow, daysAgoUnix, utcToDate } from '../lib/utils.mjs';
import {
  SCAN_QUERIES, computePainScore, analyzeComments, enrichPost,
  getPostPainCategories, matchSignals,
} from '../lib/scoring.mjs';
import { RateLimiter, httpGet as httpGetBase, REDDIT_USER_AGENT, _rateLimitWarning } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';
import { getGlobalRateMonitor } from '../lib/rate-monitor.mjs';
import { Logger } from '../lib/logger.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PULLPUSH_HOST = 'api.pullpush.io';
const SUBMISSION_PATH = '/reddit/search/submission/';
const COMMENT_PATH = '/reddit/search/comment/';

const ARCTIC_SHIFT_HOST = 'arctic-shift.photon-reddit.com';
const ARCTIC_SHIFT_POSTS_PATH = '/api/posts/search';
const ARCTIC_SHIFT_COMMENTS_PATH = '/api/comments/search';

const MAX_RETRIES_429 = 5;
const MAX_RETRIES_5XX = 3;
const MAX_RETRIES_TIMEOUT = 1;
const BACKOFF_BASE_MS = 2000;

const PAGE_SIZE = 100;

let _redditTipShown = false;

// Module-level logger reference so helper functions (fetchWithRetry, redditOAuthGet) can emit events
let _scanLogger = null;

// ─── expanded SCAN_QUERIES (30+ terms, domain-specific sets) ─────────────────

const DOMAIN_SCAN_QUERIES = {
  // General pain signals
  frustration: [
    'frustrated', 'nightmare', 'terrible', 'unusable', 'hate',
    'broken', 'awful', 'garbage', 'worst experience', 'ridiculous',
  ],
  desire: [
    'alternative', 'looking for', 'switched from', 'wish',
    'need something better', 'replacement for', 'move away from',
  ],
  cost: [
    'expensive', 'overpriced', 'not worth', 'price hike', 'hidden fees',
    'ripoff', 'gouging',
  ],
  willingness_to_pay: [
    'paid for', 'would pay', 'wasted hours', 'hired',
    'worth paying', 'take my money',
  ],
  // Tickets domain
  tickets: [
    'bot bought tickets', 'queue bot', 'presale bot',
    'ticketmaster bot', 'sold out instantly',
  ],
  // Sneakers domain
  sneakers: [
    'sneaker bot', 'SNKRS bot', 'checkout bot', 'raffle bot',
  ],
  // GPU / electronics domain
  gpu: [
    'scalper gpu', 'bot bought gpu', 'sold out gpu',
  ],
  // General scalper / fairness
  general_scalper: [
    'scalper', 'resale markup', 'face value', 'anti-bot', 'queue fairness',
  ],
};

// Categories included by default (domain-specific ones like tickets/sneakers/gpu are opt-in)
const GENERAL_CATEGORIES = ['frustration', 'desire', 'cost', 'willingness_to_pay', 'general_scalper'];

// ─── recommended subreddits help text ────────────────────────────────────────

const RECOMMENDED_SUBREDDITS = `
Tickets / Events:
  Ticketmaster, LiveNation, concerts, festivals, taylor_swift, beyonce,
  livenation, stubhub, seatgeek, eventim, coachella

Sneakers:
  Sneakers, Sneakerhead, Nike, Adidas, SNKRS, FashionReps,
  yeezy, jordans, streetwear, hypebeast

Gaming / GPUs / Electronics:
  hardware, buildapc, pcmasterrace, nvidia, amd, GameDeals,
  ps5, xbox, gaming, consoles, GamersNexus

General Commerce / Scalping:
  OutOfTheLoop, mildlyinfuriating, Scams, personalfinance,
  antiwork, technology, business, Entrepreneur

SaaS / Software:
  SaaS, startups, Entrepreneur, webdev, programming,
  productivity, remotework, digitalnomad

Customer Service / Support:
  mildlyinfuriating, TrueOffMyChest, complaints, CustomerService,
  legaladvice, smallbusiness, freelance
`;

// ─── rate limiters ──────────────────────────────────────────────────────────

const rateLimiter = new RateLimiter({ maxPerRun: 1000 });

const arcticShiftRateLimiter = new RateLimiter({
  maxPerRun: 5000,
  minDelayMs: 3500,
  jitterMs: 1000,
  maxPerMin: 15,
});

// ─── HTTP client (PullPush) ─────────────────────────────────────────────────

function httpGet(urlPath, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const fullPath = `${urlPath}?${qs.toString()}`;
  return httpGetBase(PULLPUSH_HOST, fullPath, {
    headers: { 'User-Agent': REDDIT_USER_AGENT },
  });
}

async function fetchWithRetry(urlPath, params) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
    try {
      await rateLimiter.wait();
      getUsageTracker().increment('reddit-api');
      return await httpGet(urlPath, params);
    } catch (err) {
      lastErr = err;
      const code = err.statusCode || 0;

      // 403 = blocked/banned — do not retry, throw so caller can handle gracefully
      if (code === 403) {
        _scanLogger?.warn('403 Forbidden — possible IP ban or API block. Returning partial results.', { statusCode: 403 });
        getGlobalRateMonitor().reportBlock('reddit-api', 'PullPush 403 Forbidden — possible IP ban or API block', { statusCode: 403 });
        throw err;
      }

      let maxForType;
      if (code === 429) maxForType = MAX_RETRIES_429;
      else if (code >= 500) maxForType = MAX_RETRIES_5XX;
      else if (err.message === 'timeout') maxForType = MAX_RETRIES_TIMEOUT;
      else maxForType = 1;
      if (attempt >= maxForType) break;

      // Exponential backoff; respect Retry-After header for 429s
      let backoff;
      if (code === 429 && err.retryAfterSec) {
        backoff = err.retryAfterSec * 1000;
        _scanLogger?.warn(`429 Too Many Requests — retry after ${err.retryAfterSec}s`, { statusCode: 429, retryAfterSec: err.retryAfterSec });
        getGlobalRateMonitor().reportError('reddit-api', `PullPush 429 — retry after ${err.retryAfterSec}s`, { statusCode: 429, retryAfterSec: err.retryAfterSec });
      } else {
        backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      }
      const jitter = Math.floor(Math.random() * backoff * 0.5);
      const delay = backoff + jitter;
      log(`[http] ${err.message} — retry ${attempt + 1}/${maxForType} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ─── PullPush helpers ───────────────────────────────────────────────────────

async function searchSubmissions(params) {
  const result = await fetchWithRetry(SUBMISSION_PATH, { size: PAGE_SIZE, ...params });
  return result?.data || [];
}

async function searchComments(params) {
  const result = await fetchWithRetry(COMMENT_PATH, { size: PAGE_SIZE, ...params });
  return result?.data || [];
}

async function paginateSubmissions(params, maxPages = 20) {
  const all = [];
  let currentParams = { ...params };
  for (let page = 0; page < maxPages; page++) {
    let posts;
    try { posts = await searchSubmissions(currentParams); }
    catch (err) { log(`[paginate] page ${page + 1} failed: ${err.message}`); break; }
    if (!posts.length) break;
    all.push(...posts);
    const last = posts[posts.length - 1];
    if (!last.created_utc) break;
    currentParams = { ...currentParams, before: Math.floor(last.created_utc) };
  }
  return all;
}

async function paginateCommentSearch(params, maxPages = 20) {
  const all = [];
  let currentParams = { ...params };
  for (let page = 0; page < maxPages; page++) {
    let comments;
    try { comments = await searchComments(currentParams); }
    catch (err) { log(`[comment-search] page ${page + 1} failed: ${err.message}`); break; }
    if (!comments.length) break;
    all.push(...comments);
    const last = comments[comments.length - 1];
    if (!last.created_utc) break;
    currentParams = { ...currentParams, before: Math.floor(last.created_utc) };
  }
  return all;
}

async function paginateComments(linkId, maxComments = 100) {
  const all = [];
  let before = null;
  const maxPages = Math.ceil(maxComments / PAGE_SIZE);
  for (let page = 0; page < maxPages; page++) {
    const params = { link_id: linkId, size: PAGE_SIZE };
    if (before) params.before = before;
    let comments;
    try { comments = await searchComments(params); }
    catch (err) { log(`[comments] page ${page + 1} failed: ${err.message}`); break; }
    if (!comments.length) break;
    all.push(...comments);
    const last = comments[comments.length - 1];
    if (!last.created_utc) break;
    before = Math.floor(last.created_utc);
  }
  return all.slice(0, maxComments);
}

// ─── Arctic Shift helpers ────────────────────────────────────────────────────

/**
 * Convert a unix timestamp to ISO 8601 date string (YYYY-MM-DD).
 */
function unixToISODate(ts) {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

/**
 * Low-level GET for Arctic Shift API.
 */
function arcticShiftGet(urlPath, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const fullPath = `${urlPath}?${qs.toString()}`;
  return httpGetBase(ARCTIC_SHIFT_HOST, fullPath, {
    headers: { 'User-Agent': REDDIT_USER_AGENT },
  });
}

/**
 * Arctic Shift GET with retry logic (mirrors PullPush fetchWithRetry).
 */
async function arcticShiftFetchWithRetry(urlPath, params) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
    try {
      await arcticShiftRateLimiter.wait();
      getUsageTracker().increment('reddit-api');
      const result = await arcticShiftGet(urlPath, params);
      return result?.data || [];
    } catch (err) {
      lastErr = err;
      const code = err.statusCode || 0;

      if (code === 403) {
        _scanLogger?.warn('Arctic Shift 403 Forbidden — returning partial results.', { statusCode: 403 });
        getGlobalRateMonitor().reportBlock('reddit-api', 'Arctic Shift 403 Forbidden', { statusCode: 403 });
        throw err;
      }

      let maxForType;
      if (code === 429) maxForType = MAX_RETRIES_429;
      else if (code >= 500) maxForType = MAX_RETRIES_5XX;
      else if (err.message === 'timeout') maxForType = MAX_RETRIES_TIMEOUT;
      else maxForType = 1;
      if (attempt >= maxForType) break;

      let backoff;
      if (code === 429 && err.retryAfterSec) {
        backoff = err.retryAfterSec * 1000;
        _scanLogger?.warn(`Arctic Shift 429 — retry after ${err.retryAfterSec}s`, { statusCode: 429, retryAfterSec: err.retryAfterSec });
        getGlobalRateMonitor().reportError('reddit-api', `Arctic Shift 429 — retry after ${err.retryAfterSec}s`, { statusCode: 429, retryAfterSec: err.retryAfterSec });
      } else {
        backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      }
      const jitter = Math.floor(Math.random() * backoff * 0.5);
      const delay = backoff + jitter;
      log(`[arctic-shift] ${err.message} — retry ${attempt + 1}/${maxForType} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Search submissions via Arctic Shift API.
 * Accepts params with unix-timestamp `after`/`before` and converts to ISO dates.
 */
async function arcticShiftSearchSubmissions(params) {
  const asParams = { limit: PAGE_SIZE };
  if (params.subreddit) asParams.subreddit = params.subreddit;
  if (params.q || params.query) asParams.query = params.q || params.query;
  if (params.after) asParams.after = unixToISODate(params.after);
  if (params.before) asParams.before = unixToISODate(params.before);
  if (params.limit) asParams.limit = params.limit;
  return arcticShiftFetchWithRetry(ARCTIC_SHIFT_POSTS_PATH, asParams);
}

/**
 * Paginate submissions via Arctic Shift, using `before` set to last result's created_utc.
 */
async function arcticShiftPaginateSubmissions(params, maxPages = 20) {
  const all = [];
  let currentParams = { ...params };
  for (let page = 0; page < maxPages; page++) {
    let posts;
    try { posts = await arcticShiftSearchSubmissions(currentParams); }
    catch (err) { log(`[arctic-shift] page ${page + 1} failed: ${err.message}`); break; }
    if (!posts.length) break;
    all.push(...posts);
    const last = posts[posts.length - 1];
    if (!last.created_utc) break;
    currentParams = { ...currentParams, before: Math.floor(last.created_utc) };
  }
  return all;
}

// ─── post normalization ─────────────────────────────────────────────────────

function extractPostId(input) {
  const urlMatch = input.match(/\/comments\/([a-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-z0-9]+$/i.test(input)) return input;
  return null;
}

/** Normalize a PullPush/Arctic Shift post to common shape */
function normalizePost(p) {
  return {
    id: p.id,
    title: p.title || '',
    selftext: p.selftext || '',
    subreddit: p.subreddit || '',
    url: `https://www.reddit.com${p.permalink || ''}`,
    score: p.score || 0,
    num_comments: p.num_comments || 0,
    upvote_ratio: p.upvote_ratio || 0,
    flair: p.link_flair_text || '',
    created_utc: p.created_utc || 0,
  };
}

// ─── Reddit OAuth API fallback ───────────────────────────────────────────────

/**
 * Check if Reddit OAuth credentials are available in environment.
 */
function hasRedditOAuthCredentials() {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

/**
 * Get an OAuth access token from Reddit using client_credentials grant.
 * Returns the token string or throws on failure.
 */
let _redditOAuthToken = null;
let _redditOAuthExpiry = 0;

async function getRedditOAuthToken() {
  // Return cached token if still valid (with 60s buffer)
  if (_redditOAuthToken && Date.now() < _redditOAuthExpiry - 60000) {
    return _redditOAuthToken;
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are required for Reddit OAuth');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const postData = 'grant_type=client_credentials';

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.reddit.com',
      path: '/api/v1/access_token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_USER_AGENT,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            if (data.access_token) {
              _redditOAuthToken = data.access_token;
              _redditOAuthExpiry = Date.now() + (data.expires_in || 3600) * 1000;
              resolve(data.access_token);
            } else {
              reject(new Error(`Reddit OAuth: no access_token in response`));
            }
          } catch {
            reject(new Error(`Reddit OAuth: non-JSON response`));
          }
        } else {
          reject(new Error(`Reddit OAuth: HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Reddit OAuth: timeout')); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Make an authenticated GET request to the Reddit OAuth API.
 */
function redditOAuthGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'oauth.reddit.com',
      path,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': REDDIT_USER_AGENT,
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          // Check X-Ratelimit headers from Reddit API and warn if approaching limits
          const remaining = res.headers['x-ratelimit-remaining'];
          const used = res.headers['x-ratelimit-used'];
          const resetSec = res.headers['x-ratelimit-reset'];
          if (remaining !== undefined) {
            const rem = parseFloat(remaining);
            if (rem <= 10) {
              _scanLogger?.warn(`Reddit API — ${rem} requests remaining`, { remaining: rem, resetSec: resetSec || null });
              getGlobalRateMonitor().reportWarning('reddit-api', `Reddit OAuth API — only ${rem} requests remaining (resets in ${resetSec || '?'}s)`, { remaining: rem, resetSec });
            } else if (rem <= 30) {
              log(`[reddit-oauth] approaching rate limit: ${rem} requests remaining (used ${used || '?'}, resets in ${resetSec || '?'}s)`);
            }
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Reddit API: non-JSON response`)); }
        } else if (res.statusCode === 429) {
          const retryAfter = res.headers['retry-after'];
          _scanLogger?.warn(`Reddit OAuth API 429 — Too Many Requests`, { statusCode: 429, retryAfter: retryAfter || 'unknown' });
          getGlobalRateMonitor().reportError('reddit-api', `Reddit OAuth API 429 — Too Many Requests (retry-after: ${retryAfter || 'unknown'}s)`, { statusCode: 429, retryAfter });
          const err = new Error(`Reddit API: HTTP 429 (rate limited)`);
          err.statusCode = 429;
          if (retryAfter) err.retryAfterSec = parseInt(retryAfter, 10) || 60;
          reject(err);
        } else if (res.statusCode === 403) {
          _scanLogger?.warn(`Reddit OAuth API 403 — Forbidden (possible ban or auth failure)`, { statusCode: 403 });
          getGlobalRateMonitor().reportBlock('reddit-api', 'Reddit OAuth API 403 — Forbidden (possible ban or auth failure)', { statusCode: 403 });
          const err = new Error(`Reddit API: HTTP 403 (forbidden)`);
          err.statusCode = 403;
          reject(err);
        } else {
          const err = new Error(`Reddit API: HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Reddit API: timeout')); });
    req.on('error', reject);
  });
}

/**
 * Search Reddit via OAuth API. Returns posts in the same format as PullPush.
 */
async function redditOAuthSearch(query, { subreddit, sort = 'relevance', limit = 100, after } = {}) {
  const token = await getRedditOAuthToken();

  let path;
  if (subreddit) {
    path = `/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}&restrict_sr=on&type=link`;
  } else {
    path = `/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}&type=link`;
  }

  // Add time filter if 'after' timestamp is provided
  if (after) {
    const daysAgo = Math.ceil((unixNow() - after) / 86400);
    let t;
    if (daysAgo <= 1) t = 'day';
    else if (daysAgo <= 7) t = 'week';
    else if (daysAgo <= 30) t = 'month';
    else if (daysAgo <= 365) t = 'year';
    else t = 'all';
    path += `&t=${t}`;
  }

  await rateLimiter.wait();
  const data = await redditOAuthGet(path, token);

  // Reddit API returns { data: { children: [{ data: post }, ...] } }
  const children = data?.data?.children || [];
  return children.map(child => {
    const p = child.data;
    return {
      id: p.id,
      title: p.title || '',
      selftext: p.selftext || '',
      subreddit: p.subreddit || '',
      permalink: p.permalink || '',
      score: p.score || 0,
      num_comments: p.num_comments || 0,
      upvote_ratio: p.upvote_ratio || 0,
      link_flair_text: p.link_flair_text || '',
      created_utc: p.created_utc || 0,
    };
  });
}

/**
 * Paginate Reddit OAuth search results using after tokens.
 */
async function paginateRedditOAuth(query, { subreddit, sort = 'relevance', maxPages = 5, after } = {}) {
  const all = [];
  let redditAfter = null;

  for (let page = 0; page < maxPages; page++) {
    try {
      const token = await getRedditOAuthToken();
      let path;
      if (subreddit) {
        path = `/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=100&restrict_sr=on&type=link`;
      } else {
        path = `/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=100&type=link`;
      }

      if (after) {
        const daysAgo = Math.ceil((unixNow() - after) / 86400);
        let t;
        if (daysAgo <= 1) t = 'day';
        else if (daysAgo <= 7) t = 'week';
        else if (daysAgo <= 30) t = 'month';
        else if (daysAgo <= 365) t = 'year';
        else t = 'all';
        path += `&t=${t}`;
      }

      if (redditAfter) path += `&after=${redditAfter}`;

      await rateLimiter.wait();
      const data = await redditOAuthGet(path, token);

      const children = data?.data?.children || [];
      if (children.length === 0) break;

      for (const child of children) {
        const p = child.data;
        all.push({
          id: p.id,
          title: p.title || '',
          selftext: p.selftext || '',
          subreddit: p.subreddit || '',
          permalink: p.permalink || '',
          score: p.score || 0,
          num_comments: p.num_comments || 0,
          upvote_ratio: p.upvote_ratio || 0,
          link_flair_text: p.link_flair_text || '',
          created_utc: p.created_utc || 0,
        });
      }

      redditAfter = data?.data?.after;
      if (!redditAfter) break;
    } catch (err) {
      log(`[reddit-oauth] page ${page + 1} failed: ${err.message}`);
      break;
    }
  }

  return all;
}

// ─── comment search helper ──────────────────────────────────────────────────

/**
 * Search comments for a query term, fetch parent post metadata for each
 * unique parent post, and return enriched post objects with matching comment
 * counts attached. Groups comments by parent post to avoid duplicates.
 */
async function searchCommentsByQuery({ q, subreddit, after, minScore, maxPages, domain }) {
  const params = { q, size: PAGE_SIZE, after };
  if (subreddit) params.subreddit = subreddit;

  log(`[comment-search] q=${q}${subreddit ? ` r/${subreddit}` : ''}`);
  let comments;
  try {
    comments = await paginateCommentSearch(params, maxPages);
  } catch (err) {
    log(`[comment-search] failed: ${err.message}`);
    return [];
  }

  // Group by parent post link_id (strip t3_ prefix)
  const commentsByPost = new Map();
  for (const c of comments) {
    if (!c.link_id) continue;
    const postId = c.link_id.replace(/^t3_/, '');
    if (!commentsByPost.has(postId)) commentsByPost.set(postId, []);
    commentsByPost.get(postId).push(c);
  }

  log(`[comment-search] ${comments.length} comments → ${commentsByPost.size} unique posts`);

  // Fetch parent post metadata for each unique post
  const postsById = new Map();
  const postIds = [...commentsByPost.keys()];
  // Batch fetch: PullPush supports comma-separated ids
  const BATCH_SIZE = 20;
  for (let i = 0; i < postIds.length; i += BATCH_SIZE) {
    const batch = postIds.slice(i, i + BATCH_SIZE);
    let batchPosts;
    try {
      batchPosts = await searchSubmissions({ ids: batch.join(','), size: batch.length });
    } catch (err) {
      log(`[comment-search] batch fetch failed: ${err.message}`);
      continue;
    }
    for (const p of batchPosts) {
      postsById.set(p.id, p);
    }
  }

  // Build enriched posts with comment hit counts
  const results = [];
  for (const [postId, postComments] of commentsByPost) {
    const rawPost = postsById.get(postId);
    if (!rawPost) continue;
    if ((rawPost.score || 0) < minScore) continue;
    const post = normalizePost(rawPost);
    post._commentHits = postComments.length;
    post._matchingComments = postComments.map(c => ({
      body: (c.body || '').slice(0, 300),
      score: c.score || 0,
    }));
    results.push(post);
  }
  return results;
}

// ─── per-subreddit scan helper ───────────────────────────────────────────────

/**
 * Scan a single subreddit for all queries using a given paginate function.
 * Writes results into the shared postsById Map.
 * Returns the number of posts found for this subreddit and whether the source failed.
 */
async function scanSubreddit(sub, queries, { postsById, after, minScore, maxPages, includeComments, domain, logger, paginateFn, sourceLabel }) {
  let count = 0;
  let sourceFailed = false;

  for (const { q, category } of queries) {
    log(`[scan/${sourceLabel}] r/${sub} q=${q} (${category})`);
    let posts;
    try {
      posts = await paginateFn({
        q, subreddit: sub, score: `>${minScore}`,
        sort: 'desc', sort_type: 'num_comments', after,
      }, maxPages);
    } catch (err) {
      if (err.statusCode === 403) { sourceFailed = true; break; }
      if (err.statusCode >= 500 || err.message === 'timeout') sourceFailed = true;
      log(`[scan/${sourceLabel}] failed: ${err.message}`); continue;
    }
    for (const p of posts) {
      if (!postsById.has(p.id)) {
        postsById.set(p.id, p);
        count++;
      }
    }
  }

  // Comment search mode: search comments for query terms and surface parent posts
  // (only supported with PullPush, not Arctic Shift which doesn't support link_id queries)
  if (includeComments && !sourceFailed && sourceLabel === 'pullpush') {
    log(`[scan] comment-search mode for r/${sub}`);
    const commentQueries = domain
      ? [domain, ...Object.values(DOMAIN_SCAN_QUERIES).flat().slice(0, 10)]
      : Object.values(DOMAIN_SCAN_QUERIES).flat().slice(0, 15);

    for (const q of commentQueries) {
      const commentPosts = await searchCommentsByQuery({
        q, subreddit: sub, after, minScore, maxPages: Math.min(maxPages, 5), domain,
      });
      for (const p of commentPosts) {
        if (!postsById.has(p.id)) {
          postsById.set(p.id, p);
          count++;
        } else {
          // Merge comment hit data onto existing post
          const existing = postsById.get(p.id);
          existing._commentHits = (existing._commentHits || 0) + (p._commentHits || 0);
        }
      }
    }
  }

  if (sourceFailed) {
    log(`[scan/${sourceLabel}] r/${sub} completed with errors`);
  }
  log(`[scan/${sourceLabel}] r/${sub} found ${count} new posts`);
  return { count, sourceFailed };
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdDiscover(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 10;
  log(`[discover] domain="${domain}", limit=${limit}`);

  const seedQueries = [
    `"${domain}"`, `"${domain} tool"`, `"${domain} software"`,
    `"${domain} app"`, `"${domain} alternative"`,
  ];
  const subredditCounts = {};

  for (const q of seedQueries) {
    log(`[discover] seed query: ${q}`);
    let posts;
    try {
      posts = await searchSubmissions({ q, size: PAGE_SIZE, score: '>3', sort: 'desc', sort_type: 'num_comments' });
    } catch (err) { log(`[discover] failed: ${err.message}`); continue; }
    for (const p of posts) {
      const sub = p.subreddit;
      if (!sub) continue;
      if (!subredditCounts[sub]) subredditCounts[sub] = { seedHits: 0, painHits: 0 };
      subredditCounts[sub].seedHits++;
    }
  }

  const candidates = Object.entries(subredditCounts)
    .sort((a, b) => b[1].seedHits - a[1].seedHits)
    .slice(0, limit + 2);
  log(`[discover] ${candidates.length} candidate subreddits`);

  const painValidationQueries = ['frustrated', 'alternative', 'expensive'];
  for (const [sub, counts] of candidates) {
    for (const pq of painValidationQueries) {
      let posts;
      try { posts = await searchSubmissions({ q: pq, subreddit: sub, size: 1 }); }
      catch { continue; }
      if (posts.length > 0) {
        counts.painHits += 1;
        if ((posts[0].score || 0) > 10) counts.painHits += 1;
      }
    }
  }

  const ranked = candidates
    .map(([name, counts]) => ({ name, seedHits: counts.seedHits, painHits: counts.painHits, score: counts.seedHits * 2 + counts.painHits }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  ok({ domain, subreddits: ranked, api_calls: rateLimiter.count });
}

async function cmdScan(args) {
  const logger = new Logger('reddit-api');
  _scanLogger = logger;

  const subreddits = args.subreddits;
  const domain = args.domain || '';

  // --subreddits is required unless --domain is provided (coordinator mode: global domain search)
  if ((!subreddits || !subreddits.length) && !domain) {
    fail('--subreddits or --domain is required');
  }

  // Check daily usage budget
  const _usage = getUsageTracker();
  const _remaining = _usage.getRemaining('reddit-api');
  if (_remaining.pct >= 80) {
    logger.warn(`daily budget low — ${_remaining.remaining}/${_remaining.limit} requests remaining today`, { remaining: _remaining.remaining, limit: _remaining.limit });
  }
  if (_remaining.remaining <= 0) {
    logger.error('daily budget exhausted. Try again tomorrow.');
    return ok({ source: 'reddit-api', posts: [], stats: { error: 'daily limit reached' } });
  }

  const days = args.days || 180; // default 6 months for fresher results
  const minScore = args.minScore || 1;
  const minComments = args.minComments || 3;
  const limit = args.limit || 30;
  const maxPages = args.maxPages || 20;
  const includeComments = args['include-comments'] || args.includeComments || false;
  const concurrency = args.concurrency || 3;

  // Domain-only mode: no subreddits — search globally using domain-focused queries
  const globalMode = !subreddits || !subreddits.length;

  const after = unixNow() - days * 86400;

  if (globalMode) {
    log(`[scan] global domain mode: domain="${domain}", days=${days}, maxPages=${maxPages}`);
  } else {
    log(`[scan] subreddits=${subreddits.join(',')}, days=${days}, maxPages=${maxPages}, concurrency=${concurrency}`);
  }

  const queries = [];
  if (globalMode) {
    // In global mode, use quoted-phrase queries so APIs match the full domain phrase,
    // preventing false positives from individual words like "management" matching unrelated posts.
    const q = `"${domain}"`;
    queries.push({ q: `${q} frustrated`, category: 'domain' });
    queries.push({ q: `${q} terrible`, category: 'domain' });
    queries.push({ q: `${q} alternative`, category: 'domain' });
    queries.push({ q: `${q} broken`, category: 'domain' });
    queries.push({ q: `${q} hate`, category: 'domain' });
    queries.push({ q: `${q} overpriced`, category: 'domain' });
  } else {
    // Use expanded domain-specific query sets, filtered by active categories
    const activeCategories = args.queryCategories
      ? args.queryCategories.split(',').map(s => s.trim())
      : GENERAL_CATEGORIES;
    log(`[scan] active query categories: ${activeCategories.join(', ')}`);
    for (const cat of activeCategories) {
      if (DOMAIN_SCAN_QUERIES[cat]) {
        for (const q of DOMAIN_SCAN_QUERIES[cat]) queries.push({ q, category: cat });
      }
    }
    // Also include the original SCAN_QUERIES for backwards compatibility
    for (const cat of Object.keys(SCAN_QUERIES)) {
      for (const q of SCAN_QUERIES[cat]) {
        // Avoid duplicates
        if (!queries.find(x => x.q === q)) queries.push({ q, category: cat });
      }
    }
    if (domain) {
      queries.push({ q: `${domain} frustrated`, category: 'domain' });
      queries.push({ q: `${domain} terrible`, category: 'domain' });
      queries.push({ q: `${domain} alternative`, category: 'domain' });
      queries.push({ q: `${domain} bot`, category: 'domain' });
      queries.push({ q: `${domain} scalper`, category: 'domain' });
    }
  }

  const postsById = new Map();
  let queriesRun = 0;
  let arcticShiftFailed = false;
  let pullpushFailed = false;
  let dataSource = 'arctic-shift';

  // ── Strategy 1: Arctic Shift API (primary) ─────────────────────────────────
  try {
    if (globalMode) {
      for (const { q, category } of queries) {
        log(`[scan/arctic-shift] global q=${q} (${category})`);
        queriesRun++;
        let posts;
        try {
          posts = await arcticShiftPaginateSubmissions({
            q, after,
          }, maxPages);
        } catch (err) {
          if (err.statusCode === 403) { arcticShiftFailed = true; break; }
          if (err.statusCode >= 500 || err.message === 'timeout') arcticShiftFailed = true;
          log(`[scan/arctic-shift] failed: ${err.message}`); continue;
        }
        for (const p of posts) {
          if (!postsById.has(p.id)) postsById.set(p.id, p);
        }
      }
    } else {
      const scanOpts = { postsById, after, minScore, maxPages, includeComments, domain, logger, paginateFn: arcticShiftPaginateSubmissions, sourceLabel: 'arctic-shift' };
      for (let i = 0; i < subreddits.length; i += concurrency) {
        const batch = subreddits.slice(i, i + concurrency);
        log(`[scan/arctic-shift] launching batch ${Math.floor(i / concurrency) + 1}: ${batch.map(s => `r/${s}`).join(', ')}`);
        const results = await Promise.allSettled(
          batch.map(sub => scanSubreddit(sub, queries, scanOpts))
        );
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === 'rejected') {
            log(`[scan/arctic-shift] r/${batch[j]} failed: ${result.reason?.message || result.reason}`);
            arcticShiftFailed = true;
          } else if (result.value?.sourceFailed) {
            arcticShiftFailed = true;
          }
        }
      }
    }
  } catch (err) {
    log(`[scan] Arctic Shift error: ${err.message}`);
    arcticShiftFailed = true;
  }

  log(`[scan] Arctic Shift: ${postsById.size} unique posts${arcticShiftFailed ? ' (Arctic Shift had errors)' : ''}`);

  // ── Strategy 2: PullPush API (first fallback) ─────────────────────────────
  if (arcticShiftFailed || postsById.size === 0) {
    log(`[scan] falling back to PullPush API`);
    if (postsById.size > 0) {
      dataSource = 'arctic-shift+pullpush';
    } else {
      dataSource = 'pullpush';
    }

    try {
      if (globalMode) {
        for (const { q, category } of queries) {
          log(`[scan/pullpush] global q=${q} (${category})`);
          queriesRun++;
          let posts;
          try {
            posts = await paginateSubmissions({
              q, score: `>${minScore}`,
              sort: 'desc', sort_type: 'num_comments', after,
            }, maxPages);
          } catch (err) {
            if (err.statusCode === 403) { pullpushFailed = true; break; }
            if (err.statusCode >= 500 || err.message === 'timeout') pullpushFailed = true;
            log(`[scan/pullpush] failed: ${err.message}`); continue;
          }
          for (const p of posts) {
            if (!postsById.has(p.id)) postsById.set(p.id, p);
          }
        }
      } else {
        const scanOpts = { postsById, after, minScore, maxPages, includeComments, domain, logger, paginateFn: paginateSubmissions, sourceLabel: 'pullpush' };
        for (let i = 0; i < subreddits.length; i += concurrency) {
          const batch = subreddits.slice(i, i + concurrency);
          log(`[scan/pullpush] launching batch ${Math.floor(i / concurrency) + 1}: ${batch.map(s => `r/${s}`).join(', ')}`);
          const results = await Promise.allSettled(
            batch.map(sub => scanSubreddit(sub, queries, scanOpts))
          );
          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === 'rejected') {
              log(`[scan/pullpush] r/${batch[j]} failed: ${result.reason?.message || result.reason}`);
              pullpushFailed = true;
            } else if (result.value?.sourceFailed) {
              pullpushFailed = true;
            }
          }
        }
      }
    } catch (err) {
      log(`[scan] PullPush error: ${err.message}`);
      pullpushFailed = true;
    }

    log(`[scan] PullPush: ${postsById.size} unique posts${pullpushFailed ? ' (PullPush had errors)' : ''}`);
  }

  // ── Strategy 3: Reddit OAuth API (second fallback) ────────────────────────
  // Try Reddit OAuth if both Arctic Shift and PullPush failed or returned no results
  if ((arcticShiftFailed && pullpushFailed) || postsById.size === 0) {
    if (hasRedditOAuthCredentials()) {
      log(`[scan] falling back to Reddit OAuth API`);
      if (postsById.size > 0) {
        dataSource = dataSource + '+reddit-oauth';
      } else {
        dataSource = 'reddit-oauth';
      }

      const oauthQueries = queries.slice(0, 10); // Limit queries to stay within rate limits
      for (const { q, category } of oauthQueries) {
        const subs = globalMode ? [null] : subreddits;
        for (const sub of subs) {
          const label = sub ? `r/${sub}` : 'global';
          log(`[scan/reddit-oauth] ${label} q=${q} (${category})`);
          queriesRun++;
          try {
            const posts = await paginateRedditOAuth(q, {
              subreddit: sub || undefined,
              sort: 'relevance',
              maxPages: Math.min(maxPages, 3), // conservative for OAuth
              after,
            });
            for (const p of posts) {
              if (!postsById.has(p.id)) postsById.set(p.id, p);
            }
            log(`[scan/reddit-oauth]   got ${posts.length} posts (${postsById.size} total)`);
          } catch (err) {
            log(`[scan/reddit-oauth]   failed: ${err.message}`);
            if (err.message.includes('HTTP 401') || err.message.includes('HTTP 403')) {
              log('[scan/reddit-oauth] auth error — check REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET');
              break;
            }
          }
        }
      }
      log(`[scan/reddit-oauth] total after OAuth fallback: ${postsById.size} unique posts`);
    } else {
      log(`[scan] Arctic Shift and PullPush failed, no Reddit OAuth credentials found.`);
      log(`[scan] Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET env vars to enable Reddit OAuth fallback.`);
      log(`[scan] Get free credentials at https://www.reddit.com/prefs/apps (script type app).`);
      if (!_redditTipShown) {
        _redditTipShown = true;
        logger.info('tip: set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET as backup — free at reddit.com/prefs/apps');
      }
    }
  }

  log(`[scan] ${postsById.size} unique posts (source: ${dataSource})`);

  // Save ALL raw posts before filtering for LLM batch-evaluation
  try {
    const allRawPosts = [...postsById.values()].map(p => normalizePost(p));
    const rawOutput = { ok: true, data: { source: 'reddit-api', posts: allRawPosts, stats: { raw: true, total: allRawPosts.length } } };
    writeFileSync('/tmp/gapscout-reddit-api-raw.json', JSON.stringify(rawOutput));
    log(`[scan] saved ${allRawPosts.length} raw posts to /tmp/gapscout-reddit-api-raw.json`);
  } catch (err) {
    log(`[scan] failed to save raw posts: ${err.message}`);
  }

  const scored = [];
  for (const rawPost of postsById.values()) {
    if ((rawPost.num_comments || 0) < minComments) continue;
    const post = normalizePost(rawPost);
    // Carry over comment hit metadata if present
    if (rawPost._commentHits) post._commentHits = rawPost._commentHits;
    if (rawPost._matchingComments) post._matchingComments = rawPost._matchingComments;
    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  const warnings = [];
  if (arcticShiftFailed) warnings.push('Arctic Shift API returned errors — fell back to PullPush');
  if (pullpushFailed) warnings.push('PullPush API returned errors — results may be incomplete');
  if (_rateLimitWarning) warnings.push('Rate limits were hit during this scan — results may be incomplete');

  for (const w of warnings) {
    logger.warn(w);
  }

  const _logEvents = logger.export();
  _scanLogger = null;

  ok({
    mode: globalMode ? 'api-global' : 'api',
    posts: scored.slice(0, limit),
    stats: {
      subreddits: globalMode ? 0 : subreddits.length,
      global_mode: globalMode,
      queries_run: queriesRun,
      api_calls: rateLimiter.count + arcticShiftRateLimiter.count,
      raw_posts: postsById.size,
      after_filter: Math.min(scored.length, limit),
      include_comments: includeComments,
      data_source: dataSource,
      rateMonitor: getGlobalRateMonitor().getSourceBreakdown().get('reddit-api') || { warnings: 0, blocks: 0, errors: 0 },
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    _observability: _logEvents,
  });
}

async function cmdDeepDive(args) {
  const postIds = [];
  if (args.post) {
    const id = extractPostId(args.post);
    if (!id) fail(`Cannot parse post ID from: ${args.post}`);
    postIds.push(id);
  } else if (args.fromScan) {
    const fs = await import('node:fs');
    let scanData;
    try { scanData = JSON.parse(fs.readFileSync(args.fromScan, 'utf8')); }
    catch (err) { fail(`Cannot read scan file: ${err.message}`); }
    const posts = scanData?.data?.posts || scanData?.posts || [];
    for (const p of posts.slice(0, args.top || 10)) { if (p.id) postIds.push(p.id); }
  } else if (args.fromStdin) {
    let input = '';
    const { stdin } = await import('node:process');
    for await (const chunk of stdin) input += chunk;
    try {
      const scanData = JSON.parse(input);
      const posts = scanData?.data?.posts || scanData?.posts || [];
      for (const p of posts.slice(0, args.top || 10)) { if (p.id) postIds.push(p.id); }
    } catch (err) { fail(`Cannot parse stdin: ${err.message}`); }
  } else {
    fail('--post <id|url> or --from-scan <file> or --stdin is required');
  }

  const maxComments = args.maxComments || 200;
  log(`[deep-dive] ${postIds.length} post(s), maxComments=${maxComments}`);

  const results = [];
  for (const postId of postIds) {
    log(`[deep-dive] fetching ${postId}`);
    let postMeta = null;
    try {
      const posts = await searchSubmissions({ ids: postId, size: 1 });
      if (posts.length > 0) postMeta = normalizePost(posts[0]);
    } catch (err) { log(`[deep-dive] metadata failed: ${err.message}`); }

    let comments;
    try { comments = await paginateComments(postId, maxComments); }
    catch (err) {
      log(`[deep-dive] comments failed: ${err.message}`);
      results.push({ postId, error: err.message });
      continue;
    }

    const postPainCats = postMeta ? getPostPainCategories(postMeta) : [];
    const normalizedComments = comments.map(c => ({ body: c.body || '', score: c.score || 0 }));
    const analysis = analyzeComments(normalizedComments, postPainCats, postMeta?.url || '');

    results.push({
      post: postMeta ? {
        id: postMeta.id, title: postMeta.title, subreddit: postMeta.subreddit,
        url: postMeta.url, score: postMeta.score, num_comments: postMeta.num_comments,
        painScore: computePainScore(postMeta), selftext_excerpt: excerpt(postMeta.selftext, 300),
      } : { id: postId },
      analysis,
    });
  }

  ok({ mode: 'api', results, api_calls: rateLimiter.count });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'reddit-api',
  description: 'Arctic Shift API + PullPush + Reddit OAuth fallback — historical Reddit data, no browser needed',
  commands: ['discover', 'scan', 'deep-dive'],
  async run(command, args) {
    switch (command) {
      case 'discover': return cmdDiscover(args);
      case 'scan': return cmdScan(args);
      case 'deep-dive': return cmdDeepDive(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
reddit-api source — Arctic Shift API with PullPush + Reddit OAuth fallback

Data sources (tried in order):
  1. Arctic Shift API — high-throughput historical Reddit archive (~2000 req/min)
  2. PullPush API — historical Reddit data archive (fallback)
  3. Reddit OAuth API — official Reddit API (second fallback when both above fail)

Reddit OAuth setup (optional, enables second fallback):
  1. Go to https://www.reddit.com/prefs/apps and create a "script" app
  2. Set environment variables:
       export REDDIT_CLIENT_ID="your_client_id"
       export REDDIT_CLIENT_SECRET="your_client_secret"
  3. Free for non-commercial use (100 requests/min)

Everything works without credentials — Arctic Shift is tried first, then PullPush.
Reddit OAuth is only used as a last resort when both archive APIs fail.

Commands:
  discover   Find relevant subreddits for a domain
  scan       Broad pain-point search across subreddits
  deep-dive  Deep comment analysis for specific posts

discover options:
  --domain <str>        Domain to search (required)
  --limit <n>           Max subreddits (default: 10)

scan options:
  --subreddits <list>   Comma-separated subreddits (required unless --domain is given)
  --domain <str>        Domain for targeted queries; used alone for global Reddit search
  --days <n>            Search last N days (default: 365)
  --minScore <n>        Min post score (default: 1)
  --minComments <n>     Min comments (default: 3)
  --limit <n>           Max posts (default: 30)
  --max-pages <n>       Pages per query (default: 20, was 2)
  --include-comments    Also search comments for matching terms (10-100x more coverage)
  --query-categories <list>  Comma-separated query categories to include
                             (default: frustration,desire,cost,willingness_to_pay,general_scalper)
                             Domain-specific: tickets, sneakers, gpu

deep-dive options:
  --post <id|url>       Single post
  --from-scan <file>    JSON file from scan
  --stdin               Read scan JSON from stdin
  --top <n>             Top N posts (default: 10)
  --maxComments <n>     Max comments per post (default: 200)

Recommended subreddits:
${RECOMMENDED_SUBREDDITS}
`,
};
