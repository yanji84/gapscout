# GapScout Agent Relationships

> Single reference for understanding how all agents relate to each other: spawning trees, data flow, context boundaries, iteration loops, and agent counts.

---

## 1. Auto-Proceed Chain (The Main Pipeline)

```
                          USER INPUT
                              |
                              v
+-----------------------------------------------------------------------------------+
|                         STEP 0.75: PLANNING                                       |
|                                                                                   |
|   planner                                                                         |
|     |-- [spawns 4 parallel research agents]                                       |
|     |     planner-market-research                                                 |
|     |     planner-source-viability                                                |
|     |     planner-competitive-landscape                                           |
|     |     planner-query-strategy                                                  |
|     |-- [merges outputs into scan-spec.json]                                      |
|                                                                                   |
|   Artifact: /tmp/gapscout-<id>/scan-spec.json                                    |
|   Auto-Proceed: immediately after saving scan-spec.json                           |
+-----------------------------------------------------------------------------------+
                              |
                              | Gate: scan-spec.json saved and summary presented
                              v
+-----------------------------------------------------------------------------------+
|                        STEP 1: DISCOVERY                                          |
|                                                                                   |
|   4 coordinator agents launched IN PARALLEL:                                      |
|     market-mapper -----> /tmp/gapscout-competitor-map.json                        |
|     profile-scraper ---> /tmp/gapscout-competitor-profiles.json                   |
|     subreddit-discoverer -> /tmp/gapscout-subreddits.json                         |
|     query-generator ---> /tmp/gapscout-queries.json                               |
|                                                                                   |
|   Each coordinator spawns its own parallel sub-team (see Section 2).              |
|   Auto-Proceed: after all 4 coordinators complete                                 |
+-----------------------------------------------------------------------------------+
                              |
                              | Artifact: stage-complete-discovery.json
                              v
+-----------------------------------------------------------------------------------+
|                     QA CHECKPOINT: DISCOVERY                                      |
|                                                                                   |
|   Spawned in parallel:                                                            |
|     judge-discovery --> /tmp/gapscout-<id>/judge-discovery-COMPLETE.json           |
|     documenter-discovery --> /tmp/gapscout-documented-issues-discovery.json        |
|                                                                                   |
|   Flow: judge evaluates + writes file --> documenter reads file + writes issues   |
|   Gate: if blockerForNextStage=true, team lead must address before proceeding     |
|   Auto-Proceed: if PASS or MARGINAL (non-blocking), continue to scanning          |
+-----------------------------------------------------------------------------------+
                              |
                              | [CONTEXT RESET — next agents spawned fresh]
                              v
+-----------------------------------------------------------------------------------+
|                        STEP 5: SCANNING                                           |
|                                                                                   |
|   17 scanner agents launched IN PARALLEL (see Section 2 for sub-teams):           |
|                                                                                   |
|   Category A (competitor-specific):                                               |
|     reviews-coordinator, trustpilot-coordinator, appstore-coordinator,            |
|     reddit-competitor-scanner, github-issues-coordinator,                         |
|     stackoverflow-scanner                                                         |
|                                                                                   |
|   Category B (market-wide):                                                       |
|     reddit-market-scanner, hn-scanner, google-scanner, twitter-scanner,           |
|     producthunt-scanner, kickstarter-scanner                                      |
|                                                                                   |
|   Specialists:                                                                    |
|     websearch-coordinator, switching-signal-hunter, competitor-profiler            |
|                                                                                   |
|   Broadening loop (continuous):                                                   |
|     scan-orchestrator <-- NEW_COMPETITOR from all scanners                        |
|       --> spawns broaden-{profile,reviews,reddit,web}-<slug> per new competitor   |
|                                                                                   |
|   Auto-Proceed: after all scanners + all broaden agents complete                  |
+-----------------------------------------------------------------------------------+
                              |
                              | Artifact: stage-complete-scanning.json
                              v
+-----------------------------------------------------------------------------------+
|                     QA CHECKPOINT: SCANNING                                       |
|                                                                                   |
|   judge-scanning --> /tmp/gapscout-<id>/judge-scanning-COMPLETE.json              |
|   documenter-scanning --> /tmp/gapscout-documented-issues-scanning.json           |
|                                                                                   |
|   Gate: MOST CRITICAL — if FAIL, do NOT proceed to synthesis                      |
|   Auto-Proceed: if PASS or MARGINAL, continue to synthesis                        |
+-----------------------------------------------------------------------------------+
                              |
                              | [CONTEXT RESET — next agents spawned fresh]
                              v
+-----------------------------------------------------------------------------------+
|                    STEP 6: SYNTHESIS (7 SEQUENTIAL SPRINTS)                       |
|                                                                                   |
|   synthesizer-coordinator chains sprints with context resets:                     |
|                                                                                   |
|   Sprint 1: Competitive Map Assembly                                              |
|     --> synthesis-1-competitive-map.json + synthesis-1-READY.txt                  |
|     [CONTEXT RESET]                                                               |
|   Sprint 2: Competitor Pain Analysis                                              |
|     --> synthesis-2-competitor-pain.json + synthesis-2-READY.txt                  |
|     [CONTEXT RESET]                                                               |
|   Sprint 3: Unmet Needs Discovery                                                 |
|     --> synthesis-3-unmet-needs.json + synthesis-3-READY.txt                      |
|     [CONTEXT RESET]                                                               |
|   Sprint 4: Switching Signal Analysis                                             |
|     --> synthesis-4-switching.json + synthesis-4-READY.txt                        |
|     [CONTEXT RESET]                                                               |
|   Sprint 5: Gap Matrix Construction                                               |
|     --> synthesis-5-gap-matrix.json + synthesis-5-READY.txt                       |
|     [CONTEXT RESET]                                                               |
|   Sprint 6: Opportunity Scoring                                                   |
|     --> synthesis-6-opportunities.json + synthesis-6-READY.txt                    |
|     [CONTEXT RESET]                                                               |
|   Sprint 7: False-Negative Rescue                                                 |
|     --> synthesis-7-rescued.json + synthesis-7-READY.txt                          |
|                                                                                   |
|   Auto-Proceed: after Sprint 7, generate report, then spawn judge                |
+-----------------------------------------------------------------------------------+
                              |
                              | Artifact: report.json + report.html
                              v
+-----------------------------------------------------------------------------------+
|                     QA CHECKPOINT: SYNTHESIS                                      |
|                                                                                   |
|   judge-synthesis --> /tmp/gapscout-<id>/judge-synthesis-COMPLETE.json            |
|   documenter-synthesis --> full scan retrospective + ISSUES.md update             |
|                                                                                   |
|   Gate: FINAL quality gate before presenting to user                              |
|   If MARGINAL/FAIL: triggers iteration loop (see Section 5)                       |
|   If PASS: documenter produces final documentation                                |
+-----------------------------------------------------------------------------------+
                              |
                              v
                        FINAL REPORT
               /tmp/gapscout-<id>/report.html
               /tmp/gapscout-<id>/report.json
```

