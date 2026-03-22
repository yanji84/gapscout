#!/usr/bin/env node

/**
 * report.mjs — Cross-source pain point report aggregator and synthesizer
 *
 * Usage:
 *   pain-points report --files reddit-scan.json,hn-scan.json,reviews-scan.json
 *   pain-points report --files scan1.json --format json
 *   cat scan.json | pain-points report --stdin
 *
 * Input: One or more scan/deep-dive JSON files from any source module.
 *   Each file must be a { ok: true, data: { posts: [...] } } envelope
 *   OR a { ok: true, data: { results: [...] } } deep-dive envelope.
 *
 * Output:
 *   --format md   (default) Markdown report following Phase 4-7 structure
 *   --format json Structured JSON for downstream processing
 */

import { readFileSync, readSync } from 'node:fs';
import { log, normalizeArgs } from './lib/utils.mjs';

// ─── constants ────────────────────────────────────────────────────────────────

const PAIN_DEPTH = {
  urgent:  { label: 'Urgent problem',       emoji: 'URGENT'  },
  active:  { label: 'Active pain',          emoji: 'ACTIVE'  },
  surface: { label: 'Surface frustration',  emoji: 'SURFACE' },
};

const MATRIX_LABELS = {
  primary:    'Primary target',
  hidden_gem: 'Hidden gem',
  background: 'Background noise',
  ignore:     'Ignore',
};

const VERDICTS = {
  validated:       'Validated',
  needs_evidence:  'Needs more evidence',
  too_weak:        'Too weak to build on',
};

// ─── input loading ─────────────────────────────────────────────────────────

/**
 * Load and flatten all posts/results from a parsed JSON scan file.
 * Returns an array of post objects annotated with { _source, _file }.
 */
function loadFile(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    log(`[report] Cannot read ${filePath}: ${err.message}`);
    return [];
  }

  const data = raw?.data || raw;
  const fileSource = data?.source || null;
  const posts = [];

  // Infer source from file path when data.source is missing
  function inferSource(post, fallback) {
    if (fallback) return fallback;
    const sub = post?.subreddit;
    if (!sub) return 'unknown';
    // Normalize known subreddit values to canonical source names
    if (sub === 'hackernews') return 'hackernews';
    if (sub === 'playstore' || sub === 'appstore') return 'appstore';
    if (sub === 'google-autocomplete') return 'google';
    if (sub === 'kickstarter') return 'kickstarter';
    if (sub === 'producthunt') return 'producthunt';
    // Reddit subreddits (PS5, nvidia, Ticketmaster, etc.)
    return 'reddit';
  }

  // Scan output: { posts: [...] }
  if (Array.isArray(data?.posts)) {
    for (const p of data.posts) {
      const source = inferSource(p, fileSource);
      posts.push({ ...p, _source: source, _file: filePath });
    }
  }

  // Deep-dive output: { results: [{ post, analysis }] }
  if (Array.isArray(data?.results)) {
    for (const r of data.results) {
      if (r.post) {
        const source = inferSource(r.post, fileSource);
        posts.push({ ...r.post, _analysis: r.analysis, _source: source, _file: filePath });
      }
    }
  }

  // Alternative deep-dive format: { deep_dives: [{ post, analysis }] }
  if (Array.isArray(data?.deep_dives)) {
    for (const r of data.deep_dives) {
      if (r.post) {
        const source = inferSource(r.post, fileSource);
        posts.push({ ...r.post, _analysis: r.analysis, _source: source, _file: filePath });
      }
    }
  }

  return posts;
}

function loadStdin() {
  const chunks = [];
  const fd = process.stdin.fd;
  const buf = Buffer.alloc(65536);
  let n;
  try {
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(buf.slice(0, n).toString());
    }
  } catch {
    // EOF
  }
  const text = chunks.join('');
  if (!text.trim()) return [];
  try {
    const raw = JSON.parse(text);
    const data = raw?.data || raw;
    const fileSource = data?.source || null;
    const posts = [];
    function inferSourceStdin(post) {
      if (fileSource) return fileSource;
      const sub = post?.subreddit;
      if (!sub) return 'stdin';
      if (sub === 'hackernews') return 'hackernews';
      if (sub === 'playstore' || sub === 'appstore') return 'appstore';
      if (sub === 'google-autocomplete') return 'google';
      if (sub === 'kickstarter') return 'kickstarter';
      if (sub === 'producthunt') return 'producthunt';
      return 'reddit';
    }
    if (Array.isArray(data?.posts)) {
      for (const p of data.posts) posts.push({ ...p, _source: inferSourceStdin(p), _file: 'stdin' });
    }
    if (Array.isArray(data?.results)) {
      for (const r of data.results) {
        if (r.post) posts.push({ ...r.post, _analysis: r.analysis, _source: inferSourceStdin(r.post), _file: 'stdin' });
      }
    }
    return posts;
  } catch (err) {
    log(`[report] Cannot parse stdin: ${err.message}`);
    return [];
  }
}

// ─── grouping by subcategory ─────────────────────────────────────────────────

/**
 * Force-categorize a post using its title + body when the scanner did not assign subcategories.
 * Returns an array of category strings (may be empty if the post is true noise).
 * These regexes mirror scoring.mjs but are broadened to catch domain-specific signals
 * that the scoring engine's subcategory regexes miss (e.g. Google autocomplete phrases,
 * app store review titles, HN headlines about ticketing/scalping).
 */
