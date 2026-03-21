# pain-point-finder

Discover validated pain points, frustrations, and unmet needs from Reddit, Hacker News, Product Hunt, Google, G2/Capterra reviews, Kickstarter, and the Play Store. Posts and reviews are scored using a shared signal engine — pain language, willingness-to-pay evidence, engagement, and negation awareness — then ranked for actionability. Run all sources at once with `pain-points all scan --domain "X"`. No API keys required for most sources.

## Installation

```bash
npm install
```

For sources that require a browser (`browser`, `google`, `ph`, `reviews`, `kickstarter`, `appstore`), Chrome must be running with remote debugging enabled. If you use `puppeteer-mcp-server`, it handles this automatically.

## Quick Start

```bash
# 1. Find relevant subreddits for your domain
pain-points api discover --domain "project management" --limit 8

# 2. Scan top subreddits for pain posts
pain-points api scan --subreddits projectmanagement,SaaS --domain "project management" --days 90 --limit 20

# 3. Deep-dive into top posts to measure validation strength
pain-points api deep-dive --from-scan scan-output.json --top 5
```

All commands output JSON to stdout. Logs go to stderr.

## Available Sources

| Source | Alias | Data | Requires Browser | Commands |
|--------|-------|------|-----------------|---------|
| `reddit-api` | `api` | Historical Reddit via PullPush API | No | `discover`, `scan`, `deep-dive` |
| `reddit-browser` | `browser` | Real-time Reddit via old.reddit.com | Yes | `scan`, `deep-dive` |
| `hackernews` | `hn` | Hacker News via Algolia API | No | `scan`, `deep-dive` |
| `google-autocomplete` | `google` | Google autocomplete + People Also Ask | Yes (with HTTP fallback) | `scan` |
| `producthunt` | `ph` | Product Hunt launches + comments | Yes | `scan` |
| `reviews` | `reviews` | G2/Capterra 1-3 star reviews | Yes | `scan` |
| `crowdfunding` | `kickstarter` | Kickstarter projects + backer comments | Yes | `scan` |
| `appstore` | `appstore` | Google Play Store 1-2 star reviews | Yes | `scan` |
| `coordinator` | `all` | Runs all sources in parallel, merges results | Depends on sources | `scan` |

### reddit-api (`api`)

Historical Reddit data via the PullPush archive API. Fast, no browser needed. Best for large-scale scans and historical trend analysis.

```bash
pain-points api discover --domain "email marketing" --limit 8
pain-points api scan --subreddits emailmarketing,SaaS --days 90 --limit 20
pain-points api deep-dive --post 1inyk7o
pain-points api deep-dive --from-scan scan.json --top 5
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required (discover) | Domain to search |
| `--limit` | 10 / 30 | Max subreddits (discover) or posts (scan) |
| `--subreddits` | required (scan) | Comma-separated list |
| `--days` | 365 | How far back to search |
| `--minScore` | 1 | Min post upvote score |
| `--minComments` | 3 | Min comment count |
| `--pages` | 2 | Pages per query (more = deeper, slower) |
| `--post` | — | Post ID or Reddit URL (deep-dive) |
| `--from-scan` | — | JSON file from a scan run |
| `--top` | 10 | How many scan posts to deep-dive |
| `--maxComments` | 200 | Max comments per post |

### reddit-browser (`browser`)

Real-time Reddit scraping via Puppeteer on old.reddit.com. Use when PullPush is down, rate-limited, or you need current data.

```bash
pain-points browser scan --subreddits PokemonTCG --domain "pokemon tcg" --time year
pain-points browser deep-dive --post https://old.reddit.com/r/PokemonTCG/comments/1k9vcj5/
```

| Flag | Default | Description |
|------|---------|-------------|
| `--subreddits` | required | Comma-separated list |
| `--domain` | — | Domain for relevance boosting |
| `--time` | year | `hour`, `day`, `week`, `month`, `year`, `all` |
| `--minComments` | 3 | Min comment count |
| `--limit` | 30 | Max posts |
| `--post` | — | Post URL or ID (deep-dive) |
| `--from-scan` | — | JSON file from scan |
| `--top` | 10 | How many scan posts to deep-dive |
| `--maxComments` | 200 | Max comments to scrape |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

### hackernews (`hn`)

Searches Hacker News via the Algolia API. Good for B2B/developer pain points.

```bash
pain-points hn scan --domain "project management" --limit 20
pain-points hn deep-dive --post 12345678
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required (scan) | Domain to search |
| `--limit` | 30 | Max posts |
| `--minComments` | 1 | Min comments |
| `--post` | — | HN story ID or URL (deep-dive) |
| `--from-scan` | — | JSON file from scan |
| `--top` | 10 | How many scan posts to deep-dive |

