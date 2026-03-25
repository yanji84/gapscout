/**
 * cfpb.mjs — CFPB Consumer Complaints source for gapscout
 *
 * Uses the CFPB Consumer Complaint Database API to search consumer complaints.
 * Financial product complaints with narratives = validated consumer pain.
 *
 * No API key required — free government data.
 *
 * Usage:
 *   pain-points cfpb scan --domain "banking"
 *   pain-points cfpb scan --domain "credit card" --limit 100 --days 180
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGet } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const CFPB_API_HOST = 'www.consumerfinance.gov';
const MIN_DELAY_MS = 500;

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;

log('[cfpb] Public API mode — no key required (free government data)');

// ─── rate limiter ────────────────────────────────────────────────────────────

let lastRequestAt = 0;

async function rateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

// ─── CFPB API helper ────────────────────────────────────────────────────────

async function cfpbApiGet(path) {
  await rateLimit();
  getUsageTracker().increment('cfpb');
  log(`[cfpb] GET ${path}`);

  try {
    const data = await httpGet(CFPB_API_HOST, path, {
      timeout: 15000,
      headers: { 'User-Agent': 'gapscout/1.0' },
    });
    return data;
  } catch (err) {
    if (err.statusCode === 429) {
      rateLimitWarnings++;
      log(`[cfpb] WARNING: rate limited (429) — backing off`);
    }
    if (err.statusCode === 403) {
      rateLimitWarnings++;
      log(`[cfpb] WARNING: received 403 Forbidden`);
    }
    throw err;
  }
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Search CFPB complaints matching a keyword.
 * Uses the Consumer Complaint Database search API.
 */
async function searchComplaints(keyword, { limit = 100, days = 180 } = {}) {
  const dateMin = new Date(Date.now() - days * 86400 * 1000).toISOString().split('T')[0];
  const params = new URLSearchParams({
    search_term: keyword,
    date_received_min: dateMin,
    size: String(limit),
    sort: 'relevance_desc',
  });
  const path = `/data-research/consumer-complaints/search/api/v1/?${params.toString()}`;
  const data = await cfpbApiGet(path);
  return {
    items: data.hits?.hits || [],
    total: data.hits?.total?.value || data.hits?.total || 0,
  };
}

// ─── normalizers ────────────────────────────────────────────────────────────

function normalizePost(item) {
  const src = item._source || {};
  const id = item._id || String(src.complaint_id || Math.random());
  const product = src.product || '';
  const issue = src.issue || '';
  const title = [product, issue].filter(Boolean).join(' — ');
  const body = src.complaint_what_happened || '';
  const dateReceived = src.date_received || '';
  const createdUtc = dateReceived ? Math.floor(new Date(dateReceived).getTime() / 1000) : 0;

  return {
    id: String(id),
    title,
    selftext: body.slice(0, 3000),
    subreddit: 'cfpb',
    url: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/${id}`,
    score: src.consumer_disputed === 'Yes' ? 2 : 1,
    num_comments: 0,
    upvote_ratio: 0,
    flair: [src.sub_product, src.sub_issue].filter(Boolean).join(', '),
    created_utc: createdUtc,
    company: src.company || '',
    state: src.state || '',
    company_response: src.company_response || '',
  };
}

// ─── query generation ───────────────────────────────────────────────────────

function buildPainQueries(domain) {
  return [
    `${domain} problem`,
    `${domain} complaint`,
    `${domain} fee`,
    `${domain} error`,
    `${domain} unauthorized`,
    `${domain} fraud`,
    `${domain} denied`,
    `${domain} misleading`,
    `${domain} overcharged`,
    `${domain} closed account`,
    `${domain} late`,
    `${domain} harassed`,
    `${domain}`,
  ];
}

// ─── scan command ───────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 100;
  const days = args.days || 180;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  let stoppedEarly = false;

  log(`[cfpb] scan domain="${domain}", limit=${limit}, days=${days}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('cfpb');
  if (remaining.pct >= 80) {
    log(`[cfpb] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[cfpb] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'cfpb', posts: [], stats: { error: 'daily limit reached' } });
  }

  const queries = buildPainQueries(domain);
  const complaintsById = new Map();

  for (const query of queries) {
    if (stoppedEarly) break;

    let result;
    try {
      result = await searchComplaints(query, { limit: Math.min(limit, 100), days });
    } catch (err) {
      log(`[cfpb] query "${query}" failed: ${err.message}`);
      if (err.statusCode === 429) {
        log(`[cfpb] backing off due to 429, returning partial results`);
        await sleep(10000);
        stoppedEarly = true;
      }
      if (err.statusCode === 403) {
        log(`[cfpb] stopping due to 403, returning partial results`);
        stoppedEarly = true;
      }
      continue;
    }

    log(`[cfpb] query="${query}": ${result.items.length} items (total: ${result.total})`);

    for (const item of result.items) {
      const id = item._id || String(item._source?.complaint_id || '');
      if (id && !complaintsById.has(id)) {
        complaintsById.set(id, item);
      }
    }
  }

  log(`[cfpb] ${complaintsById.size} unique complaints found`);

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const item of complaintsById.values()) {
    const post = normalizePost(item);

    // Basic relevance check
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    // Skip complaints with no narrative text
    if (!post.selftext || post.selftext.length < 20) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'cfpb';
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'cfpb',
    posts: scored.slice(0, limit),
    stats: {
      queries_run: queries.length,
      raw_complaints: complaintsById.size,
      after_filter: Math.min(scored.length, limit),
      rateLimitWarnings,
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'cfpb',
  description: 'CFPB Consumer Complaints — free government API, no auth needed',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
cfpb source — CFPB Consumer Complaint Database API

Commands:
  scan       Search consumer complaints for pain signals about a domain

scan options:
  --domain <str>        Product/industry to search for (required)
  --limit <n>           Max posts to return (default: 100)
  --days <n>            Look back period in days (default: 180)

No API key required — this is free government data from the
Consumer Financial Protection Bureau complaint database.

Returns complaints with consumer narratives mapped to standard post format.
Complaints where the consumer disputed the company response are scored higher.

Examples:
  node scripts/cli.mjs cfpb scan --domain "banking" --limit 100
  node scripts/cli.mjs cfpb scan --domain "credit card" --days 365
  node scripts/cli.mjs cfpb scan --domain "mortgage" --limit 200
`,
};
