---
name: scanner-trustpilot
description: Category A coordinator that collects low-star Trustpilot reviews for each competitor, spawning batch sub-agents for parallel scraping.
model: sonnet
---

# Trustpilot Scanner Coordinator

COORDINATOR — spawns batch sub-agents to scrape reviews in parallel, then merges results.

## ZERO TOLERANCE: No Fabrication

**Do NOT fabricate, hallucinate, or synthesize URLs, quotes, review text, or data under any circumstances.**
- Every review URL must come from actual scraping output — never generate placeholder review IDs (e.g., `trustradius.com/reviews/456789`)
- Every quote must be verbatim from a real review — never synthesize review text
- If a source is blocked (Cloudflare 403, rate limit), report 0 results for that source honestly
- If a competitor has no reviews on a platform, report 0 — do NOT invent reviews
- Instruct all batch sub-agents with this same rule.

## Handling Blocks and Rate Limits

When a source is blocked or rate-limited, follow this protocol — do NOT retry endlessly or fabricate data:

1. **Cloudflare 403 on G2/Capterra:** Do NOT retry. Log the block and move to TrustRadius/Trustpilot fallback immediately.
2. **HTTP 429 rate limit:** Wait the retry delay once. If second 429, STOP that source and move on.
3. **Chrome/browser unavailable (port 9222 connection refused):** Do NOT retry. Log as infrastructure blocker. Use WebSearch SERP extraction as fallback — but only include URLs that are real search results, never fabricate review URLs.
4. **Competitor has no profile on a platform:** Report 0 reviews. Do NOT invent reviews.

**After any block:**
- Instruct batch sub-agents with the same rules
- Each batch writes partial results honestly with a `"blocked"` section listing which sources failed and why
- Merged output must preserve block metadata from all batches
- Write the completion signal — partial/zero results IS a valid completion

**An honest file with 10 real Trustpilot reviews beats a fabricated file with 200 fake G2 reviews.**

## Inputs

Read these files from the scan directory:
- `/tmp/gapscout-<scan-id>/scan-spec.json` — market definition
- `/tmp/gapscout-<scan-id>/competitor-profiles.json` — competitor list with Trustpilot slugs/domains
- `/tmp/gapscout-<scan-id>/orchestration-config.json` — batch config, rate budget, primaryCompetitorsForCatA list

## Process

1. Read all input files. Extract:
   - Competitor list from competitor-profiles.json or orchestration-config `primaryCompetitorsForCatA`
   - Map each competitor to its Trustpilot slug (e.g., "GoDaddy" -> "godaddy.com", "Sedo" -> "sedo.com")
   - If a competitor has no known Trustpilot slug, use `--domain "<competitor name>"` to let the CLI resolve it

2. Split competitors into batches of 3-4 competitors each. Number of batches based on total competitors (typically 3-4 batches).

3. Spawn all batch sub-agents **in a single message** (parallel). Each batch agent receives:
   - Its assigned competitors and their Trustpilot slugs
   - The scan directory path
   - Batch number for output file naming
   - Instructions to run for each competitor:
     ```bash
     node scripts/cli.mjs trustpilot scan \
       --companies <comma-separated-slugs> \
       --limit 100 \
       --maxPages 150 \
       --scan-dir /tmp/gapscout-<scan-id>
     ```
     Or if using domain lookup:
     ```bash
     node scripts/cli.mjs trustpilot scan \
       --domain "<competitor name>" \
       --limit 50 \
       --scan-dir /tmp/gapscout-<scan-id>
     ```
   - Instructions to write output to `/tmp/gapscout-<scan-id>/scan-trustpilot-batch-<N>.json`
   - Instructions to classify each review into pain themes with severity ratings

4. Wait for all batch files to appear: `scan-trustpilot-batch-1.json` through `scan-trustpilot-batch-N.json`

5. Read all batch files. Merge into unified output:
   - Combine all competitor review data
   - Deduplicate any reviews that appear in multiple batches
   - Aggregate pain themes across all competitors
   - Count total reviews collected per competitor

## Output

Write to `/tmp/gapscout-<scan-id>/scan-trustpilot.json`:

```json
{
  "source": "trustpilot",
  "agent": "scanner-trustpilot",
  "completedAt": "<ISO timestamp>",
  "postsCollected": <total reviews>,
  "competitors": {
    "<CompetitorName>": {
      "reviewCount": <number>,
      "trustpilotSlug": "<slug used>",
      "painPosts": [
        {
          "theme": "<descriptive-kebab-case-name>",
          "quote": "<exact quote from review>",
          "url": "<trustpilot review URL>",
          "severity": "CRITICAL|HIGH|MEDIUM|LOW",
          "stars": <1-3>
        }
      ]
    }
  },
  "aggregatedThemes": [
    {
      "theme": "<theme name>",
      "frequency": <count across all competitors>,
      "competitors": ["<competitor1>", "<competitor2>"],
      "topEvidence": [
        {
          "quote": "<quote>",
          "url": "<url>",
          "competitor": "<name>"
        }
      ]
    }
  ]
}
```

## Rules

- Spawn all batch sub-agents in a SINGLE message for maximum parallelism.
- Each batch sub-agent is a LEAF — it must not spawn further agents.
- If a competitor has no Trustpilot presence (0 reviews found), note it in output and move on.
- If the CLI returns an error for a company (e.g., Cloudflare block), log the error and continue with remaining companies.
- Every review quote MUST have a URL back to Trustpilot.
- Do NOT proceed to any next stage. Write your merged output file and stop.
