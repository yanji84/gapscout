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
  const source = data?.source || 'unknown';
  const posts = [];

  // Scan output: { posts: [...] }
  if (Array.isArray(data?.posts)) {
    for (const p of data.posts) {
      posts.push({ ...p, _source: source, _file: filePath });
    }
  }

  // Deep-dive output: { results: [{ post, analysis }] }
  if (Array.isArray(data?.results)) {
    for (const r of data.results) {
      if (r.post) {
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
    const source = data?.source || 'stdin';
    const posts = [];
    if (Array.isArray(data?.posts)) {
      for (const p of data.posts) posts.push({ ...p, _source: source, _file: 'stdin' });
    }
    if (Array.isArray(data?.results)) {
      for (const r of data.results) {
        if (r.post) posts.push({ ...r.post, _analysis: r.analysis, _source: source, _file: 'stdin' });
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
 * Group posts by their painSubcategories.
 * A post with multiple subcategories appears in each group.
 * Posts with no subcategories go into an 'uncategorized' group.
 */
function groupBySubcategory(posts) {
  const groups = new Map();

  for (const post of posts) {
    const subcats = post.painSubcategories || [];
    const targets = subcats.length > 0 ? subcats : ['uncategorized'];
    for (const cat of targets) {
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(post);
    }
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
    intensityScore = avg;
    // deep-dive scale: low=1, moderate=2, high=3, extreme=4; threshold at moderate
    intensityThreshold = 2.0;
  } else {
    // Fall back to post-level intensity field (0-3 count of intensity keyword matches)
    const postIntensities = posts.map(p => p.intensity || 0);
    if (postIntensities.length > 0) {
      intensityScore = postIntensities.reduce((s, i) => s + i, 0) / postIntensities.length;
    }
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
      trails.push(...p._analysis.moneyTrail.slice(0, 2));
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
        hints.push(sol.body);
      }
    }

    // High-score quotes that hint at a deeper need (score >= 10 = widely agreed on)
    for (const q of (analysis.topQuotes || []).slice(0, 2)) {
      if ((q.score || 0) >= 10) hints.push(q.body);
    }
  }

  // Deduplicate by content prefix
  const seen = new Set();
  return hints.filter(h => {
    const key = h.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

// ─── competitive landscape ────────────────────────────────────────────────────

function aggregateTools(posts) {
  const allTools = new Set();
  for (const p of posts) {
    if (p._analysis?.mentionedTools) {
      for (const t of p._analysis.mentionedTools) allTools.add(t);
    }
  }
  return [...allTools].slice(0, 10);
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

    // Top quotes
    const topQuotes = [];
    for (const p of posts) {
      if (p._analysis?.topQuotes) topQuotes.push(...p._analysis.topQuotes.slice(0, 2));
    }

    // Solution attempts
    const solutionAttempts = [];
    for (const p of posts) {
      if (p._analysis?.solutionAttempts) solutionAttempts.push(...p._analysis.solutionAttempts.slice(0, 2));
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
      topQuotes: topQuotes.slice(0, 5),
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

  // Identify the gap from failed solution attempts
  const hasSolutionAttempts = g.solutionAttempts.length > 0;
  const hasTools = g.tools.length > 0;
  const toolList = g.tools.slice(0, 3).join(', ');

  let gapClause = '';
  if (hasSolutionAttempts) {
    const firstAttempt = (g.solutionAttempts[0]?.body || '').replace(/\n/g, ' ').slice(0, 100);
    gapClause = `Existing attempts (e.g., "${firstAttempt}...") fall short. `;
  } else if (hasTools) {
    gapClause = `Despite tools like ${toolList} being available, users still express the pain — suggesting a quality or accessibility gap. `;
  }

  // Money trail signal
  let wtpClause = '';
  if (g.moneyTrail.strength === 'strong' || g.moneyTrail.strength === 'moderate') {
    wtpClause = `Users are already spending money on workarounds (${g.moneyTrail.totalCount} signals), indicating real WTP. `;
  }

  // Urgency framing
  let urgencyClause = '';
  if (g.depth === 'urgent') {
    urgencyClause = `This is an urgent, unresolved pain — users need a better solution now.`;
  } else if (g.depth === 'active') {
    urgencyClause = `Users are actively seeking solutions; first-mover with a focused product could capture this segment.`;
  } else {
    urgencyClause = `Low urgency — validate further before building.`;
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

  for (const g of groups) {
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

    if (g.topQuotes.length > 0) {
      lines.push('**5. Evidence — Top Quotes:**');
      for (const q of g.topQuotes.slice(0, 3)) {
        lines.push(`> "${(q.body || '').replace(/\n/g, ' ').slice(0, 200)}"`);
        lines.push(`> — score: ${q.score || 0}`);
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

    if (g.tools.length > 0) {
      lines.push(`**8. Competitive landscape:** ${g.tools.join(', ')}`);
      lines.push('');
    }

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

    if (g.representativePosts.length > 0) {
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
  lines.push('| Rank | Pain Category | Build Score | Verdict | Depth | Matrix | Money Trail |');
  lines.push('|------|---------------|-------------|---------|-------|--------|-------------|');

  groups.forEach((g, i) => {
    const depthLabel = PAIN_DEPTH[g.depth]?.label || g.depth;
    const matrixLabel = MATRIX_LABELS[g.matrix] || g.matrix;
    const verdictLabel = VERDICTS[g.verdict] || g.verdict;
    lines.push(`| ${i + 1} | **${g.category}** | ${g.buildScore} | ${verdictLabel} | ${depthLabel} | ${matrixLabel} | ${g.moneyTrail.strength} (${g.moneyTrail.totalCount}) |`);
  });

  lines.push('');
  lines.push('---');
  lines.push('');
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
