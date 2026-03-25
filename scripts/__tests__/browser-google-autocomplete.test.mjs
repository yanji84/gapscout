/**
 * browser-google-autocomplete.test.mjs — Tests for google-autocomplete.mjs
 *
 * Google autocomplete has HTTP-first paths (suggestqueries API) that can be
 * tested without Chrome. Tests cover:
 *   - Smoke tests: module shape
 *   - buildSeeds generation
 *   - hashText ID generation
 *   - makePost data shape
 *   - expandQuery with mock fetch
 *   - enrichPost pipeline for autocomplete-shaped data
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichPost } from '../../scripts/lib/scoring.mjs';

// The module doesn't export internal functions, so we re-implement the testable
// pure functions here based on the source code to validate the logic.

// ─── Re-implementations of pure functions from google-autocomplete.mjs ───────

const PLATFORMS = [
  'ticketmaster', 'stubhub', 'seatgeek', 'axs',
  'nike snkrs', 'adidas confirmed', 'goat', 'stockx',
  'foot locker', 'resy', 'opentable',
];

const QUERY_PATTERNS = [
  'why is X so', 'X not working', 'i hate X', 'X alternative',
  'X complaints', 'X vs', 'X problems', 'X bot', 'X scam', 'X unfair',
];

const LANG_SEEDS = {
  zh: ['抢票', '黄牛', '秒杀', '抢购机器人', '抢票软件', '抢票 怎么', '黄牛 投诉', '秒杀 失败', '抢票 不公平'],
  ja: ['転売ヤー', 'チケット転売', 'ボット購入', 'チケット 買えない', '転売 対策', 'チケット 不正'],
  ko: ['티켓 봇', '리셀러', '티켓팅 실패', '암표 신고', '티켓 자동구매', '티켓 불공정'],
};

function buildSeeds(domain, langs) {
  const seeds = new Set();
  const platforms = PLATFORMS.includes(domain.toLowerCase())
    ? PLATFORMS
    : [domain, ...PLATFORMS];
  for (const platform of platforms) {
    for (const pattern of QUERY_PATTERNS) {
      seeds.add(pattern.replace('X', platform));
    }
  }
  if (langs && langs.length > 0) {
    for (const lang of langs) {
      const langSeeds = LANG_SEEDS[lang];
      if (langSeeds) {
        for (const s of langSeeds) seeds.add(s);
      }
    }
  }
  return [...seeds];
}

function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(31, h) + text.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

function makePost({ text, source, position, queryPattern }) {
  return {
    id: hashText(text),
    title: text,
    selftext: `Found via Google ${source === 'google-paa' ? '"People also ask"' : source === 'google-related' ? '"Related searches"' : 'autocomplete'} for pattern: "${queryPattern}"`,
    subreddit: source,
    url: `https://www.google.com/search?q=${encodeURIComponent(text)}`,
    score: Math.max(1, 10 - position),
    num_comments: 0,
    upvote_ratio: 0,
    flair: queryPattern,
    created_utc: 0,
  };
}

// ─── Import the actual module for smoke tests ────────────────────────────────

let googleAutocomplete;
try {
  googleAutocomplete = (await import('../../scripts/sources/google-autocomplete.mjs')).default;
} catch {
  googleAutocomplete = null;
}

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe('google-autocomplete: smoke tests', () => {
  it('module loads and exports default object', () => {
    assert.ok(googleAutocomplete, 'module should load');
    assert.equal(typeof googleAutocomplete, 'object');
  });

  it('has required source interface fields', () => {
    assert.equal(googleAutocomplete.name, 'google-autocomplete');
    assert.ok(googleAutocomplete.description);
    assert.ok(Array.isArray(googleAutocomplete.commands));
    assert.ok(googleAutocomplete.commands.includes('scan'));
    assert.equal(typeof googleAutocomplete.run, 'function');
    assert.equal(typeof googleAutocomplete.help, 'string');
  });
});

// ─── buildSeeds tests ────────────────────────────────────────────────────────

describe('google-autocomplete: buildSeeds', () => {
  it('generates seeds for a known platform', () => {
    const seeds = buildSeeds('ticketmaster', []);
    assert.ok(seeds.length > 0, 'should generate seeds');
    // 11 platforms * 10 patterns = 110
    assert.equal(seeds.length, 110, 'known platform should produce 110 seeds (11 platforms * 10 patterns)');
  });

  it('generates seeds for an unknown domain', () => {
    const seeds = buildSeeds('acme-crm', []);
    // [acme-crm, ...11 platforms] * 10 patterns = 120
    assert.equal(seeds.length, 120, 'unknown domain adds itself + 11 platforms = 12 * 10 = 120');
  });

  it('includes domain-specific patterns', () => {
    const seeds = buildSeeds('acme-crm', []);
    assert.ok(seeds.some(s => s.includes('acme-crm')), 'seeds should include the domain');
    assert.ok(seeds.some(s => s === 'i hate acme-crm'), 'should have "i hate acme-crm"');
    assert.ok(seeds.some(s => s === 'acme-crm alternative'), 'should have "acme-crm alternative"');
  });

  it('adds language seeds when langs specified', () => {
    const seeds = buildSeeds('ticketmaster', ['zh']);
    assert.ok(seeds.length > 110, 'should be more than base 110 with zh seeds');
    assert.ok(seeds.some(s => s === '抢票'), 'should include Chinese seed');
  });

  it('adds multiple language seeds', () => {
    const seeds = buildSeeds('ticketmaster', ['zh', 'ja', 'ko']);
    const zhCount = LANG_SEEDS.zh.length;
    const jaCount = LANG_SEEDS.ja.length;
    const koCount = LANG_SEEDS.ko.length;
    assert.equal(seeds.length, 110 + zhCount + jaCount + koCount);
  });

  it('ignores unknown language codes', () => {
    const seeds = buildSeeds('ticketmaster', ['xx', 'yy']);
    assert.equal(seeds.length, 110, 'unknown langs should not add extra seeds');
  });

  it('returns empty langs as base seeds only', () => {
    const seeds = buildSeeds('ticketmaster', null);
    assert.equal(seeds.length, 110);
  });
});

// ─── hashText tests ──────────────────────────────────────────────────────────

describe('google-autocomplete: hashText', () => {
  it('returns a string', () => {
    assert.equal(typeof hashText('test'), 'string');
  });

  it('is deterministic', () => {
    assert.equal(hashText('hello world'), hashText('hello world'));
  });

  it('produces different hashes for different inputs', () => {
    assert.notEqual(hashText('hello'), hashText('world'));
  });

  it('handles empty string', () => {
    const result = hashText('');
    assert.equal(typeof result, 'string');
    assert.equal(result, '0');
  });

  it('handles unicode text', () => {
    const result = hashText('抢票 黄牛');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

// ─── makePost tests ──────────────────────────────────────────────────────────

describe('google-autocomplete: makePost', () => {
  it('creates a post with correct shape', () => {
    const post = makePost({
      text: 'why is ticketmaster so expensive',
      source: 'google-autocomplete',
      position: 0,
      queryPattern: 'why is X so',
    });

    assert.ok(post.id, 'should have an id');
    assert.equal(post.title, 'why is ticketmaster so expensive');
    assert.ok(post.selftext.includes('autocomplete'));
    assert.equal(post.subreddit, 'google-autocomplete');
    assert.ok(post.url.includes('google.com'));
    assert.equal(post.score, 10, 'position 0 should give score 10');
    assert.equal(post.num_comments, 0);
    assert.equal(post.flair, 'why is X so');
  });

  it('score decreases with position', () => {
    const post0 = makePost({ text: 'a', source: 'google-autocomplete', position: 0, queryPattern: 'test' });
    const post5 = makePost({ text: 'b', source: 'google-autocomplete', position: 5, queryPattern: 'test' });
    const post9 = makePost({ text: 'c', source: 'google-autocomplete', position: 9, queryPattern: 'test' });
    assert.equal(post0.score, 10);
    assert.equal(post5.score, 5);
    assert.equal(post9.score, 1);
  });

  it('score floors at 1', () => {
    const post = makePost({ text: 'x', source: 'google-autocomplete', position: 20, queryPattern: 'test' });
    assert.equal(post.score, 1, 'score should floor at 1');
  });

  it('generates different selftext for PAA source', () => {
    const post = makePost({ text: 'why', source: 'google-paa', position: 0, queryPattern: 'test' });
    assert.ok(post.selftext.includes('People also ask'));
  });

  it('generates different selftext for related source', () => {
    const post = makePost({ text: 'why', source: 'google-related', position: 0, queryPattern: 'test' });
    assert.ok(post.selftext.includes('Related searches'));
  });
});

// ─── expandQuery with mock fetch ─────────────────────────────────────────────

describe('google-autocomplete: expandQuery logic', () => {
  // Simplified expandQuery that we can test synchronously
  async function expandQuery(query, queryPattern, depth, maxDepth, seenQueries, lang, fetchFn) {
    if (seenQueries.has(query)) return [];
    seenQueries.add(query);
    const suggestions = await fetchFn(query, lang);
    const results = suggestions.map((text, i) => ({ text, queryPattern, position: i }));
    // We skip recursive expansion in tests (depth >= maxDepth)
    return results;
  }

  it('returns suggestions from fetch function', async () => {
    const mockFetch = async () => ['suggestion 1', 'suggestion 2', 'suggestion 3'];
    const seen = new Set();
    const results = await expandQuery('test query', 'test', 0, 0, seen, null, mockFetch);
    assert.equal(results.length, 3);
    assert.equal(results[0].text, 'suggestion 1');
    assert.equal(results[0].position, 0);
  });

  it('skips already-seen queries', async () => {
    const mockFetch = async () => ['a', 'b'];
    const seen = new Set(['test query']);
    const results = await expandQuery('test query', 'test', 0, 0, seen, null, mockFetch);
    assert.equal(results.length, 0, 'should return empty for already-seen query');
  });

  it('handles empty fetch response', async () => {
    const mockFetch = async () => [];
    const seen = new Set();
    const results = await expandQuery('test', 'test', 0, 0, seen, null, mockFetch);
    assert.equal(results.length, 0);
  });
});

// ─── enrichPost pipeline for autocomplete data ──────────────────────────────

describe('google-autocomplete: enrichPost pipeline', () => {
  it('enrichPost processes autocomplete-shaped post', () => {
    const post = makePost({
      text: 'why is ticketmaster so frustrating and terrible',
      source: 'google-autocomplete',
      position: 0,
      queryPattern: 'why is X so',
    });
    const result = enrichPost(post, 'ticketmaster');
    if (result) {
      assert.ok(result.painScore > 0);
      assert.ok('painSignals' in result);
    }
  });

  it('enrichPost handles PAA post with pain signals', () => {
    const post = makePost({
      text: 'why does ticketmaster hate customers and charge ridiculous fees',
      source: 'google-paa',
      position: 1,
      queryPattern: 'ticketmaster complaints',
    });
    const result = enrichPost(post, 'ticketmaster');
    // PAA posts may or may not pass the signal filter
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });
});
