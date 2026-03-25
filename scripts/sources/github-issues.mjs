/**
 * github-issues.mjs — GitHub Issues source for gapscout
 *
 * Supports two modes:
 *   1. GraphQL mode (default when GITHUB_TOKEN is set)
 *      - Uses GitHub GraphQL API at https://api.github.com/graphql
 *      - Fetches issue title, body, reactions, comments (10), and labels in ONE call
 *      - 5-10x more data per API call vs REST (issue + comments + reactions + labels)
 *      - Requires authentication (GITHUB_TOKEN or GH_TOKEN)
 *      - Rate limit: 5,000 points/hr; delay reduced to 500ms (120 req/min)
 *
 *   2. REST mode (fallback when no token, or forced with --rest)
 *      - Uses GitHub REST Search API
 *      - 60 req/hr unauthenticated, 5,000 req/hr authenticated
 *      - Each call returns only issue metadata (no comments/labels inline)
 *
 * Mode selection:
 *   - GITHUB_TOKEN or GH_TOKEN set → GraphQL (default)
 *   - No token → REST (GraphQL requires auth)
 *   - --rest flag → Force REST mode even with token
 *
 * Usage:
 *   pain-points gh-issues scan --domain "kubernetes"
 *   pain-points github-issues scan --domain "react native" --limit 100
 *   pain-points github-issues scan --domain "react native" --rest   # force REST mode
 *
 *   # With authentication (enables GraphQL mode):
 *   GITHUB_TOKEN=ghp_xxx node scripts/cli.mjs gh-issues scan --domain "kubernetes"
 */

import https from 'node:https';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';
import { RateLimiter, DEFAULT_USER_AGENT } from '../lib/http.mjs';
import { getGlobalRateMonitor } from '../lib/rate-monitor.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const GH_API_HOST = 'api.github.com';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const AUTHENTICATED = Boolean(GH_TOKEN);
const REQUEST_TIMEOUT_MS = 15000;

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;

let _tipShown = false;

if (AUTHENTICATED) {
  log('[github-issues] Authenticated mode (GITHUB_TOKEN detected) — 5,000 requests/hour, GraphQL available');
} else {
  log('[github-issues] Unauthenticated mode — 60 requests/hour (REST only). Set GITHUB_TOKEN or GH_TOKEN for GraphQL mode with 5-10x more data per call.');
  if (!_tipShown) {
    _tipShown = true;
    process.stderr.write('[github-issues] tip: set GITHUB_TOKEN for GraphQL mode (5-10x more data per call) → already set if using gh CLI\n');
  }
}

// ─── rate limiters ──────────────────────────────────────────────────────────

// REST rate limiter: 28 req/min, 2100ms delay
const restRateLimiter = new RateLimiter({ minDelayMs: 2100, maxPerMin: 28, jitterMs: 300 });

// GraphQL rate limiter: 120 req/min, 500ms delay (each call returns 5-10x more data)
const graphqlRateLimiter = new RateLimiter({ minDelayMs: 500, maxPerMin: 120, jitterMs: 100 });

// ─── GraphQL query template ────────────────────────────────────────────────

const GRAPHQL_SEARCH_QUERY = `
query($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on Issue {
        title
        body
        url
        createdAt
        state
        number
        repository {
          nameWithOwner
        }
        reactions {
          totalCount
        }
        comments(first: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
          totalCount
          nodes {
            body
            author { login }
            reactions { totalCount }
            createdAt
          }
        }
        labels(first: 5) {
          nodes { name }
        }
      }
    }
  }
}
`;

// ─── GraphQL API helper ─────────────────────────────────────────────────────

/**
 * POST a GraphQL query to the GitHub GraphQL API.
 * Requires GITHUB_TOKEN — GraphQL is auth-only.
 *
 * Returns { data, rateLimitRemaining, rateLimitLimit, rateLimitReset }.
 */
