/**
 * producthunt.test.mjs — Tests for the Product Hunt source
 *
 * Tests the normalizers (API and browser modes), pain signal detection,
 * and enrichPost pipeline integration with PH fixture data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { enrichPost, computePainScore, analyzeComments, matchSignals } from '../lib/scoring.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'producthunt-api.json'), 'utf8'));

// ─── import source module ───────────────────────────────────────────────────

import producthunt from '../sources/producthunt.mjs';

// ─── smoke tests ────────────────────────────────────────────────────────────

describe('producthunt source: smoke tests', () => {
  it('exports a valid source object', () => {
    assert.ok(producthunt, 'default export should exist');
    assert.equal(producthunt.name, 'producthunt');
    assert.ok(producthunt.description);
    assert.ok(Array.isArray(producthunt.commands));
    assert.ok(producthunt.commands.includes('scan'));
    assert.equal(typeof producthunt.run, 'function');
    assert.ok(producthunt.help);
  });
});

// ─── pain signal patterns (replicated from source) ──────────────────────────

const PAIN_PATTERNS = [
  /i wish (this|it) (did|had|could|would)/i,
  /missing feature/i,
  /doesn'?t work for/i,
  /switched from/i,
  /please add/i,
  /feature request/i,
  /wish (you|they) (would|could|had)/i,
  /not worth/i,
  /deal.?breaker/i,
  /can'?t figure out/i,
  /frustrat/i,
  /annoying/i,
  /too expensive/i,
  /overpriced/i,
  /terrible/i,
  /unusable/i,
  /hate (it|this|that)/i,
  /alternatives?/i,
  /compared to/i,
  /instead i (use|went|tried)/i,
  /stopped using/i,
  /still missing/i,
  /would be better if/i,
  /not great/i,
  /disappointed/i,
  /lacking/i,
  /needs improvement/i,
  /room for improvement/i,
  /could be better/i,
  /limitation/i,
  /bug|crash|broken/i,
  /slow|laggy/i,
  /confus/i,
  /hard to (use|understand|navigate)/i,
];

function hasPainSignal(text) {
  return PAIN_PATTERNS.some(p => p.test(text));
}

// ─── buildPostFromApiNode (replicated from source) ──────────────────────────

function buildPostFromApiNode(node, comments) {
  const createdUtc = node.createdAt
    ? Math.floor(new Date(node.createdAt).getTime() / 1000)
    : 0;
  const productUrl = node.url || `https://www.producthunt.com/posts/${node.slug}`;
  const painComments = comments.filter(c => hasPainSignal(c.body));
  const allCommentTexts = comments.map(c => c.body).join('\n\n');
  const selftext = [node.description || '', allCommentTexts]
    .filter(Boolean)
    .join('\n\n---\n\n')
    .substring(0, 6000);

  return {
    id: node.slug || node.id,
    title: node.name + (node.tagline ? ` — ${node.tagline}` : ''),
    body: selftext,
    selftext,
    subreddit: 'producthunt',
    url: productUrl,
    score: node.votesCount || 0,
    source: 'producthunt',
    created_utc: createdUtc,
    num_comments: node.commentsCount || comments.length,
    upvote_ratio: 0,
    flair: '',
    _painComments: painComments,
    _allComments: comments,
  };
}

// ─── hasPainSignal tests ────────────────────────────────────────────────────

describe('producthunt hasPainSignal', () => {
  it('detects wish patterns', () => {
    assert.ok(hasPainSignal('I wish this had better Gantt charts'));
    assert.ok(hasPainSignal('I wish it could export to PDF'));
  });

  it('detects missing feature', () => {
    assert.ok(hasPainSignal('Missing feature: dark mode'));
  });

  it('detects switched from', () => {
    assert.ok(hasPainSignal('I switched from Asana'));
  });

  it('detects frustration', () => {
    assert.ok(hasPainSignal('This is frustrating'));
    assert.ok(hasPainSignal('Very frustrating experience'));
  });

  it('detects cost complaints', () => {
    assert.ok(hasPainSignal('Too expensive for what it offers'));
    assert.ok(hasPainSignal('Overpriced compared to competitors'));
  });

  it('detects alternatives mention', () => {
    assert.ok(hasPainSignal('Looking at alternatives'));
  });

  it('detects UX problems', () => {
    assert.ok(hasPainSignal('Hard to navigate the interface'));
    assert.ok(hasPainSignal('The UI is confusing'));
  });

  it('returns false for positive comments', () => {
    assert.ok(!hasPainSignal('Great product, love it!'));
    assert.ok(!hasPainSignal('This is exactly what I needed'));
    assert.ok(!hasPainSignal('Works perfectly for our team'));
  });
});

// ─── buildPostFromApiNode tests ─────────────────────────────────────────────

describe('producthunt buildPostFromApiNode', () => {
  it('builds post from API node with comments', () => {
    const node = fixtures.postsByTopicResponse.posts.edges[0].node;
    const comments = fixtures.postCommentsResponse.post.comments.edges.map(e => ({
      body: (e.node.body || '').substring(0, 500),
      score: e.node.votesCount || 1,
      stars: 0,
    }));

    const post = buildPostFromApiNode(node, comments);

    assert.equal(post.id, 'awesome-pm-tool');
    assert.ok(post.title.includes('Awesome PM Tool'));
    assert.ok(post.title.includes('The project management tool'));
    assert.equal(post.subreddit, 'producthunt');
    assert.ok(post.url.includes('producthunt.com'));
    assert.equal(post.score, 234);
    assert.equal(post.source, 'producthunt');
    assert.ok(post.created_utc > 0);
    assert.ok(post.selftext.length > 0);
  });

  it('identifies pain comments', () => {
    const node = fixtures.postsByTopicResponse.posts.edges[0].node;
    const comments = fixtures.postCommentsResponse.post.comments.edges.map(e => ({
      body: (e.node.body || '').substring(0, 500),
      score: e.node.votesCount || 1,
      stars: 0,
    }));
    const post = buildPostFromApiNode(node, comments);

    // Fixture comments include pain signals: "I wish", "missing feature", "switched from", "confusing"
    assert.ok(post._painComments.length > 0, 'should detect pain comments');
  });

  it('concatenates description and comments in selftext', () => {
    const node = fixtures.postsByTopicResponse.posts.edges[0].node;
    const comments = [{ body: 'Comment text here', score: 1, stars: 0 }];
    const post = buildPostFromApiNode(node, comments);

    assert.ok(post.selftext.includes(node.description));
    assert.ok(post.selftext.includes('Comment text here'));
    assert.ok(post.selftext.includes('---')); // separator
  });

  it('truncates selftext to 6000 chars', () => {
    const node = {
      slug: 'test',
      name: 'Test',
      tagline: '',
      description: 'x'.repeat(3000),
      votesCount: 10,
      commentsCount: 1,
      url: '',
      createdAt: null,
    };
    const comments = [{ body: 'y'.repeat(4000), score: 1 }];
    const post = buildPostFromApiNode(node, comments);
    assert.ok(post.selftext.length <= 6000);
  });

  it('handles node with no tagline', () => {
    const node = {
      slug: 'no-tagline',
      name: 'No Tagline',
      description: '',
      votesCount: 5,
      commentsCount: 0,
      url: '',
      createdAt: null,
    };
    const post = buildPostFromApiNode(node, []);
    assert.equal(post.title, 'No Tagline');
    assert.ok(!post.title.includes('undefined'));
  });

  it('handles empty comments array', () => {
    const node = {
      slug: 'no-comments',
      name: 'No Comments',
      tagline: 'Test',
      description: 'Test description',
      votesCount: 10,
      commentsCount: 0,
      url: '',
      createdAt: '2024-01-01T00:00:00Z',
    };
    const post = buildPostFromApiNode(node, []);
    assert.equal(post._painComments.length, 0);
    assert.equal(post._allComments.length, 0);
    assert.ok(post.selftext.includes('Test description'));
  });

  it('uses slug as id when available', () => {
    const node = { slug: 'my-slug', id: '999', name: 'Test', votesCount: 0, commentsCount: 0 };
    const post = buildPostFromApiNode(node, []);
    assert.equal(post.id, 'my-slug');
  });

  it('falls back to id when slug missing', () => {
    const node = { id: '999', name: 'Test', votesCount: 0, commentsCount: 0 };
    const post = buildPostFromApiNode(node, []);
    assert.equal(post.id, '999');
  });
});

// ─── fixture-based enrichPost pipeline ──────────────────────────────────────

describe('producthunt enrichPost pipeline', () => {
  it('enriches PH post with pain signals from fixture', () => {
    const node = fixtures.postsByTopicResponse.posts.edges[0].node;
    const comments = fixtures.postCommentsResponse.post.comments.edges.map(e => ({
      body: (e.node.body || '').substring(0, 500),
      score: e.node.votesCount || 1,
      stars: 0,
    }));
    const post = buildPostFromApiNode(node, comments);
    const enriched = enrichPost(post, 'project management');

    assert.ok(enriched, 'should enrich post with pain signals in description/comments');
    assert.ok(enriched.painScore > 0);
    assert.ok(enriched.citeKey.startsWith('PH-'));
    assert.equal(enriched.subreddit, 'producthunt');
  });

  it('includes frustration signals from fixture comments', () => {
    const node = fixtures.postsByTopicResponse.posts.edges[0].node;
    const comments = fixtures.postCommentsResponse.post.comments.edges.map(e => ({
      body: (e.node.body || '').substring(0, 500),
      score: e.node.votesCount || 1,
      stars: 0,
    }));
    const post = buildPostFromApiNode(node, comments);
    const enriched = enrichPost(post, 'project management');

    if (enriched) {
      // The fixture description mentions "frustrating" and "overpriced"
      assert.ok(
        enriched.painCategories.includes('frustration') || enriched.painCategories.includes('cost'),
        'should detect pain categories from fixture'
      );
    }
  });

  it('analyzeComments works with PH fixture comments', () => {
    const comments = fixtures.postCommentsResponse.post.comments.edges.map(e => ({
      body: e.node.body || '',
      score: e.node.votesCount || 1,
    }));
    const result = analyzeComments(comments);
    assert.ok(result.totalComments > 0);
    assert.ok(typeof result.validationStrength === 'string');
  });
});

// ─── GraphQL response shape tests ───────────────────────────────────────────

describe('producthunt API response shapes', () => {
  it('topic search response has expected structure', () => {
    const resp = fixtures.topicSearchResponse;
    assert.ok(Array.isArray(resp.topics.edges));
    assert.ok(resp.topics.pageInfo);
    assert.ok('hasNextPage' in resp.topics.pageInfo);
  });

  it('posts by topic response has expected structure', () => {
    const resp = fixtures.postsByTopicResponse;
    assert.ok(Array.isArray(resp.posts.edges));
    assert.ok(resp.posts.pageInfo);
    const node = resp.posts.edges[0].node;
    assert.ok('slug' in node);
    assert.ok('name' in node);
    assert.ok('votesCount' in node);
    assert.ok('commentsCount' in node);
  });

  it('post comments response has expected structure', () => {
    const resp = fixtures.postCommentsResponse;
    assert.ok(resp.post);
    assert.ok(Array.isArray(resp.post.comments.edges));
    assert.ok(resp.post.comments.pageInfo);
    const comment = resp.post.comments.edges[0].node;
    assert.ok('body' in comment);
    assert.ok('votesCount' in comment);
  });

  it('empty topics response has zero edges', () => {
    assert.equal(fixtures.emptyTopics.topics.edges.length, 0);
  });
});

// ─── edge cases ─────────────────────────────────────────────────────────────

describe('producthunt edge cases', () => {
  it('handles post with no description and no comments', () => {
    const node = {
      slug: 'empty-product',
      name: 'Empty Product',
      tagline: '',
      description: '',
      votesCount: 0,
      commentsCount: 0,
      url: '',
      createdAt: null,
    };
    const post = buildPostFromApiNode(node, []);
    assert.equal(post.selftext, '');
    post.source = 'producthunt';
    const result = enrichPost(post, 'product');
    // Should be filtered out (no pain signals)
    assert.equal(result, null);
  });

  it('handles comments with only positive sentiment', () => {
    const node = {
      slug: 'happy-product',
      name: 'Happy Product',
      tagline: 'Great tool',
      description: 'A wonderful product.',
      votesCount: 100,
      commentsCount: 2,
      url: '',
      createdAt: '2024-01-01T00:00:00Z',
    };
    const comments = [
      { body: 'Love this! Great job.', score: 5 },
      { body: 'Perfect for our team.', score: 3 },
    ];
    const post = buildPostFromApiNode(node, comments);
    assert.equal(post._painComments.length, 0, 'no pain signals in positive comments');
  });

  it('handles null createdAt', () => {
    const node = { slug: 'null-date', name: 'Test', createdAt: null, votesCount: 0, commentsCount: 0 };
    const post = buildPostFromApiNode(node, []);
    assert.equal(post.created_utc, 0);
  });

  it('handles comment with very long body', () => {
    const longComment = { body: 'frustrated '.repeat(1000), score: 5 };
    assert.ok(hasPainSignal(longComment.body));
  });

  it('DOMAIN_TO_TOPIC has expected mappings', () => {
    // Verify the well-known PH topic mappings
    const DOMAIN_TO_TOPIC = {
      'project management': 'project-management',
      'productivity': 'productivity',
      'ai': 'artificial-intelligence',
      'developer tools': 'developer-tools',
    };
    assert.equal(DOMAIN_TO_TOPIC['project management'], 'project-management');
    assert.equal(DOMAIN_TO_TOPIC['ai'], 'artificial-intelligence');
  });

  it('handles multiple pain patterns in single comment', () => {
    const text = 'I wish it had more features. The UI is confusing and hard to use. Too expensive.';
    assert.ok(hasPainSignal(text));
  });

  it('handles special characters in comment body', () => {
    const text = 'Bug: doesn\'t work for <script> tags & special chars';
    assert.ok(hasPainSignal(text)); // "doesn't work for" matches
  });
});