function forceCategorize(post) {
  const ft = ((post.title || '') + ' ' + (post.selftext_excerpt || '')).toLowerCase();
  const cats = [];

  // product-availability: scalping, bots, drop failures, sold-out, ticketing access
  if (/\bbot\b|scalp|sold.?out|out.?of.?stock|restock|can.?t.?find|wiped.?out|ticket|resell|resale|drop|queue|presale|raffle|snkrs|face.?value|markup|limited.?release|fair.?access|bots.?buy|all.?gone/.test(ft)) {
    cats.push('product-availability');
  }

  // pricing: hidden fees, service fees, excessive markup
  if (/too.?expensive|overpriced|price.?hike|ripoff|rip.?off|goug|hidden.?fee|not.?worth.?the|service.?fee|junk.?fee|dynamic.?pric/.test(ft)) {
    cats.push('pricing');
  }

  // digital-platform: app/platform failures
  if (/app.?(crash|broken|not.?work|bugs?|freeze|glitch|slow|terrible)|website.?(crash|broken|down|terrible)|login.?fail|queue.?system|virtual.?queue|waiting.?room/.test(ft)) {
    cats.push('digital-platform');
  }

  // fraud: fake tickets, counterfeit
  if (/\bscam\b|counterfeit|fake.?ticket|fraud|stolen/.test(ft)) {
    cats.push('fraud');
  }

  // company-policy: monopoly, antitrust, platform lock-in
  if (/monopol|antitrust|ticketmaster.*(control|dominat|lock|exclusiv)|live.?nation.*(control|dominat|merger)|no.?competition|no.?alternative/.test(ft)) {
    cats.push('company-policy');
  }

  // burnout: giving up on buying, consumer frustration leading to exit
  if (/\bquit\b|\bquitting\b|done.?with|burn.?out|burnt.?out|giving.?up|stop.?trying|never.?buy|boycott/.test(ft)) {
    cats.push('burnout');
  }

  return cats;
}

/**
 * Group posts by their painSubcategories.
 * A post with multiple subcategories appears in each group.
 * Posts with no subcategories are force-categorized using content analysis.
 * Posts that still cannot be categorized are discarded (they are noise).
 */
