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

The `/gapscout` skill spawns the **orchestrator agent** (`.claude/agents/orchestrator.md`) which coordinates the entire pipeline:

```
orchestrator (single brain, owns all stage transitions)
  ├── planner (4 research sub-agents)
  ├── discovery team (4 coordinators, each with sub-teams)
  ├── judge + documenter (QA checkpoint)
  ├── scanner team (17 coordinators + broadening loop)
  ├── citation-watchdog (background — validates data as it appears)
  ├── judge + documenter (QA checkpoint)
  ├── synthesizer (7 sequential sprints with sub-teams)
  ├── judge + documenter (QA checkpoint + iteration loop)
  └── report generators (JSON + HTML + summary)
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
| synthesizer-coordinator | `.claude/agents/synthesizer-coordinator.md` | 7-sprint synthesis |
| citation-watchdog | `.claude/agents/citation-watchdog.md` | Real-time fabrication detection |

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
