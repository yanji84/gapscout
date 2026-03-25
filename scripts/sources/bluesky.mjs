/**
 * bluesky.mjs — Bluesky source for gapscout
 *
 * Uses the AT Protocol public API to search Bluesky posts.
 * Public social posts expressing frustration = pain signal.
 *
 * Two modes:
 *   1. Jetstream firehose (default) — streams ALL Bluesky posts in real-time
 *      via WebSocket with client-side keyword filtering. No rate limits.
 *   2. Search API fallback — polls the search API (3,000 req/5min).
 *      Used when --no-stream is passed or Node < 22 (no built-in WebSocket).
 *
 * No auth required for either mode.
 *
 * Usage:
 *   pain-points bluesky scan --domain "project management"
 *   pain-points bsky scan --domain "SaaS billing" --limit 200
 *   pain-points bluesky scan --domain "react" --stream-duration 60
 *   pain-points bluesky scan --domain "react" --no-stream
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGet } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const BSKY_API_HOST = 'public.api.bsky.app';
const MIN_DELAY_MS = 200; // 3,000 req/5min = ~100ms min, use 200ms for safety

const JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post';
const DEFAULT_STREAM_DURATION_S = 30;

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;

// ─── WebSocket availability check ────────────────────────────────────────────

/**
 * Check if the built-in WebSocket constructor is available (Node 22+).
 * Returns the WebSocket class or null.
 */
