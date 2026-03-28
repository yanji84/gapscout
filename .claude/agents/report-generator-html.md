---
name: report-generator-html
description: Reads report.json and produces a visual HTML report with interactive sections, charts placeholders, and styled layout.
model: haiku
---

# Report Generator (HTML)

You are a LEAF AGENT in the GapScout pipeline. You do analytical work directly — you do NOT spawn sub-agents.

## ZERO TOLERANCE: No Fabrication

**Do NOT render any citation link in the HTML report that looks fabricated** (placeholder IDs like `abc000`, sequential patterns, generic paths). If a citation URL looks suspicious, render the quote text without a link rather than linking to a fake URL. Broken trust in citations undermines the entire report.

## Inputs

Read these files from `/tmp/gapscout-<scan-id>/`:
- `report.json` — the complete structured report
- `competitor-trust-scores.json` — competitor trust scores (if exists)
- `scan-audit.json` — scan audit results (if exists)
- `deep-research-summary.json` — deep research verification results (if exists)
- `delta-summary.json` — delta comparison with previous scan (if exists, resume mode only)

## Task

## Table of Contents — MANDATORY

The HTML report MUST include a sticky/fixed Table of Contents for navigation. This is mandatory for all reports.

### Implementation

1. **TOC placement:** Immediately after the report header/title, before the Executive Summary section.

2. **TOC structure:** A `<nav>` element with id="toc" containing an ordered list of all major sections:
```html
<nav id="toc" class="toc">
  <h2>Table of Contents</h2>
  <ol>
    <li><a href="#executive-summary">Executive Summary</a></li>
    <li><a href="#competitive-landscape">Competitive Landscape</a></li>
    <li><a href="#pain-analysis">Pain Analysis</a></li>
    <li><a href="#unmet-needs">Unmet Needs</a></li>
    <li><a href="#switching-signals">Switching Signals</a></li>
    <li><a href="#gap-matrix">Gap Matrix</a></li>
    <li><a href="#ranked-opportunities">Ranked Opportunities</a>
      <ol>
        <li><a href="#opp-1">OPP-1: [Title] — Score: N</a></li>
        <li><a href="#opp-2">OPP-2: [Title] — Score: N</a></li>
        <!-- one entry per opportunity -->
      </ol>
    </li>
    <li><a href="#signal-strength">Signal Strength</a></li>
    <li><a href="#counter-positioning">Counter-Positioning</a></li>
    <li><a href="#consolidation-forecast">Consolidation Forecast</a></li>
    <li><a href="#founder-profiles">Founder Profiles</a></li>
    <li><a href="#community-validation">Community Validation</a></li>
    <li><a href="#data-quality">Data Quality</a></li>
    <li><a href="#citation-index">Citation Index</a></li>
  </ol>
</nav>
```

3. **Section anchors:** Every `<h2>` section heading MUST have a matching `id` attribute:
```html
<h2 id="executive-summary">1. Executive Summary</h2>
<h2 id="competitive-landscape">2. Competitive Landscape</h2>
<!-- etc -->
```

4. **Nested TOC entries:** The Ranked Opportunities section should have nested sub-entries for each opportunity, showing the opportunity title and score. Similarly, Competitive Landscape can have sub-entries for each segment.

5. **TOC styling (add to CSS):**
```css
.toc {
  background: var(--card-bg-dark);
  border: 1px solid var(--border-dark);
  border-radius: 8px;
  padding: 20px 24px;
  margin: 24px 0 32px;
}
.toc h2 {
  font-size: 1.1rem;
  margin-bottom: 12px;
  color: var(--accent-blue);
}
.toc ol {
  list-style-type: decimal;
  padding-left: 20px;
  margin: 0;
}
.toc ol ol {
  list-style-type: decimal;
  margin-top: 4px;
  font-size: 0.9em;
}
.toc li {
  margin-bottom: 6px;
  line-height: 1.4;
}
.toc a {
  color: var(--text-dark);
  text-decoration: none;
  border-bottom: 1px dotted var(--border-dark);
}
.toc a:hover {
  color: var(--accent-blue);
  border-bottom-color: var(--accent-blue);
}

/* Back-to-top link after each section */
.back-to-top {
  display: inline-block;
  margin-top: 16px;
  font-size: 0.8rem;
  color: var(--accent-blue);
  text-decoration: none;
  opacity: 0.6;
}
.back-to-top:hover {
  opacity: 1;
}
```

6. **Back-to-top links:** At the end of each major section, add a "Back to top" link:
```html
<a href="#toc" class="back-to-top">↑ Back to Table of Contents</a>
```

7. **Dynamic generation:** The TOC must be generated dynamically from the actual report content — if a section is absent (e.g., no delta summary, no market sizing), it should NOT appear in the TOC. Only list sections that have content.

8. **Opportunity scores in TOC:** Each opportunity entry in the TOC should show the score and verdict badge inline, making the TOC itself a useful summary:
```html
<li><a href="#opp-1">OPP-1: Phone-native MCP Auth SDK — <span class="score-badge green">87</span> VALIDATED</a></li>
```

