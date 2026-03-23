/**
 * web-report/styling.mjs — CSS and JS for HTML reports
 *
 * Pain discovery research document — stripped to pain discovery essentials.
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
.hero-title { font-size: clamp(28px, 4vw, 42px); font-weight: 800; line-height: 1.15; letter-spacing: -.8px; margin-bottom: 12px; }
.hero-date { font-size: 14px; color: var(--muted); }
.hero-stats { flex: 0 0 auto; }
.hero-kpis { display: flex; gap: 16px; flex-wrap: wrap; }
.kpi { display: flex; flex-direction: column; align-items: center; gap: 2px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 18px; }
.kpi-val { font-size: 26px; font-weight: 800; letter-spacing: -.5px; color: var(--fg); }
.kpi-label { font-size: 11px; color: var(--muted); font-weight: 500; letter-spacing: .5px; text-transform: uppercase; }

/* ── Badges ── */
.badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 700; letter-spacing: .8px; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; }
.depth-badge { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: .5px; }
.depth-badge[data-depth="urgent"]  { background: #ef444422; color: var(--color-urgent); }
.depth-badge[data-depth="active"]  { background: #f59e0b22; color: var(--color-active); }
.depth-badge[data-depth="surface"] { background: #3b82f622; color: var(--color-surface); }

/* ── Signal strength badges ── */
.signal-badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 4px; letter-spacing: .3px; }
.signal-strong { background: #14532d33; color: #4ade80; border: 1px solid #4ade8040; }
.signal-moderate { background: #78350f33; color: #fcd34d; border: 1px solid #fcd34d40; }
.signal-weak { background: #1f2937; color: #9ca3af; border: 1px solid #4b556340; }

/* ── Category cards ── */
.cat-cards { display: flex; flex-direction: column; gap: 16px; }
.cat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); border-left: 4px solid var(--depth-color); box-shadow: var(--shadow); overflow: hidden; transition: border-color .2s; }
.cat-card-header { display: flex; gap: 16px; align-items: flex-start; padding: 20px 20px 0; flex-wrap: wrap; }
.cat-card-left { display: flex; gap: 16px; align-items: flex-start; flex: 1; }
.cat-info { flex: 1; }
.cat-name { font-size: 17px; font-weight: 700; letter-spacing: -.3px; margin-bottom: 4px; text-transform: capitalize; }
.cat-description { font-size: 13px; color: var(--fg2); margin-bottom: 10px; line-height: 1.5; }
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

/* ── Cited quotes in category cards ── */
.cat-quotes { padding: 16px 20px 0; }
.cited-quote { background: var(--bg3); border-radius: var(--radius-sm); padding: 12px; border: 1px solid var(--border); margin-bottom: 8px; position: relative; }
.cited-quote-link { text-decoration: none; color: inherit; display: block; }
.cited-quote-link:hover .cited-quote-text { color: var(--accent); }
.cited-quote-text { font-size: 13px; color: var(--fg2); line-height: 1.7; font-style: italic; margin-bottom: 4px; }
.cited-quote-source { font-size: 11px; color: var(--muted); font-weight: 500; }
.cited-quote-score { position: absolute; top: 10px; right: 10px; font-size: 12px; font-weight: 700; color: var(--accent2); }
.cited-more { font-size: 12px; color: var(--muted); margin-top: 4px; }
.detail-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); margin: 0 0 10px; }
.detail-label:first-child { margin-top: 0; }

/* ── Citations list in details ── */
.citations-list { display: flex; flex-direction: column; gap: 6px; }
.citation-link { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius-sm); text-decoration: none; color: var(--fg2); transition: border-color .15s; }
.citation-link:hover { border-color: var(--accent); color: var(--fg); }
.citation-source { font-size: 11px; font-weight: 700; background: var(--bg2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 4px; flex-shrink: 0; text-transform: capitalize; }
.citation-title { flex: 1; font-size: 13px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Details toggle ── */
.cat-details { border-top: 1px solid var(--border); }
.cat-details-toggle { display: flex; align-items: center; gap: 8px; padding: 12px 20px; font-size: 13px; font-weight: 600; color: var(--fg2); cursor: pointer; list-style: none; user-select: none; transition: color .15s, background .15s; }
.cat-details-toggle:hover { color: var(--fg); background: var(--bg3); }
.cat-details[open] .toggle-arrow { transform: rotate(90deg); }
.toggle-arrow { transition: transform .2s; display: inline-block; font-size: 10px; }
.cat-details-body { padding: 16px 20px 20px; }

/* ── Source coverage ── */
.source-list { display: flex; flex-direction: column; gap: 8px; max-width: 600px; }
.source-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.source-item-icon { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; background: var(--bg3); border: 1px solid var(--border); color: var(--fg2); flex-shrink: 0; }
.source-item-icon[data-source="reddit"]     { background: #ff451522; color: #ff6b3d; border-color: #ff451540; }
.source-item-icon[data-source="hackernews"] { background: #ff660022; color: #ff8533; border-color: #ff660040; }
.source-item-icon[data-source="google"]     { background: #4285f422; color: #6fa8f8; border-color: #4285f440; }
.source-item-icon[data-source="appstore"]   { background: #007aff22; color: #4db3ff; border-color: #007aff40; }
.source-item-name { flex: 1; font-size: 14px; font-weight: 600; color: var(--fg); text-transform: capitalize; }
.source-item-count { font-size: 13px; color: var(--muted); }
.source-status { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 4px; letter-spacing: .3px; }
.source-status-ok { background: #14532d33; color: #4ade80; }
.source-status-empty { background: var(--bg3); color: var(--muted); }

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
.source-badge-sm { font-size: 10px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg3); border: 1px solid var(--border); font-weight: 700; }
.muted-text { font-size: 13px; color: var(--muted); font-style: italic; }

/* ── Data warnings ── */
.warning-list { display: flex; flex-direction: column; gap: 8px; max-width: 800px; }
.warning-row { display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: #78350f1a; border: 1px solid #f59e0b30; border-radius: var(--radius-sm); flex-wrap: wrap; }
.warning-source { font-size: 13px; font-weight: 700; color: var(--fg); flex: 0 0 120px; text-transform: capitalize; }
.warning-status { font-size: 12px; font-weight: 600; color: #fcd34d; }
.warning-detail { font-size: 12px; color: var(--fg2); flex: 1; }

/* ── Footer ── */
.report-footer { text-align: center; padding: 40px 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; margin-top: 40px; }

/* ── Print ── */
@media print {
  .topnav, .theme-toggle, .filter-btn, .cat-details-toggle { display: none !important; }
  .cat-details[open] .cat-details-body { display: block; }
  body { background: #fff; color: #000; }
  .section { padding: 32px 0; }
  .cat-card, .evidence-card { break-inside: avoid; }
}

/* ── Responsive ── */
@media (max-width: 700px) {
  .topnav { overflow-x: auto; }
  .hero-inner { flex-direction: column; }
  .hero-kpis { flex-direction: column; }
  .evidence-wall { columns: 1; }
  .source-list { max-width: 100%; }
  .section { padding: 40px 0; }
  .section-title { font-size: 20px; }
  .warning-source { flex: 0 0 auto; }
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
document.querySelectorAll('.cat-details').forEach(d => {
  d.addEventListener('toggle', () => {
    const arrow = d.querySelector('.toggle-arrow');
    if (arrow) arrow.style.transform = d.open ? 'rotate(90deg)' : '';
  });
});
`;
}
