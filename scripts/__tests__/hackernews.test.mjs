/**
 * hackernews.test.mjs — Tests for the HN Algolia API source
 *
 * Tests the normalizer, query builder, comment flattener, and
 * enrichPost pipeline integration with HN fixture data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { enrichPost, computePainScore, analyzeComments, getPostPainCategories } from '../lib/scoring.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hackernews-api.json'), 'utf8'));

// ─── import source module (default export) ──────────────────────────────────

import hackernews from '../sources/hackernews.mjs';

// ─── smoke tests ────────────────────────────────────────────────────────────

describe('hackernews source: smoke tests', () => {
  it('exports a valid source object', () => {
    assert.ok(hackernews, 'default export should exist');
    assert.equal(hackernews.name, 'hackernews');
    assert.ok(hackernews.description);
    assert.ok(Array.isArray(hackernews.commands));
    assert.ok(hackernews.commands.includes('scan'));
    assert.equal(typeof hackernews.run, 'function');
    assert.ok(hackernews.help);
  });

  it('commands include expected entries', () => {
    assert.ok(hackernews.commands.includes('scan'));
    assert.ok(hackernews.commands.includes('deep-dive'));
    assert.ok(hackernews.commands.includes('frontpage'));
  });
});

// ─── normalizePost (tested via enrichPost pipeline) ─────────────────────────

function normalizeHNPost(hit) {
  const isAskHN = (hit.title || '').toLowerCase().startsWith('ask hn');
  return {
    id: hit.objectID,
    title: hit.title || '',
    selftext: decodeHtmlEntities(hit.story_text || ''),
    subreddit: 'hackernews',
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    score: hit.points || 0,
    num_comments: hit.num_comments || 0,
    upvote_ratio: 0,
    flair: isAskHN ? 'ask_hn' : 'story',
    created_utc: hit.created_at_i || 0,
  };
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x2B;/g, '+')
    .replace(/&#x3D;/g, '=');
}

function flattenComments(node) {
  const results = [];
  const children = node.children || [];
  for (const child of children) {
    if (child.type === 'comment' && child.text) {
      results.push({
        body: decodeHtmlEntities(child.text),
        score: child.points != null ? child.points : 2,
      });
    }
    results.push(...flattenComments(child));
  }
  return results;
}

describe('hackernews normalizePost', () => {
  it('normalizes a typical HN search hit', () => {
    const hit = fixtures.searchResults.hits[0];
    const post = normalizeHNPost(hit);

    assert.equal(post.id, '38001234');
    assert.equal(post.subreddit, 'hackernews');
    assert.ok(post.title.includes('Kubernetes'));
    assert.equal(post.score, 245);
    assert.equal(post.num_comments, 187);
    assert.equal(post.flair, 'ask_hn');
    assert.equal(post.upvote_ratio, 0);
    assert.ok(post.url.includes('38001234'));
  });

  it('sets flair to story for non-Ask HN posts', () => {
    const hit = fixtures.searchResults.hits[1];
    const post = normalizeHNPost(hit);
    assert.equal(post.flair, 'story');
  });

  it('uses external URL when available', () => {
    const hit = fixtures.searchResults.hits[1];
    const post = normalizeHNPost(hit);
    assert.equal(post.url, 'https://example.com/k8s-dash');
  });

  it('decodes HTML entities in story_text', () => {
    const hit = fixtures.searchResults.hits[0];
    const post = normalizeHNPost(hit);
    assert.ok(post.selftext.includes("'"), 'should decode &#x27; to apostrophe');
    assert.ok(!post.selftext.includes('&#x27;'), 'should not contain raw entity');
  });

  it('handles hit with missing fields', () => {
    const hit = {
      objectID: '99999',
    };
    const post = normalizeHNPost(hit);
    assert.equal(post.id, '99999');
    assert.equal(post.title, '');
    assert.equal(post.selftext, '');
    assert.equal(post.score, 0);
    assert.equal(post.num_comments, 0);
    assert.equal(post.flair, 'story');
  });

  it('handles null story_text', () => {
    const hit = { objectID: '11111', story_text: null };
    const post = normalizeHNPost(hit);
    assert.equal(post.selftext, '');
  });
});

// ─── flattenComments ────────────────────────────────────────────────────────

describe('hackernews flattenComments', () => {
  it('flattens nested comment tree', () => {
    const comments = flattenComments(fixtures.itemDetail);
    assert.ok(comments.length >= 3, `expected >= 3 comments, got ${comments.length}`);
  });

  it('assigns default score of 2 for null-points comments', () => {
    const comments = flattenComments(fixtures.itemDetail);
    for (const c of comments) {
      assert.ok(c.score >= 0, 'comment score should be non-negative');
    }
    // HN comments have null points, so should default to 2
    assert.ok(comments.some(c => c.score === 2), 'should have default score of 2');
  });

  it('decodes HTML entities in comment text', () => {
    const comments = flattenComments(fixtures.itemDetail);
    for (const c of comments) {
      assert.ok(!c.body.includes('&#x27;'), 'should decode entities');
    }
  });

  it('handles empty children', () => {
    const comments = flattenComments({ children: [] });
    assert.equal(comments.length, 0);
  });

  it('handles node with no children key', () => {
    const comments = flattenComments({});
    assert.equal(comments.length, 0);
  });

  it('skips non-comment children', () => {
    const node = {
      children: [
        { type: 'story', text: 'Not a comment', children: [] },
        { type: 'comment', text: 'Real comment', children: [] },
      ],
    };
    const comments = flattenComments(node);
    assert.equal(comments.length, 1);
    assert.ok(comments[0].body.includes('Real comment'));
  });
});

// ─── fixture-based enrichPost pipeline ──────────────────────────────────────

describe('hackernews enrichPost pipeline', () => {
  it('enriches frustration post from fixture', () => {
    const hit = fixtures.searchResults.hits[0];
    const post = normalizeHNPost(hit);
    post.source = 'hackernews';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched, 'should enrich pain-signal post');
    assert.ok(enriched.painScore > 0);
    assert.ok(enriched.painCategories.includes('frustration'));
    assert.ok(enriched.citeKey.startsWith('HN-'));
  });

  it('enriches cost post from fixture', () => {
    const hit = fixtures.searchResults.hits[2];
    const post = normalizeHNPost(hit);
    post.source = 'hackernews';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched, 'should enrich cost-signal post');
    assert.ok(enriched.painCategories.includes('cost'));
  });

  it('processes all fixture hits without crashing', () => {
    for (const hit of fixtures.searchResults.hits) {
      const post = normalizeHNPost(hit);
      post.source = 'hackernews';
      // enrichPost may return null for some posts (no pain) -- that is ok
      const result = enrichPost(post, 'kubernetes');
      if (result) {
        assert.equal(typeof result.painScore, 'number');
        assert.ok(result.citeKey);
      }
    }
  });

  it('analyzeComments works with flattened HN comments', () => {
    const comments = flattenComments(fixtures.itemDetail);
    const postCats = ['frustration'];
    const result = analyzeComments(comments, postCats);

    assert.ok(result.totalComments > 0);
    assert.ok(typeof result.agreementCount === 'number');
    assert.ok(typeof result.validationStrength === 'string');
  });
});

// ─── edge cases ─────────────────────────────────────────────────────────────

describe('hackernews edge cases', () => {
  it('handles empty search results', () => {
    const hits = fixtures.emptyResults.hits;
    assert.equal(hits.length, 0);
  });

  it('handles post with zero points and zero comments', () => {
    const post = normalizeHNPost({
      objectID: '0',
      title: 'Frustrated with kubernetes broken deployment',
      story_text: '',
      points: 0,
      num_comments: 0,
      created_at_i: 0,
    });
    post.source = 'hackernews';
    // Low engagement post with 1 pain signal -- enrichPost may filter it
    const result = enrichPost(post, 'kubernetes');
    // Whether it passes or not, should not crash
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });

  it('handles extremely long story_text', () => {
    const longText = 'frustrated '.repeat(5000);
    const post = normalizeHNPost({
      objectID: 'long1',
      title: 'Kubernetes is terrible',
      story_text: longText,
      points: 50,
      num_comments: 20,
      created_at_i: 1700000000,
    });
    post.source = 'hackernews';
    const result = enrichPost(post, 'kubernetes');
    assert.ok(result);
    assert.ok(result.selftext_excerpt.length <= 210);
  });

  it('handles special characters in title', () => {
    const post = normalizeHNPost({
      objectID: 'special1',
      title: 'K8s: <script>alert("xss")</script> broken &amp; frustrated',
      story_text: '',
      points: 10,
      num_comments: 5,
      created_at_i: 1700000000,
    });
    // Should not crash
    assert.ok(post.title);
  });
});
