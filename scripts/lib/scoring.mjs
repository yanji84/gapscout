/**
 * scoring.mjs — Shared scoring engine for gapscout
 *
 * Canonical version with R2/R3 refinements:
 *   - Sentiment-aware signal matching
 *   - Negation detection
 *   - Context-aware WTP filtering
 *   - Body signal cap
 *   - Expanded agreement detection
 *   - Thematic agreement
 *   - Pain subcategory classification
 */

import { createHash } from 'node:crypto';
import { excerpt } from './utils.mjs';
import { blendLLMScores } from './llm.mjs';

// ─── cite-key helpers ────────────────────────────────────────────────────────
const SOURCE_PREFIX = {
  reddit: 'R',
  hackernews: 'HN',
  g2: 'G2',
  capterra: 'CA',
  trustpilot: 'TP',
  appstore: 'AS',
  'github-issues': 'GH',
  stackoverflow: 'SO',
  twitter: 'TW',
  producthunt: 'PH',
  kickstarter: 'KS',
  websearch: 'WS',
  'google-autocomplete': 'GA',
  youtube: 'YT',
};

function makeCiteKey(post) {
  const src = post.source || post._source || '';
  const prefix = SOURCE_PREFIX[src] || 'SRC';
  const id = post.id
    || createHash('sha256').update(post.url || post.title || '').digest('hex').slice(0, 12);
  return `${prefix}-${id}`;
}

// ─── source quality multipliers ─────────────────────────────────────────────
// Each source has different signal quality. These multipliers are applied to
// the final painScore of each post based on its source.

export const SOURCE_QUALITY_MULTIPLIERS = {
  'reddit-api': 1.0,       // High signal, real discussions
  'reddit-browser': 1.0,   // High signal, real discussions
  hackernews: 0.95,         // High signal, technical
  stackoverflow: 1.0,       // High signal, real developer pain
  producthunt: 0.85,        // Mixed signal
  reviews: 0.9,             // Verified reviews (G2/Capterra)
  trustpilot: 0.85,         // Review bombing risk
  'google-autocomplete': 0.6, // Noisy, not actual posts
  appstore: 0.75,           // Noise-heavy, complaint-biased
  twitter: 0.7,             // Short-form, context-poor
  crowdfunding: 0.8,        // Kickstarter/Indiegogo
  websearch: 0.8,           // Blogs, forums, wider web
  'github-issues': 0.9,     // Real issues with reaction validation
  cfpb: 0.95,                // Official complaints with narratives
  bluesky: 0.7,              // Short-form social, similar to twitter
};

/**
 * Get the quality multiplier for a given source name.
 * Returns 1.0 for unknown sources.
 */
export function getSourceQualityMultiplier(source) {
  if (!source) return 1.0;
  return SOURCE_QUALITY_MULTIPLIERS[source] || 1.0;
}

/**
 * Apply source quality multiplier to a pain score.
 * @param {number} painScore - Raw pain score
 * @param {string} source - Source name (e.g. 'hackernews', 'twitter')
 * @returns {number} Adjusted pain score
 */
export function applySourceQuality(painScore, source) {
  const multiplier = getSourceQualityMultiplier(source);
  return Math.round(painScore * multiplier * 10) / 10;
}

// ─── pain signal keywords ────────────────────────────────────────────────────

