# GapScout — Market Gap Intelligence Workflow

> **One-line summary:** Same scanning infrastructure, different lens: from "what hurts?" to "where's the gap nobody's filling?"
>
> **GapScout** is a market gap intelligence engine that maps competitors, mines their weaknesses across 11+ sources, identifies whitespace nobody serves, and scores opportunities by composite cross-platform evidence.
>
> **Core principle: leverage teams of agents at every stage.** No single agent works alone when work can be parallelized. New competitors discovered at any stage trigger automatic follow-up research.
>
> **Quality principle: every stage is judged and documented.** A `judge` agent evaluates every data source's output against structured rubrics. A `documenter` agent records issues, strengths, and improvement opportunities. Together they form the **QA team** that runs at every pipeline stage.

---

## Entry Point

The user provides one of three inputs:

- **Mode A — Market/category:** `"project management tools"` → full market scan
- **Mode B — Named competitors:** `"Jira, Asana, Linear, Monday"` → competitor weakness scan
- **Mode C — No input:** scan HN frontpage → suggest trending markets → user picks one

If no input is provided, run **Step 0.5** to suggest markets before asking the user to pick one.

All script commands use: `node /home/jayknightcoolie/claude-business/gapscout/scripts/cli.mjs`

**No API keys required.** All sources use free public APIs or browser scraping. LLM analysis is performed by the Claude Code agent itself.

---

## Step 0: Setup & Environment

1. **Run setup** (auto-detects tokens, shows instructions for missing ones):
   ```bash
   cd /home/jayknightcoolie/claude-business/gapscout && node scripts/cli.mjs setup
   ```
   Show full output. If tokens are missing, tell user they can configure later. **Never block — always proceed.**

2. **Launch Chrome** for browser-based sources:
   ```bash
   curl -s --connect-timeout 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1 || {
     pkill -f 'chrome.*remote-debugging-port' 2>/dev/null; sleep 1
     google-chrome --headless=new --remote-debugging-port=9222 --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --user-data-dir=/tmp/gapscout-chrome 2>/dev/null &
     sleep 4
   }
   ```

---

## Step 0.5: HN Frontpage Market Suggestions (Mode C only)

If no market/competitors provided:

1. Run: `node scripts/cli.mjs hn frontpage --limit 60 --top 20`
2. Present top suggested markets with story counts, engagement, and sample titles.
3. Ask user to pick a market or enter their own.
4. Proceed to Step 1.

---

## QA Team Protocol (Runs at Every Stage)

At the end of **every pipeline stage** (Discovery, Scanning, Synthesis), spawn the QA team in parallel:

#### Agent: `judge-<stage>` (e.g., `judge-discovery`, `judge-scanning`, `judge-synthesis`)
```
You are the stage judge. See .claude/agents/judge.md for full instructions.

Stage: <current-stage>
Output files to evaluate: <list of /tmp/gapscout-*.json files produced by this stage>
Scan plan (for volume comparison): /tmp/gapscout-plan.json (if exists)

1. Load and evaluate every output file from this stage
2. Score each source on the rubric (relevance, signal density, coverage, citations, etc.)
3. Generate per-source scorecards
4. Generate stage summary with overall verdict
5. Send full evaluation to the `documenter-<stage>` agent
6. Save scorecards to /tmp/gapscout-judge-<stage>.json
7. If blockerForNextStage is true, message the team lead with the reason
```

#### Agent: `documenter-<stage>` (e.g., `documenter-discovery`, `documenter-scanning`, `documenter-synthesis`)
```
You are the stage documenter. See .claude/agents/documenter.md for full instructions.

Stage: <current-stage>
Scan ID: <scan-id>

1. Wait for judge-<stage> to send you their evaluation
2. Read the stage output files independently for issues the judge may have missed
3. Check ISSUES.md for known issues that may be manifesting
4. Write/append to /tmp/gapscout-issues-<scan-id>.md
5. Update ISSUES.md if you find new systemic (non-scan-specific) issues
6. Save structured issues to /tmp/gapscout-documented-issues-<stage>.json
7. Send summary to team lead: issue counts, verdict, recommendation
```

**Flow**: Stage agents complete → Judge + Documenter spawn in parallel → Judge evaluates and sends to Documenter → Documenter writes issues and reports to team lead → Team lead reviews QA verdict before proceeding to next stage.

**Gate rule**: If the judge returns `blockerForNextStage: true`, the team lead MUST address the blocker before proceeding. This may mean re-running a source, adjusting queries, or acknowledging degraded data.

---

## Step 0.75: Scan Planning (Planner Agent)

Before any work begins, spawn a **planner agent** that produces a bounded specification.

```
Agent: "planner"
See .claude/agents/planner.md for full instructions.

Input: "<market>" (from user) + depth preference (regular/deep)
Output: /tmp/gapscout-<scan-id>/scan-spec.json

The planner:
1. Expands market name into synonyms and audience segments
2. Estimates competitor count range (min-max, not "find ALL")
3. Reserves rate budgets (20% discovery, 80% scanning) — prevents Issue #6/#35
4. Marks source viability (skip Twitter, cap Google depth)
5. Defines sprint contracts with measurable "done" criteria
6. Sets wall-time limits and stop criteria for every stage

ALL downstream agents MUST read and respect scan-spec.json.
```

Present the plan summary to the user. If they approve, proceed.

---

## Checkpoint/Resume Protocol

Every stage writes a completion manifest on finish:

```json
/tmp/gapscout-<scan-id>/stage-complete-<stage>.json
{
  "stage": "<stage>",
  "completedAt": "<ISO>",
  "artifacts": { "<name>": "<path>", ... },
  "stats": { ... },
  "rateBudgetUsed": { "<source>": <N>, ... },
  "rateBudgetRemaining": { "<source>": <N>, ... },
  "nextStage": "<stage>",
  "resumable": true
}
```

**To resume a failed scan**: Read the last `stage-complete-*.json` that exists. Skip all completed stages. Resume from the next stage using the artifacts and remaining rate budgets.

**File-based handoffs, not SendMessage**: Agents communicate via files in `/tmp/gapscout-<scan-id>/`. This prevents context accumulation and enables clean context resets between stages.

---

## Context Reset Protocol

Between every major stage boundary (Discovery → QA → Scanning → QA → Synthesis):

1. Current stage agents write their outputs to files
2. Current stage agents write `stage-complete-<stage>.json`
3. **Context reset** — next stage agents are spawned fresh
4. Next stage agents read from files (not from in-context messages)
5. Next stage agents verify artifacts exist before starting

This follows Anthropic's finding that context resets are more effective than compaction for preventing context anxiety in long-running tasks.

---

## Step 1: Competitor Discovery

This is the biggest change from the original workflow. Before scanning for pain points, **first map the competitive landscape.** This step uses **multiple teams of parallel agents** for maximum speed and coverage.

### 1A. Spawn Discovery Agent Team

Launch ALL discovery agents in a single message (parallel):

