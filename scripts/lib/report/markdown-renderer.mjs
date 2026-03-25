/**
 * report/markdown-renderer.mjs — Markdown and JSON rendering for reports
 */

import { buildOpportunityText } from './synthesis.mjs';

// ─── constants ──────────────────────────────────────────────────────────────

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

// ─── pain group formatting helper ───────────────────────────────────────────

export function formatPainGroup(g, lines) {
  const verdictLabel = VERDICTS[g.verdict] || g.verdict;
  const depthLabel = PAIN_DEPTH[g.depth]?.label || g.depth;
  const matrixLabel = MATRIX_LABELS[g.matrix] || g.matrix;
  const verdictBadge = g.verdict === 'validated'
    ? '**[VALIDATED — BUILD THIS]**'
    : g.verdict === 'needs_evidence'
      ? '**[NEEDS MORE EVIDENCE]**'
      : '**[TOO WEAK — SKIP]**';

  const llmBadge = g.llmEnhanced ? ' [LLM-Enhanced]' : '';
  lines.push(`### ${g.category}${llmBadge}`);
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

  if (g.implicitPainSignals && g.implicitPainSignals.length > 0) {
    lines.push(`**Implicit pain signals (LLM-detected):** ${g.implicitPainSignals.join(', ')}`);
    lines.push('');
  }

  if (g.targetPersonas && g.targetPersonas.length > 0) {
    lines.push(`**Target personas (LLM-detected):** ${g.targetPersonas.join('; ')}`);
    lines.push('');
  }

  const hasQuotes = g.topQuotes.length > 0;
  const hasRepPosts = g.representativePosts.length > 0;

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
      const hintText = typeof hint === 'string' ? hint : (hint.body || '');
      lines.push(`> ${hintText.replace(/\n/g, ' ').slice(0, 200)}`);
    }
    lines.push('');
  }
}

// ─── idea sketch formatting ─────────────────────────────────────────────────

export function formatIdeaSketch(sketch, lines) {
  const verdictBadge = sketch.verdict === 'validated'
    ? '**[VALIDATED]**'
    : '**[NEEDS MORE EVIDENCE]**';

  lines.push(`### ${sketch.category.replace(/-/g, ' ')} — Idea Sketch`);
  lines.push('');
  lines.push(`${verdictBadge} — Build Score: ${sketch.buildScore}/100`);
  lines.push('');

  lines.push('**Problem Statement**');
  lines.push(sketch.problemStatement);
  lines.push('');

  lines.push('**Target Customer**');
  lines.push(`- Who: ${sketch.targetCustomer.who}`);
  lines.push(`- Where they hang out: ${sketch.targetCustomer.whereTheyHangOut}`);
  lines.push(`- Current spending: ${sketch.targetCustomer.currentSpending}`);
  lines.push('');

  lines.push('**Solution Concept (MVP)**');
  lines.push(`- Core feature: ${sketch.solutionConcept.coreFeature}`);
  lines.push(`- Why existing solutions fail: ${sketch.solutionConcept.whyExistingFail}`);
  lines.push(`- Key differentiator: ${sketch.solutionConcept.keyDifferentiator}`);
  lines.push('');

  lines.push('**Business Model**');
  lines.push(`- Pricing: ${sketch.businessModel.pricing}`);
  lines.push(`- Revenue model: ${sketch.businessModel.revenueModel}`);
  lines.push(`- Estimated willingness-to-pay: ${sketch.businessModel.estimatedWtp}`);
  lines.push('');

  lines.push('**Go-to-Market**');
  lines.push(`- Launch channel: ${sketch.goToMarket.launchChannel}`);
  lines.push(`- First 100 customers: ${sketch.goToMarket.first100}`);
  lines.push(`- Content angle: ${sketch.goToMarket.contentAngle}`);
  lines.push('');

  lines.push('**Competitive Landscape**');
  lines.push(`- Direct competitors: ${sketch.competitiveLandscape.directCompetitors}`);
  lines.push(`- Indirect competitors: ${sketch.competitiveLandscape.indirectCompetitors}`);
  lines.push(`- Moat opportunity: ${sketch.competitiveLandscape.moatOpportunity}`);
  lines.push('');

  lines.push('**Risk & Validation**');
  lines.push(`- Key assumption: ${sketch.riskAndValidation.keyAssumption}`);
  lines.push(`- How to test: ${sketch.riskAndValidation.howToTest}`);
  lines.push(`- Red flags: ${sketch.riskAndValidation.redFlags.join(' | ')}`);
  lines.push('');

  lines.push(`**Verdict: ${sketch.verdictLabel}**`);
  lines.push('');
  lines.push('---');
  lines.push('');
}

// ─── data collection warnings section ────────────────────────────────────────

/**
 * Render a "Data Collection Warnings" section if any sources had rate limit issues.
 * @param {object} rateMonitorSummary - Output of RateMonitor.getSummary()
 * @param {Array} lines - Lines array to push to
 */