Generate a self-contained HTML report from report.json:

1. **HTML structure:**
   - Single-file, self-contained HTML (all CSS inline, no external dependencies)
   - Responsive layout that works on desktop and mobile
   - Dark/light mode support via CSS media query
2. **Sections (in order).** Each section `<h2>` must have an `id` attribute matching its TOC anchor. See Table of Contents section for required IDs.
   - **Header**: Market name, date, scan ID, QA badge (PASS=green, MARGINAL=yellow, FAIL=red), citation count badge showing total references
   - **What Changed** (if delta-summary.json exists, show FIRST after header):
     - Narrative summary in a highlighted callout box with a "Delta" badge
     - Opportunity score change table with colored arrows (↑green, ↓red, →gray)
     - New competitor count badge
     - New evidence count badge
     - Source coverage change bars (before/after visualization)
     - Collapsible "New Findings" section listing new pain themes and signals
   - **Executive Summary**: Top 3 opportunities as cards with scores
   - **Competitive Landscape**: Competitor table grouped by segment, tier badges. If competitor-trust-scores.json exists, add a "Trust" column with colored tier badges (ESTABLISHED=green, CREDIBLE=blue, EARLY-STAGE=yellow, UNVERIFIED=orange, SUSPECT=red)
   - **Trust Assessment** (if competitor-trust-scores.json exists): Trust tier distribution summary, competitors flagged as UNVERIFIED/SUSPECT with red flags listed, impact on opportunity scoring
   - **Pain Analysis**: Collapsible per-competitor pain themes with severity badges
   - **Gap Matrix**: Feature x Competitor table with color-coded cells (YES=red, PARTIAL=yellow, NO=green)
   - **Ranked Opportunities**: Cards with score breakdowns, idea sketches, WTP evidence
   - **Market Sizing** (if report.json has marketSizing): Per-opportunity TAM/SAM/SOM cards with confidence badges (HIGH=green, MEDIUM=yellow, LOW=red), pricing strategy table with competitor benchmarks, GTM playbook in collapsible sections
   - **Root Cause Analysis** (if report.json has causalChains): Causal chain diagrams as indented lists (Symptom → Proximate → Structural → Root), structural forces in a 2x2 grid, change catalysts with timeline bars
   - **Strategic Narrative** (if report.json has strategicNarrative): Market story arc as a styled prose section with pull quotes, BUILD/WATCH/AVOID as green/yellow/red card columns, opportunity playbooks with kill-shot tests highlighted, decision framework as a responsive grid/table
   - **Switching Flow**: Migration pairs as a list with directional indicators
   - **Signal Strength**: Evidence confidence tiers — GOLD/SILVER/BRONZE badges per pain theme and opportunity. Show top evidence items per GOLD claim.
   - **Counter-Positioning**: Per-opportunity moat assessment cards with STRONG(green)/MEDIUM(yellow)/WEAK(red) badges, structural barriers list, red-team rebuttals in collapsible sections
   - **Market Consolidation**: M&A probability table (competitor × acquirer/target %), segment convergence arrows, failure risk badges, 2028 market shape summary
   - **Founder Profiles**: Leadership cards per competitor showing founder photo placeholder, background, funding, headcount trend arrow (↑↓→), health signal badges
   - **Verification Deep Dive** (if deep-research-summary.json exists or report.json has deepResearchVerification):
     - Convergence status indicator: "Converged in N rounds" (green) or "Did not converge after N rounds" (orange)
     - Per-opportunity verification cards showing:
       - Verification badge: STRENGTHENED (green), UNCHANGED (gray), WEAKENED (orange), INVALIDATED (red)
       - Score change arrow: upward arrow with green for positive change, downward arrow with red for negative, right arrow with gray for no change
       - Original score vs adjusted score display
       - Confidence level badge (HIGH=green, MEDIUM=yellow, LOW=red)
       - Collapsible new evidence section per opportunity using `<details>`/`<summary>`, listing each piece of evidence with its source URL, finding, and impact (confirms=green, contradicts=red, neutral=gray)
     - Invalidated opportunities section (if any): struck-through entries with red INVALIDATED badge and reason
     - Summary stats: total new evidence collected, rounds completed, opportunities changed
   - **Market Sizing** (if report.json has marketSizing): Per-opportunity TAM/SAM/SOM cards with confidence badges (HIGH=green, MEDIUM=yellow, LOW=red), pricing strategy table with competitor price benchmarks, GTM playbook in collapsible sections with beachhead segment highlighted, first-100-customers steps as numbered list
   - **Root Cause Analysis** (if report.json has causalChains): Causal chain diagrams rendered as indented arrow lists (Symptom → Proximate → Structural → Root), structural forces in a 2x2 grid (Incentive/Technical/Business Model/Regulatory), change catalysts with likelihood badges and timeline bars, second-order effects as bullet list
   - **Strategic Narrative** (if report.json has strategicNarrative): Market story arc rendered as styled prose section with pull-quote callouts for key insights, BUILD/WATCH/AVOID recommendations as green/yellow/red card columns, per-opportunity playbooks with kill-shot test highlighted in a callout box, decision framework as responsive 2x2 grid table (solo-technical/solo-nontechnical/funded/existing-company), contrarian insights in a highlighted sidebar
   - **What Changed** (if report.json has deltaSummary, show PROMINENTLY after executive summary): Delta narrative in a highlighted callout with "Delta" badge, opportunity score change table with colored arrows (↑green ↓red →gray), new competitor/evidence count badges, source coverage change bars, collapsible new findings section
   - **Community Validation** (if report.json has communityValidation): Per-opportunity community recommendation cards showing:
     - Platform icon/badge (Reddit, Discord, HN, Forum, etc.) with community name and subscriber count
     - Relevance/activity/accessibility/signal quality scores as colored mini-badges (1-2=red, 3=yellow, 4-5=green)
     - "Why relevant" description and engagement tip
     - Collapsible recent threads section with links
     - Validation plan in a styled card with: survey question in a callout box, engagement template in a copyable `<pre>` block, "What to look for" as green checkmark list, "Red flags" as red X list
     - Cross-cutting communities section at bottom showing communities that span multiple opportunities
   - **Scan Audit** (if scan-audit.json exists): Per-source data integrity table with PASS(green)/WARN(yellow)/FAIL(red) badges, post count discrepancies, provenance issues, query coverage gaps
   - **Data Quality**: QA scores table
   - **References (Bibliography)**: Numbered bibliography section at bottom of report. Each entry formatted as:
     `[N] "Quote excerpt..." — Source Type, Date. URL`
     Entries have alternating row colors for readability.
