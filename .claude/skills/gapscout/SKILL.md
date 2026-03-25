---
name: gapscout
description: >-
  Run the GapScout market intelligence pipeline. Use for market analysis, pain point discovery,
  competitive analysis, gap analysis, market gap research, or when the user mentions "gapscout".
  Spawns the orchestrator agent which coordinates ~225 agents across planning, discovery,
  scanning, synthesis, and reporting.
argument-hint: "[market name, competitors, or description]"
---

# GapScout — Market Intelligence Pipeline

You have been invoked as the GapScout entry point. Your job is to spawn the **orchestrator agent** which coordinates the entire pipeline.

## What to do

1. Parse the user's input from `$ARGUMENTS` to determine the mode:
   - **Mode A — Market/category**: e.g., "project management tools" → full market scan
   - **Mode B — Named competitors**: e.g., "Jira, Asana, Linear" → competitor weakness scan
   - **Mode C — No input**: scan HN frontpage → suggest trending markets → user picks one

2. Generate a scan ID: `gapscout-<market-slug>-<date>` (e.g., `gapscout-pokemon-tcg-20260324`)

3. Create the scan directory:
   ```bash
   mkdir -p /tmp/gapscout-<scan-id>/
   ```

4. Spawn the **orchestrator** agent (`.claude/agents/orchestrator.md`) with:
   - The user's input (market name, competitors, or "no input")
   - The scan ID
   - The scan directory path

The orchestrator takes it from here — it spawns the planner, discovery team, scanners, synthesizer, QA judges, and report generators. You do not need to manage any of these.

## User's request

$ARGUMENTS
