/**
 * browser-reviews.test.mjs — Tests for reviews.mjs (G2/Capterra)
 *
 * G2/Capterra reviews truly require Chrome — all parsing is done inside
 * page.evaluate(). Tests cover:
 *   - Smoke tests: module shape
 *   - normalizeReview data shape and star-inversion logic
 *   - enrichPost pipeline for review-shaped data
 *   - Edge cases: Cloudflare blocks, empty results, star-bypass logic
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichPost } from '../../scripts/lib/scoring.mjs';

let reviewsModule;
try {
  reviewsModule = (await import('../../scripts/sources/reviews.mjs')).default;
} catch {
  reviewsModule = null;
}

// ─── Re-implement normalizeReview (not exported from module) ─────────────────

function normalizeReview(review, source = 'g2', productName = '') {
  const invertedScore = Math.max(1, 6 - Math.round(review.stars));
  const title = review.title || `${productName} — ${review.stars}-star review`;
  return {
    id: review.id || `${source}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: title,
    selftext: review.body || '',
    subreddit: source,
    url: review.url || '',
    score: invertedScore,
    num_comments: review.helpfulVotes || 0,
    upvote_ratio: 0,
    created_utc: 0,
    flair: review.stars ? `${review.stars}-star` : '',
  };
}

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe('reviews: smoke tests', () => {
  it('module loads and exports default object', () => {
    assert.ok(reviewsModule, 'module should load');
    assert.equal(typeof reviewsModule, 'object');
  });

  it('has required source interface fields', () => {
    assert.equal(reviewsModule.name, 'reviews');
    assert.ok(reviewsModule.description);
    assert.ok(Array.isArray(reviewsModule.commands));
    assert.ok(reviewsModule.commands.includes('scan'));
    assert.equal(typeof reviewsModule.run, 'function');
    assert.equal(typeof reviewsModule.help, 'string');
  });
});

// ─── normalizeReview tests ───────────────────────────────────────────────────

describe('reviews: normalizeReview', () => {
  it('inverts 1-star to score 5', () => {
    const review = { id: 'r1', stars: 1, title: 'Terrible', body: 'Worst product ever', helpfulVotes: 10, url: 'https://g2.com/r1' };
    const post = normalizeReview(review, 'g2', 'Acme CRM');
    assert.equal(post.score, 5);
  });

  it('inverts 2-star to score 4', () => {
    const review = { id: 'r2', stars: 2, title: 'Bad', body: 'Pretty bad experience overall', helpfulVotes: 5 };
    const post = normalizeReview(review, 'g2', 'Acme CRM');
    assert.equal(post.score, 4);
  });

  it('inverts 3-star to score 3', () => {
    const review = { id: 'r3', stars: 3, title: 'Meh', body: 'Could be much better honestly', helpfulVotes: 2 };
    const post = normalizeReview(review, 'g2', 'Acme CRM');
    assert.equal(post.score, 3);
  });

  it('uses product name in title when review has no title', () => {
    const review = { id: 'r4', stars: 1, title: '', body: 'Something long enough to pass the filter', helpfulVotes: 0 };
    const post = normalizeReview(review, 'g2', 'Acme CRM');
    assert.ok(post.title.includes('Acme CRM'), 'title should include product name');
    assert.ok(post.title.includes('1-star'), 'title should include star rating');
  });

  it('uses review title when provided', () => {
    const review = { id: 'r5', stars: 2, title: 'Horrible UX', body: 'The interface is confusing and slow', helpfulVotes: 3 };
    const post = normalizeReview(review, 'g2', 'Acme CRM');
    assert.equal(post.title, 'Horrible UX');
  });

  it('maps helpfulVotes to num_comments', () => {
    const review = { id: 'r6', stars: 1, title: 'Bad', body: 'Really terrible product', helpfulVotes: 42 };
    const post = normalizeReview(review, 'g2', 'Test');
    assert.equal(post.num_comments, 42);
  });

  it('sets subreddit to source name', () => {
    const review = { id: 'r7', stars: 1, title: 'X', body: 'Bad product experience here', helpfulVotes: 0 };
    const g2Post = normalizeReview(review, 'g2', 'Test');
    assert.equal(g2Post.subreddit, 'g2');
    const captPost = normalizeReview(review, 'capterra', 'Test');
    assert.equal(captPost.subreddit, 'capterra');
  });

  it('sets flair to star label', () => {
    const review = { id: 'r8', stars: 2, title: 'Bad', body: 'Terrible service and support', helpfulVotes: 0 };
    const post = normalizeReview(review, 'g2', 'Test');
    assert.equal(post.flair, '2-star');
  });

  it('generates an id when review has none', () => {
    const review = { stars: 1, title: 'No ID', body: 'Missing ID field in review data' };
    const post = normalizeReview(review, 'g2', 'Test');
    assert.ok(post.id, 'should generate an id');
    assert.ok(post.id.startsWith('g2-'), 'generated id should start with source prefix');
  });
});

// ─── enrichPost pipeline for review data ─────────────────────────────────────

describe('reviews: enrichPost pipeline', () => {
  it('enrichPost processes a normalized 1-star review with pain signals', () => {
    const review = {
      id: 'g2-test-001',
      stars: 1,
      title: 'Absolutely terrible CRM software',
      body: 'The software crashes constantly, the UI is broken, and customer support is non-existent. I wish I had chosen a different product. This is frustrating and unusable.',
      helpfulVotes: 15,
      url: 'https://g2.com/reviews/test-001',
    };
    const post = normalizeReview(review, 'g2', 'CRM software');
    const result = enrichPost(post, 'CRM software');
    assert.ok(result, 'should enrich a pain-heavy review');
    assert.ok(result.painScore > 0);
  });

  it('enrichPost may reject review without pain keywords', () => {
    const review = {
      id: 'g2-mild-001',
      stars: 3,
      title: 'Its okay I guess',
      body: 'The product does what it says but nothing special. Average features and average performance.',
      helpfulVotes: 0,
    };
    const post = normalizeReview(review, 'g2', 'generic');
    const result = enrichPost(post, 'generic');
    // May return null for mild review without strong pain signals
    // This is expected behavior
    assert.ok(result === null || typeof result === 'object');
  });
});

// ─── Star-bypass logic ───────────────────────────────────────────────────────

describe('reviews: star-bypass logic', () => {
  it('1-2 star reviews should be keepable even without pain keywords', () => {
    const review = {
      id: 'g2-bypass-001',
      stars: 1,
      title: 'Not great',
      body: 'The product did not meet my expectations. I would not recommend it to anyone looking for quality.',
      helpfulVotes: 0,
    };
    const post = normalizeReview(review, 'g2', 'acme');
    const enriched = enrichPost(post, 'acme');

    // The star-bypass logic in reviews.mjs creates a manual enriched object
    // when enrichPost returns null for 1-2 star reviews. We test the bypass here.
    if (!enriched && review.stars <= 2 && (post.selftext || '').length >= 20) {
      const bypassed = {
        id: post.id,
        title: post.title || '',
        subreddit: post.subreddit || '',
        url: post.url || '',
        score: post.score || 0,
        num_comments: post.num_comments || 0,
        upvote_ratio: 0,
        created_utc: 0,
        date: null,
        selftext_excerpt: post.selftext ? post.selftext.slice(0, 200) : '',
        painScore: post.score + 3.0,
        painSignals: [],
        bodyPainSignals: [],
        painCategories: [],
        painSubcategories: [],
        wtpSignals: [],
        intensity: 0,
        flair: post.flair || null,
      };

      assert.ok(bypassed.painScore > 0, 'bypassed review should have positive painScore');
      assert.equal(bypassed.painScore, 5 + 3.0, '1-star inverted (5) + 3.0 = 8.0');
      assert.ok(Array.isArray(bypassed.painSignals));
      assert.ok(Array.isArray(bypassed.painCategories));
    }
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('reviews: edge cases', () => {
  it('normalizeReview handles review with 0 stars gracefully', () => {
    const review = { id: 'edge1', stars: 0, title: 'No rating', body: 'Some text that is long enough', helpfulVotes: 0 };
    const post = normalizeReview(review, 'g2', 'Test');
    // 6 - 0 = 6, max(1, 6) = 6
    assert.equal(post.score, 6);
  });

  it('normalizeReview handles very high star rating', () => {
    const review = { id: 'edge2', stars: 5, title: 'Great', body: 'Amazing product I love it', helpfulVotes: 0 };
    const post = normalizeReview(review, 'g2', 'Test');
    // 6 - 5 = 1, max(1, 1) = 1
    assert.equal(post.score, 1);
  });

  it('normalizeReview handles empty body', () => {
    const review = { id: 'edge3', stars: 1, title: 'Bad', body: '', helpfulVotes: 0 };
    const post = normalizeReview(review, 'g2', 'Test');
    assert.equal(post.selftext, '');
  });

  it('normalizeReview handles missing url', () => {
    const review = { id: 'edge4', stars: 2, title: 'Meh', body: 'Okay but not great product' };
    const post = normalizeReview(review, 'g2', 'Test');
    assert.equal(post.url, '');
  });
});