#### Agent: `market-mapper` (spawns its own sub-team)
```
You are a market research coordinator. Your goal: comprehensively map ALL
significant products/tools in the "<market>" space. Do not stop at a fixed
number — the web is large and markets can have 30, 50, or 100+ players
across segments. Be exhaustive.

DO NOT use a hardcoded set of queries. Instead, use your domain knowledge of
"<market>" to dynamically generate the most effective search strategy:

1. THINK about the market first:
   - What are the common category names for this market? (e.g., "project management"
     might also be called "task management", "work management", "team collaboration")
   - What audience segments exist? (SMB, mid-market, enterprise, developer, consumer)
   - Are there well-known comparison/review sites for this vertical?
   - What adjacent categories overlap? (e.g., "note-taking" overlaps with "knowledge management")

2. DIVIDE the search strategy into parallel workstreams and SPAWN a team of agents:

   Agent: "mapper-mainstream"
   - Search for mainstream/well-known players using broad queries
   - Review aggregator searches (G2, Capterra, Product Hunt categories)
   - "Best X tools" articles and comparison roundups
   - Use the current year for freshness

   Agent: "mapper-niche"
   - Search for niche, vertical-specific, and emerging players
   - Segment-specific queries (e.g., "best X for freelancers", "X for agencies")
   - Indie hacker communities, Show HN launches, Product Hunt recent launches
   - Regional/non-English market players if relevant

   Agent: "mapper-opensource"
   - Search for open-source alternatives and self-hosted options
   - GitHub "awesome-X" lists, self-hosted directories
   - r/selfhosted, r/opensource, alternative.to
   - Developer-focused communities

   Agent: "mapper-adjacent"
   - Search for tools in adjacent/overlapping categories
   - Products that partially compete but come from a different angle
   - Platform features that compete (e.g., Notion competing with project management tools)
   - New AI-native entrants disrupting the category

3. COLLECT results from all mapper agents. Each agent surfaces new competitors
   the others may have missed.

4. DEDUPLICATE and CLASSIFY into: Leaders, Challengers, Niche Players, Open-Source.
   Use your judgment — a "leader" has high visibility across multiple search results;
   a "niche player" appears in only 1-2 results with a specific focus.

5. If ANY mapper agent surfaces sub-markets or segments not covered by others,
   spawn ADDITIONAL mapper agents to cover those gaps.

Output a structured competitorMap as JSON:
{
  "market": "<market>",
  "synonyms": ["<alt name 1>", "<alt name 2>"],
  "segments": ["<segment 1>", "<segment 2>"],
  "competitors": [
    {
      "name": "...",
      "url": "...",
      "description": "...",
      "pricing": "free|freemium|paid|enterprise|open-source",
      "audience": "...",
      "tier": "leader|challenger|niche|open-source",
      "evidence": "found in N search results, surfaced by <which mapper agent>"
    }
  ]
}
Save to /tmp/gapscout-competitor-map.json.
```

#### Agent: `profile-scraper` (coordinator — spawns profiler sub-team)
```
You are a profiling coordinator. Your goal: build deep profiles for EVERY
competitor in the competitorMap by distributing the work across a team of agents.

Wait for the market-mapper to produce the competitorMap (check TaskList).

1. DIVIDE the competitor list into manageable batches (scale batch size to the
   total — e.g., 5 batches for 25 competitors, 10 batches for 50, etc.).

2. SPAWN one `profiler-batch-N` agent per batch, all in parallel. Each batch
   agent receives its list of competitors and independently profiles them:

   For each competitor assigned:
   a. Visit their homepage and pricing page → extract:
      - Tier names, prices, billing frequency
      - Key features per tier
      - Free tier / trial availability
   b. Visit their features/product page → extract:
      - Core capabilities list
      - Integrations
      - Platform support (web, mobile, desktop, API)
   c. Find their review platform profiles:
      - WebSearch for G2, Capterra, Trustpilot, App Store, Play Store, GitHub profiles
   d. Collect review counts and average ratings from each platform found
   e. IMPORTANT — While profiling, if you discover NEW competitors mentioned
      on pricing comparison pages, "alternatives to X" pages, G2 category
      pages, or competitor feature comparison tables that are NOT in the
      original competitorMap:
      - Note them with: name, URL, and where you found them
      - Send a message to the profile-scraper coordinator:
        "NEW_COMPETITOR_SURFACED: <name> | <url> | Found on: <source>"

   Save batch results to /tmp/gapscout-profiles-batch-N.json.

3. COLLECT results from all batch agents as they complete.

4. For any NEW competitors surfaced by batch agents:
   - Deduplicate against the original competitorMap and other surfaced names
   - Spawn additional `profiler-adhoc-N` agents to profile genuinely new
     competitors (in parallel, as they surface — don't wait for all batches
     to finish before launching these)

5. MERGE all results (original batches + adhoc profiles) into a single
   competitorProfiles JSON. Save to /tmp/gapscout-competitor-profiles.json.

6. UPDATE the competitorMap with any new competitors added during profiling.
   Save updated map to /tmp/gapscout-competitor-map-final.json.

7. REPORT to team lead:
   - "Profiled N competitors (M original + K newly surfaced during profiling)"
   - List the newly surfaced competitors with context on where they were found

This cascading discovery pattern means the competitive map GROWS during
profiling — comparison pages and G2 category listings often reveal competitors
that initial web searches missed.
```

#### Agent: `subreddit-discoverer` (spawns sub-team for large markets)
```
You are a Reddit community research coordinator. Your goal: find ALL relevant
subreddits for the "<market>" space, including competitor-specific communities.

DO NOT use a fixed query list. Instead:

1. USE the market synonyms from the competitorMap (wait for market-mapper if needed)
   to search broadly — each synonym may have its own subreddit ecosystem.

2. SPAWN parallel search agents if the market has multiple distinct segments:

   Agent: "subreddit-market" — search for market-category subreddits
   Agent: "subreddit-competitors" — check r/<competitor-name> for every competitor
   Agent: "subreddit-roles" — search for professional role communities
   Agent: "subreddit-adjacent" — search for adjacent/overlapping communities

   For smaller markets, handle all searches yourself without spawning sub-agents.

3. SEARCH using dynamically generated queries based on the market:
   - Community recommendation queries ("best subreddits for...", "where to discuss...")
   - Market-specific terms and their Reddit communities
   - Competitor-specific subreddits (many products have r/<productname>)
   - Adjacent/overlapping communities
   - Professional role communities (e.g., r/ProductManagement, r/sysadmin)
   - "Help me find" communities (r/SuggestASoftware, r/selfhosted, etc.)

4. RUN the CLI discover command for API-based suggestions:
   node scripts/cli.mjs api discover --domain "<market>" --limit 50

5. COMBINE all sources, deduplicate, remove obviously irrelevant subreddits.
   No fixed cap — include every relevant community found. For large markets
   this could be 50-100+ subreddits across all segments.

Output: expandedSubreddits list with a brief note on why each was included.
Save to /tmp/gapscout-subreddits.json.
```