export const PAIN_SIGNALS = {
  frustration: [
    'frustrated', 'frustrating', 'annoying', 'annoyed',
    'fed up', 'sick of', 'tired of', 'giving up', 'nightmare',
    'terrible', 'awful', 'broken', 'buggy', 'unusable',
    'horrible', 'worst', 'garbage', 'trash', 'joke',
    'hate', 'ruining', 'killing', 'destroying',
    'not working', 'keeps breaking', 'keeps crashing',
  ],
  desire: [
    'wish there was', 'looking for', 'alternative to',
    'switched from', 'better than', 'anything else',
    'does anyone know', 'recommendations for',
    'is there a', 'need something',
    'alternatives to', 'replace this', 'replacement for',
    'substitute for', 'switch from', 'switching from',
    'move away from',
  ],
  cost: [
    'too expensive', 'price hike', 'overpriced', 'not worth',
    'hidden fees', 'ripoff', 'rip off', 'gouging',
    'cost went up', 'raised prices',
  ],
  agreement: [
    'same here', 'me too', 'can confirm', 'exactly this',
    'this is why', 'i had the same', 'happened to me',
    'i agree', 'so true', "couldn't agree more",
    'yep same', 'deal breaker for me too',
  ],
  solution: [
    'i switched to', 'i ended up using', 'the workaround is',
    'i built my own', 'i just use', 'try using',
    'we moved to', 'what worked for me', 'i found that',
    'we use', 'i use', 'we went with', 'i went with',
    'check out', 'look into', 'have you tried',
  ],
  willingness_to_pay: [
    'paid for', 'paying for', 'bought', 'purchased', 'subscribed',
    'subscription', 'hired', 'consultant', 'freelancer',
    'wasted hours', 'wasted days', 'wasted weeks', 'spent hours',
    'spent days', 'worth paying', 'shut up and take my money',
    'take my money', 'would pay', "i'd pay", 'happy to pay',
    'gladly pay', 'budget for', 'invested in', 'cost me',
    'money on', 'dollars on', 'per month', 'per year',
    'annual plan', 'monthly plan', 'enterprise plan', 'pro plan',
  ],
  intensity: [
    'literally', 'absolutely', 'completely', 'utterly',
    'beyond frustrated', 'pulling my hair', 'losing my mind',
    'want to scream', 'at my wits end', "can't take it",
    'last straw', 'final straw', 'deal breaker', 'dealbreaker',
    'unacceptable', 'inexcusable', 'ridiculous', 'insane',
    'blows my mind', 'how is this', 'why is this so',
    'every single time', 'constantly', 'always breaks',
    'never works', 'still broken', 'years and still',
  ],
};

export const SCAN_QUERIES = {
  frustration: [
    'frustrated', 'nightmare', 'terrible', 'unusable', 'hate',
  ],
  desire: [
    'alternative', 'looking for', 'switched from', 'wish',
  ],
  cost: [
    'expensive', 'overpriced', 'not worth',
  ],
  willingness_to_pay: [
    'paid for', 'would pay', 'wasted hours', 'hired',
  ],
};

export const EXPANDED_AGREEMENT = [
  'absolutely', 'this exactly', '+1', 'yup', 'ugh same', 'preach',
  'for real', 'right?', 'totally', 'tell me about it', 'story of my life',
  'facts', 'this right here', 'nailed it', 'spot on', '100%',
  'the worst part', 'and on top of that', 'not to mention',
  'yeah the', 'yep the', 'seriously', 'no kidding',
];

export const PAIN_FLAIRS = new Set([
  'rant', 'complaint', 'help', 'vent', 'venting', 'frustrated',
  'issue', 'problem', 'bug', 'support',
]);

