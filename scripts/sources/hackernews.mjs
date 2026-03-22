/**
 * hackernews.mjs — Hacker News source for pain-point-finder
 * Uses the Algolia HN Search API (no browser needed)
 */

import https from 'node:https';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import {
  computePainScore, analyzeComments, enrichPost,
  getPostPainCategories,
} from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const HN_ALGOLIA_HOST = 'hn.algolia.com';
const SEARCH_PATH = '/api/v1/search';
const ITEMS_PATH = '/api/v1/items';

const MIN_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 15000;

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;

// Date windowing: year ranges from 2019 to 2026
const DATE_WINDOWS = [
  { start: new Date('2019-01-01').getTime() / 1000 | 0, end: new Date('2020-01-01').getTime() / 1000 | 0 },
  { start: new Date('2020-01-01').getTime() / 1000 | 0, end: new Date('2021-01-01').getTime() / 1000 | 0 },
  { start: new Date('2021-01-01').getTime() / 1000 | 0, end: new Date('2022-01-01').getTime() / 1000 | 0 },
  { start: new Date('2022-01-01').getTime() / 1000 | 0, end: new Date('2023-01-01').getTime() / 1000 | 0 },
  { start: new Date('2023-01-01').getTime() / 1000 | 0, end: new Date('2024-01-01').getTime() / 1000 | 0 },
  { start: new Date('2024-01-01').getTime() / 1000 | 0, end: new Date('2025-01-01').getTime() / 1000 | 0 },
  { start: new Date('2025-01-01').getTime() / 1000 | 0, end: new Date('2026-01-01').getTime() / 1000 | 0 },
  { start: new Date('2026-01-01').getTime() / 1000 | 0, end: new Date('2027-01-01').getTime() / 1000 | 0 },
];

// ─── HTTP client ─────────────────────────────────────────────────────────────

function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname,
      path,
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

async function fetchWithRetry(hostname, path) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        log(`[http] retry ${attempt} in ${backoff}ms`);
        await sleep(backoff);
      }
      return await httpGet(hostname, path);
    } catch (err) {
      lastErr = err;
      const code = err.statusCode || 0;
      if (code === 403 || code === 404) throw err;
      log(`[http] ${err.message}`);
    }
  }
  throw lastErr;
}

// ─── rate limiter ────────────────────────────────────────────────────────────

let lastRequestAt = 0;

async function rateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

// ─── Algolia HN API helpers ──────────────────────────────────────────────────

/**
 * Search HN posts (stories/ask_hn) with optional pagination and date windowing.
 */
async function searchHN(query, tags = 'ask_hn', { page = 0, hitsPerPage = 50, numericFilters } = {}) {
  await rateLimit();
  const params = { query, tags, hitsPerPage: String(hitsPerPage), page: String(page) };
  if (numericFilters) params.numericFilters = numericFilters;
  const qs = new URLSearchParams(params);
  const path = `${SEARCH_PATH}?${qs.toString()}`;
  log(`[hn] search: query="${query}" tags=${tags} page=${page}${numericFilters ? ' ' + numericFilters : ''}`);
  const result = await fetchWithRetry(HN_ALGOLIA_HOST, path);
  return result?.hits || [];
}

/**
 * Search HN comments with optional pagination and date windowing.
 * Returns comment hits (each has story_id, objectID, comment_text, etc.)
 */
async function searchHNComments(query, { page = 0, hitsPerPage = 100, numericFilters } = {}) {
  await rateLimit();
  const params = { query, tags: 'comment', hitsPerPage: String(hitsPerPage), page: String(page) };
  if (numericFilters) params.numericFilters = numericFilters;
  const qs = new URLSearchParams(params);
  const path = `${SEARCH_PATH}?${qs.toString()}`;
  log(`[hn] comment search: query="${query}" page=${page}${numericFilters ? ' ' + numericFilters : ''}`);
  const result = await fetchWithRetry(HN_ALGOLIA_HOST, path);
  return result?.hits || [];
}

async function fetchItem(itemId) {
  await rateLimit();
  const path = `${ITEMS_PATH}/${itemId}`;
  log(`[hn] fetch item: ${itemId}`);
  return fetchWithRetry(HN_ALGOLIA_HOST, path);
}

// ─── normalizers ─────────────────────────────────────────────────────────────

/** Decode common HTML entities returned by Algolia HN API */
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x2B;/g, '+')
    .replace(/&#x3D;/g, '=');
}

