/**
 * scoring-pipeline.test.mjs — Tests for the shared scoring pipeline
 *
 * Covers: enrichPost, makeCiteKey, computePainScore, analyzeComments,
 * matchSignals, signal matchers, context analysis, and the scoring engine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enrichPost,
  computePainScore,
  analyzeComments,
  matchSignals,
  matchSignalsFiltered,
  matchSignalsWeighted,
  getPostPainCategories,
  PAIN_SIGNALS,
  PAIN_FLAIRS,
  NON_PAIN_TITLE_SIGNALS,
  WTP_STRONG,
  WTP_FIRST_PERSON,
  WTP_GENERIC,
  sentimentMultiplier,
  isNegated,
  isWtpFirstPerson,
  isWtpContextual,
  computeIntensity,
  applySourceQuality,
  getSourceQualityMultiplier,
  SOURCE_QUALITY_MULTIPLIERS,
} from '../lib/scoring.mjs';

import { SignalMatcher } from '../lib/signals/matcher.mjs';
import { getSignalProfile, listProfiles, PAIN_SIGNALS as SIGNALS_INDEX_PAIN } from '../lib/signals/index.mjs';
import {
  isNegated as ctxIsNegated,
  sentimentMultiplier as ctxSentimentMult,
  isWtpFirstPerson as ctxIsWtpFP,
  isWtpContextual as ctxIsWtpCtx,
} from '../lib/signals/context.mjs';
import { PainScorer, registerScoringFunctions } from '../lib/scoring-engine.mjs';

// ─── makeCiteKey (tested indirectly via enrichPost) ─────────────────────────

describe('makeCiteKey via enrichPost', () => {
  it('assigns a citeKey with source prefix', () => {
    const post = {
      id: 'abc123',
      title: 'This tool is frustrating and broken',
      selftext: 'I hate it. Looking for alternatives to this terrible tool.',
      subreddit: 'hackernews',
      url: 'https://news.ycombinator.com/item?id=abc123',
      score: 100,
      num_comments: 50,
      upvote_ratio: 0,
      flair: '',
      created_utc: 1700000000,
      source: 'hackernews',
    };
    const enriched = enrichPost(post, 'tool');
    assert.ok(enriched, 'enrichPost should return a result for pain-signal post');
    assert.ok(enriched.citeKey, 'citeKey should be set');
    // The source field is set by the caller after enrichPost; makeCiteKey uses post.source or post._source
    // Since post.source='hackernews', prefix should be HN
    assert.ok(enriched.citeKey.startsWith('HN-'), `citeKey should start with HN-, got ${enriched.citeKey}`);
    assert.ok(enriched.citeKey.includes('abc123'), `citeKey should include post id`);
  });

  it('uses SHA256 hash when post has no id', () => {
    const post = {
      title: 'This is frustrating and terrible',
      selftext: 'I hate this broken thing.',
      subreddit: 'hackernews',
      url: 'https://example.com/post',
      score: 100,
      num_comments: 50,
      upvote_ratio: 0,
      flair: '',
      created_utc: 1700000000,
      source: 'hackernews',
    };
    const enriched = enrichPost(post, 'thing');
    assert.ok(enriched);
    assert.ok(enriched.citeKey.startsWith('HN-'), `citeKey should start with HN-`);
  });

  it('different sources get different prefixes', () => {
    const basePost = {
      id: 'test1',
      title: 'This is frustrating and broken',
      selftext: 'I hate this terrible tool.',
      subreddit: 'stackoverflow',
      url: 'https://example.com',
      score: 100,
      num_comments: 50,
      upvote_ratio: 0,
      flair: '',
      created_utc: 1700000000,
    };

    const redditPost = { ...basePost, source: 'reddit' };
    const ghPost = { ...basePost, source: 'github-issues', subreddit: 'github-issues' };
    const soPost = { ...basePost, source: 'stackoverflow' };
    const phPost = { ...basePost, source: 'producthunt', subreddit: 'producthunt' };

    const re = enrichPost(redditPost, 'tool');
    const gh = enrichPost(ghPost, 'tool');
    const so = enrichPost(soPost, 'tool');
    const ph = enrichPost(phPost, 'tool');

    assert.ok(re?.citeKey.startsWith('R-'));
    assert.ok(gh?.citeKey.startsWith('GH-'));
    assert.ok(so?.citeKey.startsWith('SO-'));
    assert.ok(ph?.citeKey.startsWith('PH-'));
  });
});

// ─── enrichPost ─────────────────────────────────────────────────────────────

describe('enrichPost', () => {
  it('returns null for posts with no pain signals', () => {
    const post = {
      id: 'neutral1',
      title: 'My Kubernetes setup',
      selftext: 'Here is how I configured my cluster. Works well.',
      subreddit: 'devops',
      url: 'https://reddit.com/r/devops/neutral1',
      score: 50,
      num_comments: 20,
      upvote_ratio: 0.9,
      flair: '',
      created_utc: 1700000000,
    };
    const result = enrichPost(post, 'kubernetes');
    assert.equal(result, null);
  });

  it('enriches a post with frustration signals', () => {
    const post = {
      id: 'pain1',
      title: 'Kubernetes is frustrating and broken',
      selftext: 'I am tired of dealing with this terrible tool. The YAML is a nightmare.',
      subreddit: 'devops',
      url: 'https://reddit.com/r/devops/pain1',
      score: 100,
      num_comments: 50,
      upvote_ratio: 0.85,
      flair: '',
      created_utc: 1700000000,
    };
    const result = enrichPost(post, 'kubernetes');
    assert.ok(result, 'should return enriched post');
    assert.equal(result.id, 'pain1');
    assert.ok(result.painScore > 0, 'painScore should be positive');
    assert.ok(result.painSignals.length > 0, 'should have pain signals');
    assert.ok(result.painCategories.includes('frustration'), 'should include frustration category');
    assert.ok(result.citeKey, 'should have citeKey');
    assert.ok(result.selftext_excerpt, 'should have selftext_excerpt');
    assert.ok(result.date, 'should have date string');
  });

  it('enriches post with desire signals', () => {
    const post = {
      id: 'desire1',
      title: 'Looking for alternative to Kubernetes',
      selftext: 'I switched from k8s because it was broken and frustrating. Need something simpler.',
      subreddit: 'devops',
      url: 'https://reddit.com/r/devops/desire1',
      score: 80,
      num_comments: 40,
      upvote_ratio: 0.9,
      flair: '',
      created_utc: 1700000000,
    };
    const result = enrichPost(post, 'kubernetes');
    assert.ok(result);
    assert.ok(result.painCategories.includes('desire'));
  });

  it('enriches post with cost signals', () => {
    const post = {
      id: 'cost1',
      title: 'Kubernetes is too expensive for small teams',
      selftext: 'The price hike for managed k8s is ridiculous. We need a cheaper solution.',
      subreddit: 'devops',
      url: 'https://reddit.com/r/devops/cost1',
      score: 120,
      num_comments: 60,
      upvote_ratio: 0.88,
      flair: '',
      created_utc: 1700000000,
    };
    const result = enrichPost(post, 'kubernetes');
    assert.ok(result);
    assert.ok(result.painCategories.includes('cost'));
  });

  it('enriches post with WTP signals', () => {
    const post = {
      id: 'wtp1',
      title: 'I would happily pay for a simpler Kubernetes alternative',
      selftext: 'Frustrated with k8s complexity. Happy to pay for something that just works.',
      subreddit: 'devops',
      url: 'https://reddit.com/r/devops/wtp1',
      score: 90,
      num_comments: 35,
      upvote_ratio: 0.92,
      flair: '',
      created_utc: 1700000000,
    };
    const result = enrichPost(post, 'kubernetes');
    assert.ok(result);
    assert.ok(result.wtpSignals.length > 0, 'should detect WTP signals');
    assert.ok(result.painCategories.includes('wtp'));
  });

  it('applies domain relevance boost', () => {
    const post = {
      id: 'rel1',
      title: 'Kubernetes is frustrating and terrible',
      selftext: 'The kubernetes docs are broken.',
      subreddit: 'devops',
      url: 'https://reddit.com/r/devops/rel1',
      score: 50,
      num_comments: 20,
      upvote_ratio: 0.8,
      flair: '',
      created_utc: 1700000000,
    };
    const withDomain = enrichPost(post, 'kubernetes');
    const withoutDomain = enrichPost(post, 'completely unrelated xyz');
    assert.ok(withDomain);
    assert.ok(withoutDomain);
    assert.ok(withDomain.painScore > withoutDomain.painScore,
      'domain-matching post should score higher');
  });

  it('filters by domainKeywords when provided', () => {
    const post = {
      id: 'kw1',
      title: 'This software is frustrating and terrible',
      selftext: 'I hate it so much. Broken mess.',
      subreddit: 'programming',
      url: 'https://reddit.com/r/programming/kw1',
      score: 100,
      num_comments: 50,
      upvote_ratio: 0.9,
      flair: '',
      created_utc: 1700000000,
    };
    const withKeyword = enrichPost(post, 'software', ['software']);
    const withoutKeyword = enrichPost(post, 'software', ['kubernetes', 'k8s']);
    assert.ok(withKeyword, 'should pass when keyword matches');
    assert.equal(withoutKeyword, null, 'should reject when no keyword matches');
  });

  it('returns correct shape with all expected fields', () => {
    const post = {
      id: 'shape1',
      title: 'Frustrated with this broken tool',
      selftext: 'Terrible experience. Looking for alternatives.',
      subreddit: 'devops',
      url: 'https://reddit.com/r/devops/shape1',
      score: 75,
      num_comments: 30,
      upvote_ratio: 0.85,
      flair: 'rant',
      created_utc: 1700000000,
      source: 'reddit',
    };
    const result = enrichPost(post, 'tool');
    assert.ok(result);
    const expectedKeys = [
      'id', 'title', 'subreddit', 'url', 'score', 'num_comments',
      'upvote_ratio', 'created_utc', 'date', 'selftext_excerpt',
      'painScore', 'painSignals', 'bodyPainSignals', 'painCategories',
      'painSubcategories', 'wtpSignals', 'intensity', 'flair', 'citeKey',
    ];
    for (const key of expectedKeys) {
      assert.ok(key in result, `enriched post should have '${key}' field`);
    }
  });

  it('handles empty title and selftext gracefully', () => {
    const post = {
      id: 'empty1',
      title: '',
      selftext: '',
      subreddit: 'test',
      url: '',
      score: 0,
      num_comments: 0,
      upvote_ratio: 0,
      flair: '',
      created_utc: 0,
    };
    const result = enrichPost(post, '');
    // Should return null because no pain signals
    assert.equal(result, null);
  });

  it('handles missing fields gracefully', () => {
    const post = { id: 'sparse' };
    // No crash expected
    const result = enrichPost(post, '');
    assert.equal(result, null);
  });
});

// ─── computePainScore ───────────────────────────────────────────────────────

describe('computePainScore', () => {
  it('returns a number', () => {
    const post = {
      title: 'Test post',
      selftext: 'Test body',
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.8,
      flair: '',
    };
    const score = computePainScore(post);
    assert.equal(typeof score, 'number');
  });

  it('scores higher for frustration signals in title', () => {
    const frustrated = computePainScore({
      title: 'This is frustrating and terrible',
      selftext: '',
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.8,
      flair: '',
    });
    const neutral = computePainScore({
      title: 'My workflow setup',
      selftext: '',
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.8,
      flair: '',
    });
    assert.ok(frustrated > neutral, 'frustrated post should score higher');
  });

  it('pain flair boosts score', () => {
    const withFlair = computePainScore({
      title: 'This is broken and frustrating',
      selftext: '',
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.8,
      flair: 'rant',
    });
    const withoutFlair = computePainScore({
      title: 'This is broken and frustrating',
      selftext: '',
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.8,
      flair: '',
    });
    assert.ok(withFlair > withoutFlair, 'pain flair should boost score');
  });

  it('non-pain title signals reduce score', () => {
    const tips = computePainScore({
      title: 'Tips for dealing with frustrating bugs',
      selftext: '',
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.8,
      flair: '',
    });
    const noTips = computePainScore({
      title: 'Dealing with frustrating bugs',
      selftext: '',
      score: 10,
      num_comments: 5,
      upvote_ratio: 0.8,
      flair: '',
    });
    assert.ok(tips < noTips, 'non-pain title signal should penalize score');
  });

  it('handles zero engagement', () => {
    const score = computePainScore({
      title: 'Frustrated',
      selftext: '',
      score: 0,
      num_comments: 0,
      upvote_ratio: 0,
      flair: '',
    });
    assert.equal(typeof score, 'number');
    assert.ok(Number.isFinite(score));
  });
});

// ─── analyzeComments ────────────────────────────────────────────────────────

describe('analyzeComments', () => {
  it('returns correct shape for empty comments', () => {
    const result = analyzeComments([]);
    assert.equal(result.totalComments, 0);
    assert.equal(result.agreementCount, 0);
    assert.equal(result.agreementRatio, 0);
    assert.equal(result.validationStrength, 'anecdotal');
    assert.ok(Array.isArray(result.topQuotes));
    assert.ok(Array.isArray(result.agreements));
    assert.ok(Array.isArray(result.solutionAttempts));
    assert.ok(Array.isArray(result.moneyTrail));
    assert.ok(Array.isArray(result.mentionedTools));
  });

  it('detects agreement signals', () => {
    const comments = [
      { body: 'Same here, I had the same issue.', score: 10 },
      { body: 'Can confirm, this is broken.', score: 5 },
      { body: 'Unrelated comment.', score: 2 },
    ];
    const result = analyzeComments(comments);
    assert.ok(result.agreementCount > 0, 'should detect agreements');
    assert.ok(result.agreements.length > 0);
  });

  it('detects solution signals and extracts tools', () => {
    const comments = [
      { body: 'I switched to Nomad and it works great.', score: 20 },
      { body: 'Try using Docker Swarm instead.', score: 15 },
    ];
    const result = analyzeComments(comments);
    assert.ok(result.solutionAttempts.length > 0, 'should detect solutions');
    assert.ok(result.mentionedTools.length > 0, 'should extract tool names');
  });

  it('detects WTP signals in comments', () => {
    const comments = [
      { body: 'I paid for the pro plan and it was worth paying for.', score: 10 },
    ];
    const result = analyzeComments(comments);
    assert.ok(result.moneyTrailCount > 0, 'should detect WTP signals');
    assert.ok(result.moneyTrail.length > 0);
  });

  it('skips deleted and removed comments', () => {
    const comments = [
      { body: '[deleted]', score: 5 },
      { body: '[removed]', score: 3 },
      { body: '', score: 1 },
      { body: 'This is frustrating.', score: 10 },
    ];
    const result = analyzeComments(comments);
    assert.equal(result.totalComments, 1, 'should only count valid comments');
  });

  it('computes validation strength', () => {
    // Many agreement signals -> stronger validation
    const manyAgreements = Array.from({ length: 20 }, (_, i) => ({
      body: 'Same here, can confirm this is terrible.',
      score: 10 + i,
    }));
    const result = analyzeComments(manyAgreements);
    assert.ok(['strong', 'moderate'].includes(result.validationStrength),
      `expected strong/moderate, got ${result.validationStrength}`);
  });
});

// ─── matchSignals ───────────────────────────────────────────────────────────

describe('matchSignals', () => {
  it('matches frustration signals', () => {
    const matches = matchSignals('I am so frustrated with this broken tool', 'frustration');
    assert.ok(matches.includes('frustrated'));
    assert.ok(matches.includes('broken'));
  });

  it('matches desire signals', () => {
    const matches = matchSignals('Looking for alternative to this tool', 'desire');
    assert.ok(matches.includes('looking for'));
    assert.ok(matches.includes('alternative to'));
  });

  it('matches cost signals', () => {
    const matches = matchSignals('This is too expensive and overpriced', 'cost');
    assert.ok(matches.includes('too expensive'));
    assert.ok(matches.includes('overpriced'));
  });

  it('returns empty array for no matches', () => {
    const matches = matchSignals('Everything is fine', 'frustration');
    assert.equal(matches.length, 0);
  });

  it('returns empty array for empty text', () => {
    assert.deepEqual(matchSignals('', 'frustration'), []);
    assert.deepEqual(matchSignals(null, 'frustration'), []);
    assert.deepEqual(matchSignals(undefined, 'frustration'), []);
  });
});

// ─── matchSignalsFiltered ───────────────────────────────────────────────────

describe('matchSignalsFiltered', () => {
  it('filters negated signals', () => {
    const filtered = matchSignalsFiltered('This is not frustrating at all', 'frustration');
    assert.ok(!filtered.includes('frustrating'), 'negated signals should be filtered out');
  });

  it('keeps non-negated signals', () => {
    const filtered = matchSignalsFiltered('I am frustrated with this broken tool', 'frustration');
    assert.ok(filtered.includes('frustrated'));
    assert.ok(filtered.includes('broken'));
  });
});

// ─── matchSignalsWeighted ───────────────────────────────────────────────────

describe('matchSignalsWeighted', () => {
  it('returns keywords and weight', () => {
    const result = matchSignalsWeighted('I am frustrated', 'frustration');
    assert.ok(result.keywords.includes('frustrated'));
    assert.ok(result.weight > 0);
  });

  it('returns zero weight for empty text', () => {
    const result = matchSignalsWeighted('', 'frustration');
    assert.equal(result.keywords.length, 0);
    assert.equal(result.weight, 0);
  });

  it('boosts weight in negative context', () => {
    const negative = matchSignalsWeighted(
      'This is terrible. I am frustrated beyond belief. Awful experience.',
      'frustration'
    );
    const neutral = matchSignalsWeighted('I am frustrated', 'frustration');
    assert.ok(negative.weight >= neutral.weight,
      'negative context should boost or maintain weight');
  });
});

// ─── context analysis ───────────────────────────────────────────────────────

describe('sentimentMultiplier', () => {
  it('returns 1.0 for neutral context', () => {
    const mult = sentimentMultiplier('the tool is frustrating sometimes', 16);
    assert.equal(mult, 1.0);
  });

  it('returns < 1.0 for positive context', () => {
    const mult = sentimentMultiplier('I love this amazing tool. It is frustrating but worth it.', 35);
    assert.ok(mult < 1.0, `positive context should reduce multiplier, got ${mult}`);
  });

  it('returns > 1.0 for negative context', () => {
    const mult = sentimentMultiplier('This is terrible and awful. So frustrated with this broken useless tool.', 35);
    assert.ok(mult > 1.0, `negative context should increase multiplier, got ${mult}`);
  });

  it('handles empty text', () => {
    assert.equal(sentimentMultiplier('', 0), 1.0);
    assert.equal(sentimentMultiplier(null, 0), 1.0);
  });
});

describe('isNegated', () => {
  it('detects simple negation', () => {
    assert.equal(isNegated('this is not frustrating', 12), true);
  });

  it('detects contraction negation', () => {
    assert.equal(isNegated("it isn't broken at all", 10), true);
  });

  it('returns false for non-negated text', () => {
    assert.equal(isNegated('I am frustrated with this', 5), false);
  });

  it('returns false for empty text', () => {
    assert.equal(isNegated('', 0), false);
    assert.equal(isNegated(null, 0), false);
  });

  it('returns false for very early keyword index', () => {
    assert.equal(isNegated('ab', 1), false);
  });
});

describe('isWtpFirstPerson', () => {
  it('detects first person WTP context', () => {
    assert.equal(isWtpFirstPerson("I'd pay for this in a heartbeat", 4), true);
  });

  it('returns false without first person', () => {
    assert.equal(isWtpFirstPerson('The company paid for this tool', 16), false);
  });
});

describe('isWtpContextual', () => {
  it('detects pain context around WTP', () => {
    assert.equal(isWtpContextual('I am frustrated and would pay for a fix', 25), true);
  });

  it('returns false without pain context', () => {
    assert.equal(isWtpContextual('They purchased the enterprise plan', 5), false);
  });
});

// ─── computeIntensity ───────────────────────────────────────────────────────

describe('computeIntensity', () => {
  it('returns 0 for no intensity signals', () => {
    assert.equal(computeIntensity('A simple post'), 0);
  });

  it('returns positive for intensity signals', () => {
    const result = computeIntensity('I am literally losing my mind. This is absolutely ridiculous.');
    assert.ok(result > 0);
  });

  it('handles empty text', () => {
    assert.equal(computeIntensity(''), 0);
    assert.equal(computeIntensity(null), 0);
  });
});

// ─── source quality multipliers ─────────────────────────────────────────────

describe('source quality multipliers', () => {
  it('returns known multipliers for API sources', () => {
    assert.equal(getSourceQualityMultiplier('hackernews'), 0.95);
    assert.equal(getSourceQualityMultiplier('stackoverflow'), 1.0);
    assert.equal(getSourceQualityMultiplier('github-issues'), 0.9);
    assert.equal(getSourceQualityMultiplier('producthunt'), 0.85);
    assert.equal(getSourceQualityMultiplier('reddit-api'), 1.0);
  });

  it('returns 1.0 for unknown sources', () => {
    assert.equal(getSourceQualityMultiplier('unknown-source'), 1.0);
    assert.equal(getSourceQualityMultiplier(null), 1.0);
    assert.equal(getSourceQualityMultiplier(undefined), 1.0);
  });

  it('applySourceQuality scales score correctly', () => {
    const raw = 10.0;
    const adjusted = applySourceQuality(raw, 'hackernews');
    assert.equal(adjusted, 9.5);
  });
});

// ─── getPostPainCategories ──────────────────────────────────────────────────

describe('getPostPainCategories', () => {
  it('detects frustration category', () => {
    const cats = getPostPainCategories({ title: 'Frustrated with this', selftext: '' });
    assert.ok(cats.includes('frustration'));
  });

  it('detects desire category', () => {
    const cats = getPostPainCategories({ title: 'Looking for alternative to X', selftext: '' });
    assert.ok(cats.includes('desire'));
  });

  it('detects cost category', () => {
    const cats = getPostPainCategories({ title: '', selftext: 'This is too expensive' });
    assert.ok(cats.includes('cost'));
  });

  it('returns empty for neutral post', () => {
    const cats = getPostPainCategories({ title: 'My setup', selftext: 'Works great.' });
    assert.equal(cats.length, 0);
  });
});

// ─── SignalMatcher ──────────────────────────────────────────────────────────

describe('SignalMatcher', () => {
  it('constructs with default profile', () => {
    const matcher = new SignalMatcher();
    assert.equal(matcher.profileName, 'default');
    assert.ok(matcher.signals.frustration.length > 0);
  });

  it('match returns matching keywords', () => {
    const matcher = new SignalMatcher();
    const matches = matcher.match('I am frustrated and annoyed', 'frustration');
    assert.ok(matches.includes('frustrated'));
    assert.ok(matches.includes('annoyed'));
  });

  it('matchFiltered excludes negated signals', () => {
    const matcher = new SignalMatcher();
    const matches = matcher.matchFiltered('This is not frustrating', 'frustration');
    assert.ok(!matches.includes('frustrating'));
  });

  it('matchWeighted returns weight', () => {
    const matcher = new SignalMatcher();
    const result = matcher.matchWeighted('I am frustrated', 'frustration');
    assert.ok(result.weight > 0);
    assert.ok(result.keywords.includes('frustrated'));
  });

  it('returns empty for unknown category', () => {
    const matcher = new SignalMatcher();
    assert.deepEqual(matcher.match('test', 'nonexistent'), []);
  });

  it('supports different profiles', () => {
    const devMatcher = new SignalMatcher('developer_tools');
    assert.equal(devMatcher.profileName, 'developer_tools');
    // Developer tools profile should have extended frustration signals
    const matches = devMatcher.match('poor dx and bad documentation', 'frustration');
    assert.ok(matches.includes('poor dx'));
  });
});

// ─── signal profiles ────────────────────────────────────────────────────────

describe('signal profiles', () => {
  it('lists available profiles', () => {
    const profiles = listProfiles();
    assert.ok(profiles.includes('default'));
    assert.ok(profiles.includes('b2b_saas'));
    assert.ok(profiles.includes('consumer_marketplace'));
    assert.ok(profiles.includes('developer_tools'));
  });

  it('getSignalProfile returns default for unknown', () => {
    const profile = getSignalProfile('nonexistent');
    assert.ok(profile.frustration.length > 0);
  });

  it('b2b_saas profile extends default', () => {
    const b2b = getSignalProfile('b2b_saas');
    const def = getSignalProfile('default');
    assert.ok(b2b.frustration.length >= def.frustration.length);
    assert.ok(b2b.frustration.includes('downtime'));
  });

  it('consumer_marketplace profile extends default', () => {
    const cm = getSignalProfile('consumer_marketplace');
    assert.ok(cm.frustration.includes('scam seller'));
  });

  it('developer_tools profile extends default', () => {
    const dt = getSignalProfile('developer_tools');
    assert.ok(dt.frustration.includes('poor dx'));
    assert.ok(dt.frustration.includes('dependency hell'));
  });
});

// ─── context.mjs exports ────────────────────────────────────────────────────

describe('signals/context.mjs exports', () => {
  it('isNegated matches scoring.mjs isNegated behavior', () => {
    assert.equal(ctxIsNegated('this is not broken', 12), true);
    assert.equal(ctxIsNegated('this is broken', 8), false);
  });

  it('sentimentMultiplier matches scoring.mjs behavior', () => {
    const m = ctxSentimentMult('neutral text', 0);
    assert.equal(typeof m, 'number');
  });

  it('isWtpFirstPerson matches scoring.mjs behavior', () => {
    assert.equal(ctxIsWtpFP("I'd gladly pay for this", 4), true);
  });

  it('isWtpContextual matches scoring.mjs behavior', () => {
    assert.equal(ctxIsWtpCtx('frustrated with this, would pay for a solution', 25), true);
  });
});

// ─── PainScorer class ───────────────────────────────────────────────────────

describe('PainScorer', () => {
  it('constructs with default profile', () => {
    const scorer = new PainScorer();
    assert.equal(scorer.profileName, 'default');
    assert.ok(scorer.matcher instanceof SignalMatcher);
  });

  it('constructs with named profile', () => {
    const scorer = new PainScorer('b2b_saas');
    assert.equal(scorer.profileName, 'b2b_saas');
  });

  it('has signals from the profile', () => {
    const scorer = new PainScorer('developer_tools');
    assert.ok(scorer.signals.frustration.includes('poor dx'));
  });
});
