/**
 * Aggregator tests — mergeScanFiles, loadScanResult, inferSource
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  inferSource,
  loadScanResult,
  mergeScanFiles,
  loadFile,
} from '../lib/report/aggregator.mjs';

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures');

// ─── inferSource ─────────────────────────────────────────────────────────────

describe('inferSource', () => {
  it('returns fallback when provided', () => {
    assert.equal(inferSource({ subreddit: 'foo' }, 'hackernews'), 'hackernews');
  });

  it('infers reddit from subreddit field', () => {
    assert.equal(inferSource({ subreddit: 'concerts' }), 'reddit');
  });

  it('infers hackernews from subreddit=hackernews', () => {
    assert.equal(inferSource({ subreddit: 'hackernews' }), 'hackernews');
  });

  it('infers appstore from subreddit=playstore', () => {
    assert.equal(inferSource({ subreddit: 'playstore' }), 'appstore');
  });

  it('infers appstore from subreddit=appstore', () => {
    assert.equal(inferSource({ subreddit: 'appstore' }), 'appstore');
  });

  it('infers google from subreddit=google-autocomplete', () => {
    assert.equal(inferSource({ subreddit: 'google-autocomplete' }), 'google');
  });

  it('returns unknown when no subreddit and no fallback', () => {
    assert.equal(inferSource({}), 'unknown');
    assert.equal(inferSource(null), 'unknown');
  });
});

// ─── loadScanResult ──────────────────────────────────────────────────────────

describe('loadScanResult', () => {
  it('loads posts from { data: { posts: [...] } } envelope', () => {
    const raw = {
      data: {
        source: 'reddit',
        posts: [
          { id: 'p1', title: 'test post', subreddit: 'test' },
          { id: 'p2', title: 'another post', subreddit: 'test' },
        ],
      },
    };
    const posts = loadScanResult(raw, 'test-file.json');
    assert.equal(posts.length, 2);
    assert.equal(posts[0]._source, 'reddit');
    assert.equal(posts[0]._file, 'test-file.json');
    assert.equal(posts[0].id, 'p1');
  });

  it('loads posts from { posts: [...] } without data wrapper', () => {
    const raw = {
      posts: [{ id: 'p1', title: 'test', subreddit: 'test' }],
    };
    const posts = loadScanResult(raw, 'flat-file.json');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]._source, 'reddit');
  });

  it('loads results from deep-dive format { data: { results: [...] } }', () => {
    const raw = {
      data: {
        source: 'hackernews',
        results: [
          {
            post: { id: 'dd1', title: 'deep dive', subreddit: 'hackernews' },
            analysis: { intensityLevel: 'high', moneyTrailCount: 3 },
          },
        ],
      },
    };
    const posts = loadScanResult(raw, 'deepdive.json');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]._source, 'hackernews');
    assert.equal(posts[0]._analysis.intensityLevel, 'high');
    assert.equal(posts[0]._analysis.moneyTrailCount, 3);
  });

  it('loads results from deep_dives format', () => {
    const raw = {
      data: {
        deep_dives: [
          {
            post: { id: 'dd2', title: 'alt deep dive', subreddit: 'concerts' },
            analysis: { intensityLevel: 'moderate' },
          },
        ],
      },
    };
    const posts = loadScanResult(raw, 'alt.json');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]._source, 'reddit');
    assert.equal(posts[0]._analysis.intensityLevel, 'moderate');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(loadScanResult({}, 'empty.json'), []);
    assert.deepEqual(loadScanResult(null, 'null.json'), []);
  });

  it('combines posts + results from the same file', () => {
    const raw = {
      data: {
        source: 'reddit',
        posts: [{ id: 'p1', title: 'post', subreddit: 'test' }],
        results: [
          {
            post: { id: 'r1', title: 'result', subreddit: 'test' },
            analysis: { intensityLevel: 'low' },
          },
        ],
      },
    };
    const posts = loadScanResult(raw, 'combined.json');
    assert.equal(posts.length, 2);
  });
});

// ─── loadFile ────────────────────────────────────────────────────────────────

describe('loadFile', () => {
  it('loads reddit scan fixture', () => {
    const posts = loadFile(resolve(FIXTURE_DIR, 'scan-reddit.json'));
    assert.ok(posts.length >= 4, `Expected >=4 posts, got ${posts.length}`);
    assert.equal(posts[0]._source, 'reddit');
    assert.equal(posts[0]._file, resolve(FIXTURE_DIR, 'scan-reddit.json'));
  });

  it('loads hackernews scan fixture', () => {
    const posts = loadFile(resolve(FIXTURE_DIR, 'scan-hackernews.json'));
    assert.ok(posts.length >= 2);
    assert.equal(posts[0]._source, 'hackernews');
  });

  it('loads deep-dive fixture with analysis data', () => {
    const posts = loadFile(resolve(FIXTURE_DIR, 'scan-deepdive.json'));
    assert.ok(posts.length >= 2);
    assert.ok(posts[0]._analysis, 'Deep-dive posts should have _analysis');
    assert.ok(posts[0]._analysis.topQuotes.length > 0);
  });

  it('returns empty array for nonexistent file', () => {
    const posts = loadFile('/nonexistent/path.json');
    assert.deepEqual(posts, []);
  });
});

// ─── mergeScanFiles ──────────────────────────────────────────────────────────

describe('mergeScanFiles', () => {
  const allFixtures = [
    resolve(FIXTURE_DIR, 'scan-reddit.json'),
    resolve(FIXTURE_DIR, 'scan-hackernews.json'),
    resolve(FIXTURE_DIR, 'scan-deepdive.json'),
    resolve(FIXTURE_DIR, 'scan-reviews.json'),
  ];

  it('merges multiple scan files', () => {
    const { posts, sources } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    assert.ok(posts.length > 0, 'Should have loaded posts');
    assert.ok(sources.size >= 2, `Expected >=2 sources, got ${sources.size}`);
    assert.ok(sources.has('reddit'));
    assert.ok(sources.has('hackernews'));
  });

  it('deduplicates by id, keeping analysis version', () => {
    // Create two files with overlapping IDs
    const { posts } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    const idCounts = new Map();
    for (const p of posts) {
      const key = p.id || p.url || p.title;
      idCounts.set(key, (idCounts.get(key) || 0) + 1);
    }
    for (const [key, count] of idCounts) {
      assert.equal(count, 1, `Post "${key}" should appear only once after dedup`);
    }
  });

  it('applies recency filter with maxAgeDays', () => {
    // All fixtures have created_utc around 1700000000 (Nov 2023)
    // With a very short maxAgeDays the old posts should be filtered
    const { posts: recent } = mergeScanFiles(allFixtures, { maxAgeDays: 1 });
    // Posts are ~2+ years old, should all be filtered
    assert.equal(recent.length, 0, 'Old posts should be filtered with maxAgeDays=1');
  });

  it('skips recency filter when maxAgeDays=0', () => {
    const { posts } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    assert.ok(posts.length > 0, 'Should keep all posts when maxAgeDays=0');
  });

  it('preserves citeKey from original posts', () => {
    const { posts } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    const withCiteKey = posts.filter(p => p.citeKey);
    assert.ok(withCiteKey.length > 0, 'Some posts should have citeKey');
    // Verify specific known citeKey
    const hn = posts.find(p => p.id === 'hn-001');
    if (hn) {
      assert.equal(hn.citeKey, 'HN-hn001');
    }
  });

  it('returns empty result for empty file list', () => {
    const { posts, sources } = mergeScanFiles([]);
    assert.equal(posts.length, 0);
    assert.equal(sources.size, 0);
  });
});