function normalizePost(hit) {
  const isAskHN = (hit.title || '').toLowerCase().startsWith('ask hn');
  return {
    id: hit.objectID,
    title: hit.title || '',
    selftext: decodeHtmlEntities(hit.story_text || ''),
    subreddit: 'hackernews',
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    score: hit.points || 0,
    num_comments: hit.num_comments || 0,
    upvote_ratio: 0,
    flair: isAskHN ? 'ask_hn' : 'story',
    created_utc: hit.created_at_i || 0,
  };
}

/** Recursively flatten nested HN comment children into a flat list.
 *  HN Algolia items API returns points: null for comments — treat as 0.
 *  score is set to 1 (non-zero) so topQuotes threshold of >= 2 doesn't drop them all.
 */
function flattenComments(node) {
  const results = [];
  const children = node.children || [];
  for (const child of children) {
    if (child.type === 'comment' && child.text) {
      results.push({
        body: decodeHtmlEntities(child.text),
        // HN Algolia items API always returns null for comment points.
        // Use 2 so downstream >= 2 score filters include HN comments in topQuotes.
        score: child.points != null ? child.points : 2,
      });
    }
    results.push(...flattenComments(child));
  }
  return results;
}

// ─── query generation ────────────────────────────────────────────────────────

/**
 * Generate 50+ query variations covering domain pain points and sub-domains.
 * Each entry: { fn, tag } where fn(domain) -> query string.
 */
function buildPainQueries(domain) {
  // Core pain patterns for ask_hn
  const askHnPatterns = [
    d => `${d} frustrated`,
    d => `${d} alternative`,
    d => `${d} terrible`,
    d => `${d} hate`,
    d => `${d} problem`,
    d => `${d} annoying`,
    d => `${d} broken`,
    d => `${d} fails`,
    d => `${d} awful`,
    d => `${d} disappointed`,
    d => `${d} scam`,
    d => `${d} ripoff`,
    d => `${d} overpriced`,
    d => `${d} unfair`,
    d => `${d} unethical`,
  ];

  // Story patterns
  const storyPatterns = [
    d => `${d} broken`,
    d => `${d} terrible`,
    d => `${d} hate`,
    d => `${d} alternative`,
    d => `${d} problem`,
    d => `${d} fraud`,
    d => `${d} scam`,
    d => `${d} anti bot`,
    d => `${d} ban`,
    d => `${d} unfair`,
    d => `${d} markup`,
    d => `${d} resale`,
    d => `${d} outrage`,
    d => `${d} disgusting`,
    d => `${d} sold out`,
    d => `${d} price gouge`,
    d => `${d} dynamic pricing`,
    d => `${d} queue`,
    d => `${d} captcha`,
    d => `${d} bot detection`,
  ];

  // Sub-domain / industry-specific terms (added as direct queries)
  const subDomainTerms = [
    'scalper', 'bot', 'ticket scalper', 'sneaker bot', 'GPU scalper',
    'queue unfair', 'resale', 'markup', 'face value',
    'Ticketmaster', 'AXS', 'StubHub', 'SeatGeek', 'DICE', 'SNKRS',
    'checkout bot', 'raffle', 'anti-bot', 'queue fairness', 'captcha',
    'bot detection', 'sold out', 'limited edition', 'drop', 'presale',
    'verified fan', 'dynamic pricing',
  ];

  const queries = [];

  // Ask HN patterns against the user domain
  for (const fn of askHnPatterns) {
    queries.push({ fn, tag: 'ask_hn' });
  }

  // Story patterns against the user domain
  for (const fn of storyPatterns) {
    queries.push({ fn, tag: 'story' });
  }

  // Sub-domain terms as standalone story queries (ignoring domain arg)
  for (const term of subDomainTerms) {
    queries.push({ fn: () => term, tag: 'story' });
  }

  return queries;
}

// ─── paginated search ────────────────────────────────────────────────────────

/**
 * Run a paginated search across multiple pages, collecting unique post hits.
 * Respects maxPages limit.
 */
async function paginatedPostSearch(query, tag, maxPages, postsById) {
  for (let page = 0; page < maxPages; page++) {
    let hits;
    try {
      hits = await searchHN(query, tag, { page, hitsPerPage: 50 });
    } catch (err) {
      log(`[scan] query failed (page ${page}): ${err.message}`);
      break;
    }
    if (!hits.length) break;
    for (const hit of hits) {
      if (!postsById.has(hit.objectID)) {
        postsById.set(hit.objectID, hit);
      }
    }
    // Stop early if fewer hits than expected (last page)
    if (hits.length < 50) break;
  }
}