#### Agent: `query-generator` (spawns sub-team for large competitor lists)
```
You are a search query strategist coordinator. Your goal: generate the most
effective complaint/pain/switching queries for the "<market>" space and ALL
its competitors.

Wait for the market-mapper to produce the competitorMap (check TaskList).

DO NOT use a fixed template. Instead:

1. ANALYZE the competitorMap:
   - Which competitors are dominant? (switching queries are highest value for leaders)
   - Which are controversial or have had recent pricing changes, outages, acquisitions?
   - Are there known rivalries? (e.g., "Jira vs Linear" is a real battleground)
   - What's the typical user frustration language in this domain?

2. If the competitorMap has 15+ competitors, SPAWN parallel query agents:

   Agent: "queries-leaders" — generate deep query sets for market leaders
     (more queries per competitor — these have the most complaint data)
   Agent: "queries-challengers" — generate query sets for challengers
   Agent: "queries-niche" — generate lighter query sets for niche players
   Agent: "queries-market-wide" — generate broad unmet-need queries

   For smaller markets (<15 competitors), handle all query generation yourself.

3. GENERATE CATEGORY A — Competitor-specific queries:
   For each competitor, use your knowledge to craft queries that capture:
   - Switching intent: how do real users talk about leaving this product?
     (Not just "[X] alternative" — think "[X] migration", "moving off [X]",
     "replacing [X]", "ditching [X]", "[X] to [Y]")
   - Complaints: what are the known pain patterns for this type of product?
     (Performance? Pricing? Complexity? Lock-in? Missing features?)
   - Comparison shopping: "[X] vs" queries, "[X] reviews", "[X] honest review"
   - Recent events: if you know about pricing changes, acquisitions, outages,
     or controversial decisions, craft queries around those
   - Platform-specific queries for tech products

4. GENERATE CATEGORY B — Market-wide unmet need queries:
   Think about what's UNIQUE to this market's pain landscape:
   - Domain-specific frustration language
   - Painful workflows in this space
   - Emerging trends causing new friction
   - Power user vs casual user gaps
   - Use market synonyms from competitorMap to broaden coverage

5. PRIORITIZE: rank queries by expected signal quality. Switching-intent queries
   produce the strongest WTP signals. Unmet-need queries find greenfield opportunities.

Output:
{
  "competitorQueries": {
    "<competitor-name>": ["query1", "query2", ...],
    ...
  },
  "marketQueries": ["query1", "query2", ...],
  "queryRationale": "brief explanation of query strategy for this market"
}
Save to /tmp/gapscout-queries.json.
```

### 1B. Present Discovery Results

Once all discovery agents complete, show the user:

```
Market: "<market>"

Competitors Found (N):
├── Leaders: CompA, CompB, CompC
├── Challengers: CompD, CompE, ...
├── Niche: CompF, CompG, ...
└── Open-source: CompH, CompI, ...

New competitors surfaced during profiling: N additional
Review Profiles Collected: N competitors with G2/Capterra/Trustpilot URLs
Subreddits (N): r/sub1, r/sub2, r/sub3, ...
Competitor Queries (N): per-competitor query sets generated
Market Queries (N): broad unmet-need queries generated
```

### 1C. QA Checkpoint: Discovery

Spawn the QA team (see **QA Team Protocol** above):
- **`judge-discovery`**: Evaluate `/tmp/gapscout-competitor-map.json`, `/tmp/gapscout-competitor-profiles.json`, `/tmp/gapscout-subreddits.json`, `/tmp/gapscout-queries.json`
  - Key rubric focus: **Coverage breadth** (did we find enough competitors?), **Deduplication** (are competitors properly deduplicated?), **Relevance** (are subreddits/queries on-domain?)
- **`documenter-discovery`**: Document issues, update ISSUES.md if systemic problems found

Review QA verdict before proceeding. If MARGINAL, note degraded areas. If FAIL, address blockers.

Proceed to Step 2.

---

## Step 2: Scan Plan

Run the scan plan generator:
```bash
node scripts/cli.mjs plan --domain "<market>" --depth regular 2>/dev/null
```

Present a formatted table showing sources, methods, limits, expected posts, and estimated time. Now with **two scan categories clearly labeled:**

```
CATEGORY A: Competitor-Specific Scans (targeted at named products)
| Source             | Competitors Targeted | Method  | Limit | Est. Time |
|--------------------|---------------------|---------|-------|-----------|
| G2/Capterra        | all with profiles   | Browser | 500   | varies    |
| Trustpilot         | all with profiles   | Browser | 300   | varies    |
| App Store          | all with apps       | Browser | 200   | varies    |
| Reddit (targeted)  | all                 | API     | 500   | varies    |
| GitHub Issues      | open-source ones    | API     | 300   | varies    |
| Stack Overflow     | all                 | API     | 200   | varies    |

CATEGORY B: Market-Wide Scans (broad discovery)
| Source             | Method    | Limit      | Est. Time |
|--------------------|-----------|------------|-----------|
| Reddit (broad)     | API       | 500        | 10s       |
| Hacker News        | API       | 200        | 5s        |
| Google Autocomplete| Browser   | 100        | 3 min     |
| Twitter            | Browser   | 200        | 4 min     |
| Product Hunt       | API       | 100        | 2 min     |
| Kickstarter        | Browser   | 100        | 3 min     |
| WebSearch          | Built-in  | 30+ queries| 5 min     |
```

Ask user: **"Regular (~5K posts, ~20 min) or deep (~50K posts, ~90 min)? Ready to start?"**

---

## Step 3: Create Team

```
TeamCreate:
  team_name: "gapscout-<market-slug>"
  description: "Market gap intelligence for <market>"
```

---

## Step 4: Create Scan Tasks

Create tasks for ALL scans. Tasks are split into Category A and Category B.

### Category A: Competitor-Specific Scan Tasks

**Task: "G2/Capterra competitor reviews"**
```
For each competitor in competitorProfiles that has a G2 or Capterra URL:
Run: node scripts/cli.mjs reviews scan --domain "<competitor-name>" --sources g2,capterra --limit <limit>
Focus on 1-3 star reviews. Save per-competitor results.
Merge all into /tmp/gapscout-reviews-all.json.
```

**Task: "Trustpilot competitor reviews"**
```
For each competitor with a Trustpilot URL:
Run: node scripts/cli.mjs trustpilot scan --domain "<competitor-name>" --limit <limit>
Focus on 1-3 star reviews. Merge all into /tmp/gapscout-trustpilot-all.json.
```

**Task: "App store competitor reviews"**
```
For each competitor with an app store listing:
Run: node scripts/cli.mjs appstore scan --domain "<competitor-name>" --limit <limit>
Focus on 1-2 star reviews. Save to /tmp/gapscout-appstore-all.json.
```

**Task: "Reddit competitor complaints"**
```
Run: node scripts/cli.mjs api scan --subreddits "<expandedSubreddits>"
  --domain "<market>" --days 180 --limit <limit>
Use competitor-specific queries from query-generator.
Save to /tmp/gapscout-reddit-competitors.json.
```

**Task: "GitHub Issues competitor complaints"**
```
For each open-source competitor with a GitHub repo:
Run: node scripts/cli.mjs gh-issues scan --domain "<competitor-name>" --limit <limit>
Mine their actual issue tracker for bug reports, feature requests, and complaints.
Save to /tmp/gapscout-github-issues-all.json.
```

**Task: "Stack Overflow competitor problems"**
```
Run: node scripts/cli.mjs so scan --domain "<market>" --limit <limit>
Use competitor-specific queries from query-generator.
Save to /tmp/gapscout-stackoverflow-all.json.
```

### Category B: Market-Wide Scan Tasks