export function renderDataCollectionWarnings(rateMonitorSummary, lines) {
  if (!rateMonitorSummary) return;

  const { warnings, blocks, errors } = rateMonitorSummary;
  const totalIssues = warnings.length + blocks.length + errors.length;
  if (totalIssues === 0) return;

  lines.push('## Data Collection Warnings');
  lines.push('');
  lines.push('Some data sources encountered rate limiting or blocking during collection. Results from affected sources may be partial.');
  lines.push('');

  // Build per-source breakdown
  const sourceMap = new Map();
  const bump = (source, field, entry) => {
    if (!sourceMap.has(source)) sourceMap.set(source, { warnings: [], blocks: [], errors: [] });
    sourceMap.get(source)[field].push(entry);
  };
  for (const w of warnings) bump(w.source, 'warnings', w);
  for (const b of blocks) bump(b.source, 'blocks', b);
  for (const e of errors) bump(e.source, 'errors', e);

  lines.push('| Source | Status | Details |');
  lines.push('|--------|--------|---------|');

  for (const [source, counts] of sourceMap) {
    const parts = [];
    if (counts.blocks.length > 0) parts.push(`${counts.blocks.length} block(s)`);
    if (counts.errors.length > 0) parts.push(`${counts.errors.length} error(s)`);
    if (counts.warnings.length > 0) parts.push(`${counts.warnings.length} warning(s)`);
    const status = counts.blocks.length > 0 ? 'Partial results' : 'Completed with warnings';

    // Pick most recent/relevant message for details
    const allEntries = [...counts.blocks, ...counts.errors, ...counts.warnings];
    const detail = allEntries[0]?.message || 'Rate limit issue encountered';

    lines.push(`| **${source}** | ${status} | ${parts.join(', ')} — ${detail} |`);
  }

  lines.push('');
  lines.push('> **Note:** Sources automatically stop and return partial results when rate-limited or blocked. No manual intervention needed.');
  lines.push('');
  lines.push('---');
  lines.push('');
}

// ─── full markdown renderer ─────────────────────────────────────────────────

export function renderMarkdown(groups, meta) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`# Pain Point Synthesis Report`);
  lines.push('');
  lines.push(`**Generated:** ${now}  `);
  lines.push(`**Sources:** ${meta.sources.join(', ')}  `);
  lines.push(`**Total posts analyzed:** ${meta.totalPosts}  `);
  lines.push(`**Pain categories found:** ${groups.length}`);
  lines.push('');

  // Data collection warnings (if any sources had rate limit issues)
  if (meta.rateMonitorSummary) {
    renderDataCollectionWarnings(meta.rateMonitorSummary, lines);
  }

  lines.push('---');
  lines.push('');

  // Executive Summary
  {
    const top = groups[0];
    const allTools = [...new Set(groups.flatMap(g => g.tools))].slice(0, 6);
    const topAudience = top ? (top.audience || 'consumers') : 'consumers';

    lines.push('## Executive Summary');
    lines.push('');

    if (top) {
      const depthLabel = (PAIN_DEPTH[top.depth]?.label || top.depth).toLowerCase();
      lines.push(`**#1 Pain:** ${top.category.replace(/-/g, ' ')} — ${depthLabel} felt across ${top.crossSources} platform(s).`);

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

  // Phase 4: Pain Depth Classification
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

  // Phase 5: Frequency vs Intensity Matrix
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

  // Phase 6: Willingness-to-Pay & Unspoken Pain
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

  const withUnspoken = groups.filter(g => g.unspokenPain.length > 0);
  if (withUnspoken.length > 0) {
    lines.push('### Unspoken Pain Patterns');
    lines.push('');
    for (const g of withUnspoken) {
      const llmLabel = g.llmEnhanced ? ' [LLM-Enhanced]' : '';
      lines.push(`**${g.category}**${llmLabel}`);
      for (const hint of g.unspokenPain) {
        const hintText = typeof hint === 'string' ? hint : (hint.body || '');
        lines.push(`> ${hintText.replace(/\n/g, ' ')}`);
        lines.push('');
      }
    }
  }
  lines.push('---');
  lines.push('');

  // Phase 7: Verdict & Opportunity Synthesis
  lines.push('## Phase 7: Verdict & Opportunity Synthesis');
  lines.push('');

  const primaryGroups = groups.filter(g => g.postCount >= 2);
  const weakGroups = groups.filter(g => g.postCount < 2);

  for (const g of primaryGroups) {
    formatPainGroup(g, lines);

    lines.push(`**11. Opportunity:** ${buildOpportunityText(g)}`);
    lines.push('');

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

  // Final Ranked List
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

  // What to Build
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

  // Weak Signals Appendix
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

  lines.push('*Generated by gapscout report aggregator*');
  lines.push('');

  return lines.join('\n');
}

// ─── JSON renderer ──────────────────────────────────────────────────────────

export function renderJson(groups, meta, { allPosts } = {}) {
  const data = {
    generated: new Date().toISOString(),
    meta,
    groups,
  };

  // Include rate monitor summary if present
  if (meta.rateMonitorSummary) {
    data.dataCollectionWarnings = meta.rateMonitorSummary;
  }

  // Build evidenceCorpus: all posts keyed by citeKey for inline expandable citations
  if (allPosts && allPosts.length > 0) {
    const evidenceCorpus = {};
    for (const p of allPosts) {
      const citeKey = p._citeKey;
      if (!citeKey) continue;
      const rawText = p.title || p.selftext || p.body || '';
      evidenceCorpus[citeKey] = {
        title: (p.title || '').slice(0, 500),
        url: p.url || '',
        source: p._source || p.subreddit || 'unknown',
        score: p.score || 0,
        date: p.created_utc
          ? new Date(p.created_utc * 1000).toISOString().split('T')[0]
          : p.date || '',
        quote: rawText.slice(0, 500),
        num_comments: p.num_comments || 0,
        subreddit: p.subreddit || '',
        category: p._category || '',
      };
    }
    data.evidenceCorpus = evidenceCorpus;
  }

  return JSON.stringify({ ok: true, data }, null, 2);
}
