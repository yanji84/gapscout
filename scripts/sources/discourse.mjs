/**
 * discourse.mjs — Discourse Forums source for gapscout
 *
 * Uses the standard Discourse REST API to search topics across any Discourse instance.
 * One implementation pattern unlocks hundreds of company/community forums.
 *
 * No auth required for public categories. Rate limit: ~60 req/min per instance.
 *
 * Usage:
 *   gapscout discourse scan --domain "CDN" --instances "community.cloudflare.com,community.fastly.com"
 *   gapscout discourse scan --domain "home automation" --limit 100
 */

import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGetWithRetry } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const MIN_DELAY_MS = 1000; // ~60 req/min per instance, stay well under
const RAW_OUTPUT_PATH = '/tmp/gapscout-discourse-raw.json';

// Well-known Discourse instances by broad domain category for auto-discovery
const KNOWN_INSTANCES = {
  cdn: ['community.cloudflare.com', 'community.fastly.com'],
  hosting: ['community.render.com', 'community.fly.io'],
  'home automation': ['community.home-assistant.io'],
  notes: ['forum.obsidian.md'],
  discourse: ['meta.discourse.org'],
  devops: ['community.fly.io', 'community.render.com', 'community.cloudflare.com'],
  security: ['community.cloudflare.com', 'community.bitwarden.com'],
  containers: ['forums.docker.com', 'community.fly.io'],
};

// Track rate limit warnings across a scan
let rateLimitWarnings = 0;
let totalRequests = 0;

// ─── rate limiter ────────────────────────────────────────────────────────────

const lastRequestByInstance = new Map();

async function rateLimit(instance) {
  const lastAt = lastRequestByInstance.get(instance) || 0;
  const elapsed = Date.now() - lastAt;
  if (elapsed < MIN_DELAY_MS) {
    await sleep(MIN_DELAY_MS - elapsed);
  }
  lastRequestByInstance.set(instance, Date.now());
  totalRequests++;
  if (totalRequests > 0 && totalRequests % 50 === 0) {
    log(`[discourse] INFO: ${totalRequests} requests made this session`);
  }
}

// ─── Discourse API helpers ──────────────────────────────────────────────────

/**
 * Fetch JSON from a Discourse instance with retry and rate limiting.
 */
async function discourseGet(instance, path) {
  await rateLimit(instance);
  getUsageTracker().increment('discourse');
  log(`[discourse] GET https://${instance}${path}`);

  try {
    return await httpGetWithRetry(instance, path, { maxRetries: 3 });
  } catch (err) {
    const code = err.statusCode || 0;
    if (code === 429) {
      rateLimitWarnings++;
      log(`[discourse] WARNING: rate limit hit on ${instance} — backing off 10s`);
      await sleep(10000);
      return null;
    }
    if (code === 403) {
      rateLimitWarnings++;
      log(`[discourse] WARNING: 403 Forbidden on ${instance} — instance may require auth`);
      return null;
    }
    if (code === 404) {
      log(`[discourse] 404 on ${instance}${path} — skipping`);
      return null;
    }
    throw err;
  }
}

/**
 * Search a Discourse instance for topics matching a query.
 */
async function searchInstance(instance, query) {
  const params = new URLSearchParams({ q: query });
  const path = `/search.json?${params.toString()}`;
  const data = await discourseGet(instance, path);
  if (!data) return [];
  return data.topics || [];
}

/**
 * Fetch topic detail (including first post body) from a Discourse instance.
 */
async function fetchTopicDetail(instance, topicId) {
  const path = `/t/${topicId}.json`;
  const data = await discourseGet(instance, path);
  return data || null;
}

/**
 * Fetch latest topics from a Discourse instance.
 */
async function fetchLatestTopics(instance) {
  const path = '/latest.json';
  const data = await discourseGet(instance, path);
  if (!data) return [];
  return data.topic_list?.topics || [];
}

// ─── normalizers ─────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from Discourse post content.
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

/**
 * Normalize a Discourse topic into the standard gapscout post format.
 */
