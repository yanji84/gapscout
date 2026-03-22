#!/usr/bin/env node

/**
 * monitor.mjs — Continuous pain point monitoring with delta detection
 *
 * Usage:
 *   pain-points monitor --config domains.json --once
 *   pain-points monitor --config domains.json --interval 6h
 *   pain-points monitor --config domains.json --domain scalper-bot --once
 *
 * Storage structure:
 *   reports/
 *     {domain-name}/
 *       scans/
 *         {source}-{timestamp}.json     Raw scan results
 *       reports/
 *         {timestamp}-report.md         Synthesis reports
 *         {timestamp}-report.json
 *       deltas/
 *         {timestamp}-delta.json        What changed since last scan
 *       history.json                    Pain score timeline
 *       latest-report.md               Copy of most recent report
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { log } from './lib/utils.mjs';
import { resolveSourceName } from './lib/command-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, 'cli.mjs');

// ─── config loading ──────────────────────────────────────────────────────────

function loadConfig(configPath) {
  try {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log(`[monitor] Cannot load config ${configPath}: ${err.message}`);
    process.exit(1);
  }
}

// ─── directory helpers ───────────────────────────────────────────────────────

function ensureDirs(baseDir, domainName) {
  const domainDir = join(baseDir, domainName);
  const dirs = [
    domainDir,
    join(domainDir, 'scans'),
    join(domainDir, 'reports'),
    join(domainDir, 'deltas'),
  ];
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  return domainDir;
}

function writeJSON(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ─── timestamp helpers ───────────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString();
}

function nowFilestamp() {
  // e.g. 2026-03-21T18-00-00Z — safe for filenames
  return nowISO().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

// ─── spawn helper ────────────────────────────────────────────────────────────

/**
 * Spawn a pain-points CLI command, capture stdout, return parsed JSON.
 * Returns { ok, data, rawStdout, error }.
 */
function spawnSource(cliArgs, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const args = [CLI_PATH, ...cliArgs];
    log(`[monitor] spawn: node ${args.slice(1, 5).join(' ')} ...`);

    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (code) => {
      // Forward stderr as prefixed log lines
      if (stderr.trim()) {
        for (const line of stderr.trim().split('\n')) {
          log(`    ${line}`);
        }
      }

      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        const snippet = stdout.trim().slice(0, 200);
        resolve({
          ok: false,
          data: null,
          rawStdout: stdout,
          error: `JSON parse failed (exit ${code}): ${snippet}`,
        });
        return;
      }

      resolve({
        ok: parsed.ok !== false,
        data: parsed.data || parsed,
        rawStdout: stdout,
        error: parsed.ok === false ? (parsed.error?.message || 'source error') : null,
      });
    });

    child.on('error', (err) => {
      resolve({ ok: false, data: null, rawStdout: '', error: err.message });
    });
  });
}

// ─── source runner ───────────────────────────────────────────────────────────

/**
 * Map a domains.json source key to the CLI source name.
 * e.g. "api" -> "reddit-api", "hn" -> "hackernews"
 */
function resolveSourceAlias(name) {
  return resolveSourceName(name);
}

/**
 * Build CLI args for a single source scan given domain config.
 */
function buildSourceArgs(sourceName, sourceConfig, domainConfig) {
  const resolved = resolveSourceAlias(sourceName);
  const args = [resolved, 'scan', '--domain', domainConfig.domain];

  // Reddit subreddits
  if (sourceConfig.subreddits) {
    args.push('--subreddits', sourceConfig.subreddits.join(','));
  }

  // Google depth
  if (sourceConfig.depth !== undefined) {
    args.push('--depth', String(sourceConfig.depth));
  }

  // Trustpilot companies
  if (sourceConfig.companies) {
    args.push('--companies', sourceConfig.companies.join(','));
  }

  // App store apps
  if (sourceConfig.apps) {
    args.push('--apps', sourceConfig.apps.join(','));
  }

  // Generic limit/days passthrough
  if (sourceConfig.limit) args.push('--limit', String(sourceConfig.limit));
  if (sourceConfig.days)  args.push('--days', String(sourceConfig.days));

  return args;
}

/**
 * Run all configured sources for a domain.
 * Returns array of { sourceName, cliArgs, result, timestamp }.
 */