async function ghGraphQL(query, variables = {}) {
  await graphqlRateLimiter.wait();
  getUsageTracker().increment('github-issues');

  const postBody = JSON.stringify({ query, variables });
  log(`[github-issues:graphql] POST /graphql (variables: ${JSON.stringify(variables).slice(0, 120)})`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GH_API_HOST,
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': `bearer ${GH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'gapscout/5.0',
        'Content-Length': Buffer.byteLength(postBody),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(body);
          const remaining = parseInt(res.headers['x-ratelimit-remaining'] || '0', 10);
          const limit = parseInt(res.headers['x-ratelimit-limit'] || '0', 10);
          const resetEpoch = parseInt(res.headers['x-ratelimit-reset'] || '0', 10);
          const resetDate = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : 'unknown';

          // Log rate limit info when approaching the limit
          if (remaining > 0 && remaining <= 500) {
            rateLimitWarnings++;
            log(`[github-issues:graphql] WARNING: rate limit approaching — ${remaining} requests remaining (limit: ${limit}, resets: ${resetDate})`);
            getGlobalRateMonitor().reportWarning('github-issues', `GraphQL rate limit approaching — ${remaining} remaining (limit: ${limit}, resets: ${resetDate})`, { remaining, limit, resetDate });
          }

          // Handle HTTP-level errors
          if (res.statusCode === 429) {
            rateLimitWarnings++;
            const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
            log(`[github-issues:graphql] WARNING: 429 rate limited, retry after ${retryAfter}s`);
            getGlobalRateMonitor().reportError('github-issues', `GraphQL 429 — rate limited, retry after ${retryAfter}s`, { statusCode: 429, retryAfter });
            const err = new Error(`GitHub GraphQL 429: rate limited — retry after ${retryAfter}s`);
            err.statusCode = 429;
            err.retryAfter = retryAfter;
            reject(err);
            return;
          }

          if (res.statusCode === 403) {
            rateLimitWarnings++;
            const msg = data.message || 'Forbidden';
            log(`[github-issues:graphql] WARNING: 403 — ${msg}`);
            getGlobalRateMonitor().reportError('github-issues', `GraphQL 403 — ${msg}`, { statusCode: 403, remaining, resetDate });
            const err = new Error(`GitHub GraphQL 403: ${msg}`);
            err.statusCode = 403;
            reject(err);
            return;
          }

          if (res.statusCode >= 400) {
            reject(new Error(`GitHub GraphQL ${res.statusCode}: ${data.message || JSON.stringify(data.errors || 'Unknown error')}`));
            return;
          }

          // Handle GraphQL-level errors (HTTP 200 but errors in response)
          if (data.errors && data.errors.length > 0) {
            const errMsgs = data.errors.map(e => e.message).join('; ');
            log(`[github-issues:graphql] GraphQL errors: ${errMsgs}`);
            // If we also have data, log warning but continue (partial success)
            if (!data.data) {
              reject(new Error(`GitHub GraphQL errors: ${errMsgs}`));
              return;
            }
            rateLimitWarnings++;
          }

          resolve({
            data: data.data,
            rateLimitRemaining: remaining,
            rateLimitLimit: limit,
            rateLimitReset: resetDate,
          });
        } catch (err) {
          reject(new Error(`Failed to parse GitHub GraphQL response: ${err.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub GraphQL request timed out')); });
    req.write(postBody);
    req.end();
  });
}

// ─── GraphQL search with pagination ─────────────────────────────────────────

/**
 * Search GitHub issues via GraphQL.
 * Returns up to 50 issues per call, each with inline comments, reactions, and labels.
 * Handles cursor-based pagination via pageInfo.endCursor.
 */
async function searchIssuesGraphQL(query, { maxResults = 200 } = {}) {
  const allNodes = [];
  let after = null;
  let totalCount = 0;
  let rateLimitRemaining = 5000;
  const perPage = 50; // GitHub GraphQL max for search is 100, 50 is safe

  const searchQuery = `${query} type:issue state:open sort:reactions-desc`;

  while (allNodes.length < maxResults) {
    const first = Math.min(perPage, maxResults - allNodes.length);
    let result;
    try {
      result = await ghGraphQL(GRAPHQL_SEARCH_QUERY, {
        query: searchQuery,
        first,
        after,
      });
    } catch (err) {
      log(`[github-issues:graphql] search failed: ${err.message}`);
      // Return what we have so far on rate limit errors
      if (err.statusCode === 429 || err.statusCode === 403) {
        break;
      }
      throw err;
    }

    const search = result.data?.search;
    if (!search) {
      log('[github-issues:graphql] unexpected response — no search field');
      break;
    }

    totalCount = search.issueCount;
    rateLimitRemaining = result.rateLimitRemaining;

    // Filter out null nodes (can happen with deleted issues or non-Issue types)
    const validNodes = (search.nodes || []).filter(n => n && n.title);
    allNodes.push(...validNodes);

    log(`[github-issues:graphql] fetched ${validNodes.length} issues (total so far: ${allNodes.length}, available: ${totalCount}, rate limit: ${rateLimitRemaining})`);

    // Stop if no more pages or we got fewer than requested
    if (!search.pageInfo?.hasNextPage || validNodes.length < first) break;
    after = search.pageInfo.endCursor;

    // Safety check on rate limit
    if (rateLimitRemaining < 10) {
      log(`[github-issues:graphql] rate limit critically low (${rateLimitRemaining}), stopping pagination`);
      rateLimitWarnings++;
      break;
    }
  }

  return { nodes: allNodes, totalCount, rateLimitRemaining };
}

// ─── GraphQL post normalizer ────────────────────────────────────────────────

/**
 * Normalize a GraphQL issue node to GapScout's standard post format.
 * Includes inline comments, labels, and source metadata.
 */
function normalizeGraphQLPost(issue) {
  const repo = issue.repository?.nameWithOwner || '';
  const number = issue.number || 0;

  return {
    id: `gh-${repo}-${number}`,
    title: issue.title || '',
    selftext: issue.body ? issue.body.slice(0, 2000) : '',
    url: issue.url || '',
    score: issue.reactions?.totalCount || 0,
    num_comments: issue.comments?.totalCount || 0,
    created_utc: issue.createdAt ? new Date(issue.createdAt).getTime() / 1000 : 0,
    subreddit: issue.repository?.nameWithOwner || 'github-issues',
    source: 'github-issues',
    _source: 'github-issues-graphql',
    _comments: issue.comments?.nodes || [],
    _labels: (issue.labels?.nodes || []).map(l => l.name),
    // Keep flair compatible with REST normalizer
    flair: repo,
    upvote_ratio: 0,
    reactions: { totalCount: issue.reactions?.totalCount || 0 },
  };
}

// ─── REST API helper (existing, unchanged) ──────────────────────────────────

async function ghApiGet(path) {
  await restRateLimiter.wait();
  getUsageTracker().increment('github-issues');
  log(`[github-issues:rest] GET ${path}`);

  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': 'application/vnd.github.v3+json',
    };
    if (GH_TOKEN) {
      headers['Authorization'] = `Bearer ${GH_TOKEN}`;
    }

    const req = https.get(`https://${GH_API_HOST}${path}`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(body);
          const remaining = parseInt(res.headers['x-ratelimit-remaining'] || '0', 10);
          const limit = parseInt(res.headers['x-ratelimit-limit'] || '0', 10);
          const resetEpoch = parseInt(res.headers['x-ratelimit-reset'] || '0', 10);
          const resetDate = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : 'unknown';

          // Log rate limit info when approaching the limit
          const threshold = AUTHENTICATED ? 500 : 10;
          if (remaining > 0 && remaining <= threshold) {
            rateLimitWarnings++;
            log(`[github-issues:rest] WARNING: rate limit approaching — ${remaining} requests remaining (limit: ${limit}, resets: ${resetDate})`);
            getGlobalRateMonitor().reportWarning('github-issues', `Rate limit approaching — ${remaining} requests remaining (limit: ${limit}, resets: ${resetDate})`, { remaining, limit, resetDate });
          }

          // Handle 429 Too Many Requests — return partial results, don't crash
          if (res.statusCode === 429) {
            rateLimitWarnings++;
            const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
            log(`[github-issues:rest] WARNING: rate limit approaching — 0 requests remaining (429 received, retry after ${retryAfter}s)`);
            getGlobalRateMonitor().reportError('github-issues', `GitHub API 429 — rate limited, retry after ${retryAfter}s`, { statusCode: 429, retryAfter });
            const err = new Error(`GitHub API 429: rate limited — retry after ${retryAfter}s`);
            err.statusCode = 429;
            err.retryAfter = retryAfter;
            reject(err);
            return;
          }

          // Handle 403 — often rate limiting
          if (res.statusCode === 403) {
            rateLimitWarnings++;
            const msg = data.message || 'Forbidden';
            log(`[github-issues:rest] WARNING: rate limit approaching — ${remaining} requests remaining (403: ${msg}, resets: ${resetDate})`);
            getGlobalRateMonitor().reportError('github-issues', `GitHub API 403 — ${msg} (resets: ${resetDate})`, { statusCode: 403, remaining, resetDate });
            const err = new Error(`GitHub API 403: ${msg} (resets at ${resetDate})`);
            err.statusCode = 403;
            reject(err);
            return;
          }

          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data.message || 'Unknown error'}`));
            return;
          }

          resolve({
            data,
            rateLimitRemaining: remaining,
            rateLimitLimit: limit,
            rateLimitReset: resetDate,
          });
        } catch (err) {
          reject(new Error(`Failed to parse GitHub API response: ${err.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API request timed out')); });
  });
}

// ─── REST search (existing, unchanged) ──────────────────────────────────────

/**
 * Search GitHub issues mentioning a domain query via REST API.
 * Sorted by reactions (most +1'd = most validated pain).
 */
async function searchIssues(query, { page = 1, perPage = 50 } = {}) {
  const q = encodeURIComponent(`${query} type:issue state:open`);
  const path = `/search/issues?q=${q}&sort=reactions&order=desc&page=${page}&per_page=${perPage}`;
  const { data, rateLimitRemaining } = await ghApiGet(path);
  return {
    items: data.items || [],
    totalCount: data.total_count || 0,
    rateLimitRemaining,
  };
}

// ─── REST normalizer (existing, unchanged) ──────────────────────────────────

function normalizePost(item) {
  // Extract repo name from repository_url
  const repoName = item.repository_url
    ? item.repository_url.replace('https://api.github.com/repos/', '')
    : '';

  return {
    id: String(item.id),
    title: item.title || '',
    selftext: item.body ? item.body.slice(0, 2000) : '',
    subreddit: 'github-issues',
    url: item.html_url || '',
    score: (item.reactions?.['+1'] || 0) + (item.reactions?.heart || 0),
    num_comments: item.comments || 0,
    upvote_ratio: 0,
    flair: repoName,
    created_utc: item.created_at ? Math.floor(new Date(item.created_at).getTime() / 1000) : 0,
    reactions: item.reactions || {},
  };
}

// ─── query generation ───────────────────────────────────────────────────────

function buildPainQueries(domain) {
  return [
    `${domain} bug`,
    `${domain} broken`,
    `${domain} not working`,
    `${domain} error`,
    `${domain} issue`,
    `${domain} problem`,
    `${domain} crash`,
    `${domain} feature request`,
    `${domain} help wanted`,
    `${domain} workaround`,
    `${domain}`,
  ];
}

// ─── GraphQL scan command ───────────────────────────────────────────────────

/**
 * Scan GitHub issues using GraphQL API.
 * Each call returns issue + 10 comments + reactions + labels (5-10x more data than REST).
 */
async function cmdScanGraphQL(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 50;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  let stoppedEarly = false;

  log(`[github-issues:graphql] scan domain="${domain}", limit=${limit}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('github-issues');
  if (remaining.pct >= 80) {
    log(`[github-issues:graphql] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[github-issues:graphql] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'github-issues', posts: [], stats: { error: 'daily limit reached', mode: 'graphql' } });
  }

  const queries = buildPainQueries(domain);
  const issuesById = new Map();
  let rateLimitRemaining = 5000;

  for (const query of queries) {
    if (stoppedEarly) break;

    if (rateLimitRemaining < 10) {
      log(`[github-issues:graphql] rate limit critically low (${rateLimitRemaining}), stopping early — returning partial results`);
      break;
    }

    // Warn when approaching limit
    if (rateLimitRemaining <= 500 && rateLimitRemaining > 10) {
      log(`[github-issues:graphql] WARNING: rate limit approaching — ${rateLimitRemaining} requests remaining`);
      rateLimitWarnings++;
    }

    let result;
    try {
      // GraphQL fetches 50 issues with comments+reactions+labels per page
      // Max 200 results per query to stay within budget
      result = await searchIssuesGraphQL(query, { maxResults: 200 });
    } catch (err) {
      log(`[github-issues:graphql] query "${query}" failed: ${err.message}`);
      if (err.statusCode === 429) {
        const retryAfter = err.retryAfter || 60;
        log(`[github-issues:graphql] 429 rate limited — backing off ${retryAfter}s, returning partial results`);
        await sleep(retryAfter * 1000);
        stoppedEarly = true;
        rateLimitRemaining = 0;
      }
      if (err.statusCode === 403) {
        log(`[github-issues:graphql] 403 received, stopping — returning partial results`);
        stoppedEarly = true;
        rateLimitRemaining = 0;
      }
      continue;
    }

    rateLimitRemaining = result.rateLimitRemaining;

    for (const node of result.nodes) {
      const key = `${node.repository?.nameWithOwner}-${node.number}`;
      if (!issuesById.has(key)) {
        issuesById.set(key, node);
      }
    }
  }

  log(`[github-issues:graphql] ${issuesById.size} unique issues found`);

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const issue of issuesById.values()) {
    const post = normalizeGraphQLPost(issue);

    // Basic relevance check
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'github-issues';
      enriched._source = 'github-issues-graphql';
      enriched._comments = post._comments;
      enriched._labels = post._labels;

      // Boost score for highly-reacted issues (validated pain)
      const reactions = issue.reactions?.totalCount || 0;
      if (reactions >= 50) enriched.painScore += 3.0;
      else if (reactions >= 20) enriched.painScore += 2.0;
      else if (reactions >= 10) enriched.painScore += 1.0;
      else if (reactions >= 5) enriched.painScore += 0.5;
      enriched.painScore = Math.round(enriched.painScore * 10) / 10;

      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'github-issues',
    posts: scored.slice(0, limit),
    stats: {
      mode: 'graphql',
      queries_run: queries.length,
      raw_issues: issuesById.size,
      after_filter: Math.min(scored.length, limit),
      rate_limit_remaining: rateLimitRemaining,
      rateLimitWarnings,
    },
  });
}