/**
 * Run a paginated comment search, collecting unique story IDs.
 * Returns a Map of storyId -> { commentTexts: [], storyTitle, storyUrl, created_at_i }
 */
async function paginatedCommentSearch(query, maxPages, commentStoriesById) {
  for (let page = 0; page < maxPages; page++) {
    let hits;
    try {
      hits = await searchHNComments(query, { page, hitsPerPage: 100 });
    } catch (err) {
      log(`[scan] comment query failed (page ${page}): ${err.message}`);
      break;
    }
    if (!hits.length) break;
    for (const hit of hits) {
      const storyId = hit.story_id ? String(hit.story_id) : null;
      if (!storyId) continue;
      if (!commentStoriesById.has(storyId)) {
        commentStoriesById.set(storyId, {
          storyId,
          storyTitle: hit.story_title || '',
          storyUrl: hit.story_url || `https://news.ycombinator.com/item?id=${storyId}`,
          created_at_i: hit.created_at_i || 0,
          commentTexts: [],
        });
      }
      const entry = commentStoriesById.get(storyId);
      if (hit.comment_text) {
        entry.commentTexts.push(decodeHtmlEntities(hit.comment_text));
      }
    }
    if (hits.length < 100) break;
  }
}

/**
 * Run paginated searches with year-by-year date windowing to bypass result limits.
 */
async function paginatedPostSearchWindowed(query, tag, maxPages, postsById) {
  for (const { start, end } of DATE_WINDOWS) {
    const numericFilters = `created_at_i>${start},created_at_i<${end}`;
    for (let page = 0; page < maxPages; page++) {
      let hits;
      try {
        hits = await searchHN(query, tag, { page, hitsPerPage: 50, numericFilters });
      } catch (err) {
        log(`[scan] windowed query failed (page ${page}): ${err.message}`);
        break;
      }
      if (!hits.length) break;
      for (const hit of hits) {
        if (!postsById.has(hit.objectID)) {
          postsById.set(hit.objectID, hit);
        }
      }
      if (hits.length < 50) break;
    }
  }
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 30;
  const minComments = args.minComments || 1;
  const maxPages = args.maxPages || 10;
  const includeComments = args.includeComments === true || args.includeComments === 'true';

  log(`[scan] domain="${domain}", limit=${limit}, maxPages=${maxPages}, includeComments=${includeComments}`);

  const painQueries = buildPainQueries(domain);
  log(`[scan] running ${painQueries.length} query variations`);

  const postsById = new Map();

  // Run paginated searches for all query/tag combinations
  for (const { fn, tag } of painQueries) {
    const query = fn(domain);
    await paginatedPostSearch(query, tag, maxPages, postsById);
  }

  log(`[scan] ${postsById.size} unique posts from story searches`);

  // Comment search: gather story IDs from comment hits, then synthesize pseudo-posts
  let commentStoriesById = new Map();
  let queriesWithComments = 0;

  if (includeComments) {
    // Build comment queries: domain + sub-domain terms
    const commentQueries = [
      domain,
      `${domain} bot`,
      `${domain} scalper`,
      `${domain} unfair`,
      `${domain} resale`,
      `${domain} problem`,
      'ticket scalper', 'sneaker bot', 'GPU scalper', 'checkout bot',
      'Ticketmaster bot', 'StubHub markup', 'AXS queue', 'SNKRS bot',
      'anti-bot', 'captcha bypass', 'queue fairness', 'sold out bot',
      'dynamic pricing unfair', 'verified fan fail', 'presale bot',
      'limited edition bot', 'drop bot', 'resale markup', 'face value',
    ];

    for (const q of commentQueries) {
      await paginatedCommentSearch(q, maxPages, commentStoriesById);
      queriesWithComments++;
    }
    log(`[scan] ${commentStoriesById.size} unique stories referenced in comments`);
  }

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];

  // Score posts from story search
  for (const hit of postsById.values()) {
    if ((hit.num_comments || 0) < minComments) continue;
    const post = normalizePost(hit);

    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  // Score pseudo-posts synthesized from comment search results
  if (includeComments) {
    for (const entry of commentStoriesById.values()) {
      // Skip if story was already captured in story search
      if (postsById.has(entry.storyId)) continue;

      const combinedText = (entry.storyTitle + ' ' + entry.commentTexts.join(' ')).toLowerCase();
      const hasDomainMatch = domainWords.some(w => combinedText.includes(w));
      if (!hasDomainMatch) continue;

      const pseudoPost = {
        id: entry.storyId,
        title: entry.storyTitle || `[Story ${entry.storyId}]`,
        selftext: entry.commentTexts.slice(0, 5).join('\n\n'),
        subreddit: 'hackernews',
        url: entry.storyUrl,
        score: 0,
        num_comments: entry.commentTexts.length,
        upvote_ratio: 0,
        flair: 'comment_match',
        created_utc: entry.created_at_i,
      };

      if (pseudoPost.num_comments < minComments) continue;

      const enriched = enrichPost(pseudoPost, domain);
      if (enriched) scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'hackernews',
    posts: scored.slice(0, limit),
    stats: {
      queries_run: painQueries.length + (includeComments ? queriesWithComments : 0),
      raw_posts: postsById.size,
      comment_stories: commentStoriesById.size,
      after_filter: Math.min(scored.length, limit),
    },
  });
}