async function runDomainSources(domainConfig) {
  const sources = domainConfig.sources || {};
  const results = [];

  // Run sources in parallel
  const tasks = Object.entries(sources).map(async ([sourceName, sourceConfig]) => {
    const cliArgs = buildSourceArgs(sourceName, sourceConfig || {}, domainConfig);
    const ts = nowISO();
    log(`[monitor] [${domainConfig.name}] running source: ${sourceName}`);
    const result = await spawnSource(cliArgs);
    if (!result.ok) {
      log(`[monitor] [${domainConfig.name}] source ${sourceName} failed: ${result.error}`);
    } else {
      const postCount = result.data?.posts?.length ?? 0;
      log(`[monitor] [${domainConfig.name}] source ${sourceName}: ${postCount} posts`);
    }
    return { sourceName, cliArgs, result, timestamp: ts };
  });

  const settled = await Promise.all(tasks);
  results.push(...settled);
  return results;
}

// ─── delta detection ─────────────────────────────────────────────────────────

/**
 * Extract a pain category summary from a posts array.
 * Returns { [subcategory]: { painScore, posts, wtp, postIds } }
 */
function extractCategoryMap(posts) {
  const cats = {};
  for (const post of (posts || [])) {
    const subcats = post.subcategories || post.painSubcategories || [];
    const score = post.painScore || 0;
    const wtp = post.wtpSignals || 0;
    const id = post.id || post.url || post.title;

    if (subcats.length === 0) {
      // Uncategorized bucket
      const key = 'uncategorized';
      if (!cats[key]) cats[key] = { painScore: 0, posts: 0, wtp: 0, postIds: [] };
      cats[key].painScore += score;
      cats[key].posts += 1;
      cats[key].wtp += wtp;
      if (id) cats[key].postIds.push(id);
    } else {
      for (const cat of subcats) {
        if (!cats[cat]) cats[cat] = { painScore: 0, posts: 0, wtp: 0, postIds: [] };
        cats[cat].painScore += score;
        cats[cat].posts += 1;
        cats[cat].wtp += wtp;
        if (id) cats[cat].postIds.push(id);
      }
    }
  }
  return cats;
}

/**
 * Extract solution attempts from posts.
 * Returns array of normalized solution strings.
 */
function extractSolutions(posts) {
  const solutions = new Set();
  for (const post of (posts || [])) {
    for (const s of (post.solutionAttempts || [])) {
      if (typeof s === 'string') solutions.add(s.toLowerCase().trim());
      else if (s?.text) solutions.add(s.text.toLowerCase().trim());
    }
  }
  return [...solutions];
}

/**
 * Compare current scan posts to previous scan posts and generate a delta.
 */
function computeDelta(domainName, currentPosts, previousPosts, currentTs, previousTs) {
  const current = extractCategoryMap(currentPosts);
  const previous = extractCategoryMap(previousPosts);

  const currentSolutions = extractSolutions(currentPosts);
  const previousSolutions = extractSolutions(previousPosts);

  const newPains = [];
  const rising = [];
  const fading = [];
  const resolved = [];
  const newSolutions = [];

  // Check all current categories
  for (const [cat, curr] of Object.entries(current)) {
    if (!previous[cat]) {
      newPains.push({
        category: cat,
        painScore: curr.painScore,
        posts: curr.posts,
        wtp: curr.wtp,
        postIds: curr.postIds,
      });
    } else {
      const prev = previous[cat];
      const scoreDelta = curr.painScore - prev.painScore;
      const postsDelta = curr.posts - prev.posts;
      if (scoreDelta > 0 || postsDelta > 0) {
        rising.push({
          category: cat,
          painScore: curr.painScore,
          prevPainScore: prev.painScore,
          scoreDelta,
          posts: curr.posts,
          prevPosts: prev.posts,
          postsDelta,
        });
      } else if (scoreDelta < 0 || postsDelta < 0) {
        fading.push({
          category: cat,
          painScore: curr.painScore,
          prevPainScore: prev.painScore,
          scoreDelta,
          posts: curr.posts,
          prevPosts: prev.posts,
          postsDelta,
        });
      }
    }
  }

  // Categories in previous but not current = resolved
  for (const [cat, prev] of Object.entries(previous)) {
    if (!current[cat]) {
      resolved.push({
        category: cat,
        prevPainScore: prev.painScore,
        prevPosts: prev.posts,
      });
    }
  }

  // New solutions not in previous
  for (const sol of currentSolutions) {
    if (!previousSolutions.includes(sol)) {
      newSolutions.push(sol);
    }
  }

  return {
    timestamp: currentTs,
    domain: domainName,
    previous: previousTs,
    new_pains: newPains,
    rising,
    fading,
    resolved,
    new_solutions: newSolutions,
  };
}