// ─── REST scan command (existing, unchanged) ────────────────────────────────

async function cmdScanREST(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 50;
  const maxPages = args.maxPages || 2;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  let stoppedEarly = false;

  log(`[github-issues:rest] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('github-issues');
  if (remaining.pct >= 80) {
    log(`[github-issues:rest] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[github-issues:rest] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'github-issues', posts: [], stats: { error: 'daily limit reached', mode: 'rest' } });
  }

  const queries = buildPainQueries(domain);
  const issuesById = new Map();
  let rateLimitRemaining = AUTHENTICATED ? 5000 : 60;

  for (const query of queries) {
    if (stoppedEarly) break;

    if (rateLimitRemaining < 5) {
      log(`[github-issues:rest] rate limit critically low (${rateLimitRemaining}), stopping early — returning partial results`);
      break;
    }

    // Warn when approaching limit
    const warnThreshold = AUTHENTICATED ? 500 : 10;
    if (rateLimitRemaining <= warnThreshold && rateLimitRemaining > 5) {
      log(`[github-issues:rest] WARNING: rate limit approaching — ${rateLimitRemaining} requests remaining`);
      rateLimitWarnings++;
    }

    for (let page = 1; page <= maxPages; page++) {
      let result;
      try {
        result = await searchIssues(query, { page, perPage: 50 });
      } catch (err) {
        log(`[github-issues:rest] query "${query}" page ${page} failed: ${err.message}`);
        // On 429, back off and return partial results
        if (err.statusCode === 429) {
          const retryAfter = err.retryAfter || 60;
          log(`[github-issues:rest] 429 rate limited — backing off ${retryAfter}s, returning partial results`);
          await sleep(retryAfter * 1000);
          stoppedEarly = true;
          rateLimitRemaining = 0;
        }
        // On 403, stop but don't crash
        if (err.statusCode === 403) {
          log(`[github-issues:rest] 403 received, stopping — returning partial results`);
          stoppedEarly = true;
          rateLimitRemaining = 0;
        }
        break;
      }

      rateLimitRemaining = result.rateLimitRemaining;
      log(`[github-issues:rest] query="${query}" page=${page}: ${result.items.length} items (rate limit: ${rateLimitRemaining}/${result.rateLimitLimit}, resets: ${result.rateLimitReset})`);

      for (const item of result.items) {
        if (!issuesById.has(item.id)) {
          issuesById.set(item.id, item);
        }
      }

      if (result.items.length < 50) break;
    }
  }

  log(`[github-issues:rest] ${issuesById.size} unique issues found`);

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const item of issuesById.values()) {
    const post = normalizePost(item);

    // Basic relevance check
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'github-issues';
      // Boost score for highly-reacted issues (validated pain)
      const reactions = item.reactions?.['+1'] || 0;
      if (reactions >= 50) enriched.painScore += 3.0;
      else if (reactions >= 20) enriched.painScore += 2.0;
      else if (reactions >= 10) enriched.painScore += 1.0;
      else if (reactions >= 5) enriched.painScore += 0.5;
      enriched.painScore = Math.round(enriched.painScore * 10) / 10;

      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'github-issues',
    posts: scored.slice(0, limit),
    stats: {
      mode: 'rest',
      queries_run: queries.length,
      raw_issues: issuesById.size,
      after_filter: Math.min(scored.length, limit),
      rate_limit_remaining: rateLimitRemaining,
      rateLimitWarnings,
    },
  });
}

