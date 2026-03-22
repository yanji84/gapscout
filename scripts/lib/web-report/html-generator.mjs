/**
 * web-report/html-generator.mjs — HTML section builders for the web report
 *
 * Re-exports helpers and provides all the buildXxx() functions used by
 * the web-report orchestrator.
 */

export { escHtml, truncate, stripHtml, DEPTH_COLOR, VERDICT_META, MATRIX_LABELS, SOURCE_ICONS } from './helpers.mjs';
import { escHtml, truncate, DEPTH_COLOR, VERDICT_META, MATRIX_LABELS, SOURCE_ICONS } from './helpers.mjs';
import { buildGaugeSvg, buildDonutSvg, buildMatrixSvg } from './svg-charts.mjs';

// Re-export chart builders for use in the orchestrator
export { buildGaugeSvg, buildDonutSvg, buildMatrixSvg };

// ─── competitor bars ────────────────────────────────────────────────────────

function buildCompetitorBars(allTools) {
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

// ─── section builders ───────────────────────────────────────────────────────

export function buildHero(data) {
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

export function buildCategoryCards(groups) {
  const cards = groups.map((g, idx) => {
    const depthMeta = DEPTH_COLOR[g.depth] || DEPTH_COLOR.surface;
    const verdictMeta = VERDICT_META[g.verdict] || VERDICT_META.needs_evidence;
    const gauge = buildGaugeSvg(g.buildScore || 0, 64, 7);
    const topQuote = g.topQuotes?.[0]?.body || '';
    const sourceBadges = (g.sourceNames || []).map(s =>
      `<span class="source-badge" data-source="${escHtml(s)}">${escHtml(SOURCE_ICONS[s] || s.slice(0, 2).toUpperCase())}</span>`
    ).join('');

    const allQuotes = [
      ...(g.topQuotes || []),
      ...(g.unspokenPain || []).map(b => typeof b === 'string' ? { body: b, score: 0, url: '', _unspoken: true } : { ...b, score: 0, _unspoken: true }),
    ];
    const evidenceHtml = allQuotes.slice(0, 6).map(q => {
      const body = typeof q === 'string' ? q : q.body;
      const score = typeof q === 'object' ? q.score : 0;
      const url = typeof q === 'object' ? (q.url || '') : '';
      const linkOpen = url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener" class="evidence-link">` : '';
      const linkClose = url ? '</a>' : '';
      return `<div class="evidence-item">
        ${linkOpen}<p class="evidence-text">"${escHtml(truncate(body, 240))}"</p>${linkClose}
        <div class="evidence-item-footer">
          ${score ? `<span class="evidence-score">+${score}</span>` : ''}
          ${url ? '<span class="link-icon">\u2197</span>' : '<span class="no-source">no source</span>'}
        </div>
      </div>`;
    }).join('');

    const solutionHtml = (g.solutionAttempts || []).slice(0, 3).map(s => {
      const body = typeof s === 'string' ? s : s.body;
      const url = typeof s === 'object' ? (s.url || '') : '';
      const linkOpen = url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener" class="solution-link">` : '';
      const linkClose = url ? '</a>' : '';
      return `<li class="solution-item">${linkOpen}${escHtml(truncate(body, 160))}${linkClose}${url ? ' <span class="link-icon">\u2197</span>' : ' <span class="no-source">no source</span>'}</li>`;
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
        <summary class="cat-details-toggle">Show full evidence <span class="toggle-arrow">\u25B6</span></summary>
        <div class="cat-details-body">
          ${evidenceHtml ? `<p class="detail-label">Evidence</p><div class="evidence-list">${evidenceHtml}</div>` : ''}
          ${solutionHtml ? `<p class="detail-label">Current Workarounds</p><ul class="solution-list">${solutionHtml}</ul>` : ''}
          ${g.moneyTrail?.examples?.length ? `<p class="detail-label">Money Trail (${g.moneyTrail.strength})</p>
            <div class="money-trail">
              ${g.moneyTrail.examples.slice(0, 3).map(ex => {
                const exUrl = ex.url || '';
                const linkOpen = exUrl ? `<a href="${escHtml(exUrl)}" target="_blank" rel="noopener" class="evidence-link">` : '';
                const linkClose = exUrl ? '</a>' : '';
                return `<div class="money-trail-item">
                  ${linkOpen}<p class="money-body">"${escHtml(truncate(ex.body, 200))}"</p>${linkClose}
                  <div class="money-signals">${(ex.signals || []).map(sig => `<span class="signal-tag">${escHtml(sig)}</span>`).join('')}${exUrl ? '<span class="link-icon">\u2197</span>' : '<span class="no-source">no source</span>'}</div>
                </div>`;
              }).join('')}
            </div>` : ''}
          ${competitorHtml}
          ${g.audience ? `<p class="detail-label">Target Audience</p><p class="detail-text">${escHtml(g.audience)}</p>` : ''}
          ${(g.representativePosts || []).length > 0 ? `<p class="detail-label">Source Posts</p>
            <div class="ref-posts">
              ${g.representativePosts.slice(0, 8).map(p => `<a class="ref-post" href="${escHtml(p.url || '#')}" target="_blank" rel="noopener">
                <span class="ref-source">${escHtml(SOURCE_ICONS[p.source] || p.source || '?')}</span>
                <span class="ref-title">${escHtml(truncate(p.title, 80))}</span>
                <span class="ref-stats">${p.score ? `\u2191${p.score}` : ''} ${p.num_comments ? `\uD83D\uDCAC${p.num_comments}` : ''}</span>
              </a>`).join('')}
            </div>` : ''}
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

export function buildMatrix(groups) {
  const svg = buildMatrixSvg(groups);
  return `<section class="section" id="matrix">
    <h2 class="section-title">Frequency \u00D7 Intensity Matrix</h2>
    <p class="section-sub">Dot size = post count. Position = market opportunity quadrant.</p>
    <div class="matrix-wrap">${svg}</div>
    <div class="matrix-legend">
      <div class="matrix-legend-item q-primary"><span class="matrix-legend-dot"></span> Primary Target \u2014 high freq + high intensity</div>
      <div class="matrix-legend-item q-hidden"><span class="matrix-legend-dot"></span> Hidden Gem \u2014 low freq, high intensity</div>
      <div class="matrix-legend-item q-background"><span class="matrix-legend-dot"></span> Background Noise \u2014 high freq, low intensity</div>
      <div class="matrix-legend-item q-ignore"><span class="matrix-legend-dot"></span> Ignore \u2014 low freq + low intensity</div>
    </div>
  </section>`;
}

export function buildSourceCoverage(meta, groups) {
  const sourceCounts = {};
  for (const g of groups) {
    for (const src of (g.sourceNames || [])) {
      sourceCounts[src] = (sourceCounts[src] || 0) + (g.postCount || 0);
    }
  }
  const segments = Object.entries(sourceCounts).map(([label, value]) => ({ label, value }));
  const donut = buildDonutSvg(segments, 180, 34);

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

export function buildEvidenceWall(groups) {
  const cards = [];
  for (const g of groups) {
    for (const p of (g.representativePosts || [])) {
      cards.push({ body: p.title, score: p.score || 0, signals: [], category: g.category, depth: g.depth, url: p.url, source: p.source, comments: p.num_comments });
    }
    for (const q of (g.topQuotes || [])) {
      cards.push({ body: q.body, score: q.score || 0, signals: q.signals || [], category: g.category, depth: g.depth, url: q.url || '' });
    }
    for (const item of (g.unspokenPain || [])) {
      const body = typeof item === 'string' ? item : item.body;
      const url = typeof item === 'object' ? (item.url || '') : '';
      cards.push({ body, score: 0, signals: [], category: g.category, depth: g.depth, url, unspoken: true });
    }
  }
  if (cards.length === 0) return '';

  cards.sort((a, b) => b.score - a.score);

  const filterBtns = ['all', ...new Set(groups.map(g => g.category))].map(cat =>
    `<button class="filter-btn${cat === 'all' ? ' active' : ''}" data-filter="${escHtml(cat)}">${cat === 'all' ? 'All' : escHtml(cat)}</button>`
  ).join('');

  const cardHtml = cards.map(c => {
    const depthMeta = DEPTH_COLOR[c.depth] || DEPTH_COLOR.surface;
    const linkOpen = c.url ? `<a href="${escHtml(c.url)}" target="_blank" rel="noopener" class="evidence-link">` : '';
    const linkClose = c.url ? '</a>' : '';
    const sourceIcon = c.source ? `<span class="source-badge source-badge-sm" data-source="${escHtml(c.source)}">${escHtml(SOURCE_ICONS[c.source] || c.source.slice(0, 2).toUpperCase())}</span>` : '';
    return `<div class="evidence-card" data-category="${escHtml(c.category)}">
      ${linkOpen}<p class="evidence-card-text">${c.url ? '' : '"'}${escHtml(truncate(c.body, 220))}${c.url ? '' : '"'}</p>${linkClose}
      <div class="evidence-card-footer">
        <span class="cat-pill" style="--depth-color:${depthMeta.css}">${escHtml(c.category)}</span>
        ${sourceIcon}
        ${c.score ? `<span class="evidence-upvotes">\u2191${c.score}</span>` : ''}
        ${c.comments ? `<span class="evidence-comments">\uD83D\uDCAC${c.comments}</span>` : ''}
        ${c.unspoken ? '<span class="unspoken-badge">unspoken</span>' : ''}
        ${c.url ? '<span class="link-icon">\u2197</span>' : ''}
      </div>
    </div>`;
  }).join('');

  return `<section class="section" id="evidence">
    <h2 class="section-title">Evidence Wall</h2>
    <div class="filter-row">${filterBtns}</div>
    <div class="evidence-wall" id="evidenceWall">${cardHtml}</div>
  </section>`;
}

export function buildCompetitorSection(groups) {
  const allTools = groups.flatMap(g => g.tools || []).filter(Boolean);
  const bars = buildCompetitorBars(allTools);
  return `<section class="section" id="competitors">
    <h2 class="section-title">Competitive Landscape</h2>
    <p class="section-sub">Tools and solutions mentioned by users across all sources.</p>
    ${bars}
  </section>`;
}

export function buildLeaderboard(groups) {
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

export function buildIdeaSketches(groups) {
  const sketches = (groups || []).filter(g => g.verdict === 'validated' || g.verdict === 'needs_evidence');
  if (sketches.length === 0) return '';

  const cards = sketches.map((g) => {
    const verdictMeta = VERDICT_META[g.verdict] || VERDICT_META.needs_evidence;
    const gauge = buildGaugeSvg(g.buildScore || 0, 56, 6);
    const categoryName = escHtml(g.category.replace(/-/g, ' '));

    const topQuote = g.topQuotes?.[0]?.body || '';
    const topTitle = g.representativePosts?.[0]?.title || '';
    const problemText = topQuote
      ? `Users are experiencing significant friction with ${categoryName}: "${escHtml(truncate(topQuote, 120))}." This pain is expressed across ${g.postCount} posts from ${g.crossSources} platform(s).`
      : topTitle
        ? `Users repeatedly report problems with ${categoryName}, e.g. "${escHtml(truncate(topTitle, 100))}." ${g.postCount} posts across ${g.crossSources} source(s) confirm this is recurring.`
        : `Users experience recurring frustration with ${categoryName} across ${g.postCount} posts and ${g.crossSources} platform(s).`;

    const audience = escHtml(g.audience || `People frustrated with ${categoryName}`);
    const sourceLabels = (g.sourceNames || []).map(s => {
      if (s === 'reddit') return 'Reddit communities';
      if (s === 'hackernews') return 'Hacker News';
      if (s === 'google') return 'Google Search';
      if (s === 'appstore') return 'App Store / Play Store';
      if (s === 'producthunt') return 'Product Hunt';
      if (s === 'crowdfunding') return 'Kickstarter / Indiegogo';
      if (s === 'reviews') return 'G2 / Capterra';
      return s;
    }).join(', ');
    const mtStrength = g.moneyTrail?.strength || 'none';
    const mtCount = g.moneyTrail?.totalCount || 0;
    const mtExample = g.moneyTrail?.examples?.[0]?.body || '';

    let spendingText;
    if (mtStrength === 'strong') spendingText = `Strong spending signals (${mtCount} WTP instances). ${mtExample ? `E.g.: "${escHtml(truncate(mtExample, 100))}"` : ''}`;
    else if (mtStrength === 'moderate') spendingText = `Moderate spending (${mtCount} WTP instances). ${mtExample ? `E.g.: "${escHtml(truncate(mtExample, 100))}"` : ''}`;
    else if (mtStrength === 'weak') spendingText = `Weak spending signals (${mtCount} instance).`;
    else spendingText = 'No direct spending signals found.';

    const solBodies = (g.solutionAttempts || []).slice(0, 3).map(s => truncate(typeof s === 'string' ? s : s.body, 120));
    const toolList = (g.tools || []).slice(0, 4).map(t => escHtml(t)).join(', ');
    const coreFeature = solBodies.length > 0
      ? `Address the gap exposed by current workarounds: "${escHtml(solBodies[0])}." Build the single feature that eliminates this friction.`
      : `Build a focused tool that directly resolves the core ${categoryName} frustration.`;
    const whyFail = toolList
      ? `Tools like ${toolList} exist, but users still report pain across ${g.crossSources} platform(s).`
      : 'No established tools mentioned \u2014 the market appears underserved.';
    const unspokenHint = g.unspokenPain?.[0];
    const unspokenText = unspokenHint ? (typeof unspokenHint === 'string' ? unspokenHint : unspokenHint.body) : '';
    const differentiator = unspokenText
      ? `Address the unspoken need: "${escHtml(truncate(unspokenText, 120))}." This is the gap competitors miss.`
      : toolList
        ? `Differentiate by solving what ${escHtml((g.tools || [])[0] || 'competitors')} doesn't.`
        : 'First-mover advantage in an underserved market.';

    const pricingText = mtStrength === 'strong' || mtStrength === 'moderate'
      ? `Users show willingness to pay (${mtCount} signals). Start with a low-friction entry price.`
      : 'Limited pricing signals \u2014 validate with a landing page before committing.';

    const topPost = g.representativePosts?.[0];
    const launchText = `${escHtml(sourceLabels)} \u2014 where the pain is loudest (${g.postCount} posts, ${g.totalScore || 0} total engagement).`;
    const contentText = topPost
      ? `Lead with user language: "${escHtml(truncate(topPost.title, 80))}" (${topPost.score || 0} upvotes).`
      : `Frame content around the core ${categoryName} frustration.`;

    const directComp = toolList ? `${toolList} \u2014 mentioned but not fully solving the problem.` : 'No direct competitors identified.';
    const indirectComp = solBodies.length > 0
      ? `Workarounds: "${escHtml(solBodies.slice(0, 2).join('"; "').slice(0, 200))}"`
      : 'Users appear to endure the pain without structured workarounds.';
    const moat = g.crossSources >= 3
      ? `Cross-platform validation (${g.crossSources} sources) \u2014 build a network effect or data moat.`
      : toolList
        ? `Differentiate on UX and pain dimensions that ${escHtml((g.tools || [])[0] || 'competitors')} ignores.`
        : 'First-mover advantage \u2014 build brand loyalty early.';

    const redFlags = [];
    if (mtStrength === 'none') redFlags.push('No WTP signals');
    if (g.crossSources < 2) redFlags.push(`Only ${g.crossSources} source`);
    if (g.depth === 'surface') redFlags.push('Surface-level pain only');
    if (g.postCount < 3) redFlags.push(`Low volume (${g.postCount} posts)`);
    if ((g.tools || []).length >= 5) redFlags.push(`Crowded market (${(g.tools || []).length} tools)`);
    if (redFlags.length === 0) redFlags.push('No major red flags');

    const keyAssumption = mtStrength === 'none'
      ? 'Users will pay for a solution \u2014 pain is clear but WTP unconfirmed.'
      : g.crossSources < 2
        ? `Pain extends beyond ${escHtml(g.sourceNames?.[0] || 'one platform')}.`
        : 'Pain is severe enough to drive adoption and switching.';
    const howToTest = mtStrength === 'none'
      ? 'Landing page with pricing + email capture to validate WTP.'
      : g.depth === 'urgent'
        ? 'Rapid prototype or concierge MVP \u2014 pain is urgent enough for fast adoption.'
        : 'Survey 20-30 users from the communities where pain was found.';

    function subsection(title, content) {
      return `<details class="sketch-subsection">
        <summary class="sketch-subsection-toggle">${title} <span class="toggle-arrow">\u25B6</span></summary>
        <div class="sketch-subsection-body">${content}</div>
      </details>`;
    }

    return `<div class="sketch-card" data-verdict="${g.verdict}">
      <div class="sketch-card-header">
        <div class="sketch-card-left">
          <div class="sketch-gauge">${gauge}</div>
          <div class="sketch-info">
            <h3 class="sketch-name">${categoryName}</h3>
            <div class="sketch-badges">
              <span class="badge ${verdictMeta.cls}">${verdictMeta.label}</span>
              <span class="sketch-score">Build Score: ${g.buildScore || 0}/100</span>
            </div>
          </div>
        </div>
      </div>
      <div class="sketch-body">
        ${subsection('Problem Statement', `<p class="sketch-text">${problemText}</p>`)}
        ${subsection('Target Customer', `
          <div class="sketch-kv">
            <div class="sketch-kv-row"><span class="sketch-kv-label">Who</span><span class="sketch-kv-val">${audience}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Where they hang out</span><span class="sketch-kv-val">${escHtml(sourceLabels)}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Current spending</span><span class="sketch-kv-val">${spendingText}</span></div>
          </div>
        `)}
        ${subsection('Solution Concept (MVP)', `
          <div class="sketch-kv">
            <div class="sketch-kv-row"><span class="sketch-kv-label">Core feature</span><span class="sketch-kv-val">${coreFeature}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Why existing solutions fail</span><span class="sketch-kv-val">${whyFail}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Key differentiator</span><span class="sketch-kv-val">${differentiator}</span></div>
          </div>
        `)}
        ${subsection('Business Model', `
          <div class="sketch-kv">
            <div class="sketch-kv-row"><span class="sketch-kv-label">Pricing</span><span class="sketch-kv-val">${pricingText}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Revenue model</span><span class="sketch-kv-val">SaaS / freemium \u2014 free tier to build user base, premium for power users.</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Est. WTP</span><span class="sketch-kv-val">${mtCount >= 5 ? 'High' : mtCount >= 2 ? 'Moderate' : mtCount >= 1 ? 'Low' : 'Unknown'} (${mtCount} signals)</span></div>
          </div>
        `)}
        ${subsection('Go-to-Market', `
          <div class="sketch-kv">
            <div class="sketch-kv-row"><span class="sketch-kv-label">Launch channel</span><span class="sketch-kv-val">${launchText}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">First 100 customers</span><span class="sketch-kv-val">${(g.sourceNames || []).includes('reddit') ? 'Engage directly in Reddit communities. Post value-first content and offer early access.' : (g.sourceNames || []).includes('hackernews') ? 'Launch with a Show HN post targeting technical users.' : `Reach out to users on ${escHtml(g.sourceNames?.[0] || 'the platform')} who posted about this pain.`}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Content angle</span><span class="sketch-kv-val">${contentText}</span></div>
          </div>
        `)}
        ${subsection('Competitive Landscape', `
          <div class="sketch-kv">
            <div class="sketch-kv-row"><span class="sketch-kv-label">Direct competitors</span><span class="sketch-kv-val">${directComp}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Indirect competitors</span><span class="sketch-kv-val">${indirectComp}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Moat opportunity</span><span class="sketch-kv-val">${moat}</span></div>
          </div>
        `)}
        ${subsection('Risk &amp; Validation', `
          <div class="sketch-kv">
            <div class="sketch-kv-row"><span class="sketch-kv-label">Key assumption</span><span class="sketch-kv-val">${keyAssumption}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">How to test</span><span class="sketch-kv-val">${howToTest}</span></div>
            <div class="sketch-kv-row"><span class="sketch-kv-label">Red flags</span><span class="sketch-kv-val">${redFlags.map(f => `<span class="sketch-red-flag">${escHtml(f)}</span>`).join(' ')}</span></div>
          </div>
        `)}
      </div>
    </div>`;
  }).join('\n');

  return `<section class="section" id="idea-sketches">
    <h2 class="section-title">Idea Sketches</h2>
    <p class="section-sub">Actionable startup sketches for each validated or needs-more-evidence pain point. Click subsections to expand.</p>
    <div class="sketch-cards">${cards}</div>
  </section>`;
}
