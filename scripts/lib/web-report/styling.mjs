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

/* ── Verification summary ── */
.verification-summary {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px; margin-bottom: 8px;
  background: #14532d1a; border: 1px solid #4ade8030;
  border-radius: var(--radius-sm);
  font-size: 13px; font-weight: 500; color: #4ade80;
}
.verification-icon { font-size: 15px; font-weight: 700; }
[data-theme="light"] .verification-summary {
  background: #dcfce7; border-color: #86efac; color: #166534;
}

/* ── Evidence drawer (expandable inline citations) ── */
.evidence-details { border-top: 1px solid var(--border); }
.evidence-toggle { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.evidence-toggle:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.evidence-drawer { display: flex; flex-direction: column; gap: 0; }
.evidence-drawer-entries { display: flex; flex-direction: column; gap: 10px; }
.evidence-entry {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 14px;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color .15s;
}
.evidence-entry:hover { border-color: var(--accent); }
.evidence-entry-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.evidence-entry-quote {
  font-size: 13px; line-height: 1.65; color: var(--fg2);
  font-style: italic; margin: 0;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
}
.evidence-entry-meta {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 12px; color: var(--muted);
}
.evidence-entry-meta a {
  color: var(--accent2); text-decoration: none; font-weight: 600; font-size: 12px;
}
.evidence-entry-meta a:hover { text-decoration: underline; }
.evidence-entry-score { font-weight: 700; color: var(--accent2); }
.evidence-entry-date { color: var(--muted); }
.evidence-entry-subreddit { color: var(--fg2); font-weight: 500; }

/* ── Source badge pills (inline in evidence entries) ── */
.source-badge-pill {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 2px 8px; border-radius: 10px;
  font-size: 10px; font-weight: 700; letter-spacing: .3px; text-transform: uppercase;
  flex-shrink: 0;
}
.source-badge-pill[data-source="reddit"]       { background: #ff451522; color: #ff6b3d; border: 1px solid #ff451530; }
.source-badge-pill[data-source="hackernews"]   { background: #ff660022; color: #ff8533; border: 1px solid #ff660030; }
.source-badge-pill[data-source="google"]       { background: #4285f422; color: #6fa8f8; border: 1px solid #4285f430; }
.source-badge-pill[data-source="g2"]           { background: #22c55e22; color: #4ade80; border: 1px solid #22c55e30; }
.source-badge-pill[data-source="trustpilot"]   { background: #22c55e22; color: #4ade80; border: 1px solid #22c55e30; }
.source-badge-pill[data-source="appstore"]     { background: #007aff22; color: #4db3ff; border: 1px solid #007aff30; }
.source-badge-pill[data-source="twitter"]      { background: #1da1f222; color: #5bc1f7; border: 1px solid #1da1f230; }
.source-badge-pill[data-source="producthunt"]  { background: #da552f22; color: #f07050; border: 1px solid #da552f30; }
.source-badge-pill[data-source="github-issues"]{ background: #8b5cf622; color: #a78bfa; border: 1px solid #8b5cf630; }
.source-badge-pill[data-source="websearch"]    { background: #6366f122; color: #818cf8; border: 1px solid #6366f130; }
.source-badge-pill[data-source="unknown"]      { background: var(--bg2); color: var(--muted); border: 1px solid var(--border); }

/* ── Load more button ── */
.load-more {
  display: flex; align-items: center; justify-content: center;
  padding: 10px 20px; margin-top: 10px;
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--accent2); font-size: 13px; font-weight: 600;
  cursor: pointer; font-family: inherit;
  transition: background .15s, border-color .15s;
}
.load-more:hover { background: var(--bg3); border-color: var(--accent); }

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
  .topnav, .theme-toggle, .filter-btn, .cat-details-toggle, .load-more { display: none !important; }
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
  .evidence-entry-header { gap: 6px; }
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

// ── Evidence drawer: lazy parsing + paginated "Show more" ──

// Lazy-parsed evidence corpus (parsed on first drawer open)
let _evidenceCorpus = null;
function getEvidenceCorpus() {
  if (_evidenceCorpus) return _evidenceCorpus;
  const el = document.getElementById('evidence-store');
  if (!el) return {};
  try {
    _evidenceCorpus = JSON.parse(el.textContent);
  } catch (e) {
    _evidenceCorpus = {};
  }
  return _evidenceCorpus;
}

// Source label abbreviations for pills
const SOURCE_ABBR = {
  reddit: 'R', hackernews: 'HN', google: 'G', appstore: 'AS',
  twitter: 'X', producthunt: 'PH', trustpilot: 'TP', g2: 'G2',
  'github-issues': 'GH', websearch: 'W', unknown: '?',
};

function escAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderEvidenceEntry(entry) {
  const src = entry.source || 'unknown';
  const abbr = SOURCE_ABBR[src] || src.slice(0, 2).toUpperCase();
  const quote = (entry.quote || entry.title || '').slice(0, 500);
  const linkHtml = entry.url
    ? '<a href="' + escAttr(entry.url) + '" target="_blank" rel="noopener">View original \\u2197</a>'
    : '';
  const scoreHtml = entry.score
    ? '<span class="evidence-entry-score">\\u2191' + entry.score + '</span>'
    : '';
  const dateHtml = entry.date
    ? '<span class="evidence-entry-date">' + escAttr(entry.date) + '</span>'
    : '';
  const subHtml = entry.subreddit
    ? '<span class="evidence-entry-subreddit">r/' + escAttr(entry.subreddit) + '</span>'
    : '';

  return '<div class="evidence-entry">'
    + '<div class="evidence-entry-header">'
    +   '<span class="source-badge-pill" data-source="' + escAttr(src) + '">' + escAttr(abbr) + '</span>'
    +   (entry.title ? '<span style="font-size:13px;font-weight:600;color:var(--fg)">' + escAttr(entry.title.slice(0, 120)) + '</span>' : '')
    + '</div>'
    + (quote ? '<p class="evidence-entry-quote">"' + escAttr(quote) + '"</p>' : '')
    + '<div class="evidence-entry-meta">'
    +   scoreHtml + dateHtml + subHtml + linkHtml
    + '</div>'
    + '</div>';
}

// Page size for "Show more"
const EVIDENCE_PAGE_SIZE = 10;

function populateDrawer(detailsEl) {
  if (detailsEl.dataset.loaded === 'true') return;
  detailsEl.dataset.loaded = 'true';

  const corpus = getEvidenceCorpus();
  let citeKeys;
  try {
    citeKeys = JSON.parse(detailsEl.dataset.citeKeys || '[]');
  } catch (e) {
    citeKeys = [];
  }

  // Resolve entries from corpus, filter to those that exist
  const entries = citeKeys.map(k => corpus[k]).filter(Boolean);
  if (entries.length === 0) {
    const container = detailsEl.querySelector('.evidence-drawer-entries');
    if (container) container.innerHTML = '<p class="muted-text">No evidence posts available.</p>';
    return;
  }

  const container = detailsEl.querySelector('.evidence-drawer-entries');
  if (!container) return;

  // Render first page
  let shown = 0;
  const renderPage = () => {
    const end = Math.min(shown + EVIDENCE_PAGE_SIZE, entries.length);
    let html = '';
    for (let i = shown; i < end; i++) {
      html += renderEvidenceEntry(entries[i]);
    }
    // Remove existing "show more" button before appending
    const existingBtn = container.parentElement.querySelector('.load-more');
    if (existingBtn) existingBtn.remove();

    container.insertAdjacentHTML('beforeend', html);
    shown = end;

    // Add "Show more" button if there are remaining entries
    const remaining = entries.length - shown;
    if (remaining > 0) {
      const btn = document.createElement('button');
      btn.className = 'load-more';
      btn.textContent = 'Show more (' + remaining + ' remaining)';
      btn.addEventListener('click', renderPage);
      container.parentElement.appendChild(btn);
    }
  };

  renderPage();
}

// Listen for evidence drawer opens
document.querySelectorAll('.evidence-details').forEach(d => {
  d.addEventListener('toggle', () => {
    if (d.open) populateDrawer(d);
  });
});
`;
}
