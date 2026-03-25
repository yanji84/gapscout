# GapScout Scalability Blockers Report

> Generated 2026-03-24. Covers all 23 data sources + shared infrastructure.

---

## Executive Summary

GapScout's current architecture caps throughput at **~30 requests/min per source** via a shared `RateLimiter` class, with no global coordination across sources. Browser-dependent sources (G2, Capterra, Kickstarter) are the slowest at ~9-20 posts/min. API-gated sources (YouTube, StackOverflow) hit hard daily quotas. The coordinator runs all sources via unbounded `Promise.all()` with O(N²) deduplication — a scaling wall at 1,000+ posts.

**Top 3 systemic blockers:**
1. No global rate limiter across sources — each source independently burns IP reputation
2. No browser connection pool — each Puppeteer source spawns pages without coordination
3. O(N²) title-similarity deduplication in coordinator

---

## Per-Source Rate Limit Matrix

### Tier 1: API-Gated (Hard Daily Caps)

| Source | External Limit | Self-Imposed Delay | Auth Required | Max Posts/Run | Critical Blocker |
|--------|---------------|-------------------|---------------|---------------|-----------------|
| **YouTube** | 10,000 units/day (100/search, 1/comment) | 500ms | Yes (API key) | ~120 comments | Daily unit budget exhaustion |
| **StackOverflow** | 300/day (unkeyed), 10K/day (keyed) | 1,000ms | Optional (key) | 150-750 | Daily quota wall without key |
| **GitHub Issues** | 60/hr (unauthed), 5K/hr (authed) | 2,100ms | Optional (token) | ~1,000 | Self-imposed delay 4x slower than API allows |
| **GitLab Issues** | 400/10min (unauthed), 2K/10min (authed) | 1,500ms (unauthed) | Optional (token) | ~500 | Unauthenticated mode severely limited |

### Tier 2: Browser-Dependent (Slowest)

| Source | Self-Imposed Delay | Browser Required | Max Posts/Run | Critical Blocker |
|--------|-------------------|-----------------|---------------|-----------------|
| **Reviews (G2/Capterra)** | 5-7s/page | Yes (Chrome) | ~45 reviews | Cloudflare, DOM fragility, 5 products × 3 pages cap |
| **Reddit Browser** | 1.5-2s/page | Yes (Chrome) | 25,000 | Single Chrome instance, 200 pages/worker cap |
| **Crowdfunding (KS)** | 3-4s/search | Optional | ~225 | JS rendering, infinite scroll for comments |
| **Google Autocomplete** | 1.2-2s/query | Optional | ~200 queries | Recursive expansion explosion (26^depth) |
| **WebSearch (Google)** | 2.5-4s/query | Optional | ~200 results | CAPTCHA detection, SearXNG instance fragility |
| **Twitter** | 2.5-3.3s/page | Yes (Nitter/x.com) | 300-1,600 | Nitter instance health, x.com login wall |
| **ProductHunt** | 2.1s (28/min) | Optional | 200-1,600 | 20 posts/page pagination, requires API token |

### Tier 3: API-Based (Moderate)

| Source | External Limit | Self-Imposed Delay | Max Posts/Run | Critical Blocker |
|--------|---------------|-------------------|---------------|-----------------|
| **Reddit API** | ~100/min (OAuth), PullPush unknown | 1,000ms (30/min) | ~1,000 | Per-run 1K request cap, sequential queries |
| **HackerNews** | Undocumented (Algolia) | 1.2s (45/min) | 25,000+ | Query explosion: 50+ queries × 8 date windows |
| **Bluesky** | 3,000/5min | 200ms | 1,500 | No pagination — capped at 100 results/query |
| **Mastodon** | 300/5min per instance | 1,000ms | 1,200-4,800 | Instance health, hashtag mapping quality |
| **Discourse** | ~60/min per instance | 1,000ms | ~2,000 | Sequential instance processing, 50 detail fetches |
| **Dev.to** | 30/30sec | 1,100ms | ~270 | Tag-based only, 30 results/page |
| **Lobsters** | Respectful (crawl-delay: 1) | 1,100ms | ~375 | 25 results/page, 3 pages/tag |

### Tier 4: Unrestricted (Fastest)

| Source | External Limit | Self-Imposed Delay | Max Posts/Run | Critical Blocker |
|--------|---------------|-------------------|---------------|-----------------|
| **CFPB** | None (gov API) | 500ms | ~1,300 | No pagination per query (100 cap) |
| **Trustpilot** | None (HTTP scrape) | 2.5-3.2s/page | 9,000/company | 150 pages/company ceiling, parsing cascade |
| **App Store** | None (npm packages) | 3-4.5s/app | ~250 | Npm package opacity, no rate limit visibility |
| **Package Stats** | None (npm/PyPI) | 200-250ms | ~400 | Sequential fetching, no parallelism |
| **Crowdfunding (IGG)** | None | 1.2s (25/min) | ~360 | Slow rate limiter |