// ─── scan command router ────────────────────────────────────────────────────

/**
 * Route scan to GraphQL or REST based on token availability and --rest flag.
 *
 * Mode selection:
 *   - GITHUB_TOKEN set + no --rest flag → GraphQL (5-10x more data per call)
 *   - GITHUB_TOKEN set + --rest flag → REST (forced fallback)
 *   - No token → REST (GraphQL requires auth)
 */
async function cmdScan(args) {
  const forceRest = args.rest || false;
  const useGraphQL = AUTHENTICATED && !forceRest;

  if (useGraphQL) {
    log('[github-issues] Using GraphQL mode (5-10x more data per API call)');
    return cmdScanGraphQL(args);
  } else {
    if (forceRest && AUTHENTICATED) {
      log('[github-issues] REST mode forced via --rest flag (GraphQL available but not used)');
    } else if (!AUTHENTICATED) {
      log('[github-issues] Using REST mode (GraphQL requires GITHUB_TOKEN)');
    }
    return cmdScanREST(args);
  }
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'github-issues',
  description: 'GitHub Issues — REST + GraphQL API, no browser needed',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
github-issues source — GitHub Search API (REST + GraphQL)

Commands:
  scan       Search GitHub issues for pain signals about a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max posts to return (default: 50)
  --max-pages <n>       Max pages per query (default: 2, REST mode only)
  --rest                Force REST mode even when GITHUB_TOKEN is set

API modes:
  GraphQL (default with token):
    - Fetches issue + 10 comments + reactions + labels in ONE call
    - 5-10x more data per API call vs REST
    - 500ms delay between requests (120 req/min)
    - Requires GITHUB_TOKEN or GH_TOKEN

  REST (fallback):
    - Returns issue metadata only (no inline comments/labels)
    - 2100ms delay between requests (28 req/min)
    - Works without authentication (60 req/hr)
    - With token: 5,000 req/hr

Issues with many +1 reactions are boosted as validated pain.

Authentication:
  Set GITHUB_TOKEN or GH_TOKEN environment variable.
  - Without token:  REST mode, 60 requests/hour
  - With token:     GraphQL mode (default), 5,000 points/hour
  Generate a token at https://github.com/settings/tokens

Examples:
  node scripts/cli.mjs gh-issues scan --domain "kubernetes" --limit 100
  GITHUB_TOKEN=ghp_xxx node scripts/cli.mjs gh-issues scan --domain "react native"
  GITHUB_TOKEN=ghp_xxx node scripts/cli.mjs gh-issues scan --domain "react native" --rest
`,
};
