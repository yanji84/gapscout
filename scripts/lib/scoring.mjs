/**
 * scoring.mjs — Shared scoring engine for pain-point-finder
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

import { excerpt } from './utils.mjs';

// ─── pain signal keywords ────────────────────────────────────────────────────

export const PAIN_SIGNALS = {
  frustration: [
    'frustrated', 'frustrating', 'annoying', 'annoyed',
    'fed up', 'sick of', 'tired of', 'giving up', 'nightmare',
    'terrible', 'awful', 'broken', 'buggy', 'unusable',
    'horrible', 'worst', 'garbage', 'trash', 'joke',
    'hate', 'ruining', 'killing', 'destroying',
  ],
  desire: [
    'wish there was', 'looking for', 'alternative to',
    'switched from', 'better than', 'anything else',
    'does anyone know', 'recommendations for',
    'is there a', 'need something',
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
];

export const NON_PAIN_FLAIRS = new Set([
  'appreciation', 'resources', 'tips', 'showcase', 'release',
  'announcement', 'meta', 'discussion', 'tutorial', 'guide',
  'deck', 'pulls', 'meme', 'humor', 'art', 'collection',
]);

export const WTP_STRONG = new Set([
  'would pay', "i'd pay", 'happy to pay', 'shut up and take my money',
  'take my money', 'worth paying', 'gladly pay', 'budget for',
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

  // WTP: context-aware (R2)
  const wtpMatches = matchSignals(fullText, 'willingness_to_pay');
  const effectiveWtpMatches = [];
  for (const kw of wtpMatches) {
    const idx = fullText.toLowerCase().indexOf(kw);
    const sentMult = sentimentMultiplier(fullText, idx);
    if (WTP_STRONG.has(kw)) {
      score += 3.0 * sentMult;
      effectiveWtpMatches.push(kw);
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

export function analyzeComments(comments, postPainCategories = []) {
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
      agreements.push({ body: excerpt(body, 150), score: c.score || 0, signals: allAgreeMatches });
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
      solutions.push({ body: excerpt(body, 200), score: c.score || 0, signals: solutionMatches });

      const TOOL_NOISE = new Set([
        'I', 'It', 'The', 'This', 'That', 'My', 'We', 'They', 'But', 'And',
        'Or', 'So', 'If', 'Is', 'Was', 'Are', 'Not', 'For', 'You', 'Your',
        'Just', 'Also', 'Been', 'Have', 'Has', 'Had', 'Very', 'Really',
        'MIL', 'DIY', 'OP', 'PSA', 'TBH', 'IMO', 'FWIW', 'TIL',
        'AI', 'API', 'LLM', 'LLMs', 'IDE', 'MVC', 'REST', 'SQL', 'CLI',
        'UI', 'UX', 'PR', 'CI', 'CD', 'HTTP', 'SSH', 'CSS', 'HTML',
        'Honestly', 'Actually', 'Basically', 'Generally', 'Recently',
        'Unfortunately', 'Personally', 'Obviously', 'Apparently',
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
      topQuotes.push({ body: excerpt(body, 200), score: c.score || 0, signals: painMatches });
    }

    // WTP signals
    const wtpMatches = matchSignals(body, 'willingness_to_pay');
    if (wtpMatches.length > 0) {
      moneyTrail.push({ body: excerpt(body, 200), score: c.score || 0, signals: wtpMatches });
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
 */
export function enrichPost(post, domain = '') {
  let painScore = computePainScore(post);

  // Domain relevance boost/penalty
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

  // Hard pain filter (R2)
  const hasStrongWtp = wtpSignals.some(kw => WTP_STRONG.has(kw));
  if (allPainSignals.length === 0 && !hasStrongWtp) return null;

  // R3: "looking for" alone without frustration/cost = skip
  if (allPainSignals.length === 1 && allPainSignals[0] === 'looking for') {
    const hasFrustration = matchSignals(fullText, 'frustration').length > 0;
    const hasCost = matchSignals(fullText, 'cost').length > 0;
    if (!hasFrustration && !hasCost) return null;
  }

  // R3: minimum engagement floor
  if ((post.score || 0) < 5 && (post.num_comments || 0) < 10) {
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
  if (/expensive|overpriced|price|cost|ripoff|goug/.test(ftLower)) painSubcategories.push('pricing');
  if (/scam|fake|counterfeit|reseal|tamper/.test(ftLower)) painSubcategories.push('fraud');
  if (/toxic|rude|harass|threaten|bully|cheat/.test(ftLower)) painSubcategories.push('community-toxicity');
  if (/pokemon company|tpc|tpci|nintendo|print run|reprint/.test(ftLower)) painSubcategories.push('company-policy');
  if (/shipping|damage|lost|fedex|ups|usps/.test(ftLower)) painSubcategories.push('shipping');
  if (/grading|psa|cgc|beckett|tag |slab/.test(ftLower)) painSubcategories.push('grading');
  if (/app|ptcg live|client|online|digital/.test(ftLower)) painSubcategories.push('digital-platform');
  if (/quit|leaving|done with|burnout|burnt out|burn out|giving up/.test(ftLower)) painSubcategories.push('hobby-burnout');

  painScore = Math.round(painScore * 10) / 10;

  return {
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
  };
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
