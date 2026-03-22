/**
 * report/synthesis.mjs — Verdict, scoring, and idea sketch generation
 */

// ─── constants ──────────────────────────────────────────────────────────────

const AUDIENCE_MAP = {
  'pricing':              'Budget-conscious consumers and small businesses sensitive to price increases',
  'product-availability': 'Retail customers and collectors unable to access products at fair market prices',
  'fraud':                'Buyers and sellers requiring product authentication and trust',
  'community-toxicity':   'Community members seeking safe and respectful spaces',
  'company-policy':       'Loyal customers frustrated by corporate decisions affecting the product',
  'shipping':             'Online shoppers who have experienced lost, damaged, or delayed orders',
  'grading':              'Collectors and investors seeking professional card authentication and valuation',
  'digital-platform':     'Digital product users frustrated by app/platform quality or stability',
  'hobby-burnout':        'Long-time enthusiasts considering leaving due to accumulated frustrations',
  'uncategorized':        'General users experiencing the documented pain points',
};

// ─── cross-source bonus ─────────────────────────────────────────────────────

function crossSourceBonus(count) {
  if (count >= 3) return 5;
  if (count >= 2) return 3;
  return 0;
}

// ─── build-worthiness score ─────────────────────────────────────────────────

export function buildWorthinessScore(depth, matrix, moneyTrail, crossSources, postCount) {
  let score = 0;

  if (depth === 'urgent') score += 30;
  else if (depth === 'active') score += 18;
  else score += 5;

  if (matrix === 'primary') score += 30;
  else if (matrix === 'hidden_gem') score += 20;
  else if (matrix === 'background') score += 8;
  else score += 0;

  if (moneyTrail.strength === 'strong') score += 25;
  else if (moneyTrail.strength === 'moderate') score += 15;
  else if (moneyTrail.strength === 'weak') score += 7;

  score += crossSourceBonus(crossSources);
  score += Math.min(10, postCount);

  return Math.min(100, score);
}

// ─── verdict ────────────────────────────────────────────────────────────────

export function determineVerdict(depth, matrix, moneyTrail) {
  if (depth === 'urgent' && (matrix === 'primary' || matrix === 'hidden_gem') && moneyTrail.strength !== 'none') {
    return 'validated';
  }
  if (depth === 'active' && (matrix === 'primary' || matrix === 'hidden_gem')) {
    return 'needs_evidence';
  }
  if (depth === 'urgent' && moneyTrail.strength === 'none') {
    return 'needs_evidence';
  }
  if (depth === 'surface' || matrix === 'ignore') {
    return 'too_weak';
  }
  return 'needs_evidence';
}

// ─── opportunity text ───────────────────────────────────────────────────────

export function buildOpportunityText(g) {
  const categoryName = g.category.replace(/-/g, ' ');
  const hasTools = g.tools.length > 0;
  const toolList = g.tools.slice(0, 3).join(', ');
  const hasSolutionAttempts = g.solutionAttempts.length > 0;
  const topTitles = g.representativePosts.slice(0, 2).map(p => p.title).filter(Boolean);
  const evidenceSnippet = topTitles.length > 0
    ? `Evidence: "${topTitles[0].slice(0, 80)}"${topTitles[1] ? ` and ${topTitles.length - 1} similar posts` : ''}.`
    : '';

  let gapClause = '';
  if (hasSolutionAttempts) {
    const firstAttempt = (g.solutionAttempts[0]?.body || '').replace(/\n/g, ' ').slice(0, 100);
    gapClause = `Current workarounds (e.g., "${firstAttempt}...") are insufficient. `;
  } else if (hasTools) {
    gapClause = `Despite tools like ${toolList} existing, users continue to express this pain across ${g.crossSources} platforms. `;
  } else if (evidenceSnippet) {
    gapClause = `${evidenceSnippet} `;
  }

  let wtpClause = '';
  if (g.moneyTrail.strength === 'strong' || g.moneyTrail.strength === 'moderate') {
    const wtpKeywords = g.representativePosts
      .flatMap(p => p.wtpSignals || []).slice(0, 2).join(', ');
    wtpClause = `WTP signals found (${g.moneyTrail.totalCount} instances${wtpKeywords ? ': ' + wtpKeywords : ''}). `;
  }

  let urgencyClause = '';
  if (g.depth === 'urgent' && g.crossSources >= 2) {
    urgencyClause = `Urgent, cross-platform pain (${g.crossSources} sources) — real demand exists now.`;
  } else if (g.depth === 'urgent') {
    urgencyClause = `Urgent pain — users need a better solution now.`;
  } else if (g.depth === 'active' && g.crossSources >= 2) {
    urgencyClause = `Active pain validated across ${g.crossSources} platforms — first-mover opportunity.`;
  } else if (g.depth === 'active') {
    urgencyClause = `Active pain on ${g.sourceNames[0] || 'one platform'} — validate cross-platform before building.`;
  } else {
    urgencyClause = `Low signal — validate further before building.`;
  }

  return `${gapClause}${wtpClause}${urgencyClause}`;
}

