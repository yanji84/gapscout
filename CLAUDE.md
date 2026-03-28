# GapScout

Market intelligence engine that maps competitors, mines weaknesses across 11+ sources, identifies whitespace, and scores opportunities.

## Quick Start

```
/gapscout [market name or description]
```

Examples:
- `/gapscout pokemon TCG market`
- `/gapscout project management tools`
- `/gapscout Jira, Asana, Linear, Monday`
- `/gapscout` (no input → suggests markets from HN frontpage)

## Architecture

The `/gapscout` skill spawns the **orchestrator agent** (`.claude/agents/orchestrator.md`) which coordinates the entire pipeline. Default mode is **iterative draft** — a lean first pass refined through critique→debate→improve cycles.

### Iterative Draft Mode (default)

```
orchestrator (single brain, owns all stage transitions)
  ├── planner (4 research sub-agents)
  ├── discovery team (4 coordinators, each with sub-teams)
  ├── trust-scorer (4 dimension sub-agents)
  ├── scanner team (all sources in parallel + broadening loop)
  ├── citation-watchdog (background — validates data as it appears)
  ├── LEAN synthesis (6 core sprints: map → pain → needs → switching → gaps → scoring)
  ├── citation verification (5 parallel verifiers)
  ├── draft report v1
  └── ITERATIVE REFINEMENT LOOP (max 3 iterations):
      ├── report-critic (5 parallel sub-teams: evidence, perspective, bias, competitors, counter-evidence)
      ├── debate-agent (parallel bull/bear pairs per top opportunity)
      ├── strategic-reviewer (parallel strategist per opportunity — CEO lens)
      ├── improvement-planner (targeted action plan)
      ├── targeted re-scan + re-synthesize + citation expansion
      ├── report v(N+1)
      ├── loop-controller (converge or continue?)
      └── iteration-journal (appends human-readable record)

Resume mode: previous report → draft v0 → enters loop at critique step
```

### Full Single-Pass Mode (set `iterativeMode.enabled: false`)

```
orchestrator
  ├── planner → discovery → judge/documenter QA
  ├── scanner team → judge/documenter QA
  ├── synthesizer (15 sequential sprints)
  ├── deep-research-verifier (max 3 rounds)
  ├── judge/documenter QA (with iteration loop)
  ├── citation verification → report generators
  └── delta-summarizer (resume mode only)
```

~225 agents per scan. Peak concurrency ~50-60 during scanning.

## Agent Definitions

| Agent | File | Role |
|-------|------|------|
| orchestrator | `.claude/agents/orchestrator.md` | Master coordinator |
| planner | `.claude/agents/planner.md` | Bounded scan specification |
| gap-analyst | `.claude/agents/gap-analyst.md` | Pain point analysis |
| judge | `.claude/agents/judge.md` | Quality evaluation with rubrics |
| documenter | `.claude/agents/documenter.md` | Issue documentation |
| synthesizer-coordinator | `.claude/agents/synthesizer-coordinator.md` | 15-sprint synthesis |
| synthesis-signal-strength | `.claude/agents/synthesis-signal-strength.md` | Evidence credibility scoring |
| synthesis-counter-positioning | `.claude/agents/synthesis-counter-positioning.md` | Incumbent moat analysis |
| synthesis-consolidation-forecast | `.claude/agents/synthesis-consolidation-forecast.md` | M&A and market forecast |
| synthesis-founder-profiles | `.claude/agents/synthesis-founder-profiles.md` | Leadership research |
| trust-scorer | `.claude/agents/trust-scorer.md` | Competitor legitimacy scoring |
| scan-auditor | `.claude/agents/scan-auditor.md` | Post-scan data integrity validation |
| deep-research-verifier | `.claude/agents/deep-research-verifier.md` | Iterative opportunity verification |
| community-validator | `.claude/agents/community-validator.md` | Community validation suggestions per opportunity |
| synthesis-market-sizing | `.claude/agents/synthesis-market-sizing.md` | TAM/SAM/SOM and GTM analysis |
| synthesis-causal-chains | `.claude/agents/synthesis-causal-chains.md` | Root cause chain analysis |
| synthesis-strategic-narrative | `.claude/agents/synthesis-strategic-narrative.md` | Strategic narrative and recommendations |
| scan-resumption | `.claude/agents/scan-resumption.md` | Copy previous scan files and set iteration baseline |
| citation-watchdog | `.claude/agents/citation-watchdog.md` | Real-time fabrication detection |
| delta-summarizer | `.claude/agents/delta-summarizer.md` | Compares first draft to final report (iterative and resume modes) |
| report-critic | `.claude/agents/report-critic.md` | Adversarial red-team critique (spawns 5 sub-teams) |
| debate-agent | `.claude/agents/debate-agent.md` | Bull vs bear debates per opportunity (spawns parallel pairs) |
| improvement-planner | `.claude/agents/improvement-planner.md` | Targeted improvement plan from critique + debates |
| loop-controller | `.claude/agents/loop-controller.md` | Convergence manager for iterative loop |
| strategic-reviewer | `.claude/agents/strategic-reviewer.md` | CEO/founder-mode strategic review per opportunity |
| iteration-journal | `.claude/agents/iteration-journal.md` | Human-readable iteration history journal |

See `AGENT-RELATIONSHIPS.md` for full topology, data flows, and agent counts.

## CLI (used internally by agents)

```bash
node scripts/cli.mjs <source> <command> [options]
```

Sources: `api`, `browser`, `hn`, `google`, `ph`, `reviews`, `kickstarter`, `appstore`, `trustpilot`, `all`

## Key Files

- `GAPSCOUT-WORKFLOW.md` — Full pipeline workflow with agent prompts
- `AGENT-RELATIONSHIPS.md` — Agent topology, data flows, context resets
- `ISSUES.md` — Known bugs and improvement opportunities
- `SKILL.md` — Legacy skill documentation (pre-orchestrator)