### Resume Mode Entry Point

```
RESUME MODE: previous scan → scan-resumption (copy + baseline) → enters iterative loop at CRITIQUE
```

When resuming from an existing report, the `scan-resumption` agent copies previous scan files into the new workspace and writes `resumption-baseline.json`. The pipeline then enters the iterative refinement loop (Section 5C) at the critique step, treating the previous report as draft v0.

### Transition Summary Table

| From | To | Trigger | Artifact Passed | Gate Condition |
|------|----|---------|-----------------|----------------|
| User input | planner | User provides market/competitors | User text | None |
| planner | Discovery team | Auto-proceed after scan-spec.json saved | scan-spec.json | None (auto) |
| Discovery team | judge-discovery | All 4 coordinators complete | competitor-map, profiles, subreddits, queries JSONs | None (auto) |
| judge-discovery | documenter-discovery | Judge writes COMPLETE.json + READY.txt | judge-discovery-COMPLETE.json | None (auto) |
| QA Discovery | Scanner team | Team lead reviews verdict | stage-complete-discovery.json | blockerForNextStage != true |
| Scanner team | judge-scanning | All scanners + broaden agents complete | All /tmp/gapscout-*.json scan files | None (auto) |
| QA Scanning | synthesizer-coordinator | Team lead reviews verdict | stage-complete-scanning.json | blockerForNextStage != true; scanning verdict != FAIL |
| synthesizer-coordinator | judge-synthesis | All 7 sprints complete + report generated | report.json, report.html | None (auto) |
| judge-synthesis (PASS) | documenter-synthesis | Verdict is PASS | judge-synthesis-COMPLETE.json | compositeScore >= 7.0, no CRITICAL issues |
| judge-synthesis (FAIL) | synthesizer-coordinator | Verdict is MARGINAL/FAIL | judge-feedback-round-N.json | Round < max iterations (3) |
| documenter-synthesis | Final report | Auto-proceed | scan retrospective | None (auto) |

---

## 2. Agent Spawning Tree

### 2A. Planner

```
planner
  |-- [PARALLEL, single message]
  |   |-- planner-market-research
  |   |     Reads: user input (market name)
  |   |     Writes: /tmp/gapscout-<id>/market-research.json
  |   |
  |   |-- planner-source-viability
  |   |     Reads: user input (market name)
  |   |     Writes: /tmp/gapscout-<id>/source-viability.json
  |   |
  |   |-- planner-competitive-landscape
  |   |     Reads: user input (market name)
  |   |     Writes: /tmp/gapscout-<id>/competitive-landscape.json
  |   |
  |   +-- planner-query-strategy
  |         Reads: user input (market name)
  |         Writes: /tmp/gapscout-<id>/query-strategy.json
  |
  +-- [MERGE step — planner reads all 4 files, produces scan-spec.json]
        Writes: /tmp/gapscout-<id>/scan-spec.json
```

**Sub-agents: 4 parallel**

### 2B. Market-Mapper

```
market-mapper
  |-- [PARALLEL, single message]
  |   |-- mapper-mainstream
  |   |     Searches: broad queries, review aggregators, "best X tools" articles
  |   |
  |   |-- mapper-niche
  |   |     Searches: vertical-specific, indie, emerging, regional players
  |   |
  |   |-- mapper-opensource
  |   |     Searches: GitHub awesome-X lists, r/selfhosted, alternative.to
  |   |
  |   +-- mapper-adjacent
  |         Searches: overlapping categories, AI-native entrants, platform features
  |
  +-- [MERGE + DEDUP — market-mapper collects and classifies]
        Writes: /tmp/gapscout-competitor-map.json
```

**Sub-agents: 4 parallel (+ additional mappers if gaps found)**

### 2C. Profile-Scraper

```
profile-scraper
  |-- [PARALLEL — batch count scales with competitor count]
  |   |-- profiler-batch-1
  |   |     Reads: subset of competitor-map.json
  |   |     Writes: /tmp/gapscout-profiles-batch-1.json
  |   |     Side-effect: may send NEW_COMPETITOR_SURFACED messages
  |   |
  |   |-- profiler-batch-2
  |   |     ...
  |   |
  |   +-- profiler-batch-N  (N = ceil(competitors / batch_size))
  |
  |-- [PARALLEL — spawned as new competitors surface, not waiting for batches]
  |   |-- profiler-adhoc-1
  |   |-- profiler-adhoc-2
  |   +-- profiler-adhoc-K  (K = number of newly surfaced competitors)
  |
  +-- [MERGE all batches + adhocs]
        Writes: /tmp/gapscout-competitor-profiles.json
        Writes: /tmp/gapscout-competitor-map-final.json
```

**Sub-agents: N batch + K adhoc (typical: 5-10 batch + 2-5 adhoc)**

### 2D. Subreddit-Discoverer

```
subreddit-discoverer
  |-- [PARALLEL — for large markets; sequential for small]
  |   |-- subreddit-market
  |   |     Searches: market-category subreddits
  |   |
  |   |-- subreddit-competitors
  |   |     Searches: r/<competitor-name> for every competitor
  |   |
  |   |-- subreddit-roles
  |   |     Searches: professional role communities
  |   |
  |   +-- subreddit-adjacent
  |         Searches: adjacent/overlapping communities
  |
  +-- [MERGE + DEDUP]
        Writes: /tmp/gapscout-subreddits.json
```

**Sub-agents: 4 parallel (for large markets) or 0 (small markets, handled inline)**

### 2E. Query-Generator

```
query-generator
  |-- [PARALLEL — only if 15+ competitors; else handled inline]
  |   |-- queries-leaders
  |   |     Generates: deep query sets for market leaders (more queries per competitor)
  |   |
  |   |-- queries-challengers
  |   |     Generates: query sets for challengers
  |   |
  |   |-- queries-niche
  |   |     Generates: lighter query sets for niche players
  |   |
  |   +-- queries-market-wide
  |         Generates: broad unmet-need queries
  |
  +-- [MERGE + PRIORITIZE]
        Writes: /tmp/gapscout-queries.json
```

**Sub-agents: 4 parallel (if 15+ competitors) or 0**

### 2F. Reviews-Coordinator, Trustpilot-Coordinator, Appstore-Coordinator

All three follow the same pattern:

```
<source>-coordinator
  |-- [PARALLEL — batch count scales with competitor count]
  |   |-- <source>-batch-1
  |   |     Scans: subset of competitors on <source>
  |   |     Side-effect: NEW_COMPETITOR signals to scan-orchestrator
  |   |
  |   |-- <source>-batch-2
  |   +-- <source>-batch-N
  |
  +-- [MERGE all batches]
        Writes: /tmp/gapscout-<source>-all.json
```

**Sub-agents per coordinator: N batches (typical: 3-6 per coordinator)**

### 2G. Reddit-Competitor-Scanner

