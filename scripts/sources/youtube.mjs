/**
 * youtube.mjs — YouTube Comments source for gapscout
 *
 * Dual-mode comment fetching:
 *   1. Innertube (default) — Uses YouTube's internal API, no quota limits
 *   2. Official API v3 (fallback) — Uses YOUTUBE_API_KEY, 10,000 units/day
 *
 * Video search still uses the official API when YOUTUBE_API_KEY is set
 * (100 units/search). When no API key is set, Innertube is used for
 * both search and comments.
 *
 * Usage:
 *   gapscout youtube scan --domain "project management" --limit 200
 *   gapscout yt scan --domain "CRM software"
 *   gapscout yt scan --domain "CRM software" --no-innertube
 */

import https from 'node:https';
import { writeFileSync } from 'node:fs';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { httpGetWithRetry } from '../lib/http.mjs';
import { getUsageTracker } from '../lib/usage-tracker.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const YT_API_HOST = 'www.googleapis.com';
const YT_API_KEY = process.env.YOUTUBE_API_KEY || '';
const MIN_DELAY_MS = 500;
const INNERTUBE_DELAY_MS = 500; // 500ms between Innertube requests (IP-based limits are generous)
const RAW_OUTPUT_PATH = '/tmp/gapscout-youtube-raw.json';

// Unit costs for budget tracking (official API only)
const SEARCH_COST = 100;
const COMMENT_THREADS_COST = 1;

// Track rate limit warnings and budget across a scan
let rateLimitWarnings = 0;
let totalRequests = 0;
let unitsUsed = 0;
const DAILY_UNIT_LIMIT = 10000;

