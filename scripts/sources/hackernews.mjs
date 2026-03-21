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

async function searchHN(query, tags = 'ask_hn') {
  await rateLimit();
  const qs = new URLSearchParams({ query, tags, hitsPerPage: '30' });
  const path = `${SEARCH_PATH}?${qs.toString()}`;
  log(`[hn] search: query="${query}" tags=${tags}`);
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

// ─── commands ────────────────────────────────────────────────────────────────

const PAIN_QUERIES = [
  // Ask HN pain queries — scoped to ask_hn tag
  { fn: (domain) => `${domain} frustrated`, tag: 'ask_hn' },
  { fn: (domain) => `${domain} alternative`, tag: 'ask_hn' },
  { fn: (domain) => `${domain} terrible`, tag: 'ask_hn' },
  { fn: (domain) => `${domain} hate`, tag: 'ask_hn' },
  // Story queries — covers blog posts, launch HN, etc.
  { fn: (domain) => `${domain} broken`, tag: 'story' },
  { fn: (domain) => `${domain} terrible`, tag: 'story' },
  { fn: (domain) => `${domain} hate`, tag: 'story' },
  { fn: (domain) => `${domain} alternative`, tag: 'story' },
];

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 30;
  const minComments = args.minComments || 1;

  log(`[scan] domain="${domain}", limit=${limit}`);

  const postsById = new Map();

  for (const { fn, tag } of PAIN_QUERIES) {
    const query = fn(domain);
    let hits;
    try {
      hits = await searchHN(query, tag);
    } catch (err) {
      log(`[scan] query failed: ${err.message}`);
      continue;
    }
    for (const hit of hits) {
      if (!postsById.has(hit.objectID)) {
        postsById.set(hit.objectID, hit);
      }
    }
  }

  log(`[scan] ${postsById.size} unique posts`);

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const hit of postsById.values()) {
    if ((hit.num_comments || 0) < minComments) continue;
    const post = normalizePost(hit);

    // Hard domain relevance filter: at least one domain word must appear in title+body.
    // HN Algolia returns false positives (posts matching pain words but not the domain)
    // because our queries use pain keywords as the primary signal, not the domain.
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'hackernews',
    posts: scored.slice(0, limit),
    stats: {
      queries_run: PAIN_QUERIES.length,
      raw_posts: postsById.size,
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
    const analysis = analyzeComments(comments, postPainCats);

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
  --domain <str>        Domain to search (required)
  --limit <n>           Max posts to return (default: 30)
  --minComments <n>     Min comments to include a post (default: 1)

deep-dive options:
  --post <id|url>       Single HN story ID or URL (e.g. 12345 or https://news.ycombinator.com/item?id=12345)
  --from-scan <file>    JSON file from scan
  --stdin               Read scan JSON from stdin
  --top <n>             Top N posts from scan (default: 10)
`,
};
