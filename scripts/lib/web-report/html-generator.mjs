/**
 * web-report/html-generator.mjs — HTML section builders for the web report
 *
 * Pain discovery research document — focused on evidencing pain points
 * with citation-grounded quotes and signal strength indicators.
 */

export { escHtml, truncate, stripHtml, DEPTH_COLOR, SOURCE_ICONS } from './helpers.mjs';
import { escHtml, truncate, DEPTH_COLOR, SOURCE_ICONS } from './helpers.mjs';
import { buildDonutSvg } from './svg-charts.mjs';

// Re-export chart builders for use in the orchestrator
export { buildDonutSvg };

// ─── signal strength helper ────────────────────────────────────────────────

function getSignalStrength(postCount, crossSources) {
  if (postCount >= 20 && crossSources >= 3) return { label: 'Strong signal', cls: 'signal-strong' };
  if (postCount >= 5 && crossSources >= 2) return { label: 'Moderate signal', cls: 'signal-moderate' };
  return { label: 'Weak signal', cls: 'signal-weak' };
}

// ─── evidence store embed ──────────────────────────────────────────────────

/**
 * Embed the evidenceCorpus as a JSON script tag for client-side lazy parsing.
 */
export function buildEvidenceStore(data) {
  const corpus = data.evidenceCorpus || {};
  if (Object.keys(corpus).length === 0) return '';
  return `<script type="application/json" id="evidence-store">${JSON.stringify(corpus)}</script>`;
}

// ─── verification summary ──────────────────────────────────────────────────

/**
 * Build a report-level verification summary line near the top.
 */
export function buildVerificationSummary(data) {
  const corpus = data.evidenceCorpus || {};
  const groups = data.groups || [];
  const totalCiteKeys = Object.keys(corpus).length;
  if (totalCiteKeys === 0) return '';

  // Count how many citeKeys in groups are actually present in the corpus
  let verified = 0;
  for (const g of groups) {
    for (const key of (g.categoryCiteKeys || [])) {
      if (corpus[key]) verified++;
    }
  }

  return `<div class="verification-summary">
    <span class="verification-icon">\u2713</span>
    ${totalCiteKeys} citation${totalCiteKeys !== 1 ? 's' : ''}, ${verified} verified against scan data
  </div>`;
}

// ─── section builders ───────────────────────────────────────────────────────

