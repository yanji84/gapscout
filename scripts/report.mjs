#!/usr/bin/env node

/**
 * report.mjs — Cross-source pain point report aggregator and synthesizer
 *
 * Thin orchestrator that delegates to:
 *   - lib/report/aggregator.mjs   — input loading and merging
 *   - lib/report/analysis.mjs     — grouping, classification, matrix
 *   - lib/report/synthesis.mjs    — verdicts, scoring, idea sketches
 *   - lib/report/markdown-renderer.mjs — markdown and JSON output
 *
 * Usage:
 *   pain-points report --files reddit-scan.json,hn-scan.json,reviews-scan.json
 *   pain-points report --files scan1.json --format json
 *   cat scan.json | pain-points report --stdin
 */

import { readFileSync } from 'node:fs';
import { log, normalizeArgs } from './lib/utils.mjs';
import { mergeScanFiles } from './lib/report/aggregator.mjs';
import {
  groupBySubcategory, classifyDepth, computeMatrix,
  aggregateMoneyTrail, extractUnspokenPain, aggregateTools,
} from './lib/report/analysis.mjs';
import {
  buildWorthinessScore, determineVerdict, buildOpportunityText,
  getAudience,
} from './lib/report/synthesis.mjs';
import { renderMarkdown, renderJson } from './lib/report/markdown-renderer.mjs';

// ─── synthesize groups into report data ──────────────────────────────────────

function synthesize(groups, allPosts) {
  const reportGroups = [];

  for (const [category, posts] of groups.entries()) {
    const sources = new Set(posts.map(p => p._source || p.subreddit || 'unknown'));
    const crossSources = sources.size;
    const depth = classifyDepth(posts);
    const { frequency, intensityScore, position: matrix } = computeMatrix(posts, crossSources);
    const moneyTrail = aggregateMoneyTrail(posts);
    const unspokenPain = extractUnspokenPain(posts);
    const tools = aggregateTools(posts);
    const buildScore = buildWorthinessScore(depth, matrix, moneyTrail, crossSources, posts.length);
    const verdict = determineVerdict(depth, matrix, moneyTrail);

    // Top quotes
    const topQuotes = [];
    for (const p of posts) {
      if (p._analysis?.topQuotes) {
        for (const q of p._analysis.topQuotes.slice(0, 2)) {
          topQuotes.push({ ...q, url: q.url || p.url || '', citeKey: p._citeKey || '' });
        }
      }
    }

    // Solution attempts
    const solutionAttempts = [];
    for (const p of posts) {
      if (p._analysis?.solutionAttempts) {
        for (const s of p._analysis.solutionAttempts.slice(0, 2)) {
          solutionAttempts.push({ ...s, url: s.url || p.url || '' });
        }
      }
    }

    const totalComments = posts.reduce((s, p) => s + (p.num_comments || p._analysis?.totalComments || 0), 0);
    const totalScore = posts.reduce((s, p) => s + (p.score || 0), 0);

    // Collect all citeKeys belonging to this category for evidence drawer
    const categoryCiteKeys = posts.map(p => p._citeKey).filter(Boolean);

    const representativePosts = [...posts]
      .sort((a, b) => (b.painScore || 0) - (a.painScore || 0))
      .slice(0, 3)
      .map(p => ({
        title: p.title,
        url: p.url,
        score: p.score,
        num_comments: p.num_comments,
        source: p._source || p.subreddit || 'unknown',
        llmEnhanced: !!p.llmAugmentation,
        wtpSignals: p.wtpSignals,
        citeKey: p._citeKey || '',
      }));

    const llmAugmentedPosts = posts.filter(p => p.llmAugmentation);
    const hasLLM = llmAugmentedPosts.length > 0;
    const implicitPainSignals = hasLLM
      ? [...new Set(llmAugmentedPosts.flatMap(p => p.llmAugmentation.implicitPain || []))]
      : [];
    const targetPersonas = hasLLM
      ? [...new Set(llmAugmentedPosts.map(p => p.llmAugmentation.targetPersona).filter(Boolean))]
      : [];
    const llmAudience = targetPersonas.length > 0
      ? targetPersonas.slice(0, 2).join('; ')
      : null;

    reportGroups.push({
      category,
      postCount: posts.length,
      crossSources,
      sourceNames: [...sources],
      depth,
      frequency,
      intensityScore,
      matrix,
      moneyTrail,
      unspokenPain,
      tools,
      topQuotes: topQuotes.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5),
      solutionAttempts: solutionAttempts.slice(0, 5),
      totalComments,
      totalScore,
      buildScore,
      verdict,
      representativePosts,
      categoryCiteKeys,
      audience: llmAudience || getAudience(category),
      llmEnhanced: hasLLM,
      llmAugmentedCount: llmAugmentedPosts.length,
      implicitPainSignals: implicitPainSignals.slice(0, 10),
      targetPersonas: targetPersonas.slice(0, 3),
    });
  }

  reportGroups.sort((a, b) => b.buildScore - a.buildScore);
  return reportGroups;
}

