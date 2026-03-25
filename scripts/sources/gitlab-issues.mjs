/**
 * gitlab-issues.mjs — GitLab Issues source for gapscout
 *
 * Uses the GitLab REST API v4 to find open issues mentioning a domain.
 * Issues with many upvotes and comments = validated pain.
 *
 * Authentication is optional:
 *   - Without token: 400 requests/10 min (unauthenticated)
 *   - With GITLAB_TOKEN: 2,000 requests/10 min (5x improvement)
 *
 * Usage:
 *   gapscout gitlab-issues scan --domain "kubernetes"
 *   gapscout gitlab scan --domain "react native" --limit 100
 *
 *   # With authentication (higher rate limits):
 *   GITLAB_TOKEN=glpat-xxx node scripts/cli.mjs gitlab-issues scan --domain "kubernetes"
 */

import https from 'node:https';
import fs from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const GL_API_HOST = 'gitlab.com';
const GL_TOKEN = process.env.GITLAB_TOKEN || '';
const AUTHENTICATED = Boolean(GL_TOKEN);
const MIN_DELAY_MS = AUTHENTICATED ? 300 : 1500; // Auth: 2,000/10min allows faster polling
const REQUEST_TIMEOUT_MS = 15000;
const RAW_DUMP_PATH = '/tmp/gapscout-gitlab-issues-raw.json';

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;

let _tipShown = false;

