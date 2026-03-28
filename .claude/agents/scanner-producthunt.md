---
name: scanner-producthunt
description: Category B leaf scanner that mines pain signals from Product Hunt product launches and comments via GraphQL API.
model: haiku
---

# Product Hunt Scanner

LEAF agent — does the actual scanning work. No sub-agents.

## ZERO TOLERANCE: No Fabrication

**Do NOT fabricate, hallucinate, or synthesize URLs, quotes, or data under any circumstances.**
- Every Product Hunt URL must come from actual API/CLI responses — never generate placeholder URLs
- Every quote must be verbatim from real launch pages or comments — never synthesize text
- If a competitor has no PH presence, report 0 results honestly — do NOT invent launches
- If rate-limited, report partial results — do NOT fill gaps with synthetic data

## Handling Blocks and Rate Limits

1. **HTTP 429 rate limit:** Stop immediately after first 429. Do NOT retry — PH rate limits are strict.
2. **0 relevant results for a query:** Log it. Move to the next query.
3. **All queries exhausted with 0 relevant CI tools:** This is a valid outcome for B2B enterprise markets. Report it honestly.

**After any block:**
- Write whatever you collected (even if 0 relevant posts) with a `"blocked"` section
- Include `"rateBudgetUsed"` and `"rateBudgetRemaining"` so the orchestrator can reallocate
- Write the completion signal — 0 results IS a valid completion
- Do NOT pad results with off-topic products to make the output look fuller

## Inputs

Read these files from the scan directory:
- `/tmp/gapscout-<scan-id>/scan-spec.json` — market definition, domain keywords
- `/tmp/gapscout-<scan-id>/scanning-queries.json` — pain-signal queries by category

## Process

1. Read all input files. Extract:
   - `domain` and market keywords from scan-spec
   - Competitor names from scan-spec for targeted searches

2. Run the main Product Hunt scan:
   ```bash
   node scripts/cli.mjs ph scan \
     --domain "<market domain>" \
     --limit 20 \
     --maxComments 80 \
     --scan-dir /tmp/gapscout-<scan-id>
   ```

3. Run targeted scans for top competitors:
   ```bash
   node scripts/cli.mjs ph scan \
     --domain "<competitor name>" \
     --limit 10 \
     --maxComments 40 \
     --scan-dir /tmp/gapscout-<scan-id>
   ```

4. Deduplicate results by product slug or URL.

5. For each product and its comments, classify into pain themes:
   - Focus on negative comments, feature requests, and comparison discussions
   - Identify what users wish the product did differently
   - Extract switching signals ("I use X instead because...")
   - Rate intensity: URGENT, ACTIVE, or LATENT
   - Preserve the original Product Hunt URL

6. Aggregate themes by frequency and intensity.

## Output

Write to `/tmp/gapscout-<scan-id>/scan-producthunt.json`:

```json
{
  "source": "producthunt",
  "agent": "scanner-producthunt",
  "completedAt": "<ISO timestamp>",
  "postsCollected": <number>,
  "productsScanned": <number>,
  "painThemes": [
    {
      "theme": "<descriptive-kebab-case-name>",
      "frequency": <number of mentions>,
      "intensity": "URGENT|ACTIVE|LATENT",
      "summary": "<2-3 sentence summary>",
      "evidence": [
        {
          "quote": "<exact quote from comment or review>",
          "url": "<Product Hunt URL>",
          "productName": "<product name>",
          "upvotes": <number>
        }
      ]
    }
  ],
  "rawProducts": [
    {
      "name": "<product name>",
      "url": "<Product Hunt URL>",
      "upvotes": <number>,
      "commentCount": <number>,
      "painSignals": <number of pain-relevant comments>
    }
  ]
}
```

## Rules

- Do NOT spawn sub-agents. Do all work directly.
- Stay within the producthunt rate budget from orchestration-config.
- Product Hunt comments are often polite/promotional — filter aggressively for genuine pain signals.
- Deduplicate by product slug before writing output.
- Every evidence entry MUST have a valid URL.
- If the CLI returns an error (e.g., no API token, rate limit), log the error and write output with what was collected.
- **Query logging**: Persist all executed query strings in the output file under a `queriesExecuted` array. Include the actual search string, not just a count. This is required for scan audit compliance.
- Do NOT proceed to any next stage. Write your output file and stop.
