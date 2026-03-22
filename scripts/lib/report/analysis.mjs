/**
 * report/analysis.mjs — Grouping, classification, and analysis logic
 */

import { log } from '../utils.mjs';
import { matchSignals } from '../scoring.mjs';

// ─── force-categorize ──────────────────────────────────────────────────────

/**
 * Force-categorize a post using its title + body when the scanner did not assign subcategories.
 */
function forceCategorize(post) {
  const ft = ((post.title || '') + ' ' + (post.selftext_excerpt || '')).toLowerCase();
  const cats = [];

  if (/\bbot\b|scalp|sold.?out|out.?of.?stock|restock|can.?t.?find|wiped.?out|ticket|resell|resale|drop|queue|presale|raffle|snkrs|face.?value|markup|limited.?release|fair.?access|bots.?buy|all.?gone/.test(ft)) {
    cats.push('product-availability');
  }
  if (/too.?expensive|overpriced|price.?hike|ripoff|rip.?off|goug|hidden.?fee|not.?worth.?the|service.?fee|junk.?fee|dynamic.?pric/.test(ft)) {
    cats.push('pricing');
  }
  if (/app.?(crash|broken|not.?work|bugs?|freeze|glitch|slow|terrible)|website.?(crash|broken|down|terrible)|login.?fail|queue.?system|virtual.?queue|waiting.?room/.test(ft)) {
    cats.push('digital-platform');
  }
  if (/\bscam\b|counterfeit|fake.?ticket|fraud|stolen/.test(ft)) {
    cats.push('fraud');
  }
  if (/monopol|antitrust|ticketmaster.*(control|dominat|lock|exclusiv)|live.?nation.*(control|dominat|merger)|no.?competition|no.?alternative/.test(ft)) {
    cats.push('company-policy');
  }
  if (/\bquit\b|\bquitting\b|done.?with|burn.?out|burnt.?out|giving.?up|stop.?trying|never.?buy|boycott/.test(ft)) {
    cats.push('burnout');
  }

  return cats;
}

// ─── groupBySubcategory ──────────────────────────────────────────────────────

/**
 * Group posts by their painSubcategories.
 * A post with multiple subcategories appears in each group.
 * Posts with no subcategories are force-categorized using content analysis.
 * Posts that still cannot be categorized are discarded.
 */
export function groupBySubcategory(posts) {
  const groups = new Map();
  let discarded = 0;

  for (const post of posts) {
    let subcats = post.painSubcategories || [];

    if (subcats.length === 0) {
      subcats = forceCategorize(post);
    }

    if (subcats.length === 0) {
      discarded++;
      continue;
    }

    for (const cat of subcats) {
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(post);
    }
  }

  if (discarded > 0) {
    log(`[report] Discarded ${discarded} posts that could not be domain-categorized`);
  }

  return groups;
}

// ─── cross-source validation ─────────────────────────────────────────────────

function crossSourceCount(posts) {
  const sources = new Set(posts.map(p => p._source || p.subreddit || 'unknown'));
  return { sources, count: sources.size };
}

// ─── pain depth classification ───────────────────────────────────────────────

/**
 * Classify a group of posts into surface / active / urgent.
 */