// ─── previous scan loader ────────────────────────────────────────────────────

/**
 * Find the most recent scan JSON file for a given source in the scans/ dir.
 * Files are named {source}-{timestamp}.json
 */
function findPreviousScan(domainDir, sourceName) {
  const scansDir = join(domainDir, 'scans');
  if (!existsSync(scansDir)) return null;

  const prefix = sourceName + '-';
  let files;
  try {
    files = readdirSync(scansDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort(); // ISO timestamps sort lexicographically
  } catch {
    return null;
  }

  if (files.length < 2) return null; // Need at least 2 to compare (current not yet written)
  // Return second-to-last (last is the one we just wrote)
  const file = files[files.length - 2];
  return readJSON(join(scansDir, file));
}

/**
 * Find the most recent scan file to compare against BEFORE writing new one.
 */
function findLastScan(domainDir, sourceName) {
  const scansDir = join(domainDir, 'scans');
  if (!existsSync(scansDir)) return null;

  const prefix = sourceName + '-';
  let files;
  try {
    files = readdirSync(scansDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort();
  } catch {
    return null;
  }

  if (files.length === 0) return null;
  const file = files[files.length - 1];
  return readJSON(join(scansDir, file));
}

// ─── history tracking ────────────────────────────────────────────────────────

function updateHistory(domainDir, timestamp, allPosts, sourceNames) {
  const histPath = join(domainDir, 'history.json');
  let history = readJSON(histPath) || { timeline: [] };

  const categories = extractCategoryMap(allPosts);
  // Strip postIds from history to keep it compact
  const compactCategories = {};
  for (const [cat, val] of Object.entries(categories)) {
    compactCategories[cat] = {
      painScore: val.painScore,
      posts: val.posts,
      wtp: val.wtp,
    };
  }

  history.timeline.push({
    timestamp,
    categories: compactCategories,
    totalPosts: allPosts.length,
    sources: sourceNames,
  });

  writeJSON(histPath, history);
}

// ─── report synthesis ────────────────────────────────────────────────────────

/**
 * Run the report synthesizer over a set of scan JSON files.
 * Returns { md, json }.
 */
async function runReport(scanFilePaths) {
  if (scanFilePaths.length === 0) return { md: null, json: null };

  const reportPath = resolve(__dirname, 'report.mjs');

  // Run for Markdown
  const mdResult = await spawnSource(
    ['report', '--files', scanFilePaths.join(','), '--format', 'md'],
    120000
  );

  // Run for JSON
  const jsonResult = await spawnSource(
    ['report', '--files', scanFilePaths.join(','), '--format', 'json'],
    120000
  );

  return {
    md: mdResult.ok ? mdResult.rawStdout : null,
    json: jsonResult.ok ? jsonResult.data : null,
  };
}

// ─── single domain scan ──────────────────────────────────────────────────────

async function scanDomain(domainConfig, baseDir) {
  const domainName = domainConfig.name;
  log(`\n[monitor] === Scanning domain: ${domainConfig.displayName || domainName} ===`);

  const domainDir = ensureDirs(baseDir, domainName);
  const ts = nowFilestamp();
  const tsISO = nowISO();

  // 1. Load previous scans BEFORE running new ones (for delta)
  const previousScans = {};
  for (const sourceName of Object.keys(domainConfig.sources || {})) {
    const lastScan = findLastScan(domainDir, sourceName);
    if (lastScan) previousScans[sourceName] = lastScan;
  }

  // 2. Run all sources
  const sourceResults = await runDomainSources(domainConfig);

  // 3. Save raw scan files
  const savedScanPaths = [];
  const allCurrentPosts = [];

  for (const { sourceName, result, timestamp } of sourceResults) {
    if (!result.ok || !result.data) continue;

    const posts = result.data.posts || result.data.results || [];
    allCurrentPosts.push(...posts);

    const filestamp = timestamp.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const scanFile = join(domainDir, 'scans', `${sourceName}-${filestamp}.json`);
    writeJSON(scanFile, result.data);
    savedScanPaths.push(scanFile);
    log(`[monitor] [${domainName}] saved scan: ${scanFile}`);
  }

  if (savedScanPaths.length === 0) {
    log(`[monitor] [${domainName}] no successful scans, skipping report and delta`);
    return;
  }

  // 4. Compute deltas per source
  const allDeltas = [];
  for (const { sourceName, result, timestamp } of sourceResults) {
    if (!result.ok || !result.data) continue;
    const currentPosts = result.data.posts || result.data.results || [];
    const prevData = previousScans[sourceName];
    if (prevData) {
      const prevPosts = prevData.posts || prevData.results || [];
      // Find previous timestamp from history or use empty string
      const prevTs = prevData.timestamp || '';
      const delta = computeDelta(domainName, currentPosts, prevPosts, timestamp, prevTs);
      allDeltas.push({ source: sourceName, ...delta });
    }
  }

  // Merged delta across all sources
  if (allDeltas.length > 0) {
    const mergedDelta = mergeDeltaAcrossSources(allDeltas, domainName, tsISO);
    const deltaFile = join(domainDir, 'deltas', `${ts}-delta.json`);
    writeJSON(deltaFile, mergedDelta);
    log(`[monitor] [${domainName}] delta saved: ${deltaFile}`);

    // Log summary
    logDeltaSummary(domainName, mergedDelta);
  }

  // 5. Run report synthesis
  log(`[monitor] [${domainName}] running report synthesis...`);
  const report = await runReport(savedScanPaths);

  if (report.md) {
    const mdFile = join(domainDir, 'reports', `${ts}-report.md`);
    writeFileSync(mdFile, report.md, 'utf8');
    log(`[monitor] [${domainName}] report saved: ${mdFile}`);

    // Update latest-report.md
    const latestFile = join(domainDir, 'latest-report.md');
    writeFileSync(latestFile, report.md, 'utf8');
  }

  if (report.json) {
    const jsonFile = join(domainDir, 'reports', `${ts}-report.json`);
    writeJSON(jsonFile, report.json);

    // Update latest-report.json (watched by web-report --serve for live dashboard)
    const latestJsonFile = join(domainDir, 'latest-report.json');
    writeJSON(latestJsonFile, report.json);
    log(`[monitor] [${domainName}] latest-report.json updated`);
  }

  // 6. Update history
  const sourceNames = sourceResults
    .filter(r => r.result.ok)
    .map(r => r.sourceName);
  updateHistory(domainDir, tsISO, allCurrentPosts, sourceNames);
  log(`[monitor] [${domainName}] history updated`);
}

// ─── delta merge helpers ─────────────────────────────────────────────────────

function mergeDeltaAcrossSources(allDeltas, domainName, timestamp) {
  const merged = {
    timestamp,
    domain: domainName,
    sources_compared: allDeltas.map(d => d.source),
    new_pains: [],
    rising: [],
    fading: [],
    resolved: [],
    new_solutions: [],
  };

  // Collect previous timestamps
  const prevTimestamps = allDeltas.map(d => d.previous).filter(Boolean);
  merged.previous = prevTimestamps.length > 0 ? prevTimestamps[0] : null;

  for (const delta of allDeltas) {
    merged.new_pains.push(...(delta.new_pains || []));
    merged.rising.push(...(delta.rising || []));
    merged.fading.push(...(delta.fading || []));
    merged.resolved.push(...(delta.resolved || []));
    merged.new_solutions.push(...(delta.new_solutions || []));
  }

  // Deduplicate solutions
  merged.new_solutions = [...new Set(merged.new_solutions)];

  return merged;
}

function logDeltaSummary(domainName, delta) {
  const np = delta.new_pains?.length || 0;
  const ri = delta.rising?.length || 0;
  const fa = delta.fading?.length || 0;
  const re = delta.resolved?.length || 0;
  const ns = delta.new_solutions?.length || 0;
  log(`[monitor] [${domainName}] delta: +${np} new pains, ${ri} rising, ${fa} fading, ${re} resolved, ${ns} new solutions`);
}

// ─── interval parser ─────────────────────────────────────────────────────────

function parseInterval(str) {
  const match = String(str).match(/^(\d+)(h|m|s)?$/i);
  if (!match) return null;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || 'h').toLowerCase();
  if (unit === 'h') return val * 3600 * 1000;
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 's') return val * 1000;
  return null;
}

