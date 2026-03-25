/**
 * producthunt.mjs — Product Hunt source for gapscout
 *
 * Primary path: Product Hunt GraphQL API v2 (requires PRODUCTHUNT_TOKEN or --token).
 * Fallback path: Puppeteer-based scraping (when no token is available).
 *
 * API rate limit: 450 requests per 15 minutes.
 * Endpoint: https://api.producthunt.com/v2/api/graphql
 */

import https from 'node:https';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { RateLimiter } from '../lib/http.mjs';
import { createBlockTracker, enableResourceBlocking } from '../lib/browser.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { getGlobalRateMonitor } from '../lib/rate-monitor.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const PH_BASE = 'https://www.producthunt.com';
const PH_API_HOST = 'api.producthunt.com';
const PH_API_PATH = '/v2/api/graphql';
const PAGE_DELAY_MS = 1500;

// Rate limiter: 450 req / 15 min = 30 req / min
const apiLimiter = new RateLimiter({
  minDelayMs: 2100,   // ~28 req/min to stay well under 30/min
  jitterMs: 300,
  maxPerMin: 28,
});

// Well-known PH category slugs (used by both API and fallback)
const DOMAIN_TO_TOPIC = {
  'project management': 'project-management',
  'task management': 'task-management',
  'productivity': 'productivity',
  'email': 'email',
  'crm': 'crm',
  'analytics': 'analytics',
  'marketing': 'marketing',
  'design': 'design-tools',
  'developer tools': 'developer-tools',
  'ai': 'artificial-intelligence',
  'chatbot': 'chatbots',
  'writing': 'writing',
  'sales': 'sales',
  'customer support': 'customer-support',
  'finance': 'fintech',
  'hr': 'human-resources',
  'note taking': 'note-taking',
};

// ─── pain signal patterns ────────────────────────────────────────────────────

const PAIN_PATTERNS = [
  /i wish (this|it) (did|had|could|would)/i,
  /missing feature/i,
  /doesn'?t work for/i,
  /switched from/i,
  /please add/i,
  /feature request/i,
  /wish (you|they) (would|could|had)/i,
  /not worth/i,
  /deal.?breaker/i,
  /can'?t figure out/i,
  /frustrat/i,
  /annoying/i,
  /too expensive/i,
  /overpriced/i,
  /terrible/i,
  /unusable/i,
  /hate (it|this|that)/i,
  /alternatives?/i,
  /compared to/i,
  /instead i (use|went|tried)/i,
  /stopped using/i,
  /still missing/i,
  /would be better if/i,
  /not great/i,
  /disappointed/i,
  /lacking/i,
  /needs improvement/i,
  /room for improvement/i,
  /could be better/i,
  /limitation/i,
  /bug|crash|broken/i,
  /slow|laggy/i,
  /confus/i,
  /hard to (use|understand|navigate)/i,
];

function hasPainSignal(text) {
  return PAIN_PATTERNS.some(p => p.test(text));
}

// ─── GraphQL API helpers ─────────────────────────────────────────────────────

/**
 * Execute a GraphQL query against the PH v2 API.
 * @param {string} token - Bearer token
 * @param {string} query - GraphQL query string
 * @param {object} variables - GraphQL variables
 * @returns {Promise<object>} Parsed response data
 */
