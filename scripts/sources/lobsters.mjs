/**
 * lobsters.mjs — Lobsters source for gapscout
 *
 * Uses the Lobsters JSON API (append .json to any URL) to search stories
 * by domain-relevant tags. Developer link aggregator with high signal-to-noise.
 *
 * No auth required. Rate limit: be respectful (~1 req/sec, crawl-delay: 1).
 *
 * Usage:
 *   gapscout lobsters scan --domain "kubernetes" --limit 50
 *   gapscout lobsters scan --domain "devops" --limit 100
 */

import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGetWithRetry } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const LOBSTERS_HOST = 'lobste.rs';

// Respect robots.txt crawl-delay: 1
const MIN_DELAY_MS = 1100;

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;
let totalRequests = 0;

// ─── rate limiter ────────────────────────────────────────────────────────────

let lastRequestAt = 0;

async function rateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
  lastRequestAt = Date.now();
  totalRequests++;
  if (totalRequests > 0 && totalRequests % 50 === 0) {
    log(`[lobsters] INFO: ${totalRequests} requests made this session — pacing at ${MIN_DELAY_MS}ms between requests`);
  }
}

// ─── Lobsters API helper ────────────────────────────────────────────────────

/**
 * Fetch from Lobsters JSON API with rate limiting and retry logic.
 */
async function lobstersGet(path) {
  await rateLimit();
  getUsageTracker().increment('lobsters');
  log(`[lobsters] GET ${path}`);

  try {
    const data = await httpGetWithRetry(LOBSTERS_HOST, path, {
      maxRetries: 3,
      headers: {
        'User-Agent': 'gapscout/5.0',
        'Accept': 'application/json',
      },
    });
    return data;
  } catch (err) {
    const code = err.statusCode || 0;
    if (code === 429) {
      rateLimitWarnings++;
      log(`[lobsters] WARNING: rate limit hit — received 429 Too Many Requests`);
      await sleep(10000);
      return null;
    }
    if (code === 403) {
      rateLimitWarnings++;
      log(`[lobsters] WARNING: received 403 Forbidden`);
      return null;
    }
    throw err;
  }
}

// ─── tag generation ─────────────────────────────────────────────────────────

/**
 * Generate domain-relevant Lobsters tags from a user-provided domain string.
 * Lobsters has a curated tag set; we map domains to known tags.
 */
function generateTags(domain) {
  const d = domain.toLowerCase().trim();

  // Known Lobsters tags (curated list of commonly used tags)
  const knownTags = [
    'ask', 'devops', 'programming', 'security', 'web', 'linux',
    'python', 'rust', 'javascript', 'go', 'ruby', 'java', 'dotnet',
    'databases', 'distributed', 'networking', 'crypto', 'privacy',
    'ai', 'ml', 'hardware', 'mobile', 'design', 'culture',
    'practices', 'testing', 'performance', 'osdev', 'unix',
    'browsers', 'vim', 'emacs', 'git', 'formaldehyde',
    'compsci', 'release', 'show', 'pdf', 'video', 'audio',
    'api', 'elixir', 'erlang', 'haskell', 'scala', 'clojure',
    'lisp', 'c', 'cpp', 'zig', 'nix',
  ];

  // Domain-to-tag mappings
  const domainTagMap = {
    'kubernetes': ['devops', 'distributed', 'linux', 'networking', 'practices'],
    'devops': ['devops', 'linux', 'distributed', 'practices', 'networking'],
    'security': ['security', 'crypto', 'privacy', 'networking', 'practices'],
    'web': ['web', 'javascript', 'browsers', 'design', 'performance'],
    'react': ['web', 'javascript', 'browsers', 'design', 'practices'],
    'python': ['python', 'programming', 'ai', 'ml', 'practices'],
    'rust': ['rust', 'programming', 'performance', 'practices', 'osdev'],
    'database': ['databases', 'distributed', 'performance', 'practices'],
    'ai': ['ai', 'ml', 'programming', 'compsci', 'practices'],
    'machine learning': ['ai', 'ml', 'python', 'compsci', 'programming'],
    'cloud': ['devops', 'distributed', 'networking', 'linux', 'practices'],
    'mobile': ['mobile', 'design', 'programming', 'practices', 'performance'],
    'linux': ['linux', 'unix', 'osdev', 'programming', 'practices'],
    'privacy': ['privacy', 'security', 'crypto', 'culture', 'practices'],
    'project management': ['practices', 'culture', 'programming', 'ask', 'show'],
    'testing': ['testing', 'practices', 'programming', 'performance'],
    'go': ['go', 'programming', 'distributed', 'performance', 'practices'],
    'java': ['java', 'programming', 'practices', 'performance'],
  };

  // Collect matched tags
  const matchedTags = new Set();

  for (const [key, tags] of Object.entries(domainTagMap)) {
    if (d.includes(key)) {
      for (const tag of tags) {
        matchedTags.add(tag);
      }
    }
  }

  // Also try matching domain words directly to known tags
  const words = d.split(/\s+/).filter(w => w.length > 1);
  for (const word of words) {
    const cleaned = word.replace(/[^a-z0-9]/g, '');
    if (knownTags.includes(cleaned)) {
      matchedTags.add(cleaned);
    }
  }

  // Always include 'ask' and 'programming' as fallbacks for broad searches
  if (matchedTags.size === 0) {
    matchedTags.add('ask');
    matchedTags.add('programming');
    matchedTags.add('practices');
    matchedTags.add('show');
  }

  return [...matchedTags];
}