### google-autocomplete (`google`)

Scrapes Google autocomplete suggestions and "People Also Ask" boxes using pain-revealing query templates. Falls back to the `suggestqueries` HTTP API if a CAPTCHA is detected.

```bash
pain-points google scan --domain "notion"
pain-points google scan --domain "slack" --limit 30
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Domain or product name |
| `--limit` | 50 | Max results |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

### producthunt (`ph`)

Scrapes Product Hunt product pages and comment threads for pain signals — feature requests, switching mentions, and complaints.

```bash
pain-points ph scan --domain "project management"
pain-points ph scan --domain "email marketing" --limit 10
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Domain or topic to search |
| `--limit` | 20 | Max products |
| `--maxComments` | 100 | Max comments per product |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

### reviews (`reviews`)

Scrapes 1-3 star reviews from G2 and/or Capterra. Low-star reviews are dense with actionable pain language.

```bash
pain-points reviews scan --domain "project management"
pain-points reviews scan --domain "CRM software" --sources g2,capterra --limit 50
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Product domain to search |
| `--sources` | `g2` | Comma-separated: `g2`, `capterra` |
| `--limit` | 30 | Max reviews |
| `--maxProducts` | 5 | Max products to scrape per source |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

### crowdfunding (`kickstarter`)

Scrapes Kickstarter project pages and backer comment threads for pain signals. Good for finding unmet needs in physical product and hardware spaces.

```bash
pain-points kickstarter scan --domain "smart home"
pain-points kickstarter scan --domain "productivity app" --limit 10
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Domain or keyword to search |
| `--limit` | 20 | Max projects in output |
| `--maxComments` | 60 | Max comments per project |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

### appstore (`appstore`)

Scrapes 1-2 star reviews from Google Play Store apps related to a domain. Low-star mobile reviews surface pain language and willingness-to-pay signals.

```bash
pain-points appstore scan --domain "project management" --limit 20
pain-points appstore scan --domain "todo list" --maxApps 3
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Search query to find apps |
| `--limit` | 30 | Max reviews to return |
| `--maxApps` | 5 | Max apps to scrape per search |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

### coordinator (`all`)

Runs all source modules in parallel for a given domain, deduplicates results by title similarity, and returns a single ranked list. The fastest way to get broad coverage in one command.

```bash
pain-points all scan --domain "project management"
pain-points all scan --domain "SaaS billing" --limit 50
pain-points all scan --domain "pokemon tcg" --sources reddit-api,hackernews
```

| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Problem domain to search |
| `--limit` | 50 | Max posts in final output |
| `--sources` | all | Comma-separated source names to run |
| `--days` | source default | Forwarded to sources that support it |
| `--subreddits` | — | Forwarded to Reddit sources |
| `--dedup-threshold` | 0.6 | Jaccard similarity threshold for deduplication |

## Architecture

```
pain-points <source> <command> [options]
         │
         ▼
  scripts/cli.mjs              — resolves aliases, loads source module, routes command
         │
         ├── sources/reddit-api.mjs         (api)         — PullPush HTTP API
         ├── sources/reddit-browser.mjs     (browser)     — Puppeteer → old.reddit.com
         ├── sources/hackernews.mjs         (hn)          — Algolia HN API
         ├── sources/google-autocomplete.mjs (google)     — Puppeteer → Google
         ├── sources/producthunt.mjs        (ph)          — Puppeteer → producthunt.com
         ├── sources/reviews.mjs            (reviews)     — Puppeteer → G2/Capterra
         ├── sources/crowdfunding.mjs       (kickstarter) — Puppeteer → Kickstarter
         ├── sources/appstore.mjs           (appstore)    — Puppeteer → Google Play
         └── sources/coordinator.mjs        (all)         — runs all sources in parallel
                    │
                    ▼
         lib/scoring.mjs   — shared scoring engine (all sources use this)
         lib/utils.mjs     — shared helpers (HTTP, args, logging)

pain-points report --files scan1.json,scan2.json
         │
         ▼
  scripts/report.mjs       — aggregates multi-source scans → Phase 4-7 Markdown/JSON report