export const NON_PAIN_TITLE_SIGNALS = [
  'tips', 'workflow', 'share your', 'appreciation', 'guide',
  'how i built', 'my setup', 'what are you using', 'best practices',
  'release', 'update:', 'announcement', 'unpopular opinion',
  'showcase', 'show off', 'just finished', 'proud of', 'tutorial',
  'resource', 'cheat sheet', 'comparison', 'review:',
  'how to', 'strategy', 'climbing to', 'deck list', 'tier list',
  'what deck', 'which deck', 'where did everyone',
  // R2: hobby-specific non-pain signals
  'deck discussion', 'discussion thread', 'regionals', 'tournament results',
  'card art', 'my pulls', 'just pulled', 'check out this', 'look at this',
  'sold too early', 'sold too late', 'what is your', "what's yours",
  'recap', 'results from', 'data says', 'what the data',
  'giveaway', 'drop your', 'comment your', 'favorite',
  'worst looking', 'best looking', 'coolest',
  // R3: celebration/positive posts and writeups
  'just got into', 'first booster', 'look what i got', 'so happy',
  'my collection', 'haul', 'writeup', 'meta thoughts', 'random thoughts',
  'not terrible', 'convert this', 'convert me',
  // Educational/informational queries (appear in autocomplete but not pain signals)
  'and solutions', 'solutions pdf', 'problem solving', 'problem statement',
  'problem tree', 'techniques', 'examples', 'template', ' pdf',
  'definition', 'what is', 'overview', 'introduction', 'certification',
  'training', 'courses', 'course', 'degree', 'salary', 'jobs', 'career',
  'alternative names', 'alternative titles', 'alternative words',
  'alternative analysis', 'alternative jobs',
  // R4: SaaS/startup advice and success stories (not pain)
  'validating', 'roast my', 'we got acquired', 'got acquired', 'the advice i',
  'advice i wish', 'stop paying', 'the process i used', 'i used to grow',
  'top free tools', 'top tools', 'free tools', 'here\'s what no one tells',
  'what no one tells', 'no one tells you', 'not as easy as',
  'it\'s not as easy', 'success story', 'we sold', 'we launched',
  'lessons learned', 'postmortem', 'how i grew', 'how we grew',
  'my journey', 'our journey', 'things i learned', 'the truth about',
  'sharing my experience', 'behind the scenes', 'ama:', 'ask me anything',
  'vibe your way', 'your way to', 'ways to scale', 'ways to grow',
  'things you need to do', 'how to promote', 'how to scale',
  'how to market', 'how to launch', 'how to get', 'step by step',
  'the 10 things', 'the 5 things', 'the 7 things', 'things to do',
  // R5: analysis/insight posts misidentified as pain (common in SaaS/PM subs)
  'i spent', 'i analyzed', 'i analysed', 'i researched', 'i studied',
  'i built an', 'i built a', 'i created a', 'i created an', 'i made a',
  "i've built", "i've built 30", "i've built 10",
  'here\'s what i learned', 'here are the', "here's the", 'here is what',
  'is terrible advice', 'is bad advice', 'is wrong advice',
  'is killing your', 'is ruining your', 'is destroying your',
  'stop doing', 'you should stop', 'most people get', 'everyone gets',
  "the truth nobody", 'nobody tells you', 'the real reason',
  'foundation truths', 'product truths', 'startup advice',
  'we hit', 'reached ', 'crossed ', 'our mrr', 'our arr', 'monthly recurring',
  // R6: founder story / journey posts (not user pain)
  'i sold my', 'i sold ', 'lost everything', 'then i typed', 'then i built',
  'the founders who succeed', 'the founders who', 'who succeed are',
  'mvp myth', 'myth is', 'change my mind',
  'i\'ve been building', "i've been building", 'i launched', 'we launched',
  'my first startup', 'our first startup', 'first saas', 'bootstrap story',
];

export const NON_PAIN_FLAIRS = new Set([
  'appreciation', 'resources', 'tips', 'showcase', 'release',
  'announcement', 'meta', 'discussion', 'tutorial', 'guide',
  'deck', 'pulls', 'meme', 'humor', 'art', 'collection',
]);

export const WTP_STRONG = new Set([
  "i'd pay", 'happy to pay', 'shut up and take my money',
  'take my money', 'worth paying', 'gladly pay',
]);

// WTP that needs both first-person context AND pain/solution context to count
export const WTP_FIRST_PERSON = new Set([
  'would pay', 'budget for',
]);

// Generic commerce words — only count as WTP when near pain/solution context
export const WTP_GENERIC = new Set([
  'bought', 'purchased', 'paid for', 'paying for', 'subscribed',
  'subscription', 'per month', 'per year',
]);

// ─── sentiment context ──────────────────────────────────────────────────────

const POSITIVE_CONTEXT = [
  'happy', 'glad', 'love', 'great', 'best', 'worth it', 'no issues',
  'no problems', 'amazing', 'perfect', 'excellent', 'fantastic',
  'recommend', 'impressed', 'enjoy', 'smooth', 'solid',
];
const NEGATIVE_CONTEXT = [
  'hate', 'regret', 'waste', 'terrible', 'awful', 'not worth',
  'unfortunately', 'disappointed', 'annoying', 'broken', 'sucks',
  'horrible', 'useless', 'worse', 'painful', 'unacceptable',
];

export function sentimentMultiplier(text, keywordIndex, windowSize = 80) {
  if (!text) return 1.0;
  const start = Math.max(0, keywordIndex - windowSize);
  const end = Math.min(text.length, keywordIndex + windowSize);
  const window = text.slice(start, end).toLowerCase();
  const posHits = POSITIVE_CONTEXT.filter(w => window.includes(w)).length;
  const negHits = NEGATIVE_CONTEXT.filter(w => window.includes(w)).length;
  if (posHits > negHits) return 0.2;
  if (negHits > posHits) return 1.5;
  return 1.0;
}

// ─── negation detection (R3) ────────────────────────────────────────────────

const NEGATION_WORDS = ['not', 'no', "n't", 'never', 'neither', 'nor', 'without', 'barely'];

