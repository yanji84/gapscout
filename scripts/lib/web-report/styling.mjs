/**
 * web-report/styling.mjs — CSS and JS for HTML reports
 *
 * Extracted from web-report.mjs to keep the orchestrator thin.
 * The CSS and JS strings are exported as functions that return the full content.
 */

export { buildCss, buildJs };

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
.cat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); border-left: 4px solid var(--depth-color); box-shadow: var(--shadow); overflow: hidden; transition: border-color .2s; }
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
.source-badge { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; font-size: 11px; font-weight: 700; background: var(--bg3); border: 1px solid var(--border); color: var(--fg2); }
.source-badge[data-source="reddit"]     { background: #ff451533; color: #ff6b3d; border-color: #ff451540; }
.source-badge[data-source="hackernews"] { background: #ff660033; color: #ff8533; border-color: #ff660040; }
.source-badge[data-source="google"]     { background: #4285f433; color: #6fa8f8; border-color: #4285f440; }
.source-badge[data-source="appstore"]   { background: #007aff33; color: #4db3ff; border-color: #007aff40; }
.source-badge[data-source="twitter"]    { background: #1da1f233; color: #5bc1f7; border-color: #1da1f240; }
.cat-quote { font-style: italic; font-size: 14px; color: var(--fg2); padding: 14px 20px; border-top: 1px solid var(--border); margin-top: 16px; line-height: 1.7; }
.cat-details { border-top: 1px solid var(--border); }
.cat-details-toggle { display: flex; align-items: center; gap: 8px; padding: 12px 20px; font-size: 13px; font-weight: 600; color: var(--fg2); cursor: pointer; list-style: none; user-select: none; transition: color .15s, background .15s; }
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
.evidence-upvotes { font-size: 12px; color: var(--accent2); font-weight: 700; }
.evidence-comments { font-size: 12px; color: var(--muted); }
.evidence-link { text-decoration: none; color: inherit; }
.evidence-link:hover .evidence-card-text { color: var(--accent); }
.link-icon { font-size: 12px; color: var(--accent); margin-left: auto; opacity: 0.6; }
.evidence-card:hover .link-icon { opacity: 1; }
.no-source { font-size: 10px; color: var(--muted); opacity: 0.5; font-style: italic; }
.evidence-item-footer { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.solution-link { color: inherit; text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: 2px; }
.solution-link:hover { color: var(--accent); }
.source-badge-sm { font-size: 10px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg3); border: 1px solid var(--border); font-weight: 700; }
.unspoken-badge { font-size: 10px; background: var(--bg3); border: 1px solid var(--border); color: var(--muted); padding: 1px 6px; border-radius: 4px; }
.ref-posts { display: flex; flex-direction: column; gap: 6px; }
.ref-post { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius-sm); text-decoration: none; color: var(--fg2); transition: border-color .15s; }
.ref-post:hover { border-color: var(--accent); color: var(--fg); }
.ref-source { font-size: 11px; font-weight: 700; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg2); border: 1px solid var(--border); flex-shrink: 0; }
.ref-title { flex: 1; font-size: 13px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-stats { font-size: 12px; color: var(--muted); flex-shrink: 0; }

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

/* ── Idea Sketches ── */
.sketch-cards { display: flex; flex-direction: column; gap: 20px; }
.sketch-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; border-left: 4px solid var(--accent); }
.sketch-card[data-verdict="validated"] { border-left-color: #22c55e; }
.sketch-card[data-verdict="needs_evidence"] { border-left-color: #f59e0b; }
.sketch-card-header { display: flex; gap: 16px; align-items: center; padding: 20px 20px 16px; }
.sketch-card-left { display: flex; gap: 16px; align-items: center; flex: 1; }
.sketch-gauge { flex: 0 0 56px; }
.sketch-info { flex: 1; }
.sketch-name { font-size: 18px; font-weight: 700; letter-spacing: -.3px; margin-bottom: 6px; text-transform: capitalize; }
.sketch-badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sketch-score { font-size: 12px; color: var(--muted); font-weight: 500; }
.sketch-body { border-top: 1px solid var(--border); }
.sketch-subsection { border-bottom: 1px solid var(--border); }
.sketch-subsection:last-child { border-bottom: none; }
.sketch-subsection-toggle { display: flex; align-items: center; gap: 8px; padding: 12px 20px; font-size: 13px; font-weight: 600; color: var(--fg2); cursor: pointer; list-style: none; user-select: none; transition: color .15s, background .15s; }
.sketch-subsection-toggle:hover { color: var(--fg); background: var(--bg3); }
.sketch-subsection[open] .toggle-arrow { transform: rotate(90deg); }
.sketch-subsection-body { padding: 0 20px 16px; }
.sketch-text { font-size: 14px; color: var(--fg2); line-height: 1.7; }
.sketch-kv { display: flex; flex-direction: column; gap: 10px; }
.sketch-kv-row { display: flex; gap: 12px; align-items: flex-start; }
.sketch-kv-label { flex: 0 0 160px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; padding-top: 2px; }
.sketch-kv-val { flex: 1; font-size: 14px; color: var(--fg2); line-height: 1.6; }
.sketch-red-flag { display: inline-block; font-size: 11px; background: #450a0a33; color: #f87171; border: 1px solid #f8717130; padding: 2px 8px; border-radius: 4px; margin: 2px 4px 2px 0; }
@media (max-width: 700px) {
  .sketch-kv-row { flex-direction: column; gap: 2px; }
  .sketch-kv-label { flex: none; }
}

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
  toggle.textContent = next === 'light' ? '\\u263E Dark' : '\\u2600 Light';
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
document.querySelectorAll('.cat-details, .sketch-subsection').forEach(d => {
  d.addEventListener('toggle', () => {
    const arrow = d.querySelector('.toggle-arrow');
    if (arrow) arrow.style.transform = d.open ? 'rotate(90deg)' : '';
  });
});
`;
}
