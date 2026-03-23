/**
 * web-report/svg-charts.mjs — SVG chart builders for HTML reports
 *
 * Stripped down to only the donut chart for source coverage (if needed).
 */

import { escHtml } from './helpers.mjs';

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