**Task: "Reddit market-wide scan"**
```
Run: node scripts/cli.mjs api scan --subreddits "<expandedSubreddits>"
  --domain "<market>" --days 180 --limit <limit>
Use market-wide queries from query-generator.
Save to /tmp/gapscout-reddit-market.json.
```

**Task: "Hacker News scan"**
```
Run: node scripts/cli.mjs hn scan --domain "<market>" --limit <limit>
Save to /tmp/gapscout-hn.json.
```

**Task: "Google autocomplete scan"**
```
Run: node scripts/cli.mjs google scan --domain "<market>" --limit <limit>
Include "[competitor] alternative" for each competitor.
Save to /tmp/gapscout-google.json.
```

**Task: "Twitter scan"**
```
Run: node scripts/cli.mjs twitter scan --domain "<market>" --limit <limit>
Save to /tmp/gapscout-twitter.json.
```

**Task: "Product Hunt scan"**
```
Run: node scripts/cli.mjs ph scan --domain "<market>" --limit <limit>
Save to /tmp/gapscout-producthunt.json.
```

**Task: "Kickstarter scan"**
```
Run: node scripts/cli.mjs kickstarter scan --domain "<market>" --limit <limit>
Save to /tmp/gapscout-kickstarter.json.
```

**Task: "Web search scan"**
```
Use WebSearch tool directly. Run all queries from query-generator
(both competitorQueries and marketQueries).
Save to /tmp/gapscout-websearch.json.
```

**Task: "Switching signal deep-dive"**
```
Dedicated WebSearch scan focused exclusively on switching/migration signals.
Use dynamically generated queries based on competitor rivalries and market dynamics.
Save to /tmp/gapscout-switching-signals.json.
This is high-value WTP evidence — people who switch are already paying.
```

### Deep-Dive Tasks (blocked by scan tasks)

**Task: "Reddit deep-dive"** — blocked by Reddit scan tasks
```
Run: node scripts/cli.mjs api deep-dive --from-scan /tmp/gapscout-reddit-competitors.json --top <topN>
Save to /tmp/gapscout-reddit-deep.json.
```

**Task: "HN deep-dive"** — blocked by HN scan
```
Run: node scripts/cli.mjs hn deep-dive --from-scan /tmp/gapscout-hn.json --top <topN>
Save to /tmp/gapscout-hn-deep.json.
```

### Synthesis Task (blocked by ALL above)

**Task: "Synthesis & market gap report"** — blocked by all scan and deep-dive tasks. Details in Step 6.

---

## Step 5: Spawn Scanner Agent Team

Launch ALL scanner agents in a single message for maximum parallelism. Each agent joins the team via `team_name`.

**Key principle: each scanner agent that handles multiple competitors spawns its own sub-team to parallelize the work.**

### Category A Agents (Competitor-Specific) — Each Spawns Sub-Teams

1. **`reviews-coordinator`** — Claims "G2/Capterra competitor reviews" task.
   ```
   You are a review scanning coordinator. Your competitorProfiles list has N
   competitors with G2/Capterra URLs.

   SPAWN parallel `reviews-batch-N` agents, each handling a batch of competitors (batch size scales with total count):
   - Each batch agent runs the CLI scan per competitor
   - Each batch agent LLM-evaluates raw reviews for genuine pain signals
   - Each batch agent watches for NEW competitors mentioned in reviews
     (comparison mentions, "switched from X to Y", "X is better than Y")
     and reports them: "NEW_COMPETITOR: <name> | <context>"

   COLLECT all batch results, MERGE into /tmp/gapscout-reviews-all.json.
   Report total reviews collected and any new competitors surfaced.
   ```

2. **`trustpilot-coordinator`** — Claims "Trustpilot competitor reviews" task.
   Same sub-team pattern as reviews-coordinator.

3. **`appstore-coordinator`** — Claims "App store competitor reviews" task.
   Same sub-team pattern. Spawns batch agents scaled to competitor count.

4. **`reddit-competitor-scanner`** — Claims "Reddit competitor complaints" task.
   ```
   You are a Reddit competitor scanning coordinator.

   SPAWN parallel agents by competitor cluster:
   - Agent "reddit-leaders": scan for complaints about market leaders
     (these generate the most data — allocate more queries)
   - Agent "reddit-challengers": scan for complaints about challengers
   - Agent "reddit-niche": scan for complaints about niche players

   Each agent uses the competitor-specific queries from /tmp/gapscout-queries.json.
   Each agent LLM-evaluates raw posts for pain, switching intent, WTP signals.
   Each agent watches for NEW competitors mentioned in posts.

   MERGE all results into /tmp/gapscout-reddit-competitors.json.
   ```

5. **`github-issues-coordinator`** — Claims "GitHub Issues competitor complaints" task.
   ```
   SPAWN one agent per open-source competitor (they have independent issue trackers).
   Each agent mines that competitor's GitHub issues for bug reports, feature requests,
   and complaints. Watch for mentions of OTHER competitors in issues.
   MERGE into /tmp/gapscout-github-issues-all.json.
   ```

6. **`stackoverflow-scanner`** — Claims "Stack Overflow competitor problems" task.
   Uses competitor-specific queries. Single agent (SO API is fast).

### Category B Agents (Market-Wide) — Parallel by Source

7. **`reddit-market-scanner`** — Claims "Reddit market-wide scan" task.
   Uses broad unmet-need queries. LLM-evaluates for pain signals.

8. **`hn-scanner`** — Claims "Hacker News scan" task.

9. **`google-scanner`** — Claims "Google autocomplete scan" task.

10. **`twitter-scanner`** — Claims "Twitter scan" task.

11. **`producthunt-scanner`** — Claims "Product Hunt scan" task.

12. **`kickstarter-scanner`** — Claims "Kickstarter scan" task.

### Specialist Agents

13. **`websearch-coordinator`** — Claims "Web search scan" task.
    ```
    You are a web search coordinator. You have a large set of queries from
    /tmp/gapscout-queries.json (both competitorQueries and marketQueries).

    SPAWN parallel agents to execute searches:
    - Agent "ws-competitor-complaints": run all competitor-specific complaint queries
    - Agent "ws-switching-signals": run all switching/migration queries
    - Agent "ws-unmet-needs": run all market-wide unmet need queries
    - Agent "ws-comparison": run comparison and review queries

    Each agent uses WebSearch directly (not CLI). Each collects results,
    deduplicates by URL, and watches for NEW competitors in results.

    MERGE all results into /tmp/gapscout-websearch.json.
    ```

14. **`switching-signal-hunter`** — Claims "Switching signal deep-dive" task.
    ```
    You are a switching signal specialist. Your ONLY job is to find evidence
    of people migrating between competitors.

    Use the competitorMap to identify competitor pairs. SPAWN parallel agents
    for the highest-value pairs (leader-to-challenger migrations):

    - Agent "switch-<leader>": find all switching signals AWAY from <leader>
      (the biggest competitor generates the most switching evidence)
    - Agent "switch-pairs": find migration evidence between specific pairs
    - Agent "switch-general": find general "looking for alternative" signals

    Each agent uses WebSearch. Dynamically generate queries based on how real
    users talk about switching in this specific market.

    MERGE into /tmp/gapscout-switching-signals.json.
    This data is the HIGHEST VALUE for WTP estimation.
    ```