function normalizePost(topic, instance, firstPostBody) {
  const createdAt = topic.created_at ? new Date(topic.created_at).getTime() / 1000 | 0 : 0;
  return {
    id: `discourse-${instance}-${topic.id}`,
    title: topic.title || '',
    selftext: stripHtml(firstPostBody || topic.excerpt || ''),
    subreddit: `discourse:${instance}`,
    url: `https://${instance}/t/${topic.slug || topic.id}/${topic.id}`,
    score: (topic.like_count || 0) + (topic.reply_count || topic.posts_count || 0),
    num_comments: topic.reply_count || topic.posts_count || 0,
    upvote_ratio: 0,
    flair: topic.category_id ? `cat:${topic.category_id}` : '',
    created_utc: createdAt,
    source: 'discourse',
    meta: {
      instance,
      like_count: topic.like_count || 0,
      reply_count: topic.reply_count || topic.posts_count || 0,
      views: topic.views || 0,
    },
  };
}

// ─── query generation ────────────────────────────────────────────────────────

function buildSearchQueries(domain) {
  return [
    `${domain}`,
    `${domain} problem`,
    `${domain} issue`,
    `${domain} error`,
    `${domain} not working`,
    `${domain} bug`,
    `${domain} broken`,
    `${domain} alternative`,
    `${domain} frustrated`,
    `${domain} workaround`,
    `${domain} fix`,
    `${domain} slow`,
    `${domain} migration`,
    `${domain} replacement`,
  ];
}

// ─── instance discovery ─────────────────────────────────────────────────────

/**
 * Try to discover relevant Discourse instances for a given domain.
 * Uses known instances mapping and domain keywords.
 */
function discoverInstances(domain) {
  const domainLower = domain.toLowerCase();
  const discovered = new Set();

  for (const [keyword, instances] of Object.entries(KNOWN_INSTANCES)) {
    if (domainLower.includes(keyword) || keyword.includes(domainLower)) {
      for (const inst of instances) {
        discovered.add(inst);
      }
    }
  }

  // Always include meta.discourse.org as a fallback for general searches
  if (discovered.size === 0) {
    discovered.add('meta.discourse.org');
    log(`[discourse] no known instances for domain "${domain}" — using meta.discourse.org as fallback`);
    log(`[discourse] tip: use --instances to specify Discourse forums relevant to your domain`);
  }

  return [...discovered];
}

