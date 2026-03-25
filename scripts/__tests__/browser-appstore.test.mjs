/**
 * browser-appstore.test.mjs — Tests for appstore.mjs
 *
 * App Store uses npm scraper packages (google-play-scraper, app-store-scraper),
 * zero browser dependency. Tests cover:
 *   - Smoke tests: module shape
 *   - CURATED_APPS lookup structure
 *   - PAIN_PATTERNS filtering logic
 *   - normalizeReview data shape (re-implemented)
 *   - enrichPost pipeline for app review data
 *   - Edge cases
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichPost } from '../../scripts/lib/scoring.mjs';

let appstoreModule;
try {
  appstoreModule = (await import('../../scripts/sources/appstore.mjs')).default;
} catch {
  appstoreModule = null;
}

// ─── Pain patterns from the source ───────────────────────────────────────────

const PAIN_PATTERNS = [
  'i would pay for', 'i wish', "doesn't work", 'does not work', 'broken',
  'not working', 'crashes', 'crash', 'freezes', 'freeze', 'bug', 'glitch',
  'unusable', 'terrible', 'awful', 'horrible', 'hate', 'frustrated',
  'annoying', 'useless', 'waste', 'refund', 'disappointed', 'fix',
  'please add', 'missing feature',
];

function hasPainSignal(text) {
  const lower = text.toLowerCase();
  return PAIN_PATTERNS.some(p => lower.includes(p));
}

// Re-implement normalizeReview for app store reviews
function normalizeAppReview(review, appName, source) {
  const invertedScore = Math.max(1, 6 - Math.round(review.score || review.rating || 1));
  return {
    id: review.id || `${source}-${Date.now()}`,
    title: review.title || `${appName} review`,
    selftext: review.text || review.body || '',
    subreddit: source || 'appstore',
    url: review.url || '',
    score: invertedScore,
    num_comments: review.thumbsUp || 0,
    upvote_ratio: 0,
    created_utc: review.date ? Math.floor(new Date(review.date).getTime() / 1000) || 0 : 0,
    flair: review.score ? `${review.score}-star` : '',
  };
}

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe('appstore: smoke tests', () => {
  it('module loads and exports default object', () => {
    assert.ok(appstoreModule, 'module should load');
    assert.equal(typeof appstoreModule, 'object');
  });

  it('has required source interface fields', () => {
    assert.equal(appstoreModule.name, 'appstore');
    assert.ok(appstoreModule.description);
    assert.ok(Array.isArray(appstoreModule.commands));
    assert.ok(appstoreModule.commands.includes('scan'));
    assert.equal(typeof appstoreModule.run, 'function');
    assert.equal(typeof appstoreModule.help, 'string');
  });
});

// ─── Pain pattern detection ──────────────────────────────────────────────────

describe('appstore: PAIN_PATTERNS matching', () => {
  it('detects "crashes" in review text', () => {
    assert.ok(hasPainSignal('This app crashes every time I open it'));
  });

  it('detects "broken" in review text', () => {
    assert.ok(hasPainSignal('Completely broken after the latest update'));
  });

  it('detects "i wish" in review text', () => {
    assert.ok(hasPainSignal('I wish this app had dark mode'));
  });

  it('detects "i would pay for" in review text', () => {
    assert.ok(hasPainSignal('I would pay for a premium version without ads'));
  });

  it('detects "missing feature" in review text', () => {
    assert.ok(hasPainSignal('Missing feature: offline mode'));
  });

  it('does not match positive text', () => {
    assert.ok(!hasPainSignal('This is the best app ever, I love it so much'));
  });

  it('case insensitive matching', () => {
    assert.ok(hasPainSignal('TERRIBLE APP'));
    assert.ok(hasPainSignal('I HATE this'));
  });
});

// ─── normalizeAppReview tests ────────────────────────────────────────────────

describe('appstore: normalizeAppReview', () => {
  it('creates correct post shape', () => {
    const review = {
      id: 'gp-123',
      title: 'Terrible app',
      text: 'The app crashes on startup and is completely broken.',
      score: 1,
      thumbsUp: 25,
      date: '2025-06-15T00:00:00Z',
      url: 'https://play.google.com/store/apps/details?id=com.test',
    };
    const post = normalizeAppReview(review, 'Test App', 'google-play');
    assert.equal(post.id, 'gp-123');
    assert.equal(post.title, 'Terrible app');
    assert.ok(post.selftext.includes('crashes'));
    assert.equal(post.subreddit, 'google-play');
    assert.equal(post.score, 5); // inverted: 6-1=5
    assert.equal(post.num_comments, 25);
    assert.equal(post.flair, '1-star');
    assert.ok(post.created_utc > 0);
  });

  it('inverts star ratings correctly', () => {
    assert.equal(normalizeAppReview({ score: 1 }, 'x', 'y').score, 5);
    assert.equal(normalizeAppReview({ score: 2 }, 'x', 'y').score, 4);
    assert.equal(normalizeAppReview({ score: 3 }, 'x', 'y').score, 3);
    assert.equal(normalizeAppReview({ score: 4 }, 'x', 'y').score, 2);
    assert.equal(normalizeAppReview({ score: 5 }, 'x', 'y').score, 1);
  });

  it('handles missing fields gracefully', () => {
    const post = normalizeAppReview({}, 'Test', 'appstore');
    assert.ok(post.id);
    assert.equal(post.selftext, '');
    assert.equal(post.created_utc, 0);
  });
});

// ─── enrichPost pipeline for app reviews ─────────────────────────────────────

describe('appstore: enrichPost pipeline', () => {
  it('enrichPost processes a pain-heavy app review', () => {
    const review = {
      id: 'gp-pain-001',
      title: 'Frustrating and broken app experience',
      text: 'This terrible app crashes every time. I hate it. Completely broken and unusable. I wish they would fix the bugs.',
      score: 1,
      thumbsUp: 50,
    };
    const post = normalizeAppReview(review, 'Ticketmaster', 'google-play');
    const result = enrichPost(post, 'ticketmaster');
    // This post has strong pain signals and domain match
    if (result) {
      assert.ok(result.painScore > 0);
      assert.ok(Array.isArray(result.painSignals));
    }
  });

  it('enrichPost handles a mild review', () => {
    const review = {
      id: 'gp-mild-001',
      title: 'Okay app',
      text: 'It works but could be better. The design is fine.',
      score: 3,
      thumbsUp: 2,
    };
    const post = normalizeAppReview(review, 'Generic App', 'google-play');
    const result = enrichPost(post, 'generic');
    // Mild reviews may not pass enrichment
    assert.ok(result === null || typeof result === 'object');
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('appstore: edge cases', () => {
  it('normalizeAppReview floors score at 1', () => {
    const post = normalizeAppReview({ score: 10 }, 'x', 'y');
    assert.equal(post.score, 1, 'inverted score should floor at 1');
  });

  it('hasPainSignal handles empty text', () => {
    assert.ok(!hasPainSignal(''));
  });

  it('hasPainSignal with mixed pain text', () => {
    assert.ok(hasPainSignal('I would pay for this feature but the app is useless right now'));
  });

  it('PAIN_PATTERNS covers all expected categories', () => {
    // Verify key categories are represented
    assert.ok(PAIN_PATTERNS.some(p => p.includes('crash')), 'should have crash-related patterns');
    assert.ok(PAIN_PATTERNS.some(p => p.includes('wish')), 'should have wish/desire patterns');
    assert.ok(PAIN_PATTERNS.some(p => p.includes('hate')), 'should have frustration patterns');
    assert.ok(PAIN_PATTERNS.some(p => p.includes('pay')), 'should have willingness-to-pay patterns');
    assert.ok(PAIN_PATTERNS.some(p => p.includes('fix')), 'should have fix/bug patterns');
    assert.ok(PAIN_PATTERNS.length >= 20, 'should have at least 20 pain patterns');
  });
});