// ─── idea sketch generation ─────────────────────────────────────────────────

export function generateIdeaSketch(g) {
  const categoryName = g.category.replace(/-/g, ' ');

  const topTitles = g.representativePosts.slice(0, 3).map(p => p.title).filter(Boolean);
  const topQuoteBodies = g.topQuotes.slice(0, 2).map(q => (q.body || '').replace(/\n/g, ' ').slice(0, 120)).filter(Boolean);
  let problemStatement;
  if (topQuoteBodies.length > 0) {
    problemStatement = `Users are experiencing significant friction with ${categoryName}: "${topQuoteBodies[0]}." ` +
      `This pain is expressed across ${g.postCount} posts from ${g.crossSources} platform(s) with ${g.totalComments} total comments.`;
  } else if (topTitles.length > 0) {
    problemStatement = `Users repeatedly report problems with ${categoryName}, e.g. "${topTitles[0].slice(0, 100)}." ` +
      `${g.postCount} posts across ${g.crossSources} source(s) confirm this is a recurring issue.`;
  } else {
    problemStatement = `Users experience recurring frustration with ${categoryName} across ${g.postCount} posts and ${g.crossSources} platform(s).`;
  }

  const who = g.audience || `People frustrated with ${categoryName}`;
  const whereTheyHangOut = g.sourceNames.map(s => {
    if (s === 'reddit') return 'Reddit communities';
    if (s === 'hackernews') return 'Hacker News';
    if (s === 'google') return 'Google Search (autocomplete signals)';
    if (s === 'appstore') return 'App Store / Play Store';
    if (s === 'producthunt') return 'Product Hunt';
    if (s === 'crowdfunding') return 'Kickstarter / Indiegogo';
    if (s === 'reviews') return 'G2 / Capterra reviews';
    if (s === 'twitter') return 'Twitter/X';
    return s;
  }).join(', ');

  let currentSpending;
  const wtpExamples = g.moneyTrail.examples.slice(0, 2).map(ex => (ex.body || '').replace(/\n/g, ' ').slice(0, 100)).filter(Boolean);
  if (g.moneyTrail.strength === 'strong') {
    currentSpending = `Strong spending signals (${g.moneyTrail.totalCount} WTP instances). ` +
      (wtpExamples.length > 0 ? `E.g.: "${wtpExamples[0]}"` : 'Users actively spending on workarounds.');
  } else if (g.moneyTrail.strength === 'moderate') {
    currentSpending = `Moderate spending signals (${g.moneyTrail.totalCount} WTP instances). ` +
      (wtpExamples.length > 0 ? `E.g.: "${wtpExamples[0]}"` : 'Some users paying for partial solutions.');
  } else if (g.moneyTrail.strength === 'weak') {
    currentSpending = `Weak spending signals (${g.moneyTrail.totalCount} instance). Users express willingness but limited evidence of actual spending.`;
  } else {
    currentSpending = 'No direct spending signals found — users may be relying on free workarounds or enduring the pain.';
  }

  const solutionBodies = g.solutionAttempts.slice(0, 5).map(s => (s.body || '').replace(/\n/g, ' ').slice(0, 150));
  let coreFeature;
  if (solutionBodies.length > 0) {
    coreFeature = `Address the gap exposed by current workarounds: "${solutionBodies[0]}." Build the single feature that eliminates this friction.`;
  } else {
    coreFeature = `Build a focused tool that directly resolves the core ${categoryName} frustration — start with the single most-requested capability.`;
  }

  let whyExistingFail;
  if (g.tools.length > 0 && g.solutionAttempts.length > 0) {
    whyExistingFail = `Tools like ${g.tools.slice(0, 3).join(', ')} exist, but users still report pain. ` +
      `Current solutions are insufficient: "${solutionBodies[0] || 'workarounds are partial and unreliable'}."`;
  } else if (g.tools.length > 0) {
    whyExistingFail = `Existing tools (${g.tools.slice(0, 3).join(', ')}) don't fully solve the problem — users continue to express frustration across ${g.crossSources} platforms.`;
  } else {
    whyExistingFail = 'No established tools were mentioned by users — the market appears underserved with no dominant solution.';
  }

  let keyDifferentiator;
  if (g.unspokenPain.length > 0) {
    const hint = typeof g.unspokenPain[0] === 'string' ? g.unspokenPain[0] : g.unspokenPain[0].body;
    keyDifferentiator = `Address the unspoken need: "${(hint || '').replace(/\n/g, ' ').slice(0, 120)}." This is the gap competitors miss.`;
  } else if (g.tools.length > 0) {
    keyDifferentiator = `Differentiate by solving what ${g.tools[0]} doesn't — focus on the specific pain points users keep complaining about despite using existing tools.`;
  } else {
    keyDifferentiator = `First-mover advantage in an underserved market — no dominant solution exists for this specific pain.`;
  }

  let pricing;
  const wtpSignalTexts = [];
  for (const p of g.representativePosts) {
    if (p.wtpSignals) wtpSignalTexts.push(...p.wtpSignals);
  }
  for (const ex of g.moneyTrail.examples) {
    if (ex.signals) wtpSignalTexts.push(...ex.signals);
  }
  const hasSubscriptionSignal = wtpSignalTexts.some(s =>
    /per month|per year|subscription|monthly|annual/i.test(s));
  const hasOneTimeSignal = wtpSignalTexts.some(s =>
    /bought|purchased|one-time|lifetime/i.test(s));

  if (hasSubscriptionSignal) {
    pricing = 'Subscription model indicated — users mention monthly/annual pricing. Start with a freemium tier to capture the market, upgrade path at $10-30/mo.';
  } else if (hasOneTimeSignal) {
    pricing = 'One-time purchase signals detected. Consider a one-time fee with optional premium support tier.';
  } else if (g.moneyTrail.strength === 'strong' || g.moneyTrail.strength === 'moderate') {
    pricing = `Users show willingness to pay (${g.moneyTrail.totalCount} signals). Start with a low-friction entry price and iterate based on conversion data.`;
  } else {
    pricing = 'Limited pricing signals — validate WTP with a landing page or pre-sale before committing to a pricing model.';
  }

  let revenueModel;
  if (hasSubscriptionSignal) {
    revenueModel = 'SaaS (recurring subscription) — monthly/annual plans with tiered feature access.';
  } else if (categoryName.includes('marketplace') || categoryName.includes('availability')) {
    revenueModel = 'Marketplace / transactional — take a percentage per transaction or list fee.';
  } else {
    revenueModel = 'SaaS / freemium — free tier to build user base, premium tier for power users and teams.';
  }

  let estimatedWtp;
  if (g.moneyTrail.totalCount >= 5) {
    estimatedWtp = `High — ${g.moneyTrail.totalCount} WTP signals found. Users are actively spending or expressing willingness to spend on solutions.`;
  } else if (g.moneyTrail.totalCount >= 2) {
    estimatedWtp = `Moderate — ${g.moneyTrail.totalCount} WTP signals. Some spending evidence exists, but more validation needed.`;
  } else if (g.moneyTrail.totalCount >= 1) {
    estimatedWtp = `Low — ${g.moneyTrail.totalCount} WTP signal. Willingness to pay is suggested but not confirmed at scale.`;
  } else {
    estimatedWtp = 'Unknown — no direct WTP signals found. Needs dedicated pricing validation (surveys, landing page tests).';
  }

  const loudestSource = g.sourceNames[0] || 'the community where pain was discovered';
  const launchChannel = `${whereTheyHangOut} — this is where the pain is loudest (${g.postCount} posts, ${g.totalScore} total engagement score).`;

  let first100;
  if (g.sourceNames.includes('reddit')) {
    first100 = `Engage directly in Reddit communities where this pain was found. Post value-first content, answer questions, and offer early access to active complainers.`;
  } else if (g.sourceNames.includes('hackernews')) {
    first100 = `Launch on Hacker News with a "Show HN" post. Target the technical users already discussing this problem.`;
  } else {
    first100 = `Reach out directly to users who posted about this pain on ${loudestSource}. Offer early access in exchange for feedback.`;
  }

  const topEngagedPost = g.representativePosts[0];
  let contentAngle;
  if (topEngagedPost) {
    contentAngle = `Lead with the language users already use: "${topEngagedPost.title?.slice(0, 80) || categoryName}." ` +
      `This framing resonated (${topEngagedPost.score || 0} upvotes, ${topEngagedPost.num_comments || 0} comments).`;
  } else {
    contentAngle = `Frame content around the core ${categoryName} frustration using the exact language and phrases found in user complaints.`;
  }

  const directCompetitors = g.tools.length > 0
    ? g.tools.slice(0, 5).join(', ') + ` — mentioned by users but not fully solving the problem.`
    : 'No direct competitors identified — potential greenfield opportunity.';

  let indirectCompetitors;
  if (solutionBodies.length > 0) {
    indirectCompetitors = `Current workarounds: "${solutionBodies.slice(0, 2).join('"; "').slice(0, 200)}."`;
  } else {
    indirectCompetitors = 'Users appear to endure the pain without structured workarounds.';
  }

  let moatOpportunity;
  if (g.crossSources >= 3) {
    moatOpportunity = `Cross-platform validation (${g.crossSources} sources) suggests a broad market. Build a network effect or data moat that is hard to replicate.`;
  } else if (g.unspokenPain.length > 0) {
    moatOpportunity = `Address the unspoken pain that competitors miss — deep domain expertise and user empathy are hard to replicate.`;
  } else if (g.tools.length === 0) {
    moatOpportunity = `First-mover advantage in an underserved market — build brand loyalty and switching costs early.`;
  } else {
    moatOpportunity = `Differentiate on UX and the specific pain dimensions that existing tools (${g.tools.slice(0, 2).join(', ')}) ignore.`;
  }

  let keyAssumption;
  if (g.moneyTrail.strength === 'none') {
    keyAssumption = `Users will pay for a solution — pain is clearly expressed but willingness to pay is unconfirmed.`;
  } else if (g.crossSources < 2) {
    keyAssumption = `This pain extends beyond ${g.sourceNames[0] || 'one platform'} — currently validated on only ${g.crossSources} source(s).`;
  } else {
    keyAssumption = `The pain is severe enough to drive adoption — users will switch from current workarounds to a dedicated solution.`;
  }

  let howToTest;
  if (g.moneyTrail.strength === 'none') {
    howToTest = 'Landing page with pricing tiers + email capture. Measure conversion rate to validate WTP before building.';
  } else if (g.depth === 'urgent') {
    howToTest = 'Rapid prototype or concierge MVP. The pain is urgent enough that a minimal solution can capture early adopters within weeks.';
  } else {
    howToTest = 'Survey 20-30 users from the communities where pain was found. Validate the specific feature priorities and price sensitivity.';
  }

  const redFlags = [];
  if (g.moneyTrail.strength === 'none') redFlags.push('No WTP signals — users may not pay even if pain is real.');
  if (g.crossSources < 2) redFlags.push(`Pain found on only ${g.crossSources} source — may be platform-specific, not a universal need.`);
  if (g.depth === 'surface') redFlags.push('Surface-level frustration only — users may not be motivated enough to switch to a new solution.');
  if (g.postCount < 3) redFlags.push(`Low post volume (${g.postCount}) — sample size may be too small for reliable conclusions.`);
  if (g.tools.length >= 5) redFlags.push(`Crowded market (${g.tools.length} tools mentioned) — differentiation will be critical.`);
  if (redFlags.length === 0) redFlags.push('No major red flags identified — but always validate assumptions before committing resources.');

  const verdictLabel = g.verdict === 'validated' ? 'Validated'
    : g.verdict === 'needs_evidence' ? 'Needs More Evidence'
    : 'Too Weak';

  return {
    category: g.category,
    verdict: g.verdict,
    verdictLabel,
    buildScore: g.buildScore,
    problemStatement,
    targetCustomer: { who, whereTheyHangOut, currentSpending },
    solutionConcept: { coreFeature, whyExistingFail, keyDifferentiator },
    businessModel: { pricing, revenueModel, estimatedWtp },
    goToMarket: { launchChannel, first100, contentAngle },
    competitiveLandscape: { directCompetitors, indirectCompetitors, moatOpportunity },
    riskAndValidation: { keyAssumption, howToTest, redFlags },
  };
}

/**
 * Generate idea sketches for all validated or needs-evidence groups.
 */
export function generateIdeaSketches(groups) {
  return groups
    .filter(g => g.verdict === 'validated' || g.verdict === 'needs_evidence')
    .map(g => generateIdeaSketch(g));
}

/**
 * Get the audience string for a category.
 */
export function getAudience(category) {
  return AUDIENCE_MAP[category] || AUDIENCE_MAP['uncategorized'];
}