---

## Shared Infrastructure Blockers

### 1. Global Rate Limiter — MISSING

**File:** `scripts/lib/http.mjs`

Each source creates its own `RateLimiter` instance with independent counters:
- `MAX_PER_MIN = 30` (line 15)
- `MIN_DELAY_MS = 1000` (line 14)

**Problem:** 10 sources running in parallel = 300 req/min from same IP. No cross-source coordination. Risk of IP-level blocks from shared infrastructure (proxies, CDNs).

### 2. Browser Connection Pool — MISSING

**File:** `scripts/lib/browser.mjs`

- `connectBrowser()` returns a single Chrome instance (line 187-198)
- No tab pooling, no max concurrent pages, no memory limits
- Each browser-dependent source creates pages independently
- 7 sources need Chrome — running all simultaneously = uncontrolled memory growth

### 3. Coordinator Parallelism — UNBOUNDED

**File:** `scripts/sources/coordinator.mjs`

```javascript
// Line 424-426: All sources launch simultaneously
const scanPromises = sources.map(src => runSourceScan(src));
const results = await Promise.all(scanPromises);
```

- No concurrency limit (p-limit, p-queue, etc.)
- Each source spawns as a child process (line 376)
- 20 sources × 80MB/process = 1.6GB+ resident memory
- 2-minute timeout per child process (line 378)

### 4. O(N²) Deduplication

**File:** `scripts/sources/coordinator.mjs` (lines 197-268)

- Title similarity uses Jaccard distance with n-gram generation
- N-grams regenerated per comparison (not cached)
- 2,000 posts = ~720K comparisons = ~6.5M n-gram operations
- Estimated: 15-30 seconds at 1,000+ posts

### 5. Usage Tracker — Advisory Only

**File:** `scripts/lib/usage-tracker.mjs`

- Tracks daily usage per source but **never blocks** when limits exceeded
- `writeFileSync()` on every `increment()` call — 5,000+ sync writes in a full coordinator scan
- No monthly aggregation, 7-day retention only

### 6. CLI Timeout Mismatch

- Global default: 600,000ms / 10 min (cli.mjs line 34)
- Coordinator per-source: 120,000ms / 2 min (coordinator.mjs line 378)
- Slow sources hit 2-min timeout while fast sources finish in seconds

---

## Bottleneck Heatmap

```
                    Speed Impact
                    Low ◄────────────► High
                    │
  Easy to fix   ──  │  PackageStats     GitHub delay (2.1s→0.5s)
                    │  Lobsters         Bluesky pagination
                    │  CFPB query cap   Dev.to page size
                    │
                    │  GitLab delay     Reddit API per-run cap
  Medium effort ──  │  Discourse seq    Coordinator concurrency
                    │  Mastodon inst    Usage tracker sync I/O
                    │                   Dedup O(N²) → O(N log N)
                    │
                    │  SO key mandate   Browser pool
  Hard to fix   ──  │  YT unit budget   Global rate limiter
                    │  KS JS rendering  G2 Cloudflare bypass
                    │                   Twitter Nitter health
                    │                   x.com login wall
```

---

## Scalability Unblocking Strategies

### Strategy 1: Scraping-as-a-Service

Replace self-managed HTTP/browser scraping with managed services for the hardest sources.

**Best candidates for outsourcing:**
- **G2/Capterra** (Cloudflare, DOM fragility) → ScraperAPI, ZenRows, or Bright Data
- **Twitter/X** (login wall, Nitter decay) → Social media scraping APIs
- **Google Search/Autocomplete** (CAPTCHA) → SerpAPI, ScaleSerp
- **Trustpilot** (anti-bot) → Bright Data or Oxylabs

**Services to evaluate:**
| Service | JS Rendering | Anti-Bot Bypass | Pricing (est.) |
|---------|-------------|-----------------|----------------|
| ScraperAPI | Yes | Cloudflare, CAPTCHA | $49/mo (100K req) |
| ZenRows | Yes | Cloudflare, WAF | $69/mo (250K basic) |
| Bright Data | Yes | Full stack | $500+/mo (enterprise) |
| Apify | Yes (actors) | Per-actor | Pay-per-use |
| SerpAPI | N/A (search) | Google, Bing | $50/mo (5K searches) |

### Strategy 2: Rotating Proxies

Add proxy rotation to existing HTTP client for sources that don't need JS rendering.

**Best for:** Reddit API, HackerNews, Bluesky, Mastodon, CFPB, StackOverflow, Dev.to, Lobsters

**Implementation:** Single change in `http.mjs` to route through proxy:
```javascript
// Add to httpGetWithRetry options
const agent = new HttpsProxyAgent(getNextProxy());
```

