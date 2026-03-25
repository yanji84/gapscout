/**
 * browser-reddit.test.mjs — Tests for reddit-browser.mjs
 *
 * reddit-browser.mjs uses Reddit's .json HTTP API (no browser needed).
 * Tests cover:
 *   - Smoke tests: verify module shape and exports
 *   - Data shape expectations via enrichPost pipeline
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import to handle potential missing deps gracefully
let redditBrowser;
try {
  redditBrowser = (await import('../../scripts/sources/reddit-browser.mjs')).default;
} catch (err) {
  // Module may fail to import if deps are missing — that's fine for smoke tests
  redditBrowser = null;
}

// Also import scoring to test enrichPost pipeline independently
import { enrichPost, computePainScore, matchSignals } from '../../scripts/lib/scoring.mjs';

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe('reddit-browser: smoke tests', () => {
  it('module exports a default object', () => {
    assert.ok(redditBrowser, 'reddit-browser module should load');
    assert.equal(typeof redditBrowser, 'object');
  });

  it('has required source interface fields', () => {
    assert.equal(redditBrowser.name, 'reddit-browser');
    assert.ok(redditBrowser.description, 'should have a description');
    assert.ok(Array.isArray(redditBrowser.commands), 'commands should be an array');
    assert.equal(typeof redditBrowser.run, 'function', 'run should be a function');
    assert.equal(typeof redditBrowser.help, 'string', 'help should be a string');
  });

  it('supports scan and deep-dive commands', () => {
    assert.ok(redditBrowser.commands.includes('scan'));
    assert.ok(redditBrowser.commands.includes('deep-dive'));
  });
});

// ─── Data shape: enrichPost with Reddit-shaped data ──────────────────────────

describe('reddit-browser: enrichPost pipeline with Reddit-shaped posts', () => {
  const mockRedditPost = {
    id: 'abc123',
    title: 'I hate how broken the ticketmaster queue system is',
    selftext: 'Every time I try to buy tickets the site crashes. This is terrible and frustrating. I wish there was an alternative.',
    subreddit: 'concerts',
    url: 'https://old.reddit.com/r/concerts/comments/abc123/i_hate_how_broken/',
    score: 150,
    num_comments: 45,
    upvote_ratio: 0.92,
    flair: 'Rant',
    created_utc: 1700000000,
  };

  it('enrichPost returns an enriched object for a pain post', () => {
    const result = enrichPost(mockRedditPost, 'ticketmaster');
    assert.ok(result, 'enrichPost should return a result for a pain-heavy post');
    assert.equal(result.id, 'abc123');
    assert.equal(typeof result.painScore, 'number');
    assert.ok(result.painScore > 0, 'painScore should be positive for a pain post');
  });

  it('enrichPost includes expected fields', () => {
    const result = enrichPost(mockRedditPost, 'ticketmaster');
    assert.ok(result);
    assert.ok('title' in result);
    assert.ok('painScore' in result);
    assert.ok('painSignals' in result);
    assert.ok('painCategories' in result);
  });

  it('enrichPost returns null for irrelevant posts', () => {
    const irrelevantPost = {
      id: 'xyz789',
      title: 'Beautiful sunset photos from my vacation',
      selftext: 'Had a wonderful time at the beach.',
      subreddit: 'pics',
      url: 'https://old.reddit.com/r/pics/comments/xyz789/',
      score: 500,
      num_comments: 20,
      upvote_ratio: 0.95,
      flair: '',
      created_utc: 1700000000,
    };
    const result = enrichPost(irrelevantPost, 'ticketmaster');
    assert.equal(result, null, 'irrelevant post should return null');
  });

  it('computePainScore returns a number for Reddit-shaped post', () => {
    const score = computePainScore(mockRedditPost);
    assert.equal(typeof score, 'number');
  });

  it('matchSignals detects frustration keywords', () => {
    const signals = matchSignals('I hate how broken this is', 'frustration');
    assert.ok(Array.isArray(signals));
    assert.ok(signals.length > 0, 'should detect frustration signals in "hate" and "broken"');
  });
});

// ─── Edge case: post with minimal data ───────────────────────────────────────

describe('reddit-browser: edge cases', () => {
  it('enrichPost handles post with empty selftext', () => {
    const post = {
      id: 'empty1',
      title: 'Ticketmaster is terrible and frustrating',
      selftext: '',
      subreddit: 'test',
      url: '',
      score: 1,
      num_comments: 0,
      upvote_ratio: 0,
      flair: '',
      created_utc: 0,
    };
    // Should not throw
    const result = enrichPost(post, 'ticketmaster');
    // May or may not return a result depending on signal matching, but should not crash
    assert.equal(typeof result, 'object');
  });

  it('enrichPost handles post with no title', () => {
    const post = {
      id: 'notitle1',
      title: '',
      selftext: 'Ticketmaster is the worst. I hate their broken system. So frustrating.',
      subreddit: 'test',
      url: '',
      score: 1,
      num_comments: 0,
      upvote_ratio: 0,
      flair: '',
      created_utc: 0,
    };
    const result = enrichPost(post, 'ticketmaster');
    // Should not throw even with empty title
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });

  it('enrichPost handles post with zero engagement', () => {
    const post = {
      id: 'zero1',
      title: 'I hate ticketmaster so much, terrible broken service',
      selftext: 'Frustrated with this awful broken experience.',
      subreddit: 'test',
      url: '',
      score: 0,
      num_comments: 0,
      upvote_ratio: 0,
      flair: '',
      created_utc: 0,
    };
    const result = enrichPost(post, 'ticketmaster');
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });
});
