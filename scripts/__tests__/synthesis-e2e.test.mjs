/**
 * End-to-end pipeline test — scan data -> grouped -> synthesized -> rendered
 * Verifies citeKey consistency throughout the entire pipeline.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mergeScanFiles } from '../lib/report/aggregator.mjs';
import {
  groupBySubcategory,
  classifyDepth,
  computeMatrix,
  aggregateMoneyTrail,
  extractUnspokenPain,
  aggregateTools,
} from '../lib/report/analysis.mjs';
import {
  buildWorthinessScore,
  determineVerdict,
  getAudience,
} from '../lib/report/synthesis.mjs';
import { renderMarkdown, renderJson } from '../lib/report/markdown-renderer.mjs';

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures');

// ─── replicate report.mjs synthesize() for testing ───────────────────────────

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

    const topQuotes = [];
    for (const p of posts) {
      if (p._analysis?.topQuotes) {
        for (const q of p._analysis.topQuotes.slice(0, 2)) {
          topQuotes.push({ ...q, url: q.url || p.url || '', citeKey: p._citeKey || '' });
        }
      }
    }

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
      audience: getAudience(category),
      llmEnhanced: false,
      llmAugmentedCount: 0,
      implicitPainSignals: [],
      targetPersonas: [],
    });
  }

  reportGroups.sort((a, b) => b.buildScore - a.buildScore);
  return reportGroups;
}

// ─── E2E tests ───────────────────────────────────────────────────────────────

describe('end-to-end pipeline', () => {
  const allFixtures = [
    resolve(FIXTURE_DIR, 'scan-reddit.json'),
    resolve(FIXTURE_DIR, 'scan-hackernews.json'),
    resolve(FIXTURE_DIR, 'scan-deepdive.json'),
    resolve(FIXTURE_DIR, 'scan-reviews.json'),
  ];

  it('full pipeline: load -> group -> assign citeKeys -> synthesize -> render markdown', () => {
    // Step 1: Load
    const { posts: allPosts, sources: loadedSources } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    assert.ok(allPosts.length > 0, 'Should load posts from fixtures');

    // Step 2: Group
    const groups = groupBySubcategory(allPosts);
    assert.ok(groups.size > 0, 'Should have at least one category group');

    // Step 3: Assign citeKeys (replicating report.mjs logic)
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
        p._category = category;
      }
    }

    // Step 4: Synthesize
    const synthesized = synthesize(groups, allPosts);
    assert.ok(synthesized.length > 0, 'Should produce at least one synthesized group');

    // Verify groups are sorted by buildScore descending
    for (let i = 1; i < synthesized.length; i++) {
      assert.ok(synthesized[i - 1].buildScore >= synthesized[i].buildScore,
        `Groups should be sorted by buildScore: ${synthesized[i - 1].buildScore} >= ${synthesized[i].buildScore}`);
    }

    // Step 5: Render markdown
    const meta = {
      sources: [...loadedSources],
      totalPosts: allPosts.length,
      categoriesFound: synthesized.length,
    };
    const md = renderMarkdown(synthesized, meta);
    assert.ok(md.includes('Pain Point Synthesis Report'));
    assert.ok(md.includes('Executive Summary'));
    assert.ok(md.length > 500, 'Markdown output should be substantial');
  });

  it('full pipeline: load -> group -> assign citeKeys -> synthesize -> render JSON', () => {
    const { posts: allPosts, sources: loadedSources } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    const groups = groupBySubcategory(allPosts);

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
        p._category = category;
      }
    }

    const synthesized = synthesize(groups, allPosts);
    const meta = {
      sources: [...loadedSources],
      totalPosts: allPosts.length,
      categoriesFound: synthesized.length,
    };

    const jsonStr = renderJson(synthesized, meta, { allPosts });
    const parsed = JSON.parse(jsonStr);

    assert.ok(parsed.ok);
    assert.ok(parsed.data.groups.length > 0);
    assert.ok(parsed.data.evidenceCorpus);

    // Verify evidenceCorpus has entries
    const corpusKeys = Object.keys(parsed.data.evidenceCorpus);
    assert.ok(corpusKeys.length > 0, 'Evidence corpus should have entries');

    // Every corpus entry should have required fields
    for (const key of corpusKeys) {
      const entry = parsed.data.evidenceCorpus[key];
      assert.ok(typeof entry.title === 'string', `Entry ${key} should have title`);
      assert.ok(typeof entry.source === 'string', `Entry ${key} should have source`);
    }
  });

  it('citeKeys are preserved from source data through the entire pipeline', () => {
    const { posts: allPosts } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    const groups = groupBySubcategory(allPosts);

    // Assign citeKeys
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
        p._category = category;
      }
    }

    // Collect all assigned _citeKeys
    const allCiteKeys = new Set();
    for (const [, posts] of groups.entries()) {
      for (const p of posts) {
        if (p._citeKey) allCiteKeys.add(p._citeKey);
      }
    }

    // Synthesize
    const synthesized = synthesize(groups, allPosts);

    // Verify categoryCiteKeys reference valid _citeKeys
    for (const g of synthesized) {
      for (const key of g.categoryCiteKeys) {
        assert.ok(allCiteKeys.has(key),
          `categoryCiteKey "${key}" for category "${g.category}" should exist in allCiteKeys`);
      }
    }

    // Render JSON and verify corpus matches
    const meta = { sources: ['reddit', 'hackernews'], totalPosts: allPosts.length, categoriesFound: synthesized.length };
    const parsed = JSON.parse(renderJson(synthesized, meta, { allPosts }));
    const corpus = parsed.data.evidenceCorpus;

    // Every categoryCiteKey in every group should exist in evidenceCorpus
    for (const g of parsed.data.groups) {
      for (const key of g.categoryCiteKeys) {
        assert.ok(corpus[key],
          `categoryCiteKey "${key}" for group "${g.category}" should exist in evidenceCorpus`);
      }
    }
  });

  it('posts with original citeKey preserve it, posts without get generated one', () => {
    const { posts: allPosts } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    const groups = groupBySubcategory(allPosts);

    const postsWithOriginalKey = [];
    const postsWithGeneratedKey = [];

    for (const [category, posts] of groups.entries()) {
      for (const p of posts) {
        if (!p._citeKey) {
          if (p.citeKey) {
            p._citeKey = p.citeKey;
            postsWithOriginalKey.push(p);
          } else {
            const src = (p._source || p.subreddit || 'unknown').slice(0, 2).toUpperCase();
            const hash = Math.random().toString(36).slice(2, 8);
            p._citeKey = `${src}-${hash}`;
            postsWithGeneratedKey.push(p);
          }
        }
        p._category = category;
      }
    }

    assert.ok(postsWithOriginalKey.length > 0, 'Some posts should have preserved their original citeKey');
    assert.ok(postsWithGeneratedKey.length > 0, 'Some posts should get generated citeKeys');

    // Original keys match what was in the fixture
    for (const p of postsWithOriginalKey) {
      assert.equal(p._citeKey, p.citeKey,
        `Post ${p.id} should have _citeKey === citeKey (${p.citeKey})`);
    }
  });

  it('multi-source groups have correct cross-source counts', () => {
    const { posts: allPosts } = mergeScanFiles(allFixtures, { maxAgeDays: 0 });
    const groups = groupBySubcategory(allPosts);

    // Assign citeKeys
    for (const [category, posts] of groups.entries()) {
      for (const p of posts) {
        if (!p._citeKey) {
          p._citeKey = p.citeKey || `XX-${Math.random().toString(36).slice(2, 8)}`;
        }
        p._category = category;
      }
    }

    const synthesized = synthesize(groups, allPosts);

    // product-availability should appear in both reddit and hackernews fixtures
    const avail = synthesized.find(g => g.category === 'product-availability');
    if (avail) {
      assert.ok(avail.crossSources >= 2,
        `product-availability should have >=2 sources, got ${avail.crossSources}`);
      assert.ok(avail.postCount >= 3,
        `product-availability should have >=3 posts, got ${avail.postCount}`);
    }
  });
});