```
reddit-competitor-scanner
  |-- [PARALLEL]
  |   |-- reddit-leaders
  |   |     Reads: competitor-map (leaders), queries.json
  |   |     More queries allocated (highest data volume)
  |   |
  |   |-- reddit-challengers
  |   |     Reads: competitor-map (challengers), queries.json
  |   |
  |   +-- reddit-niche
  |         Reads: competitor-map (niche), queries.json
  |
  +-- [MERGE]
        Writes: /tmp/gapscout-reddit-competitors.json
```

**Sub-agents: 3 parallel**

### 2H. GitHub-Issues-Coordinator

```
github-issues-coordinator
  |-- [PARALLEL — one agent per open-source competitor]
  |   |-- gh-issues-<competitor-1>
  |   |-- gh-issues-<competitor-2>
  |   +-- gh-issues-<competitor-M>  (M = number of OSS competitors)
  |
  +-- [MERGE]
        Writes: /tmp/gapscout-github-issues-all.json
```

**Sub-agents: M parallel (M = OSS competitor count, typical: 3-8)**

### 2I. Websearch-Coordinator

```
websearch-coordinator
  |-- [PARALLEL, single message]
  |   |-- ws-complaints
  |   |     Runs: competitor-specific complaint queries via WebSearch
  |   |
  |   |-- ws-switching
  |   |     Runs: switching/migration queries via WebSearch
  |   |
  |   |-- ws-unmet
  |   |     Runs: market-wide unmet need queries via WebSearch
  |   |
  |   +-- ws-comparison
  |         Runs: comparison and review queries via WebSearch
  |
  +-- [MERGE + DEDUP by URL]
        Writes: /tmp/gapscout-websearch.json
```

**Sub-agents: 4 parallel**

### 2J. Switching-Signal-Hunter

```
switching-signal-hunter
  |-- [PARALLEL]
  |   |-- switch-<leader-1>
  |   |     Finds: all switching signals AWAY from leader-1
  |   |
  |   |-- switch-<leader-2>  (one per market leader)
  |   |     ...
  |   |
  |   |-- switch-pairs
  |   |     Finds: migration evidence between specific competitor pairs
  |   |
  |   +-- switch-general
  |         Finds: general "looking for alternative" signals
  |
  +-- [MERGE]
        Writes: /tmp/gapscout-switching-signals.json
```

**Sub-agents: L+2 parallel (L = number of market leaders, typical: 5-7)**

### 2K. Scan-Orchestrator (Broadening Loop)

```
scan-orchestrator
  |-- [PARALLEL per new competitor — spawned on-demand as NEW_COMPETITOR signals arrive]
  |
  |   For each new competitor <slug>:
  |   |-- broaden-profile-<slug>
  |   |     Writes: /tmp/gapscout-broadened-profile-<slug>.json
  |   |
  |   |-- broaden-reviews-<slug>
  |   |     Writes: /tmp/gapscout-broadened-reviews-<slug>.json
  |   |
  |   |-- broaden-reddit-<slug>
  |   |     Writes: /tmp/gapscout-broadened-reddit-<slug>.json
  |   |
  |   +-- broaden-web-<slug>
  |         Writes: /tmp/gapscout-broadened-web-<slug>.json
  |
  +-- [Signals completion when ALL original scanners + ALL broaden agents done]
```

**Sub-agents: 4 per new competitor (typical: 20 new competitors = 80 broaden agents)**

### 2L. Gap-Analyst

```
gap-analyst
  |-- [PARALLEL, single message — run per data tier]
  |   |-- analyst-filter-and-classify
  |   |     Reads: all loaded scan data
  |   |     Writes: /tmp/gapscout-<id>/classified-posts.json
  |   |
  |   |-- analyst-pattern-finder
  |   |     Reads: all loaded scan data
  |   |     Writes: /tmp/gapscout-<id>/patterns.json
  |   |
  |   |-- analyst-competitive-scanner
  |   |     Reads: all loaded scan data + competitor profiles
  |   |     Writes: /tmp/gapscout-<id>/competitive-analysis.json
  |   |
  |   +-- analyst-evidence-collector
  |         Reads: all loaded scan data
  |         Writes: /tmp/gapscout-<id>/evidence-corpus.json
  |
  +-- [MERGE — gap-analyst reads all 4 output files, writes report]
```

**Sub-agents: 4 parallel (per data tier; up to 3 tiers = 12 total)**

### 2M. Synthesizer-Coordinator (7 Sequential Sprints)

```
synthesizer-coordinator
  |
  |-- Sprint 1: Competitive Map Assembly [PARALLEL sub-team]
  |   |-- map-original-competitors
  |   |     Reads: scan-spec.json, competitor-map.json, competitor-profiles.json
  |   |     Writes: s1-original-competitors.json
  |   |
  |   |-- map-broadened-competitors
  |   |     Reads: scan-spec.json, all broadened-profile-*.json
  |   |     Writes: s1-broadened-competitors.json
  |   |
  |   +-- map-classifier  [AFTER above two complete]
  |         Reads: s1-original-competitors.json, s1-broadened-competitors.json
  |         Writes: synthesis-1-competitive-map.json + synthesis-1-READY.txt
  |   [CONTEXT RESET]
  |
  |-- Sprint 2: Competitor Pain Analysis [PARALLEL sub-team]
  |   |-- pain-reviews
  |   |     Reads: synthesis-1-competitive-map.json, review scan data
  |   |     Writes: s2-pain-reviews.json
  |   |
  |   |-- pain-reddit
  |   |     Reads: synthesis-1-competitive-map.json, Reddit data
  |   |     Writes: s2-pain-reddit.json
  |   |
  |   +-- pain-github-so
  |   |     Reads: synthesis-1-competitive-map.json, GH Issues + SO data
  |   |     Writes: s2-pain-github-so.json
  |   |
  |   +-- [MERGE]
  |         Writes: synthesis-2-competitor-pain.json + synthesis-2-READY.txt
  |   [CONTEXT RESET]
  |
  |-- Sprint 3: Unmet Needs Discovery [PARALLEL sub-team]
  |   |-- needs-reddit
  |   |     Reads: synthesis-2-competitor-pain.json, market-wide Reddit data
  |   |     Writes: s3-needs-reddit.json
  |   |
  |   |-- needs-hn-web
  |   |     Reads: synthesis-2-competitor-pain.json, HN + websearch data
  |   |     Writes: s3-needs-hn-web.json
  |   |
  |   +-- needs-other
  |   |     Reads: synthesis-2-competitor-pain.json, autocomplete + PH + other
  |   |     Writes: s3-needs-other.json
  |   |
  |   +-- [MERGE]
  |         Writes: synthesis-3-unmet-needs.json + synthesis-3-READY.txt
  |   [CONTEXT RESET]
  |
  |-- Sprint 4: Switching Signal Analysis [SINGLE agent]
  |   +-- analyst-sprint-4-switching
  |         Reads: synthesis-2, synthesis-3, switching-signals.json, reddit deep-dive
  |         Writes: synthesis-4-switching.json + synthesis-4-READY.txt
  |   [CONTEXT RESET]
  |
  |-- Sprint 5: Gap Matrix Construction [PARALLEL sub-team]
  |   |-- matrix-features
  |   |     Reads: synthesis-1, synthesis-2, synthesis-3
  |   |     Writes: s5-feature-list.json
  |   |
  |   +-- matrix-complaints
  |   |     Reads: synthesis-2, synthesis-3, synthesis-4
  |   |     Writes: s5-complaint-gaps.json
  |   |
  |   +-- matrix-validator  [AFTER above two complete]
  |         Reads: s5-feature-list.json, s5-complaint-gaps.json, raw scan data
  |         Writes: synthesis-5-gap-matrix.json + synthesis-5-READY.txt
  |   [CONTEXT RESET]
  |
  |-- Sprint 6: Opportunity Scoring [SINGLE agent]
  |   +-- analyst-sprint-6-opportunities
  |         Reads: synthesis-1 through synthesis-5
  |         Writes: synthesis-6-opportunities.json + synthesis-6-READY.txt
  |   [CONTEXT RESET]
  |
  +-- Sprint 7: False-Negative Rescue [SINGLE agent]
      +-- analyst-sprint-7-rescue
            Reads: synthesis-6, all *-raw.json files
            Writes: synthesis-7-rescued.json + synthesis-7-READY.txt
```

