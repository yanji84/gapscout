# GapScout Issues Tracker

Comprehensive list of bugs, problems, and improvement opportunities discovered during GapScout development and testing.

---

## Bugs (Code)

### 1. citeKey naming mismatch between enrichment and report generation
- **Severity:** HIGH
- **Status:** OPEN
- **Files:** `scripts/lib/scoring.mjs`, `scripts/report.mjs`
- **Description:** `enrichPost()` in `scoring.mjs` assigns `citeKey` (no underscore) at line ~723. But `report.mjs` at line ~214 checks `p._citeKey` (with underscore) and generates its own random key via `Math.random()`, discarding the stable hash-based key from enrichment. The enrichment-stage `citeKey` is never used in report generation.

### 2. Evidence drawer never renders
- **Severity:** HIGH
- **Status:** OPEN
- **Files:** `scripts/lib/web-report/html-generator.mjs`, `scripts/web-report.mjs`
- **Description:** `html-generator.mjs` `buildCategoryCards(groups, data)` expects a `data` parameter to check `data.evidenceCorpus`, but `web-report.mjs` calls `buildCategoryCards(groups)` without passing `data`. So `hasCorpus` is always false and evidence drawers never render.

### 3. stderr mixed into stdout in CLI scan output
- **Severity:** HIGH
- **Status:** OPEN
- **Affects:** All CLI scan commands when run by agents
- **Description:** When agents run CLI commands like `node scripts/cli.mjs api scan ...`, the source modules write log output to stderr AND the JSON result to stdout. When piped to a file from within an agent subprocess, stderr contaminates stdout, making JSON output unparseable. The `2>/dev/null` redirect does not always work from within Claude Code agent subprocesses.

### 4. Google Autocomplete scans wrong domain
- **Severity:** HIGH
- **Status:** OPEN
- **Files:** `scripts/sources/google-autocomplete.mjs`
- **Description:** The Google scanner used a domain from a previous/default scan ("ticketmaster") instead of the actual market being scanned. 651 posts were collected for the wrong market entirely.

### 5. Missing URL does not fail citation verification
- **Severity:** MEDIUM
- **Status:** OPEN
- **Files:** `scripts/verify-citations.mjs`
- **Description:** In `verify-citations.mjs` line ~156, `verified` is only false for phantom citations or count mismatches. Missing URLs are tracked but do not cause failure. Evidence without URLs cannot be clicked.

### 33. CLI scan commands write logs to stdout
- **Severity:** CRITICAL
- **Status:** OPEN
- **Files:** `scripts/sources/reddit-api.mjs`, `scripts/sources/hackernews.mjs`, `scripts/sources/stackoverflow.mjs`, `scripts/sources/github-issues.mjs`, `scripts/sources/producthunt.mjs`
- **Description:** All source modules write `[scan]`, `[hn]`, `[ph]` log prefixes to stdout mixed with JSON output. When agents pipe stdout to a file, the JSON is corrupted. The `2>/dev/null` redirect doesn't reliably work from within Claude Code agent subprocesses. Fix: sources should write ALL logs to stderr only, never stdout.

### 34. Google Autocomplete uses stale/wrong domain
- **Severity:** HIGH
- **Status:** OPEN
- **Files:** `scripts/sources/google-autocomplete.mjs`
- **Description:** During the scan, Google Autocomplete produced 651 posts about "ticketmaster" instead of "market gap analysis tools". The domain parameter may not be passed correctly or the source cached a previous domain.

---

## Bugs (Rate Limiting)

### 6. No cross-agent rate limit coordination
- **Severity:** CRITICAL
- **Status:** OPEN
- **Files:** Architecture-level issue, affects `.claude/commands/gapscout.md` orchestrator
- **Description:** Multiple agents can hit the same API simultaneously. Reddit competitor scanner + market scanner both hit PullPush, effectively doubling the request rate. Discovery agents consumed rate budget before scanning agents started.

### 7. PullPush rate limiter too aggressive for sustained use
- **Severity:** HIGH
- **Status:** OPEN
- **Files:** `scripts/sources/reddit-api.mjs`
- **Description:** `reddit-api.mjs` creates a RateLimiter allowing 30 req/min which matches PullPush's per-minute cap, but the 1000/hour long-term limit means effective safe rate is ~16/min sustained. Long scans exhaust hourly budget and get 429'd.

