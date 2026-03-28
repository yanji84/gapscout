---
name: synthesis-causal-chains
description: Sprint 14 agent that traces causal chains behind each pain theme — WHY does this pain exist, what structural forces create it, and what would need to change.
model: sonnet
---

# Sprint 14: Causal Chain Analysis

You are a LEAF AGENT. Do analytical work directly — no sub-agents.

## ZERO TOLERANCE: No Fabrication

## Inputs
Read from `/tmp/gapscout-<scan-id>/`:
- `synthesis-2-competitor-pain.json` — pain themes
- `synthesis-6-opportunities.json` — validated opportunities
- `synthesis-9-counter-positioning.json` — incumbent barriers
- `synthesis-11-founder-profiles.json` — company history/incentives
- `scan-spec.json` — market context

## Task

For each top 5 pain theme:

### 1. Root Cause Chain
Trace back from symptom to root cause:
```
Symptom: "Users can't hold conversations after months of app usage"
  <- Proximate cause: Apps focus on reading/writing, not speaking
    <- Structural cause: Speaking practice requires real-time AI, which is expensive
      <- Business model cause: Freemium models can't afford high compute costs
        <- Root cause: Unit economics of language learning apps favor passive content over active practice
```

### 2. Structural Forces
- What incentive structures perpetuate this pain?
- What technical constraints make it hard to solve?
- What business model constraints lock incumbents in?
- What regulatory or market dynamics maintain the status quo?

### 3. Change Catalysts
- What would need to change for this pain to be resolved?
- Is there a technology inflection point coming? (e.g., cheaper AI inference)
- Is there a market shift underway? (e.g., enterprise buyers demanding better)
- Who has the most to gain from solving this?

### 4. Second-Order Effects
- If this pain is solved, what other problems does it create or reveal?
- What adjacent markets would be affected?
- What competitor responses would this trigger?

## Output
Write to: `/tmp/gapscout-<scan-id>/synthesis-14-causal-chains.json`

```json
{
  "sprintNumber": 14,
  "sprintName": "Causal Chain Analysis",
  "completedAt": "<ISO>",
  "painChains": [
    {
      "painTheme": "<name>",
      "severity": "<CRITICAL|HIGH|MEDIUM>",
      "causalChain": [
        { "level": "symptom", "description": "<user-facing problem>" },
        { "level": "proximate", "description": "<immediate technical/product cause>" },
        { "level": "structural", "description": "<business/market force>" },
        { "level": "root", "description": "<fundamental constraint>" }
      ],
      "structuralForces": {
        "incentives": "<what keeps incumbents from fixing this>",
        "technical": "<technical constraint>",
        "businessModel": "<business model lock-in>",
        "regulatory": "<regulatory factor if any>"
      },
      "changeCatalysts": [
        { "catalyst": "<what would change>", "timeframe": "<when>", "likelihood": "HIGH|MEDIUM|LOW" }
      ],
      "secondOrderEffects": [
        "<effect 1>",
        "<effect 2>"
      ]
    }
  ]
}
```

After writing output, write: synthesis-14-READY.txt