export function isNegated(text, keywordIndex) {
  if (!text || keywordIndex < 3) return false;
  const before = text.slice(Math.max(0, keywordIndex - 20), keywordIndex).toLowerCase();
  return NEGATION_WORDS.some(neg => before.includes(neg));
}

// ─── signal matching ────────────────────────────────────────────────────────

export function matchSignals(text, category) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return PAIN_SIGNALS[category].filter(kw => lower.includes(kw));
}

export function matchSignalsFiltered(text, category) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return PAIN_SIGNALS[category].filter(kw => {
    const idx = lower.indexOf(kw);
    return idx >= 0 && !isNegated(lower, idx);
  });
}

export function matchSignalsWeighted(text, category) {
  if (!text) return { keywords: [], weight: 0 };
  const lower = text.toLowerCase();
  let totalWeight = 0;
  const keywords = [];
  for (const kw of PAIN_SIGNALS[category]) {
    const idx = lower.indexOf(kw);
    if (idx >= 0) {
      if (isNegated(lower, idx)) continue;
      const mult = sentimentMultiplier(lower, idx);
      totalWeight += mult;
      keywords.push(kw);
    }
  }
  return { keywords, weight: totalWeight };
}

// ─── WTP first-person check (R4) ────────────────────────────────────────────

const FIRST_PERSON_WORDS = ["i'd", "i would", "i'll", "i am", "i'm", 'i need', 'i want', 'i have', 'we need', 'we want', 'we have', "we'd", 'our budget', 'my budget'];

export function isWtpFirstPerson(text, kwIndex) {
  if (!text) return false;
  const start = Math.max(0, kwIndex - 60);
  const window = text.slice(start, kwIndex + 20).toLowerCase();
  return FIRST_PERSON_WORDS.some(w => window.includes(w));
}

// ─── WTP context check (R2) ────────────────────────────────────────────────

export function isWtpContextual(text, kwIndex) {
  if (!text) return false;
  const start = Math.max(0, kwIndex - 100);
  const end = Math.min(text.length, kwIndex + 100);
  const window = text.slice(start, end).toLowerCase();
  const contextWords = [
    'frustrated', 'annoying', 'terrible', 'broken', 'hate', 'awful',
    'alternative', 'switched', 'workaround', 'fix', 'solution',
    'wasted', 'waste of', 'not worth', 'overpriced', 'ripoff',
  ];
  return contextWords.some(w => window.includes(w));
}

// ─── intensity ──────────────────────────────────────────────────────────────

export function computeIntensity(text) {
  if (!text) return 0;
  const matches = matchSignals(text, 'intensity');
  if (matches.length >= 3) return 3;
  if (matches.length >= 2) return 2;
  if (matches.length >= 1) return 1;
  return 0;
}

// ─── pain score ─────────────────────────────────────────────────────────────

/**
 * Compute pain score for a post.
 * Expects normalized post shape: { title, selftext, score, num_comments, upvote_ratio, flair }
 */