### 8. Google Autocomplete unbounded recursive expansion
- **Severity:** HIGH
- **Status:** OPEN
- **Files:** `scripts/sources/google-autocomplete.mjs`
- **Description:** At depth=2, generates thousands of requests per seed (26 letters x depth x seeds). No request cap in API mode. Single biggest ban risk.

### 9. No jitter on backoff in source retry loops
- **Severity:** MEDIUM
- **Status:** OPEN
- **Files:** `scripts/sources/reddit-api.mjs`, `scripts/sources/producthunt.mjs`
- **Description:** `reddit-api.mjs` and `producthunt.mjs` use exponential backoff without jitter. Parallel agents that hit 429 simultaneously all retry at the same time (thundering herd problem).

### 10. GitHub Search API secondary limit not accounted for
- **Severity:** MEDIUM
- **Status:** OPEN
- **Files:** `scripts/sources/github-issues.mjs`
- **Description:** Current MIN_DELAY_MS of 500ms (authenticated) allows ~120 req/min, but GitHub Search API hard limit is 30 req/min. Needs per-minute cap of 30.

### 11. Product Hunt ignores rate limit response headers
- **Severity:** MEDIUM
- **Status:** OPEN
- **Files:** `scripts/sources/producthunt.mjs`
- **Description:** `graphqlRequest` function ignores `X-Rate-Limit-Remaining` and `X-Rate-Limit-Reset` headers. Relies only on client-side RateLimiter.

### 12. Hacker News has no usage tracking
- **Severity:** LOW
- **Status:** OPEN
- **Files:** `scripts/sources/hackernews.mjs`
- **Description:** `hackernews.mjs` never calls `getUsageTracker().increment('hackernews')`. Daily usage is not tracked.

### 35. Discovery phase exhausts rate budget before scanning
- **Severity:** CRITICAL
- **Status:** OPEN
- **Description:** The discovery agents (market-mapper, subreddit-discoverer) consumed PullPush and Product Hunt API rate limits. When scanning agents started, both APIs returned 429. No budget reservation between phases.

### 36. Reddit PullPush 429 has no recovery in same session
- **Severity:** HIGH
- **Status:** OPEN
- **Files:** `scripts/sources/reddit-api.mjs`
- **Description:** Once PullPush returns 429, the hourly budget is exhausted. Retry with delays in the same session doesn't help — need to wait ~60 minutes. Current retry logic keeps hitting the wall.

---

## Bugs (Infrastructure)

### 13. RateMonitor singleton exists but no API source uses it
- **Severity:** MEDIUM
- **Status:** OPEN
- **Files:** `scripts/lib/rate-monitor.mjs`, all source files
- **Description:** `rate-monitor.mjs` is defined but none of the 5 API sources import or call it. The monitor's summary is always empty.

### 14. SafeScraper defined but underused
- **Severity:** MEDIUM
- **Status:** OPEN
- **Files:** `scripts/lib/safe-scraper.mjs`, browser source files
- **Description:** Most browser sources do not use `SafeScraper` for consistent request capping, delays, and block tracking.

### 15. Logger class exists but never instantiated
- **Severity:** LOW
- **Status:** OPEN
- **Files:** `scripts/lib/logger.mjs`
- **Description:** `logger.mjs` has a proper Logger class with levels, progress tracking, and JSON export, but all source modules use raw `log()` from `utils.mjs` instead.

### 16. RetryableError class exists but never used
- **Severity:** LOW
- **Status:** OPEN
- **Files:** `scripts/lib/errors.mjs`, `scripts/lib/http.mjs`
- **Description:** `errors.mjs` defines `RetryableError` with backoff config, but `http.mjs` retry logic is manual and does not use it.

### 17. Chrome stderr discarded
- **Severity:** LOW
- **Status:** OPEN
- **Files:** `.claude/commands/gapscout.md` Step 0
- **Description:** Step 0 launches Chrome with `2>/dev/null`. Chrome crash logs are lost, making debugging impossible.

### 18. Inconsistent User-Agent strings
- **Severity:** LOW
- **Status:** OPEN
- **Files:** `scripts/lib/http.mjs`, various source files
- **Description:** Reddit uses `node:gapscout:5.0`, Stack Overflow uses `gapscout/1.0`, GitHub uses `gapscout/1.0`, Product Hunt uses `gapscout/4.0`. Should be unified.

