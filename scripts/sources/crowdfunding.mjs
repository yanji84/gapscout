/**
 * crowdfunding.mjs — Kickstarter + Indiegogo source for pain-point-finder
 *
 * Kickstarter: Puppeteer browser scraping (no public API exists).
 * Indiegogo:   HTTP API calls (no browser needed).
 *
 * Use --sources to choose: kickstarter, indiegogo, or both (default: both).
 */

import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';
import { connectBrowser, politeDelay as politeDelayBase } from '../lib/browser.mjs';
import { httpGet, httpGetWithRetry, RateLimiter } from '../lib/http.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const KICKSTARTER = 'https://www.kickstarter.com';
const PAGE_DELAY_MS = 3000;
const JITTER_MS = 1000;

async function politeDelay() {
  await politeDelayBase(PAGE_DELAY_MS, JITTER_MS);
}

const REALISTIC_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// ─── Indiegogo constants ──────────────────────────────────────────────────────

const IGG_HOST = 'www.indiegogo.com';
const IGG_PUBLIC_API_BASE = '/api/public/projects';
const IGG_DISCOVER_PATH = '/private_api/discover';

const iggRateLimiter = new RateLimiter({
  minDelayMs: 1200,
  jitterMs: 300,
  maxPerMin: 25,
});

/**
 * Strip query parameters from a URL, keeping only the path.
 */
function stripQuery(url) {
  try { return new URL(url).origin + new URL(url).pathname; }
  catch { return url.split('?')[0]; }
}

// ─── scraping helpers ────────────────────────────────────────────────────────

/**
 * Parse a compact funding string like "$1.2M", "£45K", "€3,450" into a number.
 */
function parseFundingAmount(text) {
  if (!text) return 0;
  const clean = text.replace(/[^0-9.KMkm]/g, '').toUpperCase();
  const num = parseFloat(clean);
  if (isNaN(num)) return 0;
  if (clean.endsWith('M')) return Math.round(num * 1_000_000);
  if (clean.endsWith('K')) return Math.round(num * 1_000);
  return Math.round(num);
}

/**
 * Parse backer/comment counts like "1,234 backers" → 1234.
 */
