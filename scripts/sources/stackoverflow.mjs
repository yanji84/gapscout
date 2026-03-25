/**
 * stackoverflow.mjs — Stack Overflow source for gapscout
 *
 * Two data backends:
 *   1. Stack Exchange API — real-time, but limited to 10K req/day (keyed) or 300/day (unkeyed)
 *   2. SEDE (Stack Exchange Data Explorer) — unlimited bulk SQL queries against
 *      the full Stack Overflow database (refreshed weekly, ~1 week old data)
 *
 * Default flow: Try SEDE first for historical bulk data, then API for recent (last 7 days).
 * Use --api-only to skip SEDE, --sede-only to skip the API.
 *
 * API key is optional:
 *   - Without key: 300 requests/day (unkeyed)
 *   - With STACKEXCHANGE_KEY: 10,000 requests/day (33x improvement)
 *
 * Usage:
 *   pain-points so scan --domain "project management"
 *   pain-points stackoverflow scan --domain "SaaS billing" --limit 100
 *   pain-points so scan --domain "kubernetes" --sede-only
 *   pain-points so scan --domain "react" --api-only
 *
 *   # With API key (dramatically higher rate limits):
 *   STACKEXCHANGE_KEY=xxx node scripts/cli.mjs so scan --domain "kubernetes"
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGet } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';
import { getGlobalRateMonitor } from '../lib/rate-monitor.mjs';
import zlib from 'node:zlib';
import https from 'node:https';

// ─── constants ───────────────────────────────────────────────────────────────

const SE_API_HOST = 'api.stackexchange.com';
const SE_KEY = process.env.STACKEXCHANGE_KEY || '';
const MIN_DELAY_MS = 1000;

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;

let _tipShown = false;

if (SE_KEY) {
  log('[stackoverflow] Keyed mode (STACKEXCHANGE_KEY detected) — 10,000 requests/day');
} else {
  log('[stackoverflow] Unkeyed mode — 300 requests/day. Set STACKEXCHANGE_KEY for 33x higher rate limits (free at https://stackapps.com/).');
  if (!_tipShown) {
    _tipShown = true;
    process.stderr.write('[stackoverflow] tip: set STACKEXCHANGE_KEY for 33x more queries → free at stackapps.com\n');
  }
}

// ─── rate limiter ────────────────────────────────────────────────────────────

let lastRequestAt = 0;

async function rateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

// ─── SEDE (Stack Exchange Data Explorer) ────────────────────────────────────

const SEDE_HOST = 'data.stackexchange.com';
const SEDE_RUN_PATH = '/query/run';
const SEDE_TIMEOUT_MS = 120000; // SEDE queries can be slow — 2 minute timeout

/**
 * Build a SEDE SQL query to find pain-signal questions for a given domain.
 * The domain is used for title/body matching; tags is an optional tag filter.
 */