**Services to evaluate:**
| Provider | Type | Price/GB | Price/Request | Best For |
|----------|------|----------|---------------|----------|
| Bright Data | Residential | $8-15/GB | — | Anti-bot sites |
| Oxylabs | Residential | $10/GB | — | High volume |
| SmartProxy | Residential | $7/GB | — | Budget option |
| IPRoyal | Residential | $5.5/GB | — | Low volume |
| ScraperAPI | Datacenter | — | $0.0005/req | API sources |

### Strategy 3: Managed Browser Cloud

Replace local Puppeteer with cloud-hosted headless browsers for browser-dependent sources.

**Best for:** Reddit Browser, Reviews, Crowdfunding, WebSearch, Twitter, ProductHunt

**Services to evaluate:**
| Service | Pricing | Concurrent Sessions | Puppeteer Compatible |
|---------|---------|--------------------|--------------------|
| Browserless.io | $200/mo (10 concurrent) | 10-100 | Yes (drop-in) |
| Browser Cloud | Usage-based | Unlimited | Yes |
| Apify (browser) | $49/mo+ | Per-actor | Playwright |

**Implementation:** Change `browser.mjs` connection:
```javascript
// From: puppeteer.connect({ browserWSEndpoint: local })
// To:   puppeteer.connect({ browserWSEndpoint: 'wss://cloud-service/...' })
```

### Strategy 4: Architecture Changes (No External Cost)

**Quick wins (< 1 day each):**

1. **Add coordinator concurrency limit** — Use `p-limit` or manual semaphore to cap at 5 concurrent sources
2. **Cache dedup n-grams** — Compute once per post, reuse across comparisons → O(N²) but 10x faster
3. **Make usage tracker async** — Replace `writeFileSync` with batched `writeFile`
4. **Reduce GitHub self-imposed delay** — 2,100ms → 500ms (API allows 5K/hr authenticated)
5. **Add Bluesky pagination** — Use cursor for >100 results per query
6. **Parallelize package-stats** — Use `Promise.all` with 5-way concurrency

**Medium effort (1-3 days):**

7. **Global rate limiter** — Shared token bucket across all sources, IP-aware
8. **Browser tab pool** — Max 10 concurrent tabs across all sources, FIFO queue
9. **Align coordinator timeouts** — Dynamic per-source based on expected query count
10. **Switch dedup to MinHash/LSH** — O(N) approximate similarity, 100x faster at scale

**Larger efforts (1 week+):**

11. **Proxy rotation layer** — Integrate residential proxy pool into `http.mjs`
12. **Scraping service abstraction** — Pluggable backend (direct HTTP vs ScraperAPI vs Bright Data)
13. **Result streaming** — Stream posts to disk instead of accumulating in memory
14. **Distributed scanning** — Queue-based architecture for horizontal scaling

---

## Source-Specific Recommendations

| Source | Current Limit | Recommended Fix | Expected Improvement |
|--------|--------------|-----------------|---------------------|
| **YouTube** | 10K units/day | Higher-tier API key ($200/mo) or YouTube scraping service | 10-100x |
| **StackOverflow** | 300/day unkeyed | Mandate API key (free, 10K/day) | 33x |
| **GitHub Issues** | 28 req/min (self-imposed) | Reduce delay to 500ms with auth | 4x |
| **G2/Capterra** | 9 reviews/min | ScraperAPI or ZenRows for Cloudflare bypass | 10-20x |
| **Twitter** | Nitter-dependent | Dedicated Twitter scraping API or social data provider | Reliable vs fragile |
| **Reddit API** | 1K req/run cap | Raise to 5K-10K, parallelize queries | 5-10x |
| **Reddit Browser** | 200 pages/worker | Raise to 500, add browser cloud pool | 2.5x |
| **Bluesky** | 100 results/query | Add cursor pagination | 10-50x |
| **HackerNews** | 45 req/min | Already fast — reduce query explosion (50→20 queries) | 2x efficiency |
| **WebSearch** | 2.5s/query (browser) | SerpAPI or ScaleSerp | 5-10x + no CAPTCHA |
| **Coordinator** | Unbounded parallel | p-limit(5) concurrency | Stable memory |
| **Dedup** | O(N²) | MinHash/LSH | 100x at 5K+ posts |

---

## Priority Roadmap

### Phase 1: Free Quick Wins (Week 1)
- [ ] Add `p-limit(5)` to coordinator
- [ ] Cache dedup n-grams
- [ ] Async usage tracker writes
- [ ] Reduce GitHub/GitLab self-imposed delays
- [ ] Add Bluesky cursor pagination
- [ ] Mandate StackOverflow API key

### Phase 2: Proxy + Pool (Week 2-3)
- [ ] Integrate rotating proxy into `http.mjs`
- [ ] Build browser tab pool in `browser.mjs`
- [ ] Add global cross-source rate limiter
- [ ] Align coordinator timeouts per source