15. **`competitor-profiler`** — Claims "Competitor profiling" task.
    Builds a structured feature matrix from competitorProfiles.
    Outputs /tmp/gapscout-feature-matrix.json. This feeds into the gap matrix in synthesis.

### Continuous Competitor Broadening (Key Innovation — Owned by the Scanning Team)

**The discovery team (Step 1) surfaces the initial competitive map. The scanning team (Step 5) continuously expands it as new competitors emerge during scanning.**

This is NOT a team-lead responsibility — the scanning coordinators own the broadening loop themselves. When a scanner surfaces a new competitor, the scanning team autonomously launches a **full scan pipeline** for that competitor (not just a profile — actual review mining, Reddit complaints, switching signals, the works).

#### How It Works

**Every scanner agent (and sub-agent) follows this protocol:**
```
While processing scan results:
  Extract mentioned product/tool names using LLM judgment.
  For each mentioned name:
    If name is NOT in competitorMap AND NOT in "already-surfaced" list:
      1. Add to "already-surfaced" list (prevent duplicates)
      2. Send message to scan-orchestrator:
         "NEW_COMPETITOR: <name> | Context: <quote> | Source: <platform> | URL: <link>"
```

16. **`scan-orchestrator`** — A dedicated scanning-team agent that manages broadening.
    ```
    You are the scan orchestrator. You coordinate the continuous broadening loop.

    MONITOR messages from ALL scanner agents. Maintain a running list of:
    - Known competitors (from the initial competitorMap)
    - Already-being-researched competitors (to prevent duplicates)

    When a "NEW_COMPETITOR" message arrives:
      1. DEDUPLICATE — check against known + in-progress lists
      2. If genuinely new, SPAWN a full scan team for that competitor:

         Agent: "broaden-profile-<slug>"
         - WebSearch + WebFetch to get: website, pricing, features, review URLs
         - Save profile to /tmp/gapscout-broadened-profile-<slug>.json

         Agent: "broaden-reviews-<slug>"
         - If G2/Capterra/Trustpilot URLs found, run CLI review scans
         - Focus on 1-3 star reviews
         - Save to /tmp/gapscout-broadened-reviews-<slug>.json

         Agent: "broaden-reddit-<slug>"
         - Search Reddit for complaints, switching signals, "alternative to <name>"
         - Use the expanded subreddits list
         - Save to /tmp/gapscout-broadened-reddit-<slug>.json

         Agent: "broaden-web-<slug>"
         - WebSearch for: "<name> problems", "<name> complaints", "switched from <name>",
           "<name> vs", "<name> alternative"
         - Save to /tmp/gapscout-broadened-web-<slug>.json

         All four broaden agents run in parallel per new competitor.

      3. UPDATE the competitorMap with the new competitor
      4. TRACK all broaden agents spawned — report the running count to team lead

    When all original scanner tasks are complete AND all broaden agents are complete:
      Signal to the synthesizer-coordinator that scanning is done.

    This means: a competitor mentioned in a G2 review gets its OWN G2 reviews
    scraped, its OWN Reddit complaints mined, and its OWN switching signals found.
    The competitive map doesn't just grow — it gets DEEP coverage on every new entrant.
    ```

17. **`synthesizer-coordinator`** — Waits for the scan-orchestrator to signal completion
    (all original scans + all broaden scans done), then executes Step 6 using a team
    of analyst agents.

### 5B. QA Checkpoint: Scanning

After all scanner agents complete (including broaden agents), spawn the QA team:
- **`judge-scanning`**: Evaluate ALL `/tmp/gapscout-*.json` scan output files
  - Key rubric focus: **Signal density** (are we finding real pain?), **Volume vs plan** (did we hit targets?), **Rate limit health** (did sources degrade?), **Citation quality** (do posts have URLs?)
  - Special attention: Compare Category A (competitor-specific) vs Category B (market-wide) quality — if one category is significantly weaker, flag it
  - Evaluate broadened competitor scans separately — are they as thorough as original competitor scans?
- **`documenter-scanning`**: Document all issues, compare against Discovery stage issues (are problems recurring?), update ISSUES.md

**This is the most critical QA checkpoint** — scanning produces the raw evidence that synthesis depends on. A FAIL verdict here means the synthesis will produce unreliable conclusions.

Review QA verdict. If sources returned <25% of planned volume, consider re-running with adjusted parameters before synthesis.

---

## Step 6: Synthesis — Market Gap Intelligence Report

The synthesizer reads all scan output files and produces a **6-section market intelligence report** using **sequential sprints with context resets** between each analyst. See `.claude/agents/synthesizer-coordinator.md` for the full orchestration protocol.

### 6A. Why Sequential Sprints (Not Parallel Analysts)

From Anthropic's harness design article: "Models tend to lose coherence on lengthy tasks as the context window fills." When 7 analysts run in parallel and merge in-context, the coordinator's context fills with 100KB+ of outputs. Sequential sprints with file-based handoffs give each analyst a fresh context window.

**Trade-off**: ~2x slower, but guarantees completeness. No analyst skips data due to context pressure.

### 6B. Spawn Synthesizer Coordinator

```
Agent: "synthesizer-coordinator"
See .claude/agents/synthesizer-coordinator.md for full instructions.

The coordinator chains 7 analyst sprints sequentially:

Sprint 1: Competitive Map Assembly
  → /tmp/gapscout-<scan-id>/synthesis-1-competitive-map.json
  [CONTEXT RESET]

Sprint 2: Competitor Pain Analysis (reads Sprint 1 from FILE)
  → /tmp/gapscout-<scan-id>/synthesis-2-competitor-pain.json
  [CONTEXT RESET]

Sprint 3: Unmet Needs Discovery (reads Sprint 2 from FILE)
  → /tmp/gapscout-<scan-id>/synthesis-3-unmet-needs.json
  [CONTEXT RESET]

Sprint 4: Switching Signal Analysis (reads Sprints 2-3 from FILE)
  → /tmp/gapscout-<scan-id>/synthesis-4-switching.json
  [CONTEXT RESET]

Sprint 5: Gap Matrix Construction (reads Sprints 1-4 from FILE)
  → /tmp/gapscout-<scan-id>/synthesis-5-gap-matrix.json
  [CONTEXT RESET]

Sprint 6: Opportunity Scoring + Idea Sketches (reads Sprints 1-5 from FILE)
  → /tmp/gapscout-<scan-id>/synthesis-6-opportunities.json
  [CONTEXT RESET]

Sprint 7: False-Negative Rescue (reads Sprint 6 + raw data from FILE)
  → /tmp/gapscout-<scan-id>/synthesis-7-rescued.json

Each sprint has a "done" contract from scan-spec.json.
Each sprint writes a -READY.txt signal before the next sprint starts.
```

### 6B-detail. Sprint Contracts