export function computePainScore(post) {
  const title = post.title || '';
  const body = post.selftext || '';
  const fullText = title + ' ' + body;
  const titleLower = title.toLowerCase();

  const titleFrust = matchSignalsWeighted(title, 'frustration');
  const titleDesire = matchSignalsWeighted(title, 'desire');
  const titleCost = matchSignalsWeighted(title, 'cost');
  const bodyFrust = matchSignalsWeighted(body, 'frustration');
  const bodyDesire = matchSignalsWeighted(body, 'desire');
  const bodyCost = matchSignalsWeighted(body, 'cost');

  // R3: cap body signal contribution
  const bodyWeight = bodyFrust.weight + bodyDesire.weight + bodyCost.weight;
  const cappedBodyWeight = Math.min(4.0, bodyWeight);

  const painWeight = (titleFrust.weight + titleDesire.weight + titleCost.weight) * 2.0
    + cappedBodyWeight * 1.0;

  let score = painWeight;

  // Engagement: capped at 2.5 (R2: reduced from 4.0)
  const engagementScore = Math.log2((post.num_comments || 0) + 1) * 0.8
    + Math.log2((post.score || 0) + 1) * 0.4;
  score += Math.min(2.5, engagementScore);

  // Upvote ratio
  if (post.upvote_ratio) {
    score += Math.max(0, (post.upvote_ratio - 0.7)) * 3.0;
  }

  // Flair
  const flair = (post.flair || '').toLowerCase();
  if (PAIN_FLAIRS.has(flair)) score += 1.5;

  // WTP: context-aware (R2) + first-person check (R4)
  const wtpMatches = matchSignals(fullText, 'willingness_to_pay');
  const effectiveWtpMatches = [];
  for (const kw of wtpMatches) {
    const idx = fullText.toLowerCase().indexOf(kw);
    const sentMult = sentimentMultiplier(fullText, idx);
    if (WTP_STRONG.has(kw)) {
      score += 3.0 * sentMult;
      effectiveWtpMatches.push(kw);
    } else if (WTP_FIRST_PERSON.has(kw)) {
      // R4: 'would pay'/'budget for' only count when first-person + contextual
      if (isWtpFirstPerson(fullText, idx) && isWtpContextual(fullText, idx)) {
        score += 2.0 * sentMult;
        effectiveWtpMatches.push(kw);
      } else if (isWtpContextual(fullText, idx)) {
        score += 0.5 * sentMult;
        effectiveWtpMatches.push(kw);
      }
    } else if (WTP_GENERIC.has(kw)) {
      if (isWtpContextual(fullText, idx)) {
        score += 0.5 * sentMult;
        effectiveWtpMatches.push(kw);
      }
    } else {
      score += 0.5 * sentMult;
      effectiveWtpMatches.push(kw);
    }
  }

  // Intensity: only when pain signals present
  const intensity = computeIntensity(fullText);
  if (painWeight > 0) {
    score += intensity * 1.5;
  }

  // Non-pain penalties
  const hasNonPainTitle = NON_PAIN_TITLE_SIGNALS.some(s => titleLower.includes(s));
  if (hasNonPainTitle) score -= 4.0;
  const hasNonPainFlair = [...NON_PAIN_FLAIRS].some(f => flair.includes(f));
  if (hasNonPainFlair) score -= 2.0;

  // Zero-pain penalty (R2: increased to -8)
  if (painWeight === 0 && effectiveWtpMatches.length === 0) {
    score -= 8.0;
  }

  return Math.round(score * 10) / 10;
}

// ─── comment analysis ───────────────────────────────────────────────────────

