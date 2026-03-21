---
name: pain-point-finder
description: >-
  Discover pain points, frustrations, and unmet needs on Reddit using PullPush API.
  No API keys required. Use to find startup ideas backed by real user complaints.
metadata: {"clawdbot":{"emoji":"🔬","requires":{"bins":["node"]}}
}
---

# Pain Point Finder

Discover validated pain points on Reddit. Searches for frustrations, complaints, and unmet needs, then analyzes comment threads for agreement signals, emotional intensity, willingness-to-pay evidence, and failed solutions. Powered by PullPush API — no API keys needed.

## Workflow

Follow these 7 phases in order. Phases 1-3 are script-driven data collection. Phases 4-7 are your analysis of the collected data.

### Phase 1: Discover Subreddits

Find the right subreddits for the user's domain.

```bash
node {baseDir}/scripts/pain-points.mjs discover --domain "<user's domain>" --limit 8
```

Take the top 3-5 subreddits from the output for phase 2.

### Phase 2: Scan for Pain Points

Broad search across discovered subreddits.

```bash
node {baseDir}/scripts/pain-points.mjs scan \
  --subreddits "<sub1>,<sub2>,<sub3>" \
  --domain "<domain>" \
  --days 90 \
  --limit 20
```

Review the scored posts. Posts with high `painScore`, high `num_comments`, `wtpSignals`, and high `intensity` are the best candidates for deep analysis.

### Phase 3: Deep-Dive Analysis

Analyze comment threads of top posts for agreement, money trail, and intensity signals.

Single post:
```bash
node {baseDir}/scripts/pain-points.mjs deep-dive --post <post_id>
```

Top N from scan output:
```bash
node {baseDir}/scripts/pain-points.mjs deep-dive --from-scan <scan_output.json> --top 5
```

Key fields in the output:
- **validationStrength**: strong / moderate / weak / anecdotal
- **intensityLevel**: extreme / high / moderate / low
- **moneyTrailCount**: how many comments show willingness-to-pay signals
- **moneyTrail**: actual quotes showing spending, hiring, or time investment
- **solutionAttempts**: what people have tried and why it failed
- **mentionedTools**: competitive landscape

### Phase 4: Pain Depth Classification

For each pain point from the deep-dive results, classify it into one of three depth levels:

- **Surface frustration**: People mention it but aren't actively seeking a fix. Low agreement, low intensity. They complain but tolerate it.
- **Active pain**: People are looking for solutions. They post "looking for", "alternative to", "does anyone know" queries. Moderate-to-high agreement, some solution attempts.
- **Urgent problem**: People are spending money or significant time right now. High `moneyTrailCount`, high intensity, multiple failed solution attempts. They're paying consultants, buying tools, or wasting hours on workarounds.

Present the classification in a table with the pain, its depth level, and the key evidence.

### Phase 5: Frequency vs Intensity Matrix

Map pains on two dimensions using the data already collected:

- **Frequency**: How often it comes up across posts (post count, agreement count, multiple subreddits mentioning it)
- **Intensity**: How emotionally charged the language is (`intensityLevel`, presence of extreme language in `topQuotes`)

Categorize each pain:
- **Primary target** (frequent + intense): Build for this — validated demand with emotional urgency
- **Hidden gem** (infrequent + intense): Niche but desperate users — could be a premium play
- **Background noise** (frequent + low intensity): Common annoyance, low willingness to pay
- **Ignore** (infrequent + low intensity): Not worth pursuing

### Phase 6: Willingness-to-Pay & Unspoken Pain Analysis

Two tasks here:

**Money trail analysis**: Using the `moneyTrail` data from deep-dive, identify which pains have visible spending signals — tools bought, consultants hired, hours wasted, subscriptions tried. Rank pains by strength of the money trail. A pain with no money trail is a complaining pain, not a buying pain.

**Unspoken pain extraction**: Read the `topQuotes` and `solutionAttempts` carefully. What are people actually frustrated about underneath the surface complaint? Look for patterns:
- Complaints about a tool that are really about a broken workflow
- Cost complaints that are really about feeling locked in
- Feature requests that reveal a deeper unmet need
- Frustration with complexity that signals a need for simplification

For each unspoken pain found, state: the surface complaint, the real underlying pain, and why you believe this.

### Phase 7: Verdict & Opportunity Synthesis

For each validated pain point, present a structured proposal:

