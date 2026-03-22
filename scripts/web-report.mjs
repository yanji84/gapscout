#!/usr/bin/env node

/**
 * web-report.mjs — Beautiful self-contained HTML report generator
 *
 * Usage:
 *   pain-points web-report --input report.json --output report.html
 *   pain-points web-report --input report.json --serve 8080
 *   pain-points report --files scan.json --format json | pain-points web-report --output report.html
 *
 * Generates a single self-contained .html file with all CSS/JS inline.
 * No external dependencies. Dark/light mode toggle. Responsive.
 */

import { readFileSync, writeFileSync, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { normalizeArgs, log } from './lib/utils.mjs';

// ─── constants ────────────────────────────────────────────────────────────────

const DEPTH_COLOR = {
  urgent:  { css: 'var(--color-urgent)',  label: 'Urgent',  hex: '#ef4444' },
  active:  { css: 'var(--color-active)',  label: 'Active',  hex: '#f59e0b' },
  surface: { css: 'var(--color-surface)', label: 'Surface', hex: '#3b82f6' },
};

const VERDICT_META = {
  validated:      { label: 'VALIDATED',       cls: 'badge-green'  },
  needs_evidence: { label: 'NEEDS EVIDENCE',  cls: 'badge-amber'  },
  too_weak:       { label: 'TOO WEAK',        cls: 'badge-red'    },
};

const MATRIX_LABELS = {
  primary:    { label: 'Primary Target',    quadrant: 'top-right',    cls: 'q-primary'    },
  hidden_gem: { label: 'Hidden Gem',        quadrant: 'bottom-right', cls: 'q-hidden'     },
  background: { label: 'Background Noise',  quadrant: 'top-left',     cls: 'q-background' },
  ignore:     { label: 'Ignore',            quadrant: 'bottom-left',  cls: 'q-ignore'     },
};

const SOURCE_ICONS = {
  reddit:     'R',
  hackernews: 'Y',
  google:     'G',
  appstore:   'A',
  twitter:    'T',
  producthunt:'P',
  crowdfunding:'K',
  trustpilot: 'TP',
  reviews:    'RV',
  unknown:    '?',
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s, n = 200) {
  const clean = stripHtml(s);
  if (clean.length <= n) return clean;
  return clean.slice(0, n).replace(/\s\S*$/, '') + '…';
}

// ─── SVG building blocks ──────────────────────────────────────────────────────

/**
 * Circular gauge (SVG). score 0–100.
 * Returns an SVG string.
 */
function buildGaugeSvg(score, size = 80, strokeWidth = 8) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (score / 100) * circumference;
  const gap = circumference - filled;

  // Color by score
  let color;
  if (score >= 70) color = '#22c55e';
  else if (score >= 40) color = '#f59e0b';
  else color = '#ef4444';

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="gauge-svg">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${strokeWidth}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"
      stroke-dasharray="${filled.toFixed(2)} ${gap.toFixed(2)}"
      stroke-dashoffset="${(circumference * 0.25).toFixed(2)}"
      stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
      class="gauge-text" fill="${color}">${score}</text>
  </svg>`;
}

/**
 * Donut chart for source coverage.
 * segments: [{ label, value, color }]
 */
function buildDonutSvg(segments, size = 200, strokeWidth = 36) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return `<svg width="${size}" height="${size}"><text x="50%" y="50%" text-anchor="middle" fill="var(--muted)">No data</text></svg>`;

  const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#3b82f6', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6'];
  let offset = 0;
  let arcs = '';
  let legends = '';

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const pct = seg.value / total;
    const dashLen = pct * circumference;
    const gapLen = circumference - dashLen;
    const color = seg.color || COLORS[i % COLORS.length];

    arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}"
      stroke-width="${strokeWidth}"
      stroke-dasharray="${dashLen.toFixed(2)} ${gapLen.toFixed(2)}"
      stroke-dashoffset="${(circumference * 0.25 - offset * circumference).toFixed(2)}"
      stroke-linecap="butt">
      <title>${escHtml(seg.label)}: ${seg.value}</title>
    </circle>`;

    legends += `<div class="donut-legend-item">
      <span class="donut-dot" style="background:${color}"></span>
      <span class="donut-label">${escHtml(seg.label)}</span>
      <span class="donut-val">${seg.value}</span>
    </div>`;

    offset += pct;
  }

  const totalLabel = `${total}`;

  return `<div class="donut-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="donut-svg">
      ${arcs}
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" class="donut-total-num" fill="var(--fg)">${totalLabel}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" class="donut-total-label" fill="var(--muted)">posts</text>
    </svg>
    <div class="donut-legend">${legends}</div>
  </div>`;
}

/**
 * 2×2 Matrix visualization.
 * groups: array of group objects with .matrix, .category, .postCount, .frequency, .intensityScore
 */
