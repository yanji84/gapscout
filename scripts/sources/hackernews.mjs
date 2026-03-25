/**
 * hackernews.mjs — Hacker News source for gapscout
 * Uses the Algolia HN Search API (no browser needed)
 */

import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import {
  computePainScore, analyzeComments, enrichPost,
  getPostPainCategories,
} from '../lib/scoring.mjs';
import { httpGet, httpGetWithRetry, RateLimiter } from '../lib/http.mjs';
import { getGlobalRateMonitor } from '../lib/rate-monitor.mjs';
import { Logger } from '../lib/logger.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const HN_ALGOLIA_HOST = 'hn.algolia.com';
const SEARCH_PATH = '/api/v1/search';
const ITEMS_PATH = '/api/v1/items';

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;

// Module-level logger reference so helper functions can emit events
let _scanLogger = null;

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

// ─── HTTP client (uses shared lib/http.mjs) ──────────────────────────────────

async function fetchWithRetry(hostname, path) {
  try {
    return await httpGetWithRetry(hostname, path, { maxRetries: 3, rateLimiter });
  } catch (err) {
    const code = err.statusCode || 0;
    if (code === 429) {
      rateLimitWarnings++;
      _scanLogger?.warn('rate limit — received 429 Too Many Requests', { statusCode: 429 });
      getGlobalRateMonitor().reportError('hackernews', 'Algolia HN API 429 — Too Many Requests', { statusCode: 429 });
      // Back off heavily on 429, then return null to allow partial results
      await sleep(10000);
      return null;
    }
    if (code === 403) {
      rateLimitWarnings++;
      _scanLogger?.warn('received 403 Forbidden — possible rate limit or IP block', { statusCode: 403 });
      getGlobalRateMonitor().reportBlock('hackernews', 'Algolia HN API 403 — possible rate limit or IP block', { statusCode: 403 });
      return null;
    }
    throw err;
  }
}

// ─── rate limiter ────────────────────────────────────────────────────────────

const rateLimiter = new RateLimiter({ minDelayMs: 1200, maxPerMin: 45, jitterMs: 200 });

// ─── Algolia HN API helpers ──────────────────────────────────────────────────

/**
 * Search HN posts (stories/ask_hn) with optional pagination and date windowing.
 */
async function searchHN(query, tags = 'ask_hn', { page = 0, hitsPerPage = 50, numericFilters } = {}) {
  await rateLimiter.wait();
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
  await rateLimiter.wait();
  const params = { query, tags: 'comment', hitsPerPage: String(hitsPerPage), page: String(page) };
  if (numericFilters) params.numericFilters = numericFilters;
  const qs = new URLSearchParams(params);
  const path = `${SEARCH_PATH}?${qs.toString()}`;
  log(`[hn] comment search: query="${query}" page=${page}${numericFilters ? ' ' + numericFilters : ''}`);
  const result = await fetchWithRetry(HN_ALGOLIA_HOST, path);
  return result?.hits || [];
}

