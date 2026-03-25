/**
 * plan.mjs — Scan Plan Generator for gapscout
 *
 * Checks configured tokens and Chrome availability, then calculates
 * expected posts, estimated time, and status for each data source
 * based on the chosen depth preset (regular or deep).
 *
 * Usage:
 *   node scripts/cli.mjs plan --domain "pokemon tcg" --depth regular
 *   node scripts/cli.mjs plan --domain "SaaS billing" --depth deep
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { getUsageTracker } from './lib/usage-tracker.mjs';

// ─── RC file loader ──────────────────────────────────────────────────────────

const RC_PATH = resolve(homedir(), '.pain-pointsrc');

function loadRc() {
  try {
    return JSON.parse(readFileSync(RC_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getTokens(rc) {
  const tokens = (rc && rc.tokens) || {};
  // Merge with env vars (env takes precedence)
  const merged = { ...tokens };
  for (const key of Object.keys(merged)) {
    if (process.env[key]) merged[key] = process.env[key];
  }
  // Also check env vars not in rc
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'STACKEXCHANGE_KEY', 'PRODUCTHUNT_TOKEN', 'SEARXNG_URL']) {
    if (process.env[key] && !merged[key]) merged[key] = process.env[key];
  }
  return merged;
}

// ─── Chrome probe ────────────────────────────────────────────────────────────

function probeChrome(port = 9222) {
  try {
    execSync(`curl -s --connect-timeout 2 http://127.0.0.1:${port}/json/version`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Depth presets ───────────────────────────────────────────────────────────

const DEPTH_PRESETS = {
  regular: {
    reddit:         500,
    hackernews:     500,
    google:         200,
    reviews:        200,
    appstore:       500,
    kickstarter:    100,
    producthunt:    200,
    websearch:       15,  // queries, not posts
    twitter:        100,
    trustpilot:     200,
    stackoverflow:  200,
    ghIssues:       200,
    deepDiveTopN:    10,
  },
  deep: {
    reddit:       10000,
    hackernews:    5000,
    google:         500,
    reviews:       1000,
    appstore:      5000,
    kickstarter:    500,
    producthunt:   2000,
    websearch:       50,  // queries, not posts
    twitter:       1000,
    trustpilot:    2000,
    stackoverflow: 3000,
    ghIssues:      5000,
    deepDiveTopN:    30,
  },
};

// ─── Source definitions ──────────────────────────────────────────────────────

function buildSources(tokens, chromeReady, limits) {
  const hasGithubToken = !!(tokens.GITHUB_TOKEN || tokens.GH_TOKEN);
  const hasStackKey = !!tokens.STACKEXCHANGE_KEY;
  const hasPHToken = !!tokens.PRODUCTHUNT_TOKEN;
  const hasSearxng = !!tokens.SEARXNG_URL;

  return [
    // Reddit (PullPush API — no auth needed)
    // Actual: PAGE_SIZE=100, ~2s per request effective
    {
      name: 'Reddit',
      method: 'API (PullPush)',
      limit: limits.reddit,
      resultsPerRequest: 100,
      delayMs: 2000,
      needsBrowser: false,
      needsToken: false,
      hasToken: true,
      tokenNote: null,
      expectedPostsRatio: [0.6, 1.0],
      maxPerDay: 10000, // rate limited, ~25/page effective, ~2s/req
    },
    // Hacker News (Algolia API — no auth needed)
    // Actual: MIN_DELAY_MS=1200, hitsPerPage=50 (stories), 100 (comments)
    {
      name: 'Hacker News',
      method: 'API (Algolia)',
      limit: limits.hackernews,
      resultsPerRequest: 50,
      delayMs: 1200,
      needsBrowser: false,
      needsToken: false,
      hasToken: true,
      tokenNote: null,
      expectedPostsRatio: [0.4, 1.0],
      maxPerDay: 5000, // 1000 results/query max, date windowing needed
    },
    // Google autocomplete (browser-based, fallback to HTTP API)
    // Actual: SEARCH_DELAY_MS=1200 + JITTER_MS=800 (avg ~1.6s), ~8 suggestions per query
    {
      name: 'Google Autocomplete',
      method: chromeReady ? 'Browser (Chrome)' : 'API (HTTP fallback)',
      limit: limits.google,
      resultsPerRequest: chromeReady ? 8 : 8,
      delayMs: 1600, // avg of 1200 + 800/2 jitter
      needsBrowser: false, // has HTTP API fallback
      needsToken: false,
      hasToken: true,
      tokenNote: chromeReady ? null : 'Chrome not running — using HTTP API fallback (fewer PAA results)',
      expectedPostsRatio: [0.5, 1.0],
      maxPerDay: 500, // browser CAPTCHA risk limits throughput
    },
    // G2/Capterra reviews (browser-based)
    // Actual: PAGE_DELAY_MS=2500 + JITTER_MS=500 (avg ~2.75s), ~10 reviews per page
    {
      name: 'G2/Capterra',
      method: chromeReady ? 'Browser (Chrome)' : 'unavailable',
      limit: limits.reviews,
      resultsPerRequest: 10,
      delayMs: 2750, // avg of 2500 + 500/2 jitter
      needsBrowser: true,
      needsToken: false,
      hasToken: true,
      tokenNote: chromeReady ? null : 'Chrome required for G2/Capterra scraping',
      expectedPostsRatio: [0.2, 0.6],
      maxPerDay: 1000, // browser, anti-bot detection, ~3s/page
    },
    // App Store (npm packages — no browser needed)
    // Actual: google-play-scraper npm, ~50 reviews per app, ~0.1s per batch
    {
      name: 'App Store / Play Store',
      method: 'npm (google-play-scraper)',
      limit: limits.appstore,
      resultsPerRequest: 50,
      delayMs: 100,
      needsBrowser: false,
      needsToken: false,
      hasToken: true,
      tokenNote: null,
      expectedPostsRatio: [0.3, 0.8],
      maxPerDay: 5000, // fast API, up to 150 reviews/call
    },
    // Kickstarter (crowdfunding.mjs, browser-based)
    // Actual: PAGE_DELAY_MS=3000 + JITTER_MS=1000 (avg ~3.5s), per_page=24
    {
      name: 'Kickstarter',
      method: chromeReady ? 'Browser (Chrome)' : 'unavailable',
      limit: limits.kickstarter,
      resultsPerRequest: 24,
      delayMs: 3500, // avg of 3000 + 1000/2 jitter
      needsBrowser: true,
      needsToken: false,
      hasToken: true,
      tokenNote: chromeReady ? null : 'Chrome required for Kickstarter scraping',
      expectedPostsRatio: [0.1, 0.5],
      maxPerDay: 500, // browser, 4s/page, limited project count
    },
    // Product Hunt (API with token, browser fallback)
    // Actual: PAGE_DELAY_MS=1500 + jitterMs=300 (avg ~1.65s), ~20 per page
    {
      name: 'Product Hunt',
      method: hasPHToken ? 'API (GraphQL)' : (chromeReady ? 'Browser (Chrome fallback)' : 'unavailable'),
      limit: limits.producthunt,
      resultsPerRequest: hasPHToken ? 20 : 10,
      delayMs: hasPHToken ? 1650 : 3000,
      needsBrowser: !hasPHToken,
      needsToken: false,
      hasToken: hasPHToken,
      tokenNote: hasPHToken
        ? 'PRODUCTHUNT_TOKEN configured — API mode (450 req/15min)'
        : (chromeReady ? 'No PRODUCTHUNT_TOKEN — using slower browser scraping' : 'Chrome required for browser fallback'),
      expectedPostsRatio: [0.2, 0.7],
      degraded: !hasPHToken && chromeReady,
      maxPerDay: 2000, // 450 req/15min cap
    },
    // Web Search (WebSearch tool — queries, not posts)
    // Actual: SEARCH_DELAY_MS=2500 + JITTER_MS=1500 (avg ~3.25s per query)
    {
      name: 'Web Search',
      method: 'WebSearch (Claude tool)',
      limit: limits.websearch,
      resultsPerRequest: 1,
      delayMs: 3250, // avg of 2500 + 1500/2 jitter
      needsBrowser: false,
      needsToken: false,
      hasToken: true,
      tokenNote: null,
      isQueryBased: true,
      expectedPostsRatio: [5, 10], // per query
      maxPerDay: 500, // ~50 queries × ~10 results/query
    },
    // Twitter (Nitter + browser fallback)
    // Actual: PAGE_DELAY_MS=2500 + JITTER_MS=800 (avg ~2.9s), ~20 tweets per page
    {
      name: 'Twitter',
      method: chromeReady ? 'Browser (Nitter + fallback)' : 'API (Nitter)',
      limit: limits.twitter,
      resultsPerRequest: 20,
      delayMs: 2900, // avg of 2500 + 800/2 jitter
      needsBrowser: false, // Nitter is HTTP-based
      needsToken: false,
      hasToken: true,
      tokenNote: chromeReady ? null : 'Nitter HTTP only — may have reduced availability',
      expectedPostsRatio: [0.3, 0.8],
      maxPerDay: 1000, // Nitter fragile, instances go down
    },
    // Trustpilot (HTTP-based)
    // Actual: PAGE_DELAY_MS=2500 + JITTER_MS=700 (avg ~2.85s), REVIEWS_PER_PAGE=20
    {
      name: 'Trustpilot',
      method: 'HTTP (server-rendered)',
      limit: limits.trustpilot,
      resultsPerRequest: 20,
      delayMs: 2850, // avg of 2500 + 700/2 jitter
      needsBrowser: false, // HTTP primary
      needsToken: false,
      hasToken: true,
      tokenNote: null,
      expectedPostsRatio: [0.3, 0.8],
      maxPerDay: 2000, // 3s/page, Cloudflare risk
    },
    // Stack Overflow (API, optional key)
    // Actual: MIN_DELAY_MS=1000, pageSize=50. Without key: 300 req/day hard cap
    {
      name: 'Stack Overflow',
      method: hasStackKey ? 'API (keyed)' : 'API (unkeyed)',
      limit: limits.stackoverflow,
      resultsPerRequest: 50,
      delayMs: 1000,
      needsBrowser: false,
      needsToken: false,
      hasToken: hasStackKey,
      tokenNote: hasStackKey
        ? 'STACKEXCHANGE_KEY configured — 10K req/day'
        : 'No STACKEXCHANGE_KEY — 300 req/day cap',
      degraded: !hasStackKey,
      rateLimitCap: hasStackKey ? null : { requests: 300, period: 'day' },
      expectedPostsRatio: [0.3, 1.0],
      maxPerDay: hasStackKey ? 10000 : 3000, // keyed: 10K req/day; unkeyed: 300 req × 50/page but throttled
    },
    // GitHub Issues (API, optional token)
    // Actual: MIN_DELAY_MS=500 (auth) / 2000 (unauth), per_page=50. Without token: 60 req/hr cap
    {
      name: 'GitHub Issues',
      method: hasGithubToken ? 'API (authenticated)' : 'API (unauthenticated)',
      limit: limits.ghIssues,
      resultsPerRequest: 50,
      delayMs: hasGithubToken ? 500 : 2000,
      needsBrowser: false,
      needsToken: false,
      hasToken: hasGithubToken,
      tokenNote: hasGithubToken
        ? 'GITHUB_TOKEN configured — 5K req/hr'
        : 'No GITHUB_TOKEN — 60 req/hr cap',
      degraded: !hasGithubToken,
      rateLimitCap: hasGithubToken ? null : { requests: 60, period: 'hour' },
      expectedPostsRatio: [0.3, 1.0],
      maxPerDay: hasGithubToken ? 5000 : 1800, // authed: 5K req/hr; unauthed: 60 req/hr × ~30 results
    },
  ];
}

// ─── Time estimation ─────────────────────────────────────────────────────────

function estimateSeconds(source) {
  if (source.isQueryBased) {
    // Web search: ~5 seconds per query
    return source.limit * (source.delayMs / 1000);
  }

  const requests = Math.ceil(source.limit / source.resultsPerRequest);

  // Factor in rate limit caps
  if (source.rateLimitCap) {
    const { requests: cap, period } = source.rateLimitCap;
    const periodSeconds = period === 'hour' ? 3600 : period === 'day' ? 86400 : 60;
    const secondsPerRequest = periodSeconds / cap;
    const rateLimitTime = requests * secondsPerRequest;
    const normalTime = requests * (source.delayMs / 1000);
    return Math.max(rateLimitTime, normalTime);
  }

  return Math.ceil(requests * (source.delayMs / 1000));
}

// ─── Status determination ────────────────────────────────────────────────────

function getStatus(source, chromeReady) {
  if (source.needsBrowser && !chromeReady) {
    return 'unavailable';
  }
  if (source.degraded) {
    return 'degraded';
  }
  return 'ready';
}

// ─── Main plan function ──────────────────────────────────────────────────────

export async function runPlan(args) {
  const domain = args.domain;
  const depth = args.depth || 'regular';

  if (!domain) {
    process.stderr.write('[plan] Missing --domain. Usage: plan --domain "<domain>" --depth regular|deep\n');
    process.exit(1);
  }

  if (!DEPTH_PRESETS[depth]) {
    process.stderr.write(`[plan] Unknown depth "${depth}". Use "regular" or "deep".\n`);
    process.exit(1);
  }

  const rc = loadRc();
  const tokens = getTokens(rc);
  const chromeReady = probeChrome();
  const limits = DEPTH_PRESETS[depth];
  const sourceDefs = buildSources(tokens, chromeReady, limits);

  // Map plan source names to usage tracker keys
  const PLAN_TO_USAGE_KEY = {
    'Reddit': 'reddit-api',
    'Hacker News': 'hackernews',
    'Google Autocomplete': 'google-autocomplete',
    'G2/Capterra': 'reviews',
    'App Store / Play Store': 'appstore',
    'Kickstarter': 'crowdfunding',
    'Product Hunt': 'producthunt',
    'Web Search': 'websearch',
    'Twitter': 'twitter',
    'Trustpilot': 'trustpilot',
    'Stack Overflow': 'stackoverflow',
    'GitHub Issues': 'github-issues',
  };

  const usageTracker = getUsageTracker();

  const sources = [];
  let totalMinPosts = 0;
  let totalMaxPosts = 0;
  let totalSeconds = 0;
  let readyCount = 0;
  let degradedCount = 0;
  let unavailableCount = 0;

  for (const src of sourceDefs) {
    let status = getStatus(src, chromeReady);
    const estSeconds = status === 'unavailable' ? 0 : estimateSeconds(src);

    let minPosts, maxPosts;
    if (status === 'unavailable') {
      minPosts = 0;
      maxPosts = 0;
    } else if (src.isQueryBased) {
      minPosts = src.limit * src.expectedPostsRatio[0];
      maxPosts = src.limit * src.expectedPostsRatio[1];
    } else {
      minPosts = Math.round(src.limit * src.expectedPostsRatio[0]);
      maxPosts = Math.round(src.limit * src.expectedPostsRatio[1]);
    }

    const expectedPosts = status === 'unavailable' ? '0' : `${minPosts}-${maxPosts}`;

    // Get daily usage data
    const usageKey = PLAN_TO_USAGE_KEY[src.name];
    let usedToday = 0;
    let remainingToday = null;
    let usageNote = null;
    if (usageKey) {
      const rem = usageTracker.getRemaining(usageKey);
      usedToday = rem.used;
      remainingToday = rem.remaining;

      // Override status based on usage
      if (rem.remaining <= 0 && rem.limit !== Infinity && status !== 'unavailable') {
        status = 'unavailable';
        usageNote = 'daily limit exhausted';
      } else if (rem.pct >= 80 && rem.limit !== Infinity && status === 'ready') {
        status = 'degraded';
        usageNote = `daily budget low (${rem.remaining} remaining)`;
      }
    }

    if (status === 'ready') readyCount++;
    else if (status === 'degraded') degradedCount++;
    else unavailableCount++;

    if (status !== 'unavailable') {
      totalMinPosts += minPosts;
      totalMaxPosts += maxPosts;
      totalSeconds += estSeconds;
    }

    const sourceEntry = {
      name: src.name,
      method: src.method,
      limit: src.limit,
      maxPerDay: src.maxPerDay || null,
      expectedPosts: expectedPosts,
      estimatedSeconds: Math.round(estSeconds),
      status,
      notes: usageNote || src.tokenNote || null,
      usedToday,
      remainingToday,
    };

    sources.push(sourceEntry);
  }

  // Deep-dives: estimate ~30 seconds per deep-dive (comment fetching)
  const deepDiveCount = 2; // reddit + HN
  const deepDiveTopN = limits.deepDiveTopN;
  const deepDiveSeconds = deepDiveCount * deepDiveTopN * 30;

  // Synthesis: ~120 seconds for report generation
  const synthesisSeconds = 120;

  const totalEstimatedSeconds = totalSeconds + deepDiveSeconds + synthesisSeconds;

  const result = {
    ok: true,
    data: {
      domain,
      depth,
      timeframe: '180 days',
      sources,
      deepDives: {
        count: deepDiveCount,
        topN: deepDiveTopN,
        estimatedSeconds: deepDiveSeconds,
      },
      synthesis: {
        estimatedSeconds: synthesisSeconds,
      },
      totals: {
        expectedPostsMin: totalMinPosts,
        expectedPostsMax: totalMaxPosts,
        estimatedMinutes: Math.ceil(totalEstimatedSeconds / 60),
        sourcesReady: readyCount,
        sourcesDegraded: degradedCount,
        sourcesUnavailable: unavailableCount,
      },
    },
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