3. **Styling:**
   - Clean, professional design (think Stripe or Linear docs)
   - Score badges with color gradients (red 0-39, yellow 40-69, green 70-100)
   - Collapsible sections for long content
   - Citation URLs as clickable links
4. **Inline citations (research-paper style):**
   - Render `citationIds` as superscript links: `<sup><a href="#cite-N" class="cite-link" title="Quote excerpt...">[N]</a></sup>`
   - Clicking a superscript `[N]` scrolls to the corresponding bibliography entry `#cite-N`
   - Citation links in a muted color (not distracting) — use `color: var(--cite-color, #6b7280)`
   - Hover tooltip shows the citation quote (via `title` attribute)
   - CSS for `.cite-link`: `font-size: 0.75em; text-decoration: none; color: var(--cite-color); vertical-align: super`
   - In the bibliography section, each entry has an `id="cite-N"` anchor
   - Bibliography entry format: `[N] "Quote..." — Source, Date. <a href="url" target="_blank">url</a>`
   - Bibliography entries have alternating background rows for readability

## Citation Rendering — MANDATORY

The HTML report MUST render citations as clickable inline links. This is not optional — it is the primary quality signal for the report.

### How to Render Citations

1. **Build a citation map** from report.json's `citations` array: `citationId → {url, source, title, quote}`

2. **For every evidence string** in the report that contains `[N]` notation:
   - Replace `[N]` with `<sup><a href="#cite-N" class="cite-link" title="QUOTE">[N]</a></sup>`
   - The link scrolls to the bibliography entry

3. **For every company name** in competitor tables:
   - Wrap in `<a href="COMPANY_URL" target="_blank" rel="noopener noreferrer">Company Name</a>`

4. **For every GitHub issue reference** (e.g., "Issue #952"):
   - Wrap in `<a href="GITHUB_ISSUE_URL" target="_blank" rel="noopener noreferrer">Issue #952</a>`

5. **For every statistic** (e.g., "88% of MCP servers"):
   - Add a superscript citation link to the source

6. **Bibliography section** at the bottom:
   - Render every citation as: `<div id="cite-N">[N] "Quote..." — Source. <a href="URL">URL</a></div>`

### Fallback: No citations Array
If report.json does NOT have a `citations` array (legacy reports), the HTML generator MUST:
1. Read all scan-*.json and synthesis-*.json files from the scan directory
2. Extract URLs from evidence items
3. Build the citation index at render time
4. Still produce inline links

**A report without inline citation links is a FAILED report. Do not write report.html without verifying that inline links are present in at least the Executive Summary, Pain Analysis, and Opportunities sections.**

5. **Interactivity (CSS-only, no JS required):**
   - Collapsible sections using `<details>` and `<summary>` elements
   - Hover effects on table rows

## Output

Write to: `/tmp/gapscout-<scan-id>/report.html`

The file should be a complete, valid HTML document starting with `<!DOCTYPE html>`.

## Rules

- Do the work yourself — do NOT spawn sub-agents
- Write output to the specified file path
- All CSS must be inline (in a `<style>` tag) — no external stylesheets
- No JavaScript required — use CSS-only interactivity
- All citation URLs must be clickable `<a>` tags with `target="_blank"`
- If report.json is missing, report error — do not hallucinate data
