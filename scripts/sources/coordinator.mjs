/**
 * coordinator.mjs — Cross-source orchestration layer for gapscout
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
import { resolveSourceName } from '../lib/command-registry.mjs';
import { applySourceQuality } from '../lib/scoring.mjs';

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

    // If an explicit allowlist is provided, skip sources not in it.
    // Resolve aliases: 'hn' -> 'hackernews', 'api' -> 'reddit-api', etc.
    if (allowList) {
      const resolvedAllowList = allowList.map(resolveSourceName);
      if (!resolvedAllowList.includes(sourceName)) continue;
    }

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
 * Normalize text for similarity comparison:
 * lowercase, strip punctuation, split into words, remove stopwords.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'but', 'with', 'my', 'i', 'we', 'you', 'your',
  'this', 'that', 'are', 'was', 'be', 'been', 'have', 'has', 'had',
  'do', 'does', 'did', 'by', 'from', 'as', 'so', 'its', 'their',
  'not', 'no', 'just', 'can', 'will', 'would', 'should', 'could',
  'about', 'what', 'when', 'where', 'how', 'why', 'who', 'which',
  'any', 'all', 'some', 'there', 'here', 'than', 'then', 'if',
  'very', 'really', 'also', 'been', 'being', 'get', 'got', 'getting',
  'like', 'know', 'think', 'want', 'need', 'use', 'using', 'used',
]);

/**
 * Normalize text into an array of cleaned words (no stopwords, lowercase, no punctuation).
 */
function normalizeToWords(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function normalizeTitle(title) {
  return new Set(normalizeToWords(title));
}

/**
 * Generate bigrams from a word array.
 * Returns a Set of "word1 word2" strings.
 */
function generateBigrams(words) {
  const bigrams = new Set();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

/**
 * Generate trigrams from a word array.
 * Returns a Set of "word1 word2 word3" strings.
 */
function generateTrigrams(words) {
  const trigrams = new Set();
  for (let i = 0; i < words.length - 2; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return trigrams;
}

/**
 * Jaccard similarity between two sets.
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
 * Compute a combined similarity score using unigram, bigram, and trigram Jaccard.
 * Weights: unigram 0.4, bigram 0.4, trigram 0.2
 * Falls back gracefully when n-grams are empty (short titles).
 */
function combinedSimilarity(wordsA, wordsB) {
  const unigramSim = jaccardSimilarity(new Set(wordsA), new Set(wordsB));

  const bigramsA = generateBigrams(wordsA);
  const bigramsB = generateBigrams(wordsB);
  const bigramSim = (bigramsA.size > 0 && bigramsB.size > 0)
    ? jaccardSimilarity(bigramsA, bigramsB)
    : unigramSim; // fall back to unigram if no bigrams

  const trigramsA = generateTrigrams(wordsA);
  const trigramsB = generateTrigrams(wordsB);
  const trigramSim = (trigramsA.size > 0 && trigramsB.size > 0)
    ? jaccardSimilarity(trigramsA, trigramsB)
    : bigramSim; // fall back to bigram if no trigrams

  return unigramSim * 0.4 + bigramSim * 0.4 + trigramSim * 0.2;
}

/**
 * Normalize a URL for comparison: strip protocol, www, trailing slashes, query params.
 */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').replace(/\?.*$/, '');
  }
}

/**
 * Deduplicate posts across sources by URL identity and title similarity.
 * Uses n-gram overlap (bigrams/trigrams) in addition to unigram Jaccard.
 * Cross-source dedup uses a lower threshold to catch same content from different platforms.
 *
 * When two posts are similar, keep the one with higher painScore.
 * The other post's source is appended to the winner's `sources` array.
 *
 * @param {Array} posts - All posts with a `source` field
 * @param {number} threshold - Combined similarity threshold for same-source dedup (default 0.6)
 * @param {number} crossSourceThreshold - Threshold for cross-source dedup (default 0.45)
 */
function deduplicateByTitle(posts, threshold = 0.6, crossSourceThreshold = 0.45) {
  // Phase 1: URL-based dedup (definite duplicates)
  const urlMap = new Map(); // normalizedUrl -> index in sorted
  const sorted = [...posts].sort((a, b) => (b.painScore || 0) - (a.painScore || 0));

  // Mark URL-based duplicates
  const urlDuplicateOf = new Map(); // post index -> winner index
  for (let i = 0; i < sorted.length; i++) {
    const normUrl = normalizeUrl(sorted[i].url);
    if (!normUrl) continue;
    if (urlMap.has(normUrl)) {
      urlDuplicateOf.set(i, urlMap.get(normUrl));
    } else {
      urlMap.set(normUrl, i);
    }
  }

  // Phase 2: Title/content similarity dedup with n-grams
  const kept = [];
  const keptWords = [];   // parallel array of word arrays for n-gram comparison
  const keptSources = []; // parallel array of source names

  for (let i = 0; i < sorted.length; i++) {
    const post = sorted[i];

    // Handle URL-based duplicates
    if (urlDuplicateOf.has(i)) {
      const winnerIdx = urlDuplicateOf.get(i);
      // Find the winner in kept array
      for (const k of kept) {
        if (k.url === sorted[winnerIdx].url || normalizeUrl(k.url) === normalizeUrl(sorted[winnerIdx].url)) {
          if (!k.sources) k.sources = [k.source];
          if (post.source && !k.sources.includes(post.source)) {
            k.sources.push(post.source);
          }
          break;
        }
      }
      continue;
    }

    const postWords = normalizeToWords(post.title);
    let isDuplicate = false;

    for (let j = 0; j < kept.length; j++) {
      const sim = combinedSimilarity(postWords, keptWords[j]);

      // Use lower threshold for cross-source dedup
      const isCrossSource = post.source !== keptSources[j];
      const effectiveThreshold = isCrossSource ? crossSourceThreshold : threshold;

      if (sim >= effectiveThreshold) {
        // Merge provenance
        const winner = kept[j];
        if (!winner.sources) winner.sources = [winner.source];
        if (post.source && !winner.sources.includes(post.source)) {
          winner.sources.push(post.source);
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      kept.push({ ...post, sources: [post.source] });
      keptWords.push(postWords);
      keptSources.push(post.source);
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

      // Forward global scan flags so child processes share the same scan context
      if (args.scanId) cliArgs.push('--scan-id', String(args.scanId));
      if (args.scanDir) cliArgs.push('--scan-dir', String(args.scanDir));

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

    // Tag each post with its source and apply quality multiplier
    for (const post of result.posts) {
      const adjustedScore = applySourceQuality(post.painScore || 0, result.sourceName);
      allPosts.push({ ...post, source: result.sourceName, painScore: adjustedScore });
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
