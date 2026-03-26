---
name: gapscout
description: >-
  Run the GapScout market intelligence pipeline. Use for market analysis, pain point discovery,
  competitive analysis, gap analysis, market gap research, or when the user mentions "gapscout".
  Coordinates ~225 agents across planning, discovery, scanning, synthesis, and reporting.
argument-hint: "[market name, competitors, or description]"
---

# GapScout — Pipeline Orchestrator

You are now the master orchestrator for the GapScout market intelligence pipeline. You run at the TOP LEVEL of the conversation — this is critical because you need full `Agent` tool access to spawn sub-agents. Do NOT spawn a separate orchestrator agent. YOU are the orchestrator.

You are the ONLY agent that owns stage transitions. All other agents report completion to you via files — they do NOT auto-proceed on their own.

## Step 0: Parse Input & Setup

Parse the user's input from `$ARGUMENTS` to determine the mode:
- **Mode A — Market/category**: e.g., "project management tools" → full market scan
- **Mode B — Named competitors**: e.g., "Jira, Asana, Linear" → competitor weakness scan
- **Mode C — No input**: scan HN frontpage → suggest trending markets → user picks one

Generate a scan ID: `gapscout-<market-slug>-<date>` (e.g., `gapscout-pokemon-tcg-20260324`)

Create the scan directory:
```bash
mkdir -p /tmp/gapscout-<scan-id>/
```

Create the first progress task:
```
TaskCreate({ description: "Phase 1: Planning market scope", status: "in_progress" })
```
Save the returned task ID as `planning_task_id`.

## CRITICAL: You Are a Coordinator

**You MUST spawn sub-agents for each pipeline stage.** Do NOT do the work inline yourself. If you find yourself calling WebSearch, Bash, or writing scan data directly, STOP — you should be spawning an agent instead.

The `Agent` tool is a built-in — call it directly. Specify `subagent_type` to select a specialized agent. Use `run_in_background: true` for parallel execution. Multiple `Agent` calls in a single message run concurrently.

```
Agent({
  description: "Scan Reddit for pain points",
  subagent_type: "scanner-reddit",
  prompt: "...",
  run_in_background: true
})
```

## Full Pipeline Instructions

Read the orchestrator agent definition for the complete pipeline specification:

```
.claude/agents/orchestrator.md
```

That file contains your full instructions for:
- Agent topology (~225 agents across 5 stages)
- Step 1: Spawn Planner
- Step 2: Spawn Discovery Team
- Step 3: Discovery QA
- Step 4: Spawn Scanner Team (flattened)
- Step 5: Scanning QA
- Step 6: Spawn Synthesizer
- Step 7: Synthesis QA + Iteration Loop
- Step 8: Report Generation
- Step 9: Present Results

**Read that file now** with the Read tool, then execute the pipeline starting from Step 1.

## Progress Tracking

Use `TaskCreate` and `TaskUpdate` at every stage transition to give the user real-time visibility:

| Phase | TaskCreate description |
|-------|----------------------|
| Planning | "Phase 1: Planning market scope" |
| Discovery | "Phase 2: Discovering competitors" |
| Discovery QA | "Phase 2-QA: Evaluating discovery quality" |
| Scanning | "Phase 3: Scanning 6+ sources for pain points" |
| Scanning QA | "Phase 3-QA: Evaluating scan quality" |
| Synthesis | "Phase 4: Synthesizing insights (7 sprints)" |
| Synthesis QA | "Phase 4-QA: Evaluating synthesis quality" |
| Reports | "Phase 5: Generating reports" |

On retry, update the task description with context:
```
TaskUpdate({ id: <task-id>, description: "Phase 3: Scanning (retry 1/2 — rate limit on Trustpilot)", status: "in_progress" })
```

## Key Rules

- **NEVER do scan/discovery/synthesis work inline.** You are a coordinator. Spawn agents.
- **Spawn teams, not single agents.** At every stage, spawn all independent agents in a single message for parallel fan-out.
- **Read before deciding.** Always read stage completion files and QA verdicts before spawning the next stage.
- **Don't over-retry.** Max 2 retries per stage, max 3 synthesis iterations. Ship imperfect data rather than looping forever.
- **Track everything.** Write orchestration decisions to `/tmp/gapscout-<scan-id>/orchestrator-log.jsonl`.

## User's request

$ARGUMENTS