function buildSedeQuery(domain, tags) {
  // Escape single quotes for SQL
  const esc = (s) => s.replace(/'/g, "''");
  const domainEsc = esc(domain);

  // Build tag filter: use provided tags or derive from domain
  const tagFilter = tags
    ? tags.map(t => `p.Tags LIKE '%<${esc(t)}>%'`).join(' OR ')
    : `p.Tags LIKE '%<${esc(domain.toLowerCase().replace(/\s+/g, '-'))}>%'`;

  return `
SELECT TOP 500
  p.Id,
  p.Title,
  p.Body,
  p.Score,
  p.ViewCount,
  p.AnswerCount,
  p.CommentCount,
  p.CreationDate,
  p.Tags
FROM Posts p
WHERE p.PostTypeId = 1
  AND p.Score >= 5
  AND (
    p.Title LIKE '%${domainEsc}%'
    OR ${tagFilter}
  )
  AND (
    p.Title LIKE '%frustrat%' OR p.Title LIKE '%hate%' OR p.Title LIKE '%broken%'
    OR p.Title LIKE '%alternative%' OR p.Title LIKE '%switch%'
    OR p.Title LIKE '%bug%' OR p.Title LIKE '%issue%' OR p.Title LIKE '%problem%'
    OR p.Body LIKE '%frustrat%' OR p.Body LIKE '%nightmare%'
  )
ORDER BY p.Score DESC`.trim();
}

/**
 * Execute a SQL query against SEDE and return parsed results.
 * SEDE accepts POST to /query/run with form-encoded body.
 * Returns an array of row objects, or throws on error.
 */
async function querySede(domain, tags) {
  const sql = buildSedeQuery(domain, tags);
  log(`[stackoverflow/sede] executing SEDE query (${sql.length} chars)`);

  const postBody = new URLSearchParams({
    sql,
    site: 'stackoverflow',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SEDE_HOST,
      path: SEDE_RUN_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'User-Agent': 'gapscout/5.0',
        'Accept': 'application/json',
      },
      timeout: SEDE_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        // SEDE may return HTML (CAPTCHA page) instead of JSON from new IPs
        if (res.statusCode !== 200 || body.trimStart().startsWith('<!') || body.trimStart().startsWith('<html')) {
          log(`[stackoverflow/sede] WARNING: SEDE returned non-JSON response (status ${res.statusCode}) — possible CAPTCHA or maintenance page. Falling back to API.`);
          const err = new Error(`SEDE returned HTML/non-JSON (status ${res.statusCode})`);
          err.sedeCaptcha = true;
          reject(err);
          return;
        }

        try {
          const data = JSON.parse(body);

          if (!data.resultSets || !data.resultSets.length) {
            log('[stackoverflow/sede] WARNING: SEDE returned empty resultSets');
            resolve([]);
            return;
          }

          const resultSet = data.resultSets[0];
          const columns = resultSet.columns || [];
          const rows = resultSet.rows || [];

          // Map column names to indices
          const colIndex = {};
          columns.forEach((col, i) => { colIndex[col.name] = i; });

          const results = rows.map(row => ({
            Id: row[colIndex['Id']],
            Title: row[colIndex['Title']],
            Body: row[colIndex['Body']],
            Score: row[colIndex['Score']],
            ViewCount: row[colIndex['ViewCount']],
            AnswerCount: row[colIndex['AnswerCount']],
            CommentCount: row[colIndex['CommentCount']],
            CreationDate: row[colIndex['CreationDate']],
            Tags: row[colIndex['Tags']],
          }));

          log(`[stackoverflow/sede] SEDE returned ${results.length} rows`);
          resolve(results);
        } catch (err) {
          log(`[stackoverflow/sede] WARNING: failed to parse SEDE response: ${err.message}`);
          reject(new Error(`SEDE parse error: ${err.message}`));
        }
      });
      res.on('error', reject);
    });

    req.on('error', (err) => {
      log(`[stackoverflow/sede] SEDE request error: ${err.message}`);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      log('[stackoverflow/sede] SEDE request timed out');
      reject(new Error('SEDE request timed out'));
    });

    req.write(postBody);
    req.end();
  });
}

/**
 * Normalize a SEDE result row to the GapScout post format.
 */
function normalizeSedePost(row) {
  const tagsRaw = row.Tags || '';
  // SEDE tags look like "<javascript><node.js>" — extract them
  const tagList = tagsRaw.match(/<([^>]+)>/g)?.map(t => t.slice(1, -1)) || [];

  return {
    id: `so-${row.Id}`,
    title: row.Title || '',
    selftext: stripHtml(row.Body || ''),
    url: `https://stackoverflow.com/questions/${row.Id}`,
    score: row.Score || 0,
    num_comments: row.CommentCount || 0,
    upvote_ratio: 0,
    flair: tagList.slice(0, 3).join(','),
    created_utc: row.CreationDate ? new Date(row.CreationDate).getTime() / 1000 : 0,
    subreddit: 'stackoverflow',
    source: 'stackoverflow',
    _source: 'stackoverflow-sede',
    _views: row.ViewCount || 0,
    _answers: row.AnswerCount || 0,
    _tags: tagsRaw,
  };
}

// ─── Stack Exchange API helper ──────────────────────────────────────────────

/**
 * Fetch from Stack Exchange API. The API returns gzip-compressed responses,
 * so we need to handle decompression manually.
 */