// Innertube constants
const INNERTUBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INNERTUBE_CLIENT_VERSION = '2.20250320.00.00';
const YT_CFG_RE = /ytcfg\.set\s*\(\s*({.+?})\s*\)\s*;/;
const YT_INITIAL_DATA_RE = /(?:window\s*\[\s*["']ytInitialData["']\s*\]|ytInitialData)\s*=\s*({.+?})\s*;\s*(?:var\s+meta|<\/script|\n)/;

// Innertube request tracker
let innertubeRequests = 0;
let innertubeLastRequestAt = 0;

if (YT_API_KEY) {
  log('[youtube] API key detected (YOUTUBE_API_KEY) — 10,000 units/day');
  log('[youtube] Innertube will be used for comments (no quota cost)');
} else {
  log('[youtube] No YOUTUBE_API_KEY set — using Innertube for search and comments (no quota limits)');
}

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
    log(`[youtube] INFO: ${totalRequests} requests made, ~${unitsUsed} API units used this session`);
  }
}

async function innertubeRateLimit() {
  const elapsed = Date.now() - innertubeLastRequestAt;
  if (elapsed < INNERTUBE_DELAY_MS) {
    await sleep(INNERTUBE_DELAY_MS - elapsed);
  }
  innertubeLastRequestAt = Date.now();
  innertubeRequests++;
  if (innertubeRequests > 0 && innertubeRequests % 50 === 0) {
    log(`[youtube/innertube] INFO: ${innertubeRequests} Innertube requests made`);
  }
}

// ─── Innertube helpers ──────────────────────────────────────────────────────

/**
 * Make an HTTPS request and return the response body as a string.
 * Uses native node:https — no new dependencies needed.
 */
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': INNERTUBE_USER_AGENT,
        ...(options.headers || {}),
      },
      timeout: options.timeout || 30000,
    };

    const req = https.request(reqOptions, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 308) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${parsedUrl.hostname}${res.headers.location}`;
        return httpsRequest(redirectUrl, options).then(resolve, reject);
      }

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Recursively search a nested object/array for all values matching a key.
 * Mirrors the search_dict() function from youtube-comment-downloader.
 */
function* searchDict(partial, searchKey) {
  const stack = [partial];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const [key, value] of Object.entries(current)) {
        if (key === searchKey) {
          yield value;
        } else {
          stack.push(value);
        }
      }
    } else if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
    }
  }
}

/**
 * Get the first result from searchDict, or a default value.
 */
function searchDictFirst(partial, searchKey, defaultValue = null) {
  for (const value of searchDict(partial, searchKey)) {
    return value;
  }
  return defaultValue;
}

/**
 * Fetch a YouTube page and extract ytcfg and ytInitialData.
 */
async function fetchYouTubePage(url) {
  await innertubeRateLimit();
  log(`[youtube/innertube] GET ${url.substring(0, 100)}...`);

  const html = await httpsRequest(url, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml',
      'Cookie': 'CONSENT=YES+cb',
    },
  });

  // Extract ytcfg
  const cfgMatch = html.match(YT_CFG_RE);
  let ytcfg = null;
  if (cfgMatch) {
    try {
      ytcfg = JSON.parse(cfgMatch[1]);
    } catch {
      // Try to find a larger match — ytcfg can span multiple set() calls
      ytcfg = null;
    }
  }

  // Extract ytInitialData
  const dataMatch = html.match(YT_INITIAL_DATA_RE);
  let initialData = null;
  if (dataMatch) {
    try {
      initialData = JSON.parse(dataMatch[1]);
    } catch {
      initialData = null;
    }
  }

  return { html, ytcfg, initialData };
}

/**
 * Make an Innertube API POST request.
 *
 * @param {object} endpoint - The continuation endpoint object containing
 *   commandMetadata.webCommandMetadata.apiUrl and continuationCommand.token
 * @param {object} ytcfg - The ytcfg object from the page
 * @param {number} retries - Max retries
 * @returns {object|null} Parsed JSON response
 */
async function innertubePost(endpoint, ytcfg, retries = 3) {
  await innertubeRateLimit();

  // Build URL from the endpoint's metadata or use default
  let apiUrl;
  try {
    apiUrl = 'https://www.youtube.com' + endpoint.commandMetadata.webCommandMetadata.apiUrl;
  } catch {
    apiUrl = 'https://www.youtube.com/youtubei/v1/next';
  }

  // Extract continuation token
  let token;
  if (endpoint.continuationCommand?.token) {
    token = endpoint.continuationCommand.token;
  } else if (endpoint.token) {
    token = endpoint.token;
  } else if (typeof endpoint === 'string') {
    token = endpoint;
  }

  if (!token) {
    log('[youtube/innertube] WARNING: no continuation token found in endpoint');
    return null;
  }

  // Build the context from ytcfg or use a default
  const context = ytcfg?.INNERTUBE_CONTEXT || {
    client: {
      clientName: 'WEB',
      clientVersion: INNERTUBE_CLIENT_VERSION,
    },
  };

  const body = JSON.stringify({
    context,
    continuation: token,
  });

  // Determine API key parameter
  const apiKey = ytcfg?.INNERTUBE_API_KEY || '';
  const queryStr = apiKey ? `?key=${apiKey}&prettyPrint=false` : '?prettyPrint=false';

  log(`[youtube/innertube] POST ${apiUrl.substring(0, 80)}...`);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const responseText = await httpsRequest(apiUrl + queryStr, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': 'CONSENT=YES+cb',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': INNERTUBE_CLIENT_VERSION,
        },
        body,
      });
      return JSON.parse(responseText);
    } catch (err) {
      const code = err.statusCode || 0;
      if (code === 403 || code === 413) {
        log(`[youtube/innertube] ${code} response — stopping`);
        return null;
      }
      if (attempt < retries - 1) {
        log(`[youtube/innertube] request failed (${err.message}), retry ${attempt + 1}/${retries}`);
        await sleep(2000 * (attempt + 1));
      }
    }
  }
  return null;
}

/**
 * Fetch comments for a video using the Innertube API.
 * No quota cost — uses YouTube's internal API.
 *
 * @param {string} videoId - YouTube video ID
 * @param {number} maxComments - Maximum comments to fetch
 * @returns {Array} Array of comment objects { commentId, text, likeCount, publishedAt, authorName }
 */
async function innertubeComments(videoId, maxComments = 200) {
  const comments = [];

  // Step 1: Fetch the watch page to get initial data and config
  let pageData;
  try {
    pageData = await fetchYouTubePage(`https://www.youtube.com/watch?v=${videoId}`);
  } catch (err) {
    log(`[youtube/innertube] failed to fetch watch page for ${videoId}: ${err.message}`);
    return comments;
  }

  const { ytcfg, initialData } = pageData;
  if (!initialData) {
    log(`[youtube/innertube] no initial data found for video ${videoId}`);
    return comments;
  }

  // Step 2: Find the comment section continuation token
  // Look for the continuation in itemSectionRenderer (comments section)
  const itemSection = searchDictFirst(initialData, 'itemSectionRenderer');
  const renderer = itemSection ? searchDictFirst(itemSection, 'continuationItemRenderer') : null;

  if (!renderer) {
    log(`[youtube/innertube] no comment continuation found for video ${videoId} (comments may be disabled)`);
    return comments;
  }

  // Get sorting menu — we need to find the continuation endpoints
  let sortMenu = searchDictFirst(initialData, 'sortFilterSubMenuRenderer');
  let sortMenuItems = sortMenu?.subMenuItems || [];

  // If no sort menu found directly, we may need to make an initial request
  const continuations = [];
  if (!sortMenuItems.length) {
    // Try getting continuation from section list
    const sectionList = searchDictFirst(initialData, 'sectionListRenderer');
    if (sectionList) {
      const contEndpoints = [...searchDict(sectionList, 'continuationEndpoint')];
      if (contEndpoints.length > 0 && ytcfg) {
        const response = await innertubePost(contEndpoints[0], ytcfg);
        if (response) {
          sortMenu = searchDictFirst(response, 'sortFilterSubMenuRenderer');
          sortMenuItems = sortMenu?.subMenuItems || [];
        }
      }
    }
  }

  // Use "Top comments" (index 0) sort order for relevance
  if (sortMenuItems.length > 0) {
    continuations.push(sortMenuItems[0].serviceEndpoint);
  } else {
    // Fallback: use the continuation from the renderer directly
    const contEndpoint = searchDictFirst(renderer, 'continuationEndpoint');
    if (contEndpoint) {
      continuations.push(contEndpoint);
    } else {
      log(`[youtube/innertube] could not find any comment continuation endpoint for ${videoId}`);
      return comments;
    }
  }

  // Step 3: Paginate through comments
  let pages = 0;
  const maxPages = 20; // Safety limit

  while (continuations.length > 0 && comments.length < maxComments && pages < maxPages) {
    const continuation = continuations.shift();
    const response = await innertubePost(continuation, ytcfg);

    if (!response) break;

    // Check for errors
    const error = searchDictFirst(response, 'externalErrorMessage');
    if (error) {
      log(`[youtube/innertube] server error: ${error}`);
      break;
    }

    pages++;

    // Extract continuation items from the response
    const reloadActions = [...searchDict(response, 'reloadContinuationItemsCommand')];
    const appendActions = [...searchDict(response, 'appendContinuationItemsAction')];
    const actions = [...reloadActions, ...appendActions];

    for (const action of actions) {
      const items = action.continuationItems || [];
      const targetId = action.targetId || '';

      for (const item of items) {
        // Extract next page continuation tokens
        if (targetId === 'comments-section' ||
            targetId === 'engagement-panel-comments-section' ||
            targetId === 'shorts-engagement-panel-comments-section') {
          for (const ep of searchDict(item, 'continuationEndpoint')) {
            continuations.unshift(ep); // prepend for depth-first
          }
        }
        // Reply continuations
        if (targetId.startsWith('comment-replies-item') && item.continuationItemRenderer) {
          const btnRenderer = searchDictFirst(item, 'buttonRenderer');
          if (btnRenderer?.command) {
            continuations.push(btnRenderer.command);
          }
        }
      }
    }

    // Extract comments from the new entity payload format
    for (const comment of searchDict(response, 'commentEntityPayload')) {
      try {
        const properties = comment.properties;
        if (!properties) continue;

        const cid = properties.commentId || '';
        const text = properties.content?.content || '';
        const publishedTime = properties.publishedTime || '';
        const author = comment.author || {};
        const toolbar = comment.toolbar || {};

        // Parse like count — it comes as a string like "1.2K" or "5"
        const votesStr = (toolbar.likeCountNotliked || '0').trim();
        const likeCount = parseLikeCount(votesStr);

        comments.push({
          commentId: cid,
          text,
          likeCount,
          publishedAt: publishedTime,
          authorName: author.displayName || '',
        });
      } catch {
        // Skip malformed comments
      }

      if (comments.length >= maxComments) break;
    }

    // If no commentEntityPayload found, try the older format
    if (comments.length === 0 && pages === 1) {
      for (const action of actions) {
        for (const item of (action.continuationItems || [])) {
          const commentRenderer = item?.commentThreadRenderer?.comment?.commentRenderer;
          if (commentRenderer) {
            const text = (commentRenderer.contentText?.runs || []).map(r => r.text).join('');
            const authorText = commentRenderer.authorText?.simpleText || '';
            const votesText = commentRenderer.voteCount?.simpleText || '0';
            const timeText = (commentRenderer.publishedTimeText?.runs || [])[0]?.text || '';
            const cid = commentRenderer.commentId || '';

            comments.push({
              commentId: cid,
              text,
              likeCount: parseLikeCount(votesText),
              publishedAt: timeText,
              authorName: authorText,
            });

            if (comments.length >= maxComments) break;
          }
        }
      }
    }
  }

  log(`[youtube/innertube] video ${videoId}: ${comments.length} comments fetched in ${pages} page(s)`);
  return comments;
}