### Phase 3: Outsource Hardest Sources (Week 3-4)
- [ ] ScraperAPI/ZenRows for G2, Capterra, Trustpilot
- [ ] SerpAPI for Google Search/Autocomplete
- [ ] Social data API for Twitter/X
- [ ] Browser cloud for remaining Puppeteer sources

### Phase 4: Architecture (Month 2)
- [ ] MinHash/LSH deduplication
- [ ] Result streaming to disk
- [ ] Queue-based distributed scanning

---

## Appendix A: Service Pricing Research (March 2026)

### Scraping-as-a-Service Comparison

| Service | Base Plan | Credits/Requests | JS Rendering | Anti-Bot (Cloudflare) | Best For |
|---------|-----------|-----------------|-------------|----------------------|----------|
| **ScrapingBee** | $49/mo | 250K credits | 5x cost | 75x cost (stealth) | Simple pages |
| **ScraperAPI** | $49/mo | 100K credits | Included | Included | Easy integration |
| **ZenRows** | $69/mo | 250K basic | 5x cost | 10-25x cost | Middle ground |
| **Bright Data** | Pay-per-success | $1.50-2.50/1K | Included (flat) | Included (flat) | Hard targets (G2, Trustpilot) |
| **Apify** | $29/mo (Starter) | Per compute unit | Per-actor | Per-actor | Multi-source (pre-built actors) |
| **Scrape.do** | Competitive | Similar to ZenRows | Yes | Yes | Budget option |

**Winner for GapScout: Apify** — has pre-built scrapers for Reddit, Twitter, Trustpilot, G2, Capterra, App Store, Product Hunt, HN. Supplement with Bright Data ($1.50/1K) for the hardest targets.

### Rotating Proxy Comparison

| Provider | Residential $/GB | Pool Size | Min Purchase | Best For |
|----------|-----------------|-----------|-------------|----------|
| **Bright Data** | $3.30-8.40 | 150M+ IPs | ~$500/mo | Enterprise, highest success |
| **Oxylabs** | $8.00 | 100M+ IPs | $75 min | High volume |
| **Decodo (SmartProxy)** | $1.50-2.20 | 65M IPs | No minimum | Budget residential |
| **IPRoyal** | $2.57-3.68 | 32M+ IPs | 1 GB, PAYG, never expires | Low volume, no commitment |

**Winner for GapScout: IPRoyal or Decodo** for PAYG residential proxies. Move to Bright Data only if success rates demand it (G2 has only 36.6% scraping success rate industry-wide).

### Cloud Browser Comparison

| Service | Free Tier | Paid Starting | Cost/Hour | CAPTCHA Solving | Puppeteer Compatible |
|---------|-----------|--------------|-----------|-----------------|---------------------|
| **Browserless.io** | 1K units | $50/mo (Starter) | — | Free Cloudflare | Yes (drop-in) |
| **Browserbase** | Yes | $20/mo (Dev) | $0.10/hr overage | Auto CAPTCHA | Yes |
| **Steel.dev** | $10/mo credits | $29/mo (290 hrs) | $0.10/hr | — | Yes, open-source |

**Winner for GapScout: Browserbase ($20/mo)** or Steel.dev ($29/mo, self-hostable). Drop-in replacement for local Puppeteer.

### Twitter/X Data Access

| Option | Cost | Limits | Notes |
|--------|------|--------|-------|
| **X Free API** | $0 | Write-only, 1 req/24h reads | Useless for scanning |
| **X Basic** | $200/mo | 10K tweets/mo, 7-day search | Expensive for intermittent use |
| **X Pay-Per-Use** (new Feb 2026) | ~$0.01/tweet | Default for new devs | Best for GapScout's pattern |
| **TwitterAPI.io** | $0.05-0.10/1K | No OAuth needed | Drop-in replacement |
| **Apify Twitter actors** | ~$0.50/1K | Per compute unit | Pre-built |
| **Nitter** | Free | **Dead since Feb 2024** | Not viable |

**Winner for GapScout: X Pay-Per-Use ($0.01/tweet)** for light scanning, or TwitterAPI.io for heavier use.

### Reddit Data Access

| Option | Cost | Limits | Notes |
|--------|------|--------|-------|
| **Reddit Free API** | $0 | 100 RPM (OAuth), 10K/mo | Sufficient for scan-level use |
| **Reddit Commercial** | $12K-60K/yr | 100-500 RPM | Overkill for GapScout |
| **PullPush** | Free | Data through May 2025 only | Single maintainer, outage risk |
| **Arctic Shift** | Free | Better rate limits than PullPush | Best for historical data |
| **Apify Reddit actors** | Per compute | Browser-based | Bypasses API limits |

**Winner: Keep current dual approach** (reddit-api + reddit-browser). Add Arctic Shift as PullPush backup.

### Estimated Monthly Cost (Moderate Usage)

