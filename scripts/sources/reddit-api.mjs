/**
 * reddit-api.mjs — PullPush API source for pain-point-finder
 */

import https from 'node:https';
import { sleep, log, ok, fail, excerpt, unixNow, daysAgoUnix, utcToDate } from '../lib/utils.mjs';
import {
  SCAN_QUERIES, computePainScore, analyzeComments, enrichPost,
  getPostPainCategories, matchSignals,
} from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PULLPUSH_HOST = 'api.pullpush.io';
const SUBMISSION_PATH = '/reddit/search/submission/';
const COMMENT_PATH = '/reddit/search/comment/';

const MIN_DELAY_MS = 1000;
const JITTER_MS = 200;
const MAX_PER_MIN = 30;
const MAX_PER_RUN = 300;
const REQUEST_TIMEOUT_MS = 15000;

const MAX_RETRIES_429 = 5;
const MAX_RETRIES_5XX = 3;
const MAX_RETRIES_TIMEOUT = 1;
const BACKOFF_BASE_MS = 2000;

const PAGE_SIZE = 100;

// ─── rate limiter ───────────────────────────────────────────────────────────

class RateLimiter {
  constructor() {
    this.timestamps = [];
    this.totalRequests = 0;
    this.lastRequestAt = 0;
  }

  async wait() {
    if (this.totalRequests >= MAX_PER_RUN) {
      throw new Error(`Rate limit: max ${MAX_PER_RUN} requests per run exceeded`);
    }
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60000);
    if (this.timestamps.length >= MAX_PER_MIN) {
      const oldest = this.timestamps[0];
      const waitMs = 60000 - (now - oldest) + 100;
      log(`[rate] per-minute cap hit, sleeping ${waitMs}ms`);
      await sleep(waitMs);
    }
    const elapsed = Date.now() - this.lastRequestAt;
    const minWait = MIN_DELAY_MS + Math.floor(Math.random() * JITTER_MS);
    if (elapsed < minWait) {
      await sleep(minWait - elapsed);
    }
    this.timestamps.push(Date.now());
    this.lastRequestAt = Date.now();
    this.totalRequests++;
  }

  get count() { return this.totalRequests; }
}

const rateLimiter = new RateLimiter();

// ─── HTTP client ────────────────────────────────────────────────────────────