function buildMatrixSvg(groups) {
  const W = 460, H = 360;
  const padL = 50, padB = 40, padT = 20, padR = 20;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const midX = padL + innerW / 2;
  const midY = padT + innerH / 2;

  // Compute max for scaling
  const maxFreq = Math.max(...groups.map(g => g.frequency || 1), 1);
  const maxIntensity = Math.max(...groups.map(g => g.intensityScore || 1), 1);
  const maxPosts = Math.max(...groups.map(g => g.postCount || 1), 1);

  function fx(freq) {
    return padL + (freq / maxFreq) * innerW;
  }
  function fy(intensity) {
    return padT + innerH - (intensity / maxIntensity) * innerH;
  }
  function fRadius(posts) {
    return Math.max(8, Math.min(28, 8 + (posts / maxPosts) * 20));
  }

  const quadrantLabels = [
    { x: padL + innerW * 0.75, y: padT + innerH * 0.18, text: 'Primary Target', cls: 'q-primary' },
    { x: padL + innerW * 0.75, y: padT + innerH * 0.78, text: 'Hidden Gem',     cls: 'q-hidden'  },
    { x: padL + innerW * 0.20, y: padT + innerH * 0.18, text: 'Background Noise', cls: 'q-background' },
    { x: padL + innerW * 0.20, y: padT + innerH * 0.78, text: 'Ignore',         cls: 'q-ignore'  },
  ];

  const dots = groups.map((g, i) => {
    const x = fx(g.frequency || 0).toFixed(1);
    const y = fy(g.intensityScore || 0).toFixed(1);
    const rr = fRadius(g.postCount || 1);
    const COLORS = ['#6366f1','#22c55e','#f59e0b','#3b82f6','#ec4899','#14b8a6'];
    const color = COLORS[i % COLORS.length];
    const label = escHtml(g.category);
    return `<g class="matrix-dot-group" data-cat="${escHtml(g.category)}">
      <circle cx="${x}" cy="${y}" r="${rr}" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="2">
        <title>${label} — freq:${g.frequency} intensity:${g.intensityScore} posts:${g.postCount}</title>
      </circle>
      <text x="${x}" y="${(parseFloat(y) + rr + 12).toFixed(1)}" text-anchor="middle" class="matrix-dot-label">${label}</text>
    </g>`;
  }).join('\n');

  const qlabels = quadrantLabels.map(q =>
    `<text x="${q.x}" y="${q.y}" text-anchor="middle" class="quadrant-label ${q.cls}">${q.text}</text>`
  ).join('\n');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="matrix-svg">
    <!-- Quadrant backgrounds -->
    <rect x="${padL}" y="${padT}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-tl"/>
    <rect x="${midX}" y="${padT}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-tr"/>
    <rect x="${padL}" y="${midY}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-bl"/>
    <rect x="${midX}" y="${midY}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-br"/>
    <!-- Dividers -->
    <line x1="${midX}" y1="${padT}" x2="${midX}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <line x1="${padL}" y1="${midY}" x2="${padL + innerW}" y2="${midY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <!-- Axes -->
    <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="var(--muted)" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="var(--muted)" stroke-width="1"/>
    <!-- Axis labels -->
    <text x="${padL + innerW/2}" y="${H - 4}" text-anchor="middle" class="axis-label">Frequency (post count)</text>
    <text x="12" y="${padT + innerH/2}" text-anchor="middle" class="axis-label" transform="rotate(-90 12 ${padT + innerH/2})">Intensity</text>
    <!-- Quadrant labels -->
    ${qlabels}
    <!-- Dots -->
    ${dots}
  </svg>`;
}

/**
 * Horizontal bar chart for competitive landscape.
 * tools: string[] (mentioned tool names)
 */
function buildCompetitorBars(allTools) {
  // Count occurrences
  const counts = {};
  for (const t of allTools) {
    counts[t] = (counts[t] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (sorted.length === 0) return '<p class="muted-text">No competitive tools mentioned in this dataset.</p>';

  const max = sorted[0][1];
  const COLORS = ['#6366f1','#22c55e','#f59e0b','#3b82f6','#ec4899','#14b8a6','#f97316','#8b5cf6'];

  const bars = sorted.map(([name, count], i) => {
    const pct = (count / max * 100).toFixed(1);
    const color = COLORS[i % COLORS.length];
    return `<div class="comp-bar-row">
      <span class="comp-bar-label">${escHtml(name)}</span>
      <div class="comp-bar-track">
        <div class="comp-bar-fill" style="width:${pct}%;background:${color}" data-val="${count}">
          <span class="comp-bar-val">${count}</span>
        </div>
      </div>
    </div>`;
  }).join('\n');

  return `<div class="comp-bars">${bars}</div>`;
}

// ─── HTML sections ────────────────────────────────────────────────────────────

function buildHero(data) {
  const topGroup = data.groups[0];
  const meta = data.meta;
  const totalWtp = data.groups.reduce((s, g) => s + (g.moneyTrail?.totalCount || 0), 0);
  const topQuote = topGroup?.topQuotes?.[0]?.body || topGroup?.unspokenPain?.[0] || '';
  const verdict = VERDICT_META[topGroup?.verdict] || VERDICT_META.needs_evidence;
  const gauge = buildGaugeSvg(topGroup?.buildScore || 0, 120, 12);

  return `<section class="hero" id="hero">
    <div class="hero-inner">
      <div class="hero-text">
        <p class="hero-eyebrow">Pain Point Analysis</p>
        <h1 class="hero-title">#1 Pain: <span class="hero-accent">${escHtml(topGroup?.category || 'Unknown')}</span></h1>
        ${topQuote ? `<blockquote class="hero-quote">"${escHtml(truncate(topQuote, 160))}"</blockquote>` : ''}
        <p class="hero-audience">${escHtml(topGroup?.audience || '')}</p>
      </div>
      <div class="hero-stats">
        <div class="hero-gauge">
          ${gauge}
          <p class="gauge-label">Build Score</p>
        </div>
        <div class="hero-kpis">
          <div class="kpi">
            <span class="kpi-val">${meta.totalPosts}</span>
            <span class="kpi-label">Posts Analyzed</span>
          </div>
          <div class="kpi">
            <span class="kpi-val">${meta.sources?.length || 0}</span>
            <span class="kpi-label">Sources</span>
          </div>
          <div class="kpi">
            <span class="kpi-val">${totalWtp}</span>
            <span class="kpi-label">WTP Signals</span>
          </div>
          <div class="kpi">
            <span class="kpi-val">${meta.categoriesFound}</span>
            <span class="kpi-label">Pain Categories</span>
          </div>
          <div class="kpi kpi-wide">
            <span class="badge ${verdict.cls}">${verdict.label}</span>
            <span class="kpi-label">Top Verdict</span>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

function buildCategoryCards(groups) {
  const cards = groups.map((g, idx) => {
    const depthMeta = DEPTH_COLOR[g.depth] || DEPTH_COLOR.surface;
    const verdictMeta = VERDICT_META[g.verdict] || VERDICT_META.needs_evidence;
    const gauge = buildGaugeSvg(g.buildScore || 0, 64, 7);
    const topQuote = g.topQuotes?.[0]?.body || '';
    const sourceBadges = (g.sourceNames || []).map(s =>
      `<span class="source-badge" data-source="${escHtml(s)}">${escHtml(SOURCE_ICONS[s] || s.slice(0, 2).toUpperCase())}</span>`
    ).join('');

    // Expanded evidence
    const allQuotes = [...(g.topQuotes || []), ...(g.unspokenPain || []).map(b => ({ body: b, score: 0, _unspoken: true }))];
    const evidenceHtml = allQuotes.slice(0, 6).map(q => {
      const body = typeof q === 'string' ? q : q.body;
      const score = typeof q === 'object' ? q.score : 0;
      return `<div class="evidence-item">
        <p class="evidence-text">"${escHtml(truncate(body, 240))}"</p>
        ${score ? `<span class="evidence-score">+${score}</span>` : ''}
      </div>`;
    }).join('');

    const solutionHtml = (g.solutionAttempts || []).slice(0, 3).map(s => {
      const body = typeof s === 'string' ? s : s.body;
      return `<li class="solution-item">${escHtml(truncate(body, 160))}</li>`;
    }).join('');

    const competitorHtml = (g.tools || []).length > 0
      ? `<p class="detail-label">Competitive Landscape</p><div class="tool-tags">${(g.tools || []).map(t => `<span class="tool-tag">${escHtml(t)}</span>`).join('')}</div>`
      : '';

    return `<div class="cat-card" data-depth="${g.depth}" data-matrix="${g.matrix}" data-category="${escHtml(g.category)}" style="--depth-color:${depthMeta.css}">
      <div class="cat-card-header">
        <div class="cat-card-left">
          <div class="cat-gauge">${gauge}</div>
          <div class="cat-info">
            <h3 class="cat-name">#${idx+1} ${escHtml(g.category)}</h3>
            <div class="cat-meta-row">
              <span class="depth-badge" data-depth="${g.depth}">${depthMeta.label}</span>
              <span class="badge ${verdictMeta.cls}">${verdictMeta.label}</span>
              <span class="matrix-badge">${MATRIX_LABELS[g.matrix]?.label || g.matrix}</span>
            </div>
            <div class="cat-stats-row">
              <span class="cat-stat"><b>${g.postCount}</b> posts</span>
              <span class="cat-stat"><b>${g.crossSources}</b> source${g.crossSources !== 1 ? 's' : ''}</span>
              <span class="cat-stat"><b>${g.moneyTrail?.totalCount || 0}</b> WTP signals</span>
            </div>
          </div>
        </div>
        <div class="cat-card-right">
          <div class="source-badges">${sourceBadges}</div>
        </div>
      </div>
      ${topQuote ? `<blockquote class="cat-quote">"${escHtml(truncate(topQuote, 180))}"</blockquote>` : ''}
      <details class="cat-details">
        <summary class="cat-details-toggle">Show full evidence <span class="toggle-arrow">▶</span></summary>
        <div class="cat-details-body">
          ${evidenceHtml ? `<p class="detail-label">Evidence</p><div class="evidence-list">${evidenceHtml}</div>` : ''}
          ${solutionHtml ? `<p class="detail-label">Current Workarounds</p><ul class="solution-list">${solutionHtml}</ul>` : ''}
          ${g.moneyTrail?.examples?.length ? `<p class="detail-label">Money Trail (${g.moneyTrail.strength})</p>
            <div class="money-trail">
              ${g.moneyTrail.examples.slice(0, 3).map(ex => `<div class="money-trail-item">
                <p class="money-body">"${escHtml(truncate(ex.body, 200))}"</p>
                <div class="money-signals">${(ex.signals || []).map(sig => `<span class="signal-tag">${escHtml(sig)}</span>`).join('')}</div>
              </div>`).join('')}
            </div>` : ''}
          ${competitorHtml}
          ${g.audience ? `<p class="detail-label">Target Audience</p><p class="detail-text">${escHtml(g.audience)}</p>` : ''}
        </div>
      </details>
    </div>`;
  }).join('\n');

  return `<section class="section" id="categories">
    <h2 class="section-title">Pain Category Cards</h2>
    <p class="section-sub">Sorted by build score. Click any card to expand full evidence.</p>
    <div class="cat-cards">${cards}</div>
  </section>`;
}

function buildMatrix(groups) {
  const svg = buildMatrixSvg(groups);
  return `<section class="section" id="matrix">
    <h2 class="section-title">Frequency × Intensity Matrix</h2>
    <p class="section-sub">Dot size = post count. Position = market opportunity quadrant.</p>
    <div class="matrix-wrap">
      ${svg}
    </div>
    <div class="matrix-legend">
      <div class="matrix-legend-item q-primary"><span class="matrix-legend-dot"></span> Primary Target — high freq + high intensity</div>
      <div class="matrix-legend-item q-hidden"><span class="matrix-legend-dot"></span> Hidden Gem — low freq, high intensity</div>
      <div class="matrix-legend-item q-background"><span class="matrix-legend-dot"></span> Background Noise — high freq, low intensity</div>
      <div class="matrix-legend-item q-ignore"><span class="matrix-legend-dot"></span> Ignore — low freq + low intensity</div>
    </div>
  </section>`;
}

function buildSourceCoverage(meta, groups) {
  // Aggregate post counts per source
  const sourceCounts = {};
  for (const g of groups) {
    for (const src of (g.sourceNames || [])) {
      sourceCounts[src] = (sourceCounts[src] || 0) + (g.postCount || 0);
    }
  }
  const segments = Object.entries(sourceCounts).map(([label, value]) => ({ label, value }));

  const donut = buildDonutSvg(segments, 180, 34);

  // Source status cards
  const sourceCards = (meta.sources || []).map(src => {
    const count = sourceCounts[src] || 0;
    const icon = SOURCE_ICONS[src] || src.slice(0, 2).toUpperCase();
    return `<div class="source-card">
      <div class="source-card-icon" data-source="${escHtml(src)}">${icon}</div>
      <div class="source-card-info">
        <p class="source-card-name">${escHtml(src)}</p>
        <p class="source-card-count">${count} posts</p>
      </div>
      <span class="source-status source-status-ok">working</span>
    </div>`;
  }).join('');

  return `<section class="section" id="sources">
    <h2 class="section-title">Source Coverage</h2>
    <div class="sources-wrap">
      <div class="sources-chart">${donut}</div>
      <div class="source-cards">${sourceCards}</div>
    </div>
  </section>`;
}

function buildEvidenceWall(groups) {
  // Collect all quotes with category info
  const cards = [];
  for (const g of groups) {
    for (const q of (g.topQuotes || [])) {
      cards.push({ body: q.body, score: q.score || 0, signals: q.signals || [], category: g.category, depth: g.depth });
    }
    for (const body of (g.unspokenPain || [])) {
      cards.push({ body, score: 0, signals: [], category: g.category, depth: g.depth, unspoken: true });
    }
  }

  if (cards.length === 0) return '';

  // Sort by score desc
  cards.sort((a, b) => b.score - a.score);

  const filterBtns = ['all', ...new Set(groups.map(g => g.category))].map(cat =>
    `<button class="filter-btn${cat === 'all' ? ' active' : ''}" data-filter="${escHtml(cat)}">${cat === 'all' ? 'All' : escHtml(cat)}</button>`
  ).join('');

  const cardHtml = cards.map(c => {
    const depthMeta = DEPTH_COLOR[c.depth] || DEPTH_COLOR.surface;
    return `<div class="evidence-card" data-category="${escHtml(c.category)}">
      <p class="evidence-card-text">"${escHtml(truncate(c.body, 220))}"</p>
      <div class="evidence-card-footer">
        <span class="cat-pill" style="--depth-color:${depthMeta.css}">${escHtml(c.category)}</span>
        ${c.score ? `<span class="evidence-upvotes">+${c.score}</span>` : ''}
        ${c.unspoken ? '<span class="unspoken-badge">unspoken</span>' : ''}
      </div>
    </div>`;
  }).join('');

  return `<section class="section" id="evidence">
    <h2 class="section-title">Evidence Wall</h2>
    <div class="filter-row">${filterBtns}</div>
    <div class="evidence-wall" id="evidenceWall">${cardHtml}</div>
  </section>`;
}

function buildCompetitorSection(groups) {
  const allTools = groups.flatMap(g => g.tools || []).filter(Boolean);
  const bars = buildCompetitorBars(allTools);

  return `<section class="section" id="competitors">
    <h2 class="section-title">Competitive Landscape</h2>
    <p class="section-sub">Tools and solutions mentioned by users across all sources.</p>
    ${bars}
  </section>`;
}

function buildLeaderboard(groups) {
  const rows = groups.map((g, i) => {
    const verdictMeta = VERDICT_META[g.verdict] || VERDICT_META.needs_evidence;
    const depthMeta = DEPTH_COLOR[g.depth] || DEPTH_COLOR.surface;
    return `<div class="lb-row">
      <span class="lb-rank">${i + 1}</span>
      <div class="lb-info">
        <div class="lb-name-row">
          <span class="lb-name">${escHtml(g.category)}</span>
          <span class="badge ${verdictMeta.cls}">${verdictMeta.label}</span>
          <span class="depth-badge" data-depth="${g.depth}">${depthMeta.label}</span>
        </div>
        <div class="lb-bar-track">
          <div class="lb-bar-fill" style="width:${g.buildScore || 0}%"></div>
        </div>
      </div>
      <span class="lb-score">${g.buildScore || 0}<span class="lb-score-max">/100</span></span>
    </div>`;
  }).join('');

  return `<section class="section" id="leaderboard">
    <h2 class="section-title">Build-Worthiness Leaderboard</h2>
    <p class="section-sub">Ranked by composite build score (pain depth + frequency + WTP + cross-source validation).</p>
    <div class="leaderboard">${rows}</div>
  </section>`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

function buildCss() {
  return `
:root {
  --bg: #0a0a0f;
  --bg2: #111118;
  --bg3: #1a1a24;
  --border: #2a2a3a;
  --fg: #e8e8f0;
  --fg2: #a0a0b8;
  --muted: #606078;
  --accent: #6366f1;
  --accent2: #818cf8;
  --track: #2a2a3a;
  --color-urgent: #ef4444;
  --color-active: #f59e0b;
  --color-surface: #3b82f6;
  --shadow: 0 1px 3px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3);
  --radius: 12px;
  --radius-sm: 8px;
  font-size: 15px;
}
[data-theme="light"] {
  --bg: #f8f8fc;
  --bg2: #ffffff;
  --bg3: #f0f0f8;
  --border: #e0e0ec;
  --fg: #1a1a2e;
  --fg2: #4a4a6a;
  --muted: #8888aa;
  --track: #e0e0ec;
  --shadow: 0 1px 3px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.06);
}
*,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  line-height: 1.6;
  min-height: 100vh;
}

/* ── Nav ── */
.topnav {
  position: sticky; top: 0; z-index: 100;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 0 24px;
  display: flex; align-items: center; gap: 8px;
  height: 52px;
}
.nav-brand { font-weight: 700; font-size: 14px; color: var(--accent2); margin-right: auto; letter-spacing: -.3px; }
.nav-link { font-size: 13px; color: var(--fg2); text-decoration: none; padding: 6px 10px; border-radius: 6px; transition: background .15s, color .15s; }
.nav-link:hover { background: var(--bg3); color: var(--fg); }
.nav-sep { color: var(--border); }
.theme-toggle {
  background: var(--bg3); border: 1px solid var(--border); color: var(--fg2);
  padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
  transition: all .15s;
}
.theme-toggle:hover { color: var(--fg); border-color: var(--accent); }

/* ── Layout ── */
.container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
.section { padding: 64px 0; }
.section-title {
  font-size: 24px; font-weight: 700; letter-spacing: -.5px;
  margin-bottom: 6px; color: var(--fg);
}
.section-sub { color: var(--fg2); font-size: 14px; margin-bottom: 28px; }

/* ── Hero ── */
.hero { padding: 72px 0 60px; }
.hero-inner { display: flex; gap: 48px; align-items: flex-start; flex-wrap: wrap; }
.hero-text { flex: 1 1 360px; }
.hero-eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: var(--accent2); margin-bottom: 12px; }
.hero-title { font-size: clamp(28px, 4vw, 42px); font-weight: 800; line-height: 1.15; letter-spacing: -.8px; margin-bottom: 20px; }
.hero-accent { color: var(--accent2); }
.hero-quote { font-size: 16px; font-style: italic; color: var(--fg2); border-left: 3px solid var(--accent); padding-left: 16px; margin: 20px 0; line-height: 1.7; }
.hero-audience { font-size: 14px; color: var(--muted); }
.hero-stats { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 24px; }
.hero-gauge { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.gauge-label { font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: .5px; }
.gauge-text { font-size: 20px; font-weight: 700; }
.hero-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.kpi { display: flex; flex-direction: column; align-items: center; gap: 2px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 18px; }
.kpi-wide { grid-column: span 2; }
.kpi-val { font-size: 26px; font-weight: 800; letter-spacing: -.5px; color: var(--fg); }
.kpi-label { font-size: 11px; color: var(--muted); font-weight: 500; letter-spacing: .5px; text-transform: uppercase; }

/* ── Badges ── */
.badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 700; letter-spacing: .8px; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; }
.badge-green { background: #14532d33; color: #4ade80; border: 1px solid #4ade8040; }
.badge-amber { background: #78350f33; color: #fcd34d; border: 1px solid #fcd34d40; }
.badge-red   { background: #450a0a33; color: #f87171; border: 1px solid #f8717140; }
.depth-badge { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: .5px; }
.depth-badge[data-depth="urgent"]  { background: #ef444422; color: var(--color-urgent); }
.depth-badge[data-depth="active"]  { background: #f59e0b22; color: var(--color-active); }
.depth-badge[data-depth="surface"] { background: #3b82f622; color: var(--color-surface); }
.matrix-badge { font-size: 11px; color: var(--muted); padding: 3px 8px; border-radius: 4px; background: var(--bg3); border: 1px solid var(--border); }

/* ── Category cards ── */
.cat-cards { display: flex; flex-direction: column; gap: 16px; }
.cat-card {
  background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
  border-left: 4px solid var(--depth-color);
  box-shadow: var(--shadow);
  overflow: hidden;
  transition: border-color .2s;
}
.cat-card-header { display: flex; gap: 16px; align-items: flex-start; padding: 20px 20px 0; flex-wrap: wrap; }
.cat-card-left { display: flex; gap: 16px; align-items: flex-start; flex: 1; }
.cat-gauge { flex: 0 0 64px; }
.cat-info { flex: 1; }
.cat-name { font-size: 17px; font-weight: 700; letter-spacing: -.3px; margin-bottom: 8px; }
.cat-meta-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.cat-stats-row { display: flex; gap: 16px; flex-wrap: wrap; }
.cat-stat { font-size: 13px; color: var(--fg2); }
.cat-card-right { flex: 0 0 auto; }
.source-badges { display: flex; gap: 4px; flex-wrap: wrap; }
.source-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%; font-size: 11px; font-weight: 700;
  background: var(--bg3); border: 1px solid var(--border); color: var(--fg2);
}
.source-badge[data-source="reddit"]     { background: #ff451533; color: #ff6b3d; border-color: #ff451540; }
.source-badge[data-source="hackernews"] { background: #ff660033; color: #ff8533; border-color: #ff660040; }
.source-badge[data-source="google"]     { background: #4285f433; color: #6fa8f8; border-color: #4285f440; }
.source-badge[data-source="appstore"]   { background: #007aff33; color: #4db3ff; border-color: #007aff40; }
.source-badge[data-source="twitter"]    { background: #1da1f233; color: #5bc1f7; border-color: #1da1f240; }
.cat-quote { font-style: italic; font-size: 14px; color: var(--fg2); padding: 14px 20px; border-top: 1px solid var(--border); margin-top: 16px; line-height: 1.7; }
.cat-details { border-top: 1px solid var(--border); }
.cat-details-toggle {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 20px; font-size: 13px; font-weight: 600; color: var(--fg2); cursor: pointer;
  list-style: none; user-select: none;
  transition: color .15s, background .15s;
}
.cat-details-toggle:hover { color: var(--fg); background: var(--bg3); }
.cat-details[open] .toggle-arrow { transform: rotate(90deg); }
.toggle-arrow { transition: transform .2s; display: inline-block; font-size: 10px; }
.cat-details-body { padding: 16px 20px 20px; }
.detail-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); margin: 16px 0 8px; }
.detail-label:first-child { margin-top: 0; }
.detail-text { font-size: 14px; color: var(--fg2); }
.evidence-list { display: flex; flex-direction: column; gap: 10px; }
.evidence-item { background: var(--bg3); border-radius: var(--radius-sm); padding: 12px; border: 1px solid var(--border); position: relative; }
.evidence-text { font-size: 13px; color: var(--fg2); line-height: 1.7; font-style: italic; }
.evidence-score { position: absolute; top: 8px; right: 10px; font-size: 12px; font-weight: 700; color: var(--accent2); }
.solution-list { padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.solution-item { font-size: 13px; color: var(--fg2); line-height: 1.6; }
.money-trail { display: flex; flex-direction: column; gap: 10px; }
.money-trail-item { background: var(--bg3); border-radius: var(--radius-sm); padding: 12px; border: 1px solid var(--border); border-left: 3px solid #22c55e; }
.money-body { font-size: 13px; color: var(--fg2); font-style: italic; line-height: 1.6; margin-bottom: 6px; }
.money-signals { display: flex; gap: 4px; flex-wrap: wrap; }
.signal-tag { font-size: 11px; background: #22c55e22; color: #4ade80; border: 1px solid #22c55e30; padding: 2px 6px; border-radius: 4px; }
.tool-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tool-tag { font-size: 12px; background: var(--bg3); border: 1px solid var(--border); color: var(--fg2); padding: 3px 10px; border-radius: 20px; }

/* ── Matrix ── */
.matrix-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; overflow-x: auto; }
.matrix-svg { display: block; min-width: 320px; }
.quad-bg { fill: transparent; }
.quad-bg-tr { fill: color-mix(in srgb, #6366f1 4%, transparent); }
.quad-bg-br { fill: color-mix(in srgb, #22c55e 4%, transparent); }
.axis-label { font-size: 11px; fill: var(--muted); font-family: inherit; }
.quadrant-label { font-size: 12px; font-weight: 600; font-family: inherit; }
.q-primary    { fill: #818cf8; }
.q-hidden     { fill: #4ade80; }
.q-background { fill: var(--muted); }
.q-ignore     { fill: var(--muted); }
.matrix-dot-label { font-size: 10px; fill: var(--fg2); font-family: inherit; }
.matrix-legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 16px; }
.matrix-legend-item { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg2); }
.matrix-legend-dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
.matrix-legend-item.q-primary    { color: #818cf8; }
.matrix-legend-item.q-hidden     { color: #4ade80; }
.matrix-legend-item.q-background { color: var(--muted); }
.matrix-legend-item.q-ignore     { color: var(--muted); }

/* ── Source coverage ── */
.sources-wrap { display: flex; gap: 40px; align-items: flex-start; flex-wrap: wrap; }
.sources-chart { flex: 0 0 auto; }
.donut-wrap { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
.donut-svg { display: block; }
.donut-total-num { font-size: 24px; font-weight: 800; font-family: inherit; }
.donut-total-label { font-size: 12px; font-family: inherit; }
.donut-legend { display: flex; flex-direction: column; gap: 8px; }
.donut-legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.donut-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 10px; }
.donut-label { color: var(--fg2); flex: 1; }
.donut-val { font-weight: 700; color: var(--fg); min-width: 24px; text-align: right; }
.source-cards { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.source-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; display: flex; gap: 12px; align-items: center; }
.source-card-icon { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; background: var(--bg3); border: 1px solid var(--border); color: var(--fg2); }
.source-card-icon[data-source="reddit"]     { background: #ff451522; color: #ff6b3d; border-color: #ff451540; }
.source-card-icon[data-source="hackernews"] { background: #ff660022; color: #ff8533; border-color: #ff660040; }
.source-card-icon[data-source="google"]     { background: #4285f422; color: #6fa8f8; border-color: #4285f440; }
.source-card-icon[data-source="appstore"]   { background: #007aff22; color: #4db3ff; border-color: #007aff40; }
.source-card-name { font-size: 14px; font-weight: 600; color: var(--fg); }
.source-card-count { font-size: 12px; color: var(--muted); }
.source-status { margin-left: auto; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 4px; letter-spacing: .3px; }
.source-status-ok { background: #14532d33; color: #4ade80; }

/* ── Evidence wall ── */
.filter-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
.filter-btn { background: var(--bg3); border: 1px solid var(--border); color: var(--fg2); padding: 6px 14px; border-radius: 20px; cursor: pointer; font-size: 13px; font-family: inherit; transition: all .15s; }
.filter-btn:hover, .filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.evidence-wall { columns: 3 280px; gap: 16px; }
.evidence-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; break-inside: avoid; margin-bottom: 16px; transition: border-color .2s; }
.evidence-card:hover { border-color: var(--accent); }
.evidence-card.hidden { display: none; }
.evidence-card-text { font-size: 14px; line-height: 1.7; color: var(--fg2); font-style: italic; margin-bottom: 12px; }
.evidence-card-footer { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cat-pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; background: color-mix(in srgb, var(--depth-color) 15%, transparent); color: var(--depth-color); border: 1px solid color-mix(in srgb, var(--depth-color) 30%, transparent); }
.evidence-upvotes { font-size: 12px; color: var(--accent2); font-weight: 700; margin-left: auto; }
.unspoken-badge { font-size: 10px; background: var(--bg3); border: 1px solid var(--border); color: var(--muted); padding: 1px 6px; border-radius: 4px; }

/* ── Competitor chart ── */
.comp-bars { display: flex; flex-direction: column; gap: 10px; max-width: 700px; }
.comp-bar-row { display: flex; align-items: center; gap: 12px; }
.comp-bar-label { font-size: 13px; font-weight: 600; color: var(--fg2); width: 120px; text-align: right; flex: 0 0 120px; }
.comp-bar-track { flex: 1; background: var(--bg3); border-radius: 6px; height: 28px; overflow: hidden; border: 1px solid var(--border); }
.comp-bar-fill { height: 100%; border-radius: 5px; position: relative; display: flex; align-items: center; transition: width .5s cubic-bezier(.4,0,.2,1); min-width: 40px; }
.comp-bar-val { position: absolute; right: 8px; font-size: 12px; font-weight: 700; color: #fff; }

/* ── Leaderboard ── */
.leaderboard { display: flex; flex-direction: column; gap: 12px; }
.lb-row { display: flex; gap: 16px; align-items: center; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px; }
.lb-rank { font-size: 20px; font-weight: 800; color: var(--muted); flex: 0 0 30px; text-align: center; }
.lb-row:nth-child(1) .lb-rank { color: #fbbf24; }
.lb-row:nth-child(2) .lb-rank { color: #94a3b8; }
.lb-row:nth-child(3) .lb-rank { color: #b45309; }
.lb-info { flex: 1; }
.lb-name-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.lb-name { font-size: 15px; font-weight: 700; color: var(--fg); }
.lb-bar-track { height: 8px; background: var(--track); border-radius: 4px; overflow: hidden; }
.lb-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 4px; transition: width .5s; }
.lb-score { font-size: 22px; font-weight: 800; color: var(--fg); flex: 0 0 70px; text-align: right; }
.lb-score-max { font-size: 13px; color: var(--muted); font-weight: 400; }

/* ── Footer ── */
.report-footer { text-align: center; padding: 40px 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; margin-top: 40px; }

/* ── Print ── */
@media print {
  .topnav, .theme-toggle, .filter-btn, .cat-details-toggle { display: none !important; }
  .cat-details[open] .cat-details-body { display: block; }
  body { background: #fff; color: #000; }
  .section { padding: 32px 0; }
  .cat-card, .lb-row, .evidence-card { break-inside: avoid; }
}

/* ── Responsive ── */
@media (max-width: 700px) {
  .topnav { overflow-x: auto; }
  .hero-inner { flex-direction: column; }
  .hero-kpis { grid-template-columns: 1fr 1fr; }
  .evidence-wall { columns: 1; }
  .comp-bar-label { width: 80px; flex: 0 0 80px; font-size: 11px; }
  .sources-wrap { flex-direction: column; }
  .section { padding: 40px 0; }
  .section-title { font-size: 20px; }
}
`;
}

// ─── JS ───────────────────────────────────────────────────────────────────────

function buildJs() {
  return `
// Theme toggle
const toggle = document.getElementById('themeToggle');
const root = document.documentElement;
const saved = localStorage.getItem('pp-theme');
if (saved) root.setAttribute('data-theme', saved);
toggle.addEventListener('click', () => {
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next === 'dark' ? '' : next);
  localStorage.setItem('pp-theme', next);
  toggle.textContent = next === 'light' ? '☾ Dark' : '☀ Light';
});

// Evidence wall filter
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.filter;
    document.querySelectorAll('.evidence-card').forEach(card => {
      if (filter === 'all' || card.dataset.category === filter) {
        card.classList.remove('hidden');
      } else {
        card.classList.add('hidden');
      }
    });
  });
});

// Smooth scroll for nav links
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// details toggle arrow
document.querySelectorAll('.cat-details').forEach(d => {
  d.addEventListener('toggle', () => {
    const arrow = d.querySelector('.toggle-arrow');
    if (arrow) arrow.style.transform = d.open ? 'rotate(90deg)' : '';
  });
});
`;
}

// ─── HTML assembler ───────────────────────────────────────────────────────────

function generateHtml(reportData, generatedAt = new Date().toISOString()) {
  const data = reportData.data || reportData;
  const meta = data.meta || {};
  const groups = (data.groups || []).sort((a, b) => (b.buildScore || 0) - (a.buildScore || 0));

  if (!groups.length) throw new Error('No pain categories found in report data.');

  const navLinks = [
    ['#hero', 'Summary'],
    ['#categories', 'Categories'],
    ['#matrix', 'Matrix'],
    ['#sources', 'Sources'],
    ['#evidence', 'Evidence'],
    ['#competitors', 'Competitors'],
    ['#leaderboard', 'Leaderboard'],
  ].map(([href, label]) => `<a class="nav-link" href="${href}">${label}</a>`).join('');

  const topCat = groups[0]?.category || 'Pain Analysis';
  const totalWtp = groups.reduce((s, g) => s + (g.moneyTrail?.totalCount || 0), 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Pain point analysis report — ${escHtml(topCat)}">
  <title>Pain Report — ${escHtml(topCat)}</title>
  <style>${buildCss()}</style>
</head>
<body>
  <nav class="topnav">
    <span class="nav-brand">pain-points</span>
    ${navLinks}
    <button class="theme-toggle" id="themeToggle">☀ Light</button>
  </nav>
  <div class="container">
    ${buildHero(data)}
    ${buildCategoryCards(groups)}
    ${buildMatrix(groups)}
    ${buildSourceCoverage(meta, groups)}
    ${buildEvidenceWall(groups)}
    ${buildCompetitorSection(groups)}
    ${buildLeaderboard(groups)}
    <footer class="report-footer">
      Generated ${new Date(generatedAt).toLocaleString()} &nbsp;&middot;&nbsp;
      ${meta.totalPosts || '?'} posts &nbsp;&middot;&nbsp;
      ${(meta.sources || []).join(', ')} &nbsp;&middot;&nbsp;
      ${totalWtp} WTP signals
    </footer>
  </div>
  <script>${buildJs()}</script>
</body>
</html>`;
}

// ─── I/O helpers ──────────────────────────────────────────────────────────────

function readInput(inputPath) {
  let raw;
  if (inputPath === '-' || !inputPath) {
    // Read from stdin
    raw = readSync(0, Buffer.alloc(1024 * 1024 * 4), 0, 1024 * 1024 * 4, null);
    const buf = Buffer.alloc(raw);
    readSync(0, buf, 0, raw, null);
    throw new Error('Use --input flag or pipe via stdin with readFileSync pattern.');
  }
  raw = readFileSync(resolve(inputPath), 'utf8');
  return JSON.parse(raw);
}

function readStdin() {
  return new Promise((res, rej) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      try { res(JSON.parse(buf)); } catch (e) { rej(new Error('Stdin is not valid JSON: ' + e.message)); }
    });
    process.stdin.on('error', rej);
  });
}

// ─── Dev server ───────────────────────────────────────────────────────────────

async function startDevServer(port, inputPath, outputPath) {
  let htmlContent = '';

  async function regen() {
    try {
      const data = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
      htmlContent = generateHtml(data);
      if (outputPath) writeFileSync(resolve(outputPath), htmlContent, 'utf8');
      log(`[web-report] Regenerated HTML (${(htmlContent.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      log(`[web-report] Error regenerating: ${err.message}`);
    }
  }

  await regen();

  // Serve the HTML + inject auto-reload script
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      const withReload = htmlContent.replace(
        '</body>',
        `<script>
          let lastSize = ${htmlContent.length};
          setInterval(async () => {
            const r = await fetch('/size');
            const size = await r.json();
            if (size !== lastSize) { lastSize = size; location.reload(); }
          }, 1500);
        </script></body>`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(withReload);
    } else if (req.url === '/size') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(htmlContent.length));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    log(`[web-report] Dev server running at http://localhost:${port}`);
    log(`[web-report] Watching ${inputPath} for changes…`);
  });

  watchFile(resolve(inputPath), { interval: 1000 }, async () => {
    log(`[web-report] Input file changed, regenerating…`);
    await regen();
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = normalizeArgs(argv);

  const helpText = `
pain-points web-report — Generate a beautiful self-contained HTML report

Usage:
  pain-points web-report --input report.json --output report.html
  pain-points web-report --input report.json --serve 8080
  pain-points report --files scan.json --format json | pain-points web-report --output report.html

Options:
  --input   <path>  Input JSON report file (or omit to read stdin)
  --output  <path>  Output HTML file (default: report.html)
  --serve   <port>  Start dev server on this port (with auto-reload)
  --help            Show this help
`;

  if (args.help || argv.includes('--help')) {
    log(helpText);
    process.exit(0);
  }

  const inputPath = args.input;
  const outputPath = args.output || 'report.html';
  const servePort = args.serve ? parseInt(args.serve, 10) : null;

  let reportData;
  if (inputPath) {
    try {
      reportData = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
    } catch (err) {
      log(`[web-report] Cannot read input file "${inputPath}": ${err.message}`);
      process.exit(1);
    }
  } else {
    // Read from stdin
    const isTTY = process.stdin.isTTY;
    if (isTTY) {
      log('[web-report] No --input file. Pipe JSON via stdin or use --input. See --help.');
      process.exit(1);
    }
    reportData = await readStdin();
  }

  if (servePort) {
    await startDevServer(servePort, inputPath || '-', outputPath);
    return;
  }

  let html;
  try {
    html = generateHtml(reportData, reportData.data?.generated);
  } catch (err) {
    log(`[web-report] Error generating HTML: ${err.message}`);
    process.exit(1);
  }

  const outPath = resolve(outputPath);
  writeFileSync(outPath, html, 'utf8');
  log(`[web-report] Report written to ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  log(`[web-report] Fatal: ${err.message}`);
  process.exit(1);
});

// ─── export for piping ────────────────────────────────────────────────────────
export { generateHtml };