**Sprint sub-agent counts:**
| Sprint | Sub-agents | Execution |
|--------|-----------|-----------|
| 1 | 3 (2 parallel + 1 sequential) | Parallel then merge |
| 2 | 3 (parallel) + merge | Parallel then merge |
| 3 | 3 (parallel) + merge | Parallel then merge |
| 4 | 1 | Single agent |
| 5 | 3 (2 parallel + 1 sequential) | Parallel then merge |
| 6 | 1 | Single agent |
| 7 | 1 | Single agent |
| **Total** | **15** | Sequential sprints, parallel within |

### 2N. Judge

```
judge-<stage>
  |-- [PARALLEL, single message]
  |   |-- eval-<source-1>    (one per source output file)
  |   |-- eval-<source-2>
  |   |-- ...
  |   |-- eval-<source-N>
  |   |
  |   |-- eval-citation-verifier
  |   |     Samples 20 random citation URLs, verifies accessibility
  |   |
  |   +-- eval-domain-validator
  |         Samples 10 posts per source, verifies domain relevance
  |
  +-- [MERGE scorecards, apply auto-fail rules, generate stage summary]
        Writes: /tmp/gapscout-<id>/judge-<stage>-COMPLETE.json
        Writes: /tmp/gapscout-<id>/judge-<stage>-READY.txt
        Appends: /tmp/gapscout-qa-log.jsonl
```

**Sub-agents: N+2 per stage (N = number of source outputs, typical 8-15)**

### 2O. Documenter

```
documenter-<stage>
  |-- [PARALLEL, single message]
  |   |-- observer-data-quality
  |   |     Reads: all stage output files
  |   |     Writes: /tmp/gapscout-<id>/observations-data-quality.json
  |   |
  |   |-- observer-infrastructure
  |   |     Reads: logs, output files
  |   |     Writes: /tmp/gapscout-<id>/observations-infrastructure.json
  |   |
  |   |-- observer-known-issues
  |   |     Reads: ISSUES.md + stage output files
  |   |     Writes: /tmp/gapscout-<id>/observations-known-issues.json
  |   |
  |   +-- observer-cross-stage  (only if previous stage docs exist)
  |         Reads: previous stage documented-issues JSON
  |         Writes: /tmp/gapscout-<id>/observations-cross-stage.json
  |
  +-- [MERGE observations + judge evaluation]
        Writes: /tmp/gapscout-issues-<scan-id>.md (append)
        Writes: /tmp/gapscout-documented-issues-<stage>.json
        May update: ISSUES.md (for systemic issues)
```

**Sub-agents: 3-4 parallel per stage (observer-cross-stage only runs at Scanning and Synthesis stages)**

### 2P. Report-Critic (Iterative Draft Mode)

```
report-critic
  |-- [PARALLEL, single message — 5 critique dimensions]
  |   |-- evidence-auditor
  |   |     Reads: report.json, synthesis-8-signal-strength.json, citation-links-*.json
  |   |     Checks: BRONZE-tier, single-source, stale (>12 month) evidence
  |   |
  |   |-- perspective-checker
  |   |     Reads: report.json, synthesis-2-competitor-pain.json
  |   |     Checks: missing user segments, geographies, company sizes
  |   |
  |   |-- bias-detector
  |   |     Reads: report.json, synthesis-6-opportunities.json, scan-spec.json
  |   |     Checks: confirmation bias, survivorship bias, selection bias
  |   |
  |   |-- competitor-gap-finder
  |   |     Reads: competitor-map.json, report.json
  |   |     Uses: WebSearch to find missing competitors
  |   |
  |   +-- counter-evidence-hunter
  |         Reads: synthesis-6-opportunities.json
  |         Uses: WebSearch to find evidence AGAINST each top opportunity
  |
  +-- [MERGE all critique dimensions]
        Writes: critique-round-{N}.json
```

**Sub-agents: 5 parallel**

### 2Q. Debate-Agent (Iterative Draft Mode)

```
debate-agent
  |-- [PARALLEL — one debate per top opportunity, up to 5]
  |   |
  |   |-- Opportunity 1 debate:
  |   |   |-- bull-agent    (cites evidence FOR the opportunity)
  |   |   |-- bear-agent    (cites evidence AGAINST the opportunity)
  |   |   +-- verdict-agent (synthesizes winner, adjusts score)
  |   |
  |   |-- Opportunity 2 debate: (same structure)
  |   |-- Opportunity 3 debate: (same structure)
  |   |-- Opportunity 4 debate: (same structure)
  |   +-- Opportunity 5 debate: (same structure)
  |
  +-- [MERGE all verdicts]
        Writes: debate-round-{N}.json
```

**Sub-agents: 3 per opportunity × 5 opportunities = 15 parallel (in batches)**

### 2R. Improvement-Planner (Iterative Draft Mode)

```
improvement-planner  [LEAF — no sub-agents]
  Reads: critique-round-{N}.json, debate-round-{N}.json, scan-spec.json,
         orchestration-config.json, previous improvement plans
  Writes: improvement-plan-round-{N}.json
```

**Sub-agents: 0 (leaf agent)**

### 2S. Loop-Controller (Iterative Draft Mode)

```
loop-controller  [LEAF — no sub-agents]
  Reads: critique-round-{N}.json, debate-round-{N}.json, improvement-plan-round-{N}.json,
         report.json, previous convergence-check-*.json files
  Writes: convergence-check-{N}.json
  Decision: CONTINUE or STOP
```

**Sub-agents: 0 (leaf agent)**

### 2T. Strategic-Reviewer (Iterative Draft Mode)

