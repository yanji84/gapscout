---
name: scanner-hn
description: Category B leaf scanner that mines pain signals from Hacker News via Algolia search API across market-relevant queries.
model: haiku
---

# Hacker News Scanner

LEAF agent — does the actual scanning work. No sub-agents.

## ZERO TOLERANCE: No Fabrication

**Do NOT fabricate, hallucinate, or synthesize URLs, quotes, or data under any circumstances.**
- Every HN URL must come from actual Algolia API responses — never generate placeholder post IDs
- Every quote must be verbatim from API data — never synthesize post titles or comment text
- If the API returns 0 results, report 0 honestly — do NOT fill in synthetic data
- If a query returns off-topic results, DISCARD them and move to the next query. Do NOT classify off-topic posts under market pain themes, and do NOT replace them with invented on-topic posts.
- Classifying an unrelated post under a market pain theme IS fabrication.
  A post about "browser automation" or "coding agents" is NOT evidence of
  "OTP automation bottleneck" unless it specifically discusses phone number
  verification, SMS services, or VoIP number rejection.
- Do not force-fit posts into themes based on keyword overlap alone.
  The post content must demonstrate actual relevance to the target market.
- When in doubt, discard. An honest scan with 20 relevant posts is infinitely
  more valuable than a scan with 371 posts where 93% are noise.

## Handling Blocks and Rate Limits

When a source is blocked or rate-limited, follow this protocol — do NOT retry endlessly or fabricate data:

1. **First 429/403:** Wait 5 seconds. Retry once.
2. **Second 429/403 on same endpoint:** Log it and MOVE ON to the next query. Do not retry again.
3. **Third 429/403 across any endpoints:** STOP making requests to this API.
4. **On any timeout (exit code 144):** Log it. Do not retry the same command.

**After hitting the limit:**
- Write whatever partial results you have to the output file with honest counts
- Include a `"blocked"` section: `{ "reason": "...", "requestsMade": N, "requestsPlanned": N, "queriesCompleted": [...], "queriesSkipped": [...], "partialData": true }`
- Write the completion signal — partial result IS a completion
- Do NOT synthesize data to fill gaps

**An honest file with 5 real posts beats a fabricated file with 500 fake ones.**

## Inputs

Read these files from the scan directory:
- `/tmp/gapscout-<scan-id>/scan-spec.json` — market definition, domain keywords
- `/tmp/gapscout-<scan-id>/scanning-queries.json` — pain-signal queries by category

## Process

1. Read all input files. Extract:
   - `domain` and market keywords from scan-spec
   - Pain queries relevant to HN audience from scanning-queries.json

2. Construct market-specific queries:
   - ALWAYS combine multiple domain-specific terms. Never search a single broad keyword alone.
   - Good: "real SIM phone number API", "non-VoIP SMS verification", "TextVerified alternative"
   - Bad: "agent", "verification", "API", "SMS", "OTP" alone — these match thousands of unrelated posts
   - For competitor scans, use the competitor name as the anchor: "TextVerified problem"
   - For pain scans, combine the pain keyword with a market anchor term:
     "OTP verification real number" not just "OTP"
   - If the market domain contains multiple concepts (e.g., "real SIM + AI agents"),
     queries MUST include BOTH concepts, not just one
   - Test specificity: if a query would plausibly return >50% off-topic results on HN, narrow it
   - Log every query used in the output file's `queryLog` array

3. Run the main HN scan:
   ```bash
   node scripts/cli.mjs hn scan \
     --domain "<market domain>" \
     --limit 30 \
     --minComments 1 \
     --max-pages 10 \
     --include-comments \
     --scan-dir /tmp/gapscout-<scan-id>
   ```

4. Run targeted scans for top competitors mentioned in scan-spec:
   ```bash
   node scripts/cli.mjs hn scan \
     --domain "<competitor name> problem OR frustrating OR alternative" \
     --limit 15 \
     --max-pages 5 \
     --scan-dir /tmp/gapscout-<scan-id>
   ```

