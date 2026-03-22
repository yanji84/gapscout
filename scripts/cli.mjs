#!/usr/bin/env node

/**
 * cli.mjs — Unified CLI for pain-point-finder
 *
 * Usage:
 *   pain-points <source> <command> [options]
 *   pain-points report --files file1.json,file2.json [--format md|json]
 *
 * Sources:
 *   api       PullPush API (historical Reddit data)
 *   browser   Puppeteer browser (real-time Reddit scraping)
 *
 * Examples:
 *   pain-points api discover --domain "project management"
 *   pain-points api scan --subreddits projectmanagement,SaaS --days 90
 *   pain-points browser scan --subreddits PokemonTCG --domain "pokemon tcg"
 *   pain-points browser deep-dive --post <url>
 *   pain-points report --files reddit-scan.json,hn-scan.json --format md
 */

import { normalizeArgs, log } from './lib/utils.mjs';

// ─── source registry ────────────────────────────────────────────────────────
// Add new sources here. Each source module exports { name, commands, run, help }.

const SOURCES = {};

async function loadSource(name) {
  if (SOURCES[name]) return SOURCES[name];
  try {
    const mod = await import(`./sources/${name}.mjs`);
    SOURCES[name] = mod.default;
    return mod.default;
  } catch {
    return null;
  }
}

// Source name aliases
const SOURCE_ALIASES = {
  api: 'reddit-api',
  browser: 'reddit-browser',
  google: 'google-autocomplete',
  hn: 'hackernews',
  hackernews: 'hackernews',
  reviews: 'reviews',
  ph: 'producthunt',
  producthunt: 'producthunt',
  kickstarter: 'crowdfunding',
  crowdfunding: 'crowdfunding',
  appstore: 'appstore',
  twitter: 'twitter',
  x: 'twitter',
  trustpilot: 'trustpilot',
  all: 'coordinator',
  coordinator: 'coordinator',
  'reddit-api': 'reddit-api',
  'reddit-browser': 'reddit-browser',
  'google-autocomplete': 'google-autocomplete',
  'reviews': 'reviews',
  'crowdfunding': 'crowdfunding',
  'appstore': 'appstore',
  'twitter': 'twitter',
  'trustpilot': 'trustpilot',
};

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);

  // Top-level `web-report` command — delegate to web-report.mjs directly
  if (argv[0] === 'web-report') {
    const { fileURLToPath: fu2 } = await import('node:url');
    const { dirname: dn2, resolve: res2 } = await import('node:path');
    const __dirname2 = dn2(fu2(import.meta.url));
    const { spawn: sp2 } = await import('node:child_process');
    const webReportPath = res2(__dirname2, 'web-report.mjs');
    const child2 = sp2(process.execPath, [webReportPath, ...argv.slice(1)], { stdio: 'inherit' });
    child2.on('exit', code => process.exit(code ?? 0));
    return;
  }

  // Top-level `report` command — delegate to report.mjs directly
  if (argv[0] === 'report') {
    const { createRequire } = await import('node:module');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Re-launch report.mjs as a child process so process.argv is set correctly
    const { spawn } = await import('node:child_process');
    const reportPath = resolve(__dirname, 'report.mjs');
    const child = spawn(process.execPath, [reportPath, ...argv.slice(1)], {
      stdio: 'inherit',
    });
    child.on('exit', code => process.exit(code ?? 0));
    return;
  }

  // Top-level `monitor` command — delegate to monitor.mjs
  if (argv[0] === 'monitor') {
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const { normalizeArgs } = await import('./lib/utils.mjs');
    const { runMonitor } = await import('./monitor.mjs');
    const args = normalizeArgs(argv.slice(1));
    await runMonitor(args);
    return;
  }

  if (argv.length === 0 || (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help'))) {
    const apiSource = await loadSource('reddit-api');
    const browserSource = await loadSource('reddit-browser');

    log(`
pain-points — Multi-source pain point discovery

Usage:
  pain-points <source> <command> [options]
  pain-points report --files file1.json,file2.json [--format md|json]
  pain-points monitor --config domains.json [--once | --interval 6h]

Sources:
  all       Coordinator — run ALL sources in parallel (recommended)
  api       PullPush API — historical Reddit data, no browser needed
  browser   Puppeteer — real-time Reddit scraping via old.reddit.com
  google    Google autocomplete / People Also Ask
  hn        Hacker News
  reviews   G2 / Capterra / Trustpilot review scraper
  ph        Product Hunt
  crowdfunding  Kickstarter / Indiegogo
  appstore  App Store / Play Store reviews

Commands by source:
  all:      scan
  api:      discover, scan, deep-dive
  browser:  scan, deep-dive

Report command (Phases 4-7 synthesis):
  pain-points report --files reddit-scan.json,hn-scan.json [--format md|json]

Web report command (beautiful HTML dashboard):
  pain-points web-report --input report.json --output report.html
  pain-points web-report --input report.json --serve 8080

Monitor command (continuous scanning with delta detection):
  pain-points monitor --config domains.json --once
  pain-points monitor --config domains.json --interval 6h
  pain-points monitor --config domains.json --domain scalper-bot --once
  pain-points monitor --config domains.json --once --serve 8080        (scan once + serve live dashboard)
  pain-points monitor --config domains.json --interval 6h --serve 8080 (scan every 6h + live dashboard)

Examples:
  pain-points all scan --domain "project management"
  pain-points all scan --domain "SaaS billing" --limit 50
  pain-points api discover --domain "project management" --limit 8
  pain-points api scan --subreddits projectmanagement,SaaS --days 90 --limit 20
  pain-points api deep-dive --post 1inyk7o
  pain-points browser scan --subreddits PokemonTCG --domain "pokemon tcg" --time year
  pain-points browser deep-dive --post https://old.reddit.com/r/PokemonTCG/comments/1k9vcj5/
  pain-points report --files reddit.json,hn.json,reviews.json

For source-specific help:
  pain-points all --help
  pain-points api --help
  pain-points browser --help
  pain-points report --help
`);
    process.exit(0);
  }

  // Parse source and command
  const sourceName = argv[0];
  const resolvedName = SOURCE_ALIASES[sourceName];
  if (!resolvedName) {
    log(`Unknown source: "${sourceName}". Available: api, browser`);
    process.exit(1);
  }

  const source = await loadSource(resolvedName);
  if (!source) {
    log(`Failed to load source: ${resolvedName}`);
    process.exit(1);
  }

  // Source-level help
  if (argv.length === 1 || argv[1] === '--help') {
    log(source.help || `Source: ${source.name}\nCommands: ${source.commands.join(', ')}`);
    process.exit(0);
  }

  const command = argv[1];
  if (!source.commands.includes(command)) {
    log(`Source "${sourceName}" does not support command "${command}".`);
    log(`Available commands: ${source.commands.join(', ')}`);
    process.exit(1);
  }

  const args = normalizeArgs(argv.slice(2));
  await source.run(command, args);
}

main().catch(err => {
  console.log(JSON.stringify({ ok: false, error: { message: err.message } }, null, 2));
  process.exit(1);
});
