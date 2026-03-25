/**
 * Synthesis tests — buildWorthinessScore, determineVerdict, getAudience,
 * buildOpportunityText, generateIdeaSketch
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorthinessScore,
  determineVerdict,
  buildOpportunityText,
  getAudience,
  generateIdeaSketch,
} from '../lib/report/synthesis.mjs';

// ─── buildWorthinessScore ────────────────────────────────────────────────────

describe('buildWorthinessScore', () => {
  it('returns max 100', () => {
    const score = buildWorthinessScore('urgent', 'primary', { strength: 'strong' }, 5, 50);
    assert.equal(score, 100);
  });

  it('scores higher for urgent depth', () => {
    const urgent = buildWorthinessScore('urgent', 'ignore', { strength: 'none' }, 1, 1);
    const surface = buildWorthinessScore('surface', 'ignore', { strength: 'none' }, 1, 1);
    assert.ok(urgent > surface, `urgent (${urgent}) should score higher than surface (${surface})`);
  });

  it('scores higher for primary matrix', () => {
    const primary = buildWorthinessScore('surface', 'primary', { strength: 'none' }, 1, 1);
    const ignore = buildWorthinessScore('surface', 'ignore', { strength: 'none' }, 1, 1);
    assert.ok(primary > ignore, `primary (${primary}) should score higher than ignore (${ignore})`);
  });

  it('scores higher for strong money trail', () => {
    const strong = buildWorthinessScore('surface', 'ignore', { strength: 'strong' }, 1, 1);
    const none = buildWorthinessScore('surface', 'ignore', { strength: 'none' }, 1, 1);
    assert.ok(strong > none, `strong (${strong}) should score higher than none (${none})`);
  });

  it('adds cross-source bonus for 2+ sources', () => {
    const multi = buildWorthinessScore('surface', 'ignore', { strength: 'none' }, 3, 1);
    const single = buildWorthinessScore('surface', 'ignore', { strength: 'none' }, 1, 1);
    assert.ok(multi > single);
  });

  it('caps post count contribution at 10', () => {
    const count10 = buildWorthinessScore('surface', 'ignore', { strength: 'none' }, 1, 10);
    const count100 = buildWorthinessScore('surface', 'ignore', { strength: 'none' }, 1, 100);
    assert.equal(count10, count100, 'Post count beyond 10 should not increase score');
  });

  it('returns numeric value', () => {
    const score = buildWorthinessScore('active', 'hidden_gem', { strength: 'moderate' }, 2, 5);
    assert.equal(typeof score, 'number');
    assert.ok(score >= 0 && score <= 100);
  });

  it('scores all depth/matrix/money combinations deterministically', () => {
    const depths = ['urgent', 'active', 'surface'];
    const matrices = ['primary', 'hidden_gem', 'background', 'ignore'];
    const strengths = ['strong', 'moderate', 'weak', 'none'];

    for (const d of depths) {
      for (const m of matrices) {
        for (const s of strengths) {
          const score = buildWorthinessScore(d, m, { strength: s }, 2, 5);
          assert.equal(typeof score, 'number');
          assert.ok(score >= 0 && score <= 100, `${d}/${m}/${s} score ${score} out of range`);
        }
      }
    }
  });
});

// ─── determineVerdict ────────────────────────────────────────────────────────

describe('determineVerdict', () => {
  it('returns validated for urgent + primary/hidden_gem + money', () => {
    assert.equal(
      determineVerdict('urgent', 'primary', { strength: 'strong' }),
      'validated'
    );
    assert.equal(
      determineVerdict('urgent', 'hidden_gem', { strength: 'weak' }),
      'validated'
    );
  });

  it('returns needs_evidence for active + primary', () => {
    assert.equal(
      determineVerdict('active', 'primary', { strength: 'none' }),
      'needs_evidence'
    );
  });

  it('returns needs_evidence for urgent + no money', () => {
    assert.equal(
      determineVerdict('urgent', 'primary', { strength: 'none' }),
      'needs_evidence'
    );
  });

  it('returns too_weak for surface depth', () => {
    assert.equal(
      determineVerdict('surface', 'primary', { strength: 'strong' }),
      'too_weak'
    );
  });

  it('returns too_weak for ignore matrix', () => {
    assert.equal(
      determineVerdict('active', 'ignore', { strength: 'strong' }),
      'too_weak'
    );
  });

  it('returns needs_evidence for active + background + money', () => {
    assert.equal(
      determineVerdict('active', 'background', { strength: 'strong' }),
      'needs_evidence'
    );
  });
});

// ─── getAudience ─────────────────────────────────────────────────────────────

describe('getAudience', () => {
  it('returns known audience for mapped categories', () => {
    const audience = getAudience('pricing');
    assert.ok(audience.length > 0);
    assert.ok(audience.toLowerCase().includes('budget') || audience.toLowerCase().includes('price'));
  });

  it('returns default audience for unmapped category', () => {
    const audience = getAudience('some-random-category');
    assert.ok(audience.length > 0);
    assert.ok(audience.includes('pain points'), `Expected default audience, got: ${audience}`);
  });

  it('returns audience for product-availability', () => {
    const audience = getAudience('product-availability');
    assert.ok(audience.includes('Retail') || audience.includes('customer'));
  });
});

// ─── buildOpportunityText ────────────────────────────────────────────────────

describe('buildOpportunityText', () => {
  function makeGroup(overrides = {}) {
    return {
      category: 'product-availability',
      postCount: 5,
      crossSources: 2,
      sourceNames: ['reddit', 'hackernews'],
      depth: 'urgent',
      tools: [],
      solutionAttempts: [],
      moneyTrail: { strength: 'none', totalCount: 0, examples: [] },
      representativePosts: [
        { title: 'Bot problem post', score: 100, url: 'https://example.com', wtpSignals: [] },
      ],
      topQuotes: [],
      ...overrides,
    };
  }

  it('returns a non-empty string', () => {
    const text = buildOpportunityText(makeGroup());
    assert.ok(text.length > 0);
  });

  it('includes urgency clause for urgent + cross-platform', () => {
    const text = buildOpportunityText(makeGroup({ depth: 'urgent', crossSources: 2 }));
    assert.ok(text.includes('Urgent') || text.includes('cross-platform'));
  });

  it('includes WTP clause when money trail is strong', () => {
    const text = buildOpportunityText(makeGroup({
      moneyTrail: { strength: 'strong', totalCount: 8, examples: [] },
      representativePosts: [
        { title: 'Test', score: 10, url: 'https://example.com', wtpSignals: ['would pay'] },
      ],
    }));
    assert.ok(text.includes('WTP'));
  });

  it('includes gap clause when solution attempts exist', () => {
    const text = buildOpportunityText(makeGroup({
      solutionAttempts: [{ body: 'Built my own alert system but still fails' }],
    }));
    assert.ok(text.includes('workaround') || text.includes('insufficient'));
  });

  it('mentions tools when they exist but no solution attempts', () => {
    const text = buildOpportunityText(makeGroup({
      tools: ['AXS', 'DICE'],
      solutionAttempts: [],
    }));
    assert.ok(text.includes('AXS') || text.includes('DICE'));
  });
});

// ─── generateIdeaSketch ──────────────────────────────────────────────────────

describe('generateIdeaSketch', () => {
  function makeFullGroup() {
    return {
      category: 'product-availability',
      verdict: 'validated',
      buildScore: 85,
      postCount: 10,
      crossSources: 3,
      sourceNames: ['reddit', 'hackernews', 'appstore'],
      depth: 'urgent',
      tools: ['AXS', 'DICE'],
      solutionAttempts: [
        { body: 'Built my own alert system but bots still win' },
      ],
      moneyTrail: { strength: 'strong', totalCount: 8, examples: [{ body: 'Would pay $10/mo', signals: ['per month'] }] },
      representativePosts: [
        { title: 'Bots are ruining ticket buying', score: 3500, num_comments: 400, url: 'https://example.com', wtpSignals: ['subscription'] },
      ],
      topQuotes: [
        { body: 'The system is completely broken for regular fans', score: 200 },
      ],
      totalComments: 500,
      totalScore: 5000,
      unspokenPain: [{ body: 'Users want fairness, not just cheaper tickets' }],
      audience: 'Concert-goers frustrated by bot-dominated ticket sales',
    };
  }

  it('returns all required sections', () => {
    const sketch = generateIdeaSketch(makeFullGroup());
    assert.ok(sketch.category);
    assert.ok(sketch.verdict);
    assert.ok(sketch.verdictLabel);
    assert.ok(typeof sketch.buildScore === 'number');
    assert.ok(sketch.problemStatement);
    assert.ok(sketch.targetCustomer);
    assert.ok(sketch.targetCustomer.who);
    assert.ok(sketch.targetCustomer.whereTheyHangOut);
    assert.ok(sketch.targetCustomer.currentSpending);
    assert.ok(sketch.solutionConcept);
    assert.ok(sketch.solutionConcept.coreFeature);
    assert.ok(sketch.solutionConcept.whyExistingFail);
    assert.ok(sketch.solutionConcept.keyDifferentiator);
    assert.ok(sketch.businessModel);
    assert.ok(sketch.businessModel.pricing);
    assert.ok(sketch.businessModel.revenueModel);
    assert.ok(sketch.businessModel.estimatedWtp);
    assert.ok(sketch.goToMarket);
    assert.ok(sketch.goToMarket.launchChannel);
    assert.ok(sketch.goToMarket.first100);
    assert.ok(sketch.goToMarket.contentAngle);
    assert.ok(sketch.competitiveLandscape);
    assert.ok(sketch.riskAndValidation);
    assert.ok(sketch.riskAndValidation.redFlags);
    assert.ok(Array.isArray(sketch.riskAndValidation.redFlags));
  });

  it('labels verdict correctly', () => {
    const validated = generateIdeaSketch(makeFullGroup());
    assert.equal(validated.verdictLabel, 'Validated');

    const needsEvidence = generateIdeaSketch({ ...makeFullGroup(), verdict: 'needs_evidence' });
    assert.equal(needsEvidence.verdictLabel, 'Needs More Evidence');

    const tooWeak = generateIdeaSketch({ ...makeFullGroup(), verdict: 'too_weak' });
    assert.equal(tooWeak.verdictLabel, 'Too Weak');
  });

  it('detects subscription pricing signal', () => {
    const sketch = generateIdeaSketch(makeFullGroup());
    assert.ok(
      sketch.businessModel.pricing.toLowerCase().includes('subscription') ||
      sketch.businessModel.pricing.toLowerCase().includes('freemium'),
      'Should detect subscription signal'
    );
  });

  it('includes Reddit-specific go-to-market when source is reddit', () => {
    const sketch = generateIdeaSketch(makeFullGroup());
    assert.ok(sketch.goToMarket.first100.includes('Reddit'));
  });

  it('flags red flags for no WTP signals', () => {
    const group = {
      ...makeFullGroup(),
      moneyTrail: { strength: 'none', totalCount: 0, examples: [] },
    };
    const sketch = generateIdeaSketch(group);
    assert.ok(
      sketch.riskAndValidation.redFlags.some(f => f.includes('WTP')),
      'Should flag no WTP signals as risk'
    );
  });
});