| Sprint | Done When | Gate |
|--------|-----------|------|
| 1. Competitive Map | All competitors (original + broadened) classified, ≥80% have pricing | If <80% pricing, flag but proceed |
| 2. Competitor Pain | Each competitor with ≥10 data points has ≥1 pain theme. All quotes have URLs. | If <50% have pain themes, FAIL |
| 3. Unmet Needs | Each need validated against competitor features, ≥2 source citations per need | If <5 unmet needs found, flag |
| 4. Switching | Signals mapped to competitor pairs with directional evidence | If 0 switching signals, skip (acceptable) |
| 5. Gap Matrix | Each gap cell traceable to scan data. No "YES" without ≥2 sources. | Run citation verification before Sprint 6 |
| 6. Opportunities | Scores follow formula from scan-spec. Each VALIDATED has an idea sketch. | If 0 VALIDATED, lower threshold to 40 |
| 7. Rescue | Raw data sampled, false-negative check complete | If rescue changes scores by ≥5 pts, flag |

### 6B-iteration. Judge-Driven Iteration Loop

After all 7 sprints, the judge evaluates the synthesis output. If verdict is MARGINAL or FAIL:

1. Judge writes feedback to `/tmp/gapscout-<scan-id>/judge-feedback-round-<N>.json`
2. Synthesizer-coordinator identifies which sprints need re-running
3. **Only failing sprints re-run** (not the whole pipeline)
4. Downstream sprints that depend on re-run sprints also re-run
5. Maximum 3 iteration rounds (from scan-spec.json)

This implements the article's generator-evaluator loop: "Separating the agent doing the work from the agent judging it proves to be a strong lever."

### 6B. Section Details

#### Section 1: Competitive Map

```
Market: <market>
Players found: N (M original + K surfaced during scanning)
├── Leaders: [name] (segment), [name] (segment)
├── Challengers: [name], [name]
├── Niche: [name] (focus), [name] (focus)
└── Open-source: [name], [name]

[For each player: one-line description, pricing tier, primary audience]
```

Built from: competitorMap + competitorProfiles + all broadened competitors.

#### Section 2: Where Existing Products Fail

Pain points organized **by competitor**, not generically:

```
[Competitor] (N complaints across M sources):
├── "[Theme 1]" — X mentions (Reddit: N, G2: N, Twitter: N, SO: N)
│   ├── Representative quotes with CLICKABLE LINKS
│   ├── Pain depth: Surface / Active / Urgent
│   └── WTP signal: [evidence if present]
├── "[Theme 2]" — X mentions
│   └── ...
└── "[Theme 3]" — X mentions
    └── ...
```

The analyst clusters complaints into themes using LLM analysis:
- Group semantically similar complaints (e.g., "slow" + "laggy" + "takes forever" = one theme)
- Cross-reference across sources (a complaint on Reddit AND G2 AND Twitter is stronger than Reddit alone)
- Tag each theme with: frequency, intensity, source breadth, WTP evidence

#### Section 3: Unmet Needs (No Solution Exists)

From the market-wide scans (Category B):

```
"[Unmet need description]" — N mentions across M platforms
├── Evidence: [clickable links to original posts]
├── Existing solutions: None / [partial solution with gaps]
├── Target persona: [who specifically wants this]
├── WTP signals: [any spending/switching evidence]
└── Opportunity score: X/100
```

The analyst applies:
- Implicit signal detection (sarcasm, learned helplessness, quiet switching)
- Target persona identification
- Pain depth classification (Surface / Active / Urgent)
- Frequency vs. Intensity matrix

#### Section 4: Gap Matrix (Killer Feature)

Auto-generated by cross-referencing competitor features against complaints:

```
Feature/Need          | Comp A | Comp B | Comp C | Comp D | GAP?
──────────────────────┼────────┼────────┼────────┼────────┼─────────
[Feature from comps]  | Yes    | Partial| No     | Yes    | Partial
[Feature from comps]  | Yes    | Yes    | Yes    | Yes    | No
[Need from complaints]| No     | No     | No     | No     | YES ←
[Need from complaints]| No     | Basic  | No     | No     | Partial
[Unmet need]          | No     | No     | No     | No     | YES ←
```

Mark gaps as:
- **YES** — No competitor offers this, AND there is evidence of demand
- **Partial** — 1-2 competitors offer it poorly, complaints exist
- **No** — Well-served by multiple competitors

#### Section 5: Opportunity Scorecard

For each identified gap:

```
Opportunity: "[Description]"
├── Pain evidence:     N mentions across M platforms       (X/10)
├── WTP signals:       N spending/switching signals        (X/10)
├── Competition:       N direct competitors                (X/10, inverted — less = better)
├── Switching signals: N "looking for alternative" posts   (X/10)
├── Source breadth:    Confirmed on N platforms            (X/10)
├── Composite score:   XX/100
├── Verdict:           VALIDATED / NEEDS EVIDENCE / TOO WEAK
├── Target persona:    [specific segment]
├── Current solutions: [what exists and why it fails]
└── Idea sketch:       [auto-generated MVP brief]
```

**Scoring formula:**
- Pain evidence (0-10): mention count + intensity
- WTP signals (0-10): spending intent, switching behavior, failed solution attempts
- Competition gap (0-10): 10 = nobody serves this, 0 = crowded
- Switching signals (0-10): active migration/alternative-seeking behavior
- Source breadth (0-10): confirmed across how many independent platforms
- **Composite = weighted average** (WTP and switching weighted 2x because they predict revenue)

#### Section 6: Idea Sketches (for Validated + Needs-Evidence Opportunities)

For each opportunity scoring 60+/100:

```
## Idea Sketch: [Name]

**Problem:** [one sentence]
**Target Customer:** [specific persona, not "users"]
**Solution Concept (MVP):**
  - Core feature 1
  - Core feature 2
  - Core feature 3

**Business Model:** [pricing strategy informed by competitor pricing + WTP signals]
**Go-to-Market:**
  - [Distribution channel 1 — informed by where complaints were found]
  - [Distribution channel 2]
  - [Content/SEO angle — informed by search query gaps found during scanning]

**Competitive Landscape:** [who's close, what their weakness is]
**Risk & Validation:** [what would need to be true, suggested next steps]
```

### 6C. Report Generation

1. The synthesizer-coordinator collects all analyst outputs and merges them.

2. Generate structured JSON report:
   ```bash
   node scripts/cli.mjs report --files <comma-separated /tmp/gapscout-*.json files> --format json > /tmp/gapscout-report.json
   ```

3. Generate web report:
   ```bash
   node scripts/cli.mjs web-report --input /tmp/gapscout-report.json --output /tmp/gapscout-report.html
   ```

4. If web-report fails, create a self-contained HTML report at /tmp/gapscout-report.html with:
   - System font stack, max-width 900px centered, generous whitespace
   - Dark/light mode (prefers-color-scheme)
   - **Competitive map** as a visual hierarchy
   - **Gap matrix** as an interactive sortable table
   - **Opportunity cards** with verdict badges (green=validated, amber=needs evidence, red=too weak)
   - Collapsible sections per competitor and per opportunity
   - All citation links clickable to original posts
   - Executive summary at top with top 3 opportunities
   - No external dependencies

**CRITICAL: Every piece of evidence MUST have a clickable link to the original post.**

### 6D. False-Negative Rescue Step