export function classifyDepth(posts) {
  const llmDepths = posts.map(p => p.llmAugmentation?.painDepth).filter(Boolean);
  if (llmDepths.length > 0 && llmDepths.length >= posts.length * 0.5) {
    const depthCounts = { urgent: 0, active: 0, surface: 0 };
    for (const d of llmDepths) depthCounts[d] = (depthCounts[d] || 0) + 1;
    if (depthCounts.urgent >= depthCounts.active && depthCounts.urgent >= depthCounts.surface) return 'urgent';
    if (depthCounts.active >= depthCounts.surface) return 'active';
    return 'surface';
  }

  const analyses = posts.map(p => p._analysis).filter(Boolean);

  const totalMoneyTrail = analyses.reduce((s, a) => s + (a.moneyTrailCount || 0), 0);
  const hasStrongValidation = analyses.some(a => a.validationStrength === 'strong');
  const hasHighIntensity = analyses.some(a =>
    a.intensityLevel === 'high' || a.intensityLevel === 'extreme');

  const postLevelWtpCount = analyses.length === 0
    ? posts.reduce((s, p) => s + (p.wtpSignals || []).length, 0)
    : 0;
  const postLevelIntensityHigh = analyses.length === 0
    ? posts.some(p => (p.intensity || 0) >= 2)
    : false;

  const effectiveMoneyTrail = totalMoneyTrail + postLevelWtpCount;

  const hasDesireSignals = posts.some(p =>
    (p.painCategories || []).includes('desire') ||
    (p.painSignals || []).some(s => ['looking for', 'alternative to', 'switched from', 'is there a'].includes(s)));

  if (effectiveMoneyTrail >= 3 || (hasStrongValidation && hasHighIntensity)) {
    return 'urgent';
  }
  if (hasStrongValidation || hasDesireSignals || effectiveMoneyTrail >= 1 || postLevelIntensityHigh) {
    return 'active';
  }
  return 'surface';
}

// ─── frequency vs intensity matrix ──────────────────────────────────────────

/**
 * Compute frequency and intensity scores for a group.
 */
export function computeMatrix(posts, crossSources) {
  const postCount = posts.length;
  const crossSourceBonus = crossSources > 1 ? crossSources * 2 : 0;
  const frequency = postCount + crossSourceBonus;

  const analyses = posts.map(p => p._analysis).filter(Boolean);

  let intensityScore = 0;
  let intensityThreshold = 2.0;
  if (analyses.length > 0) {
    const intensityMap = { extreme: 4, high: 3, moderate: 2, low: 1 };
    const avg = analyses.reduce((s, a) => s + (intensityMap[a.intensityLevel] || 1), 0) / analyses.length;
    const unanalyzed = posts.filter(p => !p._analysis);
    if (unanalyzed.length > 0) {
      const avgPainScore = unanalyzed.reduce((s, p) => s + (p.painScore || 0), 0) / unanalyzed.length;
      const painScoreMapped = 1 + Math.min(3, avgPainScore / 5);
      const deepWeight = analyses.length;
      const shallowWeight = unanalyzed.length * 0.5;
      intensityScore = (avg * deepWeight + painScoreMapped * shallowWeight) / (deepWeight + shallowWeight);
    } else {
      intensityScore = avg;
    }
    intensityThreshold = 1.5;
  } else {
    const postIntensities = posts.map(p => p.intensity || 0);
    const avgKeywordIntensity = postIntensities.length > 0
      ? postIntensities.reduce((s, i) => s + i, 0) / postIntensities.length
      : 0;
    const avgPainScore = posts.reduce((s, p) => s + (p.painScore || 0), 0) / (posts.length || 1);
    const painScoreIntensity = Math.min(3, avgPainScore / 4);
    intensityScore = Math.max(avgKeywordIntensity, painScoreIntensity);
    intensityThreshold = 1.0;
  }

  const isFrequent = frequency >= 4;
  const isIntense = intensityScore >= intensityThreshold;

  let position;
  if (isFrequent && isIntense) position = 'primary';
  else if (!isFrequent && isIntense) position = 'hidden_gem';
  else if (isFrequent && !isIntense) position = 'background';
  else position = 'ignore';

  return { frequency, intensityScore: Math.round(intensityScore * 10) / 10, position };
}

// ─── WTP / money trail ─────────────────────────────────────────────────────

/**
 * Aggregate money trail evidence across all posts in a group.
 */