// ─── normalizers ────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from Lobsters body text.
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

function normalizePost(story) {
  const description = story.description || '';
  // For 'ask' type stories, combine description with top comment text
  const commentText = story.comment_count > 0 && story.comments
    ? story.comments.slice(0, 3).map(c => stripHtml(c.comment || c.comment_plain || '')).join('\n\n')
    : '';
  const body = description ? stripHtml(description) + (commentText ? '\n\n' + commentText : '') : commentText;

  const createdAt = story.created_at || '';
  const createdUtc = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : 0;

  return {
    id: story.short_id || String(story.id || ''),
    title: story.title || '',
    selftext: body,
    subreddit: 'lobsters',
    url: story.url || story.comments_url || `https://lobste.rs/s/${story.short_id}`,
    score: story.score || 0,
    num_comments: story.comment_count || 0,
    upvote_ratio: 0,
    flair: (story.tags || []).slice(0, 3).join(','),
    created_utc: createdUtc,
    source: 'lobsters',
  };
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Fetch Lobsters stories by tag with pagination.
 */
async function fetchByTag(tag, { page = 1 } = {}) {
  const path = `/t/${tag}.json?page=${page}`;
  const data = await lobstersGet(path);
  return data || [];
}

/**
 * Fetch newest Lobsters stories with pagination.
 */
async function fetchNewest({ page = 1 } = {}) {
  const path = `/newest.json?page=${page}`;
  const data = await lobstersGet(path);
  return data || [];
}

/**
 * Fetch a single story with comments by short_id.
 */
async function fetchStory(shortId) {
  const path = `/s/${shortId}.json`;
  const data = await lobstersGet(path);
  return data || null;
}

// ─── scan command ───────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 50;
  const maxPages = args.maxPages || 3;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  totalRequests = 0;

  log(`[lobsters] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('lobsters');
  if (remaining.pct >= 80) {
    log(`[lobsters] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[lobsters] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'lobsters', posts: [], stats: { error: 'daily limit reached' } });
  }

  const tags = generateTags(domain);
  log(`[lobsters] searching ${tags.length} tags: ${tags.join(', ')}`);

  const storiesById = new Map();
  let stoppedEarly = false;

  for (const tag of tags) {
    if (stoppedEarly) break;

    for (let page = 1; page <= maxPages; page++) {
      let stories;
      try {
        stories = await fetchByTag(tag, { page });
      } catch (err) {
        log(`[lobsters] tag "${tag}" page ${page} failed: ${err.message}`);
        if (err.statusCode === 429) {
          log(`[lobsters] rate limited, returning partial results`);
          await sleep(10000);
          stoppedEarly = true;
        }
        break;
      }

      if (!stories || !Array.isArray(stories) || stories.length === 0) break;

      log(`[lobsters] tag="${tag}" page=${page}: ${stories.length} stories`);

      for (const story of stories) {
        const sid = story.short_id || String(story.id || '');
        if (sid && !storiesById.has(sid)) {
          storiesById.set(sid, story);
        }
      }

      // Stop early if fewer results than expected (last page)
      if (stories.length < 25) break;
    }
  }

  log(`[lobsters] ${storiesById.size} unique stories found`);

  // Save raw stories before filtering
  try {
    const allRawPosts = [...storiesById.values()].map(s => normalizePost(s));
    const rawOutput = { ok: true, data: { source: 'lobsters', posts: allRawPosts, stats: { raw: true, total: allRawPosts.length } } };
    writeFileSync('/tmp/gapscout-lobsters-raw.json', JSON.stringify(rawOutput));
    log(`[lobsters] saved ${allRawPosts.length} raw posts to /tmp/gapscout-lobsters-raw.json`);
  } catch (err) {
    log(`[lobsters] failed to save raw posts: ${err.message}`);
  }

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const story of storiesById.values()) {
    const post = normalizePost(story);

    // Basic relevance check
    const fullText = ((post.title || '') + ' ' + (post.selftext || '') + ' ' + (post.flair || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'lobsters';
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'lobsters',
    posts: scored.slice(0, limit),
    stats: {
      tags_searched: tags.length,
      raw_stories: storiesById.size,
      after_filter: Math.min(scored.length, limit),
      totalRequests,
      rateLimitWarnings,
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'lobsters',
  description: 'Lobsters — JSON API, no browser needed',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
lobsters source — Lobsters JSON API

Commands:
  scan       Search Lobsters stories for pain-point posts related to a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max posts to return (default: 50)
  --max-pages <n>       Max pages per tag (default: 3)

Rate limits:
  - No auth required
  - Respectful rate limiting (~1 req/sec, respects crawl-delay: 1)

Examples:
  node scripts/cli.mjs lobsters scan --domain "kubernetes" --limit 50
  node scripts/cli.mjs lobsters scan --domain "devops" --limit 100
`,
};