async function cmdDeepDive(args) {
  const storyIds = [];

  if (args.post) {
    // Accept story ID or HN URL
    const urlMatch = String(args.post).match(/id=(\d+)/);
    const id = urlMatch ? urlMatch[1] : String(args.post).replace(/\D/g, '');
    if (!id) fail(`Cannot parse story ID from: ${args.post}`);
    storyIds.push(id);
  } else if (args.fromScan) {
    const fs = await import('node:fs');
    let scanData;
    try { scanData = JSON.parse(fs.readFileSync(args.fromScan, 'utf8')); }
    catch (err) { fail(`Cannot read scan file: ${err.message}`); }
    const posts = scanData?.data?.posts || scanData?.posts || [];
    for (const p of posts.slice(0, args.top || 10)) { if (p.id) storyIds.push(String(p.id)); }
  } else if (args.fromStdin) {
    let input = '';
    const { stdin } = await import('node:process');
    for await (const chunk of stdin) input += chunk;
    try {
      const scanData = JSON.parse(input);
      const posts = scanData?.data?.posts || scanData?.posts || [];
      for (const p of posts.slice(0, args.top || 10)) { if (p.id) storyIds.push(String(p.id)); }
    } catch (err) { fail(`Cannot parse stdin: ${err.message}`); }
  } else {
    fail('--post <id|url> or --from-scan <file> or --stdin is required');
  }

  log(`[deep-dive] ${storyIds.length} story(s)`);

  const results = [];

  for (const storyId of storyIds) {
    log(`[deep-dive] fetching story ${storyId}`);
    let item;
    try {
      item = await fetchItem(storyId);
    } catch (err) {
      log(`[deep-dive] failed: ${err.message}`);
      results.push({ storyId, error: err.message });
      continue;
    }

    const comments = flattenComments(item);
    const post = {
      id: String(item.id),
      title: item.title || '',
      selftext: decodeHtmlEntities(item.text || ''),
      subreddit: 'hackernews',
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      score: item.points || 0,
      // Use total flattened comment count (all nesting levels), not just top-level children
      num_comments: comments.length,
      upvote_ratio: 0,
      flair: (item.title || '').toLowerCase().startsWith('ask hn') ? 'ask_hn' : 'story',
      created_utc: item.created_at_i || 0,
    };

    const postPainCats = getPostPainCategories(post);
    const analysis = analyzeComments(comments, postPainCats, post.url || '');

    results.push({
      post: {
        id: post.id,
        title: post.title,
        subreddit: 'hackernews',
        url: post.url,
        score: post.score,
        num_comments: comments.length,
        painScore: computePainScore(post),
        selftext_excerpt: excerpt(post.selftext, 300),
      },
      analysis,
    });
  }

  ok({ source: 'hackernews', results });
}

// ─── source export ───────────────────────────────────────────────────────────

export default {
  name: 'hackernews',
  description: 'Hacker News — Algolia search API, no browser needed',
  commands: ['scan', 'deep-dive'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      case 'deep-dive': return cmdDeepDive(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
hackernews source — Algolia HN Search API

Commands:
  scan       Search HN for pain-point posts related to a domain
  deep-dive  Deep comment analysis for specific HN stories

scan options:
  --domain <str>          Domain to search (required)
  --limit <n>             Max posts to return (default: 30)
  --minComments <n>       Min comments to include a post (default: 1)
  --max-pages <n>         Max pages per query, 1–20 (default: 10)
  --include-comments      Also search HN comments for domain mentions

deep-dive options:
  --post <id|url>         Single HN story ID or URL (e.g. 12345 or https://news.ycombinator.com/item?id=12345)
  --from-scan <file>      JSON file from scan
  --stdin                 Read scan JSON from stdin
  --top <n>               Top N posts from scan (default: 10)
`,
};