function graphqlRequest(token, query, variables = {}) {
  const body = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: PH_API_HOST,
      path: PH_API_PATH,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'gapscout/4.0',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errors && parsed.errors.length > 0) {
              reject(new Error(`GraphQL error: ${parsed.errors[0].message}`));
            } else {
              resolve(parsed.data);
            }
          } catch {
            reject(new Error(`Non-JSON response: ${data.slice(0, 200)}`));
          }
        } else if (res.statusCode === 429) {
          getGlobalRateMonitor().reportError('producthunt', 'PH GraphQL API 429 — rate limited', { statusCode: 429 });
          reject(Object.assign(new Error('Rate limited (429)'), { statusCode: 429 }));
        } else {
          reject(Object.assign(
            new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`),
            { statusCode: res.statusCode }
          ));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Execute a GraphQL query with rate limiting and retry.
 */
async function gql(token, query, variables = {}, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await apiLimiter.wait();
      return await graphqlRequest(token, query, variables);
    } catch (err) {
      lastErr = err;
      if (err.statusCode === 403 || err.statusCode === 401) {
        getGlobalRateMonitor().reportBlock('producthunt', `PH API ${err.statusCode} — ${err.statusCode === 401 ? 'unauthorized' : 'forbidden'}`, { statusCode: err.statusCode });
        throw err;
      }
      if (attempt < maxRetries) {
        const backoff = 2000 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * backoff * 0.5);
        const delay = backoff + jitter;
        log(`[ph-api] ${err.message} — retry ${attempt + 1} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ─── GraphQL queries ─────────────────────────────────────────────────────────

const SEARCH_TOPICS_QUERY = `
query SearchTopics($query: String!, $first: Int!, $after: String) {
  topics(query: $query, first: $first, after: $after) {
    edges {
      node {
        id
        slug
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const POSTS_BY_TOPIC_QUERY = `
query PostsByTopic($topicSlug: String!, $first: Int!, $after: String) {
  posts(order: VOTES, topic: $topicSlug, first: $first, after: $after) {
    edges {
      node {
        id
        slug
        name
        tagline
        description
        votesCount
        commentsCount
        reviewsCount
        reviewsRating
        url
        website
        createdAt
        topics {
          edges {
            node {
              slug
              name
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const POST_COMMENTS_QUERY = `
query PostComments($slug: String!, $first: Int!, $after: String) {
  post(slug: $slug) {
    id
    name
    tagline
    description
    votesCount
    commentsCount
    reviewsCount
    reviewsRating
    url
    createdAt
    comments(first: $first, after: $after) {
      edges {
        node {
          id
          body
          votesCount
          createdAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

// ─── API-based scan ──────────────────────────────────────────────────────────

/**
 * Search for posts via the PH GraphQL API.
 * Returns array of post node objects.
 */
async function apiSearchTopics(token, query, limit = 10) {
  const allTopics = [];
  let cursor = null;
  const perPage = Math.min(limit, 20);

  while (allTopics.length < limit) {
    const variables = { query, first: perPage };
    if (cursor) variables.after = cursor;

    log(`[ph-api] searching topics: query="${query}", first=${perPage}, after=${cursor || 'null'}`);
    const data = await gql(token, SEARCH_TOPICS_QUERY, variables);

    const edges = data?.topics?.edges || [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      if (edge.node) allTopics.push(edge.node);
    }

    const pageInfo = data?.topics?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  log(`[ph-api] topic search returned ${allTopics.length} topics`);
  return allTopics.slice(0, limit);
}

async function apiSearchPosts(token, query, limit = 20) {
  // PH API v2 doesn't support search on posts — search topics first, then fetch posts
  const topics = await apiSearchTopics(token, query, 10);
  if (topics.length === 0) {
    log(`[ph-api] no topics found for "${query}"`);
    return [];
  }

  const allPosts = [];
  const seenSlugs = new Set();
  const postsPerTopic = Math.max(20, Math.ceil(limit / topics.length));

  for (const topic of topics) {
    if (allPosts.length >= limit) break;
    try {
      const posts = await apiGetPostsByTopic(token, topic.slug, postsPerTopic);
      for (const p of posts) {
        if (p.slug && !seenSlugs.has(p.slug)) {
          seenSlugs.add(p.slug);
          allPosts.push(p);
        }
      }
    } catch (err) {
      log(`[ph-api] failed to fetch posts for topic "${topic.slug}": ${err.message}`);
    }
  }

  log(`[ph-api] search via topics returned ${allPosts.length} posts`);
  return allPosts.slice(0, limit);
}

/**
 * Get posts by topic slug via the PH GraphQL API.
 */
async function apiGetPostsByTopic(token, topicSlug, limit = 20) {
  const allPosts = [];
  let cursor = null;
  const perPage = Math.min(limit, 20);

  while (allPosts.length < limit) {
    const variables = { topicSlug, first: perPage };
    if (cursor) variables.after = cursor;

    log(`[ph-api] fetching topic: slug="${topicSlug}", first=${perPage}, after=${cursor || 'null'}`);
    const data = await gql(token, POSTS_BY_TOPIC_QUERY, variables);

    const edges = data?.posts?.edges || [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      if (edge.node) allPosts.push(edge.node);
    }

    const pageInfo = data?.posts?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  log(`[ph-api] topic "${topicSlug}" returned ${allPosts.length} posts`);
  return allPosts.slice(0, limit);
}

/**
 * Get comments for a specific post by slug.
 */
async function apiGetPostComments(token, slug, maxComments = 80) {
  const allComments = [];
  let cursor = null;
  const perPage = 20;

  while (allComments.length < maxComments) {
    const variables = { slug, first: perPage };
    if (cursor) variables.after = cursor;

    log(`[ph-api] fetching comments: slug="${slug}", after=${cursor || 'null'}`);
    let data;
    try {
      data = await gql(token, POST_COMMENTS_QUERY, variables);
    } catch (err) {
      log(`[ph-api] comments fetch failed for "${slug}": ${err.message}`);
      break;
    }

    const post = data?.post;
    if (!post) break;

    const edges = post.comments?.edges || [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      if (edge.node) {
        allComments.push({
          body: (edge.node.body || '').substring(0, 500),
          score: edge.node.votesCount || 1,
          stars: 0,
        });
      }
    }

    const pageInfo = post.comments?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return allComments.slice(0, maxComments);
}

// ─── normalize to common post shape ──────────────────────────────────────────

function buildPost(productData, slug, productUrl) {
  const { name, tagline, description, upvotes, comments } = productData;

  const painComments = comments.filter(c => hasPainSignal(c.body));

  const allCommentTexts = comments.map(c => c.body).join('\n\n');
  const selftext = [description, allCommentTexts].filter(Boolean).join('\n\n---\n\n').substring(0, 6000);

  return {
    id: slug,
    title: name + (tagline ? ` — ${tagline}` : ''),
    selftext,
    subreddit: 'producthunt',
    url: productUrl,
    score: upvotes,
    num_comments: comments.length,
    upvote_ratio: 0,
    flair: '',
    created_utc: 0,
    _painComments: painComments,
    _allComments: comments,
  };
}

/**
 * Build a post from an API post node, including fetched comments.
 */
function buildPostFromApiNode(node, comments) {
  const createdUtc = node.createdAt
    ? Math.floor(new Date(node.createdAt).getTime() / 1000)
    : 0;

  const productUrl = node.url || `${PH_BASE}/posts/${node.slug}`;

  const painComments = comments.filter(c => hasPainSignal(c.body));
  const allCommentTexts = comments.map(c => c.body).join('\n\n');
  const selftext = [node.description || '', allCommentTexts]
    .filter(Boolean)
    .join('\n\n---\n\n')
    .substring(0, 6000);

  return {
    id: node.slug || node.id,
    title: node.name + (node.tagline ? ` — ${node.tagline}` : ''),
    body: selftext,
    selftext,
    subreddit: 'producthunt',
    url: productUrl,
    score: node.votesCount || 0,
    source: 'producthunt',
    created_utc: createdUtc,
    num_comments: node.commentsCount || comments.length,
    upvote_ratio: 0,
    flair: '',
    _painComments: painComments,
    _allComments: comments,
  };
}

// ─── API-based scan command ──────────────────────────────────────────────────

async function cmdScanApi(args, token) {
  const domain = args.domain;
  if (!domain) fail('--domain is required for producthunt scan');

  const limit = args.limit || 20;
  const maxComments = args.maxComments || 80;

  log(`[ph-api] scan domain="${domain}", limit=${limit}`);

  const postsBySlug = new Map();

  // Strategy 1: topic-based lookup
  const domainLower = domain.toLowerCase();
  const topicSlug = Object.entries(DOMAIN_TO_TOPIC).find(
    ([key]) => domainLower.includes(key) || key.includes(domainLower)
  )?.[1];

  if (topicSlug) {
    log(`[ph-api] using topic: ${topicSlug}`);
    try {
      const topicPosts = await apiGetPostsByTopic(token, topicSlug, limit);
      for (const p of topicPosts) {
        if (p.slug && !postsBySlug.has(p.slug)) postsBySlug.set(p.slug, p);
      }
    } catch (err) {
      log(`[ph-api] topic query failed: ${err.message}`);
    }
  }

  // Strategy 2: search topics by domain name (and individual words as fallback)
  if (postsBySlug.size < limit) {
    const queries = [domain];
    // Also try individual words if domain is multi-word
    const words = domain.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 1) queries.push(...words);
    for (const q of queries) {
      if (postsBySlug.size >= limit) break;
      try {
        const searchPosts = await apiSearchPosts(token, q, limit);
        for (const p of searchPosts) {
          if (p.slug && !postsBySlug.has(p.slug)) postsBySlug.set(p.slug, p);
        }
      } catch (err) {
        log(`[ph-api] search query "${q}" failed: ${err.message}`);
      }
    }
  }

  log(`[ph-api] ${postsBySlug.size} unique posts after discovery`);

  // Fetch comments for each post and score
  const scored = [];
  let count = 0;
  for (const node of postsBySlug.values()) {
    if (count >= limit + 5) break;
    try {
      const comments = await apiGetPostComments(token, node.slug, maxComments);
      const post = buildPostFromApiNode(node, comments);
      const enriched = enrichPost(post, domain);
      if (enriched) {
        enriched.ph_pain_comments = post._painComments.length;
        enriched.ph_total_comments = post._allComments.length;
        scored.push(enriched);
      }
    } catch (err) {
      log(`[ph-api] failed for ${node.slug}: ${err.message}`);
    }
    count++;
  }

  scored.sort((a, b) => b.painScore - a.painScore);
  ok({
    mode: 'producthunt',
    method: 'api',
    posts: scored.slice(0, limit),
    stats: {
      products_found: postsBySlug.size,
      products_scraped: count,
      after_filter: Math.min(scored.length, limit),
      api_requests: apiLimiter.count,
      rateMonitor: getGlobalRateMonitor().getSourceBreakdown().get('producthunt') || { warnings: 0, blocks: 0, errors: 0 },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK: Puppeteer-based scraping (used when no API token is available)
// ═══════════════════════════════════════════════════════════════════════════════

let _launchedBrowser = null;

async function politeDelay(ms = PAGE_DELAY_MS) {
  const { politeDelay: politeDelayBase } = await import('../lib/browser.mjs');
  await politeDelayBase(ms, 0);
}

async function connectBrowser(args) {
  const { connectBrowser: connectBrowserBase } = await import('../lib/browser.mjs');
  const browser = await connectBrowserBase(args, { logTag: 'ph', canLaunch: true });
  if (!args.wsUrl && !args.port) {
    _launchedBrowser = browser;
  }
  return browser;
}

async function preparePage(browser) {
  const page = await browser.newPage();
  await enableResourceBlocking(page);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  });
  return page;
}

async function navigateAndWait(page, url, waitMs = 2500) {
  log(`[ph-browser] navigate: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    log(`[ph-browser] navigation error: ${err.message}`);
    return false;
  }
  await sleep(waitMs + Math.floor(Math.random() * 500));
  const { detectBlockInPage } = await import('../lib/browser.mjs');
  const blockResult = await detectBlockInPage(page);
  if (blockResult.blocked) {
    log(`[ph-browser] block detected (${blockResult.reason}) — waiting 8s...`);
    await sleep(8000);
    const blockResult2 = await detectBlockInPage(page);
    if (blockResult2.blocked) {
      log(`[ph-browser] still blocked by ${blockResult2.reason}`);
      getGlobalRateMonitor().reportBlock('producthunt', `Browser blocked by ${blockResult2.reason}`, { reason: blockResult2.reason });
      return false;
    }
  }
  return true;
}

async function searchViaInputAndIntercept(page, query) {
  const results = [];
  const searchDataReceived = [];

  const interceptHandler = async (resp) => {
    const url = resp.url();
    if (!url.includes('graphql')) return;
    try {
      const text = await resp.text();
      const opMatch = url.match(/operationName=([^&]+)/);
      const op = opMatch ? decodeURIComponent(opMatch[1]) : '';
      if (op.toLowerCase().includes('search') || text.includes('"posts"') ||
          text.includes('"products"') || text.includes('"post"')) {
        searchDataReceived.push({ op, text });
      }
    } catch { /* ignore */ }
  };
  page.on('response', interceptHandler);

  const loaded = await navigateAndWait(page, PH_BASE + '/', 3000);
  if (!loaded) {
    page.off('response', interceptHandler);
    return results;
  }

  const searchSel = '[data-test="header-search-input"], input[name="q"], input[placeholder*="Search"]';
  const searchInput = await page.$(searchSel).catch(() => null);
  if (!searchInput) {
    log(`[ph-browser] search input not found`);
    page.off('response', interceptHandler);
    return results;
  }

  await searchInput.click();
  await sleep(500);
  await page.keyboard.type(query, { delay: 60 });
  await sleep(3000);

  page.off('response', interceptHandler);

  for (const { op, text } of searchDataReceived) {
    try {
      const data = JSON.parse(text);
      const nodes = data?.data?.search?.edges
        || data?.data?.posts?.edges
        || data?.data?.searchProducts?.edges
        || [];
      for (const edge of nodes) {
        const node = edge?.node || edge;
        if (!node) continue;
        const slug = node.slug || node.name?.toLowerCase().replace(/\s+/g, '-');
        if (!slug) continue;
        const url = node.url || `${PH_BASE}/products/${slug}`;
        results.push({
          slug,
          name: node.name || node.tagline || slug,
          tagline: node.tagline || node.description || '',
          url: url.startsWith('http') ? url : `${PH_BASE}${url}`,
          upvotes: node.votesCount || node.upvotesCount || 0,
        });
      }
    } catch { /* skip malformed */ }
  }

  const domResults = await page.evaluate((base) => {
    const items = [];
    const spotlightItems = document.querySelectorAll('[data-test^="spotlight-result-product"]');
    for (let i = 0; i < spotlightItems.length; i++) {
      const el = spotlightItems[i];
      const thumbEl = el.querySelector('[data-test*="thumbnail"]');
      const thumbText = thumbEl ? thumbEl.getAttribute('data-test').replace('-thumbnail', '') : '';
      const link = el.querySelector('a[href*="/products/"]');
      const href = link ? link.getAttribute('href') : null;
      const nameEl = el.querySelector('a, span, div');
      const name = nameEl ? nameEl.textContent.trim().substring(0, 80) : thumbText;
      if (href) {
        const parts = href.split('/products/');
        const slug = parts[1] ? parts[1].replace(/\/$/, '').split('/')[0] : '';
        if (slug) {
          items.push({
            slug,
            name: name || slug,
            tagline: '',
            url: href.startsWith('http') ? href : base + href,
            upvotes: 0,
          });
        }
      }
    }
    return items;
  }, PH_BASE);

  for (const r of domResults) {
    if (!results.find(e => e.slug === r.slug)) results.push(r);
  }

  log(`[ph-browser] query="${query}" → ${results.length} via interception, ${domResults.length} via DOM`);
  return results;
}

async function scrapeProductListing(page, listingUrl) {
  const loaded = await navigateAndWait(page, listingUrl, 4000);
  if (!loaded) return [];

  return await page.evaluate((base) => {
    const results = [];
    const seen = new Set();

    const productCards = document.querySelectorAll('[data-test^="product:"]');
    for (let i = 0; i < productCards.length; i++) {
      const el = productCards[i];
      const dt = el.getAttribute('data-test');
      const slug = dt.replace('product:', '');
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const nameEl = el.querySelector('h2, h3, [class*="name"], [class*="title"]') ||
        el.querySelector('a');
      const name = nameEl ? nameEl.textContent.trim().replace(/^\d+\.\s*/, '') : slug;
      const taglineEl = el.querySelector('p, [class*="tagline"], [class*="description"]');
      const tagline = taglineEl ? taglineEl.textContent.trim() : '';
      results.push({ slug, name, tagline, url: base + '/products/' + slug, upvotes: 0 });
    }

    const postItems = document.querySelectorAll('[data-test^="post-item"]');
    for (let i = 0; i < postItems.length; i++) {
      const el = postItems[i];
      const productLinks = Array.from(el.querySelectorAll('a[href*="/products/"]'));
      const nameEl = el.querySelector('[data-test^="post-name"]');
      for (const a of productLinks) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const parts = href.split('/products/');
        if (parts.length < 2) continue;
        const slug = parts[1].replace(/\/$/, '').split('/')[0];
        if (!slug || seen.has(slug) || slug === 'undefined') continue;
        seen.add(slug);
        const name = nameEl ? nameEl.textContent.trim().replace(/^\d+\.\s*/, '') : slug;
        const voteEl = el.querySelector('[data-test="vote-button"]');
        const upvotes = voteEl ? parseInt(voteEl.textContent.trim().replace(/[^0-9]/g, ''), 10) || 0 : 0;
        results.push({
          slug, name, tagline: '',
          url: href.startsWith('http') ? href : base + href,
          upvotes,
        });
      }
    }

    if (results.length === 0) {
      const allLinks = document.querySelectorAll('a[href*="/products/"]');
      for (let i = 0; i < allLinks.length && results.length < 20; i++) {
        const a = allLinks[i];
        const href = a.getAttribute('href') || '';
        if (href.includes('/reviews') || href.includes('/alternatives') ||
            href.includes('/launches') || href.includes('/customers')) continue;
        const parts = href.split('/products/');
        if (parts.length < 2) continue;
        const slug = parts[1].replace(/\/$/, '').split('/')[0];
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        results.push({
          slug,
          name: a.textContent.trim().substring(0, 60) || slug,
          tagline: '',
          url: href.startsWith('http') ? href : base + href,
          upvotes: 0,
        });
      }
    }

    return results;
  }, PH_BASE);
}

async function scrapeProductPage(page, slug, maxComments = 80) {
  const productUrl = `${PH_BASE}/products/${slug}`;
  const reviewsUrl = `${PH_BASE}/products/${slug}/reviews`;

  log(`[ph-browser] scraping product overview: ${productUrl}`);
  await navigateAndWait(page, productUrl, 2000);

  const overview = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const name = h1 ? h1.textContent.trim() : '';
    const taglineCandidates = Array.from(document.querySelectorAll('[data-test="header"] p, h1 + p, h1 ~ p'));
    let tagline = '';
    for (const el of taglineCandidates) {
      const t = el.textContent.trim();
      if (/\d+\s*(followers|reviews|K followers)/i.test(t) || /^\d+\.?\d*\s*[•]/.test(t)) continue;
      if (t.length > 5 && t.length < 200) { tagline = t; break; }
    }
    const descEls = document.querySelectorAll('[data-test*="description"], [class*="about"] p, main p');
    let description = '';
    for (let i = 0; i < descEls.length; i++) {
      const t = descEls[i].textContent.trim();
      if (t.length > 80) { description = t.substring(0, 600); break; }
    }
    let upvotes = 0;
    const voteBtn = document.querySelector('[data-test="vote-button"], button[class*="vote"]');
    if (voteBtn) {
      const m = voteBtn.textContent.match(/([\d,]+)/);
      if (m) upvotes = parseInt(m[1].replace(/,/g, ''), 10);
    }
    return { name, tagline, description, upvotes };
  });

  log(`[ph-browser] scraping reviews: ${reviewsUrl}`);
  await navigateAndWait(page, reviewsUrl, 2500);

  const comments = await page.evaluate((maxC) => {
    const results = [];
    const seen = new Set();
    const reviewSelectors = [
      '[data-test^="review"]', '[class*="reviewCard"]', '[class*="ReviewCard"]',
      '[class*="review-item"]', '[class*="reviewItem"]',
    ];
    let reviewEls = [];
    for (const sel of reviewSelectors) {
      reviewEls = Array.from(document.querySelectorAll(sel));
      if (reviewEls.length > 0) break;
    }
    if (reviewEls.length === 0) {
      const main = document.querySelector('main');
      if (main) {
        const divs = Array.from(main.querySelectorAll('div, article, section'));
        reviewEls = divs.filter(el => {
          const t = el.textContent.trim();
          return t.length > 60 && t.length < 2000 && !el.querySelector('nav');
        }).slice(0, maxC);
      }
    }
    for (let k = 0; k < Math.min(reviewEls.length, maxC); k++) {
      const el = reviewEls[k];
      const text = el.textContent.trim();
      if (!text || text.length < 25 || text.length > 3000) continue;
      if (seen.has(text.substring(0, 50))) continue;
      seen.add(text.substring(0, 50));
      const scoreEl = el.querySelector('[class*="vote"] span, [class*="count"] span, [data-test*="vote"]');
      let score = 1;
      if (scoreEl) {
        const sm = scoreEl.textContent.match(/(\d+)/);
        if (sm) score = parseInt(sm[1], 10);
      }
      const starText = el.querySelector('[class*="rating"], [class*="star"]');
      const starVal = starText ? parseInt(starText.textContent.trim()[0] || '0', 10) : 0;
      results.push({ body: text.substring(0, 500), score, stars: starVal });
    }
    return results;
  }, maxComments);

  log(`[ph-browser] product "${overview.name}" — upvotes:${overview.upvotes}, reviews:${comments.length}`);
  return { name: overview.name, tagline: overview.tagline, description: overview.description, upvotes: overview.upvotes, comments };
}

/**
 * Puppeteer-based scan command (fallback when no API token is available).
 */
async function cmdScanBrowser(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required for producthunt scan');

  const limit = args.limit || 20;
  const maxComments = args.maxComments || 80;

  log(`[ph-browser] scan domain="${domain}", limit=${limit} (Puppeteer fallback)`);

  const browser = await connectBrowser(args);
  const page = await preparePage(browser);
  const blockTracker = createBlockTracker('producthunt');

  try {
    const productsBySlug = new Map();

    // Strategy 1: category page
    const domainLower = domain.toLowerCase();
    const categorySlug = Object.entries(DOMAIN_TO_TOPIC).find(
      ([key]) => domainLower.includes(key) || key.includes(domainLower)
    )?.[1];

    if (categorySlug) {
      log(`[ph-browser] using category page: /categories/${categorySlug}`);
      const catUrl = `${PH_BASE}/categories/${categorySlug}`;
      const catResults = await scrapeProductListing(page, catUrl);
      log(`[ph-browser] category page: ${catResults.length} products`);
      for (const r of catResults) {
        if (!productsBySlug.has(r.slug)) productsBySlug.set(r.slug, r);
      }
      await politeDelay();
    }

    // Strategy 2: search input interception
    if (productsBySlug.size < limit) {
      log(`[ph-browser] searching via input interception...`);
      const searchResults = await searchViaInputAndIntercept(page, domain);
      for (const r of searchResults) {
        if (!productsBySlug.has(r.slug)) productsBySlug.set(r.slug, r);
      }
      await politeDelay();
    }

    // Strategy 3: homepage fallback
    if (productsBySlug.size < 3) {
      log(`[ph-browser] falling back to homepage listing...`);
      const homeResults = await scrapeProductListing(page, PH_BASE + '/');
      for (const r of homeResults) {
        if (!productsBySlug.has(r.slug)) productsBySlug.set(r.slug, r);
      }
      await politeDelay();
    }

    log(`[ph-browser] ${productsBySlug.size} unique products after discovery`);

    const scored = [];
    let count = 0;
    for (const product of productsBySlug.values()) {
      if (count >= limit + 5 || blockTracker.shouldStop) break;
      try {
        const data = await scrapeProductPage(page, product.slug, maxComments);
        if (!data.upvotes && product.upvotes) data.upvotes = product.upvotes;
        if (!data.name) data.name = product.name;
        if (!data.tagline) data.tagline = product.tagline;

        const productUrl = `${PH_BASE}/products/${product.slug}`;
        const post = buildPost(data, product.slug, productUrl);
        const enriched = enrichPost(post, domain);
        if (enriched) {
          enriched.ph_pain_comments = post._painComments.length;
          enriched.ph_total_comments = post._allComments.length;
          scored.push(enriched);
        }
      } catch (err) {
        log(`[ph-browser] failed for ${product.slug}: ${err.message}`);
      }
      count++;
      await politeDelay();
    }

    scored.sort((a, b) => b.painScore - a.painScore);
    ok({
      mode: 'producthunt',
      method: 'browser',
      posts: scored.slice(0, limit),
      stats: {
        products_found: productsBySlug.size,
        products_scraped: count,
        after_filter: Math.min(scored.length, limit),
        blocked: blockTracker.stats.blocked,
        rateLimitWarnings: blockTracker.stats.rateLimitWarnings,
        rateMonitor: getGlobalRateMonitor().getSourceBreakdown().get('producthunt') || { warnings: 0, blocks: 0, errors: 0 },
      },
    });
  } finally {
    await page.close().catch(() => {});
    if (_launchedBrowser) {
      await _launchedBrowser.close().catch(() => {});
      _launchedBrowser = null;
    }
  }
}

// ─── command dispatch ────────────────────────────────────────────────────────

let _tipShown = false;

async function cmdScan(args) {
  const token = args.token || process.env.PRODUCTHUNT_TOKEN;

  if (token) {
    log('[ph] API token found — using GraphQL API (no browser needed)');
    return cmdScanApi(args, token);
  }

  if (!_tipShown) {
    _tipShown = true;
    process.stderr.write('[producthunt] tip: set PRODUCTHUNT_TOKEN to skip browser requirement → free at producthunt.com/v2/oauth/applications\n');
  }
  log('[ph] No API token found (set PRODUCTHUNT_TOKEN or pass --token)');
  log('[ph] Falling back to Puppeteer-based scraping...');
  return cmdScanBrowser(args);
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'producthunt',
  description: 'Product Hunt — search product launches and reviews for pain signals (API or browser)',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
producthunt source — Product Hunt via GraphQL API (primary) or Puppeteer (fallback)

Commands:
  scan        Search Product Hunt for products matching --domain and score pain signals

scan options:
  --domain <str>        Domain / topic to search for (required)
  --limit <n>           Max products to return (default: 20)
  --maxComments <n>     Max comments per product (default: 80)
  --token <str>         Product Hunt API v2 bearer token
                        (or set PRODUCTHUNT_TOKEN env var)

API mode (when token is provided):
  Uses Product Hunt GraphQL API v2 directly — no browser or Chrome needed.
  Rate limited to ~28 req/min (API allows 450 per 15 min).
  Endpoint: https://api.producthunt.com/v2/api/graphql

Browser fallback (when no token):
  Falls back to Puppeteer scraping. Requires Chrome instance.
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  PRODUCTHUNT_TOKEN=xxx pain-points ph scan --domain "project management"
  pain-points ph scan --domain "email marketing" --token xxx --limit 10
  pain-points ph scan --domain "crm" (uses Puppeteer if no token)
`,
};