function httpGet(urlPath, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const fullPath = `${urlPath}?${qs.toString()}`;
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: PULLPUSH_HOST,
      path: fullPath,
      headers: { 'User-Agent': 'pain-point-finder/3.0' },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`)); }
        } else {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchWithRetry(urlPath, params) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
    try {
      await rateLimiter.wait();
      return await httpGet(urlPath, params);
    } catch (err) {
      lastErr = err;
      const code = err.statusCode || 0;
      if (code === 403) { log(`[http] 403 blocked`); throw err; }
      let maxForType;
      if (code === 429) maxForType = MAX_RETRIES_429;
      else if (code >= 500) maxForType = MAX_RETRIES_5XX;
      else if (err.message === 'timeout') maxForType = MAX_RETRIES_TIMEOUT;
      else maxForType = 1;
      if (attempt >= maxForType) break;
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      log(`[http] ${err.message} — retry ${attempt + 1} in ${backoff}ms`);
      await sleep(backoff);
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

async function paginateSubmissions(params, maxPages = 1) {
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

function extractPostId(input) {
  const urlMatch = input.match(/\/comments\/([a-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-z0-9]+$/i.test(input)) return input;
  return null;
}

/** Normalize a PullPush post to common shape */
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
  const subreddits = args.subreddits;
  const domain = args.domain || '';

  // --subreddits is required unless --domain is provided (coordinator mode: global domain search)
  if ((!subreddits || !subreddits.length) && !domain) {
    fail('--subreddits or --domain is required');
  }

  const days = args.days || 365;
  const minScore = args.minScore || 1;
  const minComments = args.minComments || 3;
  const limit = args.limit || 30;
  const pages = args.pages || 2;

  // Domain-only mode: no subreddits — search globally using domain-focused queries
  const globalMode = !subreddits || !subreddits.length;

  let effectiveNow;
  try {
    const probe = await searchSubmissions({ size: 1, sort: 'desc', sort_type: 'created_utc' });
    effectiveNow = probe.length > 0 ? Math.floor(probe[0].created_utc) : unixNow();
  } catch { effectiveNow = unixNow(); }
  const after = effectiveNow - days * 86400;

  if (globalMode) {
    log(`[scan] global domain mode: domain="${domain}", days=${days}`);
  } else {
    log(`[scan] subreddits=${subreddits.join(',')}, days=${days}`);
  }

  const queries = [];
  if (globalMode) {
    // In global mode, use quoted-phrase queries so PullPush matches the full domain phrase,
    // preventing false positives from individual words like "management" matching unrelated posts.
    const q = `"${domain}"`;
    queries.push({ q: `${q} frustrated`, category: 'domain' });
    queries.push({ q: `${q} terrible`, category: 'domain' });
    queries.push({ q: `${q} alternative`, category: 'domain' });
    queries.push({ q: `${q} broken`, category: 'domain' });
    queries.push({ q: `${q} hate`, category: 'domain' });
    queries.push({ q: `${q} overpriced`, category: 'domain' });
  } else {
    for (const cat of Object.keys(SCAN_QUERIES)) {
      for (const q of SCAN_QUERIES[cat]) queries.push({ q, category: cat });
    }
    if (domain) {
      queries.push({ q: `${domain} frustrated`, category: 'domain' });
      queries.push({ q: `${domain} terrible`, category: 'domain' });
      queries.push({ q: `${domain} alternative`, category: 'domain' });
    }
  }

  const postsById = new Map();
  let queriesRun = 0;

  if (globalMode) {
    // Global search: no subreddit filter
    for (const { q, category } of queries) {
      log(`[scan] global q=${q} (${category})`);
      queriesRun++;
      let posts;
      try {
        posts = await paginateSubmissions({
          q, score: `>${minScore}`,
          sort: 'desc', sort_type: 'num_comments', after,
        }, pages);
      } catch (err) {
        if (err.statusCode === 403) break;
        log(`[scan] failed: ${err.message}`); continue;
      }
      for (const p of posts) {
        if (!postsById.has(p.id)) postsById.set(p.id, p);
      }
    }
  } else {
    for (const sub of subreddits) {
      for (const { q, category } of queries) {
        log(`[scan] r/${sub} q=${q} (${category})`);
        queriesRun++;
        let posts;
        try {
          posts = await paginateSubmissions({
            q, subreddit: sub, score: `>${minScore}`,
            sort: 'desc', sort_type: 'num_comments', after,
          }, pages);
        } catch (err) {
          if (err.statusCode === 403) break;
          log(`[scan] failed: ${err.message}`); continue;
        }
        for (const p of posts) {
          if (!postsById.has(p.id)) postsById.set(p.id, p);
        }
      }
    }
  }

  log(`[scan] ${postsById.size} unique posts`);

  const scored = [];
  for (const rawPost of postsById.values()) {
    if ((rawPost.num_comments || 0) < minComments) continue;
    const post = normalizePost(rawPost);
    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  scored.sort((a, b) => b.painScore - a.painScore);
  ok({
    mode: globalMode ? 'api-global' : 'api',
    posts: scored.slice(0, limit),
    stats: {
      subreddits: globalMode ? 0 : subreddits.length,
      global_mode: globalMode,
      queries_run: queriesRun,
      api_calls: rateLimiter.count,
      raw_posts: postsById.size,
      after_filter: Math.min(scored.length, limit),
    },
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
    const analysis = analyzeComments(normalizedComments, postPainCats);

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
  description: 'PullPush API — historical Reddit data, no browser needed',
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
reddit-api source — PullPush API

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
  --pages <n>           Pages per query (default: 2)

deep-dive options:
  --post <id|url>       Single post
  --from-scan <file>    JSON file from scan
  --stdin               Read scan JSON from stdin
  --top <n>             Top N posts (default: 10)
  --maxComments <n>     Max comments per post (default: 200)
`,
};