function parseCount(text) {
  if (!text) return 0;
  const m = text.replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// ─── valid --sources values ─────────────────────────────────────────────────

const VALID_SOURCES = ['kickstarter', 'indiegogo', 'both'];

function parseSources(args) {
  const raw = args.sources || 'both';
  const val = raw.toLowerCase().trim();
  if (!VALID_SOURCES.includes(val)) {
    log(`[crowdfunding] invalid --sources "${raw}", using "both". Valid: ${VALID_SOURCES.join(', ')}`);
    return 'both';
  }
  return val;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  KICKSTARTER (Puppeteer)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Kickstarter search ──────────────────────────────────────────────────────

/**
 * Scrape the Kickstarter advanced search results page for a query.
 * Returns array of { slug, creator, name, url, description, backerCount, fundingAmount }.
 */
async function scrapeKickstarterSearch(page, query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `${KICKSTARTER}/discover/advanced?term=${encodedQuery}&sort=most_backed`;
  log(`[crowdfunding] search: ${url}`);

  // networkidle2 is required — domcontentloaded fires before React renders cards
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(1500);

  // Scroll to trigger lazy-loaded cards below the fold
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1500);

  return await page.evaluate(() => {
    var projects = [];
    // Primary selector: [data-pid] divs contain a data-project JSON attribute
    // with all project fields pre-populated by the server
    var cards = document.querySelectorAll('[data-pid]');

    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];

      // Try to extract rich data from the embedded JSON first
      var projectJson = null;
      try {
        var raw = card.getAttribute('data-project');
        if (raw) projectJson = JSON.parse(raw);
      } catch (e) { /* ignore parse errors */ }

      // Find the canonical project URL (strip tracking query params)
      var a = card.querySelector('a.project-card__title, a[href*="/projects/"]');
      if (!a) continue;
      var href = a.href.split('?')[0];
      var m = href.match(/\/projects\/([^/]+)\/([^/?#]+)/);
      if (!m) continue;

      var creator = m[1];
      var slug = m[2];
      var canonicalUrl = 'https://www.kickstarter.com/projects/' + creator + '/' + slug;

      // Extract title — prefer JSON, fall back to link text or blurb element
      var name = '';
      if (projectJson && projectJson.name) {
        name = projectJson.name;
      } else {
        var titleEl = card.querySelector('a.project-card__title, h3, h2');
        name = titleEl ? titleEl.textContent.trim() : slug;
      }

      // Extract blurb / short description
      var description = '';
      if (projectJson && projectJson.blurb) {
        description = projectJson.blurb;
      } else {
        var blurbEl = card.querySelector('.project-card__blurb, [class*="blurb"], p');
        description = blurbEl ? blurbEl.textContent.trim() : '';
      }

      // Backer count from JSON
      var backerCount = 0;
      if (projectJson && projectJson.backers_count) {
        backerCount = parseInt(projectJson.backers_count, 10) || 0;
      }

      // Funding amount from JSON (in cents → dollars)
      var fundingAmount = 0;
      if (projectJson && projectJson.pledged) {
        fundingAmount = Math.round(parseFloat(projectJson.pledged) || 0);
      }

      projects.push({
        creator,
        slug,
        url: canonicalUrl,
        name: name.substring(0, 120),
        description: description.substring(0, 300),
        backerCount,
        fundingAmount,
      });
    }

    // Fallback: if [data-pid] yielded nothing, try project link anchors
    if (projects.length === 0) {
      var links = document.querySelectorAll('a[href*="/projects/"]');
      var seen = new Set();
      for (var i = 0; i < links.length; i++) {
        var lhref = links[i].href.split('?')[0];
        var lm = lhref.match(/\/projects\/([^/]+)\/([^/?#]+)/);
        if (lm && !seen.has(lm[0])) {
          seen.add(lm[0]);
          projects.push({
            creator: lm[1],
            slug: lm[2],
            url: 'https://www.kickstarter.com/projects/' + lm[1] + '/' + lm[2],
            name: links[i].textContent.trim().substring(0, 120) || lm[2],
            description: '',
            backerCount: 0,
            fundingAmount: 0,
          });
        }
      }
    }

    return projects;
  });
}

// ─── Kickstarter project page ────────────────────────────────────────────────

/**
 * Scrape the main project page for description and funding stats.
 */
async function scrapeProjectPage(page, projectUrl) {
  await page.goto(projectUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(1500);

  return await page.evaluate(() => {
    // Description — try multiple selectors in priority order
    var description = '';
    var descEl = document.querySelector('.story-content p, #description-and-risks .full-description');
    if (descEl) {
      description = descEl.textContent.trim();
    }
    if (!description) {
      var paras = document.querySelectorAll('.story p');
      var parts = [];
      for (var i = 0; i < Math.min(paras.length, 3); i++) {
        parts.push(paras[i].textContent.trim());
      }
      description = parts.join(' ');
    }

    // Stats block: ".NS_campaigns__spotlight_stats" contains
    // "<b>N backers</b> pledged <span class="money">$X</span>"
    var statsEl = document.querySelector('.NS_campaigns__spotlight_stats');
    var statsText = statsEl ? statsEl.textContent.trim() : '';

    // Backer count — parse from stats text "2,511 backers pledged..."
    var backerText = '';
    var backerM = statsText.match(/([\d,]+)\s+backers?/i);
    if (backerM) backerText = backerM[1];
    // Fallback to individual selectors
    if (!backerText) {
      var backerEl = document.querySelector(
        '[data-backers-count], .num-backers, [class*="backers-count"]'
      );
      backerText = backerEl ? backerEl.textContent.trim() : '';
    }

    // Funding amount — parse from stats text "pledged $403,437"
    var fundText = '';
    var fundM = statsText.match(/pledged\s+[\$£€]?([\d,]+(?:\.\d+)?(?:[KMkm])?)/i);
    if (fundM) fundText = fundM[1];
    if (!fundText) {
      var fundEl = document.querySelector('.money.pledged, [data-pledged]');
      fundText = fundEl ? fundEl.textContent.trim() : '';
    }

    // Comment count from nav tab data attribute (most reliable)
    var commentCountText = '0';
    var commentTabEl = document.querySelector(
      'a[data-comments-count], a.project-nav__link--comments'
    );
    if (commentTabEl) {
      commentCountText = commentTabEl.getAttribute('data-comments-count')
        || commentTabEl.textContent.trim();
    }
    if (commentCountText === '0') {
      // Fallback to span inside comments tab link
      var spanEl = document.querySelector('a[href*="/comments"] span');
      if (spanEl) commentCountText = spanEl.textContent.trim();
    }

    // Project title
    var titleEl = document.querySelector('h1.project-name, h1');
    var title = titleEl ? titleEl.textContent.trim() : '';

    return { description, backerText, fundText, commentCountText, title };
  });
}

// ─── Kickstarter comments page ───────────────────────────────────────────────

/**
 * Scrape backer comments from /comments page.
 * Scrolls to load more comments (Kickstarter uses infinite scroll).
 */
async function scrapeProjectComments(page, projectUrl, maxComments = 60) {
  // Strip all query params — search ref params break the /comments URL
  const cleanUrl = stripQuery(projectUrl).replace(/\/$/, '');
  const commentsUrl = cleanUrl + '/comments';
  log(`[crowdfunding] comments: ${commentsUrl}`);

  await page.goto(commentsUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(2000);

  // Kickstarter's comments section is React-rendered. Navigating to /comments
  // loads the page shell; the actual comment list is injected by clicking the tab.
  try {
    await page.evaluate(() => {
      const link = document.querySelector('a.js-load-project-comments, a[data-content="comments"]');
      if (link) link.click();
    });
    await sleep(3000);
  } catch (err) {
    log(`[crowdfunding] comments tab click failed: ${err.message}`);
  }

  // Scroll to load additional batches (infinite scroll)
  let prevCount = 0;
  for (let scroll = 0; scroll < 5; scroll++) {
    const count = await page.evaluate(() =>
      document.querySelectorAll('#react-project-comments li').length
    );
    if (count >= maxComments || count === prevCount) break;
    prevCount = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);
  }

  return await page.evaluate((maxC) => {
    var comments = [];
    // Comments are rendered as <li> items inside #react-project-comments
    var els = document.querySelectorAll('#react-project-comments li');
    for (var i = 0; i < Math.min(els.length, maxC); i++) {
      var body = els[i].textContent.trim().substring(0, 500);
      if (!body || body.length < 10) continue;
      comments.push({ body, score: 1 });
    }
    return comments;
  }, maxComments);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INDIEGOGO (HTTP API — no browser required)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch active crowdfunding projects from Indiegogo's public API.
 * Returns array of campaign objects.
 */
async function iggFetchActiveProjects() {
  log('[crowdfunding-igg] fetching active projects via public API');
  try {
    await iggRateLimiter.wait();
    const data = await httpGet(IGG_HOST, `${IGG_PUBLIC_API_BASE}/getActiveCrowdfundingProjects`, {
      timeout: 20000,
      headers: { 'Accept': 'application/json' },
    });
    return data || [];
  } catch (err) {
    log(`[crowdfunding-igg] active projects fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a single campaign's details from Indiegogo's public API.
 * @param {string} urlName - The project's URL slug
 * @returns Campaign detail object or null
 */
async function iggFetchProjectDetails(urlName) {
  log(`[crowdfunding-igg] fetching project: ${urlName}`);
  try {
    await iggRateLimiter.wait();
    const data = await httpGet(
      IGG_HOST,
      `${IGG_PUBLIC_API_BASE}/getCrowdfundingProject?urlName=${encodeURIComponent(urlName)}`,
      { timeout: 20000, headers: { 'Accept': 'application/json' } },
    );
    return data || null;
  } catch (err) {
    log(`[crowdfunding-igg] project detail fetch failed for ${urlName}: ${err.message}`);
    return null;
  }
}

/**
 * Search campaigns using the Indiegogo private discover API.
 * This endpoint accepts POST requests and returns discoverable campaigns.
 * Falls back gracefully if the endpoint is unavailable.
 *
 * @param {string} query - Search term
 * @param {number} [page=1] - Page number
 * @returns Array of campaign stubs from the discover response
 */
async function iggDiscoverCampaigns(query, page = 1) {
  log(`[crowdfunding-igg] discover: query="${query}" page=${page}`);
  try {
    await iggRateLimiter.wait();
    // The discover endpoint is POST-based. We use Node https directly
    // since httpGet only supports GET requests.
    const { default: https } = await import('node:https');
    const body = JSON.stringify({
      sort: 'trending',
      project_type: 'campaign',
      project_timing: 'all',
      q: query,
      page_num: page,
      per_page: 24,
    });

    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: IGG_HOST,
        path: IGG_DISCOVER_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': REALISTIC_UA,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 20000,
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(raw);
              resolve(parsed?.response?.discoverables || []);
            } catch {
              log(`[crowdfunding-igg] discover: non-JSON response`);
              resolve([]);
            }
          } else {
            log(`[crowdfunding-igg] discover: HTTP ${res.statusCode}`);
            resolve([]);
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
      req.write(body);
      req.end();
    });
  } catch (err) {
    log(`[crowdfunding-igg] discover failed: ${err.message}`);
    return [];
  }
}

/**
 * Extract the URL slug from an Indiegogo project URL or clickthrough_url.
 * e.g. "/projects/my-cool-gadget" => "my-cool-gadget"
 *      "https://www.indiegogo.com/projects/my-cool-gadget" => "my-cool-gadget"
 */
function iggExtractSlug(urlOrPath) {
  if (!urlOrPath) return null;
  const m = urlOrPath.match(/\/projects\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * Normalize a discoverable item from the discover API into a project stub.
 */
function iggNormalizeDiscoverable(item) {
  const slug = iggExtractSlug(item.clickthrough_url || item.url || '');
  if (!slug) return null;

  return {
    slug,
    name: (item.title || item.name || slug).substring(0, 120),
    description: (item.tagline || item.blurb || item.description || '').substring(0, 300),
    url: `https://www.indiegogo.com/projects/${slug}`,
    backerCount: parseInt(item.contributions_count || item.backers_count || 0, 10),
    fundingAmount: Math.round(parseFloat(item.collected_funds || item.funds_raised_amount || 0)),
    commentCount: parseInt(item.comments_count || 0, 10),
  };
}

/**
 * Normalize a project from the public API active projects list.
 */
function iggNormalizePublicProject(item) {
  const slug = item.projectUrlName || iggExtractSlug(item.projectHomeUrl || '');
  if (!slug) return null;

  return {
    slug,
    name: (item.projectName || slug).substring(0, 120),
    description: (item.shortDescription || '').substring(0, 300),
    url: item.projectHomeUrl || `https://www.indiegogo.com/projects/${slug}`,
    backerCount: parseInt(item.backerCount || 0, 10),
    fundingAmount: Math.round(parseFloat(item.fundsGathered || 0)),
    commentCount: parseInt(item.commentCount || 0, 10),
    campaignStartDate: item.campaignStartDate || null,
    campaignEndDate: item.campaignEndDate || null,
  };
}

/**
 * Run the Indiegogo scan: discover campaigns via API, enrich with details.
 * No browser required.
 */
async function scanIndiegogo(domain, limit) {
  log(`[crowdfunding-igg] scanning domain="${domain}", limit=${limit}`);

  const projectsBySlug = new Map();

  // Strategy 1: search via the discover API using domain-related queries
  const queries = buildSearchQueries(domain);
  for (const query of queries) {
    try {
      const discoverables = await iggDiscoverCampaigns(query);
      log(`[crowdfunding-igg]   discover query="${query}" => ${discoverables.length} results`);
      for (const item of discoverables) {
        const stub = iggNormalizeDiscoverable(item);
        if (stub && !projectsBySlug.has(stub.slug)) {
          projectsBySlug.set(stub.slug, stub);
        }
      }
    } catch (err) {
      log(`[crowdfunding-igg]   discover query failed: ${err.message}`);
    }
  }

  // Strategy 2: also fetch active projects from the public API
  // and filter by domain keyword if provided
  try {
    const activeProjects = await iggFetchActiveProjects();
    const items = Array.isArray(activeProjects) ? activeProjects : [];
    log(`[crowdfunding-igg]   active projects: ${items.length}`);
    for (const item of items) {
      const stub = iggNormalizePublicProject(item);
      if (!stub) continue;
      // If domain is set, filter by keyword match in name/description
      if (domain) {
        const haystack = `${stub.name} ${stub.description}`.toLowerCase();
        const needles = domain.toLowerCase().split(/\s+/);
        const matches = needles.some(n => haystack.includes(n));
        if (!matches) continue;
      }
      if (!projectsBySlug.has(stub.slug)) {
        projectsBySlug.set(stub.slug, stub);
      }
    }
  } catch (err) {
    log(`[crowdfunding-igg]   active projects failed: ${err.message}`);
  }

  log(`[crowdfunding-igg] ${projectsBySlug.size} unique Indiegogo projects found`);

  // Enrich top candidates with full project details from the public API
  const stubs = [...projectsBySlug.values()].slice(0, Math.min(15, projectsBySlug.size));
  const enriched = [];

  for (const stub of stubs) {
    try {
      const details = await iggFetchProjectDetails(stub.slug);
      const title = details?.projectName || stub.name;
      const description = details?.shortDescription || stub.description || '';
      const backerCount = parseInt(details?.backerCount || stub.backerCount || 0, 10);
      const fundingAmount = Math.round(parseFloat(details?.fundsGathered || stub.fundingAmount || 0));
      const commentCount = parseInt(details?.commentCount || stub.commentCount || 0, 10);
      const startDate = details?.campaignStartDate || stub.campaignStartDate || null;

      // Compute created_utc from campaign start date
      let createdUtc = 0;
      if (startDate) {
        const ts = new Date(startDate).getTime();
        if (!isNaN(ts)) createdUtc = Math.floor(ts / 1000);
      }

      const post = {
        id: `igg-${stub.slug}`,
        title,
        selftext: description,
        subreddit: 'indiegogo',
        url: stub.url,
        score: backerCount || fundingAmount,
        num_comments: commentCount,
        upvote_ratio: 0,
        flair: '',
        created_utc: createdUtc,
        source: 'indiegogo',
        _backerCount: backerCount,
        _fundingAmount: fundingAmount,
      };

      const result = enrichPost(post, domain);
      if (result) {
        result._backerCount = backerCount;
        result._fundingAmount = fundingAmount;
        enriched.push(result);
      }
    } catch (err) {
      log(`[crowdfunding-igg]   enrich failed for ${stub.slug}: ${err.message}`);
    }
  }

  return enriched;
}

// ─── build queries from domain ────────────────────────────────────────────────

function buildSearchQueries(domain) {
  const queries = [];
  if (domain) {
    queries.push(domain);
    queries.push(`${domain} alternative`);
    queries.push(`${domain} problem`);
  }
  // Generic pain-signal queries that work across domains
  queries.push('frustrated annoying problem');
  queries.push('wish alternative better');
  queries.push('overpriced expensive not worth');
  return queries;
}

// ─── main scan command ────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain || '';
  const limit = args.limit || 20;
  const maxComments = args.maxComments || 60;
  const sources = parseSources(args);

  log(`[crowdfunding-scan] domain="${domain}", limit=${limit}, sources=${sources}`);

  const allEnriched = [];

  // ─── Kickstarter path (Puppeteer browser) ───────────────────────────────
  if (sources === 'kickstarter' || sources === 'both') {
    log('[crowdfunding-scan] starting Kickstarter scan (Puppeteer)');
    let browser, page;
    try {
      browser = await connectBrowser(args);
      page = await browser.newPage();
      // Set realistic UA once — avoids Cloudflare bot detection
      await page.setUserAgent(REALISTIC_UA);

      const queries = buildSearchQueries(domain);
      const projectsBySlug = new Map();

      // Phase 1: collect project stubs from search pages
      for (const query of queries) {
        log(`[crowdfunding-scan] query="${query}"`);
        try {
          const results = await scrapeKickstarterSearch(page, query);
          log(`[crowdfunding-scan]   found ${results.length} projects`);
          for (const p of results) {
            if (p.slug && !projectsBySlug.has(p.slug)) {
              projectsBySlug.set(p.slug, p);
            }
          }
        } catch (err) {
          log(`[crowdfunding-scan]   search failed: ${err.message}`);
        }
        await politeDelay();
      }

      log(`[crowdfunding-scan] ${projectsBySlug.size} unique Kickstarter projects found`);

      // Phase 2: enrich top candidates with project page + comments
      for (const [slug, stub] of projectsBySlug) {
        stub.url = stripQuery(stub.url);
      }
      const stubs = [...projectsBySlug.values()].slice(0, Math.min(15, projectsBySlug.size));

      for (const stub of stubs) {
        log(`[crowdfunding-scan] enriching: ${stub.url}`);
        try {
          const projectData = await scrapeProjectPage(page, stub.url);
          await politeDelay();

          const comments = await scrapeProjectComments(page, stub.url, maxComments);
          log(`[crowdfunding-scan]   ${comments.length} comments`);
          await politeDelay();

          const backerCount = parseCount(projectData.backerText) || stub.backerCount;
          const fundingAmount = parseFundingAmount(projectData.fundText) || stub.fundingAmount;
          const commentCount = parseCount(projectData.commentCountText) || comments.length;

          const description = projectData.description || stub.description || '';
          const commentSnippet = comments
            .slice(0, 10)
            .map(c => c.body)
            .join(' | ');
          const selftext = description + (commentSnippet ? '\n\n' + commentSnippet : '');

          const post = {
            id: stub.slug,
            title: projectData.title || stub.name,
            selftext,
            subreddit: 'kickstarter',
            url: stub.url,
            score: backerCount || fundingAmount,
            num_comments: commentCount,
            upvote_ratio: 0,
            flair: '',
            created_utc: 0,
            source: 'kickstarter',
            _comments: comments,
            _backerCount: backerCount,
            _fundingAmount: fundingAmount,
          };

          const result = enrichPost(post, domain);
          if (result) {
            result._comments = comments;
            result._backerCount = backerCount;
            result._fundingAmount = fundingAmount;
            allEnriched.push(result);
          }
        } catch (err) {
          log(`[crowdfunding-scan]   failed for ${stub.url}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`[crowdfunding-scan] Kickstarter scan failed: ${err.message}`);
      if (sources === 'kickstarter') {
        fail(`Kickstarter scan failed: ${err.message}`);
        return;
      }
      // If "both", continue to Indiegogo
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // ─── Indiegogo path (HTTP API — no browser) ─────────────────────────────
  if (sources === 'indiegogo' || sources === 'both') {
    log('[crowdfunding-scan] starting Indiegogo scan (HTTP API)');
    try {
      const iggResults = await scanIndiegogo(domain, limit);
      log(`[crowdfunding-scan] Indiegogo enriched: ${iggResults.length}`);
      allEnriched.push(...iggResults);
    } catch (err) {
      log(`[crowdfunding-scan] Indiegogo scan failed: ${err.message}`);
      if (sources === 'indiegogo') {
        fail(`Indiegogo scan failed: ${err.message}`);
        return;
      }
    }
  }

  // ─── merge and output ───────────────────────────────────────────────────
  allEnriched.sort((a, b) => b.painScore - a.painScore);
  const output = allEnriched.slice(0, limit);

  const cleaned = output.map(p => {
    const { _comments, _backerCount, _fundingAmount, ...rest } = p;
    return {
      ...rest,
      backerCount: _backerCount,
      fundingAmount: _fundingAmount,
      topComments: (_comments || []).slice(0, 5).map(c => excerpt(c.body, 150)),
    };
  });

  ok({
    mode: 'crowdfunding',
    sources: sources,
    posts: cleaned,
    stats: {
      total_enriched: allEnriched.length,
      after_filter: cleaned.length,
    },
  });
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'crowdfunding',
  description: 'Kickstarter (Puppeteer) + Indiegogo (HTTP API) — crowdfunding pain point discovery',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
crowdfunding source — Kickstarter + Indiegogo pain point discovery

Commands:
  scan        Search crowdfunding platforms for projects and backer pain signals

scan options:
  --domain <str>        Domain/keyword to search (e.g. "smart home")
  --limit <n>           Max projects in output (default: 20)
  --maxComments <n>     Max comments per Kickstarter project (default: 60)
  --sources <str>       Which platforms to scan: kickstarter, indiegogo, or both
                        (default: both)

Connection options (Kickstarter only — Indiegogo uses HTTP API):
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  pain-points kickstarter scan --domain "smart home"
  pain-points kickstarter scan --domain "smart home" --sources indiegogo
  pain-points kickstarter scan --domain "productivity app" --sources kickstarter
  pain-points kickstarter scan --domain "3d printer" --sources both --limit 10
`,
};