/**
 * Parse YouTube like count strings like "1.2K", "3", "12K", "1M" into numbers.
 */
function parseLikeCount(str) {
  if (!str || str === '0') return 0;
  const cleaned = str.trim().toUpperCase();
  const match = cleaned.match(/^([\d.]+)\s*([KMB]?)$/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === 'K') return Math.round(num * 1000);
  if (suffix === 'M') return Math.round(num * 1000000);
  if (suffix === 'B') return Math.round(num * 1000000000);
  return Math.round(num);
}

/**
 * Search YouTube for videos using Innertube (no API key needed).
 * Scrapes YouTube search results page.
 *
 * @param {string} query - Search query
 * @param {number} maxResults - Max videos to return
 * @returns {Array} Array of { videoId, title, description, channelTitle, publishedAt }
 */
async function innertubeSearchVideos(query, maxResults = 10) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;

  let pageData;
  try {
    pageData = await fetchYouTubePage(searchUrl);
  } catch (err) {
    log(`[youtube/innertube] search page fetch failed: ${err.message}`);
    return [];
  }

  const { initialData } = pageData;
  if (!initialData) {
    log(`[youtube/innertube] no initial data in search results`);
    return [];
  }

  const videos = [];

  // Extract video renderers from search results
  for (const renderer of searchDict(initialData, 'videoRenderer')) {
    if (videos.length >= maxResults) break;

    const videoId = renderer.videoId;
    if (!videoId) continue;

    const title = (renderer.title?.runs || []).map(r => r.text).join('') || '';
    const description = (renderer.detailedMetadataSnippets?.[0]?.snippetText?.runs || [])
      .map(r => r.text).join('') || '';
    const channelTitle = renderer.ownerText?.runs?.[0]?.text || '';
    const publishedAt = renderer.publishedTimeText?.simpleText || '';

    videos.push({ videoId, title, description, channelTitle, publishedAt });
  }

  return videos;
}

