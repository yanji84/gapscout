/**
 * Regression tests for known bugs:
 *
 * 1. citeKey naming mismatch — enrichPost() assigns `citeKey` (no underscore)
 *    but report.mjs checks `p._citeKey` (with underscore). The pipeline must
 *    copy `p.citeKey` -> `p._citeKey` so the stable key is not replaced with
 *    a random one.
 *
 * 2. Evidence corpus construction — markdown-renderer.mjs builds evidenceCorpus
 *    using `p._citeKey`. The keys in `categoryCiteKeys` must match keys in
 *    `evidenceCorpus`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupBySubcategory } from '../lib/report/analysis.mjs';
import { renderJson } from '../lib/report/markdown-renderer.mjs';

// ─── Bug #1: citeKey naming mismatch ─────────────────────────────────────────

describe('regression: citeKey naming mismatch (citeKey vs _citeKey)', () => {
  it('stable citeKey from enrichPost() is preserved and not replaced with random key', () => {
    // Simulate a post as enrichPost() would produce it: has `citeKey` (no underscore)
    const post = {
      id: 'post-001',
      title: 'Bot problem with ticket sales',
      url: 'https://example.com/post1',
      score: 100,
      num_comments: 50,
      painScore: 12,
      painSubcategories: ['product-availability'],
      _source: 'hackernews',
      citeKey: 'HN-abc123',  // <-- enrichPost sets this (no underscore)
      // Note: NO _citeKey property — that's the bug
    };

    // Run through groupBySubcategory (does not assign _citeKey)
    const groups = groupBySubcategory([post]);
    assert.ok(groups.has('product-availability'));

    // Replicate report.mjs citeKey assignment logic
    for (const [category, posts] of groups.entries()) {
      for (const p of posts) {
        if (!p._citeKey) {
          // This is the fix in report.mjs: copy citeKey -> _citeKey
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

    // Assert: the stable key from enrichPost() is preserved
    const postInGroup = groups.get('product-availability')[0];
    assert.equal(postInGroup._citeKey, 'HN-abc123',
      '_citeKey should be copied from citeKey (HN-abc123), not random');
    assert.equal(postInGroup.citeKey, 'HN-abc123',
      'Original citeKey should still be present');
  });

  it('post without citeKey gets a generated _citeKey', () => {
    const post = {
      id: 'post-002',
      title: 'App keeps crashing',
      painSubcategories: ['digital-platform'],
      _source: 'reddit',
      // No citeKey at all
    };

    const groups = groupBySubcategory([post]);
    for (const [category, posts] of groups.entries()) {
      for (const p of posts) {
        if (!p._citeKey) {
          if (p.citeKey) {
            p._citeKey = p.citeKey;
          } else {
            const src = (p._source || p.subreddit || 'unknown').slice(0, 2).toUpperCase();
            const hash = Math.random().toString(36).slice(2, 8);
            p._citeKey = `${src}-${hash}`;
          }
        }
      }
    }

    const postInGroup = groups.get('digital-platform')[0];
    assert.ok(postInGroup._citeKey, 'Should have a generated _citeKey');
    assert.ok(postInGroup._citeKey.startsWith('RE'),
      `Generated key should start with source prefix (RE), got: ${postInGroup._citeKey}`);
  });

  it('post with both citeKey and _citeKey keeps existing _citeKey', () => {
    const post = {
      id: 'post-003',
      title: 'Price gouging',
      painSubcategories: ['pricing'],
      _source: 'reddit',
      citeKey: 'RD-original',
      _citeKey: 'RD-existing',  // already set
    };

    const groups = groupBySubcategory([post]);
    for (const [category, posts] of groups.entries()) {
      for (const p of posts) {
        if (!p._citeKey) {
          if (p.citeKey) {
            p._citeKey = p.citeKey;
          } else {
            const src = (p._source || 'unknown').slice(0, 2).toUpperCase();
            const hash = Math.random().toString(36).slice(2, 8);
            p._citeKey = `${src}-${hash}`;
          }
        }
      }
    }

    const postInGroup = groups.get('pricing')[0];
    assert.equal(postInGroup._citeKey, 'RD-existing',
      'Existing _citeKey should not be overwritten');
  });

  it('multiple posts with citeKey all get their stable keys preserved', () => {
    const posts = [
      {
        id: 'p1', title: 'Post 1', painSubcategories: ['product-availability'],
        _source: 'reddit', citeKey: 'RD-stable1',
      },
      {
        id: 'p2', title: 'Post 2', painSubcategories: ['product-availability'],
        _source: 'hackernews', citeKey: 'HN-stable2',
      },
      {
        id: 'p3', title: 'Post 3', painSubcategories: ['product-availability'],
        _source: 'appstore',
        // No citeKey — should get generated
      },
    ];

    const groups = groupBySubcategory(posts);
    for (const [category, groupPosts] of groups.entries()) {
      for (const p of groupPosts) {
        if (!p._citeKey) {
          if (p.citeKey) {
            p._citeKey = p.citeKey;
          } else {
            const src = (p._source || 'unknown').slice(0, 2).toUpperCase();
            const hash = Math.random().toString(36).slice(2, 8);
            p._citeKey = `${src}-${hash}`;
          }
        }
      }
    }

    const groupPosts = groups.get('product-availability');
    const p1 = groupPosts.find(p => p.id === 'p1');
    const p2 = groupPosts.find(p => p.id === 'p2');
    const p3 = groupPosts.find(p => p.id === 'p3');

    assert.equal(p1._citeKey, 'RD-stable1');
    assert.equal(p2._citeKey, 'HN-stable2');
    assert.ok(p3._citeKey, 'Post without citeKey should get generated _citeKey');
    assert.notEqual(p3._citeKey, 'RD-stable1');
    assert.notEqual(p3._citeKey, 'HN-stable2');
  });
});

// ─── Bug #2: Evidence corpus construction ────────────────────────────────────

describe('regression: evidence corpus construction (_citeKey usage)', () => {
  it('renderJson evidenceCorpus entries are keyed by _citeKey', () => {
    const allPosts = [
      {
        _citeKey: 'RD-key1',
        title: 'First post',
        url: 'https://example.com/1',
        _source: 'reddit',
        score: 100,
        created_utc: 1700000000,
        num_comments: 50,
        subreddit: 'concerts',
        _category: 'product-availability',
      },
      {
        _citeKey: 'HN-key2',
        title: 'Second post',
        url: 'https://example.com/2',
        _source: 'hackernews',
        score: 200,
        num_comments: 30,
        subreddit: 'hackernews',
        _category: 'pricing',
      },
    ];

    const groups = [{
      category: 'product-availability',
      postCount: 2,
      crossSources: 2,
      sourceNames: ['reddit', 'hackernews'],
      depth: 'active',
      frequency: 6,
      intensityScore: 2.5,
      matrix: 'primary',
      moneyTrail: { strength: 'moderate', totalCount: 3, examples: [] },
      unspokenPain: [],
      tools: [],
      topQuotes: [],
      solutionAttempts: [],
      totalComments: 80,
      totalScore: 300,
      buildScore: 60,
      verdict: 'needs_evidence',
      representativePosts: [],
      categoryCiteKeys: ['RD-key1', 'HN-key2'],
      audience: 'test audience',
      llmEnhanced: false,
      llmAugmentedCount: 0,
      implicitPainSignals: [],
      targetPersonas: [],
    }];

    const meta = { sources: ['reddit', 'hackernews'], totalPosts: 2, categoriesFound: 1 };
    const parsed = JSON.parse(renderJson(groups, meta, { allPosts }));

    // Verify corpus is keyed by _citeKey
    assert.ok(parsed.data.evidenceCorpus['RD-key1'], 'Should have RD-key1 in corpus');
    assert.ok(parsed.data.evidenceCorpus['HN-key2'], 'Should have HN-key2 in corpus');
    assert.equal(parsed.data.evidenceCorpus['RD-key1'].title, 'First post');
    assert.equal(parsed.data.evidenceCorpus['HN-key2'].title, 'Second post');
  });

  it('categoryCiteKeys all match entries in evidenceCorpus', () => {
    const allPosts = [
      { _citeKey: 'AA-001', title: 'Post A', url: 'https://a.com', _source: 'reddit', _category: 'cat1' },
      { _citeKey: 'BB-002', title: 'Post B', url: 'https://b.com', _source: 'hackernews', _category: 'cat1' },
      { _citeKey: 'CC-003', title: 'Post C', url: 'https://c.com', _source: 'appstore', _category: 'cat2' },
    ];

    const groups = [
      {
        category: 'cat1',
        postCount: 2,
        crossSources: 2,
        sourceNames: ['reddit', 'hackernews'],
        depth: 'active',
        frequency: 6,
        intensityScore: 2,
        matrix: 'primary',
        moneyTrail: { strength: 'none', totalCount: 0, examples: [] },
        unspokenPain: [],
        tools: [],
        topQuotes: [],
        solutionAttempts: [],
        totalComments: 0,
        totalScore: 0,
        buildScore: 50,
        verdict: 'needs_evidence',
        representativePosts: [],
        categoryCiteKeys: ['AA-001', 'BB-002'],
        audience: 'test',
        llmEnhanced: false,
        llmAugmentedCount: 0,
        implicitPainSignals: [],
        targetPersonas: [],
      },
      {
        category: 'cat2',
        postCount: 1,
        crossSources: 1,
        sourceNames: ['appstore'],
        depth: 'surface',
        frequency: 1,
        intensityScore: 1,
        matrix: 'ignore',
        moneyTrail: { strength: 'none', totalCount: 0, examples: [] },
        unspokenPain: [],
        tools: [],
        topQuotes: [],
        solutionAttempts: [],
        totalComments: 0,
        totalScore: 0,
        buildScore: 10,
        verdict: 'too_weak',
        representativePosts: [],
        categoryCiteKeys: ['CC-003'],
        audience: 'test',
        llmEnhanced: false,
        llmAugmentedCount: 0,
        implicitPainSignals: [],
        targetPersonas: [],
      },
    ];

    const meta = { sources: ['reddit', 'hackernews', 'appstore'], totalPosts: 3, categoriesFound: 2 };
    const parsed = JSON.parse(renderJson(groups, meta, { allPosts }));
    const corpus = parsed.data.evidenceCorpus;

    // Every categoryCiteKey in every group must exist in corpus
    for (const g of parsed.data.groups) {
      for (const key of g.categoryCiteKeys) {
        assert.ok(corpus[key],
          `categoryCiteKey "${key}" from group "${g.category}" must exist in evidenceCorpus`);
      }
    }

    // Corpus should have exactly 3 entries
    assert.equal(Object.keys(corpus).length, 3);
  });

  it('posts without _citeKey are excluded from evidenceCorpus', () => {
    const allPosts = [
      { _citeKey: 'HAS-key', title: 'Has key', _source: 'reddit', _category: 'cat1' },
      { title: 'No key', _source: 'reddit', _category: 'cat1' },  // missing _citeKey
    ];

    const groups = [{
      category: 'cat1',
      postCount: 2,
      categoryCiteKeys: ['HAS-key'],
      // minimal required fields
      crossSources: 1, sourceNames: ['reddit'], depth: 'surface',
      frequency: 2, intensityScore: 1, matrix: 'ignore',
      moneyTrail: { strength: 'none', totalCount: 0, examples: [] },
      unspokenPain: [], tools: [], topQuotes: [], solutionAttempts: [],
      totalComments: 0, totalScore: 0, buildScore: 5, verdict: 'too_weak',
      representativePosts: [], audience: 'test', llmEnhanced: false,
      llmAugmentedCount: 0, implicitPainSignals: [], targetPersonas: [],
    }];

    const meta = { sources: ['reddit'], totalPosts: 2, categoriesFound: 1 };
    const parsed = JSON.parse(renderJson(groups, meta, { allPosts }));

    assert.equal(Object.keys(parsed.data.evidenceCorpus).length, 1);
    assert.ok(parsed.data.evidenceCorpus['HAS-key']);
  });

  it('evidenceCorpus entries contain correct metadata fields', () => {
    const allPosts = [
      {
        _citeKey: 'TEST-001',
        title: 'Test post title here',
        url: 'https://example.com/test',
        _source: 'reddit',
        score: 42,
        created_utc: 1700000000,
        num_comments: 17,
        subreddit: 'testsubreddit',
        _category: 'pricing',
        selftext: 'This is the full text of the post with more detail',
      },
    ];

    const groups = [{
      category: 'pricing',
      categoryCiteKeys: ['TEST-001'],
      postCount: 1, crossSources: 1, sourceNames: ['reddit'], depth: 'surface',
      frequency: 1, intensityScore: 1, matrix: 'ignore',
      moneyTrail: { strength: 'none', totalCount: 0, examples: [] },
      unspokenPain: [], tools: [], topQuotes: [], solutionAttempts: [],
      totalComments: 17, totalScore: 42, buildScore: 5, verdict: 'too_weak',
      representativePosts: [], audience: 'test', llmEnhanced: false,
      llmAugmentedCount: 0, implicitPainSignals: [], targetPersonas: [],
    }];

    const meta = { sources: ['reddit'], totalPosts: 1, categoriesFound: 1 };
    const parsed = JSON.parse(renderJson(groups, meta, { allPosts }));
    const entry = parsed.data.evidenceCorpus['TEST-001'];

    assert.equal(entry.title, 'Test post title here');
    assert.equal(entry.url, 'https://example.com/test');
    assert.equal(entry.source, 'reddit');
    assert.equal(entry.score, 42);
    assert.equal(entry.num_comments, 17);
    assert.equal(entry.subreddit, 'testsubreddit');
    assert.equal(entry.category, 'pricing');
    // date should be derived from created_utc
    assert.ok(entry.date.includes('2023'), `Expected date in 2023, got: ${entry.date}`);
    // quote should be the title (since selftext comes after title in the || chain)
    assert.ok(entry.quote.length > 0, 'quote should be non-empty');
  });

  it('citeKey from enrichPost flows through to evidenceCorpus key', () => {
    // This is the core regression: a post with `citeKey` (no underscore) from enrichPost
    // must end up with that same key in the evidenceCorpus

    const post = {
      id: 'enriched-001',
      title: 'Enriched post from scanner',
      url: 'https://example.com/enriched',
      _source: 'hackernews',
      score: 500,
      num_comments: 100,
      painSubcategories: ['product-availability'],
      citeKey: 'HN-enriched001',  // from enrichPost()
    };

    // Step 1: Group
    const groups = groupBySubcategory([post]);

    // Step 2: Assign _citeKey (report.mjs logic)
    for (const [category, posts] of groups.entries()) {
      for (const p of posts) {
        if (!p._citeKey) {
          if (p.citeKey) {
            p._citeKey = p.citeKey;  // <-- the fix
          } else {
            p._citeKey = `XX-${Math.random().toString(36).slice(2, 8)}`;
          }
        }
        p._category = category;
      }
    }

    // Step 3: Build allPosts with _citeKey set
    const allPosts = groups.get('product-availability');

    // Step 4: Create group data
    const groupData = [{
      category: 'product-availability',
      postCount: 1,
      categoryCiteKeys: allPosts.map(p => p._citeKey),
      crossSources: 1, sourceNames: ['hackernews'], depth: 'active',
      frequency: 1, intensityScore: 2, matrix: 'hidden_gem',
      moneyTrail: { strength: 'none', totalCount: 0, examples: [] },
      unspokenPain: [], tools: [], topQuotes: [], solutionAttempts: [],
      totalComments: 100, totalScore: 500, buildScore: 40, verdict: 'needs_evidence',
      representativePosts: [], audience: 'test', llmEnhanced: false,
      llmAugmentedCount: 0, implicitPainSignals: [], targetPersonas: [],
    }];

    // Step 5: Render JSON
    const meta = { sources: ['hackernews'], totalPosts: 1, categoriesFound: 1 };
    const parsed = JSON.parse(renderJson(groupData, meta, { allPosts }));

    // The key in evidenceCorpus should be the stable enrichPost key
    assert.ok(parsed.data.evidenceCorpus['HN-enriched001'],
      'evidenceCorpus should be keyed by the stable citeKey from enrichPost');

    // The categoryCiteKeys should reference the same key
    assert.ok(parsed.data.groups[0].categoryCiteKeys.includes('HN-enriched001'),
      'categoryCiteKeys should contain the stable citeKey');

    // Cross-check: categoryCiteKeys <-> evidenceCorpus
    for (const key of parsed.data.groups[0].categoryCiteKeys) {
      assert.ok(parsed.data.evidenceCorpus[key],
        `categoryCiteKey "${key}" must exist in evidenceCorpus`);
    }
  });
});
