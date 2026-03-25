/**
 * mastodon.mjs — Mastodon source for gapscout
 *
 * Strategy:
 *   Queries public hashtag timelines across multiple Mastodon instances
 *   using the Mastodon REST API. No authentication required for public
 *   hashtag timelines. Rate limit: ~300 req/5 min per instance.
 *
 * Exports { name: 'mastodon', commands: ['scan'], run, help }
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15000;
const RATE_LIMIT_DELAY_MS = 1000;
const JITTER_MS = 500;
const POSTS_PER_PAGE = 40;

// Major public Mastodon instances (no auth required for public hashtag timelines)
const INSTANCES = [
  'mastodon.social',
  'hachyderm.io',
  'fosstodon.org',
  'mastodon.online',
];

// Domain-to-hashtag mapping helpers
const DOMAIN_HASHTAG_MAP = {
  'project management': ['projectmanagement', 'saas', 'productivity', 'devtools'],
  'kubernetes': ['kubernetes', 'k8s', 'devops', 'containers', 'cloudnative'],
  'machine learning': ['machinelearning', 'ml', 'ai', 'deeplearning', 'datascience'],
  'web development': ['webdev', 'webdevelopment', 'frontend', 'backend', 'javascript'],
  'cloud computing': ['cloud', 'aws', 'azure', 'gcp', 'cloudcomputing'],
  'cybersecurity': ['cybersecurity', 'infosec', 'security', 'hacking', 'privacy'],
  'data science': ['datascience', 'data', 'analytics', 'machinelearning', 'python'],
  'devops': ['devops', 'cicd', 'docker', 'kubernetes', 'infrastructure'],
  'mobile development': ['mobiledev', 'ios', 'android', 'flutter', 'reactnative'],
  'open source': ['opensource', 'foss', 'linux', 'freesoftware', 'oss'],
};

// Pain-revealing keywords to boost relevance
const PAIN_KEYWORDS = [
  'frustrated', 'hate', 'terrible', 'broken', 'unusable', 'nightmare',
  'alternative', 'switched', 'wish there was', 'overpriced', 'expensive',
  'not worth', 'giving up', 'worst', 'garbage', 'awful', 'bug', 'crash',
  'annoying', 'disappointed', 'fix', 'please add', 'missing',
];

// ─── helpers ─────────────────────────────────────────────────────────────────

async function politeDelay() {
  const jitter = Math.floor(Math.random() * JITTER_MS);
  await sleep(RATE_LIMIT_DELAY_MS + jitter);
}

/**
 * Convert a domain string into relevant hashtags for Mastodon search.
 */
function domainToHashtags(domain) {
  const lower = domain.toLowerCase().trim();

  // Check direct mapping first
  for (const [key, tags] of Object.entries(DOMAIN_HASHTAG_MAP)) {
    if (lower.includes(key) || key.includes(lower)) {
      return tags;
    }
  }

  // Generate hashtags from the domain string itself
  const tags = new Set();

  // Add the domain as a single hashtag (spaces removed)
  const collapsed = lower.replace(/[^a-z0-9]/g, '');
  if (collapsed.length > 0) tags.add(collapsed);

  // Add individual words as hashtags (skip very short words)
  const words = lower.split(/\s+/).filter(w => w.length > 2);
  for (const word of words) {
    const clean = word.replace(/[^a-z0-9]/g, '');
    if (clean.length > 2) tags.add(clean);
  }

  // Add common related tags
  if (lower.includes('saas') || lower.includes('software')) {
    tags.add('saas');
    tags.add('software');
  }
  if (lower.includes('dev') || lower.includes('code') || lower.includes('programming')) {
    tags.add('devtools');
    tags.add('programming');
  }

  return [...tags].slice(0, 6);
}

/**
 * Strip HTML tags from Mastodon post content.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch JSON from a Mastodon API endpoint via HTTPS.
 * Returns { data, headers } on success.
 */