```
strategic-reviewer
  |-- [PARALLEL — one strategist per top opportunity, up to 5]
  |   |-- opportunity-strategist-1
  |   |     Reads: report.json, synthesis-6-opportunities.json, debate-round-{N}.json
  |   |     Writes: partial results merged by coordinator
  |   |
  |   |-- opportunity-strategist-2 (same structure)
  |   |-- ...
  |   +-- opportunity-strategist-5
  |
  +-- [MERGE all reviews + cross-opportunity insights]
        Writes: strategic-review-round-{N}.json
```

**Sub-agents: up to 5 parallel**

### 2U. Iteration-Journal (Iterative Draft Mode)

```
iteration-journal  [LEAF — no sub-agents]
  Reads: critique-round-{N}.json, debate-round-{N}.json, strategic-review-round-{N}.json,
         improvement-plan-round-{N}.json, convergence-check-{N}.json, report.json
  Appends to: iteration-journal.md
```

**Sub-agents: 0 (leaf agent)**

### Iterative Loop Data Flow

```
Per iteration:
  critique-round-{N}.json ──┐
                             ├──→ improvement-plan-round-{N}.json
  debate-round-{N}.json ────┘         │
                                       ├──→ targeted-scan-iter-{N}-*.json
                                       ├──→ citation-expansion-iter-{N}-*.json
                                       ├──→ refutation-iter-{N}-*.json
                                       └──→ synthesis re-runs (selective sprints)
                                                    │
                                                    v
                                           report.json v(N+1)
                                                    │
                                                    v
                                     convergence-check-{N}.json → STOP/CONTINUE
```

---

## 3. Data Flow Diagram

### 3A. Planning Stage Files

| File | Producer | Consumer(s) | Stage |
|------|----------|-------------|-------|
| `/tmp/gapscout-<id>/market-research.json` | planner-market-research | planner (merge) | Planning |
| `/tmp/gapscout-<id>/source-viability.json` | planner-source-viability | planner (merge) | Planning |
| `/tmp/gapscout-<id>/competitive-landscape.json` | planner-competitive-landscape | planner (merge) | Planning |
| `/tmp/gapscout-<id>/query-strategy.json` | planner-query-strategy | planner (merge) | Planning |
| `/tmp/gapscout-<id>/scan-spec.json` | planner | ALL downstream agents | Planning |

### 3B. Discovery Stage Files

| File | Producer | Consumer(s) | Stage |
|------|----------|-------------|-------|
| `/tmp/gapscout-competitor-map.json` | market-mapper | profile-scraper, subreddit-discoverer, query-generator, all scanners, synthesizer | Discovery |
| `/tmp/gapscout-profiles-batch-N.json` | profiler-batch-N | profile-scraper (merge) | Discovery |
| `/tmp/gapscout-competitor-profiles.json` | profile-scraper | all scanners, synthesizer | Discovery |
| `/tmp/gapscout-competitor-map-final.json` | profile-scraper | scanners, synthesizer | Discovery |
| `/tmp/gapscout-subreddits.json` | subreddit-discoverer | reddit scanners, broaden-reddit agents | Discovery |
| `/tmp/gapscout-queries.json` | query-generator | all scanners, websearch-coordinator | Discovery |
| `stage-complete-discovery.json` | team lead | judge-discovery, next stage agents | Discovery |

### 3C. Scanning Stage Files

| File | Producer | Consumer(s) | Stage |
|------|----------|-------------|-------|
| `/tmp/gapscout-reviews-all.json` | reviews-coordinator | synthesizer (Sprint 2), judge-scanning | Scanning |
| `/tmp/gapscout-trustpilot-all.json` | trustpilot-coordinator | synthesizer (Sprint 2), judge-scanning | Scanning |
| `/tmp/gapscout-appstore-all.json` | appstore-coordinator | synthesizer (Sprint 2), judge-scanning | Scanning |
| `/tmp/gapscout-reddit-competitors.json` | reddit-competitor-scanner | synthesizer (Sprint 2), deep-dive, judge | Scanning |
| `/tmp/gapscout-reddit-market.json` | reddit-market-scanner | synthesizer (Sprint 3), judge | Scanning |
| `/tmp/gapscout-github-issues-all.json` | github-issues-coordinator | synthesizer (Sprint 2), judge | Scanning |
| `/tmp/gapscout-stackoverflow-all.json` | stackoverflow-scanner | synthesizer (Sprint 2), judge | Scanning |
| `/tmp/gapscout-hn.json` | hn-scanner | synthesizer (Sprint 3), deep-dive, judge | Scanning |
| `/tmp/gapscout-google.json` | google-scanner | synthesizer (Sprint 3), judge | Scanning |
| `/tmp/gapscout-twitter.json` | twitter-scanner | synthesizer, judge | Scanning |
| `/tmp/gapscout-producthunt.json` | producthunt-scanner | synthesizer (Sprint 3), judge | Scanning |
| `/tmp/gapscout-kickstarter.json` | kickstarter-scanner | synthesizer, judge | Scanning |
| `/tmp/gapscout-websearch.json` | websearch-coordinator | synthesizer (Sprint 3), judge | Scanning |
| `/tmp/gapscout-switching-signals.json` | switching-signal-hunter | synthesizer (Sprint 4), judge | Scanning |
| `/tmp/gapscout-feature-matrix.json` | competitor-profiler | synthesizer (Sprint 5) | Scanning |
| `/tmp/gapscout-reddit-deep.json` | reddit deep-dive agent | synthesizer | Scanning |
| `/tmp/gapscout-hn-deep.json` | HN deep-dive agent | synthesizer | Scanning |
| `/tmp/gapscout-broadened-profile-<slug>.json` | broaden-profile-<slug> | synthesizer (Sprint 1) | Scanning |
| `/tmp/gapscout-broadened-reviews-<slug>.json` | broaden-reviews-<slug> | synthesizer (Sprint 2) | Scanning |
| `/tmp/gapscout-broadened-reddit-<slug>.json` | broaden-reddit-<slug> | synthesizer (Sprint 2) | Scanning |
| `/tmp/gapscout-broadened-web-<slug>.json` | broaden-web-<slug> | synthesizer (Sprint 3) | Scanning |
| `stage-complete-scanning.json` | scan-orchestrator | synthesizer-coordinator, judge | Scanning |

### 3D. Synthesis Stage Files

| File | Producer | Consumer(s) | Stage |
|------|----------|-------------|-------|
| `s1-original-competitors.json` | map-original-competitors | map-classifier | Synthesis S1 |
| `s1-broadened-competitors.json` | map-broadened-competitors | map-classifier | Synthesis S1 |
| `synthesis-1-competitive-map.json` | map-classifier | Sprint 2, 5, 6 agents | Synthesis S1 |
| `s2-pain-reviews.json` | pain-reviews | Sprint 2 merge | Synthesis S2 |
| `s2-pain-reddit.json` | pain-reddit | Sprint 2 merge | Synthesis S2 |
| `s2-pain-github-so.json` | pain-github-so | Sprint 2 merge | Synthesis S2 |
| `synthesis-2-competitor-pain.json` | Sprint 2 merge | Sprint 3, 4, 5, 6 agents | Synthesis S2 |
| `synthesis-3-unmet-needs.json` | Sprint 3 merge | Sprint 4, 5, 6 agents | Synthesis S3 |
| `synthesis-4-switching.json` | analyst-sprint-4-switching | Sprint 5, 6 agents | Synthesis S4 |
| `s5-feature-list.json` | matrix-features | matrix-validator | Synthesis S5 |
| `s5-complaint-gaps.json` | matrix-complaints | matrix-validator | Synthesis S5 |
| `synthesis-5-gap-matrix.json` | matrix-validator | Sprint 6 agent | Synthesis S5 |
| `synthesis-6-opportunities.json` | analyst-sprint-6-opportunities | Sprint 7 agent | Synthesis S6 |
| `synthesis-7-rescued.json` | analyst-sprint-7-rescue | report generation | Synthesis S7 |