if (AUTHENTICATED) {
  log('[gitlab-issues] Authenticated mode (GITLAB_TOKEN detected) — 2,000 requests/10 min');
} else {
  log('[gitlab-issues] Unauthenticated mode — 400 requests/10 min. Set GITLAB_TOKEN for 5x higher rate limits.');
  if (!_tipShown) {
    _tipShown = true;
    process.stderr.write('[gitlab-issues] tip: set GITLAB_TOKEN for 5x faster rate limits → free token at https://gitlab.com/-/user_settings/personal_access_tokens\n');
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

// ─── GitLab API helper ──────────────────────────────────────────────────────

async function glApiGet(path) {
  await rateLimit();
  getUsageTracker().increment('gitlab-issues');
  log(`[gitlab-issues] GET ${path}`);

  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'gapscout/1.0',
      'Accept': 'application/json',
    };
    if (GL_TOKEN) {
      headers['PRIVATE-TOKEN'] = GL_TOKEN;
    }

    const req = https.get(`https://${GL_API_HOST}${path}`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(body);
          const remaining = parseInt(res.headers['ratelimit-remaining'] || '0', 10);
          const limit = parseInt(res.headers['ratelimit-limit'] || '0', 10);
          const resetEpoch = parseInt(res.headers['ratelimit-reset'] || '0', 10);
          const resetDate = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : 'unknown';

          // Log rate limit info when approaching the limit
          const threshold = AUTHENTICATED ? 200 : 40;
          if (remaining > 0 && remaining <= threshold) {
            rateLimitWarnings++;
            log(`[gitlab-issues] WARNING: rate limit approaching — ${remaining} requests remaining (limit: ${limit}, resets: ${resetDate})`);
          }

          // Handle 429 Too Many Requests — return partial results, don't crash
          if (res.statusCode === 429) {
            rateLimitWarnings++;
            const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
            log(`[gitlab-issues] WARNING: rate limit approaching — 0 requests remaining (429 received, retry after ${retryAfter}s)`);
            const err = new Error(`GitLab API 429: rate limited — retry after ${retryAfter}s`);
            err.statusCode = 429;
            err.retryAfter = retryAfter;
            reject(err);
            return;
          }

          // Handle 403 — often rate limiting
          if (res.statusCode === 403) {
            rateLimitWarnings++;
            const msg = data.message || data.error || 'Forbidden';
            log(`[gitlab-issues] WARNING: rate limit approaching — ${remaining} requests remaining (403: ${msg}, resets: ${resetDate})`);
            const err = new Error(`GitLab API 403: ${msg} (resets at ${resetDate})`);
            err.statusCode = 403;
            reject(err);
            return;
          }

          if (res.statusCode >= 400) {
            reject(new Error(`GitLab API ${res.statusCode}: ${data.message || data.error || 'Unknown error'}`));
            return;
          }

          resolve({
            data,
            rateLimitRemaining: remaining,
            rateLimitLimit: limit,
            rateLimitReset: resetDate,
          });
        } catch (err) {
          reject(new Error(`Failed to parse GitLab API response: ${err.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitLab API request timed out')); });
  });
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Search GitLab issues mentioning a domain query.
 * Sorted by popularity (upvotes + notes).
 */
async function searchIssues(query, { page = 1, perPage = 100 } = {}) {
  const q = encodeURIComponent(query);
  const path = `/api/v4/issues?search=${q}&state=opened&scope=all&per_page=${perPage}&page=${page}&order_by=popularity`;
  const { data, rateLimitRemaining, rateLimitLimit, rateLimitReset } = await glApiGet(path);
  return {
    items: Array.isArray(data) ? data : [],
    totalCount: Array.isArray(data) ? data.length : 0,
    rateLimitRemaining,
    rateLimitLimit,
    rateLimitReset,
  };
}

// ─── normalizers ────────────────────────────────────────────────────────────

function normalizePost(item) {
  // Extract project path from web_url
  const projectPath = item.web_url
    ? item.web_url.replace(/\/-\/issues\/\d+$/, '').replace('https://gitlab.com/', '')
    : '';

  return {
    id: String(item.iid || item.id),
    title: item.title || '',
    selftext: item.description ? item.description.slice(0, 2000) : '',
    subreddit: 'gitlab-issues',
    url: item.web_url || '',
    score: (item.upvotes || 0) + (item.user_notes_count || 0),
    num_comments: item.user_notes_count || 0,
    upvote_ratio: 0,
    flair: projectPath,
    created_utc: item.created_at ? Math.floor(new Date(item.created_at).getTime() / 1000) : 0,
    upvotes: item.upvotes || 0,
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
  const limit = args.limit || 100;
  const maxPages = args.maxPages || 2;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  let stoppedEarly = false;

  log(`[gitlab-issues] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('gitlab-issues');
  if (remaining.pct >= 80) {
    log(`[gitlab-issues] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[gitlab-issues] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'gitlab-issues', posts: [], stats: { error: 'daily limit reached' } });
  }

  const queries = buildPainQueries(domain);
  const issuesById = new Map();
  let rateLimitRemaining = AUTHENTICATED ? 2000 : 400;

  for (const query of queries) {
    if (stoppedEarly) break;

    if (rateLimitRemaining < 5) {
      log(`[gitlab-issues] rate limit critically low (${rateLimitRemaining}), stopping early — returning partial results`);
      break;
    }

    // Warn when approaching limit
    const warnThreshold = AUTHENTICATED ? 200 : 40;
    if (rateLimitRemaining <= warnThreshold && rateLimitRemaining > 5) {
      log(`[gitlab-issues] WARNING: rate limit approaching — ${rateLimitRemaining} requests remaining`);
      rateLimitWarnings++;
    }

    for (let page = 1; page <= maxPages; page++) {
      let result;
      try {
        result = await searchIssues(query, { page, perPage: 100 });
      } catch (err) {
        log(`[gitlab-issues] query "${query}" page ${page} failed: ${err.message}`);
        // On 429, back off and return partial results
        if (err.statusCode === 429) {
          const retryAfter = err.retryAfter || 60;
          log(`[gitlab-issues] 429 rate limited — backing off ${retryAfter}s, returning partial results`);
          await sleep(retryAfter * 1000);
          stoppedEarly = true;
          rateLimitRemaining = 0;
        }
        // On 403, stop but don't crash
        if (err.statusCode === 403) {
          log(`[gitlab-issues] 403 received, stopping — returning partial results`);
          stoppedEarly = true;
          rateLimitRemaining = 0;
        }
        break;
      }

      rateLimitRemaining = result.rateLimitRemaining;
      log(`[gitlab-issues] query="${query}" page=${page}: ${result.items.length} items (rate limit: ${rateLimitRemaining}/${result.rateLimitLimit}, resets: ${result.rateLimitReset})`);

      for (const item of result.items) {
        const key = item.id || item.iid;
        if (!issuesById.has(key)) {
          issuesById.set(key, item);
        }
      }

      if (result.items.length < 100) break;
    }
  }

  log(`[gitlab-issues] ${issuesById.size} unique issues found`);

  // Save raw data
  try {
    const rawItems = Array.from(issuesById.values());
    fs.writeFileSync(RAW_DUMP_PATH, JSON.stringify(rawItems, null, 2));
    log(`[gitlab-issues] raw data saved to ${RAW_DUMP_PATH}`);
  } catch (err) {
    log(`[gitlab-issues] WARNING: could not save raw data: ${err.message}`);
  }

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
      enriched.source = 'gitlab-issues';
      // Boost score for highly-upvoted issues (validated pain)
      const upvotes = item.upvotes || 0;
      if (upvotes >= 50) enriched.painScore += 3.0;
      else if (upvotes >= 20) enriched.painScore += 2.0;
      else if (upvotes >= 10) enriched.painScore += 1.0;
      else if (upvotes >= 5) enriched.painScore += 0.5;
      enriched.painScore = Math.round(enriched.painScore * 10) / 10;

      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'gitlab-issues',
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
  name: 'gitlab-issues',
  description: 'GitLab Issues — GitLab REST API v4, no browser needed',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
gitlab-issues source — GitLab REST API v4

Commands:
  scan       Search GitLab issues for pain signals about a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max posts to return (default: 100)
  --max-pages <n>       Max pages per query (default: 2)

Issues with many upvotes are boosted as validated pain.

Authentication (optional):
  Set GITLAB_TOKEN environment variable for higher rate limits.
  - Without token:  400 requests/10 min  (delay: 1500ms between requests)
  - With token:     2,000 requests/10 min (delay: 300ms between requests)
  Generate a token at https://gitlab.com/-/user_settings/personal_access_tokens

Examples:
  gapscout gitlab-issues scan --domain "kubernetes" --limit 100
  GITLAB_TOKEN=glpat-xxx node scripts/cli.mjs gitlab scan --domain "react native"
`,
};