| Component | Cost |
|-----------|------|
| Free-tier APIs (Reddit, GitHub, HN, SO, Bluesky, etc.) | $0 |
| Apify Starter (Trustpilot, G2, Capterra, PH actors) | $29 |
| X Pay-Per-Use (~5K tweets/scan) | ~$50 |
| Browserbase Dev (JS rendering fallback) | $20 |
| **Total (moderate)** | **~$99/mo** |
| + IPRoyal residential proxies (scale) | +$10-30 |
| + Bright Data for hard targets (scale) | +$50-100 |
| **Total (heavy)** | **~$200-250/mo** |

---

## Appendix B: Open-Source Alternatives (Zero/Low Cost)

### Tier 1: Drop-In Wins (npm install, minimal code changes)

| Tool | GitHub | Stars | Replaces | Effort | Impact |
|------|--------|-------|----------|--------|--------|
| **rebrowser-puppeteer-core** | [rebrowser/rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) | 1,289 | Bot detection across ALL browser sources | **Trivial** (1 import swap) | Fixes #1 CDP detection vector (Runtime.Enable leak) |
| **p-queue** | [sindresorhus/p-queue](https://github.com/sindresorhus/p-queue) | 4,150 | Unbounded `Promise.all()` in coordinator | **~10 lines** | Caps concurrency + adds priority scheduling |
| **bottleneck** | [SGrondin/bottleneck](https://github.com/SGrondin/bottleneck) | 1,980 | Per-source RateLimiter in http.mjs | **Drop-in** | Global cross-source rate limiting (6M npm dl/wk) |
| **minhash** | [duhaime/minhash](https://github.com/duhaime/minhash) | 53 | O(N²) Jaccard dedup in coordinator | **Moderate** | 100x faster dedup at 5K+ posts via LSH index |
| **proxy-chain** | [apify/proxy-chain](https://github.com/apify/proxy-chain) | 984 | No proxy rotation in http.mjs | **Small** | Node.js proxy server with upstream chaining |

### Tier 2: Docker Sidecars (self-hosted services)

| Tool | GitHub | Stars | Replaces | Deploy | Saves |
|------|--------|-------|----------|--------|-------|
| **Browserless** (self-hosted) | [browserless/browserless](https://github.com/browserless/browserless) | 12,818 | Browserless.io/Browserbase ($50-200/mo) | `docker run` | $600-2,400/yr |
| **FlareSolverr** | [FlareSolverr/FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) | 13,200 | Bright Data for Cloudflare bypass | `docker run` | $500+/yr |
| **SearXNG** (self-hosted) | [searxng/searxng](https://github.com/searxng/searxng) | 27,158 | SerpAPI ($50/mo) + flaky public instances | `docker-compose up` | $600/yr |
| **flare-bypasser** | [yoori/flare-bypasser](https://github.com/yoori/flare-bypasser) | 341 | FlareSolverr backup for newer Cloudflare | `docker run` | Resilience |

### Tier 3: Source-Specific Replacements

| Tool | GitHub | Stars | Replaces | Language | Impact |
|------|--------|-------|----------|----------|--------|
| **the-convocation/twitter-scraper** | [the-convocation/twitter-scraper](https://github.com/the-convocation/twitter-scraper) | ~590 | Dead Nitter instances in twitter.mjs | **Node.js** | Reliable Twitter search without API fees |
| **youtube-comment-downloader** | [egbertbouman/youtube-comment-downloader](https://github.com/egbertbouman/youtube-comment-downloader) | 1,200 | YouTube API 10K unit/day quota | Python (port to Node) | Removes YouTube's hardest rate limit |
| **Arctic Shift** | [ArthurHeitmann/arctic_shift](https://github.com/ArthurHeitmann/arctic_shift) | 733 | PullPush single-point-of-failure | API call | Reddit data resilience |
| **FixTweet API** | [FixTweet/FxTwitter](https://github.com/FixTweet/FxTwitter) | High | Tweet enrichment (by ID) | API call | Free tweet data, no auth |

### Tier 4: Larger Framework Options

| Tool | GitHub | Stars | What It Does | Effort | When to Use |
|------|--------|-------|-------------|--------|-------------|
| **Crawlee** | [apify/crawlee](https://github.com/apify/crawlee) | 22,500 | Full scraping framework (replaces http.mjs + browser.mjs + retry logic) | **Major rewrite** | If rebuilding scraping layer from scratch |
| **Firecrawl** | [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl) | 97,700 | Self-hosted scraping API server (replaces ScraperAPI/ZenRows) | Docker + AGPL | If outsourcing all scraping to one service |
| **BullMQ** | [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq) | 7,280 | Distributed job queue (replaces coordinator) | Requires Redis | If scaling to multi-worker architecture |
| **keyv + @keyv/sqlite** | [jaredwray/keyv](https://github.com/jaredwray/keyv) | 3,050 | HTTP response caching (avoid re-fetching) | Moderate | Wrap httpGetWithRetry() with cache layer |

### Stealth & Anti-Detection

| Tool | GitHub | Stars | Status | What It Does |
|------|--------|-------|--------|-------------|
| **rebrowser-patches** | [rebrowser/rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) | 1,289 | Active (May 2025) | Patches Puppeteer CDP leak — #1 detection vector |
| **puppeteer-extra-plugin-stealth** | [berstend/puppeteer-extra](https://github.com/berstend/puppeteer-extra) | 7,282 | **Stale** (Jul 2024) | 17 evasion modules, but unmaintained |
| **Camoufox** | [daijro/camoufox](https://github.com/daijro/camoufox) | 6,400 | Active | Anti-detect Firefox fork (requires Playwright switch) |
| **NopeCHA** | [NopeCHALLC/nopecha-extension](https://github.com/NopeCHALLC/nopecha-extension) | 10,236 | Active | AI CAPTCHA solver, 100 free solves/day |

---

### OSS-First Cost Comparison

| Blocker | Paid Solution | Cost | OSS Alternative | Cost |
|---------|--------------|------|-----------------|------|
| Browser cloud | Browserbase | $20-99/mo | Self-host Browserless | $0 (existing infra) |
| Cloudflare bypass | Bright Data | $500+/mo | FlareSolverr + rebrowser-patches | $0 |
| Google SERP | SerpAPI | $50/mo | Self-host SearXNG | $0 (~$5/mo VPS) |
| Twitter data | X API Basic | $200/mo | the-convocation/twitter-scraper | $0 |
| YouTube quota | Higher API tier | $200/mo | Port youtube-comment-downloader | $0 |
| Coordinator concurrency | N/A | N/A | p-queue | $0 |
| Global rate limiting | N/A | N/A | bottleneck | $0 |
| Fast dedup | N/A | N/A | minhash LSH | $0 |
| Proxy rotation | IPRoyal/Decodo | $10-30/mo | proxy-chain + free proxy lists | $0 (unreliable) |
| **Total** | | **~$1,000+/mo** | | **~$5/mo** (SearXNG VPS) |

### Recommended OSS-First Implementation Order

**Week 1 — Drop-in npm packages (zero cost, minimal changes):**
1. `npm install rebrowser-puppeteer-core` → swap import in browser.mjs
2. `npm install p-queue` → wrap coordinator's Promise.all() with concurrency: 5
3. `npm install bottleneck` → replace RateLimiter in http.mjs with shared instance

**Week 2 — Docker sidecars:**
4. `docker run browserless/browserless` → point browser.mjs at it
5. `docker run flaresolverr/flaresolverr` → route Cloudflare-blocked requests through it
6. `docker-compose up searxng` → replace public SearXNG instances in websearch.mjs

**Week 3 — Source replacements:**
7. Replace Nitter with `the-convocation/twitter-scraper` in twitter.mjs
8. Add Arctic Shift as fallback in reddit-api.mjs
9. Port youtube-comment-downloader approach to remove API quota dependency

**Week 4 — Performance:**
10. `npm install minhash` → replace O(N²) dedup in coordinator.mjs with LSH
11. `npm install keyv @keyv/sqlite` → add HTTP response caching in http.mjs
12. Add NopeCHA extension loading in browser.mjs for CAPTCHA safety net

---

## Appendix C: Fundamental Scalability Unblocking

The changes in Appendices A and B take GapScout from "breaks on moderate use" to "works reliably at moderate scale." This appendix addresses the **fundamental ceilings** that remain.

### Three Walls That No npm Package Can Fix

| Wall | Why It's Fundamental | Solution Category |
|------|---------------------|-------------------|
| **Single IP, single machine** | 1 ban = everything stops. Can't distribute work. | Distributed architecture |
| **Hard API daily/hourly caps** | GitHub 5K/hr, YouTube 10K units/day, SO 10K/day — external limits | Alternative data access |
| **Browser sources are inherently slow** | G2 takes 5-7s/page. Pooling helps concurrency, not per-page speed | Eliminate the browser |

---

### Wall 1: Single IP → Distributed Architecture

#### Strategy A: BullMQ + Redis (multi-worker queue)

Replace coordinator's `Promise.all()` with a distributed job queue:

```
Current:  coordinator.mjs → spawn 23 child processes → Promise.all → merge
Proposed: coordinator.mjs → enqueue 23 jobs to BullMQ → N workers pick them up → results in Redis
```

- **Tool:** [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq) (7K stars, Node.js native)
- **Infra:** 1 Redis instance ($0 on Upstash free tier, or $5/mo self-hosted)
- **Effort:** ~1 week refactor
- **What it removes:** Single-process ceiling. Adding workers = linear scaling. Workers can run on different machines/IPs.

#### Strategy B: Lambda proxy pool (multi-IP for API sources)

Deploy thin Lambda functions as HTTP proxies. Each invocation gets a different AWS IP.

- **Tool:** [teticio/lambda-scraper](https://github.com/teticio/lambda-scraper) — Terraform + Docker Lambda proxy
- **Cost:** AWS Lambda free tier = 1M requests/month free. After: ~$0.20/1M requests
- **Applies to:** 14+ API-based sources (Reddit, HN, GitHub, SO, Bluesky, Mastodon, etc.)
- **Does NOT work for:** Browser sources (Lambda has no Chrome)
- **Effort:** 3-5 days
- **What it removes:** Single-IP ceiling for API sources at near-zero cost

#### Strategy C: VPS proxy fleet (multi-IP for browser sources)

Spin up 5-10 cheap VPS instances as proxy servers.

- **Tool:** [claffin/cloudproxy](https://github.com/claffin/cloudproxy) — auto-provisions proxies across DigitalOcean, AWS, GCP, Hetzner
- **Cost:** Hetzner CX22 = €3.29/mo per VPS. 10 VPS = ~$35/mo for 10 IPs
- **Applies to:** Browser sources (G2, Trustpilot, Twitter)
- **Effort:** 2-3 days
- **What it removes:** Single-IP ceiling for browser sources

#### Recommended hybrid:

| Source type | IP strategy | Cost |
|---|---|---|
| API sources (14+) | Lambda proxy pool | $0-5/mo |
| Browser sources (light protection) | Self-hosted VPS proxies | $15-30/mo |
| Browser sources (Cloudflare/DataDome) | Commercial residential proxy | $49+/mo (only if needed) |

---

### Wall 2: Hard API Caps → Alternative Data Access

For each API-gated source, there is often a way to get the **same data without the API**:

#### YouTube: Innertube API (removes 10K unit/day cap COMPLETELY)

YouTube's own frontend uses an internal API at `youtube.com/youtubei/v1/next` that has no unit quota. The [youtube-comment-downloader](https://github.com/egbertbouman/youtube-comment-downloader) (1.2K stars) uses this approach. No API key needed, no quota.

- **Impact:** Goes from ~120 comments/day → unlimited
- **Effort:** Medium (port Python approach to Node.js)
- **Risk:** Low — YouTube's internal API has been stable for years

#### Bluesky: Jetstream firehose (removes 3K/5min cap COMPLETELY)

Bluesky's [Jetstream](https://github.com/bluesky-social/jetstream) is an official real-time stream of ALL posts on the network via WebSocket. No rate limits. Filter by keyword in real-time.

- **Impact:** Goes from 3K req/5min polling → every single post, real-time
- **Effort:** Medium (WebSocket client + keyword filter)
- **Risk:** None — this is the officially recommended approach
- **Bandwidth:** ~25.5 GB/month with zstd compression (filtering for posts only)

#### GitHub: GHArchive + BigQuery (removes 5K/hr cap for historical data)

[GHArchive](https://www.gharchive.org/) records every public GitHub event hourly. Queryable via Google BigQuery (1 TB/month free). Also: switch REST → GraphQL for 5-10x effective throughput on real-time queries.

- **Impact:** Historical queries = unlimited. Real-time = 5-10x via GraphQL
- **Effort:** Low-Medium
- **Risk:** None — official public dataset

#### Stack Overflow: SEDE (removes 10K/day cap for bulk queries)

[Stack Exchange Data Explorer](https://data.stackexchange.com/) provides free SQL access to a weekly-refreshed copy of the entire SO database. No API quota consumed. 50K row result limit per query.

- **Impact:** Bulk pain-signal queries = unlimited (1 week lag)
- **Effort:** Low (write SQL queries, fetch results via HTTP)
- **Risk:** None — official tool

#### Reddit: Already optimal

GapScout's dual approach (PullPush + browser) is close to best-in-class. Add Arctic Shift as PullPush fallback for resilience.

#### Summary: API ceiling removal

| Source | Current Ceiling | Alternative | New Ceiling | Effort |
|--------|----------------|-------------|-------------|--------|
| **YouTube** | 10K units/day (~120 comments) | Innertube internal API | **None** (IP-based only) | Medium |
| **Bluesky** | 3K req/5min | Jetstream firehose | **None** (real-time stream) | Medium |
| **GitHub** | 5K/hr (REST) | GHArchive + GraphQL | **None** (historical) / 5-10x (real-time) | Low-Med |
| **Stack Overflow** | 10K/day (keyed) | SEDE SQL queries | **None** (weekly data) | Low |
| **Reddit** | 100 RPM (OAuth) | Already PullPush + browser | Unchanged | Done |
| **Product Hunt** | 450/15min | Already GraphQL + browser | Unchanged | Done |
| **Google Autocomplete** | IP-based CAPTCHA | Proxy rotation | Scales with IPs | Medium |

---

### Wall 3: Browser Slowness → Eliminate the Browser

Key finding: **most "browser-required" sources already have HTTP-first paths**. The real browser dependency is narrower than it appears.

#### Sources where browser can be fully eliminated:

| Source | Current Speed | Browser-Free Approach | New Speed | Speedup |
|--------|-------------|----------------------|-----------|---------|
| **Reddit Browser** | 1.5-2s/page (Puppeteer) | Append `.json` to URLs → pure HTTP JSON | 100-200ms | **10-15x** |
| **Trustpilot** | 2.5-3.2s/page (browser) | Already HTTP via `__NEXT_DATA__` + `/_next/data/` JSON | 200-400ms | **Already done** |
| **Product Hunt** | 2.1s (browser fallback) | Already GraphQL API primary | N/A | **Already done** |
| **Google Autocomplete** | 20-25s (PAA browser) | Suggestions already HTTP; PAA via self-hosted SearXNG | 50-100ms (suggestions) | **Already done** |
| **WebSearch** | 2.5-4s (Google browser) | Self-host SearXNG → HTTP JSON | 200-500ms | **5-10x** |

#### Sources where browser is still needed (but can be faster):

| Source | Current Speed | Optimization | New Speed | Speedup |
|--------|-------------|-------------|-----------|---------|
| **G2/Capterra** | 5-7s/page | FlareSolverr session cookies → HTTP for subsequent pages | 3-4s | **1.5-2x** |
| **G2/Capterra** | 5-7s/page | + Resource blocking (images/CSS/fonts) | 2-3s | **2-3x** |
| **Twitter/X** | 2.5-4s/page | Replace Nitter with `the-convocation/twitter-scraper` | 200-500ms | **5-10x** |
| **Kickstarter** | 3-4s/page | Reverse-engineer hidden JSON API | 200-400ms | **5-10x** |

#### Universal browser speedup — resource blocking:

Adding `page.setRequestInterception(true)` to block images, CSS, fonts, and media provides **1.5-2x speedup** across ALL browser sources. ~10 lines of code in `browser.mjs`. Currently NOT implemented.

#### Net effect on the 8 browser sources:

| Source | Before | After All Optimizations | Browser Still Needed? |
|--------|--------|------------------------|----------------------|
| Reddit Browser | 1.5-2s/page | 100-200ms (`.json` HTTP) | **No** |
| Trustpilot | 2.5-3.2s (browser path) | 200-400ms (HTTP path) | **No** (already HTTP-first) |
| Product Hunt | 2.1s | 2.1s (rate-limit bound) | **No** (already API-first) |
| Google Autocomplete | 50ms-25s | 50-100ms (HTTP) | **No** (except PAA) |
| WebSearch | 2.5-4s | 200-500ms (SearXNG) | **No** (self-host SearXNG) |
| Twitter/X | 2.5-4s | 200-500ms (twitter-scraper) | **No** |
| Kickstarter | 3-4s | 200-400ms (hidden API) | **Maybe** (comments scroll) |
| G2/Capterra | 5-7s | 2-3s (FlareSolverr + resource block) | **Yes** (last holdout) |

**Bottom line:** After all optimizations, **only G2/Capterra truly requires a browser.** Everything else can go pure HTTP.

---

### Fundamental Unblocking Roadmap

#### Phase 1: Eliminate unnecessary browsers (Week 1-2, $0)
1. Reddit browser → `.json` HTTP API (10-15x speedup)
2. Resource blocking in browser.mjs (1.5-2x for remaining browser sources)
3. Twitter → `the-convocation/twitter-scraper` (eliminates Nitter dependency)
4. Self-host SearXNG (eliminates Google browser scraping)

#### Phase 2: Remove API ceilings (Week 2-3, $0)
5. YouTube → Innertube internal API (removes 10K unit/day cap)
6. Bluesky → Jetstream firehose (real-time, no rate limit)
7. GitHub → GraphQL API (5-10x throughput) + GHArchive for historical
8. Stack Overflow → SEDE for bulk queries

#### Phase 3: Incremental data layer (Week 3-4, $0)
9. SQLite high-water marks (skip already-seen posts, ~70% fewer requests)
10. HTTP response caching with keyv/SQLite (skip unchanged responses)

#### Phase 4: Distributed architecture (Week 4-6, $5-40/mo)
11. BullMQ + Redis job queue (multi-worker, multi-machine)
12. Lambda proxy pool for API sources ($0-5/mo for multi-IP)
13. VPS proxy fleet for browser sources ($30-50/mo for 10 IPs)

#### After all phases:

| Metric | Current | After Phase 1-2 | After Phase 3-4 |
|--------|---------|-----------------|-----------------|
| Sources needing browser | 8 | 1 (G2 only) | 1 |
| API-capped sources | 4 (YT, BS, GH, SO) | 0 | 0 |
| IPs available | 1 | 1 | 10+ |
| Workers | 1 process | 1 process | N workers |
| Redundant fetching | 100% re-fetch | 100% re-fetch | ~30% (incremental) |
| Estimated throughput | ~500 posts/scan | ~5,000 posts/scan | ~50,000+ posts/scan |
| Monthly cost | $0 | $0 | $5-40 |