```

Each source module exports `{ name, description, commands, run, help }`. The CLI dynamically loads the right module and calls `source.run(command, args)`.

## Scoring Engine

All sources score posts and reviews through the same pipeline in `scripts/lib/scoring.mjs`.

**Signal categories detected:**

| Category | Examples |
|----------|---------|
| `frustration` | "frustrated", "nightmare", "broken", "unusable", "hate" |
| `desire` | "alternative to", "switched from", "looking for", "wish there was" |
| `cost` | "too expensive", "overpriced", "price hike", "ripoff" |
| `willingness_to_pay` | "would pay", "hired", "wasted hours", "take my money" |
| `intensity` | "literally", "deal breaker", "every single time", "want to scream" |
| `agreement` | "same here", "me too", "can confirm", "exactly this" |

**Scoring features (all R3-refined):**
- Title signals weighted 2x vs body signals
- Body signal contribution capped at 4.0 (prevents long-post inflation)
- Negation detection — "not terrible" does not trigger pain signals
- Sentiment-aware WTP filtering — generic commerce words (e.g. "bought") only count near pain context
- Non-pain title/flair penalties (deck lists, tutorials, announcements, etc.)
- Hard filter: posts with zero pain signals and no strong WTP are excluded
- 9 pain subcategories: `product-availability`, `pricing`, `fraud`, `community-toxicity`, `company-policy`, `shipping`, `grading`, `digital-platform`, `hobby-burnout`

**Deep-dive analysis** (`analyzeComments`) measures:
- `validationStrength`: strong / moderate / weak / anecdotal
- `intensityLevel`: extreme / high / moderate / low
- `agreementCount`: upvote-weighted count of agreement comments
- `moneyTrail`: comments with WTP signals
- `solutionAttempts`: what people tried and why it failed
- `mentionedTools`: competitive landscape extracted from solution comments

## Report Generator

`scripts/report.mjs` aggregates scan output from any combination of sources into a structured Phases 4-7 analysis — pain depth classification, frequency/intensity matrix, WTP analysis, and a ranked verdict list. It applies cross-source validation bonuses (+3 for 2 sources, +5 for 3+).

```bash
# Markdown report (default)
pain-points report --files reddit-scan.json,hn-scan.json,reviews-scan.json

# JSON output for downstream processing
pain-points report --files scan.json --format json

# From stdin
cat scan.json | pain-points report --stdin
```

| Flag | Default | Description |
|------|---------|-------------|
| `--files` | — | Comma-separated scan/deep-dive JSON file paths |
| `--stdin` | — | Read a single scan JSON from stdin |
| `--format` | `md` | Output format: `md` or `json` |

The report covers:
- **Phase 4**: Pain depth classification — surface / active / urgent
- **Phase 5**: Frequency vs intensity matrix — primary target / hidden gem / background noise / ignore
- **Phase 6**: Willingness-to-pay analysis + unspoken pain extraction
- **Phase 7**: Per-pain verdict (Validated / Needs more evidence / Too weak) + final list ranked by build-worthiness score (0-100)

Cross-source validation bonuses are applied automatically: pains appearing on 2 sources get +3 points, 3+ sources get +5 points.

## How to Add a New Source

1. Create `scripts/sources/<name>.mjs`.

2. Export a default object with this shape:

```js
export default {
  name: 'my-source',               // unique identifier
  description: 'One-line summary',
  commands: ['scan'],              // list of supported commands
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `...usage text...`,
};
```

3. Add an alias entry in `scripts/cli.mjs`:

```js
const SOURCE_ALIASES = {
  // ...existing...
  myalias: 'my-source',
  'my-source': 'my-source',
};
```

4. Use shared utilities from `lib/`:

```js
import { log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost, analyzeComments } from '../lib/scoring.mjs';
```

   - `enrichPost(post, domain)` — scores and enriches a normalized post object; returns `null` if it fails the hard pain filter.
   - `analyzeComments(comments, painCategories)` — produces the full agreement/intensity/money-trail breakdown.
   - Normalized post shape: `{ id, title, selftext, subreddit, url, score, num_comments, upvote_ratio, flair, created_utc }`

5. Output results with `ok(data)` (stdout JSON) and progress with `log(msg)` (stderr).

## Improvement History

See [docs/improvement-log.md](docs/improvement-log.md) for the full scoring evolution across three refinement rounds, including false-positive analysis, quality grades, and the Pokemon TCG domain case study.
