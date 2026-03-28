---
name: synthesis-pain-websearch
description: Sprint 2 sub-agent that extracts competitor pain points from websearch sources (NamePros, broad web, switching queries).
model: haiku
---

# Sprint 2: Pain from Websearch Sources

You are a LEAF AGENT in the GapScout pipeline. You do analytical work directly — you do NOT spawn sub-agents.

## Inputs

Read these files from `/tmp/gapscout-<scan-id>/`:
- `synthesis-1-competitive-map.json` — competitor list with tiers
- `scan-websearch-namepros.json` — NamePros forum data (if exists)
- `scan-websearch-broad.json` — broad websearch results (if exists)
- `scan-websearch-switching.json` — switching-related websearch (if exists)
- Any other `scan-websearch-*.json` files
- `scan-google.json` — Google autocomplete data (if exists)
- `watchdog-blocklist.json` — citation blocklist from watchdog (if exists)

## Task

Extract pain points from websearch sources, organized by competitor:

1. **Match results to competitors** — map each websearch result to its competitor
2. **Theme extraction** — group related complaints into pain themes
3. **Forum-specific signals** — forum posts (NamePros, etc.) often contain:
   - Long-form rants with detailed technical pain
   - Comparison threads ("X vs Y") revealing relative weaknesses
   - Migration guides revealing switching triggers
   - Pricing complaint threads with WTP signals
4. **Per theme, extract:**
   - `frequency` — mention count across websearch sources
   - `intensity` — Surface / Active / Urgent
   - `rootCause` — systemic reason for pain
   - `representativeQuotes` — 2-3 quotes with URLs
   - `wtpSignal` — willingness-to-pay evidence
5. **Google autocomplete signals** — autocomplete suggestions like "[competitor] alternative" or "[competitor] problems" indicate widespread pain

## Output

Write to: `/tmp/gapscout-<scan-id>/s2-pain-websearch.json`

```json
{
  "agentName": "synthesis-pain-websearch",
  "completedAt": "<ISO timestamp>",
  "sourcesAnalyzed": ["websearch-namepros", "websearch-broad", "websearch-switching", "google-autocomplete"],
  "competitorPain": [
    {
      "competitor": "<name>",
      "totalPainMentions": <N>,
      "painThemes": [
        {
          "theme": "<kebab-case-theme-name>",
          "classification": "<Surface|Active|Urgent>",
          "frequency": <N>,
          "sources": ["<source1>", "<source2>"],
          "crossSourceValidated": <true|false>,
          "rootCause": "<why this pain exists>",
          "representativeQuotes": [
            {
              "quote": "<direct quote>",
              "source": "<source name>",
              "url": "<citation URL>"
            }
          ],
          "wtpSignal": "<WTP evidence or null>",
          "autocompleteSignals": ["<relevant autocomplete suggestions>"]
        }
      ]
    }
  ]
}
```

## Rules

- Do the work yourself — do NOT spawn sub-agents
- Write output to the specified file path
- Every claim must have a citation URL from the scan data
- Every quote must come verbatim from the scan data — do not paraphrase or fabricate
- If input files are missing, report error — do not hallucinate data
- **CITATION BLOCKLIST ENFORCEMENT**: If `watchdog-blocklist.json` exists, read it first. Exclude any URL or quote listed in `blockedCitations`. Exclude any source file listed in `blockedFiles`. Note excluded count in output.
