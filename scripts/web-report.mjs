#!/usr/bin/env node

/**
 * web-report.mjs — Pain discovery research document generator (thin orchestrator)
 *
 * Delegates to:
 *   - lib/web-report/html-generator.mjs — section builders
 *   - lib/web-report/svg-charts.mjs     — SVG chart generators
 *   - lib/web-report/styling.mjs        — CSS and JS strings
 *   - lib/web-report/helpers.mjs        — shared helpers and constants
 *
 * Usage:
 *   pain-points web-report --input report.json --output report.html
 *   pain-points web-report --input report.json --serve 8080
 */

import { readFileSync, writeFileSync, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { normalizeArgs, log } from './lib/utils.mjs';
import { escHtml } from './lib/web-report/helpers.mjs';
import {
  buildHero, buildCategoryCards,
  buildSourceCoverage, buildEvidenceWall, buildDataWarnings,
} from './lib/web-report/html-generator.mjs';
import { buildCss, buildJs } from './lib/web-report/styling.mjs';

// ─── HTML assembler ───────────────────────────────────────────────────────────

function generateHtml(reportData, generatedAt = new Date().toISOString()) {
  const data = reportData.data || reportData;
  const meta = data.meta || {};
  const groups = (data.groups || []).sort((a, b) => (b.buildScore || 0) - (a.buildScore || 0));

  if (!groups.length) throw new Error('No pain categories found in report data.');

  const navItems = [
    ['#hero', 'Summary'],
    ['#categories', 'Pain Points'],
    ['#sources', 'Sources'],
    ['#evidence', 'Evidence'],
  ];
  if (meta.rateMonitorSummary) {
    navItems.push(['#warnings', 'Warnings']);
  }
  const navLinks = navItems
    .map(([href, label]) => `<a class="nav-link" href="${href}">${label}</a>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Pain discovery research report">
  <title>Pain Discovery Report</title>
  <style>${buildCss()}</style>
</head>
<body>
  <nav class="topnav">
    <span class="nav-brand">pain-points</span>
    ${navLinks}
    <button class="theme-toggle" id="themeToggle">\u2600 Light</button>
  </nav>
  <div class="container">
    ${buildHero(data)}
    ${buildCategoryCards(groups)}
    ${buildSourceCoverage(meta, groups)}
    ${buildEvidenceWall(groups)}
    ${buildDataWarnings(meta)}
    <footer class="report-footer">
      Generated ${new Date(generatedAt).toLocaleString()} &nbsp;&middot;&nbsp;
      ${meta.totalPosts || '?'} posts &nbsp;&middot;&nbsp;
      ${(meta.sources || []).join(', ')}
    </footer>
  </div>
  <script>${buildJs()}</script>
</body>
</html>`;
}

// ─── I/O helpers ──────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((res, rej) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      try { res(JSON.parse(buf)); } catch (e) { rej(new Error('Stdin is not valid JSON: ' + e.message)); }
    });
    process.stdin.on('error', rej);
  });
}

// ─── Dev server ───────────────────────────────────────────────────────────────

async function startDevServer(port, inputPath, outputPath) {
  let htmlContent = '';

  async function regen() {
    try {
      const data = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
      htmlContent = generateHtml(data);
      if (outputPath) writeFileSync(resolve(outputPath), htmlContent, 'utf8');
      log(`[web-report] Regenerated HTML (${(htmlContent.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      log(`[web-report] Error regenerating: ${err.message}`);
    }
  }

  await regen();

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      const withReload = htmlContent.replace(
        '</body>',
        `<script>
          let lastSize = ${htmlContent.length};
          setInterval(async () => {
            const r = await fetch('/size');
            const size = await r.json();
            if (size !== lastSize) { lastSize = size; location.reload(); }
          }, 1500);
        </script></body>`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(withReload);
    } else if (req.url === '/size') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(htmlContent.length));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    log(`[web-report] Dev server running at http://localhost:${port}`);
    log(`[web-report] Watching ${inputPath} for changes\u2026`);
  });

  watchFile(resolve(inputPath), { interval: 1000 }, async () => {
    log(`[web-report] Input file changed, regenerating\u2026`);
    await regen();
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = normalizeArgs(argv);

  const helpText = `
pain-points web-report — Generate a pain discovery research document (HTML)

Usage:
  pain-points web-report --input report.json --output report.html
  pain-points web-report --input report.json --serve 8080

Options:
  --input   <path>  Input JSON report file (or omit to read stdin)
  --output  <path>  Output HTML file (default: report.html)
  --serve   <port>  Start dev server on this port (with auto-reload)
  --help            Show this help
`;

  if (args.help || argv.includes('--help')) {
    log(helpText);
    process.exit(0);
  }

  const inputPath = args.input;
  const outputPath = args.output || 'report.html';
  const servePort = args.serve ? parseInt(args.serve, 10) : null;

  let reportData;
  if (inputPath) {
    try {
      reportData = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
    } catch (err) {
      log(`[web-report] Cannot read input file "${inputPath}": ${err.message}`);
      process.exit(1);
    }
  } else {
    const isTTY = process.stdin.isTTY;
    if (isTTY) {
      log('[web-report] No --input file. Pipe JSON via stdin or use --input. See --help.');
      process.exit(1);
    }
    reportData = await readStdin();
  }

  if (servePort) {
    await startDevServer(servePort, inputPath || '-', outputPath);
    return;
  }

  let html;
  try {
    html = generateHtml(reportData, reportData.data?.generated);
  } catch (err) {
    log(`[web-report] Error generating HTML: ${err.message}`);
    process.exit(1);
  }

  const outPath = resolve(outputPath);
  writeFileSync(outPath, html, 'utf8');
  log(`[web-report] Report written to ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  log(`[web-report] Fatal: ${err.message}`);
  process.exit(1);
});

// ─── export for piping ────────────────────────────────────────────────────────
export { generateHtml };
