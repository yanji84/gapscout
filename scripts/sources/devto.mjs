/**
 * devto.mjs — Dev.to (Forem) source for gapscout
 *
 * Uses the Dev.to public API to search articles by domain-relevant tags.
 * Developer blog posts and discussions reveal pain points and tool gaps.
 *
 * No auth required for reading. Rate limit: 30 req/30 sec unauthenticated.
 *
 * Usage:
 *   gapscout devto scan --domain "project management"
 *   gapscout dev scan --domain "kubernetes" --limit 100
 */

import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGetWithRetry } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const DEVTO_HOST = 'dev.to';
const API_BASE = '/api';

// 30 requests per 30 seconds unauthenticated => ~1 req/sec to stay safe
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
    log(`[devto] INFO: ${totalRequests} requests made this session — pacing at ${MIN_DELAY_MS}ms between requests`);
  }
}

// ─── Dev.to API helper ──────────────────────────────────────────────────────

/**
 * Fetch from Dev.to API with rate limiting and retry logic.
 */
async function devtoGet(path) {
  await rateLimit();
  getUsageTracker().increment('devto');
  log(`[devto] GET ${path}`);

  try {
    const data = await httpGetWithRetry(DEVTO_HOST, path, {
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
      log(`[devto] WARNING: rate limit hit — received 429 Too Many Requests`);
      await sleep(30000);
      return null;
    }
    if (code === 403) {
      rateLimitWarnings++;
      log(`[devto] WARNING: received 403 Forbidden`);
      return null;
    }
    throw err;
  }
}

// ─── tag generation ─────────────────────────────────────────────────────────

/**
 * Generate domain-relevant Dev.to tags from a user-provided domain string.
 * Dev.to tags are lowercase, no spaces, max 30 chars.
 */
function generateTags(domain) {
  const d = domain.toLowerCase().trim();

  // Base tags: split the domain into words and use as individual tags
  const words = d.split(/\s+/).filter(w => w.length > 1);
  const baseTags = words.map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);

  // Combined tag (e.g., "project management" -> "projectmanagement")
  const combined = d.replace(/[^a-z0-9]/g, '');

  // Common Dev.to tags that tend to surface pain points
  const genericTags = [
    'discuss', 'help', 'beginners', 'tutorial',
    'webdev', 'devtools', 'productivity', 'startup',
    'saas', 'opensource', 'tooling', 'programming',
  ];

  // Domain-specific tag mappings
  const domainTagMap = {
    'project management': ['projectmanagement', 'productivity', 'agile', 'scrum', 'kanban', 'tools'],
    'kubernetes': ['kubernetes', 'k8s', 'devops', 'docker', 'containers', 'cloudnative'],
    'react': ['react', 'javascript', 'frontend', 'webdev', 'nextjs', 'typescript'],
    'python': ['python', 'django', 'flask', 'datascience', 'machinelearning'],
    'devops': ['devops', 'cicd', 'docker', 'kubernetes', 'infrastructure', 'sre'],
    'ai': ['ai', 'machinelearning', 'deeplearning', 'nlp', 'gpt', 'llm'],
    'database': ['database', 'sql', 'postgres', 'mongodb', 'redis', 'orm'],
    'security': ['security', 'cybersecurity', 'infosec', 'authentication', 'encryption'],
    'mobile': ['mobile', 'android', 'ios', 'reactnative', 'flutter', 'swift'],
    'cloud': ['cloud', 'aws', 'azure', 'gcp', 'serverless', 'infrastructure'],
  };

  // Collect tags from domain-specific mappings
  const matchedTags = [];
  for (const [key, tags] of Object.entries(domainTagMap)) {
    if (d.includes(key)) {
      matchedTags.push(...tags);
    }
  }

  // Deduplicate and combine
  const allTags = new Set([
    ...baseTags,
    combined,
    ...matchedTags,
    ...genericTags.slice(0, 4), // Only include a few generic tags
  ]);

  // Remove empty strings and return
  return [...allTags].filter(t => t.length > 0 && t.length <= 30);
}

// ─── normalizers ────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from Dev.to body text.
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

