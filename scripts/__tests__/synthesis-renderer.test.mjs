/**
 * Renderer tests — renderMarkdown, renderJson, formatPainGroup output shapes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMarkdown,
  renderJson,
  formatPainGroup,
  renderDataCollectionWarnings,
} from '../lib/report/markdown-renderer.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGroup(overrides = {}) {
  return {
    category: 'product-availability',
    postCount: 5,
    crossSources: 2,
    sourceNames: ['reddit', 'hackernews'],
    depth: 'urgent',
    frequency: 9,
    intensityScore: 3.2,
    matrix: 'primary',
    moneyTrail: { strength: 'strong', totalCount: 8, examples: [{ body: 'Would pay $10/mo' }] },
    unspokenPain: [{ body: 'Users want fairness not just price reduction' }],
    tools: ['AXS', 'DICE'],
    topQuotes: [
      { body: 'The system is broken', score: 200, url: 'https://example.com/q1', citeKey: 'RD-q1' },
    ],
    solutionAttempts: [
      { body: 'Built my own alert system but still fails', url: 'https://example.com/s1' },
    ],
    totalComments: 500,
    totalScore: 5000,
    buildScore: 85,
    verdict: 'validated',
    representativePosts: [
      { title: 'Bots ruining ticketing', url: 'https://example.com/p1', score: 3500, num_comments: 455, source: 'reddit', citeKey: 'RD-p1' },
    ],
    categoryCiteKeys: ['RD-q1', 'RD-p1'],
    audience: 'Concert-goers frustrated by bot-dominated ticket sales',
    llmEnhanced: false,
    llmAugmentedCount: 0,
    implicitPainSignals: [],
    targetPersonas: [],
    ...overrides,
  };
}

function makeMeta(overrides = {}) {
  return {
    sources: ['reddit', 'hackernews'],
    totalPosts: 10,
    categoriesFound: 2,
    ...overrides,
  };
}

// ─── renderMarkdown ──────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  it('returns a non-empty string', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.length > 0);
  });

  it('contains report title', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('Pain Point Synthesis Report'));
  });

  it('contains executive summary', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('Executive Summary'));
  });

  it('contains all phase sections', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('Phase 4'));
    assert.ok(md.includes('Phase 5'));
    assert.ok(md.includes('Phase 6'));
    assert.ok(md.includes('Phase 7'));
  });

  it('contains the category name', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('product-availability'));
  });

  it('includes verdict badge for validated group', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('VALIDATED'));
  });

  it('includes final ranking table', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('Final Ranking'));
    assert.ok(md.includes('Build Score'));
  });

  it('includes source names in metadata', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('reddit'));
    assert.ok(md.includes('hackernews'));
  });

  it('renders multiple groups sorted by build score', () => {
    const groups = [
      makeGroup({ category: 'low-score', buildScore: 20, verdict: 'too_weak' }),
      makeGroup({ category: 'high-score', buildScore: 90, verdict: 'validated' }),
    ];
    const md = renderMarkdown(groups, makeMeta());
    assert.ok(md.includes('low-score'));
    assert.ok(md.includes('high-score'));
  });

  it('includes What to Build section when validated group exists', () => {
    const md = renderMarkdown([makeGroup()], makeMeta());
    assert.ok(md.includes('What to Build'));
  });

  it('shows weak signals appendix for 1-post groups', () => {
    const groups = [
      makeGroup({ postCount: 1, category: 'weak-cat', verdict: 'too_weak' }),
    ];
    const md = renderMarkdown(groups, makeMeta());
    assert.ok(md.includes('Weak Signals'));
  });

  it('includes LLM badge for LLM-enhanced groups', () => {
    const md = renderMarkdown([makeGroup({ llmEnhanced: true })], makeMeta());
    assert.ok(md.includes('LLM-Enhanced'));
  });
});

// ─── renderJson ──────────────────────────────────────────────────────────────

describe('renderJson', () => {
  it('returns valid JSON string', () => {
    const json = renderJson([makeGroup()], makeMeta());
    const parsed = JSON.parse(json);
    assert.ok(parsed);
  });

  it('has correct top-level structure', () => {
    const parsed = JSON.parse(renderJson([makeGroup()], makeMeta()));
    assert.equal(parsed.ok, true);
    assert.ok(parsed.data);
    assert.ok(parsed.data.generated);
    assert.ok(parsed.data.meta);
    assert.ok(parsed.data.groups);
  });

  it('includes meta information', () => {
    const parsed = JSON.parse(renderJson([makeGroup()], makeMeta()));
    assert.deepEqual(parsed.data.meta.sources, ['reddit', 'hackernews']);
    assert.equal(parsed.data.meta.totalPosts, 10);
  });

  it('preserves group data', () => {
    const parsed = JSON.parse(renderJson([makeGroup()], makeMeta()));
    const group = parsed.data.groups[0];
    assert.equal(group.category, 'product-availability');
    assert.equal(group.buildScore, 85);
    assert.equal(group.verdict, 'validated');
  });

  it('builds evidenceCorpus from allPosts when provided', () => {
    const allPosts = [
      {
        _citeKey: 'RD-abc',
        title: 'Test post title',
        url: 'https://example.com/1',
        _source: 'reddit',
        score: 100,
        created_utc: 1700000000,
        num_comments: 50,
        subreddit: 'concerts',
        _category: 'product-availability',
      },
      {
        _citeKey: 'HN-def',
        title: 'Another post',
        url: 'https://example.com/2',
        _source: 'hackernews',
        score: 200,
        num_comments: 30,
        subreddit: 'hackernews',
        _category: 'pricing',
      },
    ];
    const parsed = JSON.parse(renderJson([makeGroup()], makeMeta(), { allPosts }));
    assert.ok(parsed.data.evidenceCorpus);
    assert.ok(parsed.data.evidenceCorpus['RD-abc']);
    assert.ok(parsed.data.evidenceCorpus['HN-def']);
    assert.equal(parsed.data.evidenceCorpus['RD-abc'].title, 'Test post title');
    assert.equal(parsed.data.evidenceCorpus['RD-abc'].source, 'reddit');
    assert.equal(parsed.data.evidenceCorpus['HN-def'].score, 200);
  });

  it('skips posts without _citeKey in evidenceCorpus', () => {
    const allPosts = [
      { title: 'No cite key', url: 'https://example.com', _source: 'reddit' },
      { _citeKey: 'HAS-key', title: 'Has key', url: 'https://example.com/2', _source: 'reddit' },
    ];
    const parsed = JSON.parse(renderJson([makeGroup()], makeMeta(), { allPosts }));
    assert.ok(parsed.data.evidenceCorpus);
    assert.ok(parsed.data.evidenceCorpus['HAS-key']);
    assert.equal(Object.keys(parsed.data.evidenceCorpus).length, 1);
  });

  it('does not include evidenceCorpus when allPosts not provided', () => {
    const parsed = JSON.parse(renderJson([makeGroup()], makeMeta()));
    assert.equal(parsed.data.evidenceCorpus, undefined);
  });

  it('does not include evidenceCorpus when allPosts is empty', () => {
    const parsed = JSON.parse(renderJson([makeGroup()], makeMeta(), { allPosts: [] }));
    assert.equal(parsed.data.evidenceCorpus, undefined);
  });

  it('includes rateMonitorSummary when present in meta', () => {
    const meta = makeMeta({
      rateMonitorSummary: {
        warnings: [{ source: 'reddit', message: 'Rate limited' }],
        blocks: [],
        errors: [],
      },
    });
    const parsed = JSON.parse(renderJson([makeGroup()], meta));
    assert.ok(parsed.data.dataCollectionWarnings);
    assert.equal(parsed.data.dataCollectionWarnings.warnings.length, 1);
  });
});

// ─── formatPainGroup ─────────────────────────────────────────────────────────

describe('formatPainGroup', () => {
  it('produces markdown lines with correct sections', () => {
    const lines = [];
    formatPainGroup(makeGroup(), lines);
    const text = lines.join('\n');
    assert.ok(text.includes('### product-availability'));
    assert.ok(text.includes('VALIDATED'));
    assert.ok(text.includes('Build Score'));
    assert.ok(text.includes('Problem'));
    assert.ok(text.includes('Depth'));
    assert.ok(text.includes('Matrix Position'));
    assert.ok(text.includes('Cross-source'));
    assert.ok(text.includes('Who feels this'));
    assert.ok(text.includes('Money trail'));
  });

  it('includes user quotes when available', () => {
    const lines = [];
    formatPainGroup(makeGroup(), lines);
    const text = lines.join('\n');
    assert.ok(text.includes('Evidence'));
    assert.ok(text.includes('system is broken'));
  });

  it('includes competitive landscape', () => {
    const lines = [];
    formatPainGroup(makeGroup(), lines);
    const text = lines.join('\n');
    assert.ok(text.includes('AXS'));
    assert.ok(text.includes('DICE'));
  });

  it('includes unspoken pain when present', () => {
    const lines = [];
    formatPainGroup(makeGroup(), lines);
    const text = lines.join('\n');
    assert.ok(text.includes('Unspoken pain'));
    assert.ok(text.includes('fairness'));
  });
});

// ─── renderDataCollectionWarnings ────────────────────────────────────────────

describe('renderDataCollectionWarnings', () => {
  it('does nothing when summary is null', () => {
    const lines = [];
    renderDataCollectionWarnings(null, lines);
    assert.equal(lines.length, 0);
  });

  it('does nothing when all arrays are empty', () => {
    const lines = [];
    renderDataCollectionWarnings({ warnings: [], blocks: [], errors: [] }, lines);
    assert.equal(lines.length, 0);
  });

  it('renders warning table for blocks', () => {
    const lines = [];
    renderDataCollectionWarnings({
      warnings: [],
      blocks: [{ source: 'reddit', message: '429 Too Many Requests' }],
      errors: [],
    }, lines);
    const text = lines.join('\n');
    assert.ok(text.includes('Data Collection Warnings'));
    assert.ok(text.includes('reddit'));
    assert.ok(text.includes('Partial results'));
  });

  it('renders per-source breakdown', () => {
    const lines = [];
    renderDataCollectionWarnings({
      warnings: [{ source: 'hackernews', message: 'Slow response' }],
      blocks: [],
      errors: [{ source: 'reddit', message: 'Connection reset' }],
    }, lines);
    const text = lines.join('\n');
    assert.ok(text.includes('reddit'));
    assert.ok(text.includes('hackernews'));
  });
});