async function seApiGet(path) {
  await rateLimit();
  getUsageTracker().increment('stackoverflow');
  log(`[stackoverflow] GET ${path}`);

  return new Promise((resolve, reject) => {
    const url = `https://${SE_API_HOST}${path}`;
    const req = https.get(url, {
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': 'gapscout/1.0',
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try {
          let body;
          const encoding = res.headers['content-encoding'];
          if (encoding === 'gzip') {
            body = zlib.gunzipSync(buffer).toString('utf8');
          } else {
            body = buffer.toString('utf8');
          }
          const data = JSON.parse(body);

          // Handle 429 Too Many Requests
          if (res.statusCode === 429) {
            rateLimitWarnings++;
            const backoff = data.backoff || 30;
            const err = new Error(`SE API 429: rate limited — backoff ${backoff}s`);
            err.statusCode = 429;
            err.backoff = backoff;
            log(`[stackoverflow] WARNING: rate limit approaching — received 429, backing off ${backoff}s`);
            getGlobalRateMonitor().reportError('stackoverflow', `SE API 429 — rate limited, backoff ${backoff}s`, { statusCode: 429, backoff });
            reject(err);
            return;
          }

          // Handle 403 Forbidden
          if (res.statusCode === 403) {
            rateLimitWarnings++;
            const err = new Error(`SE API 403: ${data.error_message || 'Forbidden'}`);
            err.statusCode = 403;
            log(`[stackoverflow] WARNING: received 403 Forbidden — ${data.error_message || 'possible rate limit'}`);
            getGlobalRateMonitor().reportBlock('stackoverflow', `SE API 403 — ${data.error_message || 'possible rate limit'}`, { statusCode: 403 });
            reject(err);
            return;
          }

          if (data.error_id) {
            reject(new Error(`SE API error ${data.error_id}: ${data.error_message}`));
            return;
          }

          // Log backoff header if SE asks us to slow down
          if (data.backoff) {
            log(`[stackoverflow] WARNING: SE API requested backoff of ${data.backoff}s`);
            rateLimitWarnings++;
            getGlobalRateMonitor().reportWarning('stackoverflow', `SE API requested backoff of ${data.backoff}s`, { backoff: data.backoff });
          }

          resolve(data);
        } catch (err) {
          reject(new Error(`Failed to parse SE API response: ${err.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SE API request timed out')); });
  });
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Search Stack Overflow for questions matching a domain query.
 * Uses the /search/advanced endpoint sorted by votes.
 */
async function searchQuestions(query, { page = 1, pageSize = 50, sort = 'votes' } = {}) {
  const params = new URLSearchParams({
    order: 'desc',
    sort,
    site: 'stackoverflow',
    q: query,
    filter: 'withbody',
    page: String(page),
    pagesize: String(pageSize),
  });
  let pathStr = `/2.3/search/advanced?${params.toString()}`;
  if (SE_KEY) {
    pathStr += `&key=${encodeURIComponent(SE_KEY)}`;
  }
  const data = await seApiGet(pathStr);
  return {
    items: data.items || [],
    hasMore: data.has_more || false,
    quotaRemaining: data.quota_remaining,
    backoff: data.backoff || 0,
  };
}

// ─── normalizers ────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from Stack Overflow body text.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<code>[\s\S]*?<\/code>/g, '[code]')
    .replace(/<pre>[\s\S]*?<\/pre>/g, '[code block]')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePost(item) {
  return {
    id: String(item.question_id),
    title: item.title || '',
    selftext: stripHtml(item.body || ''),
    subreddit: 'stackoverflow',
    url: item.link || `https://stackoverflow.com/questions/${item.question_id}`,
    score: item.score || 0,
    num_comments: item.answer_count || 0,
    upvote_ratio: 0,
    flair: item.tags ? item.tags.slice(0, 3).join(',') : '',
    created_utc: item.creation_date || 0,
  };
}

// ─── query generation ───────────────────────────────────────────────────────

function buildPainQueries(domain) {
  return [
    `${domain} error`,
    `${domain} not working`,
    `${domain} problem`,
    `${domain} bug`,
    `${domain} issue`,
    `${domain} broken`,
    `${domain} alternative`,
    `${domain} frustrated`,
    `${domain} workaround`,
    `${domain} fix`,
    `${domain} fails`,
    `${domain} crash`,
    `${domain} slow`,
    `${domain} deprecated`,
    `${domain} replacement`,
    `${domain} migration`,
    `${domain}`,
  ];
}

// ─── scan command ───────────────────────────────────────────────────────────

/**
 * Collect posts from the Stack Exchange API (real-time, quota-limited).
 * Returns { questionsById, quotaRemaining, stoppedEarly }.
 */
async function collectFromApi(domain, maxPages) {
  let quotaRemaining = undefined;
  let stoppedEarly = false;

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('stackoverflow');
  if (remaining.pct >= 80) {
    log(`[stackoverflow/api] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[stackoverflow/api] ERROR: daily budget exhausted. Try again tomorrow.`);
    return { questionsById: new Map(), quotaRemaining: 0, stoppedEarly: true };
  }

  const queries = buildPainQueries(domain);
  const questionsById = new Map();

  for (const query of queries) {
    if (stoppedEarly) break;

    for (let page = 1; page <= maxPages; page++) {
      let result;
      try {
        result = await searchQuestions(query, { page, pageSize: 50 });
      } catch (err) {
        log(`[stackoverflow/api] query "${query}" page ${page} failed: ${err.message}`);
        if (err.statusCode === 429) {
          const backoff = err.backoff || 30;
          log(`[stackoverflow/api] backing off ${backoff}s due to 429, returning partial results`);
          await sleep(backoff * 1000);
          stoppedEarly = true;
        }
        if (err.statusCode === 403) {
          log(`[stackoverflow/api] stopping due to 403, returning partial results`);
          stoppedEarly = true;
        }
        break;
      }

      quotaRemaining = result.quotaRemaining;
      log(`[stackoverflow/api] query="${query}" page=${page}: ${result.items.length} items (quota: ${quotaRemaining})`);

      if (result.backoff) {
        log(`[stackoverflow/api] SE requested backoff of ${result.backoff}s, sleeping`);
        await sleep(result.backoff * 1000);
      }

      for (const item of result.items) {
        if (!questionsById.has(item.question_id)) {
          questionsById.set(item.question_id, item);
        }
      }

      if (!result.hasMore || result.items.length < 50) break;

      if (quotaRemaining !== undefined && quotaRemaining < 50) {
        log(`[stackoverflow/api] WARNING: rate limit approaching — ${quotaRemaining} requests remaining`);
        rateLimitWarnings++;
        getGlobalRateMonitor().reportWarning('stackoverflow', `Quota low — ${quotaRemaining} requests remaining`, { quotaRemaining });
      }

      if (quotaRemaining !== undefined && quotaRemaining < 20) {
        log(`[stackoverflow/api] quota critically low (${quotaRemaining}), stopping to preserve remaining quota`);
        getGlobalRateMonitor().reportError('stackoverflow', `Quota critically low (${quotaRemaining}), stopping early`, { quotaRemaining });
        stoppedEarly = true;
        break;
      }
    }
  }

  return { questionsById, quotaRemaining, stoppedEarly };
}

/**
 * Collect posts from SEDE (bulk historical, no quota).
 * Returns { sedePosts, sedeError }.
 */
async function collectFromSede(domain, tags) {
  let sedePosts = [];
  let sedeError = null;

  try {
    const rows = await querySede(domain, tags);
    sedePosts = rows.map(normalizeSedePost);
    log(`[stackoverflow/sede] ${sedePosts.length} posts normalized from SEDE`);
  } catch (err) {
    sedeError = err.message;
    if (err.sedeCaptcha) {
      log(`[stackoverflow/sede] SEDE requires CAPTCHA — visit https://data.stackexchange.com in a browser first, then retry.`);
    } else {
      log(`[stackoverflow/sede] SEDE query failed: ${err.message} — will fall back to API`);
    }
  }

  return { sedePosts, sedeError };
}

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 50;
  const maxPages = args.maxPages || 3;
  const apiOnly = args.apiOnly || args['api-only'] || false;
  const sedeOnly = args.sedeOnly || args['sede-only'] || false;
  const sedeTags = args.sedeTags || args['sede-tags'] || null; // comma-separated tag overrides

  if (apiOnly && sedeOnly) {
    fail('Cannot use both --api-only and --sede-only');
  }

  // Reset per-scan counters
  rateLimitWarnings = 0;

  const mode = sedeOnly ? 'sede-only' : apiOnly ? 'api-only' : 'sede+api';
  log(`[stackoverflow] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}, mode=${mode}`);

  const parsedTags = sedeTags ? sedeTags.split(',').map(t => t.trim()).filter(Boolean) : null;

  // ── Phase 1: SEDE (historical bulk data, ~1 week old) ──
  let sedePosts = [];
  let sedeError = null;

  if (!apiOnly) {
    const sedeResult = await collectFromSede(domain, parsedTags);
    sedePosts = sedeResult.sedePosts;
    sedeError = sedeResult.sedeError;
  }

  // ── Phase 2: Stack Exchange API (real-time, quota-limited) ──
  let apiQuestionsById = new Map();
  let quotaRemaining = undefined;

  if (!sedeOnly) {
    // If SEDE succeeded and returned plenty of data, only use API for recent questions
    const apiResult = await collectFromApi(domain, maxPages);
    apiQuestionsById = apiResult.questionsById;
    quotaRemaining = apiResult.quotaRemaining;
    log(`[stackoverflow/api] ${apiQuestionsById.size} unique questions from API`);
  }

  // ── Merge and deduplicate ──
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const seenIds = new Set();
  const scored = [];

  // Process SEDE posts first (they have richer metadata: views, answer count)
  for (const post of sedePosts) {
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'stackoverflow';
      enriched._source = 'stackoverflow-sede';
      scored.push(enriched);
      // Track the numeric SO question ID for dedup with API results
      const numericId = String(post.id).replace(/^so-/, '');
      seenIds.add(numericId);
    }
  }

  // Process API posts, skipping those already found via SEDE
  for (const item of apiQuestionsById.values()) {
    if (seenIds.has(String(item.question_id))) continue;

    const post = normalizePost(item);
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'stackoverflow';
      enriched._source = 'stackoverflow-api';
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  const totalRaw = sedePosts.length + apiQuestionsById.size;
  log(`[stackoverflow] ${totalRaw} total raw questions (${sedePosts.length} SEDE + ${apiQuestionsById.size} API), ${scored.length} after scoring`);

  ok({
    source: 'stackoverflow',
    posts: scored.slice(0, limit),
    stats: {
      mode,
      sede_raw: sedePosts.length,
      sede_error: sedeError,
      api_raw: apiQuestionsById.size,
      total_raw: totalRaw,
      after_filter: Math.min(scored.length, limit),
      quotaRemaining,
      rateLimitWarnings,
      rateMonitor: getGlobalRateMonitor().getSourceBreakdown().get('stackoverflow') || { warnings: 0, blocks: 0, errors: 0 },
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'stackoverflow',
  description: 'Stack Overflow — SEDE bulk queries + Stack Exchange API',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
stackoverflow source — SEDE (bulk) + Stack Exchange API (real-time)

Commands:
  scan       Search Stack Overflow for pain-revealing questions about a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max posts to return (default: 50)
  --max-pages <n>       Max pages per API query (default: 3)
  --api-only            Skip SEDE, use only the Stack Exchange API (current behavior)
  --sede-only           Skip API, use only SEDE (unlimited, but data is ~1 week old)
  --sede-tags <tags>    Comma-separated SO tags for SEDE query (e.g. "react,reactjs")

Data sources:
  SEDE (Stack Exchange Data Explorer):
    - Unlimited bulk SQL queries against the full Stack Overflow database
    - No API key needed, no rate limits
    - Data is refreshed weekly (~1 week old)
    - May require solving a CAPTCHA on first use from a new IP
      (visit https://data.stackexchange.com in a browser first)

  Stack Exchange API:
    - Real-time data, but quota-limited
    - Without key:  300 requests/day
    - With key:     10,000 requests/day
    - Set STACKEXCHANGE_KEY env var (free at https://stackapps.com/)

Default mode: SEDE first (historical bulk), then API (recent data).
SEDE errors are handled gracefully — falls back to API-only.

Examples:
  node scripts/cli.mjs so scan --domain "kubernetes" --limit 100
  node scripts/cli.mjs so scan --domain "react" --sede-only --sede-tags "reactjs,react-hooks"
  node scripts/cli.mjs so scan --domain "docker" --api-only
  STACKEXCHANGE_KEY=xxx node scripts/cli.mjs so scan --domain "react native"
`,
};
