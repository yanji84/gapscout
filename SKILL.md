---
name: gapscout
description: >-
  Discover pain points, frustrations, and unmet needs on Reddit, Hacker News, Product Hunt,
  Google, G2/Capterra, Kickstarter, and the Play Store. No API keys required for most sources.
  Use to find startup ideas backed by real user complaints.
metadata: {"clawdbot":{"emoji":"🔬","requires":{"bins":["node"]},"entryAgent":".claude/agents/orchestrator.md"}
}
---

# GapScout

Discover validated pain points and market gaps across multiple platforms. Searches for frustrations, complaints, and unmet needs, then analyzes comment threads for agreement signals, emotional intensity, willingness-to-pay evidence, and failed solutions.

**Entry point**: Spawn the orchestrator agent at `.claude/agents/orchestrator.md`. The user provides a market name, named competitors, or nothing (HN frontpage mode). The orchestrator handles everything from there — planning, discovery, scanning, synthesis, QA, and report generation.

```
User says: "Run GapScout on the project management tools market"
→ Spawn orchestrator agent
→ Orchestrator takes it from here (~225 agents across 5 stages)
```

See [README.md](README.md) for full source documentation and flag reference.

## Pipeline Overview

The orchestrator manages a 5-phase pipeline end-to-end. Each phase is described below. All stage transitions, agent spawning, QA gates, and runtime adaptations are owned by the orchestrator — individual agents never auto-proceed on their own.

### Phase 1: Planning (managed by orchestrator)

The orchestrator spawns a **planner** agent that researches the market and produces a `scan-spec.json`. The orchestrator reads the spec and makes runtime decisions about agent counts, source priorities, and rate budgets based on market density and source viability.

### Phase 2: Discovery (managed by orchestrator)

The orchestrator spawns 4 discovery agents in parallel:
- **market-mapper** — finds competitors and maps the landscape
- **profile-scraper** — scrapes competitor profiles
- **subreddit-discoverer** — finds relevant subreddits
- **query-generator** — builds search queries for scanning

After discovery completes, the orchestrator spawns a **discovery QA** team (judge + documenter). Based on the QA verdict, the orchestrator decides whether to proceed, retry specific agents, or continue with degraded data.

### Phase 3: Scanning (managed by orchestrator)

The orchestrator spawns the scanning team based on its runtime config. This includes Category A coordinators (competitor-specific: reviews, Trustpilot, App Store), Category B scanners (market-wide: Reddit, HN, Google, Product Hunt), and specialist agents (websearch, switching signals). Sources that are degraded or irrelevant to the market type are skipped.

After scanning completes, the orchestrator runs **scanning QA** — the most critical QA gate. Failed sources may be retried, skipped, or noted as degraded for synthesis.

### Phase 4: Synthesis (managed by orchestrator)

The orchestrator spawns a **synthesizer-coordinator** that runs 7 sequential sprints internally (competitive map, competitor pain, unmet needs, switching signals, gap matrix, opportunities, rescue). The orchestrator does not manage individual sprints — the coordinator owns that.

After synthesis, the orchestrator runs **synthesis QA** and owns the iteration loop: if the judge returns MARGINAL or FAIL, the orchestrator re-spawns the synthesizer for failing sprints, then re-runs QA. Max 3 iteration rounds before shipping with a weakness note.

### Phase 5: Report Generation (managed by orchestrator)

The orchestrator spawns 3 report agents in parallel:
- **report-generator-json** — produces `report.json`
- **report-generator-html** — produces `report.html`
- **report-summary-presenter** — produces an executive summary

The orchestrator then presents final results to the user, including top opportunities, stats, QA grades, deliverable paths, and any data quality notes.

## CLI Commands (used by agents internally)

The following CLI commands are used by agents within the pipeline. They are documented here for reference and debugging.

**Entry point**: `gapscout <source> <command> [options]`

Available sources: `api` (Reddit/PullPush), `browser` (Reddit/Puppeteer), `hn` (Hacker News), `google` (Google autocomplete), `ph` (Product Hunt), `reviews` (G2/Capterra), `kickstarter` (Kickstarter), `appstore` (Google Play), `all` (all sources in parallel).

### Discover Subreddits

```bash
gapscout api discover --domain "<domain>" --limit 8
```

### Scan for Pain Points

**Quick option — run everything at once:**
```bash
gapscout all scan --domain "<domain>" --limit 50
```

