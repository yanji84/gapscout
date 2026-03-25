/**
 * package-stats.mjs — npm/PyPI package stats source for gapscout
 *
 * A UNIQUE source type: finds competitive intelligence through package
 * popularity trends rather than complaints.
 *
 * APIs used (all unauthenticated, no tokens needed):
 *   - npm search:     https://registry.npmjs.org/-/v1/search?text={query}&size=20
 *   - npm downloads:  https://api.npmjs.org/downloads/range/last-month/{package}
 *   - PyPI stats:     https://pypistats.org/api/packages/{package}/recent
 *   - PyPI search:    https://pypi.org/search/?q={query}  (HTML)
 *
 * Usage:
 *   gapscout package-stats scan --domain "state management"
 *   gapscout npm scan --domain "bundler" --limit 20
 *   gapscout pypi scan --domain "machine learning" --limit 10
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const MIN_DELAY_NPM_MS = 200;   // npm is generous with rate limits
const MIN_DELAY_PYPI_MS = 250;  // pypistats: ~5 req/sec
const REQUEST_TIMEOUT_MS = 15000;
const RAW_DUMP_PATH = '/tmp/gapscout-package-stats-raw.json';

// ─── rate limiter ────────────────────────────────────────────────────────────

let lastNpmRequestAt = 0;
let lastPypiRequestAt = 0;

async function rateLimitNpm() {
  const elapsed = Date.now() - lastNpmRequestAt;
  if (elapsed < MIN_DELAY_NPM_MS) {
    await sleep(MIN_DELAY_NPM_MS - elapsed);
  }
  lastNpmRequestAt = Date.now();
}

async function rateLimitPypi() {
  const elapsed = Date.now() - lastPypiRequestAt;
  if (elapsed < MIN_DELAY_PYPI_MS) {
    await sleep(MIN_DELAY_PYPI_MS - elapsed);
  }
  lastPypiRequestAt = Date.now();
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'gapscout/1.0', 'Accept': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}: ${url}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve({ body, statusCode: res.statusCode, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)); });
  });
}

function httpsGetJson(url) {
  return httpsGet(url).then(({ body }) => JSON.parse(body));
}

// ─── npm API ─────────────────────────────────────────────────────────────────

/**
 * Search npm registry for packages matching a query.
 */
async function npmSearch(query, size = 20) {
  await rateLimitNpm();
  getUsageTracker().increment('package-stats');
  const q = encodeURIComponent(query);
  const url = `https://registry.npmjs.org/-/v1/search?text=${q}&size=${size}`;
  log(`[package-stats] npm search: ${url}`);

  try {
    const data = await httpsGetJson(url);
    return (data.objects || []).map(obj => ({
      name: obj.package.name,
      description: obj.package.description || '',
      version: obj.package.version || '',
      url: `https://www.npmjs.com/package/${obj.package.name}`,
      registry: 'npm',
    }));
  } catch (err) {
    log(`[package-stats] npm search failed: ${err.message}`);
    return [];
  }
}

/**
 * Get npm download stats for a package over the last month.
 * Returns { downloads: [{day, downloads}], total, start, end }
 */
async function npmDownloads(packageName) {
  await rateLimitNpm();
  getUsageTracker().increment('package-stats');
  const url = `https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(packageName)}`;
  log(`[package-stats] npm downloads: ${url}`);

  try {
    const data = await httpsGetJson(url);
    const days = data.downloads || [];
    const total = days.reduce((sum, d) => sum + (d.downloads || 0), 0);

    // Calculate trend: compare first half vs second half of the month
    const mid = Math.floor(days.length / 2);
    const firstHalf = days.slice(0, mid).reduce((s, d) => s + (d.downloads || 0), 0);
    const secondHalf = days.slice(mid).reduce((s, d) => s + (d.downloads || 0), 0);
    const trendPct = firstHalf > 0
      ? Math.round(((secondHalf - firstHalf) / firstHalf) * 100)
      : 0;

    // Weekly average
    const weeks = Math.max(1, days.length / 7);
    const weeklyDownloads = Math.round(total / weeks);

    return {
      total,
      weeklyDownloads,
      trendPct,
      days,
      start: data.start,
      end: data.end,
    };
  } catch (err) {
    log(`[package-stats] npm downloads failed for ${packageName}: ${err.message}`);
    return null;
  }
}

// ─── PyPI API ────────────────────────────────────────────────────────────────

/**
 * Search PyPI for packages by scraping search results page.
 * Returns a list of { name, description, url, registry }.
 */
async function pypiSearch(query, limit = 20) {
  await rateLimitPypi();
  getUsageTracker().increment('package-stats');
  const q = encodeURIComponent(query);
  const url = `https://pypi.org/search/?q=${q}`;
  log(`[package-stats] pypi search: ${url}`);

  try {
    const { body } = await httpsGet(url);
    const results = [];

    // Parse package names from HTML search results
    // Pattern: <a class="package-snippet" href="/project/NAME/">
    const snippetRegex = /class="package-snippet"[^>]*href="\/project\/([^/]+)\/"/g;
    const descRegex = /class="package-snippet__description"[^>]*>([^<]*)<\/p>/g;

    let match;
    const names = [];
    while ((match = snippetRegex.exec(body)) !== null && names.length < limit) {
      names.push(match[1]);
    }

    const descriptions = [];
    while ((match = descRegex.exec(body)) !== null) {
      descriptions.push(match[1].trim());
    }

    for (let i = 0; i < names.length; i++) {
      results.push({
        name: names[i],
        description: descriptions[i] || '',
        version: '',
        url: `https://pypi.org/project/${names[i]}/`,
        registry: 'pypi',
      });
    }

    return results;
  } catch (err) {
    log(`[package-stats] pypi search failed: ${err.message}`);
    return [];
  }
}

