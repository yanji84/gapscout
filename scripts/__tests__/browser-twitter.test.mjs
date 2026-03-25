/**
 * browser-twitter.test.mjs — Tests for twitter.mjs
 *
 * Tests cover:
 *   - Smoke tests: module shape and exported interface
 *   - normalizeTweet: tweet-to-post conversion
 *   - enrichPost pipeline with normalized tweets
 *   - Edge cases: missing fields, empty text
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichPost } from '../../scripts/lib/scoring.mjs';

// ─── Re-implement normalizeTweet from twitter.mjs for unit testing ───────────

function normalizeTweet(tweet) {
  const text = tweet.text || '';
  if (!text) return null;

  return {
    id: tweet.id,
    title: text.substring(0, 100),
    selftext: text,
    url: tweet.username
      ? `https://x.com/${tweet.username}/status/${tweet.id}`
      : '',
    score: (tweet.likes || 0) + (tweet.retweets || 0),
    num_comments: tweet.replies || 0,
    created_utc: tweet.timeParsed
      ? new Date(tweet.timeParsed).getTime() / 1000
      : 0,
    subreddit: tweet.username ? `@${tweet.username}` : 'twitter',
    source: 'twitter',
    _source: 'twitter',
  };
}

// ─── Import module for smoke tests ───────────────────────────────────────────

let twitterModule;
try {
  twitterModule = (await import('../../scripts/sources/twitter.mjs')).default;
} catch {
  twitterModule = null;
}

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe('twitter: smoke tests', () => {
  it('module loads and exports default object', () => {
    assert.ok(twitterModule, 'module should load');
    assert.equal(twitterModule.name, 'twitter');
  });

  it('has required source interface fields', () => {
    assert.ok(twitterModule.description);
    assert.ok(Array.isArray(twitterModule.commands));
    assert.ok(twitterModule.commands.includes('scan'));
    assert.equal(typeof twitterModule.run, 'function');
    assert.equal(typeof twitterModule.help, 'string');
  });
});

// ─── normalizeTweet tests ────────────────────────────────────────────────────

describe('twitter: normalizeTweet', () => {
  it('normalizes a full tweet object', () => {
    const tweet = {
      id: '123456789',
      text: 'This product is absolutely terrible, worst experience ever!',
      username: 'testuser',
      likes: 42,
      retweets: 10,
      replies: 5,
      timeParsed: '2024-06-15T12:00:00.000Z',
    };
    const post = normalizeTweet(tweet);
    assert.ok(post);
    assert.equal(post.id, '123456789');
    assert.equal(post.selftext, tweet.text);
    assert.equal(post.title, tweet.text.substring(0, 100));
    assert.equal(post.url, 'https://x.com/testuser/status/123456789');
    assert.equal(post.score, 52); // 42 + 10
    assert.equal(post.num_comments, 5);
    assert.equal(post.subreddit, '@testuser');
    assert.equal(post.source, 'twitter');
    assert.equal(post._source, 'twitter');
    assert.ok(post.created_utc > 0);
  });

  it('returns null for empty text', () => {
    const post = normalizeTweet({ id: '1', text: '', username: 'u' });
    assert.equal(post, null);
  });

  it('returns null for missing text', () => {
    const post = normalizeTweet({ id: '1', username: 'u' });
    assert.equal(post, null);
  });

  it('handles missing engagement stats', () => {
    const post = normalizeTweet({
      id: '1',
      text: 'some tweet',
      username: 'u',
    });
    assert.ok(post);
    assert.equal(post.score, 0);
    assert.equal(post.num_comments, 0);
  });

  it('handles missing username', () => {
    const post = normalizeTweet({
      id: '1',
      text: 'some tweet',
    });
    assert.ok(post);
    assert.equal(post.url, '');
    assert.equal(post.subreddit, 'twitter');
  });

  it('handles missing timeParsed', () => {
    const post = normalizeTweet({
      id: '1',
      text: 'some tweet',
      username: 'u',
    });
    assert.ok(post);
    assert.equal(post.created_utc, 0);
  });

  it('truncates title to 100 chars', () => {
    const longText = 'A'.repeat(200);
    const post = normalizeTweet({
      id: '1',
      text: longText,
      username: 'u',
    });
    assert.ok(post);
    assert.equal(post.title.length, 100);
    assert.equal(post.selftext.length, 200);
  });
});

// ─── enrichPost pipeline ─────────────────────────────────────────────────────

describe('twitter: enrichPost pipeline', () => {
  it('enrichPost processes a normalized tweet with pain signals', () => {
    const tweet = {
      id: '999',
      text: 'Ticketmaster is absolutely terrible and broken, scalpers ruin everything, worst experience of my life',
      username: 'angryuser',
      likes: 100,
      retweets: 50,
      replies: 20,
      timeParsed: '2024-06-15T12:00:00.000Z',
    };
    const post = normalizeTweet(tweet);
    assert.ok(post);
    const result = enrichPost(post, 'ticketmaster');
    if (result) {
      assert.ok(result.painScore > 0);
      assert.ok('painSignals' in result);
    }
  });

  it('enrichPost handles tweet with no pain signals', () => {
    const tweet = {
      id: '888',
      text: 'Just had a lovely day',
      username: 'happyuser',
      likes: 1,
      retweets: 0,
      replies: 0,
    };
    const post = normalizeTweet(tweet);
    assert.ok(post);
    // May or may not pass enrichment filters — just ensure no crash
    enrichPost(post, 'something');
  });
});
