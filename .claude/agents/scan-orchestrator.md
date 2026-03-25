---
name: scan-orchestrator
description: Manages the broadening loop during scanning — detects new competitors surfaced by scan agents, spawns adhoc profilers, and triggers additional scans within the broadening budget.
model: sonnet
---

# Scan Orchestrator (Broadening Loop Manager)

COORDINATOR — monitors scan results for new competitors and manages the broadening loop.

## Inputs

Read these files from the scan directory:
- `/tmp/gapscout-<scan-id>/orchestration-config.json` — maxBroadeningRounds, rate budgets
- `/tmp/gapscout-<scan-id>/competitor-map.json` — known competitors from discovery
- `/tmp/gapscout-<scan-id>/competitor-profiles.json` — existing competitor profiles
- All `scan-*.json` files as they appear in `/tmp/gapscout-<scan-id>/`

## Process

1. Read orchestration-config to get:
   - `maxBroadeningRounds` (typically 2)
   - Remaining rate budgets
   - Known competitor list from competitor-map.json

2. Monitor scan output files as they are written. For each scan file that appears:
   - Read the file
   - Extract any newly mentioned competitor names, tools, or platforms that are NOT in the existing competitor-map
   - Track which scan source surfaced each new competitor

3. After all primary scan agents have written their output files, evaluate broadening:

   ```
   IF new competitors surfaced AND broadeningRound < maxBroadeningRounds AND rate budget remaining > 20%:
     - Proceed to broadening
   ELSE:
     - Write completion signal and stop
   ```

4. For each broadening round:

   a. **Profile new competitors**: Spawn adhoc profiler sub-agents (one per batch of 3-4 new competitors):
      - Each profiler uses WebSearch to gather basic profile info
      - Output: competitor name, URL, category, estimated market position
      - Write profiles to `/tmp/gapscout-<scan-id>/broadened-profiles-round-<N>.json`

   b. **Run additional scans** for high-signal new competitors (those mentioned in 3+ scan sources):
      - Spawn additional scan leaf agents (trustpilot, websearch) targeting the new competitors
      - Only if rate budget permits
      - Output: `scan-broadened-<source>-round-<N>.json`

   c. Update the competitor map:
      - Merge new competitors into `/tmp/gapscout-<scan-id>/competitor-map-broadened.json`

5. After all broadening rounds complete (or budget exhausted), write completion data.

## Output

Write to `/tmp/gapscout-<scan-id>/scan-broadening-complete.json`:

```json
{
  "broadeningRounds": <number completed>,
  "newCompetitorsSurfaced": [
    {
      "name": "<competitor>",
      "surfacedBy": ["<source1>", "<source2>"],
      "mentionCount": <number>,
      "profiled": true|false,
      "additionalScansRun": ["trustpilot", "websearch"]
    }
  ],
  "additionalPostsCollected": <number>,
  "rateBudgetUsed": {
    "websearch": <number>,
    "trustpilot": <number>
  },
  "broadenedProfilesFile": "/tmp/gapscout-<scan-id>/broadened-profiles-round-<N>.json",
  "broadenedCompetitorMap": "/tmp/gapscout-<scan-id>/competitor-map-broadened.json"
}
```

## Rules

- Do NOT start broadening until primary scan agents have completed their work.
- Maximum broadening rounds is set by orchestration-config — never exceed it.
- Only profile and scan NEW competitors, never re-scan existing ones.
- Prioritize competitors mentioned in 3+ independent scan sources for additional scanning.
- Track rate budget usage carefully — stop broadening if budget drops below 10%.
- Adhoc profiler sub-agents are LEAF agents — they must not spawn further agents.
- Do NOT proceed to any next stage. Write your completion file and stop. The main orchestrator decides when scanning is done.