/**
 * Get PyPI download stats for a package (recent downloads).
 */
async function pypiDownloads(packageName) {
  await rateLimitPypi();
  getUsageTracker().increment('package-stats');
  const url = `https://pypistats.org/api/packages/${encodeURIComponent(packageName)}/recent`;
  log(`[package-stats] pypi downloads: ${url}`);

  try {
    const data = await httpsGetJson(url);
    const lastDay = data.data?.last_day || 0;
    const lastWeek = data.data?.last_week || 0;
    const lastMonth = data.data?.last_month || 0;

    // Trend: compare daily average of last week vs projected from last month
    const weeklyAvgDaily = lastWeek / 7;
    const monthlyAvgDaily = lastMonth / 30;
    const trendPct = monthlyAvgDaily > 0
      ? Math.round(((weeklyAvgDaily - monthlyAvgDaily) / monthlyAvgDaily) * 100)
      : 0;

    return {
      total: lastMonth,
      weeklyDownloads: lastWeek,
      trendPct,
      lastDay,
      lastWeek,
      lastMonth,
    };
  } catch (err) {
    log(`[package-stats] pypi downloads failed for ${packageName}: ${err.message}`);
    return null;
  }
}

// ─── normalizers ────────────────────────────────────────────────────────────

function normalizePackage(pkg, stats) {
  const monthlyDownloads = stats ? stats.total : 0;
  const weeklyDownloads = stats ? stats.weeklyDownloads : 0;
  const trendPct = stats ? stats.trendPct : 0;
  const trendDir = trendPct > 0 ? 'up' : trendPct < 0 ? 'down' : 'flat';

  return {
    id: pkg.name,
    title: `${pkg.name} — ${pkg.description || 'No description'}`,
    selftext: `${monthlyDownloads.toLocaleString()} downloads/month, trending ${trendDir} ${Math.abs(trendPct)}%. Registry: ${pkg.registry}.`,
    subreddit: 'package-stats',
    url: pkg.url,
    score: monthlyDownloads,
    num_comments: 0,
    upvote_ratio: 0,
    flair: pkg.registry,
    created_utc: 0,
    source: 'package-stats',
    metadata: {
      weeklyDownloads,
      monthlyDownloads,
      trend: trendPct,
      registry: pkg.registry,
    },
  };
}

// ─── scan command ───────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 20;

  log(`[package-stats] scan domain="${domain}", limit=${limit}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('package-stats');
  if (remaining.pct >= 80) {
    log(`[package-stats] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[package-stats] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'package-stats', posts: [], stats: { error: 'daily limit reached' } });
  }

  // Search both registries in parallel
  log(`[package-stats] searching npm and PyPI for "${domain}"...`);
  const [npmResults, pypiResults] = await Promise.all([
    npmSearch(domain, limit),
    pypiSearch(domain, limit),
  ]);

  log(`[package-stats] found ${npmResults.length} npm packages, ${pypiResults.length} PyPI packages`);

  // Combine and deduplicate by name
  const allPackages = [];
  const seen = new Set();

  for (const pkg of [...npmResults, ...pypiResults]) {
    if (!seen.has(pkg.name)) {
      seen.add(pkg.name);
      allPackages.push(pkg);
    }
  }

  // Limit to top packages before fetching stats
  const topPackages = allPackages.slice(0, limit);

  // Fetch download stats for each package
  log(`[package-stats] fetching download stats for ${topPackages.length} packages...`);
  const results = [];
  const rawData = [];

  for (const pkg of topPackages) {
    let stats = null;
    try {
      if (pkg.registry === 'npm') {
        stats = await npmDownloads(pkg.name);
      } else if (pkg.registry === 'pypi') {
        stats = await pypiDownloads(pkg.name);
      }
    } catch (err) {
      log(`[package-stats] failed to get stats for ${pkg.name}: ${err.message}`);
    }

    rawData.push({ package: pkg, stats });
    const normalized = normalizePackage(pkg, stats);
    results.push(normalized);
  }

  // Save raw data
  try {
    fs.writeFileSync(RAW_DUMP_PATH, JSON.stringify(rawData, null, 2));
    log(`[package-stats] raw data saved to ${RAW_DUMP_PATH}`);
  } catch (err) {
    log(`[package-stats] WARNING: could not save raw data: ${err.message}`);
  }

  // Sort by monthly downloads (score)
  results.sort((a, b) => b.score - a.score);

  const finalResults = results.slice(0, limit);

  ok({
    source: 'package-stats',
    posts: finalResults,
    stats: {
      npm_packages: npmResults.length,
      pypi_packages: pypiResults.length,
      total_with_stats: results.length,
      returned: finalResults.length,
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'package-stats',
  description: 'npm/PyPI Package Stats — competitive intelligence through download trends',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
package-stats source — npm/PyPI download stats & trends

Commands:
  scan       Search npm + PyPI for packages and get download trends

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max packages to return (default: 20)

This is a COMPETITIVE INTELLIGENCE source. Instead of finding complaints,
it finds package popularity trends to understand market dynamics.

For each package found, it fetches monthly download stats and calculates
a trend (comparing recent vs older download periods).

APIs used (all free, no authentication needed):
  - npm registry search + download counts
  - PyPI search + pypistats.org download stats

Output format:
  Each result includes metadata: { weeklyDownloads, monthlyDownloads, trend }
  The "score" field is set to monthly downloads for easy sorting.

Examples:
  gapscout package-stats scan --domain "state management" --limit 20
  node scripts/cli.mjs npm scan --domain "bundler"
  node scripts/cli.mjs pypi scan --domain "machine learning" --limit 10
`,
};