// ─── scan command ───────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 50;

  // Reset per-scan counters
  rateLimitWarnings = 0;
  totalRequests = 0;

  // Parse instances
  let instances;
  if (args.instances) {
    instances = args.instances.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    instances = discoverInstances(domain);
  }

  log(`[discourse] scan domain="${domain}", limit=${limit}, instances=${instances.join(', ')}`);

  // Check daily usage budget
  const usage = getUsageTracker();
  const remaining = usage.getRemaining('discourse');
  if (remaining.pct >= 80) {
    log(`[discourse] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
  }
  if (remaining.remaining <= 0) {
    log(`[discourse] ERROR: daily budget exhausted. Try again tomorrow.`);
    return ok({ source: 'discourse', posts: [], stats: { error: 'daily limit reached' } });
  }

  const queries = buildSearchQueries(domain);
  const topicsById = new Map();

  // Search each instance with each query
  for (const instance of instances) {
    log(`[discourse] searching instance: ${instance}`);

    for (const query of queries) {
      let topics;
      try {
        topics = await searchInstance(instance, query);
      } catch (err) {
        log(`[discourse] query "${query}" on ${instance} failed: ${err.message}`);
        continue;
      }

      if (!topics || !topics.length) continue;

      log(`[discourse] ${instance} query="${query}": ${topics.length} topics`);

      for (const topic of topics) {
        const key = `${instance}-${topic.id}`;
        if (!topicsById.has(key)) {
          topicsById.set(key, { topic, instance });
        }
      }
    }

    // Also fetch latest topics to catch recent discussions
    try {
      const latestTopics = await fetchLatestTopics(instance);
      log(`[discourse] ${instance} latest: ${latestTopics.length} topics`);
      for (const topic of latestTopics) {
        const key = `${instance}-${topic.id}`;
        if (!topicsById.has(key)) {
          topicsById.set(key, { topic, instance });
        }
      }
    } catch (err) {
      log(`[discourse] latest topics on ${instance} failed: ${err.message}`);
    }
  }

  log(`[discourse] ${topicsById.size} unique topics found across ${instances.length} instance(s)`);

  // Fetch first post body for top topics (by engagement) to improve scoring
  const sortedEntries = [...topicsById.values()]
    .sort((a, b) => {
      const scoreA = (a.topic.like_count || 0) + (a.topic.reply_count || 0);
      const scoreB = (b.topic.like_count || 0) + (b.topic.reply_count || 0);
      return scoreB - scoreA;
    });

  // Fetch details for top topics (limit detail fetches to conserve rate limit)
  const maxDetailFetches = Math.min(sortedEntries.length, 50);
  const detailMap = new Map(); // key -> first post body

  for (let i = 0; i < maxDetailFetches; i++) {
    const { topic, instance } = sortedEntries[i];
    const key = `${instance}-${topic.id}`;
    try {
      const detail = await fetchTopicDetail(instance, topic.id);
      if (detail?.post_stream?.posts?.[0]?.cooked) {
        detailMap.set(key, detail.post_stream.posts[0].cooked);
      }
    } catch (err) {
      log(`[discourse] detail fetch for topic ${topic.id} on ${instance} failed: ${err.message}`);
    }
  }

  // Save raw topics before filtering
  try {
    const allRawPosts = sortedEntries.map(({ topic, instance }) => {
      const key = `${instance}-${topic.id}`;
      return normalizePost(topic, instance, detailMap.get(key) || '');
    });
    const rawOutput = {
      ok: true,
      data: { source: 'discourse', posts: allRawPosts, stats: { raw: true, total: allRawPosts.length } },
    };
    writeFileSync(RAW_OUTPUT_PATH, JSON.stringify(rawOutput));
    log(`[discourse] saved ${allRawPosts.length} raw posts to ${RAW_OUTPUT_PATH}`);
  } catch (err) {
    log(`[discourse] failed to save raw posts: ${err.message}`);
  }

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const { topic, instance } of sortedEntries) {
    const key = `${instance}-${topic.id}`;
    const post = normalizePost(topic, instance, detailMap.get(key) || '');

    // Basic relevance check
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'discourse';
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'discourse',
    posts: scored.slice(0, limit),
    stats: {
      instances_searched: instances.length,
      queries_run: queries.length * instances.length,
      raw_topics: topicsById.size,
      detail_fetches: detailMap.size,
      after_filter: Math.min(scored.length, limit),
      totalRequests,
      rateLimitWarnings,
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'discourse',
  description: 'Discourse Forums — standard REST API, covers hundreds of community forums',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
discourse source — Standard Discourse REST API

One implementation unlocks hundreds of company/community forums. No auth
required for public categories. Rate limit: ~60 req/min per instance.

Commands:
  scan       Search Discourse forums for pain-revealing topics about a domain

scan options:
  --domain <str>        Topic/technology to search for (required)
  --instances <csv>     Comma-separated list of Discourse instances
                        e.g. "community.cloudflare.com,forum.obsidian.md"
                        If omitted, auto-discovers instances from domain keywords
  --limit <n>           Max posts to return (default: 50)

Common Discourse instances:
  community.cloudflare.com     community.render.com
  forum.obsidian.md            community.fly.io
  meta.discourse.org           community.home-assistant.io
  community.bitwarden.com      forums.docker.com

Examples:
  gapscout discourse scan --domain "CDN" --instances "community.cloudflare.com,community.fastly.com"
  gapscout discourse scan --domain "home automation" --limit 100
  gapscout discourse scan --domain "notes" --instances "forum.obsidian.md"
`,
};
