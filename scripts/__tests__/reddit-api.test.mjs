/**
 * reddit-api.test.mjs — Tests for the Reddit PullPush API source
 *
 * Tests the normalizer, enrichPost pipeline integration, and edge cases
 * using fixture data matching PullPush and Reddit OAuth response shapes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { enrichPost, computePainScore, analyzeComments, matchSignals } from '../lib/scoring.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'reddit-api.json'), 'utf8'));

// ─── import source module ───────────────────────────────────────────────────

import redditApi from '../sources/reddit-api.mjs';

// ─── smoke tests ────────────────────────────────────────────────────────────

describe('reddit-api source: smoke tests', () => {
  it('exports a valid source object', () => {
    assert.ok(redditApi, 'default export should exist');
    assert.equal(redditApi.name, 'reddit-api');
    assert.ok(redditApi.description);
    assert.ok(Array.isArray(redditApi.commands));
    assert.equal(typeof redditApi.run, 'function');
    assert.ok(redditApi.help);
  });

  it('commands include expected entries', () => {
    assert.ok(redditApi.commands.includes('discover'));
    assert.ok(redditApi.commands.includes('scan'));
    assert.ok(redditApi.commands.includes('deep-dive'));
  });
});

// ─── normalizePost (replicated from source) ─────────────────────────────────

function normalizeRedditPost(p) {
  return {
    id: p.id,
    title: p.title || '',
    selftext: p.selftext || '',
    subreddit: p.subreddit || '',
    url: `https://www.reddit.com${p.permalink || ''}`,
    score: p.score || 0,
    num_comments: p.num_comments || 0,
    upvote_ratio: p.upvote_ratio || 0,
    flair: p.link_flair_text || '',
    created_utc: p.created_utc || 0,
  };
}

function extractPostId(input) {
  const urlMatch = input.match(/\/comments\/([a-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[a-z0-9]+$/i.test(input)) return input;
  return null;
}

describe('reddit-api normalizePost', () => {
  it('normalizes a PullPush submission', () => {
    const raw = fixtures.pullpushSubmissions.data[0];
    const post = normalizeRedditPost(raw);

    assert.equal(post.id, 'abc123');
    assert.ok(post.title.includes('Kubernetes'));
    assert.ok(post.selftext.includes('tired of'));
    assert.equal(post.subreddit, 'devops');
    assert.ok(post.url.includes('reddit.com'));
    assert.equal(post.score, 156);
    assert.equal(post.num_comments, 87);
    assert.equal(post.upvote_ratio, 0.92);
    assert.equal(post.flair, 'rant');
    assert.equal(post.created_utc, 1700000000);
  });

  it('handles missing fields gracefully', () => {
    const post = normalizeRedditPost({});
    assert.equal(post.id, undefined);
    assert.equal(post.title, '');
    assert.equal(post.selftext, '');
    assert.equal(post.subreddit, '');
    assert.ok(post.url.includes('reddit.com'));
    assert.equal(post.score, 0);
    assert.equal(post.num_comments, 0);
    assert.equal(post.upvote_ratio, 0);
    assert.equal(post.flair, '');
    assert.equal(post.created_utc, 0);
  });

  it('normalizes second fixture submission', () => {
    const raw = fixtures.pullpushSubmissions.data[1];
    const post = normalizeRedditPost(raw);
    assert.equal(post.id, 'def456');
    assert.equal(post.subreddit, 'programming');
  });
});

// ─── extractPostId ──────────────────────────────────────────────────────────

describe('reddit-api extractPostId', () => {
  it('extracts ID from Reddit URL', () => {
    assert.equal(extractPostId('/r/devops/comments/abc123/kubernetes/'), 'abc123');
  });

  it('extracts ID from full URL', () => {
    assert.equal(extractPostId('https://www.reddit.com/r/test/comments/xyz789/title/'), 'xyz789');
  });

  it('returns bare ID as-is', () => {
    assert.equal(extractPostId('abc123'), 'abc123');
  });

  it('returns null for invalid input', () => {
    assert.equal(extractPostId('not a url or id!'), null);
  });
});

// ─── PullPush response shapes ───────────────────────────────────────────────

describe('reddit-api PullPush response handling', () => {
  it('handles empty data array', () => {
    const items = fixtures.emptyResponse.data;
    assert.equal(items.length, 0);
  });

  it('comment data has expected fields', () => {
    const comment = fixtures.pullpushComments.data[0];
    assert.ok(comment.id);
    assert.ok(comment.body);
    assert.ok(typeof comment.score === 'number');
    assert.ok(comment.link_id);
    assert.ok(comment.created_utc);
  });

  it('link_id has t3_ prefix', () => {
    const comment = fixtures.pullpushComments.data[0];
    assert.ok(comment.link_id.startsWith('t3_'));
  });
});

// ─── Reddit OAuth response shapes ───────────────────────────────────────────

describe('reddit-api OAuth response handling', () => {
  it('parses OAuth search response correctly', () => {
    const data = fixtures.redditOAuthResponse;
    const children = data.data.children;
    assert.equal(children.length, 1);

    const p = children[0].data;
    assert.equal(p.id, 'xyz999');
    assert.ok(p.title.includes('Kubernetes'));
    assert.equal(p.subreddit, 'devops');
  });

  it('normalizes OAuth post to common shape', () => {
    const p = fixtures.redditOAuthResponse.data.children[0].data;
    const post = normalizeRedditPost(p);
    assert.equal(post.id, 'xyz999');
    assert.ok(post.url.includes('reddit.com'));
    assert.equal(post.score, 89);
  });
});

// ─── fixture-based enrichPost pipeline ──────────────────────────────────────

describe('reddit-api enrichPost pipeline', () => {
  it('enriches frustration post from PullPush fixture', () => {
    const raw = fixtures.pullpushSubmissions.data[0];
    const post = normalizeRedditPost(raw);
    post.source = 'reddit';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched, 'should enrich pain-signal post');
    assert.ok(enriched.painScore > 0);
    assert.ok(enriched.painCategories.includes('frustration'));
    assert.ok(enriched.citeKey.startsWith('R-'));
    assert.equal(enriched.flair, 'rant');
  });

  it('enriches desire+WTP post from PullPush fixture', () => {
    const raw = fixtures.pullpushSubmissions.data[1];
    const post = normalizeRedditPost(raw);
    post.source = 'reddit';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched, 'should enrich desire/WTP post');
    assert.ok(enriched.painCategories.includes('desire'));
  });

  it('enriches OAuth post from fixture', () => {
    const p = fixtures.redditOAuthResponse.data.children[0].data;
    const post = normalizeRedditPost(p);
    post.source = 'reddit';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched);
    assert.ok(enriched.painScore > 0);
  });

  it('processes all PullPush fixture submissions without crashing', () => {
    for (const raw of fixtures.pullpushSubmissions.data) {
      const post = normalizeRedditPost(raw);
      post.source = 'reddit';
      const result = enrichPost(post, 'kubernetes');
      if (result) {
        assert.equal(typeof result.painScore, 'number');
        assert.ok(result.citeKey);
      }
    }
  });

  it('analyzeComments works with PullPush comment fixtures', () => {
    const comments = fixtures.pullpushComments.data.map(c => ({
      body: c.body,
      score: c.score,
    }));
    const result = analyzeComments(comments, ['frustration']);

    assert.ok(result.totalComments > 0);
    assert.ok(typeof result.agreementCount === 'number');
  });

  it('detects agreement in fixture comments', () => {
    const comments = fixtures.pullpushComments.data.map(c => ({
      body: c.body,
      score: c.score,
    }));
    const result = analyzeComments(comments, ['frustration']);
    // "Same here" and "Me too" are agreement signals
    assert.ok(result.agreementCount > 0, 'should detect agreement in comments');
  });

  it('detects solution in fixture comments', () => {
    const comments = fixtures.pullpushComments.data.map(c => ({
      body: c.body,
      score: c.score,
    }));
    const result = analyzeComments(comments, ['frustration']);
    // "I switched to Docker Swarm" is a solution signal
    assert.ok(result.solutionAttempts.length > 0, 'should detect solution signals');
  });
});

// ─── edge cases ─────────────────────────────────────────────────────────────

describe('reddit-api edge cases', () => {
  it('handles post with no selftext', () => {
    const post = normalizeRedditPost({
      id: 'noselftext',
      title: 'Frustrated with broken kubernetes deployment',
      subreddit: 'devops',
      permalink: '/r/devops/comments/noselftext/test/',
      score: 50,
      num_comments: 10,
      upvote_ratio: 0.8,
      link_flair_text: '',
      created_utc: 1700000000,
    });
    post.source = 'reddit';
    const result = enrichPost(post, 'kubernetes');
    // May or may not pass pain filter, but should not crash
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });

  it('handles very high upvote_ratio', () => {
    const post = normalizeRedditPost({
      id: 'highratio',
      title: 'Kubernetes is frustrating and terrible',
      selftext: 'This is broken.',
      subreddit: 'devops',
      permalink: '/r/devops/comments/highratio/test/',
      score: 500,
      num_comments: 200,
      upvote_ratio: 0.99,
      link_flair_text: '',
      created_utc: 1700000000,
    });
    post.source = 'reddit';
    const result = enrichPost(post, 'kubernetes');
    assert.ok(result);
    assert.ok(result.painScore > 0);
  });

  it('handles post with [deleted] selftext', () => {
    const post = normalizeRedditPost({
      id: 'deleted1',
      title: 'Frustrated with kubernetes broken builds',
      selftext: '[deleted]',
      subreddit: 'devops',
      permalink: '/r/devops/comments/deleted1/test/',
      score: 100,
      num_comments: 50,
      upvote_ratio: 0.85,
      link_flair_text: '',
      created_utc: 1700000000,
    });
    post.source = 'reddit';
    const result = enrichPost(post, 'kubernetes');
    // Should not crash; may or may not pass filter
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });

  it('handles malformed PullPush response with null data', () => {
    // Simulate a response where .data might be missing
    const response = {};
    const items = response?.data || [];
    assert.equal(items.length, 0);
  });

  it('handles comments with empty bodies', () => {
    const comments = [
      { body: '', score: 5 },
      { body: null, score: 3 },
      { body: 'Frustrated with this.', score: 10 },
    ];
    const result = analyzeComments(comments);
    assert.equal(result.totalComments, 1);
  });

  it('handles subreddit with special characters', () => {
    const post = normalizeRedditPost({
      id: 'special',
      title: 'Frustrated with broken tool',
      selftext: 'Terrible experience with this awful software.',
      subreddit: 'CSharp_Programming',
      permalink: '/r/CSharp_Programming/comments/special/test/',
      score: 30,
      num_comments: 15,
      upvote_ratio: 0.85,
      link_flair_text: '',
      created_utc: 1700000000,
    });
    assert.equal(post.subreddit, 'CSharp_Programming');
  });
});