### 3E. Iterative Refinement Files (Iterative Draft Mode)

| File | Producer | Consumer(s) | Stage |
|------|----------|-------------|-------|
| `critique-round-{N}.json` | report-critic | improvement-planner, loop-controller | Iteration N |
| `debate-round-{N}.json` | debate-agent | improvement-planner, loop-controller | Iteration N |
| `improvement-plan-round-{N}.json` | improvement-planner | orchestrator (executes plan) | Iteration N |
| `convergence-check-{N}.json` | loop-controller | orchestrator (continue/stop) | Iteration N |
| `targeted-scan-iter-{N}-{idx}.json` | targeted search agents | synthesizer (re-run) | Iteration N |
| `citation-expansion-iter-{N}-{idx}.json` | citation search agents | report generator, synthesizer | Iteration N |
| `refutation-iter-{N}-{idx}.json` | refutation agents | synthesizer (re-run) | Iteration N |
| `broadened-profile-iter-{N}-{slug}.json` | adhoc profiler agents | synthesizer Sprint 1 (re-run) | Iteration N |
| `strategic-review-round-{N}.json` | strategic-reviewer | improvement-planner, loop-controller, iteration-journal | Iteration N |
| `iteration-journal.md` | iteration-journal | user (chat reference) | All iterations |
| `resumption-baseline.json` | scan-resumption | improvement-planner, report-critic | Resume entry |

Note: In resume mode, `scan-resumption` copies all previous scan files into the new workspace and writes `resumption-baseline.json`. These files feed into the iterative refinement loop (not a separate pipeline).

### 3F. QA Files (Produced at Every Stage)

| File | Producer | Consumer(s) | Stage |
|------|----------|-------------|-------|
| `judge-<stage>-COMPLETE.json` | judge-<stage> | documenter-<stage> | QA |
| `judge-<stage>-READY.txt` | judge-<stage> | documenter-<stage> | QA |
| `eval-<source>.json` | eval-<source> sub-agent | judge (merge) | QA |
| `documented-issues-<stage>.json` | documenter-<stage> | observer-cross-stage (next stage) | QA |
| `gapscout-issues-<scan-id>.md` | documenter (all stages) | user, team lead | QA |
| `judge-feedback-round-<N>.json` | judge-synthesis | synthesizer-coordinator (iteration) | QA-Synthesis |
| `gapscout-qa-log.jsonl` | judge (all stages) | tuning/retrospective | QA |
| `observations-data-quality.json` | observer-data-quality | documenter (merge) | QA |
| `observations-infrastructure.json` | observer-infrastructure | documenter (merge) | QA |
| `observations-known-issues.json` | observer-known-issues | documenter (merge) | QA |
| `observations-cross-stage.json` | observer-cross-stage | documenter (merge) | QA |
| `ISSUES.md` (project root) | documenter (any stage) | observer-known-issues, developers | QA |

---

## 4. Context Reset Boundaries

Context resets occur at every major stage boundary and between every synthesis sprint. Agents on opposite sides of a reset boundary NEVER share in-context messages; all data passes through files.

```
PLANNING ──file──> [CONTEXT RESET] ──file──> DISCOVERY
                                                 |
                                          (no reset within
                                           discovery agents)
                                                 |
                                              ──file──>
                                                 |
DISCOVERY QA <──file──> [judge + documenter read from files, not SendMessage]
                                                 |
                                              ──file──>
                                                 |
              [CONTEXT RESET] ─────────────────> SCANNING
                                                 |
                                          (no reset within
                                           scanning agents;
                                           they use SendMessage
                                           for NEW_COMPETITOR)
                                                 |
                                              ──file──>
                                                 |
SCANNING QA <──file──> [judge + documenter read from files]
                                                 |
                                              ──file──>
                                                 |
              [CONTEXT RESET] ─────────────────> SYNTHESIS
                                                 |
                  Sprint 1 ──file──> [RESET]     |
                  Sprint 2 ──file──> [RESET]     |
                  Sprint 3 ──file──> [RESET]     |
                  Sprint 4 ──file──> [RESET]     |
                  Sprint 5 ──file──> [RESET]     |
                  Sprint 6 ──file──> [RESET]     |
                  Sprint 7 ──file──>             |
                                                 |
SYNTHESIS QA <──file──> [judge + documenter read from files]
```

### Where SendMessage IS Used (Within a Stage)

| Within Stage | Who Sends | Who Receives | Content |
|-------------|-----------|--------------|---------|
| Scanning | Any scanner sub-agent | scan-orchestrator | `NEW_COMPETITOR: <name> \| <context>` |
| Scanning | profiler-batch-N | profile-scraper coordinator | `NEW_COMPETITOR_SURFACED: <name>` |
| QA | documenter | team lead | Stage summary (issue counts, verdict, recommendation) |

### Where File-Based Handoff Replaces SendMessage

| Boundary | Instead of SendMessage... | Agents use file... |
|----------|--------------------------|-------------------|
| Judge -> Documenter | Judge does NOT send evaluation via message | Judge writes `judge-<stage>-COMPLETE.json`; documenter polls for `judge-<stage>-READY.txt` |
| Sprint N -> Sprint N+1 | Sprint N does NOT send output to Sprint N+1 | Sprint N writes `synthesis-N-READY.txt`; Sprint N+1 reads from file |
| Stage -> Next Stage | Current stage does NOT send outputs to next stage | Current stage writes `stage-complete-<stage>.json`; next stage reads artifacts list from file |
| Judge -> Synthesizer (iteration) | Judge does NOT send feedback via message | Judge writes `judge-feedback-round-N.json`; synthesizer reads from file |

---

## 5. Iteration Loops

### 5A. Synthesis Judge-Driven Iteration

```
                  +---------------------------+
                  |  synthesizer-coordinator   |
                  |  runs Sprints 1-7          |
                  +---------------------------+
                              |
                              v
                  +---------------------------+
                  |   judge-synthesis          |
                  |   evaluates all outputs    |
                  +---------------------------+
                         /          \
                        /            \
                   PASS               MARGINAL or FAIL
                    |                      |
                    v                      v
              documenter           judge writes feedback to
              (final docs)         judge-feedback-round-N.json
                                           |
                                           v
                               synthesizer-coordinator
                               RE-RUNS ONLY FAILING SPRINTS
                               + downstream dependencies
                                           |
                                           v
                               judge-synthesis (round N+1)
                                      /          \
                                 PASS              still FAIL?
                                  |                    |
                                  v                    v
                            documenter          if round < 3: loop again
                                                if round = 3: ship with
                                                weakness note, proceed
                                                to documenter
```