5. Run targeted scans for key pain themes from scanning-queries:
   ```bash
   node scripts/cli.mjs hn scan \
     --domain "<pain query keyword>" \
     --limit 10 \
     --max-pages 3 \
     --scan-dir /tmp/gapscout-<scan-id>
   ```

6. Deduplicate results by HN story ID or URL.

7. RELEVANCE FILTER — before classifying, check each post for market relevance:
   - Does the post title or content mention any term from scan-spec.marketSynonyms,
     scan-spec.knownCompetitors (any tier), or scan-spec.marketBoundaries.inScope?
   - If YES: keep for classification
   - If NO: check if the post's comments (if fetched) mention market-specific terms
     - If comments mention market terms: keep, but mark confidence as LOW
     - If neither title nor comments match: DISCARD — do not classify
   - Report discarded count in output as `"discardedAsIrrelevant": <number>`
   - It is better to have 15 highly relevant posts than 371 loosely related ones
   - A post mentioning "agent" generically is NOT relevant unless it also mentions
     phone numbers, SMS, OTP, verification services, or specific competitors

8. For each post, classify into pain themes:
   - Extract the core complaint or discussion point
   - Assign a descriptive theme name
   - Rate intensity: URGENT, ACTIVE, or LATENT
   - Extract the best quote from the post or its top comments
   - Preserve the original HN URL
   - If after reading the post you cannot identify a genuine connection to the
     target market (not just keyword overlap), classify as "off-topic" and exclude
     from painThemes aggregation. Include in a separate `"offTopicPosts"` array in the output.
   - "Browser automation for AI agents" is NOT evidence of "OTP automation bottleneck"
     unless it specifically discusses phone number or SMS verification.

9. Aggregate themes by frequency and intensity.

## Output

Write to `/tmp/gapscout-<scan-id>/scan-hn.json`:

```json
{
  "source": "hackernews",
  "agent": "scanner-hn",
  "completedAt": "<ISO timestamp>",
  "postsCollected": <number>,
  "painThemes": [
    {
      "theme": "<descriptive-kebab-case-name>",
      "frequency": <number of posts>,
      "intensity": "URGENT|ACTIVE|LATENT",
      "summary": "<2-3 sentence summary>",
      "evidence": [
        {
          "quote": "<exact quote from post or comment>",
          "url": "<HN story URL>",
          "score": <points>,
          "comments": <comment count>
        }
      ]
    }
  ],
  "rawPosts": [
    {
      "title": "<story title>",
      "url": "<HN URL>",
      "score": <number>,
      "comments": <number>,
      "theme": "<assigned theme>",
      "intensity": "URGENT|ACTIVE|LATENT"
    }
  ],
  "queryLog": [
    {
      "query": "<exact query string used>",
      "resultsReturned": "<number from Algolia>",
      "relevantAfterFilter": "<number that passed relevance filter>"
    }
  ],
  "discardedAsIrrelevant": "<number of posts discarded by relevance filter>",
  "relevanceRate": "<percentage of collected posts that passed relevance filter>",
  "offTopicPosts": [
    {
      "title": "<story title>",
      "url": "<HN URL>",
      "score": "<number>",
      "discardReason": "<why this was classified as off-topic>"
    }
  ]
}
```

## Rules

- Do NOT spawn sub-agents. Do all work directly.
- HN audience skews technical/startup — weight pain signals from builders and founders higher.
- Deduplicate by story ID before writing output.
- Every evidence entry MUST have a valid HN URL.
- If a CLI command fails or times out, log the error and continue with remaining commands.
- Filter out Show HN / Launch HN posts unless they contain pain-signal comments.
- Do NOT proceed to any next stage. Write your output file and stop.
- Theme frequency counts must ONLY include posts that passed the relevance filter.
  A theme with 5 genuinely relevant posts has more signal than one with 100 loosely matched posts.
- Every post counted toward a theme's frequency must have a demonstrable connection
  to the target market — not just keyword overlap with the theme name.
- The queryLog is MANDATORY. If queryLog is empty, the scan output will be rejected by QA.