export function analyzeComments(comments, postPainCategories = [], postUrl = '') {
  let agreementCount = 0;
  let thematicAgreementCount = 0;
  const agreements = [];
  const solutions = [];
  const mentionedTools = new Set();
  const topQuotes = [];
  const moneyTrail = [];
  let intensityTotal = 0;

  const sorted = [...comments].sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const c of sorted) {
    const body = (c.body || '').trim();
    if (!body || body === '[deleted]' || body === '[removed]') continue;

    // Agreement detection
    const agreeMatches = matchSignals(body, 'agreement');
    const expandedMatches = EXPANDED_AGREEMENT.filter(kw => body.toLowerCase().includes(kw));
    const allAgreeMatches = [...agreeMatches, ...expandedMatches];
    if (allAgreeMatches.length > 0) {
      const upvoteWeight = Math.max(1, Math.log2((c.score || 1) + 1));
      agreementCount += upvoteWeight;
      agreements.push({ body: excerpt(body, 150), score: c.score || 0, signals: allAgreeMatches, url: postUrl });
    }

    // Thematic agreement
    if (postPainCategories.length > 0) {
      const commentCategories = new Set();
      if (matchSignals(body, 'frustration').length) commentCategories.add('frustration');
      if (matchSignals(body, 'desire').length) commentCategories.add('desire');
      if (matchSignals(body, 'cost').length) commentCategories.add('cost');
      const overlap = postPainCategories.filter(c => commentCategories.has(c));
      if (overlap.length > 0) thematicAgreementCount++;
    }

    // Solution detection + tool extraction
    const solutionMatches = matchSignals(body, 'solution');
    if (solutionMatches.length > 0) {
      solutions.push({ body: excerpt(body, 200), score: c.score || 0, signals: solutionMatches, url: postUrl });

      const TOOL_NOISE = new Set([
        'I', 'It', 'The', 'This', 'That', 'My', 'We', 'They', 'But', 'And',
        'Or', 'So', 'If', 'Is', 'Was', 'Are', 'Not', 'For', 'You', 'Your',
        'Just', 'Also', 'Been', 'Have', 'Has', 'Had', 'Very', 'Really',
        'MIL', 'DIY', 'OP', 'PSA', 'TBH', 'IMO', 'FWIW', 'TIL',
        'AI', 'API', 'LLM', 'LLMs', 'IDE', 'MVC', 'REST', 'SQL', 'CLI',
        'UI', 'UX', 'PR', 'CI', 'CD', 'HTTP', 'SSH', 'CSS', 'HTML',
        'Honestly', 'Actually', 'Basically', 'Generally', 'Recently',
        'Unfortunately', 'Personally', 'Obviously', 'Apparently',
        // Common sentence starters misidentified as tool names
        'Maybe', 'Perhaps', 'Sometimes', 'Often', 'Always', 'Never',
        'Well', 'Now', 'Then', 'When', 'What', 'Who', 'Where', 'Why', 'How',
        'Yes', 'No', 'Ok', 'Okay', 'Sure', 'Thanks', 'Thank', 'Sorry',
        'Some', 'Many', 'Most', 'All', 'Few', 'Each', 'Both', 'Any',
        'There', 'Here', 'Today', 'Still', 'Even', 'Same', 'Different',
        'At', 'In', 'On', 'To', 'With', 'By', 'From', 'About', 'Of', 'An',
        'Their', 'Its', 'Our', 'His', 'Her', 'He', 'She',
        'Good', 'Great', 'Better', 'Best', 'Bad', 'Worse', 'Worst',
        'New', 'Old', 'Free', 'Paid', 'Plus', 'One', 'Two', 'Three',
        'SaaS', 'B2B', 'B2C', 'PM', 'SLA', 'KPI', 'OKR', 'MVP',
      ]);
      const lower = body.toLowerCase();
      for (const kw of solutionMatches) {
        const idx = lower.indexOf(kw);
        if (idx >= 0) {
          const after = body.slice(idx + kw.length, idx + kw.length + 50);
          const toolMatch = after.match(/\s+([A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)?)/);
          if (toolMatch) {
            const name = toolMatch[1].trim();
            if (!TOOL_NOISE.has(name) && name.length > 1) {
              mentionedTools.add(name);
            }
          }
        }
      }
    }

    // Top quotes
    const painMatches = [
      ...matchSignals(body, 'frustration'),
      ...matchSignals(body, 'desire'),
      ...matchSignals(body, 'cost'),
    ];
    if (painMatches.length > 0 && (c.score || 0) >= 2) {
      topQuotes.push({ body: excerpt(body, 200), score: c.score || 0, signals: painMatches, url: postUrl });
    }

    // WTP signals
    const wtpMatches = matchSignals(body, 'willingness_to_pay');
    if (wtpMatches.length > 0) {
      moneyTrail.push({ body: excerpt(body, 200), score: c.score || 0, signals: wtpMatches, url: postUrl });
    }

    intensityTotal += computeIntensity(body);
  }

  const validComments = comments.filter(c => {
    const b = (c.body || '').trim();
    return b && b !== '[deleted]' && b !== '[removed]';
  });

  const agreementRatio = validComments.length > 0
    ? Math.round((agreementCount / validComments.length) * 100) / 100
    : 0;
  const thematicRatio = validComments.length > 0
    ? Math.round((thematicAgreementCount / validComments.length) * 100) / 100
    : 0;
  const combinedAgreement = agreementCount + thematicAgreementCount * 0.5;
  const combinedRatio = validComments.length > 0
    ? Math.round((combinedAgreement / validComments.length) * 100) / 100
    : 0;

  let validationStrength;
  if (combinedRatio > 0.20 && combinedAgreement >= 8) validationStrength = 'strong';
  else if (combinedRatio > 0.10 && combinedAgreement >= 4) validationStrength = 'moderate';
  else if (combinedRatio > 0.05 || combinedAgreement >= 2) validationStrength = 'weak';
  else validationStrength = 'anecdotal';

  const avgIntensity = validComments.length > 0
    ? Math.round((intensityTotal / validComments.length) * 100) / 100
    : 0;
  let intensityLevel;
  if (avgIntensity >= 1.5) intensityLevel = 'extreme';
  else if (avgIntensity >= 0.8) intensityLevel = 'high';
  else if (avgIntensity >= 0.3) intensityLevel = 'moderate';
  else intensityLevel = 'low';

  return {
    totalComments: validComments.length,
    agreementCount: Math.round(agreementCount * 10) / 10,
    agreementRatio,
    thematicAgreementCount,
    thematicRatio,
    combinedAgreement: Math.round(combinedAgreement * 10) / 10,
    validationStrength,
    intensityLevel,
    avgIntensity,
    moneyTrailCount: moneyTrail.length,
    topQuotes: topQuotes.slice(0, 5),
    agreements: agreements.slice(0, 5),
    solutionAttempts: solutions.slice(0, 10),
    moneyTrail: moneyTrail.slice(0, 10),
    mentionedTools: [...mentionedTools].slice(0, 15),
  };
}

