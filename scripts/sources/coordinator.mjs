/**
 * coordinator.mjs — Cross-source orchestration layer for pain-point-finder
 *
 * Dynamically discovers all source modules in the sources/ directory,
 * runs their `scan` command in parallel, deduplicates results by title
 * similarity, and outputs a unified JSON result set.
 *
 * Usage:
 *   pain-points all scan --domain "project management"
 *   pain-points all scan --domain "project management" --limit 50 --sources reddit-api,hackernews
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { log, ok, fail } from '../lib/utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── source discovery ───────────────────────────────────────────────────────

/**
 * Discover all source modules in the sources/ directory.
 * A valid source module exports { name, commands, run }.
 * Skips coordinator.mjs itself and any file that fails to import.
 */
async function discoverSources(allowList = null) {
  let files;
  try {
    files = await readdir(__dirname);
  } catch (err) {
    log(`[coordinator] cannot read sources dir: ${err.message}`);
    return [];
  }

  const sources = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.mjs')) continue;
    if (file === 'coordinator.mjs') continue;

    const sourceName = basename(file, '.mjs');

    // If an explicit allowlist is provided, skip sources not in it
    if (allowList && !allowList.includes(sourceName)) continue;

    let mod;
    try {
      mod = await import(`./${file}`);
    } catch (err) {
      log(`[coordinator] skipping ${file}: import failed — ${err.message}`);
      continue;
    }

    const src = mod.default;
    if (!src || typeof src.run !== 'function') {
      log(`[coordinator] skipping ${file}: no default export with run()`);
      continue;
    }

    if (!Array.isArray(src.commands) || !src.commands.includes('scan')) {
      log(`[coordinator] skipping ${file}: no 'scan' command`);
      continue;
    }

    sources.push(src);
  }

  return sources;
}

// ─── deduplication ──────────────────────────────────────────────────────────

/**
 * Normalize a title for similarity comparison:
 * lowercase, strip punctuation, split into words, remove stopwords.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'but', 'with', 'my', 'i', 'we', 'you', 'your',
  'this', 'that', 'are', 'was', 'be', 'been', 'have', 'has', 'had',
  'do', 'does', 'did', 'by', 'from', 'as', 'so', 'its', 'their',
]);

function normalizeTitle(title) {
  if (!title) return new Set();
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Jaccard similarity between two word sets.
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Deduplicate posts across sources by title similarity.
 * When two posts are similar (Jaccard >= threshold), keep the one with
 * higher painScore. The other post's source is appended to the winner's
 * `sources` array so provenance is preserved.
 *
 * @param {Array} posts - All posts with a `source` field
 * @param {number} threshold - Jaccard similarity threshold (default 0.6)
 */
