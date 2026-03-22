/**
 * stackoverflow.mjs — Stack Overflow source for pain-point-finder
 *
 * Uses the Stack Exchange API to search questions tagged with domain-related tags,
 * filters by score and answer count. Frustrated developers asking for help = pain signal.
 *
 * API key is optional:
 *   - Without key: 300 requests/day (unkeyed)
 *   - With STACKEXCHANGE_KEY: 10,000 requests/day (33x improvement)
 *
 * Usage:
 *   pain-points so scan --domain "project management"
 *   pain-points stackoverflow scan --domain "SaaS billing" --limit 100
 *
 *   # With API key (dramatically higher rate limits):
 *   STACKEXCHANGE_KEY=xxx node scripts/cli.mjs so scan --domain "kubernetes"
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGet } from '../lib/http.mjs';
import zlib from 'node:zlib';
import https from 'node:https';

// ─── constants ───────────────────────────────────────────────────────────────

const SE_API_HOST = 'api.stackexchange.com';
const SE_KEY = process.env.STACKEXCHANGE_KEY || '';
const MIN_DELAY_MS = 1000;

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

// ─── Stack Exchange API helper ──────────────────────────────────────────────

/**
 * Fetch from Stack Exchange API. The API returns gzip-compressed responses,
 * so we need to handle decompression manually.
 */
async function seApiGet(path) {
  await rateLimit();
  log(`[stackoverflow] GET ${path}`);

  return new Promise((resolve, reject) => {
    const url = `https://${SE_API_HOST}${path}`;
    const req = https.get(url, {
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': 'pain-point-finder/1.0',
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
          if (data.error_id) {
            reject(new Error(`SE API error ${data.error_id}: ${data.error_message}`));
            return;
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

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 50;
  const maxPages = args.maxPages || 3;

  log(`[stackoverflow] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}`);

  const queries = buildPainQueries(domain);
  const questionsById = new Map();

  for (const query of queries) {
    for (let page = 1; page <= maxPages; page++) {
      let result;
      try {
        result = await searchQuestions(query, { page, pageSize: 50 });
      } catch (err) {
        log(`[stackoverflow] query "${query}" page ${page} failed: ${err.message}`);
        break;
      }

      log(`[stackoverflow] query="${query}" page=${page}: ${result.items.length} items (quota: ${result.quotaRemaining})`);

      for (const item of result.items) {
        if (!questionsById.has(item.question_id)) {
          questionsById.set(item.question_id, item);
        }
      }

      if (!result.hasMore || result.items.length < 50) break;

      // Stop if quota is getting low
      if (result.quotaRemaining !== undefined && result.quotaRemaining < 20) {
        log(`[stackoverflow] quota low (${result.quotaRemaining}), stopping`);
        break;
      }
    }
  }

  log(`[stackoverflow] ${questionsById.size} unique questions found`);

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const item of questionsById.values()) {
    const post = normalizePost(item);

    // Basic relevance check
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'stackoverflow';
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'stackoverflow',
    posts: scored.slice(0, limit),
    stats: {
      queries_run: queries.length,
      raw_questions: questionsById.size,
      after_filter: Math.min(scored.length, limit),
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'stackoverflow',
  description: 'Stack Overflow — Stack Exchange API, no browser needed',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
stackoverflow source — Stack Exchange API

Commands:
  scan       Search Stack Overflow for pain-revealing questions about a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max posts to return (default: 50)
  --max-pages <n>       Max pages per query (default: 3)

API key (optional):
  Set STACKEXCHANGE_KEY environment variable for higher rate limits.
  - Without key:  300 requests/day
  - With key:     10,000 requests/day
  Get a free key at https://stackapps.com/ (no OAuth needed, just a simple app key).

Examples:
  node scripts/cli.mjs so scan --domain "kubernetes" --limit 100
  STACKEXCHANGE_KEY=xxx node scripts/cli.mjs so scan --domain "react native"
`,
};