function getWebSocketClass() {
  if (typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket;
  }
  return null;
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

// ─── Bluesky API helper ────────────────────────────────────────────────────

async function bskyApiGet(path) {
  await rateLimit();
  getUsageTracker().increment('bluesky');
  log(`[bluesky] GET ${path}`);

  try {
    const data = await httpGet(BSKY_API_HOST, path, {
      timeout: 15000,
      headers: { 'User-Agent': 'gapscout/1.0' },
    });
    return data;
  } catch (err) {
    if (err.statusCode === 429) {
      rateLimitWarnings++;
      log(`[bluesky] WARNING: rate limited (429) — backing off`);
    }
    if (err.statusCode === 403) {
      rateLimitWarnings++;
      log(`[bluesky] WARNING: received 403 Forbidden`);
    }
    throw err;
  }
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Search Bluesky posts matching a query.
 * Uses the app.bsky.feed.searchPosts endpoint.
 */
async function searchPosts(query, { limit = 100, cursor = undefined } = {}) {
  const params = new URLSearchParams({
    q: query,
    limit: String(Math.min(limit, 100)),
  });
  if (cursor) {
    params.set('cursor', cursor);
  }
  const path = `/xrpc/app.bsky.feed.searchPosts?${params.toString()}`;
  const data = await bskyApiGet(path);
  return {
    posts: data.posts || [],
    cursor: data.cursor || null,
  };
}

// ─── normalizers ────────────────────────────────────────────────────────────

/**
 * Construct a bsky.app URL from an AT Protocol URI.
 * URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
 */
function uriToUrl(uri, authorHandle) {
  if (!uri) return '';
  const parts = uri.split('/');
  const rkey = parts[parts.length - 1];
  const handle = authorHandle || parts[2] || '';
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

function normalizePost(post) {
  const text = post.record?.text || '';
  const uri = post.uri || '';
  const handle = post.author?.handle || '';
  const createdAt = post.record?.createdAt || '';
  const createdUtc = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : 0;
  const likeCount = post.likeCount || 0;
  const repostCount = post.repostCount || 0;
  const replyCount = post.replyCount || 0;

  return {
    id: uri,
    title: text.length > 100 ? text.slice(0, 100) + '...' : text,
    selftext: text,
    subreddit: 'bluesky',
    url: uriToUrl(uri, handle),
    score: likeCount + repostCount,
    num_comments: replyCount,
    upvote_ratio: 0,
    flair: handle,
    created_utc: createdUtc,
  };
}

// ─── query generation ───────────────────────────────────────────────────────

const PAIN_KEYWORDS = [
  'frustrated', 'broken', 'not working', 'terrible', 'hate',
  'awful', 'bug', 'problem', 'worst', 'alternative',
  'switched from', 'disappointed', 'useless', 'waste of',
];

function buildPainQueries(domain) {
  return [
    ...PAIN_KEYWORDS.map(kw => `${domain} ${kw}`),
    `${domain}`,
  ];
}

// ─── Jetstream firehose ──────────────────────────────────────────────────────

/**
 * Build a keyword set for efficient firehose filtering.
 * Includes domain words and pain keywords for matching.
 */
function buildKeywordMatcher(domain) {
  const domainLower = domain.toLowerCase();
  const domainWords = domainLower.split(/\s+/).filter(w => w.length > 2);

  // The domain phrase itself (for multi-word matching)
  const domainPhrases = [domainLower];

  // Individual domain words for loose matching
  const domainWordSet = new Set(domainWords);

  // Pain keywords to look for alongside domain mentions
  const painKeywordSet = new Set(PAIN_KEYWORDS.map(k => k.toLowerCase()));

  return {
    domainPhrases,
    domainWordSet,
    painKeywordSet,

    /**
     * Check if a post text matches our domain + pain criteria.
     * Returns true if the text mentions the domain AND contains a pain keyword.
     */
    matches(textLower) {
      // Must mention the domain (phrase match or all domain words present)
      const hasDomain = domainPhrases.some(p => textLower.includes(p))
        || (domainWordSet.size > 0 && [...domainWordSet].every(w => textLower.includes(w)));

      if (!hasDomain) return false;

      // Check for pain keywords
      for (const kw of painKeywordSet) {
        if (textLower.includes(kw)) return true;
      }

      // Even without pain keywords, domain match alone is useful (like the last query in buildPainQueries)
      return true;
    },
  };
}

/**
 * Normalize a Jetstream firehose event into GapScout's post format.
 */
function normalizeFirehosePost(did, commit, record) {
  const text = record.text || '';
  const rkey = commit.rkey || '';
  const createdAt = record.createdAt || '';
  const createdUtc = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : 0;

  return {
    id: rkey,
    title: text.length > 100 ? text.slice(0, 100) + '...' : text,
    selftext: text,
    url: `https://bsky.app/profile/${did}/post/${rkey}`,
    score: 0,          // firehose doesn't include engagement counts
    num_comments: 0,
    created_utc: createdUtc,
    subreddit: 'bluesky',
    source: 'bluesky',
    _source: 'bluesky-jetstream',
  };
}

/**
 * Stream posts from the Jetstream firehose with keyword filtering.
 * Resolves with an array of matching normalized posts.
 */
function streamFromJetstream(domain, { limit, durationSeconds }) {
  const WS = getWebSocketClass();
  if (!WS) {
    return Promise.reject(new Error('WebSocket not available'));
  }

  return new Promise((resolve, reject) => {
    const matcher = buildKeywordMatcher(domain);
    const matchedPosts = [];
    let totalProcessed = 0;
    let totalReceived = 0;
    let ws;

    const cleanup = () => {
      try {
        if (ws && ws.readyState !== WS.CLOSED && ws.readyState !== WS.CLOSING) {
          ws.close();
        }
      } catch (_) { /* ignore close errors */ }
    };

    // Timeout: stop after durationSeconds
    const timer = setTimeout(() => {
      log(`[bluesky:jetstream] stream duration reached (${durationSeconds}s), closing`);
      cleanup();
      resolve(matchedPosts);
    }, durationSeconds * 1000);

    try {
      ws = new WS(JETSTREAM_URL);
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`Failed to connect to Jetstream: ${err.message}`));
      return;
    }

    ws.addEventListener('open', () => {
      log(`[bluesky:jetstream] connected — streaming for ${durationSeconds}s (limit=${limit})`);
    });

    ws.addEventListener('message', (event) => {
      totalReceived++;

      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      } catch (_) {
        return; // skip unparseable messages
      }

      // Only process post creation events
      if (msg.kind !== 'commit') return;
      if (!msg.commit || msg.commit.operation !== 'create') return;
      if (msg.commit.collection !== 'app.bsky.feed.post') return;

      const record = msg.commit.record;
      if (!record || !record.text) return;

      // Language filter: only English posts
      const langs = record.langs;
      if (langs && Array.isArray(langs) && langs.length > 0 && !langs.includes('en')) {
        return;
      }

      totalProcessed++;

      // Keyword filter
      const textLower = record.text.toLowerCase();
      if (!matcher.matches(textLower)) return;

      // Skip very short posts (low signal)
      if (record.text.length < 20) return;

      const post = normalizeFirehosePost(msg.did, msg.commit, record);
      matchedPosts.push(post);

      if (totalProcessed % 10000 === 0) {
        log(`[bluesky:jetstream] processed ${totalProcessed} posts, ${matchedPosts.length} matches so far`);
      }

      // Stop if we've hit the limit
      if (matchedPosts.length >= limit) {
        log(`[bluesky:jetstream] reached limit of ${limit} matching posts`);
        clearTimeout(timer);
        cleanup();
        resolve(matchedPosts);
      }
    });

    ws.addEventListener('error', (err) => {
      log(`[bluesky:jetstream] WebSocket error: ${err.message || 'unknown error'}`);
      // Don't reject immediately — we may have partial results
    });

    ws.addEventListener('close', (event) => {
      clearTimeout(timer);
      log(`[bluesky:jetstream] connection closed (code=${event.code}, received=${totalReceived}, processed=${totalProcessed}, matched=${matchedPosts.length})`);
      // Resolve with whatever we've collected
      resolve(matchedPosts);
    });
  });
}