Spawn a dedicated `rescue-analyst` agent:
```
1. List all /tmp/gapscout-*-raw.json files
2. For each raw file, compare post count to corresponding filtered file
3. If raw has significantly more posts (2x+), sample up to 100 random posts
   NOT already in the evaluated set
4. LLM-evaluate for missed pain/switching/WTP signals
5. Look especially for: sarcasm, learned helplessness, quiet switching,
   implicit spending frustration, domain-specific jargon
6. If rescued posts found, add to report with source "rescued-from-raw"
7. Trigger report regeneration if significant new signals found
```

---

### 6E. QA Checkpoint: Synthesis

After all analyst agents complete and the report is generated, spawn the QA team:
- **`judge-synthesis`**: Evaluate the final report (`/tmp/gapscout-report.json`, `/tmp/gapscout-report.html`) and all analyst outputs
  - Key rubric focus: **Citation grounding** (is every claim backed by evidence?), **Cross-source validation** (are pain points confirmed across 3+ sources?), **Actionability** (are opportunities specific enough to act on?), **Gap identification** (are the gaps real or fabricated?)
  - Cross-check: Verify that the gap matrix entries correspond to actual data, not hallucinated features
  - Verify opportunity scores are mathematically correct per the scoring formula
- **`documenter-synthesis`**: Document final issues, produce a **full scan retrospective** comparing all three stage evaluations
  - Generate a "Scan Quality Report" section showing score trends across Discovery → Scanning → Synthesis
  - Identify the single biggest improvement that would help the next scan
  - Update ISSUES.md with any new systemic findings

The synthesis QA checkpoint is the **final quality gate** before the report is presented to the user.

---

## Step 7: Collect Results & Present

When the synthesizer completes, present:

1. **Executive summary:**
   - Market overview (N competitors mapped, N review sources scanned)
   - Top 3 opportunities with composite scores
   - Key finding: biggest gap nobody is filling

2. **Stats:**
   - Total posts/reviews analyzed across all sources
   - Competitors profiled (original + surfaced during scan)
   - New competitors discovered during scanning (the broaden pattern results)
   - Total agents spawned (shows depth of research)

3. **Deliverables:**
   - Path to web report: `/tmp/gapscout-report.html`
   - Path to raw JSON: `/tmp/gapscout-report.json`
   - Competitor profiles: `/tmp/gapscout-competitor-profiles.json`
   - Feature matrix: `/tmp/gapscout-feature-matrix.json`

4. **Source quality notes:**
   - If any sources hit rate limits or blocks, list them with impact
   - Sources automatically stop and return partial results when rate-limited