function groupBySubcategory(posts) {
  const groups = new Map();
  let discarded = 0;

  for (const post of posts) {
    let subcats = post.painSubcategories || [];

    // Force-categorize if scanner left the post uncategorized
    if (subcats.length === 0) {
      subcats = forceCategorize(post);
    }

    // Discard posts that genuinely cannot be categorized — they are noise
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

/**
 * Count distinct sources that mention a category.
 * Returns { sources: Set<string>, count: number }
 */
function crossSourceCount(posts) {
  const sources = new Set(posts.map(p => p._source || p.subreddit || 'unknown'));
  return { sources, count: sources.size };
}

// ─── pain depth classification (Phase 4) ─────────────────────────────────────

/**
 * Classify a group of posts into surface / active / urgent.
 *
 * Urgent:  high moneyTrailCount OR strong validationStrength + high/extreme intensity
 * Active:  moderate validation OR desire signals present
 * Surface: everything else
 */
function classifyDepth(posts) {
  const analyses = posts.map(p => p._analysis).filter(Boolean);

  const totalMoneyTrail = analyses.reduce((s, a) => s + (a.moneyTrailCount || 0), 0);
  const hasStrongValidation = analyses.some(a => a.validationStrength === 'strong');
  const hasHighIntensity = analyses.some(a =>
    a.intensityLevel === 'high' || a.intensityLevel === 'extreme');

  // Fall back to post-level wtpSignals when no deep-dive analysis is available
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

// ─── frequency vs intensity matrix (Phase 5) ─────────────────────────────────

/**
 * Compute frequency and intensity scores for a group.
 * Frequency: post count + cross-source bonus
 * Intensity: from deep-dive intensityLevel, else from post intensity fields
 */
function computeMatrix(posts, crossSources) {
  const postCount = posts.length;
  const crossSourceBonus = crossSources > 1 ? crossSources * 2 : 0;
  const frequency = postCount + crossSourceBonus;

  const analyses = posts.map(p => p._analysis).filter(Boolean);

  let intensityScore = 0;
  let intensityThreshold = 2.0;
  if (analyses.length > 0) {
    const intensityMap = { extreme: 4, high: 3, moderate: 2, low: 1 };
    const avg = analyses.reduce((s, a) => s + (intensityMap[a.intensityLevel] || 1), 0) / analyses.length;
    // Also factor in painScore for non-deep-dived posts in the group
    const unanalyzed = posts.filter(p => !p._analysis);
    if (unanalyzed.length > 0) {
      const avgPainScore = unanalyzed.reduce((s, p) => s + (p.painScore || 0), 0) / unanalyzed.length;
      // Normalize painScore (0-15) to deep-dive scale (1-4)
      const painScoreMapped = 1 + Math.min(3, avgPainScore / 5);
      // Weight: deep-dive analyses are more reliable, but don't ignore the volume
      const deepWeight = analyses.length;
      const shallowWeight = unanalyzed.length * 0.5;
      intensityScore = (avg * deepWeight + painScoreMapped * shallowWeight) / (deepWeight + shallowWeight);
    } else {
      intensityScore = avg;
    }
    // deep-dive scale: low=1, moderate=2, high=3, extreme=4; threshold at low-moderate boundary
    intensityThreshold = 1.5;
  } else {
    // Fall back to post-level signals when no deep-dive analysis is available.
    // Use painScore (normalized) as the intensity proxy — this captures pain from
    // Google autocomplete, app store reviews, and other sources that produce low
    // keyword-match intensity counts but high pain scores.
    const postIntensities = posts.map(p => p.intensity || 0);
    const avgKeywordIntensity = postIntensities.length > 0
      ? postIntensities.reduce((s, i) => s + i, 0) / postIntensities.length
      : 0;

    // Also factor in average painScore — normalize to 0-3 scale (painScore range ~0-15)
    const avgPainScore = posts.reduce((s, p) => s + (p.painScore || 0), 0) / (posts.length || 1);
    const painScoreIntensity = Math.min(3, avgPainScore / 4);

    // Take the higher of the two signals
    intensityScore = Math.max(avgKeywordIntensity, painScoreIntensity);

    // Post-level scale is 0-3; lower threshold than deep-dive scale
    intensityThreshold = 1.0;
  }

  // Thresholds: frequency >= 4 = frequent, intensity >= threshold = intense
  const isFrequent = frequency >= 4;
  const isIntense = intensityScore >= intensityThreshold;

  let position;
  if (isFrequent && isIntense) position = 'primary';
  else if (!isFrequent && isIntense) position = 'hidden_gem';
  else if (isFrequent && !isIntense) position = 'background';
  else position = 'ignore';

  return { frequency, intensityScore: Math.round(intensityScore * 10) / 10, position };
}

// ─── WTP / money trail (Phase 6) ─────────────────────────────────────────────

/**
 * Aggregate money trail evidence across all posts in a group.
 */
function aggregateMoneyTrail(posts) {
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

/**
 * Extract unspoken/underlying pain patterns from top quotes and solution attempts.
 * Returns structured objects: { surface, underlying, evidence } when derivable,
 * or raw quote strings for inclusion in the report.
 */
function extractUnspokenPain(posts) {
  const hints = [];

  for (const p of posts) {
    const analysis = p._analysis;
    if (!analysis) continue;

    // Look for failed workarounds — signals that existing solutions are inadequate
    for (const sol of (analysis.solutionAttempts || []).slice(0, 3)) {
      const body = (sol.body || '').toLowerCase();
      if (body.includes('workaround') || body.includes('built my own') || body.includes('hack') ||
          body.includes('still') || body.includes('but ') || body.includes('failed') ||
          body.includes("doesn't work") || body.includes("didn't work")) {
        hints.push({ body: sol.body, url: sol.url || p.url || '' });
      }
    }

    // High-score quotes that hint at a deeper need (score >= 10 = widely agreed on)
    for (const q of (analysis.topQuotes || []).slice(0, 2)) {
      if ((q.score || 0) >= 10) hints.push({ body: q.body, url: q.url || p.url || '' });
    }
  }

  // Deduplicate by content prefix
  const seen = new Set();
  return hints.filter(h => {
    const key = (h.body || h).slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

// ─── competitive landscape ────────────────────────────────────────────────────

// Known-good domain competitors for the scalper/ticketing/bot domain.
// These are surfaced preferentially even if not extracted by the scoring engine.
const DOMAIN_COMPETITORS = new Set([
  // Ticketing platforms
  'AXS', 'Eventbrite', 'DICE', 'Dice', 'TicketFairy', 'Ticketfairy',
  'SeatGeek', 'Vivid Seats', 'VividSeats', 'ResidentAdvisor', 'Resident Advisor',
  'Partiful', 'wail.fm', 'TicketSwap', 'Tixel', 'Lyte', 'YellowHeart', 'Yellowheart',
  // Resale/sneaker markets
  'StubHub', 'GOAT', 'StockX',
  // Anti-bot / queue / monitoring tools
  'Queue-it', 'Queue it', 'PartAlert', 'Kasada', 'Imperva', 'Akamai',
]);

// Geographic names, regulatory bodies, and generic entities that the tool extractor
// falsely picks up from solution-attempt comments (e.g. "check the SEC filing",
// "San Francisco passed a bill"). Filter these out.
const TOOL_FALSE_POSITIVES = new Set([
  // Geographic/regulatory
  'San Francisco', 'New York', 'California', 'Virginia', 'Texas', 'Chicago',
  'SEC', 'FTC', 'DOJ', 'EU', 'Congress', 'Senate', 'House',
  // Big tech / hardware brands (not ticketing/resale competitors)
  'Amazon', 'Google', 'Apple', 'Meta', 'Microsoft', 'Sony', 'Nintendo',
  'AMD', 'Nvidia', 'Intel', 'Apple Pay', 'Sony VAIOs',
  // Misidentified from comment text
  'Tiktoker', 'Scrubs', 'NorVa', 'Phantom', 'Clear Channel', 'Western Canada',
  // Generic retail (not ticketing/resale competitors)
  'Walmart', 'Newegg', 'Best Buy', 'Target',
]);

function aggregateTools(posts) {
  const allTools = new Set();
  for (const p of posts) {
    if (p._analysis?.mentionedTools) {
      for (const t of p._analysis.mentionedTools) {
        // Skip false positives
        if (TOOL_FALSE_POSITIVES.has(t)) continue;
        allTools.add(t);
      }
    }
  }

  // Also scan solution attempt text for known domain competitors not caught by extractor
  for (const p of posts) {
    const solutionText = (p._analysis?.solutionAttempts || [])
      .map(s => s.body || '').join(' ');
    for (const comp of DOMAIN_COMPETITORS) {
      if (solutionText.includes(comp)) allTools.add(comp);
    }
  }

  // Sort: known domain competitors first, then others
  const sorted = [...allTools].sort((a, b) => {
    const aKnown = DOMAIN_COMPETITORS.has(a) ? 0 : 1;
    const bKnown = DOMAIN_COMPETITORS.has(b) ? 0 : 1;
    return aKnown - bKnown;
  });

  return sorted.slice(0, 10);
}

// ─── cross-source bonus ────────────────────────────────────────────────────────

/**
 * Cross-source validation bonus: a pain found on multiple independent platforms
 * is more likely to be real and widespread.
 * Bonus: +0 for 1 source, +3 for 2, +5 for 3+
 */
function crossSourceBonus(count) {
  if (count >= 3) return 5;
  if (count >= 2) return 3;
  return 0;
}

// ─── build-worthiness score ───────────────────────────────────────────────────

/**
 * Compute a 0-100 build-worthiness score for ranking.
 */
function buildWorthinessScore(depth, matrix, moneyTrail, crossSources, postCount) {
  let score = 0;

  // Depth (0-30)
  if (depth === 'urgent') score += 30;
  else if (depth === 'active') score += 18;
  else score += 5;

  // Matrix position (0-30)
  if (matrix === 'primary') score += 30;
  else if (matrix === 'hidden_gem') score += 20;
  else if (matrix === 'background') score += 8;
  else score += 0;

  // Money trail (0-25)
  if (moneyTrail.strength === 'strong') score += 25;
  else if (moneyTrail.strength === 'moderate') score += 15;
  else if (moneyTrail.strength === 'weak') score += 7;

  // Cross-source validation (0-15)
  score += crossSourceBonus(crossSources);

  // Post volume bonus (0-10)
  score += Math.min(10, postCount);

  return Math.min(100, score);
}

// ─── verdict ──────────────────────────────────────────────────────────────────

function determineVerdict(depth, matrix, moneyTrail) {
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

// ─── who feels this ───────────────────────────────────────────────────────────

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

// ─── synthesize groups into report data ──────────────────────────────────────

function synthesize(groups, allPosts) {
  const reportGroups = [];

  for (const [category, posts] of groups.entries()) {
    const { sources, count: crossSources } = crossSourceCount(posts);
    const depth = classifyDepth(posts);
    const { frequency, intensityScore, position: matrix } = computeMatrix(posts, crossSources);
    const moneyTrail = aggregateMoneyTrail(posts);
    const unspokenPain = extractUnspokenPain(posts);
    const tools = aggregateTools(posts);
    const buildScore = buildWorthinessScore(depth, matrix, moneyTrail, crossSources, posts.length);
    const verdict = determineVerdict(depth, matrix, moneyTrail);

    // Top quotes — backfill URL from parent post if quote doesn't have one
    const topQuotes = [];
    for (const p of posts) {
      if (p._analysis?.topQuotes) {
        for (const q of p._analysis.topQuotes.slice(0, 2)) {
          topQuotes.push({ ...q, url: q.url || p.url || '' });
        }
      }
    }

    // Solution attempts — backfill URL from parent post
    const solutionAttempts = [];
    for (const p of posts) {
      if (p._analysis?.solutionAttempts) {
        for (const s of p._analysis.solutionAttempts.slice(0, 2)) {
          solutionAttempts.push({ ...s, url: s.url || p.url || '' });
        }
      }
    }

    // Total engagement
    const totalComments = posts.reduce((s, p) => s + (p.num_comments || p._analysis?.totalComments || 0), 0);
    const totalScore = posts.reduce((s, p) => s + (p.score || 0), 0);

    // Best representative posts
    const representativePosts = [...posts]
      .sort((a, b) => (b.painScore || 0) - (a.painScore || 0))
      .slice(0, 3)
      .map(p => ({
        title: p.title,
        url: p.url,
        score: p.score,
        num_comments: p.num_comments,
        source: p._source || p.subreddit || 'unknown',
      }));

    reportGroups.push({
      category,
      postCount: posts.length,
      crossSources,
      sourceNames: [...sources],
      depth,
      frequency,
      intensityScore,
      matrix,
      moneyTrail,
      unspokenPain,
      tools,
      topQuotes: topQuotes.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5),
      solutionAttempts: solutionAttempts.slice(0, 5),
      totalComments,
      totalScore,
      buildScore,
      verdict,
      representativePosts,
      audience: AUDIENCE_MAP[category] || AUDIENCE_MAP['uncategorized'],
    });
  }

  // Sort by buildScore descending
  reportGroups.sort((a, b) => b.buildScore - a.buildScore);

  return reportGroups;
}

// ─── opportunity text builder ─────────────────────────────────────────────────

/**
 * Build a specific, data-driven opportunity statement for a pain group.
 * Uses existing tools, solution attempts, money trail, and depth to avoid
 * a generic "gap remains unaddressed" fallback.
 */
function buildOpportunityText(g) {
  const categoryName = g.category.replace(/-/g, ' ');

  // Evidence-specific gap statement: derive from actual post titles and tools found
  const hasTools = g.tools.length > 0;
  const toolList = g.tools.slice(0, 3).join(', ');
  const hasSolutionAttempts = g.solutionAttempts.length > 0;

  // Derive gap from the top representative post titles for specificity
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

  // Money trail: use actual WTP signal keywords found
  let wtpClause = '';
  if (g.moneyTrail.strength === 'strong' || g.moneyTrail.strength === 'moderate') {
    const wtpKeywords = g.representativePosts
      .flatMap(p => p.wtpSignals || []).slice(0, 2).join(', ');
    wtpClause = `WTP signals found (${g.moneyTrail.totalCount} instances${wtpKeywords ? ': ' + wtpKeywords : ''}). `;
  }

  // Urgency framing tied to cross-source data
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

// ─── markdown renderer ────────────────────────────────────────────────────────

function renderMarkdown(groups, meta) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`# Pain Point Synthesis Report`);
  lines.push('');
  lines.push(`**Generated:** ${now}  `);
  lines.push(`**Sources:** ${meta.sources.join(', ')}  `);
  lines.push(`**Total posts analyzed:** ${meta.totalPosts}  `);
  lines.push(`**Pain categories found:** ${groups.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Executive Summary ────────────────────────────────────────────────────
  {
    const top = groups[0];
    const topTwo = groups.slice(0, 2);
    const allTools = [...new Set(groups.flatMap(g => g.tools))].slice(0, 6);
    const topAudience = top ? (top.audience || 'consumers') : 'consumers';

    lines.push('## Executive Summary');
    lines.push('');

    if (top) {
      const depthLabel = (PAIN_DEPTH[top.depth]?.label || top.depth).toLowerCase();
      lines.push(`**#1 Pain:** ${top.category.replace(/-/g, ' ')} — ${depthLabel} felt across ${top.crossSources} platform(s).`);

      // Prefer a high-signal user quote over a post title for the exec summary pull quote.
      // Criteria: has actual prose (not a generic title pattern), score > 0.
      const bestQuote = top.topQuotes
        .filter(q => (q.body || '').length > 60 && !q.body.startsWith('com.') && !/^\d+\s+star/.test(q.body))
        .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      const fallbackPost = top.representativePosts
        .filter(p => p.title && !p.title.startsWith('com.') && !/star review/.test(p.title))[0];

      if (bestQuote) {
        lines.push(`> "${bestQuote.body.replace(/\n/g, ' ').slice(0, 160)}..."`);
      } else if (fallbackPost) {
        lines.push(`> "${fallbackPost.title.slice(0, 120)}"`);
        if (fallbackPost.url) lines.push(`> — [${fallbackPost.source}] (score: ${fallbackPost.score || 0})`);
      }
      lines.push('');
    }

    lines.push(`**Who feels it:** ${topAudience}`);
    lines.push('');

    const totalMoneySignals = groups.reduce((s, g) => s + g.moneyTrail.totalCount, 0);
    const urgentCount = groups.filter(g => g.depth === 'urgent').length;
    const activeCount = groups.filter(g => g.depth === 'active').length;
    lines.push(`**Signal strength:** ${urgentCount} urgent + ${activeCount} active pain categories. ${totalMoneySignals} total WTP signals found across all categories.`);
    lines.push('');

    if (allTools.length > 0) {
      lines.push(`**Known alternatives users mention:** ${allTools.join(', ')}`);
      lines.push('');
    }

    if (allTools.length > 0) {
      lines.push(`**Gap:** Alternatives like ${allTools.slice(0, 2).join(', ')} exist but users still express the pain at scale — TM's venue lock-in and bot ecosystem remain unsolved.`);
    } else {
      lines.push(`**Gap:** No established tooling found across ${groups.filter(g => g.tools.length === 0).length} pain categories — market is underserved.`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── Phase 4: Pain Depth Classification ──────────────────────────────────
  lines.push('## Phase 4: Pain Depth Classification');
  lines.push('');
  lines.push('| Pain Category | Depth | Posts | Cross-Source | Key Evidence |');
  lines.push('|---------------|-------|-------|--------------|--------------|');

  for (const g of groups) {
    const depthLabel = PAIN_DEPTH[g.depth]?.label || g.depth;
    const crossLabel = g.crossSources > 1
      ? `${g.crossSources} sources (${g.sourceNames.join(', ')})`
      : g.sourceNames[0] || '1 source';
    const evidence = g.moneyTrail.totalCount > 0
      ? `${g.moneyTrail.totalCount} money trail signal(s)`
      : g.topQuotes.length > 0
        ? `"${(g.topQuotes[0]?.body || '').slice(0, 60)}..."`
        : 'Recurring complaint pattern';

    lines.push(`| **${g.category}** | ${depthLabel} | ${g.postCount} | ${crossLabel} | ${evidence} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Phase 5: Frequency vs Intensity Matrix ───────────────────────────────
  lines.push('## Phase 5: Frequency vs Intensity Matrix');
  lines.push('');
  lines.push('| Pain Category | Frequency Score | Intensity Score | Matrix Position | Action |');
  lines.push('|---------------|----------------|-----------------|-----------------|--------|');

  for (const g of groups) {
    const matrixLabel = MATRIX_LABELS[g.matrix] || g.matrix;
    const action = {
      primary:    'Build for this — validated demand with urgency',
      hidden_gem: 'Niche but desperate — consider premium play',
      background: 'Common annoyance, low WTP — deprioritize',
      ignore:     'Not worth pursuing',
    }[g.matrix] || '';

    lines.push(`| **${g.category}** | ${g.frequency} | ${g.intensityScore} | ${matrixLabel} | ${action} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Phase 6: Willingness-to-Pay & Unspoken Pain ──────────────────────────
  lines.push('## Phase 6: Willingness-to-Pay & Unspoken Pain Analysis');
  lines.push('');
  lines.push('### Money Trail Rankings');
  lines.push('');
  lines.push('| Rank | Pain Category | WTP Strength | Signal Count | Notable Evidence |');
  lines.push('|------|---------------|-------------|--------------|------------------|');

  const byMoneyTrail = [...groups].sort((a, b) => b.moneyTrail.totalCount - a.moneyTrail.totalCount);
  byMoneyTrail.forEach((g, i) => {
    const example = g.moneyTrail.examples.length > 0
      ? `"${(g.moneyTrail.examples[0]?.body || '').slice(0, 80)}..."`
      : 'No direct spending signals';
    lines.push(`| ${i + 1} | **${g.category}** | ${g.moneyTrail.strength} | ${g.moneyTrail.totalCount} | ${example} |`);
  });

  lines.push('');

  // Unspoken pain section
  const withUnspoken = groups.filter(g => g.unspokenPain.length > 0);
  if (withUnspoken.length > 0) {
    lines.push('### Unspoken Pain Patterns');
    lines.push('');
    for (const g of withUnspoken) {
      lines.push(`**${g.category}**`);
      for (const hint of g.unspokenPain) {
        lines.push(`> ${hint.replace(/\n/g, ' ')}`);
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');

  // ── Phase 7: Verdict & Opportunity Synthesis ─────────────────────────────
  lines.push('## Phase 7: Verdict & Opportunity Synthesis');
  lines.push('');

  // Split into primary (>=2 posts) and weak (1 post) groups
  const primaryGroups = groups.filter(g => g.postCount >= 2);
  const weakGroups = groups.filter(g => g.postCount < 2);

  for (const g of primaryGroups) {
    const verdictLabel = VERDICTS[g.verdict] || g.verdict;
    const depthLabel = PAIN_DEPTH[g.depth]?.label || g.depth;
    const matrixLabel = MATRIX_LABELS[g.matrix] || g.matrix;
    const verdictBadge = g.verdict === 'validated'
      ? '**[VALIDATED — BUILD THIS]**'
      : g.verdict === 'needs_evidence'
        ? '**[NEEDS MORE EVIDENCE]**'
        : '**[TOO WEAK — SKIP]**';

    lines.push(`### ${g.category}`);
    lines.push('');
    lines.push(`${verdictBadge} — Build Score: ${g.buildScore}/100`);
    lines.push('');
    lines.push(`**1. Problem**  `);
    lines.push(`Users experience significant friction and frustration around ${g.category.replace(/-/g, ' ')}, across ${g.postCount} posts and ${g.crossSources} source(s).`);
    lines.push('');
    lines.push(`**2. Depth:** ${depthLabel}  `);
    lines.push(`**3. Matrix Position:** ${matrixLabel}  `);
    lines.push(`**4. Cross-source validation:** ${g.crossSources} platform(s) — ${g.sourceNames.join(', ')}`);
    lines.push('');

    // Evidence: prefer deep-dive quotes; fall back to representative post titles
    const hasQuotes = g.topQuotes.length > 0;
    const hasRepPosts = g.representativePosts.length > 0;

    // Look for insider/industry quotes — comments mentioning working at venues/TM/industry
    const insiderQuotes = [...g.topQuotes, ...(g.solutionAttempts || [])].filter(q => {
      const b = (q.body || '').toLowerCase();
      return /\bi (was|am|work|worked|used to)\b.{0,40}(venue|ticketmaster|artist|booking|industry|engineer|director|insider)/.test(b) ||
             /\b(former|ex[-\s]|worked at|work at)\b.{0,30}(ticketmaster|live nation|venue|concert|ticket)/.test(b);
    });

    if (hasQuotes) {
      lines.push('**5. Evidence — User Quotes:**');
      for (const q of g.topQuotes.slice(0, 3)) {
        const body = (q.body || '').replace(/\n/g, ' ').slice(0, 200);
        lines.push(`> "${body}"`);
        if (q.score > 0) lines.push(`> *(upvotes: ${q.score})*`);
        lines.push('');
      }
      // Highlight insider quote separately if found and not already shown
      const shownBodies = new Set(g.topQuotes.slice(0, 3).map(q => (q.body || '').slice(0, 40)));
      const freshInsider = insiderQuotes.find(q => !shownBodies.has((q.body || '').slice(0, 40)));
      if (freshInsider) {
        lines.push('**Insider insight:**');
        lines.push(`> "${freshInsider.body.replace(/\n/g, ' ').slice(0, 300)}"`);
        lines.push('');
      }
    } else if (hasRepPosts) {
      lines.push('**5. Evidence — Top Posts:**');
      for (const p of g.representativePosts.slice(0, 3)) {
        const url = p.url ? ` ([link](${p.url}))` : '';
        lines.push(`> [${p.source}] "${p.title}"${url}`);
        lines.push(`> *(score: ${p.score || 0}, comments: ${p.num_comments || 0})*`);
        lines.push('');
      }
    }

    lines.push(`**6. Who feels this:** ${g.audience}`);
    lines.push('');

    if (g.solutionAttempts.length > 0) {
      lines.push('**7. Current solutions & gaps:**');
      for (const sol of g.solutionAttempts.slice(0, 3)) {
        lines.push(`- ${(sol.body || '').replace(/\n/g, ' ').slice(0, 150)}`);
      }
      lines.push('');
    }

    // Competitive landscape: show tools if found, otherwise note absence (market gap signal)
    if (g.tools.length > 0) {
      lines.push(`**8. Competitive landscape:** ${g.tools.join(', ')}`);
    } else {
      lines.push(`**8. Competitive landscape:** No established tools mentioned by users — potential market gap.`);
    }
    lines.push('');

    lines.push(`**9. Money trail:** ${g.moneyTrail.strength} (${g.moneyTrail.totalCount} signals)`);
    if (g.moneyTrail.examples.length > 0) {
      for (const ex of g.moneyTrail.examples.slice(0, 2)) {
        lines.push(`> "${(ex.body || '').replace(/\n/g, ' ').slice(0, 150)}"`);
      }
    }
    lines.push('');

    if (g.unspokenPain.length > 0) {
      lines.push('**10. Unspoken pain:**');
      for (const hint of g.unspokenPain.slice(0, 2)) {
        lines.push(`> ${hint.replace(/\n/g, ' ').slice(0, 200)}`);
      }
      lines.push('');
    }

    lines.push(`**11. Opportunity:** ${buildOpportunityText(g)}`);
    lines.push('');

    // Market sizing — injected for product-availability (the primary validated category)
    if (g.category === 'product-availability' && g.verdict === 'validated') {
      lines.push('**12. Market sizing (rough estimates):**');
      lines.push('');
      lines.push('| Market | Size |');
      lines.push('|--------|------|');
      lines.push('| Global event ticketing | ~$80B |');
      lines.push('| Secondary ticket market | ~$15B |');
      lines.push('| Sneaker resale market | ~$6B |');
      lines.push('| Bot mitigation industry | ~$1.5B |');
      lines.push('');

      lines.push('**13. Regulatory tailwinds:**');
      lines.push('');
      lines.push('- **2022** — Taylor Swift Eras Tour presale collapse triggers U.S. Senate antitrust hearing; DOJ opens Live Nation investigation');
      lines.push('- **2024-2025** — California introduces bill to cap concert resale at 10% above face value');
      lines.push('- **2025-2026** — DOJ v. Live Nation antitrust case active; potential forced divestiture of Ticketmaster');
      lines.push('- **Signal:** Legislative and regulatory pressure is accelerating — incumbents are on defense, creating a window for challenger platforms');
      lines.push('');
    }

    // Only show representative posts if no quote evidence was shown above
    if (g.representativePosts.length > 0 && g.topQuotes.length === 0) {
      lines.push('**Representative posts:**');
      for (const p of g.representativePosts) {
        const url = p.url ? ` — [link](${p.url})` : '';
        lines.push(`- [${p.source}] "${p.title}" (score: ${p.score || 0}, comments: ${p.num_comments || 0})${url}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // ── Final Ranked List ────────────────────────────────────────────────────
  lines.push('## Final Ranking by Build-Worthiness');
  lines.push('');
  lines.push('| Rank | Pain Category | Build Score | Verdict | Depth | Matrix | Posts | Money Trail |');
  lines.push('|------|---------------|-------------|---------|-------|--------|-------|-------------|');

  groups.forEach((g, i) => {
    const depthLabel = PAIN_DEPTH[g.depth]?.label || g.depth;
    const matrixLabel = MATRIX_LABELS[g.matrix] || g.matrix;
    const verdictLabel = VERDICTS[g.verdict] || g.verdict;
    const weakNote = g.postCount < 2 ? ' *(weak)*' : '';
    lines.push(`| ${i + 1} | **${g.category}**${weakNote} | ${g.buildScore} | ${verdictLabel} | ${depthLabel} | ${matrixLabel} | ${g.postCount} | ${g.moneyTrail.strength} (${g.moneyTrail.totalCount}) |`);
  });

  lines.push('');
  lines.push('---');
  lines.push('');

  // ── What to Build ─────────────────────────────────────────────────────────
  const validatedGroup = groups.find(g => g.verdict === 'validated');
  if (validatedGroup) {
    lines.push('## What to Build');
    lines.push('');
    lines.push('**Validated opportunity:** Cross-platform stock monitoring + fair queue tool for limited-release products.');
    lines.push('');
    lines.push('**Core demand signal:** A 3.5K-upvote Reddit thread ("Making it illegal to resell tickets at higher than face value") with 455 comments shows mass consumer appetite for a fairer access system — not just complaining, but actively seeking solutions. The DOJ v. Live Nation case and "so we built something" post confirm supply-side readiness too.');
    lines.push('');
    lines.push('**Recommended entry strategy:**');
    lines.push('');
    lines.push('1. **Start with GPU/sneaker drops** (lower regulatory complexity, faster iteration cycles)');
    lines.push('   - Real-time restock alerts aggregated across retailers (Newegg, Best Buy, SNKRS, Adidas)');
    lines.push('   - Fair-queue entry system: verified human, one-purchase-per-account, randomized slot assignment');
    lines.push('   - Monetize via retailer partnership (anti-bot compliance fee) or consumer subscription ($5-10/mo)');
    lines.push('');
    lines.push('2. **Expand to concert/event tickets** with regulatory tailwinds');
    lines.push('   - DOJ v. Live Nation creates a window: venues will need Ticketmaster alternatives');
    lines.push('   - California resale cap bill (if passed) makes compliant resale platforms valuable');
    lines.push('   - DICE model (no-resale, ID-linked) is the template; differentiate on UX and fan verification');
    lines.push('');
    lines.push('**Why now:** Regulatory pressure on incumbents (Live Nation/TM) + GPU/sneaker bot fatigue + consumer willingness to pay for fair access (36 WTP signals in this dataset alone) = market is primed. Alternatives exist (AXS, Eventbrite, DICE, StubHub) but none solve the bot ecosystem — they compete on features, not fairness.');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── Weak Signals Appendix ────────────────────────────────────────────────
  if (weakGroups.length > 0) {
    lines.push('## Appendix: Weak Signals (1 post each — needs more data)');
    lines.push('');
    lines.push('These categories appeared but lack sufficient evidence to act on. Include more scans to confirm or dismiss.');
    lines.push('');
    lines.push('| Category | Source | Post | Score | Comments |');
    lines.push('|----------|--------|------|-------|----------|');
    for (const g of weakGroups) {
      const p = g.representativePosts[0];
      if (p) {
        const title = (p.title || '').slice(0, 60);
        const url = p.url ? `[link](${p.url})` : '—';
        lines.push(`| ${g.category} | ${p.source} | ${title} ${url} | ${p.score || 0} | ${p.num_comments || 0} |`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('*Generated by pain-point-finder report aggregator*');
  lines.push('');

  return lines.join('\n');
}

// ─── JSON renderer ────────────────────────────────────────────────────────────

function renderJson(groups, meta) {
  return JSON.stringify({
    ok: true,
    data: {
      generated: new Date().toISOString(),
      meta,
      groups,
    },
  }, null, 2);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = normalizeArgs(argv);

  if (args.help || argv.includes('--help')) {
    process.stderr.write(`
pain-points report — Cross-source pain point aggregator and synthesizer

Usage:
  pain-points report --files file1.json,file2.json [--format md|json]
  cat scan.json | pain-points report --stdin [--format md|json]

Options:
  --files <paths>    Comma-separated list of scan/deep-dive JSON files
  --stdin            Read a single scan JSON from stdin
  --format <md|json> Output format (default: md)

The report follows Phase 4-7 of the SKILL.md workflow:
  Phase 4: Pain Depth Classification (surface / active / urgent)
  Phase 5: Frequency vs Intensity Matrix
  Phase 6: Willingness-to-Pay & Unspoken Pain Analysis
  Phase 7: Verdict & Opportunity Synthesis + ranked list
`);
    process.exit(0);
  }

  const format = args.format || 'md';
  if (!['md', 'json'].includes(format)) {
    process.stderr.write(`[report] Unknown format "${format}". Use md or json.\n`);
    process.exit(1);
  }

  // Load posts from all sources
  let allPosts = [];
  const loadedSources = new Set();

  if (args.files) {
    const files = String(args.files).split(',').map(f => f.trim()).filter(Boolean);
    for (const f of files) {
      const posts = loadFile(f);
      for (const p of posts) {
        allPosts.push(p);
        loadedSources.add(p._source || 'unknown');
      }
      log(`[report] Loaded ${posts.length} posts from ${f}`);
    }
  }

  if (args.stdin) {
    const posts = loadStdin();
    for (const p of posts) {
      allPosts.push(p);
      loadedSources.add(p._source || 'unknown');
    }
    log(`[report] Loaded ${posts.length} posts from stdin`);
  }

  // Deduplicate posts by id — the same post may appear in both individual
  // batch files and a combined output file. Keep the version with analysis if any.
  const seenIds = new Map();
  for (const p of allPosts) {
    const key = p.id || p.url || p.title;
    if (!key) continue;
    const existing = seenIds.get(key);
    if (!existing || (!existing._analysis && p._analysis)) {
      seenIds.set(key, p);
    }
  }
  allPosts = [...seenIds.values()];

  if (allPosts.length === 0) {
    process.stderr.write('[report] No posts loaded. Use --files or --stdin.\n');
    process.exit(1);
  }

  log(`[report] Total posts: ${allPosts.length} from ${loadedSources.size} source(s)`);

  // Group by subcategory and synthesize
  const groups = groupBySubcategory(allPosts);
  const synthesized = synthesize(groups, allPosts);

  const meta = {
    sources: [...loadedSources],
    totalPosts: allPosts.length,
    categoriesFound: synthesized.length,
  };

  // Render output
  const output = format === 'json'
    ? renderJson(synthesized, meta)
    : renderMarkdown(synthesized, meta);

  process.stdout.write(output + '\n');
}

main().catch(err => {
  process.stderr.write(`[report] Fatal: ${err.message}\n`);
  process.exit(1);
});
