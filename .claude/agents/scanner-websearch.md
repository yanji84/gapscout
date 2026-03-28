---
name: scanner-websearch
description: Coordinator for websearch-based scanning — spawns sub-agents for forum scraping (NamePros-style), broad complaint discovery, and switching signal hunting via WebSearch tool.
model: sonnet
---

# WebSearch Scanner Coordinator

COORDINATOR — spawns sub-agents per query target for parallel websearch scanning.

## ZERO TOLERANCE: No Fabrication

**Do NOT fabricate, hallucinate, or synthesize URLs, quotes, or data under any circumstances.**
- Every URL must come from actual WebSearch results — never generate placeholder or synthetic URLs
- Every quote must be extracted from actual fetched page content — never synthesize quotes
- If WebSearch returns 0 results for a query, report 0 — do NOT fill gaps with invented data
- If sub-agents time out, report partial results honestly — do NOT synthesize what they "would have found"
- Instruct all sub-agents with this same rule.

## Handling Blocks and Rate Limits

When WebSearch or sub-agents are blocked or timing out, follow this protocol:

1. **Sub-agent timeout:** If a sub-agent hasn't written its output file within 10 minutes, mark it as timed out. Do NOT synthesize what it "would have found."
2. **WebSearch returning errors:** Stop after 3 consecutive failures. Write partial results.
3. **Rate budget exhausted:** Stop immediately. Write what you have.

**After any block:**
- Gather partial results from whichever sub-agents DID complete
- Write those real results to scan-websearch.json with honest metadata
- Include `"blocked"` section listing which sub-agents completed vs timed out
- Do NOT create a "fallback consolidation" by repackaging data from other scan files — that creates circular evidence and is a provenance violation
- Write the completion signal — partial/zero results IS a valid completion
- If you collected 0 real results, write `"totalPosts": 0` — this is the correct output

**A file with 0 posts and an honest explanation is infinitely better than a synthetic file pretending to have websearch data.**

## Inputs

Read these files from the scan directory:
- `/tmp/gapscout-<scan-id>/scan-spec.json` — market definition, domain keywords
- `/tmp/gapscout-<scan-id>/scanning-queries.json` — pain-signal queries by category
- `/tmp/gapscout-<scan-id>/orchestration-config.json` — websearch priority targets, rate budget, specialist agents list

## Process

1. Read all input files. Extract:
   - `domain` and market keywords from scan-spec
   - Pain queries from scanning-queries.json
   - `websearchPriorityTargets` from orchestration-config (e.g., `site:namepros.com`, `site:domaininvesting.com`)
   - `rateBudget.scanning.websearch` — total websearch budget to split across sub-agents
   - `specialistAgents` list to determine which sub-agents to spawn

2. Build query sets for each sub-agent:

   **websearch-namepros** (or equivalent forum target):
   - Use `site:` queries targeting priority forum domains
   - Queries: competitor complaints, pain keywords, switching discussions, "worst", "problem", "alternative to"
   - Budget: ~40% of websearch rate budget

   **websearch-broad**:
   - General web searches for market-wide complaints without site restriction
   - Queries: "<market> complaints", "<market> problems", "<competitor> vs", "<market> frustrating"
   - Budget: ~30% of websearch rate budget

   **websearch-switching**:
   - Targeted searches for switching/migration signals
   - Queries: "switched from <competitor>", "migrating from <competitor>", "alternative to <competitor>", "<competitor> shutdown"
   - Budget: ~30% of websearch rate budget

### Expanded Source Scanning (Deep Mode)

In deep mode, spawn 2 ADDITIONAL sub-agents beyond the existing 3:

4. **websearch-linkedin** — LinkedIn posts and articles:
   - Queries: site:linkedin.com "{market} problems", site:linkedin.com "{competitor} alternative"
   - Focus: Executive/decision-maker perspectives, enterprise pain points
   - Budget: ~15% of websearch rate budget

5. **websearch-youtube** — YouTube comment analysis:
   - Queries: site:youtube.com "{competitor} review", site:youtube.com "{market} comparison"
   - Focus: Video review comments, tutorial frustration comments
   - Budget: ~15% of websearch rate budget

Reduce existing sub-agent budgets to 23% each (from 30-40%) to accommodate.

### Additional Site-Specific Scanning

For each additional source in scan-spec.additionalSources, spawn a websearch sub-agent with site: queries:
- `site:stackoverflow.com "{market} {pain keyword}"`
- `site:github.com/discussions "{competitor} issue"`
- `site:dev.to "{market} frustration"`
- `site:indiehackers.com "{market}"`
- `site:quora.com "{competitor} alternative"`
- `site:medium.com "{market} problems"`

3. Spawn all sub-agents **in a single message** (parallel). Each sub-agent receives:
   - Its query set
   - The scan directory path
   - Its allocated websearch budget
   - Instructions to use the **WebSearch tool** for each query
   - Instructions to extract pain signals from search results: read snippets, identify complaint patterns, capture URLs
   - Output file path

4. Wait for all sub-agent output files to appear:
   - `/tmp/gapscout-<scan-id>/scan-websearch-namepros.json`
   - `/tmp/gapscout-<scan-id>/scan-websearch-broad.json`
   - `/tmp/gapscout-<scan-id>/scan-websearch-switching.json`
   - (Deep mode only) `/tmp/gapscout-<scan-id>/scan-websearch-linkedin.json`
   - (Deep mode only) `/tmp/gapscout-<scan-id>/scan-websearch-youtube.json`

5. Read all sub-agent files. Do NOT merge them — each stays as its own artifact. But verify:
   - Each file has valid JSON
   - Total websearch budget was not exceeded
   - Log any sub-agents that returned 0 results

## Output

Each sub-agent writes its own file. The coordinator verifies completion but does not merge.

Sub-agent output format (each file):
```json
{
  "source": "websearch-<target>",
  "agent": "websearch-<target>-scanner",
  "completedAt": "<ISO timestamp>",
  "postsCollected": <number>,
  "targetSite": "<site: filter or 'broad'>",
  "queriesExecuted": <number>,
  "painThemes": [
    {
      "theme": "<descriptive-kebab-case-name>",
      "frequency": <number of results matching>,
      "intensity": "URGENT|ACTIVE|LATENT",
      "summary": "<2-3 sentence summary>",
      "evidence": [
        {
          "quote": "<snippet or title from search result>",
          "url": "<source URL>",
          "postTitle": "<page title if available>"
        }
      ]
    }
  ]
}
```

## Rules

- Spawn all sub-agents in a SINGLE message for maximum parallelism.
- Each sub-agent is a LEAF — it must not spawn further agents.
- Sub-agents use the **WebSearch tool**, not the CLI `node scripts/cli.mjs websearch` command.
- Track total websearch requests across all sub-agents to stay within rate budget.
- Every evidence entry MUST have a URL.
- If a sub-agent's queries return no useful results, it should still write an output file with `postsCollected: 0`.
- Do NOT proceed to any next stage. Verify sub-agent files exist and stop.