// ─── web-report server launcher ──────────────────────────────────────────────

let _webServerChild = null;

function killWebServer() {
  if (_webServerChild) {
    try { _webServerChild.kill(); } catch {}
    _webServerChild = null;
  }
}

process.on('exit', killWebServer);
process.on('SIGINT', () => { killWebServer(); process.exit(0); });
process.on('SIGTERM', () => { killWebServer(); process.exit(0); });

/**
 * Spawn the web-report dev server for a given report JSON path and port.
 * Only spawns once — subsequent calls are no-ops.
 */
function startWebServer(reportJsonPath, port) {
  if (_webServerChild) return; // already running

  const webReportScript = resolve(__dirname, 'web-report.mjs');
  _webServerChild = spawn(process.execPath, [
    webReportScript,
    '--input', reportJsonPath,
    '--serve', String(port),
  ], { stdio: 'inherit' });

  _webServerChild.on('error', (err) => {
    log(`[monitor] web-report server error: ${err.message}`);
  });

  _webServerChild.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log(`[monitor] web-report server exited with code ${code}`);
    }
    _webServerChild = null;
  });

  log(`[monitor] Live dashboard at http://localhost:${port}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function runMonitor(args) {
  const configPath = args.config;
  if (!configPath) {
    log('[monitor] --config <domains.json> is required');
    process.exit(1);
  }

  const absoluteConfig = resolve(process.cwd(), configPath);
  const config = loadConfig(absoluteConfig);

  if (!config.domains || !Array.isArray(config.domains)) {
    log('[monitor] config must have a "domains" array');
    process.exit(1);
  }

  // Determine reports base dir (next to config file, or cwd/reports)
  const baseDir = args.reportsDir
    ? resolve(process.cwd(), args.reportsDir)
    : resolve(dirname(absoluteConfig), 'reports');

  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  log(`[monitor] reports dir: ${baseDir}`);

  // Filter to a single domain if --domain specified
  let domains = config.domains;
  if (args.domain) {
    domains = domains.filter(d => d.name === args.domain);
    if (domains.length === 0) {
      log(`[monitor] No domain found with name "${args.domain}"`);
      process.exit(1);
    }
  }

  log(`[monitor] monitoring ${domains.length} domain(s): ${domains.map(d => d.name).join(', ')}`);

  // Resolve serve port once (falsy = disabled)
  const servePort = args.serve ? parseInt(args.serve, 10) : null;

  // Helper: start web server after first scan if --serve was passed
  // Uses the first domain's latest-report.json as the watched file.
  function maybeStartWebServer() {
    if (!servePort) return;
    const primaryDomain = domains[0].name;
    const reportJsonPath = join(baseDir, primaryDomain, 'latest-report.json');
    if (existsSync(reportJsonPath)) {
      startWebServer(reportJsonPath, servePort);
    } else {
      log(`[monitor] --serve: latest-report.json not found yet for "${primaryDomain}", skipping web server start`);
    }
  }

  // Single run
  if (args.once) {
    for (const domain of domains) {
      await scanDomain(domain, baseDir);
    }
    maybeStartWebServer();
    log('\n[monitor] Done.');
    // Keep process alive so the web server stays up (unless no serve)
    if (servePort && _webServerChild) {
      await new Promise(() => {}); // wait until killed
    }
    return;
  }

  // Continuous mode
  const intervalMs = args.interval ? parseInterval(args.interval) : 6 * 3600 * 1000;
  if (!intervalMs || intervalMs <= 0) {
    log(`[monitor] Invalid --interval "${args.interval}". Use e.g. 6h, 30m, 3600s`);
    process.exit(1);
  }

  const intervalHuman = args.interval || '6h';
  log(`[monitor] Continuous mode: scanning every ${intervalHuman}`);
  if (servePort) log(`[monitor] --serve ${servePort}: dashboard will start after first scan`);

  let firstCycle = true;
  while (true) {
    const runStart = Date.now();
    for (const domain of domains) {
      await scanDomain(domain, baseDir);
    }
    if (firstCycle) {
      maybeStartWebServer();
      firstCycle = false;
    }
    const elapsed = Date.now() - runStart;
    const wait = Math.max(0, intervalMs - elapsed);
    log(`\n[monitor] Scan complete. Next run in ${Math.round(wait / 1000)}s (${intervalHuman})`);
    await new Promise(r => setTimeout(r, wait));
  }
}

// ─── CLI entry (when run directly) ──────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { normalizeArgs } = await import('./lib/utils.mjs');
  const args = normalizeArgs(process.argv.slice(2));
  runMonitor(args).catch(err => {
    log(`[monitor] Fatal: ${err.message}`);
    process.exit(1);
  });
}
