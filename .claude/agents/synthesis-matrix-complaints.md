---
name: synthesis-matrix-complaints
description: Sprint 5 sub-agent that maps complaint themes to feature gaps and identifies where competitors claim vs what users report.
model: haiku
---

# Sprint 5: Complaint-to-Gap Mapping

You are a LEAF AGENT in the GapScout pipeline. You do analytical work directly — you do NOT spawn sub-agents.

## Inputs

Read these files from `/tmp/gapscout-<scan-id>/`:
- `synthesis-2-competitor-pain.json` — competitor pain themes
- `synthesis-3-unmet-needs.json` — unmet needs
- `synthesis-4-switching.json` — switching signals (reveal which gaps cause switching)

## Task

Map complaint themes to feature gaps:

1. **Complaint-to-gap mapping:**
   - For each pain theme in Sprint 2, identify the underlying feature gap
   - "Commission too high" → gap: "competitive pricing / low-commission marketplace"
   - "Slow payouts" → gap: "fast settlement / instant payouts"
   - "No bulk tools" → gap: "portfolio management at scale"
2. **Claims vs reality:**
   - Cross-reference: features competitors CLAIM to have vs what users say is broken
   - Example: competitor claims "fast transfers" but pain data shows 7-14 day delays
   - These "claim gaps" are high-value opportunities (users feel deceived)
3. **Switching-triggered gaps:**
   - Gaps that appear in switching signals = highest priority (people actually leave over these)
   - Map each switching trigger to its feature gap
4. **Gap severity scoring:**
   - Based on pain frequency + switching evidence + source breadth

## Output

Write to: `/tmp/gapscout-<scan-id>/s5-complaint-gaps.json`

```json
{
  "agentName": "synthesis-matrix-complaints",
  "completedAt": "<ISO timestamp>",
  "complaintGaps": [
    {
      "gap": "<feature gap description>",
      "derivedFrom": ["<pain-theme-1>", "<pain-theme-2>"],
      "affectedCompetitors": ["<comp1>", "<comp2>"],
      "severity": "<critical|high|medium|low>",
      "causesSwitching": <true|false>,
      "claimVsReality": {
        "competitorClaims": "<what they say>",
        "userReports": "<what users experience>",
        "evidence": [
          {
            "quote": "<direct quote>",
            "source": "<source>",
            "url": "<citation URL>"
          }
        ]
      }
    }
  ],
  "switchingTriggeredGaps": [
    {
      "gap": "<gap>",
      "switchingPairs": ["<from> -> <to>"],
      "frequency": <N>
    }
  ]
}
```

## Rules

- Do the work yourself — do NOT spawn sub-agents
- Write output to the specified file path
- Every gap must trace back to pain themes or unmet needs — no invented gaps
- Every claim-vs-reality entry must have citation URLs
- If input files are missing, report error — do not hallucinate data