// ─── post enrichment helpers ────────────────────────────────────────────────

/**
 * Enrich a post with pain scoring fields.
 * Call this after normalizing raw source data to the common post shape.
 * Returns null if the post should be filtered out (hard pain filter).
 *
 * @param {object} post - Normalized post object
 * @param {string} [domain=''] - Domain hint string (split into words for soft boost/penalty)
 * @param {string[]} [domainKeywords=[]] - Hard-gate keyword list. When provided, posts that
 *   do not contain at least one keyword in title+body are rejected (return null).
 *   Example for scalper bots domain:
 *   ['bot', 'scalp', 'resale', 'resell', 'drop', 'queue', 'sold out', 'face value',
 *    'markup', 'ticket', 'snkrs', 'limited release', 'raffle', 'presale']
 */
export function enrichPost(post, domain = '', domainKeywords = []) {
  // Domain-relevance hard gate: reject posts that contain no domain keyword at all.
  // This is the primary fix for 70-80% false-positive rate when scanners pull broad data.
  if (domainKeywords.length > 0) {
    const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainKeyword = domainKeywords.some(kw => text.includes(kw.toLowerCase()));
    if (!hasDomainKeyword) return null;
  }

  let painScore = computePainScore(post);

  // Domain relevance boost/penalty (soft, based on domain hint words)
  const domainLower = domain.toLowerCase();
  const domainWords = domainLower.split(/\s+/).filter(w => w.length > 2);
  if (domain) {
    const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomain = domainWords.some(w => text.includes(w));
    if (hasDomain) painScore += 3.0;
    else painScore -= 2.0;
  }

  const fullText = (post.title || '') + ' ' + (post.selftext || '');
  const titleSignals = [
    ...matchSignals(post.title, 'frustration'),
    ...matchSignals(post.title, 'desire'),
    ...matchSignals(post.title, 'cost'),
  ];
  const bodySignals = [
    ...matchSignals(post.selftext, 'frustration'),
    ...matchSignals(post.selftext, 'desire'),
    ...matchSignals(post.selftext, 'cost'),
  ];
  const allPainSignals = [...new Set([...titleSignals, ...bodySignals])];
  const wtpSignals = matchSignals(fullText, 'willingness_to_pay');
  const intensity = computeIntensity(fullText);

  // Hard pain filter (R2/R4)
  const hasStrongWtp = wtpSignals.some(kw => WTP_STRONG.has(kw));
  // R4: WTP_FIRST_PERSON keywords only count when first-person + contextual
  const hasFirstPersonWtp = wtpSignals.some(kw => {
    if (!WTP_FIRST_PERSON.has(kw)) return false;
    const idx = fullText.toLowerCase().indexOf(kw);
    return isWtpFirstPerson(fullText, idx) && isWtpContextual(fullText, idx);
  });
  if (allPainSignals.length === 0 && !hasStrongWtp && !hasFirstPersonWtp) return null;

  // R3: "looking for" alone without frustration/cost = skip
  if (allPainSignals.length === 1 && allPainSignals[0] === 'looking for') {
    const hasFrustration = matchSignals(fullText, 'frustration').length > 0;
    const hasCost = matchSignals(fullText, 'cost').length > 0;
    if (!hasFrustration && !hasCost) return null;
  }

  // R3: minimum engagement floor (skip for non-Reddit sources like google-autocomplete)
  const NON_REDDIT_SUBREDDITS = new Set(['hackernews', 'kickstarter', 'crowdfunding', 'producthunt', 'appstore', 'reviews']);
  const isRedditSource = !post.subreddit || (
    !post.subreddit.startsWith('google-') &&
    !post.subreddit.startsWith('hn-') &&
    !NON_REDDIT_SUBREDDITS.has(post.subreddit)
  );
  if (isRedditSource && (post.score || 0) < 5 && (post.num_comments || 0) < 10) {
    if (allPainSignals.length < 2) return null;
  }

  // Pain categories
  const painCategories = [];
  if (matchSignals(fullText, 'frustration').length) painCategories.push('frustration');
  if (matchSignals(fullText, 'desire').length) painCategories.push('desire');
  if (matchSignals(fullText, 'cost').length) painCategories.push('cost');
  if (matchSignals(fullText, 'willingness_to_pay').length) painCategories.push('wtp');

  // R3: fine-grained subcategories
  const painSubcategories = [];
  const ftLower = fullText.toLowerCase();
  if (/scalp|sold out|out of stock|restock|can't find|wiped out/.test(ftLower)) painSubcategories.push('product-availability');
  // R4/R5/R6: tightened subcategory regexes to reduce false positives
  if (/too expensive|overpriced|price hike|price increase|ripoff|rip off|goug|hidden fee|not worth the/.test(ftLower)) painSubcategories.push('pricing');
  if (/\bscam\b|counterfeit|reseal|tamper/.test(ftLower)) painSubcategories.push('fraud');
  if (/toxic|rude|harass|threaten|bully|cheat/.test(ftLower)) painSubcategories.push('community-toxicity');
  if (/pokemon company|tpc|tpci|nintendo|print run|reprint/.test(ftLower)) painSubcategories.push('company-policy');
  if (/shipping issue|damaged in shipping|lost in mail|shipping damage|fedex|ups|usps/.test(ftLower)) painSubcategories.push('shipping');
  // R6: \bgrading\b prevents matching 'degrading'
  if (/\bgrading\b|psa |cgc |beckett|\bslab\b/.test(ftLower)) painSubcategories.push('grading');
  // R6: narrowed digital-platform — requires explicit app/software problem context
  if (/ptcg live|software client|the client crash|app keeps crash|app is broken|app doesn.t work|digital tool/.test(ftLower)) painSubcategories.push('digital-platform');
  // R5: renamed from 'hobby-burnout' to 'burnout' — applies to user/customer churn context too
  if (/\bquit\b|\bquitting\b|done with|burnout|burnt out|burn out|\bgiving up\b/.test(ftLower)) painSubcategories.push('burnout');

  painScore = Math.round(painScore * 10) / 10;

  let enriched = {
    id: post.id,
    title: post.title || '',
    subreddit: post.subreddit || '',
    url: post.url || '',
    score: post.score || 0,
    num_comments: post.num_comments || 0,
    upvote_ratio: post.upvote_ratio || 0,
    created_utc: post.created_utc || 0,
    date: post.created_utc ? new Date(post.created_utc * 1000).toISOString().split('T')[0] : null,
    selftext_excerpt: excerpt(post.selftext, 200),
    painScore,
    painSignals: [...new Set(titleSignals)],
    bodyPainSignals: [...new Set(bodySignals)],
    painCategories,
    painSubcategories,
    wtpSignals,
    intensity,
    flair: post.flair || null,
    citeKey: makeCiteKey(post),
  };

  // Carry over LLM augmentation if present on the input post, and blend scores
  if (post.llmAugmentation) {
    enriched.llmAugmentation = post.llmAugmentation;
    enriched = blendLLMScores(enriched);
  }

  return enriched;
}

/**
 * Determine post pain categories for thematic agreement in deep-dive.
 */
export function getPostPainCategories(post) {
  const postText = (post.title || '') + ' ' + (post.selftext || '');
  const cats = [];
  if (matchSignals(postText, 'frustration').length) cats.push('frustration');
  if (matchSignals(postText, 'desire').length) cats.push('desire');
  if (matchSignals(postText, 'cost').length) cats.push('cost');
  return cats;
}

// ─── scoring-engine registration ────────────────────────────────────────────
// Register functions with the PainScorer class for delegation.
// This avoids circular dependencies while allowing the OO interface.

import { registerScoringFunctions } from './scoring-engine.mjs';
registerScoringFunctions({ computePainScore, analyzeComments, enrichPost });

// Re-export signal and context modules for convenience
export { getSignalProfile, listProfiles } from './signals/index.mjs';
export { SignalMatcher } from './signals/matcher.mjs';
export { PainScorer } from './scoring-engine.mjs';
