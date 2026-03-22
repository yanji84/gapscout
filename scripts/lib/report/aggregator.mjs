/**
 * report/aggregator.mjs — Input loading and merging for report generation
 */

import { readFileSync, readSync } from 'node:fs';
import { log } from '../utils.mjs';

// ─── input loading ─────────────────────────────────────────────────────────

/**
 * Infer source from file path and post data when data.source is missing.
 */
export function inferSource(post, fallback) {
  if (fallback) return fallback;
  const sub = post?.subreddit;
  if (!sub) return 'unknown';
  if (sub === 'hackernews') return 'hackernews';
  if (sub === 'playstore' || sub === 'appstore') return 'appstore';
  if (sub === 'google-autocomplete') return 'google';
  if (sub === 'kickstarter') return 'kickstarter';
  if (sub === 'producthunt') return 'producthunt';
  return 'reddit';
}

/**
 * Load a single scan result envelope and extract posts.
 * @param {object} raw - Parsed JSON data
 * @param {string} fileLabel - Label for this input (file path or 'stdin')
 * @returns {object[]} Array of post objects annotated with { _source, _file }
 */
export function loadScanResult(raw, fileLabel) {
  const data = raw?.data || raw;
  const fileSource = data?.source || null;
  const posts = [];

  // Scan output: { posts: [...] }
  if (Array.isArray(data?.posts)) {
    for (const p of data.posts) {
      const source = inferSource(p, fileSource);
      posts.push({ ...p, _source: source, _file: fileLabel });
    }
  }

  // Deep-dive output: { results: [{ post, analysis }] }
  if (Array.isArray(data?.results)) {
    for (const r of data.results) {
      if (r.post) {
        const source = inferSource(r.post, fileSource);
        posts.push({ ...r.post, _analysis: r.analysis, _source: source, _file: fileLabel });
      }
    }
  }

  // Alternative deep-dive format: { deep_dives: [{ post, analysis }] }
  if (Array.isArray(data?.deep_dives)) {
    for (const r of data.deep_dives) {
      if (r.post) {
        const source = inferSource(r.post, fileSource);
        posts.push({ ...r.post, _analysis: r.analysis, _source: source, _file: fileLabel });
      }
    }
  }

  return posts;
}

/**
 * Load and flatten all posts/results from a parsed JSON scan file.
 * Returns an array of post objects annotated with { _source, _file }.
 */
export function loadFile(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    log(`[report] Cannot read ${filePath}: ${err.message}`);
    return [];
  }
  return loadScanResult(raw, filePath);
}

/**
 * Load posts from stdin (synchronous read).
 */
export function loadStdin() {
  const chunks = [];
  const fd = process.stdin.fd;
  const buf = Buffer.alloc(65536);
  let n;
  try {
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(buf.slice(0, n).toString());
    }
  } catch {
    // EOF
  }
  const text = chunks.join('');
  if (!text.trim()) return [];
  try {
    const raw = JSON.parse(text);
    return loadScanResult(raw, 'stdin');
  } catch (err) {
    log(`[report] Cannot parse stdin: ${err.message}`);
    return [];
  }
}

/**
 * Merge multiple scan file results, deduplicating by id.
 * Keeps the version with analysis data if duplicates exist.
 *
 * @param {string[]} filePaths
 * @param {object} opts
 * @param {boolean} [opts.useStdin=false]
 * @param {number} [opts.maxAgeDays=180]
 * @returns {{ posts: object[], sources: Set<string> }}
 */
export function mergeScanFiles(filePaths, { useStdin = false, maxAgeDays = 180 } = {}) {
  let allPosts = [];
  const loadedSources = new Set();

  for (const f of filePaths) {
    const posts = loadFile(f);
    for (const p of posts) {
      allPosts.push(p);
      loadedSources.add(p._source || 'unknown');
    }
    log(`[report] Loaded ${posts.length} posts from ${f}`);
  }

  if (useStdin) {
    const posts = loadStdin();
    for (const p of posts) {
      allPosts.push(p);
      loadedSources.add(p._source || 'unknown');
    }
    log(`[report] Loaded ${posts.length} posts from stdin`);
  }

  // Deduplicate by id
  const seenIds = new Map();
  for (const p of allPosts) {
    const key = p.id || p.url || p.title;
    if (!key) continue;
    const existing = seenIds.get(key);
    if (!existing || (!existing._analysis && p._analysis)) {
      seenIds.set(key, p);
    }
  }
  allPosts = [...seenIds.values()];

  // Recency filter
  if (maxAgeDays > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    const before = allPosts.length;
    allPosts = allPosts.filter(p => {
      if (!p.created_utc || p.created_utc === 0) return true;
      return p.created_utc >= cutoff;
    });
    const dropped = before - allPosts.length;
    if (dropped > 0) {
      log(`[report] Recency filter: dropped ${dropped} posts older than ${maxAgeDays} days (kept ${allPosts.length})`);
    }
  }

  return { posts: allPosts, sources: loadedSources };
}