export function buildHero(data) {
  const meta = data.meta;
  const domain = data.groups[0]?.category?.replace(/-/g, ' ') || 'Unknown Domain';
  const totalPosts = meta.totalPosts || 0;
  const sourceCount = meta.sources?.length || 0;
  const categoriesFound = meta.categoriesFound || data.groups.length;
  const generated = data.generated || new Date().toISOString();
  const dateStr = new Date(generated).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return `<section class="hero" id="hero">
    <div class="hero-inner">
      <div class="hero-text">
        <p class="hero-eyebrow">Pain Discovery Report</p>
        <h1 class="hero-title">Pain Point Analysis</h1>
        <p class="hero-date">${escHtml(dateStr)}</p>
      </div>
      <div class="hero-stats">
        <div class="hero-kpis">
          <div class="kpi">
            <span class="kpi-val">${totalPosts}</span>
            <span class="kpi-label">Posts Analyzed</span>
          </div>
          <div class="kpi">
            <span class="kpi-val">${sourceCount}</span>
            <span class="kpi-label">Sources</span>
          </div>
          <div class="kpi">
            <span class="kpi-val">${categoriesFound}</span>
            <span class="kpi-label">Pain Categories</span>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

export function buildCategoryCards(groups, data) {
  const hasCorpus = data && data.evidenceCorpus && Object.keys(data.evidenceCorpus).length > 0;

  const cards = groups.map((g, idx) => {
    const depthMeta = DEPTH_COLOR[g.depth] || DEPTH_COLOR.surface;
    const signal = getSignalStrength(g.postCount, g.crossSources);
    const sourceBadges = (g.sourceNames || []).map(s =>
      `<span class="source-badge" data-source="${escHtml(s)}">${escHtml(SOURCE_ICONS[s] || s.slice(0, 2).toUpperCase())}</span>`
    ).join('');

    // Collect all quotes with URLs for citation-grounded display
    const allQuotes = [
      ...(g.topQuotes || []).map(q => ({ body: q.body, score: q.score || 0, url: q.url || '', source: q.source || '' })),
      ...(g.representativePosts || []).map(p => ({ body: p.title, score: p.score || 0, url: p.url || '', source: p.source || '' })),
    ];

    // Only include quotes that have URLs (citation requirement)
    const citedQuotes = allQuotes.filter(q => q.url);
    const uncitedCount = allQuotes.length - citedQuotes.length;

    const topQuotesHtml = citedQuotes.slice(0, 5).map(q => {
      const sourceLabel = q.source ? escHtml(q.source) : 'source';
      return `<div class="cited-quote">
        <a href="${escHtml(q.url)}" target="_blank" rel="noopener" class="cited-quote-link">
          <p class="cited-quote-text">"${escHtml(truncate(q.body, 240))}"</p>
          <span class="cited-quote-source">${sourceLabel} <span class="link-icon">\u2197</span></span>
        </a>
        ${q.score ? `<span class="cited-quote-score">\u2191${q.score}</span>` : ''}
      </div>`;
    }).join('');

    const remainingCount = Math.max(0, citedQuotes.length - 5);
    const remainingHtml = remainingCount > 0
      ? `<p class="cited-more">\u2026 and ${remainingCount} more cited post${remainingCount !== 1 ? 's' : ''}</p>`
      : '';

    // Expandable section for all supporting citations (legacy inline list)
    const allCitationsHtml = citedQuotes.length > 0
      ? citedQuotes.map(q => {
          const sourceLabel = q.source ? escHtml(q.source) : 'source';
          return `<a class="citation-link" href="${escHtml(q.url)}" target="_blank" rel="noopener">
            <span class="citation-source">${sourceLabel}</span>
            <span class="citation-title">${escHtml(truncate(q.body, 100))}</span>
            <span class="link-icon">\u2197</span>
          </a>`;
        }).join('')
      : '<p class="muted-text">No cited sources available for this category.</p>';

    // Evidence drawer: if we have an evidence corpus with categoryCiteKeys, build the drawer
    const citeKeys = g.categoryCiteKeys || [];
    const citeKeysJson = escHtml(JSON.stringify(citeKeys));
    const drawerCount = citeKeys.length;
    const hasDrawer = hasCorpus && drawerCount > 0;

    const evidenceDrawerHtml = hasDrawer
      ? `<details class="cat-details evidence-details" data-cite-keys="${citeKeysJson}" data-loaded="false">
        <summary class="cat-details-toggle evidence-toggle">
          Expand evidence posts (${drawerCount}) <span class="toggle-arrow">\u25B6</span>
        </summary>
        <div class="cat-details-body">
          <div class="evidence-drawer" data-category="${escHtml(g.category)}">
            <div class="evidence-drawer-entries"></div>
          </div>
        </div>
      </details>`
      : '';

    return `<div class="cat-card" data-depth="${g.depth}" data-category="${escHtml(g.category)}" style="--depth-color:${depthMeta.css}">
      <div class="cat-card-header">
        <div class="cat-card-left">
          <div class="cat-info">
            <h3 class="cat-name">#${idx+1} ${escHtml(g.category.replace(/-/g, ' '))}</h3>
            <p class="cat-description">${escHtml(g.audience || '')}</p>
            <div class="cat-meta-row">
              <span class="depth-badge" data-depth="${g.depth}">${depthMeta.label}</span>
              <span class="signal-badge ${signal.cls}">${signal.label}</span>
            </div>
            <div class="cat-stats-row">
              <span class="cat-stat"><b>${g.postCount}</b> posts</span>
              <span class="cat-stat"><b>${g.crossSources}</b> source${g.crossSources !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>
        <div class="cat-card-right">
          <div class="source-badges">${sourceBadges}</div>
        </div>
      </div>
      ${topQuotesHtml ? `<div class="cat-quotes">
        <p class="detail-label">Top Quotes</p>
        ${topQuotesHtml}
        ${remainingHtml}
      </div>` : ''}
      <details class="cat-details">
        <summary class="cat-details-toggle">All supporting citations (${citedQuotes.length}) <span class="toggle-arrow">\u25B6</span></summary>
        <div class="cat-details-body">
          <div class="citations-list">${allCitationsHtml}</div>
        </div>
      </details>
      ${evidenceDrawerHtml}
    </div>`;
  }).join('\n');

  return `<section class="section" id="categories">
    <h2 class="section-title">Pain Categories by Severity</h2>
    <p class="section-sub">Each pain point grounded in cited evidence. Click to expand all citations.</p>
    <div class="cat-cards">${cards}</div>
  </section>`;
}

export function buildSourceCoverage(meta, groups) {
  const sourceCounts = {};
  for (const g of groups) {
    for (const src of (g.sourceNames || [])) {
      sourceCounts[src] = (sourceCounts[src] || 0) + (g.postCount || 0);
    }
  }

  const sourceItems = (meta.sources || []).map(src => {
    const count = sourceCounts[src] || 0;
    const icon = SOURCE_ICONS[src] || src.slice(0, 2).toUpperCase();
    const status = count > 0 ? 'contributed' : 'no data';
    const statusCls = count > 0 ? 'source-status-ok' : 'source-status-empty';
    return `<div class="source-item">
      <span class="source-item-icon" data-source="${escHtml(src)}">${icon}</span>
      <span class="source-item-name">${escHtml(src)}</span>
      <span class="source-item-count">${count} posts</span>
      <span class="source-status ${statusCls}">${status}</span>
    </div>`;
  }).join('');

  return `<section class="section" id="sources">
    <h2 class="section-title">Source Coverage</h2>
    <p class="section-sub">Which data sources contributed to this analysis.</p>
    <div class="source-list">${sourceItems}</div>
  </section>`;
}

export function buildEvidenceWall(groups) {
  const cards = [];
  for (const g of groups) {
    for (const p of (g.representativePosts || [])) {
      if (p.url) {
        cards.push({ body: p.title, score: p.score || 0, category: g.category, depth: g.depth, url: p.url, source: p.source, comments: p.num_comments });
      }
    }
    for (const q of (g.topQuotes || [])) {
      if (q.url) {
        cards.push({ body: q.body, score: q.score || 0, category: g.category, depth: g.depth, url: q.url, source: q.source || '' });
      }
    }
  }
  if (cards.length === 0) return '';

  cards.sort((a, b) => b.score - a.score);

  const filterBtns = ['all', ...new Set(groups.map(g => g.category))].map(cat =>
    `<button class="filter-btn${cat === 'all' ? ' active' : ''}" data-filter="${escHtml(cat)}">${cat === 'all' ? 'All' : escHtml(cat.replace(/-/g, ' '))}</button>`
  ).join('');

  const cardHtml = cards.map(c => {
    const depthMeta = DEPTH_COLOR[c.depth] || DEPTH_COLOR.surface;
    const sourceIcon = c.source ? `<span class="source-badge source-badge-sm" data-source="${escHtml(c.source)}">${escHtml(SOURCE_ICONS[c.source] || c.source.slice(0, 2).toUpperCase())}</span>` : '';
    return `<div class="evidence-card" data-category="${escHtml(c.category)}">
      <a href="${escHtml(c.url)}" target="_blank" rel="noopener" class="evidence-link">
        <p class="evidence-card-text">"${escHtml(truncate(c.body, 220))}"</p>
      </a>
      <div class="evidence-card-footer">
        <span class="cat-pill" style="--depth-color:${depthMeta.css}">${escHtml(c.category.replace(/-/g, ' '))}</span>
        ${sourceIcon}
        ${c.score ? `<span class="evidence-upvotes">\u2191${c.score}</span>` : ''}
        ${c.comments ? `<span class="evidence-comments">\uD83D\uDCAC${c.comments}</span>` : ''}
        <span class="link-icon">\u2197</span>
      </div>
    </div>`;
  }).join('');

  return `<section class="section" id="evidence">
    <h2 class="section-title">Evidence Wall</h2>
    <p class="section-sub">All cited quotes with links to original posts. Filter by category.</p>
    <div class="filter-row">${filterBtns}</div>
    <div class="evidence-wall" id="evidenceWall">${cardHtml}</div>
  </section>`;
}

export function buildDataWarnings(meta) {
  const rms = meta.rateMonitorSummary;
  if (!rms) return '';

  const { warnings = [], blocks = [], errors = [] } = rms;
  const total = warnings.length + blocks.length + errors.length;
  if (total === 0) return '';

  const sourceMap = new Map();
  const bump = (source, field, entry) => {
    if (!sourceMap.has(source)) sourceMap.set(source, { warnings: [], blocks: [], errors: [] });
    sourceMap.get(source)[field].push(entry);
  };
  for (const w of warnings) bump(w.source, 'warnings', w);
  for (const b of blocks) bump(b.source, 'blocks', b);
  for (const e of errors) bump(e.source, 'errors', e);

  const rows = [...sourceMap].map(([source, counts]) => {
    const parts = [];
    if (counts.blocks.length > 0) parts.push(`${counts.blocks.length} block(s)`);
    if (counts.errors.length > 0) parts.push(`${counts.errors.length} error(s)`);
    if (counts.warnings.length > 0) parts.push(`${counts.warnings.length} warning(s)`);
    const status = counts.blocks.length > 0 ? 'Partial results' : 'Completed with warnings';
    const allEntries = [...counts.blocks, ...counts.errors, ...counts.warnings];
    const detail = allEntries[0]?.message || 'Rate limit issue encountered';

    return `<div class="warning-row">
      <span class="warning-source">${escHtml(source)}</span>
      <span class="warning-status">${status}</span>
      <span class="warning-detail">${escHtml(parts.join(', '))} — ${escHtml(detail)}</span>
    </div>`;
  }).join('');

  return `<section class="section" id="warnings">
    <h2 class="section-title">Data Collection Warnings</h2>
    <p class="section-sub">Some sources encountered issues during collection. Results may be partial.</p>
    <div class="warning-list">${rows}</div>
  </section>`;
}