// ─── YouTube API helpers (official) ────────────────────────────────────────

/**
 * Fetch from YouTube Data API v3 with retry and rate limiting.
 */
async function ytApiGet(path) {
  await rateLimit();
  getUsageTracker().increment('youtube');
  log(`[youtube] GET https://${YT_API_HOST}${path.substring(0, 120)}...`);

  try {
    return await httpGetWithRetry(YT_API_HOST, path, { maxRetries: 3 });
  } catch (err) {
    const code = err.statusCode || 0;
    if (code === 429) {
      rateLimitWarnings++;
      log(`[youtube] WARNING: rate limit hit — backing off 10s`);
      await sleep(10000);
      return null;
    }
    if (code === 403) {
      rateLimitWarnings++;
      // Could be quota exceeded or API not enabled
      log(`[youtube] WARNING: 403 Forbidden — quota may be exhausted or API key invalid`);
      return null;
    }
    throw err;
  }
}

/**
 * Search YouTube for videos matching a query (official API).
 * Cost: 100 units per call.
 */
async function searchVideos(query, maxResults = 10) {
  if (unitsUsed + SEARCH_COST > DAILY_UNIT_LIMIT) {
    log(`[youtube] WARNING: search would exceed daily unit budget (${unitsUsed}/${DAILY_UNIT_LIMIT}), skipping`);
    return [];
  }

  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(maxResults),
    order: 'relevance',
    key: YT_API_KEY,
  });
  const path = `/youtube/v3/search?${params.toString()}`;
  const data = await ytApiGet(path);

  if (!data) return [];
  unitsUsed += SEARCH_COST;

  return (data.items || []).map(item => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title || '',
    description: item.snippet?.description || '',
    channelTitle: item.snippet?.channelTitle || '',
    publishedAt: item.snippet?.publishedAt || '',
  })).filter(v => v.videoId);
}