5. **QA summary** (from documenter's scan retrospective):
   - Stage grades: Discovery (X) → Scanning (X) → Synthesis (X)
   - Total issues found: N critical, N high, N medium, N low
   - Top recurring issue across stages
   - Biggest improvement for next scan
   - Path to full issues log: `/tmp/gapscout-issues-<scan-id>.md`

Then send shutdown messages to all teammates.

---

## Appendix A: Agent Hierarchy Overview

```
Team Lead (you)
│
├── Step 0.75: Planner Agent
│   └── planner (produces scan-spec.json with bounds, budgets, contracts)
│
├── Step 1: Discovery Team (surfaces initial competitive map)
│   ├── market-mapper (coordinator)
│   │   ├── mapper-mainstream
│   │   ├── mapper-niche
│   │   ├── mapper-opensource
│   │   └── mapper-adjacent
│   ├── profile-scraper (coordinator)
│   │   ├── profiler-batch-1 ... profiler-batch-N
│   │   └── profiler-adhoc-1 ... (new competitors found during profiling)
│   ├── subreddit-discoverer (coordinator)
│   │   ├── subreddit-market
│   │   ├── subreddit-competitors
│   │   ├── subreddit-roles
│   │   └── subreddit-adjacent
│   └── query-generator (coordinator)
│       ├── queries-leaders
│       ├── queries-challengers
│       ├── queries-niche
│       └── queries-market-wide
│
├── QA Checkpoint: Discovery
│   ├── judge-discovery (evaluates all discovery outputs against rubrics)
│   └── documenter-discovery (records issues, updates ISSUES.md)
│
├── Step 5: Scanner Team (scans + continuously broadens the competitive map)
│   ├── scan-orchestrator (owns the broadening loop)
│   │   │
│   │   ├── Receives NEW_COMPETITOR signals from ALL scanners below
│   │   └── For each new competitor, spawns a FULL scan team:
│   │       ├── broaden-profile-<slug>   (pricing, features, review URLs)
│   │       ├── broaden-reviews-<slug>   (G2/Capterra/Trustpilot 1-3 star)
│   │       ├── broaden-reddit-<slug>    (complaints, switching signals)
│   │       └── broaden-web-<slug>       (WebSearch for problems, alternatives)
│   │
│   ├── Category A (competitor-specific) — feed NEW_COMPETITOR → scan-orchestrator
│   │   ├── reviews-coordinator → reviews-batch-1 ... reviews-batch-N
│   │   ├── trustpilot-coordinator → trustpilot-batch-1 ... trustpilot-batch-N
│   │   ├── appstore-coordinator → appstore-batch-1 ... appstore-batch-N
│   │   ├── reddit-competitor-scanner → reddit-leaders, reddit-challengers, reddit-niche
│   │   ├── github-issues-coordinator → one agent per open-source competitor
│   │   └── stackoverflow-scanner
│   │
│   ├── Category B (market-wide) — feed NEW_COMPETITOR → scan-orchestrator
│   │   ├── reddit-market-scanner
│   │   ├── hn-scanner
│   │   ├── google-scanner
│   │   ├── twitter-scanner
│   │   ├── producthunt-scanner
│   │   └── kickstarter-scanner
│   │
│   └── Specialists — feed NEW_COMPETITOR → scan-orchestrator
│       ├── websearch-coordinator → ws-complaints, ws-switching, ws-unmet, ws-comparison
│       ├── switching-signal-hunter → switch-<leader>, switch-pairs, switch-general
│       └── competitor-profiler
│
├── QA Checkpoint: Scanning (most critical gate)
│   ├── judge-scanning (evaluates ALL scan outputs, compares vs plan)
│   └── documenter-scanning (records issues, compares with discovery issues)
│
├── Step 6: Synthesis Team (SEQUENTIAL sprints with context resets)
│   └── synthesizer-coordinator (chains sprints, does NOT run them in parallel)
│       ├── Sprint 1: analyst-sprint-1-competitive-map → synthesis-1.json [RESET]
│       ├── Sprint 2: analyst-sprint-2-competitor-pain → synthesis-2.json [RESET]
│       ├── Sprint 3: analyst-sprint-3-unmet-needs     → synthesis-3.json [RESET]
│       ├── Sprint 4: analyst-sprint-4-switching        → synthesis-4.json [RESET]
│       ├── Sprint 5: analyst-sprint-5-gap-matrix       → synthesis-5.json [RESET]
│       ├── Sprint 6: analyst-sprint-6-opportunities    → synthesis-6.json [RESET]
│       ├── Sprint 7: analyst-sprint-7-rescue           → synthesis-7.json
│       └── Report generation (reads final sprint output from FILE)
│
└── QA Checkpoint: Synthesis (final quality gate)
    ├── judge-synthesis (evaluates report, verifies citations + scores)
    └── documenter-synthesis (full scan retrospective, ISSUES.md update)
```

**QA Team runs 3 times per scan** (once per stage), producing:
- `/tmp/gapscout-judge-<stage>.json` — scorecards per source
- `/tmp/gapscout-documented-issues-<stage>.json` — structured issues
- `/tmp/gapscout-issues-<scan-id>.md` — human-readable running log
- Updates to `ISSUES.md` for systemic issues

---

## Appendix B: Continuous Competitor Broadening — Why It Matters

### The Two-Phase Design

**Phase 1 — Discovery Team (Step 1):** Surfaces the initial competitive map using web search, review aggregators, and community research. This produces the starting set of competitors, profiles, subreddits, and queries. The discovery team does NOT do continuous broadening — it finishes its job and hands off.

**Phase 2 — Scanning Team (Step 5):** Owns the broadening loop. As scanners process reviews, Reddit posts, HN threads, and web search results, they naturally encounter competitors NOT in the initial map. The `scan-orchestrator` receives these signals and spawns **full scan pipelines** (not just profiles) for each new competitor — including their own G2/Trustpilot reviews, Reddit complaints, and switching signals.

### Why the Scanning Team Owns Broadening

1. **Scanners see what discovery agents can't.** A G2 review says "we switched to CompX" — that's a competitor AND a switching signal in one. A Reddit thread says "I tried CompY but it was worse" — that's a competitor AND a pain point. These signals only appear during scanning, not during initial web search.

2. **New competitors need full scans, not just profiles.** If you only profile a newly discovered competitor (name + pricing + features), you miss the entire point — you need their complaints, their weaknesses, their switching signals. The scan-orchestrator spawns a full 4-agent scan team per new competitor.

3. **It keeps the discovery team fast.** The discovery team's job is to produce a good starting map quickly so scanning can begin. If discovery also had to do continuous broadening, it would never finish and scanning would be delayed.

### Proof This Works

In our competitive research session for "pain point finder tools", we started with ~25 known tools and surfaced **15+ additional competitors** through cascading discovery:

- Reddily surfaced → Peekdit, Trend Seeker, SubredditSignals, Octolens, Clearcue, Syften, Reppit AI, CrowdReply
- GapHunt surfaced → GapFind, AppGaps, Gapify AI, NicheScout, NICHES HUNTER, gappr.ai
- StartupIdeaLab surfaced → PainMap, PainMiner, SaaS Miner

Each of those new competitors was then deep-dived by follow-up agents. The same pattern is now built into the scanning team — every scanner feeds new names to the scan-orchestrator, which launches full scan pipelines automatically.

**Without continuous broadening:** you map 15-20 competitors and miss half the market.
**With continuous broadening owned by scanners:** every review, every Reddit post, every HN thread becomes a potential source of new competitive intelligence — and each new competitor gets fully scanned, not just noted.

---

## Appendix C: Comparison to Original Workflow (pre-GapScout)

| Aspect | Original Workflow | Market Gap Intelligence |
|--------|------------------|------------------------|
| **Input** | Domain/niche | Market OR named competitors |
| **Planning** | None (jump straight in) | Planner agent produces bounded scan-spec.json with rate budgets and sprint contracts |
| **Discovery** | Subreddits + query variations | Full competitor mapping with agent teams |
| **Scan targeting** | Generic domain keywords | Competitor-specific + market-wide (dual category) |
| **Agent pattern** | Flat (12 parallel scanners) | Hierarchical (coordinators spawn sub-teams) + QA team at every stage |
| **Quality assurance** | None (manual review) | Judge + Documenter agents at every stage with rubrics, auto-fail rules, and iteration loops |
| **Context management** | Single context, hopes for the best | Context resets between stages, file-based handoffs, selective data loading |
| **Checkpoint/resume** | None (restart from scratch) | Stage completion manifests, rate budget tracking, resumable from any stage |
| **Synthesis** | Single synthesizer | 7 sequential sprints with context resets between each |
| **Dynamic expansion** | None | Continuous competitor broadening at every level |
| **Analysis lens** | "What hurts?" | "Where's the gap nobody's filling?" |
| **Synthesis** | Single synthesizer | Team of parallel analysts |
| **Output: Section 1** | Pain point list | Competitive map |
| **Output: Section 2** | Pain categories | Per-competitor failure analysis |
| **Output: Section 3** | (none) | Unmet needs (no solution exists) |
| **Output: Section 4** | (none) | Gap matrix (feature × competitor) |
| **Output: Section 5** | Opportunity verdicts | Composite opportunity scorecard |
| **Output: Section 6** | Idea sketches | Idea sketches (enhanced with competitive context) |

### What Stays the Same

- Chrome setup and token management
- All 12 CLI scanner scripts (G2, Capterra, Trustpilot, Reddit, HN, Twitter, SO, GitHub Issues, Google Autocomplete, Kickstarter, Product Hunt, App Store)
- Team creation pattern
- LLM-as-analyst (Claude Code agent = free analysis, no API keys)
- Deep-dive tasks for high-signal threads
- False-negative rescue step
- HTML report generation with clickable citations
- Rate limit handling and partial result collection

---

## Appendix D: Target Customer Segments

| Customer | Use Case | WTP | Retention |
|----------|----------|-----|-----------|
| **Indie hackers with existing products** | "Where should I build next? What's adjacent?" | $29-49/mo | Monthly |
| **Product managers** | "What are users complaining about in competitors? What features to build?" | $49-99/mo | Weekly |
| **VC/angel analysts** | "Is this market real? Validated demand for this startup's claim?" | $99-199/report | Per-deal |
| **Content marketers** | "What pain-point content captures frustrated users searching for alternatives?" | $19-29/mo | Weekly |
| **Agency strategists** | "Market entry analysis for client's new product" | $99-299/report | Per-project |

---

## Appendix E: Competitive Moats This Workflow Creates

1. **11+ source breadth** — no competitor scans Trustpilot + Stack Overflow + GitHub Issues + Google Autocomplete + Kickstarter for this use case
2. **Cross-platform composite scoring** — pain points validated across 5+ independent sources are qualitatively different from single-source signals
3. **Continuous broadening** — competitive map grows during the scan, capturing competitors you didn't know about
4. **Gap matrix** — auto-generated feature × competitor grid is a deliverable nobody else produces
5. **Open-source + zero LLM cost** — Claude Code agent IS the LLM; no API keys, no per-query charges
6. **Switching signal specialization** — dedicated agent team for migration/switching evidence = strongest WTP data
7. **Hierarchical agent teams** — coordinators spawning sub-teams means the research depth scales with market complexity, not a fixed number of agents
8. **Built-in quality assurance** — judge + documenter agents at every stage catch data quality issues, rate limit degradation, and false negatives before they corrupt downstream analysis. Issues are tracked across stages and across scans, creating a self-improving system
9. **Harness-grade resilience** — context resets between stages prevent coherence degradation in long-running scans. Sequential synthesis sprints with file-based handoffs guarantee completeness. Checkpoint/resume eliminates wasted work from failures. Auto-fail rules catch deprecated sources and off-topic scraping before they corrupt analysis. Judge-driven iteration loops refine synthesis output until it passes quality thresholds — the same GAN-inspired generator-evaluator pattern used in Anthropic's multi-hour application development harness