---

## Scan Results

### 37. Twitter/X completely non-functional
- **Severity:** HIGH
- **Status:** OPEN
- **Description:** All Nitter instances are down (project discontinued Feb 2024). x.com requires authentication for search. 0 tweets recoverable. Source should be marked as deprecated or require API key.

### 38. Stack Overflow returns 0 relevant results
- **Severity:** LOW
- **Status:** OPEN
- **Description:** 17 queries run, 7 raw questions found, 0 after pain filter. Market gap analysis is not a Stack Overflow topic. Source may be irrelevant for non-technical markets.

### 39. GitHub Issues returns 0 relevant results
- **Severity:** LOW
- **Status:** OPEN
- **Description:** Same issue. Competitive intelligence tools don't have public GitHub repos with complaint issues. Source irrelevant for this market.

### 40. G2/Capterra browser scraping returns 0 results
- **Severity:** HIGH
- **Status:** OPEN
- **Description:** Cloudflare blocking prevented any review data from being collected. The most valuable data source (competitor reviews) is the hardest to access.

---

## Missing Features

### 19. No test infrastructure
- **Severity:** HIGH
- **Status:** OPEN
- **Description:** `package.json` has `"test": "echo \"No tests yet\""`. No test files, no test runner, no fixtures directory.

### 20. No per-scan directory
- **Severity:** MEDIUM
- **Status:** OPEN
- **Description:** All scan data goes to flat `/tmp/gapscout-*.json` files. Old scan data can mix with new scan data. No scan ID isolation.

### 21. No checkpoint/resume
- **Severity:** MEDIUM
- **Status:** OPEN
- **Description:** If a scan fails at Step 5, there is no way to resume from Step 5 with existing data. The entire pipeline must be re-run.

### 22. No progress file
- **Severity:** MEDIUM
- **Status:** OPEN
- **Description:** No `/tmp/gapscout-progress.json` for tracking agent status. User has no visibility during 20-90 min scans.

### 23. No metrics tracking
- **Severity:** LOW
- **Status:** OPEN
- **Description:** No `gapscout-metrics.json` with per-source timing, post counts, rate events, or pipeline funnel data.

### 24. No historical tracking
- **Severity:** LOW
- **Status:** OPEN
- **Description:** No `~/.gapscout-history.json` to detect source degradation across scans.

### 25. No debug-bundle command
- **Severity:** LOW
- **Status:** OPEN
- **Description:** No way to collect all logs/data/system info for diagnosing failed scans.

---

## Legal/Ethical Risks

### 26. G2/Capterra ToS explicitly prohibit scraping
- **Severity:** HIGH
- **Status:** OPEN
- **Description:** Highest legal risk source. No official API available. Scraping violates Terms of Service.

### 27. Twitter/X ToS prohibit scraping and require login
- **Severity:** HIGH
- **Status:** OPEN
- **Description:** Nitter is effectively dead (discontinued Feb 2024). x.com requires authentication for search. Scraping violates ToS.

### 28. Google ToS prohibit automated queries
- **Severity:** MEDIUM
- **Status:** OPEN
- **Description:** Both autocomplete API and SERP scraping violate Google's Terms of Service.

---

## Recommendations (Not Yet Implemented)

### 29. Local rate limit server
- **Severity:** HIGH
- **Status:** OPEN
- **Description:** Proposed `rate-limit-server.mjs` for cross-agent coordination. In-memory token buckets per domain. Would resolve issue #6.

### 30. Orchestrator agent staggering
- **Severity:** MEDIUM
- **Status:** OPEN
- **Description:** Launch agents in waves to avoid domain conflicts. Would reduce thundering herd effects from issue #9 and cross-agent conflicts from issue #6.

### 31. Migrate Trustpilot to official API
- **Severity:** MEDIUM
- **Status:** OPEN
- **Description:** `developers.trustpilot.com` has a public API that eliminates scraping risk. Would reduce legal exposure.

### 32. Evaluate Twitter/X API
- **Severity:** LOW
- **Status:** OPEN
- **Description:** Free tier ($0, 500 posts/month) may suffice. Basic tier ($200/month) for 10K tweets. Would resolve issue #27.