export function aggregateMoneyTrail(posts) {
  const trails = [];
  const totalCount = posts.reduce((s, p) => {
    if (p._analysis) return s + (p._analysis.moneyTrailCount || 0);
    return s + (p.wtpSignals || []).length;
  }, 0);

  for (const p of posts) {
    if (p._analysis?.moneyTrail) {
      for (const m of p._analysis.moneyTrail.slice(0, 2)) {
        trails.push({ ...m, url: m.url || p.url || '' });
      }
    }
  }

  let strength;
  if (totalCount >= 5) strength = 'strong';
  else if (totalCount >= 2) strength = 'moderate';
  else if (totalCount >= 1) strength = 'weak';
  else strength = 'none';

  return { totalCount, strength, examples: trails.slice(0, 4) };
}

// ─── unspoken pain ──────────────────────────────────────────────────────────

/**
 * Extract unspoken/underlying pain patterns from top quotes and solution attempts.
 */
export function extractUnspokenPain(posts) {
  const hints = [];

  for (const p of posts) {
    if (p.llmAugmentation?.unspokenPain) {
      hints.push({
        body: `[LLM] ${p.llmAugmentation.unspokenPain}`,
        url: p.url || '',
        llmSource: true,
      });
    }
  }

  for (const p of posts) {
    const analysis = p._analysis;
    if (!analysis) continue;
    for (const sol of (analysis.solutionAttempts || []).slice(0, 3)) {
      const body = (sol.body || '').toLowerCase();
      if (body.includes('workaround') || body.includes('built my own') || body.includes('hack') ||
          body.includes('still') || body.includes('but ') || body.includes('failed') ||
          body.includes("doesn't work") || body.includes("didn't work")) {
        hints.push({ body: sol.body, url: sol.url || p.url || '' });
      }
    }
    for (const q of (analysis.topQuotes || []).slice(0, 2)) {
      if ((q.score || 0) >= 10) hints.push({ body: q.body, url: q.url || p.url || '' });
    }
  }

  const seen = new Set();
  return hints.filter(h => {
    const key = (h.body || h).slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

// ─── competitive landscape ──────────────────────────────────────────────────

const DOMAIN_COMPETITORS = new Set([
  'AXS', 'Eventbrite', 'DICE', 'Dice', 'TicketFairy', 'Ticketfairy',
  'SeatGeek', 'Vivid Seats', 'VividSeats', 'ResidentAdvisor', 'Resident Advisor',
  'Partiful', 'wail.fm', 'TicketSwap', 'Tixel', 'Lyte', 'YellowHeart', 'Yellowheart',
  'StubHub', 'GOAT', 'StockX',
  'Queue-it', 'Queue it', 'PartAlert', 'Kasada', 'Imperva', 'Akamai',
]);

const TOOL_FALSE_POSITIVES = new Set([
  'San Francisco', 'New York', 'California', 'Virginia', 'Texas', 'Chicago',
  'SEC', 'FTC', 'DOJ', 'EU', 'Congress', 'Senate', 'House',
  'Amazon', 'Google', 'Apple', 'Meta', 'Microsoft', 'Sony', 'Nintendo',
  'AMD', 'Nvidia', 'Intel', 'Apple Pay', 'Sony VAIOs',
  'Tiktoker', 'Scrubs', 'NorVa', 'Phantom', 'Clear Channel', 'Western Canada',
  'Walmart', 'Newegg', 'Best Buy', 'Target',
]);

export function aggregateTools(posts) {
  const allTools = new Set();
  for (const p of posts) {
    if (p._analysis?.mentionedTools) {
      for (const t of p._analysis.mentionedTools) {
        if (TOOL_FALSE_POSITIVES.has(t)) continue;
        allTools.add(t);
      }
    }
  }

  for (const p of posts) {
    const solutionText = (p._analysis?.solutionAttempts || [])
      .map(s => s.body || '').join(' ');
    for (const comp of DOMAIN_COMPETITORS) {
      if (solutionText.includes(comp)) allTools.add(comp);
    }
  }

  const sorted = [...allTools].sort((a, b) => {
    const aKnown = DOMAIN_COMPETITORS.has(a) ? 0 : 1;
    const bKnown = DOMAIN_COMPETITORS.has(b) ? 0 : 1;
    return aKnown - bKnown;
  });

  return sorted.slice(0, 10);
}