/**
 * Fetch comment threads for a video (official API).
 * Cost: 1 unit per call.
 */
async function fetchCommentThreads(videoId, maxResults = 100) {
  if (unitsUsed + COMMENT_THREADS_COST > DAILY_UNIT_LIMIT) {
    log(`[youtube] WARNING: comment fetch would exceed daily unit budget, skipping`);
    return [];
  }

  const params = new URLSearchParams({
    part: 'snippet,replies',
    videoId,
    maxResults: String(maxResults),
    order: 'relevance',
    key: YT_API_KEY,
  });
  const path = `/youtube/v3/commentThreads?${params.toString()}`;
  const data = await ytApiGet(path);

  if (!data) return [];
  unitsUsed += COMMENT_THREADS_COST;

  const comments = [];
  for (const item of (data.items || [])) {
    const topComment = item.snippet?.topLevelComment?.snippet;
    if (topComment) {
      comments.push({
        commentId: item.id,
        text: topComment.textDisplay || '',
        likeCount: topComment.likeCount || 0,
        publishedAt: topComment.publishedAt || '',
        authorName: topComment.authorDisplayName || '',
      });
    }

    // Include replies if available
    const replies = item.replies?.comments || [];
    for (const reply of replies) {
      const replySnippet = reply.snippet;
      if (replySnippet) {
        comments.push({
          commentId: reply.id,
          text: replySnippet.textDisplay || '',
          likeCount: replySnippet.likeCount || 0,
          publishedAt: replySnippet.publishedAt || '',
          authorName: replySnippet.authorDisplayName || '',
        });
      }
    }
  }

  return comments;
}

// ─── normalizers ─────────────────────────────────────────────────────────────

/**
 * Strip HTML tags from YouTube comment text (comments can contain basic HTML).
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Normalize a YouTube comment into the standard gapscout post format.
 */
function normalizeComment(comment, videoTitle, videoId) {
  const createdAt = comment.publishedAt ? new Date(comment.publishedAt).getTime() / 1000 | 0 : 0;
  return {
    id: comment.commentId,
    title: videoTitle,
    selftext: stripHtml(comment.text),
    subreddit: 'youtube',
    url: `https://www.youtube.com/watch?v=${videoId}&lc=${comment.commentId}`,
    score: comment.likeCount || 0,
    num_comments: 0,
    upvote_ratio: 0,
    flair: '',
    created_utc: createdAt,
    source: 'youtube',
    meta: {
      videoId,
      videoTitle,
      authorName: comment.authorName || '',
    },
  };
}

// ─── query generation ────────────────────────────────────────────────────────

function buildVideoSearchQueries(domain) {
  return [
    `${domain} review`,
    `${domain} vs`,
    `${domain} problems`,
    `best ${domain} tools`,
    `${domain} comparison`,
    `${domain} honest review`,
    `${domain} issues`,
    `${domain} alternative`,
    `${domain} tutorial problems`,
    `why I stopped using ${domain}`,
    `${domain} tips and tricks`,
    `${domain} for beginners`,
  ];
}

