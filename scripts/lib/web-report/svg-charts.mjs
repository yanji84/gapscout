/**
 * web-report/svg-charts.mjs — SVG chart builders for HTML reports
 */

import { escHtml } from './helpers.mjs';

/**
 * Circular gauge (SVG). score 0-100.
 */
export function buildGaugeSvg(score, size = 80, strokeWidth = 8) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const filled = (score / 100) * circumference;
  const gap = circumference - filled;

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
export function buildDonutSvg(segments, size = 200, strokeWidth = 36) {
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

  return `<div class="donut-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="donut-svg">
      ${arcs}
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" class="donut-total-num" fill="var(--fg)">${total}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" class="donut-total-label" fill="var(--muted)">posts</text>
    </svg>
    <div class="donut-legend">${legends}</div>
  </div>`;
}

/**
 * 2x2 Matrix visualization.
 */
export function buildMatrixSvg(groups) {
  const W = 460, H = 360;
  const padL = 50, padB = 40, padT = 20, padR = 20;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const midX = padL + innerW / 2;
  const midY = padT + innerH / 2;

  const maxFreq = Math.max(...groups.map(g => g.frequency || 1), 1);
  const maxIntensity = Math.max(...groups.map(g => g.intensityScore || 1), 1);
  const maxPosts = Math.max(...groups.map(g => g.postCount || 1), 1);

  function fx(freq) { return padL + (freq / maxFreq) * innerW; }
  function fy(intensity) { return padT + innerH - (intensity / maxIntensity) * innerH; }
  function fRadius(posts) { return Math.max(8, Math.min(28, 8 + (posts / maxPosts) * 20)); }

  const quadrantLabels = [
    { x: padL + innerW * 0.75, y: padT + innerH * 0.18, text: 'Primary Target', cls: 'q-primary' },
    { x: padL + innerW * 0.75, y: padT + innerH * 0.78, text: 'Hidden Gem',     cls: 'q-hidden'  },
    { x: padL + innerW * 0.20, y: padT + innerH * 0.18, text: 'Background Noise', cls: 'q-background' },
    { x: padL + innerW * 0.20, y: padT + innerH * 0.78, text: 'Ignore',         cls: 'q-ignore'  },
  ];

  const COLORS = ['#6366f1','#22c55e','#f59e0b','#3b82f6','#ec4899','#14b8a6'];
  const dots = groups.map((g, i) => {
    const x = fx(g.frequency || 0).toFixed(1);
    const y = fy(g.intensityScore || 0).toFixed(1);
    const rr = fRadius(g.postCount || 1);
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
    <rect x="${padL}" y="${padT}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-tl"/>
    <rect x="${midX}" y="${padT}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-tr"/>
    <rect x="${padL}" y="${midY}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-bl"/>
    <rect x="${midX}" y="${midY}" width="${innerW/2}" height="${innerH/2}" class="quad-bg quad-bg-br"/>
    <line x1="${midX}" y1="${padT}" x2="${midX}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <line x1="${padL}" y1="${midY}" x2="${padL + innerW}" y2="${midY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="var(--muted)" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="var(--muted)" stroke-width="1"/>
    <text x="${padL + innerW/2}" y="${H - 4}" text-anchor="middle" class="axis-label">Frequency (post count)</text>
    <text x="12" y="${padT + innerH/2}" text-anchor="middle" class="axis-label" transform="rotate(-90 12 ${padT + innerH/2})">Intensity</text>
    ${qlabels}
    ${dots}
  </svg>`;
}