function deduplicateByTitle(posts, threshold = 0.6) {
  // Sort descending by painScore so we keep the best-scored version
  const sorted = [...posts].sort((a, b) => (b.painScore || 0) - (a.painScore || 0));
  const kept = [];
  const keptSets = [];

  for (const post of sorted) {
    const postSet = normalizeTitle(post.title);
    let isDuplicate = false;

    for (let i = 0; i < kept.length; i++) {
      const sim = jaccardSimilarity(postSet, keptSets[i]);
      if (sim >= threshold) {
        // Merge provenance: add this post's source to the kept entry
        const winner = kept[i];
        if (!winner.sources) winner.sources = [winner.source];
        if (!winner.sources.includes(post.source)) {
          winner.sources.push(post.source);
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      kept.push({ ...post, sources: [post.source] });
      keptSets.push(postSet);
    }
  }

  return kept;
}

// ─── result normalization ───────────────────────────────────────────────────

/**
 * Extract posts array from a source's output, which may be structured as:
 *   { ok: true, data: { posts: [...] } }   — standard ok() wrapper
 *   { ok: true, data: { results: [...] } } — deep-dive style
 *   { posts: [...] }                        — direct
 *   [...]                                   — raw array
 */
function extractPosts(output, sourceName) {
  if (!output) return [];

  // Standard ok() wrapper: { ok: true, data: { posts: [...] } }
  if (output.ok === true && output.data) {
    return extractPosts(output.data, sourceName);
  }

  if (Array.isArray(output.posts)) return output.posts;
  if (Array.isArray(output.results)) return output.results;
  if (Array.isArray(output)) return output;

  // Some sources may nest posts differently; log and return empty
  log(`[coordinator] ${sourceName}: unexpected output shape, no posts extracted`);
  return [];
}

// ─── scan command ────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');

  const limit = args.limit || 50;
  const dedupThreshold = args.dedupThreshold || 0.6;

  // Optional: restrict to specific sources via --sources reddit-api,hackernews
  let sourceFilter = null;
  if (args.sources) {
    sourceFilter = String(args.sources).split(',').map(s => s.trim()).filter(Boolean);
  }

  log(`[coordinator] discovering sources${sourceFilter ? ` (filter: ${sourceFilter.join(',')})` : ''}...`);
  const sources = await discoverSources(sourceFilter);

  if (sources.length === 0) {
    fail('No source modules with a scan command were found in sources/');
  }

  log(`[coordinator] running scan on ${sources.length} source(s) in parallel: ${sources.map(s => s.name).join(', ')}`);

  // Run all sources in parallel, capturing stdout output from each.
  // Each source's run() calls ok() / fail() which writes to process.stdout.
  // We monkey-patch console.log temporarily to capture per-source output,
  // then restore it after all scans complete.

  const originalLog = console.log;
  const capturedOutputs = {}; // sourceName -> string[]

  for (const src of sources) {
    capturedOutputs[src.name] = [];
  }

  // We can't easily intercept console.log across parallel async calls since
  // they interleave on the same stdout. Instead, run sources sequentially
  // when stdout capture is needed, OR run them in separate worker threads.
  //
  // Simpler robust approach: call each source's run() in a child process
  // so stdout is isolated, OR run them as coroutines and patch stdout.
  //
  // Design choice: patch console.log per-source in series won't work for
  // parallel. Instead, intercept via a shared buffer keyed by "active source"
  // isn't thread-safe in single-threaded JS either.
  //
  // Best approach: run each source as a child_process.spawn of the CLI,
  // capture its stdout, parse JSON, and merge. This is truly isolated.

  const { spawn } = await import('node:child_process');
  const { createRequire } = await import('node:module');

  // Find the cli.mjs entry point relative to this file
  const cliPath = join(__dirname, '..', 'cli.mjs');

  /**
   * Run a single source's scan command as a child process.
   * Returns { sourceName, posts, stats, error }.
   */
  function runSourceScan(src) {
    return new Promise((resolve) => {
      const cliArgs = [cliPath, src.name, 'scan', '--domain', domain];

      // Forward relevant args
      if (args.days) cliArgs.push('--days', String(args.days));
      if (args.minScore) cliArgs.push('--min-score', String(args.minScore));
      if (args.minComments) cliArgs.push('--min-comments', String(args.minComments));
      if (args.pages) cliArgs.push('--pages', String(args.pages));
      if (args.subreddits) cliArgs.push('--subreddits', Array.isArray(args.subreddits) ? args.subreddits.join(',') : String(args.subreddits));
      // Per-source limit: fetch more than final limit so dedup has headroom
      const sourceLimit = Math.ceil(limit * 1.5);
      cliArgs.push('--limit', String(sourceLimit));

      log(`[coordinator] spawning: node ${cliArgs.slice(1).join(' ')}`);

      const child = spawn(process.execPath, cliArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000, // 2 min per source
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      child.on('close', (code) => {
        // Log source's stderr (its log() calls) prefixed with source name
        if (stderr.trim()) {
          for (const line of stderr.trim().split('\n')) {
            log(`  [${src.name}] ${line}`);
          }
        }

        let parsed = null;
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {
          const snippet = stdout.trim().slice(0, 200);
          log(`[coordinator] ${src.name}: failed to parse JSON output — "${snippet}"`);
          resolve({ sourceName: src.name, posts: [], stats: null, error: `JSON parse failed (exit ${code})` });
          return;
        }

        if (parsed.ok === false) {
          const msg = parsed.error?.message || 'unknown error';
          log(`[coordinator] ${src.name}: reported failure — ${msg}`);
          resolve({ sourceName: src.name, posts: [], stats: null, error: msg });
          return;
        }

        const posts = extractPosts(parsed, src.name);
        const stats = parsed.data?.stats || parsed.stats || null;
        log(`[coordinator] ${src.name}: ${posts.length} posts`);
        resolve({ sourceName: src.name, posts, stats, error: null });
      });

      child.on('error', (err) => {
        log(`[coordinator] ${src.name}: spawn error — ${err.message}`);
        resolve({ sourceName: src.name, posts: [], stats: null, error: err.message });
      });
    });
  }

  // Run all source scans in parallel
  const scanPromises = sources.map(src => runSourceScan(src));
  const results = await Promise.all(scanPromises);

  // Collect stats and aggregate posts
  const sourceStats = {};
  const allPosts = [];
  const errors = {};

  for (const result of results) {
    sourceStats[result.sourceName] = {
      posts: result.posts.length,
      stats: result.stats,
      error: result.error,
    };

    if (result.error) {
      errors[result.sourceName] = result.error;
    }

    // Tag each post with its source
    for (const post of result.posts) {
      allPosts.push({ ...post, source: result.sourceName });
    }
  }

  log(`[coordinator] total posts before dedup: ${allPosts.length}`);

  // Deduplicate by title similarity
  const deduplicated = deduplicateByTitle(allPosts, dedupThreshold);

  // Sort by painScore descending
  deduplicated.sort((a, b) => (b.painScore || 0) - (a.painScore || 0));

  const finalPosts = deduplicated.slice(0, limit);

  log(`[coordinator] after dedup: ${deduplicated.length} unique posts, returning top ${finalPosts.length}`);

  ok({
    mode: 'all',
    domain,
    posts: finalPosts,
    stats: {
      sources_run: sources.map(s => s.name),
      source_stats: sourceStats,
      total_before_dedup: allPosts.length,
      total_after_dedup: deduplicated.length,
      returned: finalPosts.length,
      dedup_threshold: dedupThreshold,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'coordinator',
  description: 'Run all available sources in parallel and merge results',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
coordinator source — Cross-source orchestration
Alias: all

Runs all available source modules with a 'scan' command in parallel,
deduplicates results by title similarity, and returns a unified list.

Usage:
  pain-points all scan --domain "project management"
  pain-points all scan --domain "SaaS billing" --limit 50
  pain-points all scan --domain "pokemon tcg" --sources reddit-api,hackernews

scan options:
  --domain <str>          Problem domain to search (required)
  --limit <n>             Max posts in final output (default: 50)
  --sources <list>        Comma-separated source names to include (default: all)
  --days <n>              Forwarded to sources that support it (default: source default)
  --min-score <n>         Forwarded to sources that support it
  --min-comments <n>      Forwarded to sources that support it
  --pages <n>             Forwarded to sources that support it
  --subreddits <list>     Forwarded to Reddit sources
  --dedup-threshold <f>   Jaccard similarity threshold for dedup (default: 0.6)
`,
};