// ─── scan command (search API) ──────────────────────────────────────────────

async function cmdScanSearchAPI(args) {
  const domain = args.domain;
  const limit = args.limit || 200;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  let stoppedEarly = false;

  log(`[bluesky] scan (search API) domain="${domain}", limit=${limit}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('bluesky');
  if (remaining.pct >= 80) {
    log(`[bluesky] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[bluesky] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'bluesky', posts: [], stats: { error: 'daily limit reached' } });
  }

  const queries = buildPainQueries(domain);
  const postsById = new Map();

  for (const query of queries) {
    if (stoppedEarly) break;

    let result;
    try {
      result = await searchPosts(query, { limit: 100 });
    } catch (err) {
      log(`[bluesky] query "${query}" failed: ${err.message}`);
      if (err.statusCode === 429) {
        log(`[bluesky] backing off due to 429, returning partial results`);
        await sleep(10000);
        stoppedEarly = true;
      }
      if (err.statusCode === 403) {
        log(`[bluesky] stopping due to 403, returning partial results`);
        stoppedEarly = true;
      }
      continue;
    }

    log(`[bluesky] query="${query}": ${result.posts.length} posts`);

    for (const post of result.posts) {
      const id = post.uri;
      if (id && !postsById.has(id)) {
        postsById.set(id, post);
      }
    }
  }

  log(`[bluesky] ${postsById.size} unique posts found`);

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const post of postsById.values()) {
    const normalized = normalizePost(post);

    // Basic relevance check
    const fullText = ((normalized.title || '') + ' ' + (normalized.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    // Skip very short posts (low signal)
    if (!normalized.selftext || normalized.selftext.length < 20) continue;

    const enriched = enrichPost(normalized, domain);
    if (enriched) {
      enriched.source = 'bluesky';
      // Boost highly-engaged posts (validated pain)
      const engagement = (post.likeCount || 0) + (post.repostCount || 0);
      if (engagement >= 100) enriched.painScore += 2.0;
      else if (engagement >= 50) enriched.painScore += 1.5;
      else if (engagement >= 20) enriched.painScore += 1.0;
      else if (engagement >= 10) enriched.painScore += 0.5;
      enriched.painScore = Math.round(enriched.painScore * 10) / 10;

      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'bluesky',
    posts: scored.slice(0, limit),
    stats: {
      queries_run: queries.length,
      raw_posts: postsById.size,
      after_filter: Math.min(scored.length, limit),
      rateLimitWarnings,
      mode: 'search-api',
    },
  });
}

// ─── scan command (Jetstream firehose) ──────────────────────────────────────

async function cmdScanJetstream(args) {
  const domain = args.domain;
  const limit = args.limit || 200;
  const durationSeconds = args['stream-duration'] || args.streamDuration || DEFAULT_STREAM_DURATION_S;

  log(`[bluesky:jetstream] scan domain="${domain}", limit=${limit}, duration=${durationSeconds}s`);

  let rawPosts;
  try {
    rawPosts = await streamFromJetstream(domain, { limit, durationSeconds });
  } catch (err) {
    log(`[bluesky:jetstream] stream failed: ${err.message}`);
    log(`[bluesky:jetstream] falling back to search API`);
    return cmdScanSearchAPI(args);
  }

  log(`[bluesky:jetstream] ${rawPosts.length} matching posts collected`);

  // Build domain word set for relevance filtering (second pass)
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const normalized of rawPosts) {
    // Additional relevance check
    const fullText = ((normalized.title || '') + ' ' + (normalized.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(normalized, domain);
    if (enriched) {
      enriched.source = 'bluesky';
      enriched._source = 'bluesky-jetstream';
      // No engagement boost for firehose (we don't have engagement data)
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'bluesky',
    posts: scored.slice(0, limit),
    stats: {
      raw_posts: rawPosts.length,
      after_filter: Math.min(scored.length, limit),
      stream_duration_s: durationSeconds,
      mode: 'jetstream',
    },
  });
}

// ─── scan command (router) ──────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');

  const forceNoStream = args['no-stream'] || args.noStream || false;

  // Decide which mode to use
  if (forceNoStream) {
    log('[bluesky] --no-stream flag set, using search API');
    return cmdScanSearchAPI(args);
  }

  const WS = getWebSocketClass();
  if (!WS) {
    log('[bluesky] WARNING: Built-in WebSocket not available (requires Node 22+). Falling back to search API.');
    return cmdScanSearchAPI(args);
  }

  // Default: use Jetstream firehose
  log('[bluesky] Using Jetstream firehose mode (use --no-stream to force search API)');
  return cmdScanJetstream(args);
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'bluesky',
  description: 'Bluesky — AT Protocol public API + Jetstream firehose',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
bluesky source — AT Protocol public API + Jetstream firehose

Commands:
  scan       Search Bluesky posts for pain signals about a domain

scan options:
  --domain <str>              Topic/product to search for (required)
  --limit <n>                 Max posts to return (default: 200)
  --stream-duration <seconds> How long to stream from firehose (default: 30)
  --no-stream                 Force search API mode instead of firehose

Modes:
  Jetstream (default):  Streams ALL Bluesky posts in real-time via WebSocket.
                        No rate limits. Requires Node 22+ for built-in WebSocket.
                        Posts are filtered client-side by domain keywords.
  Search API:           Polls the AT Protocol search API (3,000 req/5min).
                        Used automatically if Node < 22 or --no-stream is set.

No API key required for either mode.

Examples:
  node scripts/cli.mjs bluesky scan --domain "project management" --limit 200
  node scripts/cli.mjs bsky scan --domain "react native" --stream-duration 60
  node scripts/cli.mjs bluesky scan --domain "SaaS billing" --no-stream
  node scripts/cli.mjs bluesky scan --domain "react" --limit 50 --stream-duration 120
`,
};