**Configuration:**
- Max iterations: 3 (from scan-spec.json `synthesisSpec.maxIterationRounds`)
- Feedback file: `/tmp/gapscout-<id>/judge-feedback-round-<N>.json`
- Re-run scope: only failing sprints + sprints that depend on them
- At max iterations: proceed with best available output, note weaknesses

**Which sprints can be re-run:**

| Sprint | Can be re-run? | Triggers re-run of... |
|--------|---------------|----------------------|
| 1 | Yes | Sprints 2, 3, 5, 6 (all depend on competitive map) |
| 2 | Yes | Sprints 3, 4, 5, 6 (all depend on competitor pain) |
| 3 | Yes | Sprints 4, 5, 6 |
| 4 | Yes | Sprints 5, 6 |
| 5 | Yes | Sprint 6 |
| 6 | Yes | Sprint 7 |
| 7 | Yes | None (terminal) |

### 5B. Gap-Analyst Judge-Driven Iteration

```
gap-analyst completes report
        |
        v
  judge evaluates
        |
   MARGINAL/FAIL
        |
        v
  judge writes judge-feedback-round-N.json
        |
        v
  gap-analyst reads feedback, re-writes ONLY failing sections:
    - Citation grounding <8/10: find 2+ source quotes per claim
    - Pain depth <7/10: ask "why?" 3 times deeper
    - Specificity <7/10: replace "users" with named segments
    - Cross-source <8/10: only promote 3+ source claims
        |
        v
  judge re-evaluates (round N+1)
        |
  Max 3 rounds, then ship with weakness note
```

### 5C. Outer Iterative Refinement Loop (Iterative Draft Mode)

```
                   LEAN DRAFT (6 sprints)
                          |
                          v
                   DRAFT REPORT v1
                          |
       ┌──────────────────┼──────────────────┐
       |                  |                  |
       v                  v                  v
  report-critic      debate-agent     (parallel)
  (5 sub-teams)      (5 debate pairs)
       |                  |
       └──────┬───────────┘
              v
    improvement-planner
              |
              v
    TARGETED EXECUTION:
    ├── new searches (parallel)
    ├── citation expansion (parallel)
    ├── hypothesis refutation (parallel)
    ├── new competitor profiling (parallel)
    └── selective sprint re-runs
              |
              v
    CITATION RE-VERIFICATION (5 parallel)
              |
              v
    REGENERATE REPORT v(N+1)
              |
              v
    loop-controller
         /        \
    CONTINUE     STOP
       |           |
    loop to       SHIP
    critique
```

**Resume mode enters this loop with the previous report as draft v0.**
The `scan-resumption` agent copies files and writes `resumption-baseline.json`.
The `improvement-planner` reads `resumption-baseline.json` to understand what
data already exists. The critic red-teams the existing report as-is.

**Per-iteration agent counts:**

| Agent | Count per iteration | Notes |
|-------|-------------------|-------|
| report-critic | 1 coordinator | |
| critique sub-agents | 5 | parallel |
| debate-agent | 1 coordinator | |
| bull/bear/verdict agents | 15 | 3 per opportunity × 5 |
| improvement-planner | 1 | leaf |
| targeted search agents | 5-15 | varies by plan |
| citation expansion agents | 3-5 | varies by gaps |
| refutation agents | 2-5 | varies by hypotheses |
| new competitor profilers | 0-5 | only if critic finds gaps |
| synthesizer-coordinator (re-run) | 1 | only re-runs affected sprints |
| citation verifiers | 5 | mandatory |
| report generators | 2 | JSON + HTML |
| loop-controller | 1 | leaf |
| strategic-reviewer | 1 coordinator | |
| opportunity-strategist agents | up to 5 | parallel |
| iteration-journal | 1 | leaf, runs in background |
| **Subtotal per iteration** | **~45-65** | |

**Total across 3 iterations: ~135-195 additional agents**

**Convergence criteria (ALL must be true to STOP):**
- Critique score < 25
- Max opportunity score change < 5
- No new opportunities in top 10
- No CRITICAL findings
- New evidence rate < 10%
- OR max iterations reached (hard stop)

**Continue criteria (ANY triggers CONTINUE):**
- Any CRITICAL critique finding unaddressed
- Any top-5 opportunity with LOW confidence
- Citation coverage < 70%
- A top-5 opportunity lost its debate (BEAR won)
- New evidence rate > 30%

**Deferred sprint pull-in rules:**
| Critic flags... | Pull in sprint... |
|-----------------|-------------------|
| Weak evidence quality | Sprint 8 (signal strength) |
| Missing competitive moat analysis | Sprint 9 (counter-positioning) |
| No market forecast | Sprint 10 (consolidation forecast) |
| Missing leadership context | Sprint 11 (founder profiles) |
| No validation plan | Sprint 12 (community validation) |
| Missed pain signals | Sprint 7 (false-negative rescue) |

### 5D. Stage-Level Re-Run (Team Lead Decision)

When a judge returns `blockerForNextStage: true`:
- Team lead reviews the blocker reason
- May re-run specific sources (e.g., re-run reddit-competitor-scanner with adjusted queries)
- May acknowledge degraded data and proceed
- This is NOT automatic -- requires team lead judgment

---

## 6. Agent Count Estimate

### Assumptions for Typical Scan
- 30 competitors discovered
- Regular depth
- 5 market leaders, 10 challengers, 10 niche, 5 open-source
- 20 new competitors surfaced during scanning
- 12 source output files per QA evaluation

### 6A. Per-Stage Agent Counts

