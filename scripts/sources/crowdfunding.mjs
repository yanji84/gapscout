/**
 * crowdfunding.mjs — Puppeteer browser source for pain-point-finder
 *
 * Scrapes Kickstarter for funded projects and backer comments.
 * Connects to an existing Chrome instance (e.g. from puppeteer-mcp-server)
 * or accepts --ws-url / --port.
 */

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { sleep, log, ok, fail, excerpt } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const KICKSTARTER = 'https://www.kickstarter.com';
const PAGE_DELAY_MS = 3000;
const JITTER_MS = 1000;

async function politeDelay() {
  await sleep(PAGE_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

// ─── browser connection ─────────────────────────────────────────────────────
// Copied from reddit-browser.mjs

async function findChromeWSEndpoint() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpdir = os.default.tmpdir();
  const entries = fs.default.readdirSync(tmpdir);
  for (const entry of entries) {
    if (entry.startsWith('puppeteer_dev_chrome_profile')) {
      const portFile = path.default.join(tmpdir, entry, 'DevToolsActivePort');
      if (fs.default.existsSync(portFile)) {
        const content = fs.default.readFileSync(portFile, 'utf8').trim();
        const lines = content.split('\n');
        if (lines.length >= 2) {
          const port = lines[0].trim();
          const wsPath = lines[1].trim();
          const wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
          log(`[browser] found Chrome at ${wsUrl}`);
          return wsUrl;
        }
      }
    }
  }
  return null;
}

function getWSFromPort(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body).webSocketDebuggerUrl); }
        catch (err) { reject(new Error(`Cannot parse Chrome debug info: ${err.message}`)); }
      });
    }).on('error', reject);
  });
}

async function connectBrowser(args) {
  if (args.wsUrl) {
    log(`[browser] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }
  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[browser] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }
  const wsUrl = await findChromeWSEndpoint();
  if (wsUrl) {
    try { return await puppeteer.connect({ browserWSEndpoint: wsUrl }); }
    catch (err) { log(`[browser] auto-detect failed: ${err.message}`); }
  }
  fail('No Chrome browser found. Start puppeteer-mcp-server, or pass --ws-url / --port');
}

const REALISTIC_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

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

  log(`[crowdfunding-scan] domain="${domain}", limit=${limit}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();
  // Set realistic UA once — avoids Cloudflare bot detection without repeated protocol calls
  await page.setUserAgent(REALISTIC_UA);

  try {
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

    log(`[crowdfunding-scan] ${projectsBySlug.size} unique projects found`);

    // Phase 2: enrich top candidates with project page + comments
    // Ensure all URLs are canonical (no query params) before fetching
    for (const [slug, stub] of projectsBySlug) {
      stub.url = stripQuery(stub.url);
    }
    const stubs = [...projectsBySlug.values()].slice(0, Math.min(15, projectsBySlug.size));
    const enriched = [];

    for (const stub of stubs) {
      log(`[crowdfunding-scan] enriching: ${stub.url}`);
      try {
        // Scrape project page for richer description/stats
        const projectData = await scrapeProjectPage(page, stub.url);
        await politeDelay();

        // Scrape comments
        const comments = await scrapeProjectComments(page, stub.url, maxComments);
        log(`[crowdfunding-scan]   ${comments.length} comments`);
        await politeDelay();

        const backerCount = parseCount(projectData.backerText) || stub.backerCount;
        const fundingAmount = parseFundingAmount(projectData.fundText) || stub.fundingAmount;
        const commentCount = parseCount(projectData.commentCountText) || comments.length;

        // Combine project description with top comments for body text
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
          // Attach comments for deep analysis downstream
          _comments: comments,
          _backerCount: backerCount,
          _fundingAmount: fundingAmount,
        };

        const result = enrichPost(post, domain);
        if (result) {
          result._comments = comments;
          result._backerCount = backerCount;
          result._fundingAmount = fundingAmount;
          enriched.push(result);
        }
      } catch (err) {
        log(`[crowdfunding-scan]   failed for ${stub.url}: ${err.message}`);
      }
    }

    enriched.sort((a, b) => b.painScore - a.painScore);
    const output = enriched.slice(0, limit);

    // Strip internal _fields from final output
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
      posts: cleaned,
      stats: {
        queries: queries.length,
        raw_projects: projectsBySlug.size,
        enriched: enriched.length,
        after_filter: cleaned.length,
      },
    });
  } finally {
    await page.close();
  }
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'crowdfunding',
  description: 'Puppeteer browser — Kickstarter project scraping for backer pain points',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
crowdfunding source — Kickstarter backer pain point scraping

Commands:
  scan        Search Kickstarter for projects and scrape backer comments

scan options:
  --domain <str>        Domain/keyword to search (e.g. "smart home")
  --limit <n>           Max projects in output (default: 20)
  --maxComments <n>     Max comments per project (default: 60)

Connection options:
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  pain-points kickstarter scan --domain "smart home"
  pain-points kickstarter scan --domain "productivity app" --limit 10
`,
};
