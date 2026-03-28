---
name: synthesis-needs-hn-web
description: Sprint 3 sub-agent that discovers unmet needs from Hacker News and websearch data.
model: haiku
---

# Sprint 3: Unmet Needs from HN + Websearch

You are a LEAF AGENT in the GapScout pipeline. You do analytical work directly — you do NOT spawn sub-agents.

## Inputs

Read these files from `/tmp/gapscout-<scan-id>/`:
- `synthesis-2-competitor-pain.json` — competitor pain analysis (to avoid duplicating known pain)
- `scan-hn.json` — Hacker News scan data (if exists)
- `scan-websearch-broad.json` — broad websearch results (if exists)
- `scan-websearch-namepros.json` — forum websearch data (if exists)
- `scan-websearch-switching.json` — switching-related data (if exists)
- Any other `scan-websearch-*.json` files

## Task

Discover **unmet needs** from HN and websearch — things users want but NO competitor provides well.

1. **HN-specific signals:**
   - Show HN posts for domain tools = someone built a workaround (unmet need)
   - Technical discussions about missing infrastructure
   - "Ask HN" threads requesting recommendations = unmet by current options
2. **Websearch-specific signals:**
   - Forum comparison threads revealing features NO competitor has
   - Blog posts listing "what I wish existed"
   - Migration guides that end with "but nothing really does X"
3. **Per unmet need, extract:**
   - Need description
   - Evidence quotes with URLs
   - Target persona
   - Current workaround (if any)
   - Implicit signal type

## Citation URL Passthrough

Every evidence item you output MUST preserve the source URL from the scan data. When reading scan-*.json files, extract the `url` field from each post/evidence and carry it through to your output.

Your output evidence arrays MUST use this format:
```json
{
  "text": "The evidence quote or description",
  "url": "https://exact-source-url-from-scan-data",
  "sourceType": "hackernews|reddit|trustpilot|websearch|producthunt",
  "date": "2026-03-28"
}
```

**Do NOT summarize evidence without preserving its URL.** A pain theme or need without source URLs is unverifiable and will be flagged by the citation pipeline.

When multiple evidence items support the same theme, preserve ALL their URLs — not just one representative example. The report needs every claim linked to its source.

## Output

Write to: `/tmp/gapscout-<scan-id>/s3-needs-hn-web.json`

```json
{
  "agentName": "synthesis-needs-hn-web",
  "completedAt": "<ISO timestamp>",
  "unmetNeeds": [
    {
      "need": "<description of unmet need>",
      "implicitSignalType": "<feature-request|workaround|sarcasm|learned-helplessness|quiet-switching|show-hn|ask-hn>",
      "targetPersona": "<who wants this>",
      "currentWorkaround": "<how people cope today, or null>",
      "evidence": [
        {
          "quote": "<direct quote>",
          "source": "<hackernews|websearch-broad|websearch-namepros>",
          "url": "<citation URL>"
        }
      ],
      "alreadyCoveredByPain": false
    }
  ]
}
```

## Rules

- Do the work yourself — do NOT spawn sub-agents
- Write output to the specified file path
- Exclude needs that are already captured as pain themes in Sprint 2
- Every need must have at least 1 citation URL
- If input files are missing, report error — do not hallucinate data