Or run sources individually for more control. Start with Reddit:

```bash
gapscout api scan \
  --subreddits "<sub1>,<sub2>,<sub3>" \
  --domain "<domain>" \
  --days 90 \
  --limit 20
```

Optionally supplement with other sources:

```bash
# Hacker News (good for B2B/developer domains)
gapscout hn scan --domain "<domain>" --limit 20

# Google autocomplete (surface how people phrase their problems)
gapscout google scan --domain "<domain>"

# Low-star software reviews (dense pain language)
gapscout reviews scan --domain "<domain>" --sources g2,capterra

# Kickstarter backer comments (hardware / physical product spaces)
gapscout kickstarter scan --domain "<domain>"

# Google Play 1-2 star reviews (mobile app pain points)
gapscout appstore scan --domain "<domain>"
```

### Deep-Dive Analysis

Single post:
```bash
gapscout api deep-dive --post <post_id>
```

Top N from scan output:
```bash
gapscout api deep-dive --from-scan <scan_output.json> --top 5
```

For browser-scraped posts use `gapscout browser deep-dive`. For HN posts use `gapscout hn deep-dive`.

### Browser Mode (Alternative Reddit Source)

When PullPush is unavailable, rate-limited, or you want real-time data, use the browser source. It scrapes old.reddit.com via Puppeteer, reusing an existing Chrome session (e.g. from puppeteer-mcp-server).

**Prerequisites**: Chrome running with remote debugging (puppeteer-mcp-server does this automatically). Install deps: `npm install` in the skill directory.

```bash
# Browser scan
gapscout browser scan \
  --subreddits "<sub1>,<sub2>,<sub3>" \
  --domain "<domain>" \
  --time year \
  --limit 20

# Browser deep-dive
gapscout browser deep-dive --post <url_or_id>
gapscout browser deep-dive --from-scan <scan_output.json> --top 5
```

| | API mode (`api`) | Browser mode (`browser`) |
|---|---|---|
| **Speed** | Faster (API calls) | Slower (page loads) |
| **Data freshness** | Archive (may lag hours/days) | Real-time |
| **Login required** | No | No (but benefits from logged-in session) |
| **Rate limits** | PullPush limits (can be strict) | Reddit page loads (be polite) |
| **Reliability** | Depends on PullPush uptime | Depends on Chrome + Reddit DOM |
| **Best for** | Large-scale scans, historical data | Targeted scans, when PullPush is down |

Output format is identical between modes — both produce `{ ok: true, data: { posts: [...] } }` with the same scoring fields, so downstream analysis works with either.

## Options Reference

For the full flag reference for all sources, see [README.md](README.md).

### api discover
| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Domain to explore |
| `--limit` | 10 | Max subreddits to return |

### api scan
| Flag | Default | Description |
|------|---------|-------------|
| `--subreddits` | required | Comma-separated subreddit list |
| `--domain` | | Domain for extra search queries |
| `--days` | 365 | How far back to search |
| `--minScore` | 1 | Min post score filter |
| `--minComments` | 3 | Min comment count filter |
| `--limit` | 30 | Max posts to return |
| `--pages` | 2 | Pages per query (more = deeper, slower) |

### api deep-dive
| Flag | Default | Description |
|------|---------|-------------|
| `--post` | | Single post ID or Reddit URL |
| `--from-scan` | | Path to scan output JSON |
| `--stdin` | | Read scan JSON from stdin |
| `--top` | 10 | How many posts to analyze from scan |
| `--maxComments` | 200 | Max comments to fetch per post |

### browser scan / deep-dive
Same flags as above plus:

| Flag | Default | Description |
|------|---------|-------------|
| `--time` | year | Time filter: hour, day, week, month, year, all |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

## Rate Limits

The script self-limits to 1 request/sec, 30/min, 300/run. If PullPush is slow or returns errors, it retries with exponential backoff. Progress is logged to stderr.

## Tips

- Start broad with `--days 90` then narrow to `--days 30` for recent trends
- High `num_comments` + high `score` = validated pain (many people agree)
- High `painScore` + low `num_comments` = niche pain (worth investigating)
- High `intensity` + high `wtpSignals` = urgent buying pain — prioritize these
- The `moneyTrail` in deep-dive output shows actual spending evidence
- The `mentionedTools` maps the competitive landscape
- Posts with `validationStrength: "strong"` + `intensityLevel: "high"` are the best startup candidates
