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
import { SOURCE_ALIASES } from './lib/command-registry.mjs';

// ─── idea sketch markdown helper ─────────────────────────────────────────────

function renderSketchesMd(sketches) {
  const lines = ['# Idea Sketches', ''];
  for (const s of sketches) {
    lines.push(`## ${(s.category || '').replace(/-/g, ' ')} — Idea Sketch`);
    lines.push('');
    lines.push(`**Verdict:** ${s.verdictLabel} | **Build Score:** ${s.buildScore}/100`);
    lines.push('');
    lines.push(`**Problem Statement:** ${s.problemStatement}`);
    lines.push('');
    lines.push('**Target Customer**');
    lines.push(`- Who: ${s.targetCustomer?.who || 'Unknown'}`);
    lines.push(`- Where: ${s.targetCustomer?.whereTheyHangOut || 'Unknown'}`);
    lines.push(`- Spending: ${s.targetCustomer?.currentSpending || 'Unknown'}`);
    lines.push('');
    lines.push('**Solution Concept (MVP)**');
    lines.push(`- Core feature: ${s.solutionConcept?.coreFeature || 'TBD'}`);
    lines.push(`- Why existing fail: ${s.solutionConcept?.whyExistingFail || 'TBD'}`);
    if (s.solutionConcept?.keyDifferentiator) lines.push(`- Key differentiator: ${s.solutionConcept.keyDifferentiator}`);
    lines.push('');
    lines.push('**Business Model**');
    lines.push(`- Pricing: ${s.businessModel?.pricing || 'TBD'}`);
    lines.push(`- Revenue: ${s.businessModel?.revenueModel || 'TBD'}`);
    lines.push(`- Est. WTP: ${s.businessModel?.estimatedWtp || 'Unknown'}`);
    lines.push('');
    lines.push('**Go-to-Market**');
    lines.push(`- Launch: ${s.goToMarket?.launchChannel || 'TBD'}`);
    lines.push(`- First 100: ${s.goToMarket?.first100 || 'TBD'}`);
    if (s.goToMarket?.contentAngle) lines.push(`- Content angle: ${s.goToMarket.contentAngle}`);
    lines.push('');
    lines.push('**Competitive Landscape**');
    lines.push(`- Direct: ${s.competitiveLandscape?.directCompetitors || 'None identified.'}`);
    lines.push(`- Indirect: ${s.competitiveLandscape?.indirectCompetitors || 'Unknown'}`);
    if (s.competitiveLandscape?.moatOpportunity) lines.push(`- Moat: ${s.competitiveLandscape.moatOpportunity}`);
    lines.push('');
    lines.push('**Risk & Validation**');
    lines.push(`- Assumption: ${s.riskAndValidation?.keyAssumption || 'TBD'}`);
    lines.push(`- Test: ${s.riskAndValidation?.howToTest || 'TBD'}`);
    lines.push(`- Red flags: ${(s.riskAndValidation?.redFlags || ['None']).join(' | ')}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

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

  // Top-level `idea-sketch` command — generate idea sketches from an existing report
  if (argv[0] === 'idea-sketch') {
    const { fileURLToPath: fu3 } = await import('node:url');
    const { dirname: dn3, resolve: res3 } = await import('node:path');
    const { readFileSync: rfs3, writeFileSync: wfs3 } = await import('node:fs');
    const { normalizeArgs: na3 } = await import('./lib/utils.mjs');
    const __dirname3 = dn3(fu3(import.meta.url));

    const args3 = na3(argv.slice(1));

    if (args3.help || argv.includes('--help')) {
      process.stderr.write(`
pain-points idea-sketch — Generate idea sketches from an existing report

Usage:
  pain-points idea-sketch --from-report <report.json> [--output <file>] [--format json|md]

Options:
  --from-report <path>  Input report JSON file (output of \`report --format json\`)
  --output <path>       Output file (default: stdout)
  --format <json|md>    Output format (default: json)
  --help                Show this help
`);
      process.exit(0);
    }

    const fromReport = args3.fromReport;
    if (!fromReport) {
      process.stderr.write('[idea-sketch] Missing --from-report <report.json>. Use --help for usage.\n');
      process.exit(1);
    }

    let reportData;
    try {
      reportData = JSON.parse(rfs3(res3(fromReport), 'utf8'));
    } catch (err) {
      process.stderr.write(`[idea-sketch] Cannot read "${fromReport}": ${err.message}\n`);
      process.exit(1);
    }

    const data = reportData?.data || reportData;
    const groups = data?.groups || [];

    if (groups.length === 0) {
      process.stderr.write('[idea-sketch] No pain categories found in report data.\n');
      process.exit(1);
    }

    // If the report already has ideaSketches, use those
    if (data?.ideaSketches?.length > 0) {
      const format3 = args3.format || 'json';
      let output3;
      if (format3 === 'md') {
        output3 = renderSketchesMd(data.ideaSketches);
      } else {
        output3 = JSON.stringify({ ok: true, data: { ideaSketches: data.ideaSketches } }, null, 2);
      }
      if (args3.output) {
        wfs3(res3(args3.output), output3, 'utf8');
        process.stderr.write(`[idea-sketch] Written ${data.ideaSketches.length} sketch(es) to ${args3.output}\n`);
      } else {
        process.stdout.write(output3 + '\n');
      }
      process.exit(0);
    }

    // Otherwise, generate sketches from groups
    const sketches = groups
      .filter(g => g.verdict === 'validated' || g.verdict === 'needs_evidence')
      .map(g => {
        const categoryName = g.category.replace(/-/g, ' ');
        const topQuoteBodies = (g.topQuotes || []).slice(0, 2).map(q => (q.body || '').replace(/\n/g, ' ').slice(0, 120)).filter(Boolean);
        const topTitles = (g.representativePosts || []).slice(0, 2).map(p => p.title).filter(Boolean);
        let problemStatement;
        if (topQuoteBodies.length > 0) {
          problemStatement = `Users are experiencing significant friction with ${categoryName}: "${topQuoteBodies[0]}." This pain is expressed across ${g.postCount} posts from ${g.crossSources} platform(s).`;
        } else if (topTitles.length > 0) {
          problemStatement = `Users repeatedly report problems with ${categoryName}, e.g. "${topTitles[0].slice(0, 100)}." ${g.postCount} posts across ${g.crossSources} source(s) confirm this.`;
        } else {
          problemStatement = `Users experience recurring frustration with ${categoryName} across ${g.postCount} posts and ${g.crossSources} platform(s).`;
        }

        const sourceLabels = (g.sourceNames || []).map(s => {
          if (s === 'reddit') return 'Reddit communities';
          if (s === 'hackernews') return 'Hacker News';
          if (s === 'google') return 'Google Search';
          if (s === 'appstore') return 'App Store / Play Store';
          if (s === 'producthunt') return 'Product Hunt';
          return s;
        }).join(', ');

        const mt = g.moneyTrail || { strength: 'none', totalCount: 0, examples: [] };
        let currentSpending;
        if (mt.strength === 'strong') currentSpending = `Strong spending signals (${mt.totalCount} WTP instances).`;
        else if (mt.strength === 'moderate') currentSpending = `Moderate spending signals (${mt.totalCount} WTP instances).`;
        else if (mt.strength === 'weak') currentSpending = `Weak spending signals (${mt.totalCount} instance).`;
        else currentSpending = 'No direct spending signals found.';

        const solBodies = (g.solutionAttempts || []).slice(0, 3).map(s => (typeof s === 'string' ? s : s.body || '').replace(/\n/g, ' ').slice(0, 150));
        const tools = g.tools || [];
        const coreFeature = solBodies.length > 0
          ? `Address the gap: "${solBodies[0]}." Build the feature that eliminates this friction.`
          : `Build a focused tool for the core ${categoryName} frustration.`;
        const whyFail = tools.length > 0
          ? `Tools like ${tools.slice(0, 3).join(', ')} exist but don't fully solve the problem.`
          : 'No established tools mentioned — market appears underserved.';

        const redFlags = [];
        if (mt.strength === 'none') redFlags.push('No WTP signals.');
        if (g.crossSources < 2) redFlags.push(`Only ${g.crossSources} source.`);
        if (g.depth === 'surface') redFlags.push('Surface-level pain only.');
        if (g.postCount < 3) redFlags.push(`Low volume (${g.postCount} posts).`);
        if (redFlags.length === 0) redFlags.push('No major red flags.');

        return {
          category: g.category,
          verdict: g.verdict,
          verdictLabel: g.verdict === 'validated' ? 'Validated' : 'Needs More Evidence',
          buildScore: g.buildScore,
          problemStatement,
          targetCustomer: { who: g.audience || `People frustrated with ${categoryName}`, whereTheyHangOut: sourceLabels, currentSpending },
          solutionConcept: { coreFeature, whyExistingFail: whyFail },
          businessModel: { pricing: mt.totalCount >= 2 ? `Users show WTP (${mt.totalCount} signals).` : 'Validate WTP before committing.', revenueModel: 'SaaS / freemium', estimatedWtp: `${mt.totalCount >= 5 ? 'High' : mt.totalCount >= 2 ? 'Moderate' : mt.totalCount >= 1 ? 'Low' : 'Unknown'} (${mt.totalCount} signals)` },
          goToMarket: { launchChannel: sourceLabels, first100: (g.sourceNames || []).includes('reddit') ? 'Engage in Reddit communities where pain was found.' : `Reach out on ${g.sourceNames?.[0] || 'the platform'}.` },
          competitiveLandscape: { directCompetitors: tools.length > 0 ? tools.join(', ') : 'None identified.', indirectCompetitors: solBodies.length > 0 ? solBodies.join('; ') : 'No structured workarounds.' },
          riskAndValidation: { keyAssumption: mt.strength === 'none' ? 'Users will pay.' : 'Pain drives adoption.', howToTest: mt.strength === 'none' ? 'Landing page + email capture.' : 'Rapid prototype or survey.', redFlags },
        };
      });

    if (sketches.length === 0) {
      process.stderr.write('[idea-sketch] No validated or needs-evidence categories found.\n');
      process.exit(0);
    }

    const format3 = args3.format || 'json';
    let output3;
    if (format3 === 'md') {
      output3 = renderSketchesMd(sketches);
    } else {
      output3 = JSON.stringify({ ok: true, data: { ideaSketches: sketches } }, null, 2);
    }

    if (args3.output) {
      wfs3(res3(args3.output), output3, 'utf8');
      process.stderr.write(`[idea-sketch] Written ${sketches.length} sketch(es) to ${args3.output}\n`);
    } else {
      process.stdout.write(output3 + '\n');
    }
    process.exit(0);
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

  // Top-level `llm` command — LLM augmentation
  if (argv[0] === 'llm') {
    const subCmd = argv[1];
    if (subCmd === '--help' || !subCmd) {
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const __dirname3 = dirname(fileURLToPath(import.meta.url));
      const { spawn: sp3 } = await import('node:child_process');
      const llmCmdPath = resolve(__dirname3, 'llm-augment.mjs');
      const child3 = sp3(process.execPath, [llmCmdPath, '--help'], { stdio: 'inherit' });
      child3.on('exit', code => process.exit(code ?? 0));
      return;
    }
    if (subCmd === 'prompt' || subCmd === 'apply' || subCmd === 'augment') {
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const __dirname3 = dirname(fileURLToPath(import.meta.url));
      const { spawn: sp3 } = await import('node:child_process');
      const llmCmdPath = resolve(__dirname3, 'llm-augment.mjs');
      // Pass the subcommand as first arg, then remaining args
      const child3 = sp3(process.execPath, [llmCmdPath, subCmd, ...argv.slice(2)], {
        stdio: 'inherit',
      });
      child3.on('exit', code => process.exit(code ?? 0));
      return;
    }
    log(`Unknown llm subcommand: "${subCmd}". Available: prompt, apply, augment`);
    process.exit(1);
  }

  // Top-level `setup` command — delegate to setup.mjs
  if (argv[0] === 'setup') {
    const { normalizeArgs: na4 } = await import('./lib/utils.mjs');
    const { runSetup } = await import('./setup.mjs');
    const args4 = na4(argv.slice(1));
    if (argv.includes('--help')) args4.help = true;
    await runSetup(args4);
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
  hn        Hacker News (scan, deep-dive, frontpage)
  reviews   G2 / Capterra / Trustpilot review scraper
  ph        Product Hunt
  crowdfunding  Kickstarter / Indiegogo
  appstore  App Store / Play Store reviews
  websearch Web search — blogs, forums, and wider web via Google SERP
  twitter   Twitter/X — Nitter + browser scraping
  trustpilot Trustpilot — review scraping (1-3 star)
  so        Stack Overflow — Stack Exchange API
  gh-issues GitHub Issues — GitHub Search API

Commands by source:
  all:      scan
  api:      discover, scan, deep-dive
  browser:  scan, deep-dive

Report command (Phases 4-8 synthesis):
  pain-points report --files reddit-scan.json,hn-scan.json [--format md|json]

Idea sketch command (standalone from existing report):
  pain-points idea-sketch --from-report report.json [--output file] [--format json|md]

Web report command (beautiful HTML dashboard):
  pain-points web-report --input report.json --output report.html
  pain-points web-report --input report.json --serve 8080

LLM augmentation command (no API key needed — uses Claude Code agent):
  pain-points llm prompt --from-scan scan.json --domain "project management" --top 50
  pain-points llm apply --from-scan scan.json --analysis analysis.json

Monitor command (continuous scanning with delta detection):
  pain-points monitor --config domains.json --once
  pain-points monitor --config domains.json --interval 6h
  pain-points monitor --config domains.json --domain scalper-bot --once
  pain-points monitor --config domains.json --once --serve 8080        (scan once + serve live dashboard)
  pain-points monitor --config domains.json --interval 6h --serve 8080 (scan every 6h + live dashboard)

Examples:
  pain-points hn frontpage --limit 30 --top 10
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

main().catch(async err => {
  try {
    const { handleError } = await import('./lib/errors.mjs');
    handleError(err, 'fatal');
  } catch {
    console.log(JSON.stringify({ ok: false, error: { message: err.message } }, null, 2));
    process.exit(1);
  }
});
