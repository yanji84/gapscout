/**
 * Web report tests — buildCategoryCards, buildHero, buildSourceCoverage,
 * buildEvidenceWall, buildDataWarnings, buildEvidenceStore, buildVerificationSummary,
 * generateHtml
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHero,
  buildCategoryCards,
  buildSourceCoverage,
  buildEvidenceWall,
  buildDataWarnings,
  buildEvidenceStore,
  buildVerificationSummary,
} from '../lib/web-report/html-generator.mjs';
import { buildCss, buildJs } from '../lib/web-report/styling.mjs';
import { escHtml } from '../lib/web-report/helpers.mjs';

// We cannot import generateHtml from web-report.mjs directly because it has
// a top-level main() call that reads stdin/exits. Instead we replicate the
// generateHtml function inline (same logic as web-report.mjs lines 31-82).
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
  ${buildEvidenceStore(data)}
  <nav class="topnav">
    <span class="nav-brand">pain-points</span>
    ${navLinks}
    <button class="theme-toggle" id="themeToggle">\u2600 Light</button>
  </nav>
  <div class="container">
    ${buildHero(data)}
    ${buildVerificationSummary(data)}
    ${buildCategoryCards(groups, data)}
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

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGroup(overrides = {}) {
  return {
    category: 'product-availability',
    postCount: 10,
    crossSources: 2,
    sourceNames: ['reddit', 'hackernews'],
    depth: 'urgent',
    buildScore: 85,
    verdict: 'validated',
    audience: 'Concert-goers frustrated by bot-dominated ticket sales',
    topQuotes: [
      { body: 'The system is broken for fans', score: 200, url: 'https://example.com/q1', source: 'reddit' },
      { body: 'Bots buy everything in seconds', score: 150, url: 'https://example.com/q2', source: 'hackernews' },
    ],
    representativePosts: [
      { title: 'Bots ruining ticketing', url: 'https://example.com/p1', score: 3500, num_comments: 455, source: 'reddit' },
    ],
    solutionAttempts: [],
    categoryCiteKeys: ['RD-abc', 'HN-def'],
    moneyTrail: { strength: 'strong', totalCount: 8, examples: [] },
    tools: ['AXS', 'DICE'],
    unspokenPain: [],
    ...overrides,
  };
}

function makeReportData(overrides = {}) {
  return {
    generated: '2025-01-15T12:00:00Z',
    meta: {
      sources: ['reddit', 'hackernews'],
      totalPosts: 20,
      categoriesFound: 2,
    },
    groups: [makeGroup()],
    evidenceCorpus: {
      'RD-abc': {
        title: 'Bot problem post',
        url: 'https://example.com/p1',
        source: 'reddit',
        score: 3500,
        date: '2023-11-15',
        quote: 'Bots are buying all the tickets',
        num_comments: 455,
        subreddit: 'concerts',
        category: 'product-availability',
      },
      'HN-def': {
        title: 'Fair queue system',
        url: 'https://example.com/p2',
        source: 'hackernews',
        score: 890,
        date: '2023-11-16',
        quote: 'We built a better ticketing system',
        num_comments: 234,
        subreddit: 'hackernews',
        category: 'product-availability',
      },
    },
    ...overrides,
  };
}

// ─── buildHero ───────────────────────────────────────────────────────────────

describe('buildHero', () => {
  it('returns HTML string with hero section', () => {
    const html = buildHero(makeReportData());
    assert.ok(html.includes('hero'));
    assert.ok(html.includes('Pain Discovery Report'));
  });

  it('includes KPI values from meta', () => {
    const html = buildHero(makeReportData());
    assert.ok(html.includes('20'), 'Should include totalPosts');
    assert.ok(html.includes('2'), 'Should include source count');
  });

  it('includes formatted date', () => {
    const html = buildHero(makeReportData());
    // The date should be rendered in some form
    assert.ok(html.includes('2025') || html.includes('January'));
  });
});

// ─── buildCategoryCards ──────────────────────────────────────────────────────

describe('buildCategoryCards', () => {
  it('returns HTML with category cards section', () => {
    const data = makeReportData();
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('cat-card'));
    assert.ok(html.includes('product-availability') || html.includes('product availability'));
  });

  it('includes depth badge', () => {
    const data = makeReportData();
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('depth-badge'));
    assert.ok(html.includes('data-depth="urgent"'));
  });

  it('includes source badges', () => {
    const data = makeReportData();
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('source-badge'));
    assert.ok(html.includes('data-source="reddit"'));
  });

  it('includes cited quotes with links', () => {
    const data = makeReportData();
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('cited-quote'));
    assert.ok(html.includes('https://example.com/q1'));
  });

  it('includes evidence drawer when corpus exists', () => {
    const data = makeReportData();
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('evidence-details') || html.includes('evidence-drawer'));
  });

  it('includes signal strength badge', () => {
    const data = makeReportData();
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('signal-badge'));
  });

  it('renders multiple cards for multiple groups', () => {
    const data = makeReportData({
      groups: [
        makeGroup({ category: 'product-availability' }),
        makeGroup({ category: 'pricing', depth: 'active' }),
      ],
    });
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('product-availability') || html.includes('product availability'));
    assert.ok(html.includes('pricing'));
  });

  it('handles group with no quotes gracefully', () => {
    const data = makeReportData({
      groups: [makeGroup({ topQuotes: [], representativePosts: [] })],
    });
    const html = buildCategoryCards(data.groups, data);
    assert.ok(html.includes('cat-card'));
  });
});

// ─── buildSourceCoverage ─────────────────────────────────────────────────────

describe('buildSourceCoverage', () => {
  it('lists all sources from meta', () => {
    const data = makeReportData();
    const html = buildSourceCoverage(data.meta, data.groups);
    assert.ok(html.includes('Source Coverage'));
    assert.ok(html.includes('reddit'));
    assert.ok(html.includes('hackernews'));
  });

  it('shows contributed status for sources with posts', () => {
    const data = makeReportData();
    const html = buildSourceCoverage(data.meta, data.groups);
    assert.ok(html.includes('contributed'));
  });
});

// ─── buildEvidenceWall ───────────────────────────────────────────────────────

describe('buildEvidenceWall', () => {
  it('renders evidence cards from group quotes and posts', () => {
    const html = buildEvidenceWall([makeGroup()]);
    assert.ok(html.includes('Evidence Wall'));
    assert.ok(html.includes('evidence-card'));
  });

  it('includes filter buttons', () => {
    const html = buildEvidenceWall([makeGroup()]);
    assert.ok(html.includes('filter-btn'));
  });

  it('returns empty string when no evidence has URLs', () => {
    const group = makeGroup({
      topQuotes: [{ body: 'No URL quote', score: 10 }],
      representativePosts: [{ title: 'No URL post', score: 5 }],
    });
    const html = buildEvidenceWall([group]);
    assert.equal(html, '');
  });
});

// ─── buildDataWarnings ───────────────────────────────────────────────────────

describe('buildDataWarnings', () => {
  it('returns empty string when no rateMonitorSummary', () => {
    assert.equal(buildDataWarnings({}), '');
  });

  it('returns empty string when all arrays empty', () => {
    assert.equal(buildDataWarnings({
      rateMonitorSummary: { warnings: [], blocks: [], errors: [] },
    }), '');
  });

  it('renders warning rows for issues', () => {
    const html = buildDataWarnings({
      rateMonitorSummary: {
        warnings: [{ source: 'reddit', message: 'Rate limited' }],
        blocks: [{ source: 'hackernews', message: 'Blocked' }],
        errors: [],
      },
    });
    assert.ok(html.includes('Data Collection Warnings'));
    assert.ok(html.includes('reddit'));
    assert.ok(html.includes('hackernews'));
    assert.ok(html.includes('Partial results'));
  });
});

// ─── buildEvidenceStore ──────────────────────────────────────────────────────

describe('buildEvidenceStore', () => {
  it('embeds corpus as JSON script tag', () => {
    const data = makeReportData();
    const html = buildEvidenceStore(data);
    assert.ok(html.includes('evidence-store'));
    assert.ok(html.includes('application/json'));
    assert.ok(html.includes('RD-abc'));
  });

  it('returns empty string when no corpus', () => {
    assert.equal(buildEvidenceStore({ evidenceCorpus: {} }), '');
    assert.equal(buildEvidenceStore({}), '');
  });
});

// ─── buildVerificationSummary ────────────────────────────────────────────────

describe('buildVerificationSummary', () => {
  it('shows verification count', () => {
    const data = makeReportData();
    const html = buildVerificationSummary(data);
    assert.ok(html.includes('citation'));
    assert.ok(html.includes('verified'));
  });

  it('counts verified keys from groups against corpus', () => {
    const data = makeReportData();
    const html = buildVerificationSummary(data);
    // Both RD-abc and HN-def are in categoryCiteKeys and corpus
    assert.ok(html.includes('2 verified'));
  });

  it('returns empty string when no corpus', () => {
    assert.equal(buildVerificationSummary({ groups: [], evidenceCorpus: {} }), '');
  });
});

// ─── buildCss / buildJs ──────────────────────────────────────────────────────

describe('styling', () => {
  it('buildCss returns non-empty CSS string', () => {
    const css = buildCss();
    assert.ok(css.length > 100);
    assert.ok(css.includes(':root'));
    assert.ok(css.includes('--bg'));
  });

  it('buildJs returns non-empty JS string', () => {
    const js = buildJs();
    assert.ok(js.length > 100);
    assert.ok(js.includes('themeToggle'));
  });
});

// ─── generateHtml (full HTML generation) ─────────────────────────────────────

describe('generateHtml', () => {
  it('returns a complete HTML document', () => {
    const data = makeReportData();
    const html = generateHtml({ data });
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<html'));
    assert.ok(html.includes('</html>'));
  });

  it('includes all major sections', () => {
    const data = makeReportData();
    const html = generateHtml({ data });
    assert.ok(html.includes('hero'));
    assert.ok(html.includes('categories'));
    assert.ok(html.includes('sources'));
    assert.ok(html.includes('evidence'));
  });

  it('includes navigation', () => {
    const data = makeReportData();
    const html = generateHtml({ data });
    assert.ok(html.includes('nav'));
    assert.ok(html.includes('pain-points'));
  });

  it('includes CSS and JS', () => {
    const data = makeReportData();
    const html = generateHtml({ data });
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('<script>'));
  });

  it('throws when no groups present', () => {
    assert.throws(() => {
      generateHtml({ data: { meta: {}, groups: [] } });
    }, /No pain categories/);
  });

  it('includes warnings nav link when rateMonitorSummary present', () => {
    const data = makeReportData();
    data.meta.rateMonitorSummary = {
      warnings: [{ source: 'reddit', message: 'Rate limited' }],
      blocks: [],
      errors: [],
    };
    const html = generateHtml({ data });
    assert.ok(html.includes('#warnings'));
    assert.ok(html.includes('Warnings'));
  });
});