async function fetchItem(itemId) {
  await rateLimiter.wait();
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
  const logger = new Logger('hackernews');
  _scanLogger = logger;

  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 30;
  const minComments = args.minComments || 1;
  const maxPages = args.maxPages || 10;
  const includeComments = args.includeComments === true || args.includeComments === 'true';

  // Reset per-scan counters
  rateLimitWarnings = 0;

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

  // Save ALL raw posts before filtering for LLM batch-evaluation
  try {
    const allRawPosts = [...postsById.values()].map(hit => normalizePost(hit));
    // Also include comment-search pseudo-posts if includeComments
    if (includeComments) {
      for (const entry of commentStoriesById.values()) {
        if (!postsById.has(entry.storyId)) {
          allRawPosts.push({
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
          });
        }
      }
    }
    const rawOutput = { ok: true, data: { source: 'hackernews', posts: allRawPosts, stats: { raw: true, total: allRawPosts.length } } };
    writeFileSync('/tmp/gapscout-hn-raw.json', JSON.stringify(rawOutput));
    log(`[scan] saved ${allRawPosts.length} raw posts to /tmp/gapscout-hn-raw.json`);
  } catch (err) {
    log(`[scan] failed to save raw posts: ${err.message}`);
  }

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

  if (rateLimitWarnings > 0) {
    logger.warn(`scan completed with ${rateLimitWarnings} rate limit warning(s)`, { rateLimitWarnings });
  }

  const _logEvents = logger.export();
  _scanLogger = null;

  ok({
    source: 'hackernews',
    posts: scored.slice(0, limit),
    stats: {
      queries_run: painQueries.length + (includeComments ? queriesWithComments : 0),
      raw_posts: postsById.size,
      comment_stories: commentStoriesById.size,
      after_filter: Math.min(scored.length, limit),
      totalRequests: rateLimiter.count,
      rateLimitWarnings,
      rateMonitor: getGlobalRateMonitor().getSourceBreakdown().get('hackernews') || { warnings: 0, blocks: 0, errors: 0 },
    },
    _observability: _logEvents,
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

// ─── frontpage command ───────────────────────────────────────────────────────

const HN_FIREBASE_HOST = 'hacker-news.firebaseio.com';

function firebaseGet(path) {
  return httpGet(HN_FIREBASE_HOST, path);
}

/**
 * Extract domain from a URL string, stripping www. prefix.
 */
function extractDomain(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Classify a story into broad topic categories based on title keywords.
 */
function classifyTopics(title) {
  const t = (title || '').toLowerCase();
  const topics = [];

  const topicKeywords = {
    'AI / ML': ['ai', 'llm', 'gpt', 'machine learning', 'deep learning', 'neural', 'transformer', 'openai', 'anthropic', 'chatgpt', 'claude', 'gemini', 'diffusion', 'generative'],
    'DevTools / Infrastructure': ['api', 'sdk', 'framework', 'docker', 'kubernetes', 'k8s', 'ci/cd', 'devops', 'terraform', 'aws', 'cloud', 'serverless', 'database', 'postgres', 'redis', 'git', 'ide', 'compiler', 'rust', 'go ', 'golang', 'python', 'typescript', 'javascript'],
    'Security / Privacy': ['security', 'vulnerability', 'hack', 'breach', 'encryption', 'privacy', 'surveillance', 'vpn', 'malware', 'ransomware', 'zero-day', 'exploit', 'auth', 'oauth'],
    'Startup / Business': ['startup', 'founder', 'yc ', 'y combinator', 'fundrais', 'series a', 'revenue', 'saas', 'bootstrap', 'acquisition', 'ipo', 'valuation', 'pivot'],
    'Hardware / Electronics': ['chip', 'semiconductor', 'cpu', 'gpu', 'fpga', 'arduino', 'raspberry pi', 'hardware', 'sensor', 'pcb', 'risc-v', 'arm'],
    'Web / Frontend': ['css', 'html', 'react', 'vue', 'svelte', 'nextjs', 'browser', 'dom', 'web', 'frontend', 'responsive'],
    'Data / Analytics': ['data', 'analytics', 'metrics', 'dashboard', 'etl', 'warehouse', 'bigquery', 'snowflake', 'dbt', 'visualization'],
    'Crypto / Web3': ['crypto', 'bitcoin', 'ethereum', 'blockchain', 'nft', 'defi', 'web3', 'token'],
    'Health / Biotech': ['health', 'medical', 'biotech', 'pharma', 'drug', 'fda', 'clinical', 'genomic', 'crispr', 'longevity'],
    'Productivity / Tools': ['productivity', 'note', 'calendar', 'email', 'workflow', 'automation', 'no-code', 'low-code', 'zapier', 'notion'],
    'Open Source': ['open source', 'open-source', 'oss', 'foss', 'mit license', 'gpl', 'apache license'],
    'Hiring / Careers': ['hiring', 'job', 'career', 'interview', 'resume', 'salary', 'remote work', 'layoff'],
    'Regulation / Policy': ['regulation', 'antitrust', 'gdpr', 'eu ', 'fcc', 'copyright', 'patent', 'lawsuit', 'ban'],
    'Show HN / Launch': ['show hn'],
    'Ask HN': ['ask hn'],
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(kw => t.includes(kw))) {
      topics.push(topic);
    }
  }

  if (topics.length === 0) topics.push('General / Other');
  return topics;
}

/**
 * Analyze frontpage stories and produce niche/domain suggestions.
 */
function analyzeFrontpage(stories) {
  // Count topics, domains, and gather story metadata
  const topicCounts = {};
  const domainCounts = {};
  const topicStories = {};
  const domainStories = {};

  for (const story of stories) {
    const topics = classifyTopics(story.title);
    const domain = extractDomain(story.url);

    for (const topic of topics) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      if (!topicStories[topic]) topicStories[topic] = [];
      topicStories[topic].push({
        id: story.id,
        title: story.title,
        score: story.score || 0,
        comments: story.descendants || 0,
        url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
      });
    }

    if (domain) {
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      if (!domainStories[domain]) domainStories[domain] = [];
      domainStories[domain].push({
        id: story.id,
        title: story.title,
        score: story.score || 0,
        comments: story.descendants || 0,
      });
    }
  }

  // Compute engagement-weighted topic scores
  const topicScores = {};
  for (const [topic, storyList] of Object.entries(topicStories)) {
    const totalScore = storyList.reduce((s, st) => s + st.score, 0);
    const totalComments = storyList.reduce((s, st) => s + st.comments, 0);
    const count = storyList.length;
    // Weight: count * 10 + avg_score + avg_comments * 2
    const avgScore = count > 0 ? totalScore / count : 0;
    const avgComments = count > 0 ? totalComments / count : 0;
    topicScores[topic] = {
      count,
      totalScore,
      totalComments,
      avgScore: Math.round(avgScore),
      avgComments: Math.round(avgComments),
      relevanceScore: Math.round(count * 10 + avgScore + avgComments * 2),
      topStories: storyList.sort((a, b) => b.score - a.score).slice(0, 5),
    };
  }

  // Sort topics by relevance score
  const rankedTopics = Object.entries(topicScores)
    .map(([topic, data]) => ({ topic, ...data }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Identify multi-appearance domains (signals trending companies/products)
  const trendingDomains = Object.entries(domainCounts)
    .filter(([, count]) => count >= 2)
    .map(([domain, count]) => ({
      domain,
      count,
      stories: domainStories[domain].sort((a, b) => b.score - a.score),
    }))
    .sort((a, b) => b.count - a.count);

  // Generate niche suggestions with reasoning
  const suggestions = rankedTopics
    .filter(t => t.topic !== 'General / Other')
    .map((t, i) => {
      const highEngagement = t.avgComments > 50;
      const highVolume = t.count >= 3;
      const reasoning = [];

      if (highVolume) reasoning.push(`${t.count} stories on frontpage right now`);
      else reasoning.push(`${t.count} story/stories on frontpage`);

      if (highEngagement) reasoning.push(`high discussion (avg ${t.avgComments} comments)`);
      if (t.avgScore > 100) reasoning.push(`strong upvotes (avg ${t.avgScore} points)`);

      reasoning.push(`top story: "${t.topStories[0]?.title}"`);

      return {
        rank: i + 1,
        niche: t.topic,
        storyCount: t.count,
        avgScore: t.avgScore,
        avgComments: t.avgComments,
        relevanceScore: t.relevanceScore,
        reasoning: reasoning.join('; '),
        sampleStories: t.topStories.slice(0, 3).map(s => ({
          title: s.title,
          hnUrl: `https://news.ycombinator.com/item?id=${s.id}`,
          score: s.score,
          comments: s.comments,
        })),
      };
    });

  return { suggestions, trendingDomains };
}

async function cmdFrontpage(args) {
  const limit = args.limit || 30; // how many top stories to fetch
  const topN = args.top || 10;    // how many niche suggestions to return

  log(`[frontpage] fetching top ${limit} HN stories via Firebase API`);

  // 1. Get top story IDs
  await rateLimiter.wait();
  let storyIds;
  try {
    storyIds = await firebaseGet('/v0/topstories.json');
  } catch (err) {
    fail(`Failed to fetch HN top stories: ${err.message}`);
  }

  if (!Array.isArray(storyIds) || storyIds.length === 0) {
    fail('No stories returned from HN API');
  }

  storyIds = storyIds.slice(0, limit);
  log(`[frontpage] fetching details for ${storyIds.length} stories`);

  // 2. Fetch each story's details
  const stories = [];
  // Batch fetch with rate limiting
  for (const id of storyIds) {
    await rateLimiter.wait();
    try {
      const story = await firebaseGet(`/v0/item/${id}.json`);
      if (story && story.type === 'story') {
        stories.push(story);
      }
    } catch (err) {
      log(`[frontpage] failed to fetch story ${id}: ${err.message}`);
    }
  }

  log(`[frontpage] fetched ${stories.length} stories, analyzing`);

  // 3. Analyze and rank
  const { suggestions, trendingDomains } = analyzeFrontpage(stories);

  ok({
    source: 'hackernews-frontpage',
    fetchedAt: new Date().toISOString(),
    storiesAnalyzed: stories.length,
    suggestions: suggestions.slice(0, topN),
    trendingDomains: trendingDomains.slice(0, 10),
    allStories: stories.map(s => ({
      id: s.id,
      title: s.title,
      url: s.url || null,
      hnUrl: `https://news.ycombinator.com/item?id=${s.id}`,
      score: s.score || 0,
      comments: s.descendants || 0,
      domain: extractDomain(s.url),
      topics: classifyTopics(s.title),
    })),
  });
}

// ─── source export ───────────────────────────────────────────────────────────

export default {
  name: 'hackernews',
  description: 'Hacker News — Algolia search API, no browser needed',
  commands: ['scan', 'deep-dive', 'frontpage'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      case 'deep-dive': return cmdDeepDive(args);
      case 'frontpage': return cmdFrontpage(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
hackernews source — Algolia HN Search API

Commands:
  scan       Search HN for pain-point posts related to a domain
  deep-dive  Deep comment analysis for specific HN stories
  frontpage  Scan HN front page to suggest trending domains/niches

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

frontpage options:
  --limit <n>             Number of top stories to analyze (default: 30)
  --top <n>               Number of niche suggestions to return (default: 10)
`,
};
