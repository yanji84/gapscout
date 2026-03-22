#!/usr/bin/env node

/**
 * llm-augment.mjs — CLI for LLM-based pain signal augmentation (Claude Code agent mode)
 *
 * Two-step workflow designed for Claude Code agents:
 *
 * Step 1: Generate a prompt for the Claude Code agent to analyze
 *   pain-points llm prompt --from-scan scan.json --domain "project management" --top 50
 *   (outputs a structured prompt to stdout that the agent reads and answers)
 *
 * Step 2: Apply the agent's analysis back into the scan data
 *   pain-points llm apply --from-scan scan.json --analysis analysis.json --output augmented.json
 *   (merges the agent's JSON analysis into the scan data and blends scores)
 *
 * No API keys required — the Claude Code agent IS the LLM.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { normalizeArgs, log } from './lib/utils.mjs';
import { buildAnalysisPrompt, parseAnalysisResponse, mergeAugmentation, blendLLMScores } from './lib/llm.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const args = normalizeArgs(argv);

  // Determine subcommand: first positional arg (prompt or apply)
  const subcommand = argv[0];

  if (args.help || argv.includes('--help') || !subcommand || !['prompt', 'apply', 'augment'].includes(subcommand)) {
    log(`
pain-points llm — LLM-based pain signal augmentation (Claude Code agent mode)

No API keys required. The Claude Code agent performs the analysis directly.

Subcommands:

  prompt   Generate an analysis prompt for the Claude Code agent
    --from-scan <file>   Input scan JSON file (required)
    --domain <domain>    Domain context for better analysis (required)
    --top <n>            Only include top N posts by painScore (default: all, recommend 50)

  apply    Apply the agent's analysis back into scan data
    --from-scan <file>   Original scan JSON file (required)
    --analysis <file>    Agent's JSON analysis output (required)
    --output <file>      Output augmented JSON (default: adds -augmented suffix)

  augment  (legacy alias) Same as 'prompt' — outputs the prompt to stdout

Workflow for Claude Code agents:
  1. Run 'llm prompt' to generate a structured prompt
  2. The agent reads the prompt and produces a JSON analysis
  3. The agent saves its analysis to a file
  4. Run 'llm apply' to merge the analysis into scan data

Or, the synthesizer agent can simply read the scan data and perform
the analysis inline as part of Step 4 of the synthesis workflow.
`);
    process.exit(0);
  }

  // Reparse args excluding the subcommand
  const cmdArgs = normalizeArgs(argv.slice(1));

  if (subcommand === 'prompt' || subcommand === 'augment') {
    await handlePrompt(cmdArgs);
  } else if (subcommand === 'apply') {
    await handleApply(cmdArgs);
  }
}

async function handlePrompt(args) {
  if (!args.fromScan) {
    log('[llm] --from-scan <file> is required');
    process.exit(1);
  }

  if (!args.domain) {
    log('[llm] --domain <domain> is required');
    process.exit(1);
  }

  // Load scan file
  let scanData;
  try {
    scanData = JSON.parse(readFileSync(args.fromScan, 'utf8'));
  } catch (err) {
    log(`[llm] Cannot read ${args.fromScan}: ${err.message}`);
    process.exit(1);
  }

  const data = scanData?.data || scanData;
  let posts = data?.posts || [];

  if (posts.length === 0) {
    log('[llm] No posts found in scan file');
    process.exit(1);
  }

  // Optionally limit to top N posts by painScore
  const top = args.top ? parseInt(args.top, 10) : undefined;
  if (top) {
    posts = [...posts].sort((a, b) => (b.painScore || 0) - (a.painScore || 0)).slice(0, top);
    log(`[llm] Selected top ${top} posts by painScore`);
  }

  log(`[llm] Generating analysis prompt for ${posts.length} posts (domain: ${args.domain})`);

  const prompt = buildAnalysisPrompt(posts, args.domain);

  // Output prompt to stdout for the Claude Code agent to read
  process.stdout.write(prompt + '\n');
}

async function handleApply(args) {
  if (!args.fromScan) {
    log('[llm] --from-scan <file> is required');
    process.exit(1);
  }

  if (!args.analysis) {
    log('[llm] --analysis <file> is required (the agent\'s JSON analysis output)');
    process.exit(1);
  }

  // Load scan file
  let scanData;
  try {
    scanData = JSON.parse(readFileSync(args.fromScan, 'utf8'));
  } catch (err) {
    log(`[llm] Cannot read ${args.fromScan}: ${err.message}`);
    process.exit(1);
  }

  // Load analysis file
  let analysisRaw;
  try {
    analysisRaw = readFileSync(args.analysis, 'utf8');
  } catch (err) {
    log(`[llm] Cannot read ${args.analysis}: ${err.message}`);
    process.exit(1);
  }

  const data = scanData?.data || scanData;
  const posts = data?.posts || [];

  if (posts.length === 0) {
    log('[llm] No posts found in scan file');
    process.exit(1);
  }

  // Parse the agent's analysis
  let analysisResult;
  try {
    analysisResult = parseAnalysisResponse(analysisRaw);
  } catch (err) {
    log(`[llm] Failed to parse analysis: ${err.message}`);
    process.exit(1);
  }

  // Merge augmentation data
  const augmentedPosts = mergeAugmentation(posts, analysisResult);

  // Blend LLM scores into painScore
  const blendedPosts = augmentedPosts.map(p => blendLLMScores(p));

  // Re-sort by blended painScore
  blendedPosts.sort((a, b) => (b.painScore || 0) - (a.painScore || 0));

  // Build output
  const output = {
    ok: true,
    data: {
      ...data,
      posts: blendedPosts,
      llmAugmented: true,
      llmAugmentedAt: new Date().toISOString(),
    },
  };

  // Determine output path
  let outputPath = args.output;
  if (!outputPath) {
    const base = basename(args.fromScan, '.json');
    const dir = dirname(args.fromScan);
    outputPath = join(dir, `${base}-augmented.json`);
  }

  // Write output
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  log(`[llm] Wrote augmented scan to ${outputPath}`);

  // Summary
  const augCount = blendedPosts.filter(p => p.llmAugmentation).length;
  const avgIntensity = augCount > 0
    ? Math.round(blendedPosts
        .filter(p => p.llmAugmentation)
        .reduce((s, p) => s + p.llmAugmentation.painIntensity, 0) / augCount * 10) / 10
    : 0;

  log(`[llm] Summary:`);
  log(`  Posts augmented: ${augCount}/${posts.length}`);
  log(`  Average LLM pain intensity: ${avgIntensity}/10`);
  log(`  Output: ${outputPath}`);

  // Output JSON to stdout for piping
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  log(`[llm] Fatal: ${err.message}`);
  process.exit(1);
});
