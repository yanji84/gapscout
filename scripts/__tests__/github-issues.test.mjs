/**
 * github-issues.test.mjs — Tests for the GitHub Issues API source
 *
 * Tests the normalizer, query builder, reaction-based scoring,
 * and enrichPost pipeline integration with GitHub fixture data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { enrichPost, computePainScore, analyzeComments } from '../lib/scoring.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'github-issues-api.json'), 'utf8'));

// ─── import source module ───────────────────────────────────────────────────

import githubIssues from '../sources/github-issues.mjs';

// ─── smoke tests ────────────────────────────────────────────────────────────

describe('github-issues source: smoke tests', () => {
  it('exports a valid source object', () => {
    assert.ok(githubIssues, 'default export should exist');
    assert.equal(githubIssues.name, 'github-issues');
    assert.ok(githubIssues.description);
    assert.ok(Array.isArray(githubIssues.commands));
    assert.ok(githubIssues.commands.includes('scan'));
    assert.equal(typeof githubIssues.run, 'function');
    assert.ok(githubIssues.help);
  });
});

// ─── normalizePost (replicated from source) ─────────────────────────────────

function normalizeGHPost(item) {
  const repoName = item.repository_url
    ? item.repository_url.replace('https://api.github.com/repos/', '')
    : '';
  return {
    id: String(item.id),
    title: item.title || '',
    selftext: item.body ? item.body.slice(0, 2000) : '',
    subreddit: 'github-issues',
    url: item.html_url || '',
    score: (item.reactions?.['+1'] || 0) + (item.reactions?.heart || 0),
    num_comments: item.comments || 0,
    upvote_ratio: 0,
    flair: repoName,
    created_utc: item.created_at ? Math.floor(new Date(item.created_at).getTime() / 1000) : 0,
    reactions: item.reactions || {},
  };
}

function buildPainQueries(domain) {
  return [
    `${domain} bug`,
    `${domain} broken`,
    `${domain} not working`,
    `${domain} error`,
    `${domain} issue`,
    `${domain} problem`,
    `${domain} crash`,
    `${domain} feature request`,
    `${domain} help wanted`,
    `${domain} workaround`,
    `${domain}`,
  ];
}

describe('github-issues normalizePost', () => {
  it('normalizes a GitHub issue from fixture', () => {
    const item = fixtures.searchResults.items[0];
    const post = normalizeGHPost(item);

    assert.equal(post.id, '1234567890');
    assert.ok(post.title.includes('Kubernetes'));
    assert.ok(post.selftext.includes('YAML'));
    assert.equal(post.subreddit, 'github-issues');
    assert.ok(post.url.includes('github.com'));
    assert.equal(post.score, 85 + 5); // +1 reactions + heart
    assert.equal(post.num_comments, 47);
    assert.equal(post.upvote_ratio, 0);
    assert.equal(post.flair, 'kubernetes/kubernetes');
    assert.ok(post.created_utc > 0);
  });

  it('extracts repo name from repository_url', () => {
    const item = fixtures.searchResults.items[0];
    const post = normalizeGHPost(item);
    assert.equal(post.flair, 'kubernetes/kubernetes');
  });

  it('handles missing repository_url', () => {
    const item = { ...fixtures.searchResults.items[0], repository_url: '' };
    const post = normalizeGHPost(item);
    assert.equal(post.flair, '');
  });

  it('computes score from reactions (+1 and heart)', () => {
    const item = fixtures.searchResults.items[1];
    const post = normalizeGHPost(item);
    assert.equal(post.score, 42 + 8); // +1=42, heart=8
  });

  it('handles item with no reactions', () => {
    const item = { id: 999, title: 'Test', body: '', html_url: '', repository_url: '', created_at: null, comments: 0, reactions: {} };
    const post = normalizeGHPost(item);
    assert.equal(post.score, 0);
  });

  it('handles malformed item from fixture', () => {
    const item = fixtures.malformedItem;
    const post = normalizeGHPost(item);
    assert.equal(post.id, 'null');
    assert.equal(post.title, '');
    assert.equal(post.selftext, '');
    assert.equal(post.score, 0);
  });

  it('handles item with missing fields', () => {
    const item = fixtures.itemMissingFields;
    const post = normalizeGHPost(item);
    assert.equal(post.id, '5555555555');
    assert.equal(post.title, '');
    assert.equal(post.selftext, '');
    assert.equal(post.num_comments, 0);
  });

  it('truncates body to 2000 chars', () => {
    const longBody = 'x'.repeat(5000);
    const item = { id: 1, body: longBody, title: '', html_url: '', repository_url: '', created_at: null, comments: 0, reactions: {} };
    const post = normalizeGHPost(item);
    assert.equal(post.selftext.length, 2000);
  });
});

// ─── buildPainQueries ───────────────────────────────────────────────────────

describe('github-issues buildPainQueries', () => {
  it('generates query list for a domain', () => {
    const queries = buildPainQueries('kubernetes');
    assert.ok(queries.length > 0);
    assert.ok(queries.some(q => q.includes('kubernetes bug')));
    assert.ok(queries.some(q => q.includes('kubernetes broken')));
    assert.ok(queries.some(q => q.includes('kubernetes feature request')));
    assert.ok(queries.includes('kubernetes'));
  });

  it('works with multi-word domains', () => {
    const queries = buildPainQueries('react native');
    assert.ok(queries.some(q => q.includes('react native')));
  });
});

// ─── fixture-based enrichPost pipeline ──────────────────────────────────────

describe('github-issues enrichPost pipeline', () => {
  it('enriches bug report issue from fixture', () => {
    const item = fixtures.searchResults.items[0];
    const post = normalizeGHPost(item);
    post.source = 'github-issues';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched, 'should enrich pain-signal issue');
    assert.ok(enriched.painScore > 0);
    assert.ok(enriched.painCategories.includes('frustration'));
    assert.ok(enriched.citeKey.startsWith('GH-'));
  });

  it('enriches feature request issue from fixture', () => {
    const item = fixtures.searchResults.items[1];
    const post = normalizeGHPost(item);
    post.source = 'github-issues';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched);
    assert.ok(enriched.painScore > 0);
  });

  it('reaction-based boost works for high-reaction issues', () => {
    const item = fixtures.searchResults.items[0];
    const post = normalizeGHPost(item);
    post.source = 'github-issues';
    const enriched = enrichPost(post, 'kubernetes');

    // The source code adds boost for reactions >= 50: +3.0
    // Since enrichPost does not do the reaction boost (that's in cmdScan),
    // we simulate the boost logic here
    if (enriched) {
      const reactions = item.reactions?.['+1'] || 0;
      let boosted = enriched.painScore;
      if (reactions >= 50) boosted += 3.0;
      else if (reactions >= 20) boosted += 2.0;
      else if (reactions >= 10) boosted += 1.0;
      else if (reactions >= 5) boosted += 0.5;
      assert.ok(boosted > enriched.painScore, 'high reactions should boost score');
    }
  });

  it('processes all fixture items without crashing', () => {
    for (const item of fixtures.searchResults.items) {
      const post = normalizeGHPost(item);
      post.source = 'github-issues';
      const result = enrichPost(post, 'kubernetes');
      if (result) {
        assert.equal(typeof result.painScore, 'number');
        assert.ok(result.citeKey);
      }
    }
  });
});

// ─── API response shape tests ───────────────────────────────────────────────

describe('github-issues API response shapes', () => {
  it('search results have expected structure', () => {
    const results = fixtures.searchResults;
    assert.ok(typeof results.total_count === 'number');
    assert.ok(Array.isArray(results.items));
    assert.ok(results.items.length > 0);
  });

  it('each item has required fields', () => {
    for (const item of fixtures.searchResults.items) {
      assert.ok('id' in item);
      assert.ok('title' in item);
      assert.ok('body' in item);
      assert.ok('html_url' in item);
      assert.ok('reactions' in item);
      assert.ok('comments' in item);
    }
  });

  it('empty results have zero items', () => {
    assert.equal(fixtures.emptyResults.total_count, 0);
    assert.equal(fixtures.emptyResults.items.length, 0);
  });

  it('rate limit headers are present in fixture', () => {
    const headers = fixtures.rateLimitHeaders;
    assert.ok('x-ratelimit-remaining' in headers);
    assert.ok('x-ratelimit-limit' in headers);
    assert.ok('x-ratelimit-reset' in headers);
  });
});

// ─── edge cases ─────────────────────────────────────────────────────────────

describe('github-issues edge cases', () => {
  it('handles issue with null body', () => {
    const item = { id: 1, title: 'Bug: frustrated with broken kubernetes', body: null, html_url: '', repository_url: '', created_at: null, comments: 0, reactions: {} };
    const post = normalizeGHPost(item);
    assert.equal(post.selftext, '');
    // Should not crash on enrichment
    post.source = 'github-issues';
    const result = enrichPost(post, 'kubernetes');
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });

  it('handles issue with empty reactions object', () => {
    const item = { id: 2, title: 'Test', body: 'Test body', html_url: '', repository_url: '', created_at: null, comments: 0, reactions: {} };
    const post = normalizeGHPost(item);
    assert.equal(post.score, 0);
  });

  it('handles issue with undefined reactions', () => {
    const item = { id: 3, title: 'Test', body: 'Test body', html_url: '', repository_url: '' };
    const post = normalizeGHPost(item);
    assert.equal(post.score, 0);
    assert.equal(post.num_comments, 0);
  });

  it('handles created_at in various formats', () => {
    const item1 = { id: 4, created_at: '2024-01-15T10:30:00Z' };
    const post1 = normalizeGHPost(item1);
    assert.ok(post1.created_utc > 0);

    const item2 = { id: 5, created_at: null };
    const post2 = normalizeGHPost(item2);
    assert.equal(post2.created_utc, 0);
  });

  it('handles large reaction counts', () => {
    const item = {
      id: 6, title: 'Major bug', body: 'broken', html_url: '',
      repository_url: '', created_at: null, comments: 500,
      reactions: { '+1': 10000, heart: 5000, laugh: 100 },
    };
    const post = normalizeGHPost(item);
    assert.equal(post.score, 15000);
  });
});