// ─── scan command ───────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain;
  if (!domain) fail('--domain is required');
  const limit = args.limit || 200;
  // --no-innertube sets args.noInnertube=true via parseArgs + toCamelCase
  const useInnertube = args.innertube !== false && !args.noInnertube; // default: true

  // Reset per-scan counters
  rateLimitWarnings = 0;
  totalRequests = 0;
  unitsUsed = 0;
  innertubeRequests = 0;

  const hasApiKey = !!YT_API_KEY;
  const useInnertubeForComments = useInnertube;
  const useInnertubeForSearch = !hasApiKey && useInnertube;

  // If no API key and Innertube disabled, we cannot do anything
  if (!hasApiKey && !useInnertube) {
    log('[youtube] No YOUTUBE_API_KEY and --no-innertube specified. Cannot proceed.');
    log('[youtube] Either set YOUTUBE_API_KEY or enable Innertube (default).');
    return ok({
      source: 'youtube',
      posts: [],
      stats: { error: 'No API key and Innertube disabled' },
    });
  }

  log(`[youtube] scan domain="${domain}", limit=${limit}`);
  log(`[youtube] mode: search=${useInnertubeForSearch ? 'innertube' : 'api'}, comments=${useInnertubeForComments ? 'innertube' : 'api'}`);

  // Check daily usage budget (only relevant for API mode)
  if (hasApiKey) {
    const usage = getUsageTracker();
    const remaining = usage.getRemaining('youtube');
    if (remaining.pct >= 80) {
      log(`[youtube] WARNING: daily budget low — ${remaining.remaining}/${remaining.limit} requests remaining today`);
    }
    if (remaining.remaining <= 0 && !useInnertube) {
      log(`[youtube] ERROR: daily budget exhausted and Innertube disabled. Try again tomorrow.`);
      return ok({ source: 'youtube', posts: [], stats: { error: 'daily limit reached' } });
    }
  }

  const queries = buildVideoSearchQueries(domain);
  const videosById = new Map();
  let stoppedEarly = false;

  // Step 1: Search for review/comparison videos
  log(`[youtube] Step 1: searching for videos (${queries.length} queries)`);

  for (const query of queries) {
    if (stoppedEarly) break;

    let videos;
    try {
      if (useInnertubeForSearch) {
        videos = await innertubeSearchVideos(query, 10);
      } else {
        videos = await searchVideos(query, 10);
      }
    } catch (err) {
      log(`[youtube] search "${query}" failed: ${err.message}`);
      continue;
    }

    log(`[youtube] query="${query}": ${videos.length} videos`);

    for (const video of videos) {
      if (!videosById.has(video.videoId)) {
        videosById.set(video.videoId, video);
      }
    }

    // Check unit budget (API mode only)
    if (!useInnertubeForSearch && unitsUsed >= DAILY_UNIT_LIMIT * 0.9) {
      log(`[youtube] approaching unit limit (${unitsUsed}/${DAILY_UNIT_LIMIT}), stopping searches`);
      stoppedEarly = true;
      break;
    }
  }

  log(`[youtube] ${videosById.size} unique videos found`);

  // Step 2: Fetch comments for each video
  log(`[youtube] Step 2: fetching comments for ${videosById.size} videos (${useInnertubeForComments ? 'innertube' : 'api'})`);

  const allComments = [];

  for (const [videoId, video] of videosById) {
    if (stoppedEarly) break;

    let comments;
    try {
      if (useInnertubeForComments) {
        comments = await innertubeComments(videoId, Math.max(50, Math.ceil((limit * 2) / videosById.size)));
      } else {
        comments = await fetchCommentThreads(videoId, 100);
      }
    } catch (err) {
      log(`[youtube] comments for video ${videoId} failed: ${err.message}`);
      // If Innertube fails for a video, try official API as fallback
      if (useInnertubeForComments && hasApiKey) {
        log(`[youtube] falling back to official API for video ${videoId}`);
        try {
          comments = await fetchCommentThreads(videoId, 100);
        } catch (err2) {
          log(`[youtube] API fallback also failed: ${err2.message}`);
          continue;
        }
      } else {
        continue;
      }
    }

    log(`[youtube] video "${(video.title || '').substring(0, 50)}": ${comments.length} comments`);

    for (const comment of comments) {
      allComments.push({
        ...comment,
        videoId,
        videoTitle: video.title,
      });
    }

    // Check unit budget (API mode only)
    if (!useInnertubeForComments && unitsUsed >= DAILY_UNIT_LIMIT * 0.95) {
      log(`[youtube] unit limit nearly reached (${unitsUsed}/${DAILY_UNIT_LIMIT}), stopping`);
      stoppedEarly = true;
      break;
    }
  }

  log(`[youtube] ${allComments.length} total comments collected`);

  // Save raw comments before filtering
  try {
    const allRawPosts = allComments.map(c =>
      normalizeComment(c, c.videoTitle, c.videoId)
    );
    const rawOutput = {
      ok: true,
      data: { source: 'youtube', posts: allRawPosts, stats: { raw: true, total: allRawPosts.length } },
    };
    writeFileSync(RAW_OUTPUT_PATH, JSON.stringify(rawOutput));
    log(`[youtube] saved ${allRawPosts.length} raw comments to ${RAW_OUTPUT_PATH}`);
  } catch (err) {
    log(`[youtube] failed to save raw comments: ${err.message}`);
  }

  // Build domain word set for relevance filtering
  const domainWords = domain.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const scored = [];
  for (const comment of allComments) {
    const post = normalizeComment(comment, comment.videoTitle, comment.videoId);

    // Basic relevance check — check comment text and video title
    const fullText = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
    const hasDomainMatch = domainWords.some(w => fullText.includes(w));
    if (!hasDomainMatch) continue;

    const enriched = enrichPost(post, domain);
    if (enriched) {
      enriched.source = 'youtube';
      scored.push(enriched);
    }
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    source: 'youtube',
    posts: scored.slice(0, limit),
    stats: {
      queries_run: queries.length,
      videos_found: videosById.size,
      raw_comments: allComments.length,
      after_filter: Math.min(scored.length, limit),
      units_used: unitsUsed,
      innertube_requests: innertubeRequests,
      totalRequests,
      rateLimitWarnings,
      stoppedEarly,
      mode: {
        search: useInnertubeForSearch ? 'innertube' : 'api',
        comments: useInnertubeForComments ? 'innertube' : 'api',
      },
    },
  });
}