function fetchJson(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname,
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; gapscout/3.0)',
        'Accept': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      // Follow redirects (one level)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const redirectUrl = new URL(res.headers.location);
          fetchJson(redirectUrl.hostname, redirectUrl.pathname + redirectUrl.search)
            .then(resolve).catch(reject);
        } catch {
          reject(new Error(`bad redirect: ${res.headers.location}`));
        }
        return;
      }

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve({ data: JSON.parse(body), headers: res.headers });
          } catch (err) {
            reject(new Error(`JSON parse error: ${err.message}`));
          }
        } else if (res.statusCode === 429) {
          reject(new Error('rate-limited'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * Parse the Link header to extract max_id for pagination.
 * Mastodon returns: Link: <...?max_id=12345>; rel="next"
 */
function parseMaxIdFromLinkHeader(headers) {
  const link = headers?.link || '';
  const nextMatch = link.match(/<[^>]*[?&]max_id=(\d+)[^>]*>;\s*rel="next"/);
  return nextMatch ? nextMatch[1] : null;
}

/**
 * Convert a Mastodon status (post) to the standard gapscout post format.
 */
function statusToPost(status) {
  const plainText = stripHtml(status.content || '');
  const score = (status.favourites_count || 0) + (status.reblogs_count || 0);

  let createdUtc = 0;
  if (status.created_at) {
    const d = new Date(status.created_at);
    if (!isNaN(d.getTime())) createdUtc = Math.floor(d.getTime() / 1000);
  }

  return {
    id: status.id || `mastodon_${Date.now()}`,
    title: excerpt(plainText, 100),
    selftext: plainText.substring(0, 2000),
    subreddit: 'mastodon',
    url: status.url || status.uri || '',
    score: Math.max(score, 1),
    num_comments: status.replies_count || 0,
    upvote_ratio: 0,
    created_utc: createdUtc,
    flair: '',
    source: 'mastodon',
  };
}

// ─── Mastodon API ────────────────────────────────────────────────────────────

/**
 * Fetch hashtag timeline from a Mastodon instance.
 * Returns { posts, nextMaxId }.
 */
async function fetchHashtagTimeline(instance, hashtag, maxId = null, limit = POSTS_PER_PAGE) {
  let path = `/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?limit=${limit}`;
  if (maxId) path += `&max_id=${maxId}`;

  const { data, headers } = await fetchJson(instance, path);

  if (!Array.isArray(data)) {
    return { posts: [], nextMaxId: null };
  }

  const posts = data.map(statusToPost);
  const nextMaxId = parseMaxIdFromLinkHeader(headers)
    || (data.length > 0 ? data[data.length - 1].id : null);

  return { posts, nextMaxId: data.length < limit ? null : nextMaxId };
}

/**
 * Probe a Mastodon instance to check if it's reachable.
 */
async function probeInstance(instance) {
  try {
    await fetchJson(instance, '/api/v1/instance');
    return true;
  } catch {
    return false;
  }
}

// ─── scan command ─────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain || '';
  if (!domain) fail('--domain is required (e.g. --domain "kubernetes")');

  const limit = args.limit || 200;
  const maxPagesPerHashtag = args.pages || 5;
  const instanceList = args.instances
    ? args.instances.split(',').map(s => s.trim()).filter(Boolean)
    : [...INSTANCES];

  log(`[mastodon] scan domain="${domain}" limit=${limit} pages=${maxPagesPerHashtag}`);

  // Convert domain to hashtags
  const hashtags = domainToHashtags(domain);
  log(`[mastodon] hashtags: ${hashtags.map(h => '#' + h).join(', ')}`);

  if (hashtags.length === 0) {
    fail('Could not generate hashtags from the provided domain');
  }

  // Probe instances to find working ones
  log(`[mastodon] probing ${instanceList.length} instances...`);
  const workingInstances = [];
  const probeResults = await Promise.allSettled(
    instanceList.map(async (inst) => {
      const works = await probeInstance(inst);
      return { instance: inst, works };
    })
  );
  for (const result of probeResults) {
    if (result.status === 'fulfilled' && result.value.works) {
      workingInstances.push(result.value.instance);
      log(`[mastodon]   ${result.value.instance} OK`);
    } else if (result.status === 'fulfilled') {
      log(`[mastodon]   ${result.value.instance} UNREACHABLE`);
    }
  }

  if (workingInstances.length === 0) {
    ok({
      mode: 'mastodon',
      source: 'mastodon',
      posts: [],
      stats: {
        domain,
        hashtags,
        instances_probed: instanceList.length,
        instances_working: 0,
        raw_posts: 0,
        after_scoring: 0,
        returned: 0,
        error: 'No reachable Mastodon instances found',
      },
    });
    return;
  }

  log(`[mastodon] ${workingInstances.length} working instances`);

  // Collect posts: query each hashtag across all working instances in parallel
  const postsById = new Map();
  const postsByUrl = new Set(); // For deduplication across federated instances
  let rateLimitWarnings = 0;

  for (const hashtag of hashtags) {
    log(`[mastodon] querying #${hashtag} across ${workingInstances.length} instances`);

    // Fetch from all instances in parallel for this hashtag
    const instanceResults = await Promise.allSettled(
      workingInstances.map(async (instance) => {
        const instancePosts = [];
        let maxId = null;
        let pageCount = 0;

        while (pageCount < maxPagesPerHashtag) {
          try {
            const { posts, nextMaxId } = await fetchHashtagTimeline(instance, hashtag, maxId);
            pageCount++;
            instancePosts.push(...posts);
            log(`[mastodon]   ${instance} #${hashtag} page ${pageCount}: ${posts.length} posts`);

            if (!nextMaxId || posts.length === 0) break;
            maxId = nextMaxId;
            await politeDelay();
          } catch (err) {
            if (err.message === 'rate-limited') {
              rateLimitWarnings++;
              log(`[mastodon]   ${instance} rate-limited on #${hashtag}, backing off`);
              await sleep(5000);
            } else {
              log(`[mastodon]   ${instance} #${hashtag} page ${pageCount + 1} error: ${err.message}`);
            }
            break;
          }
        }

        return instancePosts;
      })
    );

    // Merge results, deduplicating by URL (federated posts share the same URL)
    for (const result of instanceResults) {
      if (result.status === 'fulfilled') {
        for (const post of result.value) {
          const dedupeKey = post.url || post.id;
          if (!postsByUrl.has(dedupeKey)) {
            postsByUrl.add(dedupeKey);
            postsById.set(post.id, post);
          }
        }
      }
    }

    log(`[mastodon] #${hashtag} done, ${postsById.size} unique posts so far`);

    if (postsById.size >= limit * 3) {
      log(`[mastodon] collected enough posts, stopping early`);
      break;
    }
  }

  log(`[mastodon] collected ${postsById.size} unique posts total`);

  // Save raw posts
  const postsRaw = [...postsById.values()];
  try {
    const rawOutput = {
      ok: true,
      data: { source: 'mastodon', posts: postsRaw, stats: { raw: true, total: postsRaw.length } },
    };
    writeFileSync('/tmp/gapscout-mastodon-raw.json', JSON.stringify(rawOutput));
    log(`[mastodon] saved ${postsRaw.length} raw posts to /tmp/gapscout-mastodon-raw.json`);
  } catch (err) {
    log(`[mastodon] failed to save raw posts: ${err.message}`);
  }

  // Score and filter
  const scored = [];
  for (const post of postsRaw) {
    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    mode: 'mastodon',
    source: 'mastodon',
    posts: scored.slice(0, limit),
    stats: {
      domain,
      hashtags,
      instances_probed: instanceList.length,
      instances_working: workingInstances.length,
      raw_posts: postsById.size,
      after_scoring: scored.length,
      returned: Math.min(scored.length, limit),
      rateLimitWarnings,
    },
  });
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'mastodon',
  description: 'Mastodon — scrapes public hashtag timelines across multiple instances',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
mastodon source — Mastodon public hashtag timeline scraping for pain points

Strategy:
  Queries the public Mastodon REST API across multiple instances
  (mastodon.social, hachyderm.io, fosstodon.org, mastodon.online).
  No authentication required for public hashtag timelines.
  Rate limit: ~300 req/5 min per instance.

  Converts the --domain query into relevant hashtags, then fetches
  posts from the hashtag timeline on each instance in parallel.
  Deduplicates federated posts that appear on multiple instances.

Commands:
  scan        Search Mastodon for posts about a domain via hashtag timelines

scan options:
  --domain <str>        Topic/product to search for (required)
  --limit <n>           Max posts to return (default: 200)
  --pages <n>           Pages per hashtag per instance (default: 5)
  --instances <csv>     Comma-separated instance hostnames to query

Examples:
  gapscout mastodon scan --domain "kubernetes" --limit 200
  gapscout mastodon scan --domain "project management" --limit 100
  gapscout masto scan --domain "open source" --pages 3
  gapscout mastodon scan --domain "SaaS" --instances "mastodon.social,fosstodon.org"
`,
};
