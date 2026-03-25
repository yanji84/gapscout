/**
 * Analysis tests — groupBySubcategory, classifyDepth, computeMatrix,
 * aggregateMoneyTrail, extractUnspokenPain, aggregateTools
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupBySubcategory,
  classifyDepth,
  computeMatrix,
  aggregateMoneyTrail,
  extractUnspokenPain,
  aggregateTools,
} from '../lib/report/analysis.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePost(overrides = {}) {
  return {
    id: 'test-' + Math.random().toString(36).slice(2, 6),
    title: 'Test post',
    url: 'https://example.com',
    score: 10,
    num_comments: 5,
    painScore: 8,
    intensity: 2,
    painSubcategories: ['product-availability'],
    painCategories: [],
    painSignals: [],
    wtpSignals: [],
    _source: 'reddit',
    ...overrides,
  };
}

// ─── groupBySubcategory ─────────────────────────────────────────────────────

describe('groupBySubcategory', () => {
  it('groups posts by their painSubcategories', () => {
    const posts = [
      makePost({ painSubcategories: ['pricing'] }),
      makePost({ painSubcategories: ['pricing'] }),
      makePost({ painSubcategories: ['digital-platform'] }),
    ];
    const groups = groupBySubcategory(posts);
    assert.equal(groups.size, 2);
    assert.equal(groups.get('pricing').length, 2);
    assert.equal(groups.get('digital-platform').length, 1);
  });

  it('places a post with multiple subcategories in each group', () => {
    const posts = [
      makePost({ painSubcategories: ['pricing', 'product-availability'] }),
    ];
    const groups = groupBySubcategory(posts);
    assert.equal(groups.size, 2);
    assert.equal(groups.get('pricing').length, 1);
    assert.equal(groups.get('product-availability').length, 1);
  });

  it('force-categorizes posts with empty subcategories using content analysis', () => {
    const posts = [
      makePost({
        painSubcategories: [],
        title: 'Bots are buying up all the tickets and they sold out instantly',
        selftext_excerpt: 'Can never find tickets at face value',
      }),
    ];
    const groups = groupBySubcategory(posts);
    assert.ok(groups.has('product-availability'), 'Should force-categorize to product-availability');
  });

  it('discards posts that cannot be categorized', () => {
    const posts = [
      makePost({
        painSubcategories: [],
        title: 'Nice weather today',
        selftext_excerpt: 'Went for a walk',
      }),
    ];
    const groups = groupBySubcategory(posts);
    assert.equal(groups.size, 0, 'Uncategorizable posts should be discarded');
  });

  it('returns empty map for empty input', () => {
    const groups = groupBySubcategory([]);
    assert.equal(groups.size, 0);
  });

  it('force-categorizes pricing keywords correctly', () => {
    const posts = [
      makePost({
        painSubcategories: [],
        title: 'Too expensive tickets with hidden fees and price hike',
      }),
    ];
    const groups = groupBySubcategory(posts);
    assert.ok(groups.has('pricing'));
  });

  it('force-categorizes fraud keywords', () => {
    const posts = [
      makePost({
        painSubcategories: [],
        title: 'Got a fake ticket scam from a reseller',
      }),
    ];
    const groups = groupBySubcategory(posts);
    assert.ok(groups.has('fraud'));
  });

  it('force-categorizes burnout keywords', () => {
    const posts = [
      makePost({
        painSubcategories: [],
        title: 'I quit trying to buy tickets, giving up',
      }),
    ];
    const groups = groupBySubcategory(posts);
    assert.ok(groups.has('burnout'));
  });
});

// ─── classifyDepth ──────────────────────────────────────────────────────────

describe('classifyDepth', () => {
  it('returns urgent when money trail >= 3', () => {
    const posts = [
      makePost({
        _analysis: { moneyTrailCount: 3, validationStrength: 'moderate', intensityLevel: 'moderate' },
      }),
    ];
    assert.equal(classifyDepth(posts), 'urgent');
  });

  it('returns urgent when strong validation + high intensity', () => {
    const posts = [
      makePost({
        _analysis: { moneyTrailCount: 0, validationStrength: 'strong', intensityLevel: 'high' },
      }),
    ];
    assert.equal(classifyDepth(posts), 'urgent');
  });

  it('returns active when strong validation only', () => {
    const posts = [
      makePost({
        _analysis: { moneyTrailCount: 0, validationStrength: 'strong', intensityLevel: 'moderate' },
      }),
    ];
    assert.equal(classifyDepth(posts), 'active');
  });

  it('returns active when desire signals present', () => {
    const posts = [
      makePost({
        painCategories: ['desire'],
        painSignals: ['looking for'],
      }),
    ];
    assert.equal(classifyDepth(posts), 'active');
  });

  it('returns surface for low-signal posts', () => {
    const posts = [
      makePost({
        painScore: 2,
        intensity: 0,
        painCategories: [],
        painSignals: [],
        wtpSignals: [],
      }),
    ];
    assert.equal(classifyDepth(posts), 'surface');
  });

  it('uses LLM depth when available for majority of posts', () => {
    const posts = [
      makePost({ llmAugmentation: { painDepth: 'urgent' } }),
      makePost({ llmAugmentation: { painDepth: 'urgent' } }),
      makePost({ llmAugmentation: { painDepth: 'active' } }),
    ];
    assert.equal(classifyDepth(posts), 'urgent');
  });

  it('returns active for post-level WTP signals', () => {
    const posts = [
      makePost({ wtpSignals: ['would pay'] }),
    ];
    assert.equal(classifyDepth(posts), 'active');
  });

  it('returns active for high post-level intensity', () => {
    const posts = [
      makePost({ intensity: 3 }),
    ];
    assert.equal(classifyDepth(posts), 'active');
  });
});

// ─── computeMatrix ──────────────────────────────────────────────────────────

describe('computeMatrix', () => {
  it('returns primary for frequent + intense (with analysis)', () => {
    const posts = Array.from({ length: 5 }, () =>
      makePost({ _analysis: { intensityLevel: 'high' } })
    );
    const result = computeMatrix(posts, 2);
    assert.equal(result.position, 'primary');
    assert.ok(result.frequency >= 4);
    assert.ok(result.intensityScore > 0);
  });

  it('returns hidden_gem for infrequent + intense', () => {
    const posts = [
      makePost({ _analysis: { intensityLevel: 'extreme' } }),
    ];
    const result = computeMatrix(posts, 1);
    assert.equal(result.position, 'hidden_gem');
  });

  it('returns background for frequent + low intensity', () => {
    const posts = Array.from({ length: 5 }, () =>
      makePost({ _analysis: { intensityLevel: 'low' } })
    );
    const result = computeMatrix(posts, 2);
    assert.equal(result.position, 'background');
  });

  it('returns ignore for infrequent + low intensity', () => {
    const posts = [
      makePost({ _analysis: { intensityLevel: 'low' } }),
    ];
    const result = computeMatrix(posts, 1);
    assert.equal(result.position, 'ignore');
  });

  it('applies cross-source bonus to frequency', () => {
    const posts = [makePost(), makePost()];
    const withBonus = computeMatrix(posts, 3);
    const withoutBonus = computeMatrix(posts, 1);
    assert.ok(withBonus.frequency > withoutBonus.frequency,
      'Cross-source bonus should increase frequency');
  });

  it('handles posts without analysis (keyword-based intensity)', () => {
    const posts = [
      makePost({ painScore: 15, intensity: 3 }),
      makePost({ painScore: 12, intensity: 3 }),
      makePost({ painScore: 10, intensity: 2 }),
    ];
    const result = computeMatrix(posts, 2);
    assert.ok(result.intensityScore > 0);
    assert.ok(typeof result.position === 'string');
  });

  it('blends deep-dive and shallow post intensities', () => {
    const posts = [
      makePost({ _analysis: { intensityLevel: 'high' } }),
      makePost({ painScore: 14 }),  // no _analysis
    ];
    const result = computeMatrix(posts, 1);
    assert.ok(result.intensityScore > 0);
  });

  it('returns intensityScore rounded to one decimal', () => {
    const posts = [
      makePost({ _analysis: { intensityLevel: 'moderate' } }),
    ];
    const result = computeMatrix(posts, 1);
    const decimals = String(result.intensityScore).split('.')[1] || '';
    assert.ok(decimals.length <= 1, 'intensityScore should have at most 1 decimal');
  });
});

// ─── aggregateMoneyTrail ─────────────────────────────────────────────────────

describe('aggregateMoneyTrail', () => {
  it('returns strong for >= 5 signals', () => {
    const posts = [
      makePost({
        _analysis: {
          moneyTrailCount: 5,
          moneyTrail: [
            { body: 'Would pay $10/mo', url: 'https://example.com/1' },
            { body: 'Already bought a tool', url: 'https://example.com/2' },
          ],
        },
      }),
    ];
    const result = aggregateMoneyTrail(posts);
    assert.equal(result.strength, 'strong');
    assert.equal(result.totalCount, 5);
    assert.ok(result.examples.length > 0);
  });

  it('returns moderate for 2-4 signals', () => {
    const posts = [
      makePost({
        _analysis: { moneyTrailCount: 3, moneyTrail: [] },
      }),
    ];
    const result = aggregateMoneyTrail(posts);
    assert.equal(result.strength, 'moderate');
  });

  it('returns weak for 1 signal', () => {
    const posts = [
      makePost({ _analysis: { moneyTrailCount: 1, moneyTrail: [] } }),
    ];
    assert.equal(aggregateMoneyTrail(posts).strength, 'weak');
  });

  it('returns none for 0 signals', () => {
    const posts = [
      makePost({ _analysis: { moneyTrailCount: 0, moneyTrail: [] } }),
    ];
    assert.equal(aggregateMoneyTrail(posts).strength, 'none');
  });

  it('counts wtpSignals from posts without analysis', () => {
    const posts = [
      makePost({ wtpSignals: ['would pay', 'per month'] }),
      makePost({ wtpSignals: ['subscription'] }),
    ];
    const result = aggregateMoneyTrail(posts);
    assert.equal(result.totalCount, 3);
    assert.equal(result.strength, 'moderate');
  });

  it('limits examples to 4', () => {
    const posts = [
      makePost({
        _analysis: {
          moneyTrailCount: 10,
          moneyTrail: Array.from({ length: 6 }, (_, i) => ({
            body: `Signal ${i}`,
            url: `https://example.com/${i}`,
          })),
        },
      }),
    ];
    const result = aggregateMoneyTrail(posts);
    assert.ok(result.examples.length <= 4);
  });
});

// ─── extractUnspokenPain ─────────────────────────────────────────────────────

describe('extractUnspokenPain', () => {
  it('extracts from solution attempts containing workaround/hack keywords', () => {
    const posts = [
      makePost({
        _analysis: {
          solutionAttempts: [
            { body: 'Using a workaround with multiple browsers', url: 'https://example.com/1' },
          ],
          topQuotes: [],
        },
      }),
    ];
    const result = extractUnspokenPain(posts);
    assert.ok(result.length > 0);
    assert.ok(result[0].body.includes('workaround'));
  });

  it('extracts from high-score top quotes', () => {
    const posts = [
      makePost({
        _analysis: {
          solutionAttempts: [],
          topQuotes: [
            { body: 'This system is completely broken', score: 15, url: 'https://example.com/q1' },
          ],
        },
      }),
    ];
    const result = extractUnspokenPain(posts);
    assert.ok(result.length > 0);
  });

  it('includes LLM unspoken pain signals', () => {
    const posts = [
      makePost({
        llmAugmentation: {
          unspokenPain: 'Users actually want fairness, not just cheaper tickets',
        },
        url: 'https://example.com',
      }),
    ];
    const result = extractUnspokenPain(posts);
    assert.ok(result.length > 0);
    assert.ok(result[0].body.includes('[LLM]'));
    assert.ok(result[0].llmSource);
  });

  it('deduplicates by first 40 chars', () => {
    const posts = [
      makePost({
        _analysis: {
          solutionAttempts: [
            { body: 'Using a workaround with multiple browsers approach 1', url: 'https://example.com/1' },
            { body: 'Using a workaround with multiple browsers approach 2', url: 'https://example.com/2' },
          ],
          topQuotes: [],
        },
      }),
    ];
    const result = extractUnspokenPain(posts);
    assert.equal(result.length, 1, 'Should deduplicate similar hints');
  });

  it('limits to 5 results', () => {
    const posts = Array.from({ length: 10 }, (_, i) =>
      makePost({
        _analysis: {
          solutionAttempts: [
            { body: `Workaround ${i} - using hack ${i} that still failed`, url: `https://example.com/${i}` },
          ],
          topQuotes: [
            { body: `Quote ${i} unique text`, score: 20, url: `https://example.com/q${i}` },
          ],
        },
      })
    );
    const result = extractUnspokenPain(posts);
    assert.ok(result.length <= 5);
  });

  it('returns empty for posts with no relevant signals', () => {
    const posts = [
      makePost({
        _analysis: {
          solutionAttempts: [{ body: 'Just contacted support' }],
          topQuotes: [{ body: 'OK experience', score: 1 }],
        },
      }),
    ];
    const result = extractUnspokenPain(posts);
    assert.equal(result.length, 0);
  });
});

// ─── aggregateTools ──────────────────────────────────────────────────────────

describe('aggregateTools', () => {
  it('collects mentioned tools from analysis', () => {
    const posts = [
      makePost({ _analysis: { mentionedTools: ['AXS', 'DICE'] } }),
      makePost({ _analysis: { mentionedTools: ['SeatGeek'] } }),
    ];
    const result = aggregateTools(posts);
    assert.ok(result.includes('AXS'));
    assert.ok(result.includes('DICE'));
    assert.ok(result.includes('SeatGeek'));
  });

  it('filters out known false positives', () => {
    const posts = [
      makePost({ _analysis: { mentionedTools: ['AXS', 'Amazon', 'Google', 'San Francisco'] } }),
    ];
    const result = aggregateTools(posts);
    assert.ok(result.includes('AXS'));
    assert.ok(!result.includes('Amazon'));
    assert.ok(!result.includes('Google'));
    assert.ok(!result.includes('San Francisco'));
  });

  it('extracts domain competitors from solution attempt text', () => {
    const posts = [
      makePost({
        _analysis: {
          mentionedTools: [],
          solutionAttempts: [
            { body: 'I switched to Eventbrite and it was much better' },
          ],
        },
      }),
    ];
    const result = aggregateTools(posts);
    assert.ok(result.includes('Eventbrite'));
  });

  it('deduplicates tools', () => {
    const posts = [
      makePost({ _analysis: { mentionedTools: ['AXS', 'AXS', 'DICE'] } }),
    ];
    const result = aggregateTools(posts);
    const axsCount = result.filter(t => t === 'AXS').length;
    assert.equal(axsCount, 1);
  });

  it('limits to 10 tools', () => {
    const posts = [
      makePost({
        _analysis: {
          mentionedTools: Array.from({ length: 15 }, (_, i) => `Tool${i}`),
        },
      }),
    ];
    const result = aggregateTools(posts);
    assert.ok(result.length <= 10);
  });

  it('sorts known domain competitors first', () => {
    const posts = [
      makePost({
        _analysis: { mentionedTools: ['UnknownTool', 'AXS', 'SomeOther', 'DICE'] },
      }),
    ];
    const result = aggregateTools(posts);
    // Known competitors should come before unknown ones
    const axsIdx = result.indexOf('AXS');
    const unknownIdx = result.indexOf('UnknownTool');
    assert.ok(axsIdx < unknownIdx, 'Known competitors should be sorted first');
  });
});
