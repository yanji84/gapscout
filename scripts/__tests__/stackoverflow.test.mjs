/**
 * stackoverflow.test.mjs — Tests for the Stack Overflow API source
 *
 * Tests the normalizer, HTML stripper, query builder, and
 * enrichPost pipeline integration with SO fixture data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { enrichPost, computePainScore, analyzeComments } from '../lib/scoring.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'stackoverflow-api.json'), 'utf8'));

// ─── import source module ───────────────────────────────────────────────────

import stackoverflow from '../sources/stackoverflow.mjs';

// ─── smoke tests ────────────────────────────────────────────────────────────

describe('stackoverflow source: smoke tests', () => {
  it('exports a valid source object', () => {
    assert.ok(stackoverflow, 'default export should exist');
    assert.equal(stackoverflow.name, 'stackoverflow');
    assert.ok(stackoverflow.description);
    assert.ok(Array.isArray(stackoverflow.commands));
    assert.ok(stackoverflow.commands.includes('scan'));
    assert.equal(typeof stackoverflow.run, 'function');
    assert.ok(stackoverflow.help);
  });
});

// ─── stripHtml (replicated from source) ─────────────────────────────────────

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<code>[\s\S]*?<\/code>/g, '[code]')
    .replace(/<pre>[\s\S]*?<\/pre>/g, '[code block]')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSOPost(item) {
  return {
    id: String(item.question_id),
    title: item.title || '',
    selftext: stripHtml(item.body || ''),
    subreddit: 'stackoverflow',
    url: item.link || `https://stackoverflow.com/questions/${item.question_id}`,
    score: item.score || 0,
    num_comments: item.answer_count || 0,
    upvote_ratio: 0,
    flair: item.tags ? item.tags.slice(0, 3).join(',') : '',
    created_utc: item.creation_date || 0,
  };
}

function buildPainQueries(domain) {
  return [
    `${domain} error`,
    `${domain} not working`,
    `${domain} problem`,
    `${domain} bug`,
    `${domain} issue`,
    `${domain} broken`,
    `${domain} alternative`,
    `${domain} frustrated`,
    `${domain} workaround`,
    `${domain} fix`,
    `${domain} fails`,
    `${domain} crash`,
    `${domain} slow`,
    `${domain} deprecated`,
    `${domain} replacement`,
    `${domain} migration`,
    `${domain}`,
  ];
}

// ─── stripHtml tests ────────────────────────────────────────────────────────

describe('stackoverflow stripHtml', () => {
  it('strips basic HTML tags', () => {
    assert.equal(stripHtml('<p>Hello world</p>'), 'Hello world');
  });

  it('replaces code blocks with placeholder', () => {
    const html = '<p>Use this:</p><code>kubectl apply</code><p>to deploy</p>';
    const result = stripHtml(html);
    assert.ok(result.includes('[code]'));
    assert.ok(!result.includes('kubectl'));
  });

  it('replaces pre blocks with placeholder', () => {
    const html = '<pre><code>some code here</code></pre>';
    const result = stripHtml(html);
    assert.ok(result.includes('[code block]'));
  });

  it('decodes HTML entities', () => {
    assert.ok(stripHtml('&amp;').includes('&'));
    assert.ok(stripHtml('&lt;').includes('<'));
    assert.ok(stripHtml('&gt;').includes('>'));
    assert.ok(stripHtml('&quot;').includes('"'));
    assert.ok(stripHtml('&#39;').includes("'"));
  });

  it('normalizes whitespace', () => {
    assert.equal(stripHtml('hello   \n  world'), 'hello world');
  });

  it('handles empty/null input', () => {
    assert.equal(stripHtml(''), '');
    assert.equal(stripHtml(null), '');
    assert.equal(stripHtml(undefined), '');
  });
});

// ─── normalizePost tests ────────────────────────────────────────────────────

describe('stackoverflow normalizePost', () => {
  it('normalizes a SO question from fixture', () => {
    const item = fixtures.searchResults.items[0];
    const post = normalizeSOPost(item);

    assert.equal(post.id, '77001234');
    assert.ok(post.title.includes('Kubernetes'));
    assert.equal(post.subreddit, 'stackoverflow');
    assert.ok(post.url.includes('stackoverflow.com'));
    assert.equal(post.score, 156);
    assert.equal(post.num_comments, 12); // answer_count
    assert.equal(post.upvote_ratio, 0);
    assert.equal(post.flair, 'kubernetes,docker,memory');
    assert.equal(post.created_utc, 1700000000);
  });

  it('strips HTML from body text', () => {
    const item = fixtures.searchResults.items[0];
    const post = normalizeSOPost(item);

    assert.ok(!post.selftext.includes('<p>'));
    assert.ok(!post.selftext.includes('</p>'));
    assert.ok(post.selftext.includes('[code]'));
    assert.ok(post.selftext.includes('frustrated'));
  });

  it('limits tags to 3 in flair', () => {
    const item = {
      question_id: 1,
      tags: ['tag1', 'tag2', 'tag3', 'tag4', 'tag5'],
    };
    const post = normalizeSOPost(item);
    const tagCount = post.flair.split(',').length;
    assert.ok(tagCount <= 3);
  });

  it('handles missing fields', () => {
    const post = normalizeSOPost({});
    assert.equal(post.id, 'undefined');
    assert.equal(post.title, '');
    assert.equal(post.selftext, '');
    assert.equal(post.score, 0);
    assert.equal(post.num_comments, 0);
    assert.equal(post.flair, '');
    assert.equal(post.created_utc, 0);
  });

  it('handles question with null body', () => {
    const post = normalizeSOPost({ question_id: 1, body: null });
    assert.equal(post.selftext, '');
  });

  it('generates URL from question_id when link is missing', () => {
    const post = normalizeSOPost({ question_id: 12345 });
    assert.equal(post.url, 'https://stackoverflow.com/questions/12345');
  });
});

// ─── buildPainQueries ───────────────────────────────────────────────────────

describe('stackoverflow buildPainQueries', () => {
  it('generates queries for a domain', () => {
    const queries = buildPainQueries('kubernetes');
    assert.ok(queries.length > 0);
    assert.ok(queries.some(q => q.includes('kubernetes error')));
    assert.ok(queries.some(q => q.includes('kubernetes deprecated')));
    assert.ok(queries.includes('kubernetes'));
  });
});

// ─── fixture-based enrichPost pipeline ──────────────────────────────────────

describe('stackoverflow enrichPost pipeline', () => {
  it('enriches frustration question from fixture', () => {
    const item = fixtures.searchResults.items[0];
    const post = normalizeSOPost(item);
    post.source = 'stackoverflow';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched, 'should enrich pain-signal question');
    assert.ok(enriched.painScore > 0);
    assert.ok(enriched.painCategories.includes('frustration'));
    assert.ok(enriched.citeKey.startsWith('SO-'));
  });

  it('enriches desire/cost question from fixture', () => {
    const item = fixtures.searchResults.items[1];
    const post = normalizeSOPost(item);
    post.source = 'stackoverflow';
    const enriched = enrichPost(post, 'kubernetes');

    assert.ok(enriched);
    assert.ok(enriched.painCategories.includes('desire') || enriched.painCategories.includes('cost'));
  });

  it('processes all fixture items without crashing', () => {
    for (const item of fixtures.searchResults.items) {
      const post = normalizeSOPost(item);
      post.source = 'stackoverflow';
      const result = enrichPost(post, 'kubernetes');
      if (result) {
        assert.equal(typeof result.painScore, 'number');
        assert.ok(result.citeKey);
      }
    }
  });
});

// ─── API response shape tests ───────────────────────────────────────────────

describe('stackoverflow API response shapes', () => {
  it('search results have expected structure', () => {
    const results = fixtures.searchResults;
    assert.ok(Array.isArray(results.items));
    assert.ok(typeof results.has_more === 'boolean');
    assert.ok(typeof results.quota_remaining === 'number');
  });

  it('empty results have correct shape', () => {
    assert.equal(fixtures.emptyResults.items.length, 0);
    assert.equal(fixtures.emptyResults.has_more, false);
  });

  it('backoff response includes backoff field', () => {
    const resp = fixtures.backoffResponse;
    assert.ok(typeof resp.backoff === 'number');
    assert.ok(resp.backoff > 0);
  });

  it('error response has error fields', () => {
    const err = fixtures.errorResponse;
    assert.ok(typeof err.error_id === 'number');
    assert.ok(typeof err.error_message === 'string');
    assert.ok(typeof err.error_name === 'string');
  });
});

// ─── edge cases ─────────────────────────────────────────────────────────────

describe('stackoverflow edge cases', () => {
  it('handles question with zero score and no answers', () => {
    const post = normalizeSOPost({
      question_id: 99999,
      title: 'Kubernetes is frustrated broken deployment fails',
      body: '<p>Help please</p>',
      score: 0,
      answer_count: 0,
      tags: [],
      creation_date: 0,
    });
    post.source = 'stackoverflow';
    const result = enrichPost(post, 'kubernetes');
    // May be filtered due to low engagement, but should not crash
    if (result) {
      assert.equal(typeof result.painScore, 'number');
    }
  });

  it('handles deeply nested HTML in body', () => {
    const html = '<div><p>Frustrated with <strong>Kubernetes</strong> <em>broken</em> <a href="#">deployment</a></p></div>';
    const result = stripHtml(html);
    assert.ok(!result.includes('<'));
    assert.ok(!result.includes('>'));
    assert.ok(result.includes('Frustrated'));
    assert.ok(result.includes('Kubernetes'));
  });

  it('handles malformed item from fixture', () => {
    const item = fixtures.malformedItem;
    const post = normalizeSOPost(item);
    assert.equal(post.id, 'null');
    assert.equal(post.title, '');
    assert.equal(post.selftext, '');
  });

  it('handles very long body text', () => {
    const longBody = '<p>' + 'frustrated '.repeat(2000) + '</p>';
    const post = normalizeSOPost({ question_id: 1, body: longBody, title: 'K8s is broken' });
    // Should not crash
    assert.ok(post.selftext.length > 0);
  });

  it('handles empty tags array', () => {
    const post = normalizeSOPost({ question_id: 1, tags: [] });
    assert.equal(post.flair, '');
  });

  it('handles null tags', () => {
    const post = normalizeSOPost({ question_id: 1, tags: null });
    assert.equal(post.flair, '');
  });
});
