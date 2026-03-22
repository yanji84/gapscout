/**
 * github-issues.mjs — GitHub Issues source for pain-point-finder
 *
 * Uses the GitHub Search API to find open issues mentioning a domain.
 * Issues with many +1 reactions = validated pain.
 *
 * Authentication is optional:
 *   - Without token: 60 requests/hour (unauthenticated)
 *   - With GITHUB_TOKEN or GH_TOKEN: 5,000 requests/hour (83x improvement)
 *
 * Usage:
 *   pain-points gh-issues scan --domain "kubernetes"
 *   pain-points github-issues scan --domain "react native" --limit 100
 *
 *   # With authentication (dramatically higher rate limits):
 *   GITHUB_TOKEN=ghp_xxx node scripts/cli.mjs gh-issues scan --domain "kubernetes"
 */

import https from 'node:https';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const GH_API_HOST = 'api.github.com';
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const AUTHENTICATED = Boolean(GH_TOKEN);
const MIN_DELAY_MS = AUTHENTICATED ? 500 : 2000; // Auth: 5,000/hr allows faster polling
const REQUEST_TIMEOUT_MS = 15000;

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;

let _tipShown = false;

if (AUTHENTICATED) {
  log('[github-issues] Authenticated mode (GITHUB_TOKEN detected) — 5,000 requests/hour');
} else {
  log('[github-issues] Unauthenticated mode — 60 requests/hour. Set GITHUB_TOKEN or GH_TOKEN for 83x higher rate limits.');
  if (!_tipShown) {
    _tipShown = true;
    process.stderr.write('[github-issues] tip: set GITHUB_TOKEN for 83x faster rate limits → already set if using gh CLI\n');
  }
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

// ─── GitHub API helper ──────────────────────────────────────────────────────

async function ghApiGet(path) {
  await rateLimit();
  getUsageTracker().increment('github-issues');
  log(`[github-issues] GET ${path}`);

  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'pain-point-finder/1.0',
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
            log(`[github-issues] WARNING: rate limit approaching — ${remaining} requests remaining (limit: ${limit}, resets: ${resetDate})`);
          }

          // Handle 429 Too Many Requests — return partial results, don't crash
          if (res.statusCode === 429) {
            rateLimitWarnings++;
            const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
            log(`[github-issues] WARNING: rate limit approaching — 0 requests remaining (429 received, retry after ${retryAfter}s)`);
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
            log(`[github-issues] WARNING: rate limit approaching — ${remaining} requests remaining (403: ${msg}, resets: ${resetDate})`);
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

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Search GitHub issues mentioning a domain query.
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

// ─── normalizers ────────────────────────────────────────────────────────────

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

// ─── scan command ───────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 50;
  const maxPages = args.maxPages || 2;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  let stoppedEarly = false;

  log(`[github-issues] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('github-issues');
  if (remaining.pct >= 80) {
    log(`[github-issues] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[github-issues] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'github-issues', posts: [], stats: { error: 'daily limit reached' } });
  }

  const queries = buildPainQueries(domain);
  const issuesById = new Map();
  let rateLimitRemaining = AUTHENTICATED ? 5000 : 60;

  for (const query of queries) {
    if (stoppedEarly) break;

    if (rateLimitRemaining < 5) {
      log(`[github-issues] rate limit critically low (${rateLimitRemaining}), stopping early — returning partial results`);
      break;
    }

    // Warn when approaching limit
    const warnThreshold = AUTHENTICATED ? 500 : 10;
    if (rateLimitRemaining <= warnThreshold && rateLimitRemaining > 5) {
      log(`[github-issues] WARNING: rate limit approaching — ${rateLimitRemaining} requests remaining`);
      rateLimitWarnings++;
    }

    for (let page = 1; page <= maxPages; page++) {
      let result;
      try {
        result = await searchIssues(query, { page, perPage: 50 });
      } catch (err) {
        log(`[github-issues] query "${query}" page ${page} failed: ${err.message}`);
        // On 429, back off and return partial results
        if (err.statusCode === 429) {
          const retryAfter = err.retryAfter || 60;
          log(`[github-issues] 429 rate limited — backing off ${retryAfter}s, returning partial results`);
          await sleep(retryAfter * 1000);
          stoppedEarly = true;
          rateLimitRemaining = 0;
        }
        // On 403, stop but don't crash
        if (err.statusCode === 403) {
          log(`[github-issues] 403 received, stopping — returning partial results`);
          stoppedEarly = true;
          rateLimitRemaining = 0;
        }
        break;
      }

      rateLimitRemaining = result.rateLimitRemaining;
      log(`[github-issues] query="${query}" page=${page}: ${result.items.length} items (rate limit: ${rateLimitRemaining}/${result.rateLimitLimit}, resets: ${result.rateLimitReset})`);

      for (const item of result.items) {
        if (!issuesById.has(item.id)) {
          issuesById.set(item.id, item);
        }
      }

      if (result.items.length < 50) break;
    }
  }

  log(`[github-issues] ${issuesById.size} unique issues found`);

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
      queries_run: queries.length,
      raw_issues: issuesById.size,
      after_filter: Math.min(scored.length, limit),
      rate_limit_remaining: rateLimitRemaining,
      rateLimitWarnings,
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'github-issues',
  description: 'GitHub Issues — GitHub Search API, no browser needed',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
github-issues source — GitHub Search API

Commands:
  scan       Search GitHub issues for pain signals about a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max posts to return (default: 50)
  --max-pages <n>       Max pages per query (default: 2)

Issues with many +1 reactions are boosted as validated pain.

Authentication (optional):
  Set GITHUB_TOKEN or GH_TOKEN environment variable for higher rate limits.
  - Without token:  60 requests/hour  (delay: 2000ms between requests)
  - With token:     5,000 requests/hour (delay: 500ms between requests)
  Generate a token at https://github.com/settings/tokens

Examples:
  node scripts/cli.mjs gh-issues scan --domain "kubernetes" --limit 100
  GITHUB_TOKEN=ghp_xxx node scripts/cli.mjs gh-issues scan --domain "react native"
`,
};