function normalizePost(article) {
  const body = article.body_markdown || article.description || '';
  const createdAt = article.published_at || article.created_at || '';
  const createdUtc = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : 0;

  return {
    id: String(article.id),
    title: article.title || '',
    selftext: stripHtml(body),
    subreddit: 'devto',
    url: article.url || article.canonical_url || `https://dev.to/${article.user?.username}/${article.slug}`,
    score: (article.positive_reactions_count || 0) + (article.comments_count || 0),
    num_comments: article.comments_count || 0,
    upvote_ratio: 0,
    flair: (article.tag_list || article.tags || []).slice(0, 3).join(','),
    created_utc: createdUtc,
    source: 'devto',
  };
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Search Dev.to articles by tag with pagination.
 */
async function searchByTag(tag, { page = 1, perPage = 30 } = {}) {
  const params = new URLSearchParams({
    tag,
    per_page: String(perPage),
    page: String(page),
  });
  const path = `${API_BASE}/articles?${params.toString()}`;
  const data = await devtoGet(path);
  return data || [];
}

/**
 * Search Dev.to articles by general query.
 */
async function searchArticles(query, { page = 1, perPage = 30 } = {}) {
  const params = new URLSearchParams({
    per_page: String(perPage),
    page: String(page),
  });
  // Dev.to supports search via the /articles endpoint with a query
  // The articles/search endpoint is not officially documented, use tag-based approach
  const path = `${API_BASE}/articles?${params.toString()}`;
  const data = await devtoGet(path);
  return data || [];
}

// ─── scan command ───────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 100;
  const maxPages = args.maxPages || 3;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  totalRequests = 0;

  log(`[devto] scan domain="${domain}", limit=${limit}, maxPages=${maxPages}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('devto');
  if (remaining.pct >= 80) {
    log(`[devto] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[devto] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'devto', posts: [], stats: { error: 'daily limit reached' } });
  }

  const tags = generateTags(domain);
  log(`[devto] searching ${tags.length} tags: ${tags.join(', ')}`);

  const articlesById = new Map();
  let stoppedEarly = false;

  for (const tag of tags) {
    if (stoppedEarly) break;

    for (let page = 1; page <= maxPages; page++) {
      let articles;
      try {
        articles = await searchByTag(tag, { page, perPage: 30 });
      } catch (err) {
        log(`[devto] tag "${tag}" page ${page} failed: ${err.message}`);
        if (err.statusCode === 429) {
          log(`[devto] rate limited, returning partial results`);
          await sleep(30000);
          stoppedEarly = true;
        }
        break;
      }

      if (!articles || !Array.isArray(articles) || articles.length === 0) break;

      log(`[devto] tag="${tag}" page=${page}: ${articles.length} articles`);

      for (const article of articles) {
        if (!articlesById.has(article.id)) {
          articlesById.set(article.id, article);
        }
      }

      // Stop early if fewer results than expected (last page)
      if (articles.length < 30) break;
    }
  }

  log(`[devto] ${articlesById.size} unique articles found`);

  // Save raw articles before filtering
  try {
    const allRawPosts = [...articlesById.values()].map(a => normalizePost(a));
    const rawOutput = { ok: true, data: { source: 'devto', posts: allRawPosts, stats: { raw: true, total: allRawPosts.length } } };
    writeFileSync('/tmp/gapscout-devto-raw.json', JSON.stringify(rawOutput));
    log(`[devto] saved ${allRawPosts.length} raw posts to /tmp/gapscout-devto-raw.json`);
  } catch (err) {
    log(`[devto] failed to save raw posts: ${err.message}`);
  }

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const article of articlesById.values()) {
    const post = normalizePost(article);

    // Basic relevance check
    const fullText = ((post.title || '') + ' ' + (post.selftext || '') + ' ' + (post.flair || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'devto';
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'devto',
    posts: scored.slice(0, limit),
    stats: {
      tags_searched: tags.length,
      raw_articles: articlesById.size,
      after_filter: Math.min(scored.length, limit),
      totalRequests,
      rateLimitWarnings,
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'devto',
  description: 'Dev.to (Forem) — public API, no browser needed',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
devto source — Dev.to (Forem) API

Commands:
  scan       Search Dev.to articles for pain-point posts related to a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max posts to return (default: 100)
  --max-pages <n>       Max pages per tag (default: 3)

Rate limits:
  - No auth required for reading
  - 30 requests per 30 seconds (unauthenticated)

Examples:
  node scripts/cli.mjs devto scan --domain "project management" --limit 100
  node scripts/cli.mjs dev scan --domain "kubernetes" --limit 50
`,
};