1. **Problem**: One-sentence description of the pain
2. **Depth**: Surface / Active / Urgent (from Phase 4)
3. **Matrix position**: Primary target / Hidden gem / Background noise (from Phase 5)
4. **Evidence**: Top quotes + agreement count + subreddit
5. **Who feels this**: Type of person/business affected
6. **Current solutions & gaps**: What people have tried (from `solutionAttempts`) and why it fails
7. **Competitive landscape**: Tools mentioned (from `mentionedTools`)
8. **Money trail**: Evidence of spending or willingness to pay
9. **Unspoken pain**: The deeper need underneath (from Phase 6)
10. **Opportunity**: What's missing in current solutions
11. **Idea sketch**: Brief product/service concept

**Final verdict** for each pain — one of:
- **Validated**: Urgent depth + primary target or hidden gem + strong money trail. Build this.
- **Needs more evidence**: Active depth with moderate signals. Worth a deeper scan with different subreddits or timeframes.
- **Too weak to build on**: Surface frustration, background noise, no money trail. Move on.

End with a ranked list of all pains by build-worthiness.

## Browser Mode (Alternative Data Source)

When PullPush is unavailable, rate-limited, or you want real-time data from a logged-in Reddit session, use the browser-based mode. It scrapes old.reddit.com via Puppeteer, reusing an existing Chrome session (e.g. from puppeteer-mcp-server).

**Prerequisites**: Chrome running with remote debugging (puppeteer-mcp-server does this automatically). Install deps: `npm install` in the skill directory.

### Browser Scan

```bash
node {baseDir}/scripts/browser-scan.mjs scan \
  --subreddits "<sub1>,<sub2>,<sub3>" \
  --domain "<domain>" \
  --time year \
  --limit 20
```

This searches old.reddit.com with pain-oriented queries (frustration, desire, cost keywords) and scrapes the results. It auto-detects the Chrome instance.

### Browser Deep-Dive

```bash
node {baseDir}/scripts/browser-scan.mjs deep-dive --post <url_or_id>
```

Or from scan output:
```bash
node {baseDir}/scripts/browser-scan.mjs deep-dive --from-scan <scan_output.json> --top 5
```

Scrapes the actual comment thread from old.reddit.com and runs the same analysis (agreement, intensity, money trail, solution attempts) as the API mode.

### When to use browser mode vs API mode

| | API mode (pain-points.mjs) | Browser mode (browser-scan.mjs) |
|---|---|---|
| **Speed** | Faster (API calls) | Slower (page loads) |
| **Data freshness** | Archive (may lag hours/days) | Real-time |
| **Login required** | No | No (but benefits from logged-in session) |
| **Rate limits** | PullPush limits (can be strict) | Reddit page loads (be polite) |
| **Reliability** | Depends on PullPush uptime | Depends on Chrome + Reddit DOM |
| **Best for** | Large-scale scans, historical data | Targeted scans, when PullPush is down |

Output format is identical between modes — both produce `{ ok: true, data: { posts: [...] } }` with the same scoring fields, so downstream analysis (Phases 4-7) works with either.

## Options Reference

### discover
| Flag | Default | Description |
|------|---------|-------------|
| `--domain` | required | Domain to explore |
| `--limit` | 10 | Max subreddits to return |

### scan
| Flag | Default | Description |
|------|---------|-------------|
| `--subreddits` | required | Comma-separated subreddit list |
| `--domain` | | Domain for extra search queries |
| `--days` | 365 | How far back to search |
| `--minScore` | 1 | Min post score filter |
| `--minComments` | 3 | Min comment count filter |
| `--limit` | 30 | Max posts to return |
| `--pages` | 2 | Pages per query (more = deeper, slower) |

### deep-dive
| Flag | Default | Description |
|------|---------|-------------|
| `--post` | | Single post ID or Reddit URL |
| `--from-scan` | | Path to scan output JSON |
| `--stdin` | | Read scan JSON from stdin |
| `--top` | 10 | How many posts to analyze from scan |
| `--maxComments` | 200 | Max comments to fetch per post |

### browser-scan scan
| Flag | Default | Description |
|------|---------|-------------|
| `--subreddits` | required | Comma-separated subreddit list |
| `--domain` | | Domain for relevance boosting |
| `--time` | year | Time filter: hour, day, week, month, year, all |
| `--minComments` | 3 | Min comment count filter |
| `--limit` | 30 | Max posts to return |
| `--ws-url` | auto | Chrome WebSocket URL |
| `--port` | auto | Chrome debug port |

### browser-scan deep-dive
| Flag | Default | Description |
|------|---------|-------------|
| `--post` | | Post URL or ID |
| `--from-scan` | | Path to scan output JSON |
| `--stdin` | | Read scan JSON from stdin |
| `--top` | 10 | How many posts to analyze from scan |
| `--maxComments` | 200 | Max comments to scrape per post |
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