// ─── source export ──────────────────────────────────────────────────────────

export default {
  name: 'youtube',
  description: 'YouTube Comments — Innertube + API v3 hybrid, extracts pain signals from video comments',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
youtube source — Innertube + YouTube Data API v3 hybrid

Searches for review/comparison videos and extracts comment threads
for pain-point analysis. Uses YouTube's internal Innertube API for
comment fetching (no quota cost) with official API fallback.

Modes:
  With YOUTUBE_API_KEY:
    - Video search: official API (100 units/search)
    - Comments: Innertube (free, no quota)
    - Fallback: official API if Innertube fails

  Without YOUTUBE_API_KEY:
    - Video search: Innertube (scrapes search page)
    - Comments: Innertube (free, no quota)
    - No API key needed at all!

Commands:
  scan       Search YouTube for domain-related videos and analyze comments

scan options:
  --domain <str>        Topic/technology to search for (required)
  --limit <n>           Max comments to return (default: 200)
  --innertube           Use Innertube for comments (default: true)
  --no-innertube        Force official API only (requires YOUTUBE_API_KEY)

Search strategy:
  Step 1: Search for videos matching "{domain} review", "{domain} vs",
          "{domain} problems", "best {domain} tools", etc.
  Step 2: For each video, fetch comments via Innertube (or API fallback)
  Step 3: Score and rank comments by pain signals

Examples:
  gapscout youtube scan --domain "project management" --limit 200
  gapscout yt scan --domain "CRM software"
  YOUTUBE_API_KEY=xxx gapscout yt scan --domain "CRM" --no-innertube
`,
};