| Stage | Agent Type | Count | Notes |
|-------|-----------|-------|-------|
| **Planning** | planner | 1 | |
| | planner sub-agents | 4 | parallel |
| | **Subtotal** | **5** | |
| **Discovery** | market-mapper | 1 | coordinator |
| | mapper sub-agents | 4 | parallel |
| | profile-scraper | 1 | coordinator |
| | profiler-batch-N | 6 | 30 competitors / 5 per batch |
| | profiler-adhoc-N | 3 | ~3 new during profiling |
| | subreddit-discoverer | 1 | coordinator |
| | subreddit sub-agents | 4 | parallel |
| | query-generator | 1 | coordinator |
| | query sub-agents | 4 | parallel (30 competitors > 15) |
| | **Subtotal** | **25** | |
| **QA: Discovery** | judge-discovery | 1 | |
| | eval-<source> sub-agents | 6 | 4 discovery outputs + 2 validators |
| | documenter-discovery | 1 | |
| | observer sub-agents | 3 | no cross-stage at first QA |
| | **Subtotal** | **11** | |
| **Scanning** | Category A coordinators | 6 | reviews, trustpilot, appstore, reddit-comp, gh-issues, stackoverflow |
| | reviews-batch-N | 5 | ~30 competitors with review URLs |
| | trustpilot-batch-N | 4 | ~20 competitors on Trustpilot |
| | appstore-batch-N | 3 | ~10 competitors with apps |
| | reddit-comp sub-agents | 3 | leaders, challengers, niche |
| | gh-issues per OSS comp | 5 | 5 open-source competitors |
| | Category B scanners | 6 | reddit-market, hn, google, twitter, ph, kickstarter |
| | websearch-coordinator | 1 | |
| | ws sub-agents | 4 | complaints, switching, unmet, comparison |
| | switching-signal-hunter | 1 | |
| | switch sub-agents | 7 | 5 leaders + pairs + general |
| | competitor-profiler | 1 | |
| | scan-orchestrator | 1 | |
| | broaden agents (20 new) | 80 | 4 per new competitor |
| | deep-dive agents | 2 | reddit deep-dive, HN deep-dive |
| | **Subtotal** | **129** | |
| **QA: Scanning** | judge-scanning | 1 | |
| | eval-<source> sub-agents | 17 | ~15 source files + 2 validators |
| | documenter-scanning | 1 | |
| | observer sub-agents | 4 | including cross-stage |
| | **Subtotal** | **23** | |
| **Synthesis** | synthesizer-coordinator | 1 | |
| | Sprint 1 sub-agents | 3 | |
| | Sprint 2 sub-agents | 3 + merge | |
| | Sprint 3 sub-agents | 3 + merge | |
| | Sprint 4 | 1 | |
| | Sprint 5 sub-agents | 3 | |
| | Sprint 6 | 1 | |
| | Sprint 7 | 1 | |
| | **Subtotal** | **16** | (+ coordinator) |
| **QA: Synthesis** | judge-synthesis | 1 | |
| | eval-sprint-N sub-agents | 9 | 7 sprints + 2 validators |
| | documenter-synthesis | 1 | |
| | observer sub-agents | 4 | |
| | **Subtotal** | **15** | |

### 6B. Total Agent Count

**Iterative Draft Mode (default):**

| Category | Count |
|----------|-------|
| Planning | 5 |
| Discovery | 25 |
| Scanning | 129 |
| Scan Audit | 1 |
| Lean Synthesis (6 sprints) | 14 |
| Citation Verification | 5 |
| Draft Report | 2 |
| Iterative Loop (×3 iterations) | ~120-180 |
| Final Report + Summary | 2 |
| **TOTAL** | **~300-360** |

**Full Single-Pass Mode:**

| Category | Count |
|----------|-------|
| Planning | 5 |
| Discovery | 25 |
| QA: Discovery | 11 |
| Scanning | 129 |
| QA: Scanning | 23 |
| Synthesis (15 sprints) | 17 |
| QA: Synthesis | 15 |
| **TOTAL** | **~225** |

If judge iteration loops trigger (assume 1 round of re-runs):
- Re-run 2 sprints + downstream: +8 synthesis agents
- Re-run judge + documenter: +15 QA agents
- **Total with 1 iteration round: ~248**

### 6C. Peak Concurrent Agents

| Stage | Peak Concurrency | When |
|-------|-----------------|------|
| Planning | 4 | All 4 planner sub-agents running |
| Discovery | ~18 | All 4 coordinators active, each with parallel sub-teams |
| QA: Discovery | ~9 | judge eval sub-agents + documenter observer sub-agents |
| **Scanning** | **~50-60** | **All Category A/B scanners + broadening loop at peak** |
| QA: Scanning | ~19 | judge eval sub-agents (most files to evaluate) |
| Synthesis | 3 | Max parallel within any single sprint |
| QA: Synthesis | ~13 | judge eval sub-agents for 7 sprints + validators |

**Peak concurrent agents across entire pipeline: ~50-60** (during the Scanning stage when all original scanners are active, broadening agents are spawning for newly discovered competitors, and multiple batch agents are running within each coordinator).

---

## Appendix A: Orchestration Model

**The orchestrator is the single brain.** All other agents follow a "Completion Protocol" — they write output files + a completion signal, then exit. They do NOT spawn downstream agents.

```
                    orchestrator (the ONLY agent that spawns stage transitions)
                         |
         reads completion signals + QA verdicts at each boundary
                         |
        makes runtime decisions: adjust agent counts, skip sources,
        retry failures, manage iteration loops, present final results
                         |
    ┌────────┬───────────┼───────────┬──────────┬──────────────┐
    v        v           v           v          v              v
 planner  discovery   judge/doc   scanning   synthesizer   report-gen
           team                    team      coordinator     team
    │        │           │           │          │              │
    └────────┴───────────┴───────────┴──────────┴──────────────┘
              all report completion via files, NOT auto-proceed
```

**Before the orchestrator**: Agents used "Auto-Proceed" — each agent blindly spawned the next stage without knowing the full topology. This was waterfall with no runtime adaptation.

**With the orchestrator**: One agent sees the whole picture, reads QA results, adjusts agent counts, skips broken sources, and manages the iteration loop. Agents focus on their job and report completion.

## Appendix B: Quick Reference — Agent Definition Files

| Agent | Definition File | Role |
|-------|----------------|------|
| **orchestrator** | `.claude/agents/orchestrator.md` | **Master coordinator — owns all stage transitions** |
| planner | `.claude/agents/planner.md` | Produces bounded scan-spec.json |
| gap-analyst | `.claude/agents/gap-analyst.md` | Analyzes scan data, produces pain report |
| judge | `.claude/agents/judge.md` | Evaluates outputs against rubrics |
| documenter | `.claude/agents/documenter.md` | Documents issues and quality observations |
| synthesizer-coordinator | `.claude/agents/synthesizer-coordinator.md` | Runs 6-15 synthesis sprints (lean or full) |
| report-critic | `.claude/agents/report-critic.md` | Adversarial red-team critique (spawns 5 sub-teams) |
| debate-agent | `.claude/agents/debate-agent.md` | Bull vs bear debates per opportunity (spawns parallel pairs) |
| improvement-planner | `.claude/agents/improvement-planner.md` | Targeted improvement plan from critique + debates |
| loop-controller | `.claude/agents/loop-controller.md` | Convergence manager for iterative loop |
| strategic-reviewer | `.claude/agents/strategic-reviewer.md` | CEO/founder-mode strategic review per opportunity |
| iteration-journal | `.claude/agents/iteration-journal.md` | Human-readable iteration history journal |
| scan-resumption | `.claude/agents/scan-resumption.md` | Copy previous scan files and set iteration baseline |
| delta-summarizer | `.claude/agents/delta-summarizer.md` | Compares first draft to final report (iterative and resume modes) |
| All other agents | Defined inline in `GAPSCOUT-WORKFLOW.md` | Scanner coordinators, discovery agents, etc. |

Workflow file: `/home/jayknightcoolie/claude-business/gapscout/GAPSCOUT-WORKFLOW.md`