// ─── rate monitor data extraction from scan files ────────────────────────────

/**
 * Extract and merge rateMonitorSummary data from scan JSON files.
 * Each scan file may contain a top-level `rateMonitorSummary` field
 * written by sources that use RateMonitor.
 */
function extractRateMonitorSummaries(filePaths) {
  const merged = { warnings: [], blocks: [], errors: [] };
  for (const f of filePaths) {
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      const summary = raw?.rateMonitorSummary || raw?.data?.rateMonitorSummary;
      if (summary) {
        if (Array.isArray(summary.warnings)) merged.warnings.push(...summary.warnings);
        if (Array.isArray(summary.blocks)) merged.blocks.push(...summary.blocks);
        if (Array.isArray(summary.errors)) merged.errors.push(...summary.errors);
      }
    } catch {
      // skip files that can't be read
    }
  }
  const total = merged.warnings.length + merged.blocks.length + merged.errors.length;
  return total > 0 ? merged : null;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = normalizeArgs(argv);

  if (args.help || argv.includes('--help')) {
    process.stderr.write(`
pain-points report — Cross-source pain point aggregator and synthesizer

Usage:
  pain-points report --files file1.json,file2.json [--format md|json]
  cat scan.json | pain-points report --stdin [--format md|json]

Options:
  --files <paths>    Comma-separated list of scan/deep-dive JSON files
  --stdin            Read a single scan JSON from stdin
  --format <md|json> Output format (default: md)
  --max-age <days>   Drop posts older than N days (default: 180 = 6 months, 0 = no filter)

The report follows Phase 4-7 of the SKILL.md workflow:
  Phase 4: Pain Depth Classification (surface / active / urgent)
  Phase 5: Frequency vs Intensity Matrix
  Phase 6: Willingness-to-Pay & Unspoken Pain Analysis
  Phase 7: Verdict & Opportunity Synthesis + ranked list
`);
    process.exit(0);
  }

  const format = args.format || 'md';
  if (!['md', 'json'].includes(format)) {
    process.stderr.write(`[report] Unknown format "${format}". Use md or json.\n`);
    process.exit(1);
  }

  const filePaths = args.files
    ? String(args.files).split(',').map(f => f.trim()).filter(Boolean)
    : [];

  const maxAgeDays = args.maxAge != null ? parseInt(args.maxAge, 10) : 180;

  const { posts: allPosts, sources: loadedSources } = mergeScanFiles(filePaths, {
    useStdin: !!args.stdin,
    maxAgeDays,
  });

  if (allPosts.length === 0) {
    process.stderr.write('[report] No posts loaded. Use --files or --stdin.\n');
    process.exit(1);
  }

  log(`[report] Total posts: ${allPosts.length} from ${loadedSources.size} source(s)`);

  // Assign citeKeys and category tags to each post for evidence corpus
  const groups = groupBySubcategory(allPosts);
  for (const [category, posts] of groups.entries()) {
    for (const p of posts) {
      if (!p._citeKey) {
        // Use stable citeKey from enrichPost() if available
        if (p.citeKey) {
          p._citeKey = p.citeKey;
        } else {
          const src = (p._source || p.subreddit || 'unknown').slice(0, 2).toUpperCase();
          const hash = Math.random().toString(36).slice(2, 8);
          p._citeKey = `${src}-${hash}`;
        }
      }
      p._category = category;
    }
  }

  const synthesized = synthesize(groups, allPosts);

  // Extract rate monitor data from scan files (if any sources reported issues)
  const rateMonitorSummary = extractRateMonitorSummaries(filePaths);

  const meta = {
    sources: [...loadedSources],
    totalPosts: allPosts.length,
    categoriesFound: synthesized.length,
    ...(rateMonitorSummary ? { rateMonitorSummary } : {}),
  };

  const output = format === 'json'
    ? renderJson(synthesized, meta, { allPosts })
    : renderMarkdown(synthesized, meta);

  process.stdout.write(output + '\n');
}

main().catch(err => {
  process.stderr.write(`[report] Fatal: ${err.message}\n`);
  process.exit(1);
});
