/**
 * github-issues.mjs — GitHub Issues source for pain-point-finder
 *
 * Uses the GitHub Search API to find open issues mentioning a domain.
 * Issues with many +1 reactions = validated pain.
 * No auth required for basic search (60 requests/hour).
 *
 * Usage:
 *   pain-points gh-issues scan --domain "kubernetes"
 *   pain-points github-issues scan --domain "react native" --limit 100
 */

import https from 'node:https';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const GH_API_HOST = 'api.github.com';
const MIN_DELAY_MS = 2000; // Be conservative with GitHub's rate limits
const REQUEST_TIMEOUT_MS = 15000;

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
  log(`[github-issues] GET ${path}`);

  return new Promise((resolve, reject) => {
    const req = https.get(`https://${GH_API_HOST}${path}`, {
      headers: {
        'User-Agent': 'pain-point-finder/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(body);

          if (res.statusCode === 403) {
            const rateLimitReset = res.headers['x-ratelimit-reset'];
            const msg = data.message || 'Rate limited';
            reject(new Error(`GitHub API 403: ${msg} (resets at ${rateLimitReset})`));
            return;
          }

          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data.message || 'Unknown error'}`));
            return;
          }

          resolve({
            data,
            rateLimitRemaining: parseInt(res.headers['x-ratelimit-remaining'] || '0', 10),
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

  log(`[github-issues] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}`);

  const queries = buildPainQueries(domain);
  const issuesById = new Map();
  let rateLimitRemaining = 60;

  for (const query of queries) {
    if (rateLimitRemaining < 5) {
      log(`[github-issues] rate limit low (${rateLimitRemaining}), stopping early`);
      break;
    }

    for (let page = 1; page <= maxPages; page++) {
      let result;
      try {
        result = await searchIssues(query, { page, perPage: 50 });
      } catch (err) {
        log(`[github-issues] query "${query}" page ${page} failed: ${err.message}`);
        if (err.message.includes('403')) {
          log(`[github-issues] rate limited, stopping all queries`);
          rateLimitRemaining = 0;
        }
        break;
      }

      rateLimitRemaining = result.rateLimitRemaining;
      log(`[github-issues] query="${query}" page=${page}: ${result.items.length} items (rate limit: ${rateLimitRemaining})`);

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
No authentication required (60 requests/hour rate limit).

Examples:
  node scripts/cli.mjs gh-issues scan --domain "kubernetes" --limit 100
  node scripts/cli.mjs github-issues scan --domain "react native" --limit 50
`,
};
