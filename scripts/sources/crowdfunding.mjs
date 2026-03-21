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

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Scroll to trigger lazy loads
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await sleep(1000);

  return await page.evaluate(() => {
    var projects = [];
    // Kickstarter renders project cards with various selectors depending on layout
    var cards = document.querySelectorAll('[data-pid], .js-react-proj-card, .project-card');
    if (cards.length === 0) {
      // Try the newer React-rendered grid
      cards = document.querySelectorAll('[class*="ProjectCard"], [class*="project-card"]');
    }
    if (cards.length === 0) {
      // Fallback: any anchor whose href contains /projects/
      var links = document.querySelectorAll('a[href*="/projects/"]');
      var seen = new Set();
      for (var i = 0; i < links.length; i++) {
        var href = links[i].href;
        var m = href.match(/\/projects\/([^/]+)\/([^/?#]+)/);
        if (m && !seen.has(m[0])) {
          seen.add(m[0]);
          projects.push({
            creator: m[1],
            slug: m[2],
            url: 'https://www.kickstarter.com/projects/' + m[1] + '/' + m[2],
            name: links[i].textContent.trim().substring(0, 120) || m[2],
            description: '',
            backerCount: 0,
            fundingAmount: 0,
          });
        }
      }
      return projects;
    }

    for (var j = 0; j < cards.length; j++) {
      var card = cards[j];
      var a = card.querySelector('a[href*="/projects/"]');
      if (!a) continue;
      var href2 = a.href;
      var m2 = href2.match(/\/projects\/([^/]+)\/([^/?#]+)/);
      if (!m2) continue;

      var nameEl = card.querySelector('h3, h2, [class*="title"], [class*="name"]');
      var descEl = card.querySelector('p, [class*="desc"], [class*="blurb"]');
      var backerEl = card.querySelector('[class*="backer"], [class*="Backer"]');
      var fundEl = card.querySelector('[class*="percent"], [class*="fund"], [class*="raised"]');

      projects.push({
        creator: m2[1],
        slug: m2[2],
        url: 'https://www.kickstarter.com/projects/' + m2[1] + '/' + m2[2],
        name: nameEl ? nameEl.textContent.trim().substring(0, 120) : m2[2],
        description: descEl ? descEl.textContent.trim().substring(0, 300) : '',
        backerCount: backerEl ? parseInt(backerEl.textContent.replace(/,/g, '').match(/\d+/)?.[0] || '0', 10) : 0,
        fundingAmount: 0,
      });
    }
    return projects;
  });
}

// ─── Kickstarter project page ────────────────────────────────────────────────

/**
 * Scrape the main project page for description and funding stats.
 */
async function scrapeProjectPage(page, projectUrl) {
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  return await page.evaluate(() => {
    // Description
    var descEl = document.querySelector('#description-and-risks .full-description, [class*="description"] p, .story-content p');
    var description = descEl ? descEl.textContent.trim() : '';
    if (!description) {
      var paras = document.querySelectorAll('.story p');
      var parts = [];
      for (var i = 0; i < Math.min(paras.length, 3); i++) {
        parts.push(paras[i].textContent.trim());
      }
      description = parts.join(' ');
    }

    // Backer count
    var backerEl = document.querySelector('[class*="backers-count"], [data-backers-count], .num-backers, [class*="backer"] b');
    var backerText = backerEl ? backerEl.textContent.trim() : '';

    // Funding amount
    var fundEl = document.querySelector('[class*="pledged"], [data-pledged], .money.pledged, [class*="raised"]');
    var fundText = fundEl ? fundEl.textContent.trim() : '';

    // Comment count hint (shown in tab)
    var commentTabEl = document.querySelector('a[href*="/comments"] span, [class*="comments-count"]');
    var commentCountText = commentTabEl ? commentTabEl.textContent.trim() : '0';

    // Project title
    var titleEl = document.querySelector('h1.project-name, h1[class*="title"], h1');
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
  const commentsUrl = projectUrl.replace(/\/$/, '') + '/comments';
  log(`[crowdfunding] comments: ${commentsUrl}`);

  await page.goto(commentsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Scroll to load additional comments
  let prevCount = 0;
  for (let scroll = 0; scroll < 5; scroll++) {
    const count = await page.evaluate(() =>
      document.querySelectorAll('[class*="comment"], .comment').length
    );
    if (count >= maxComments || count === prevCount) break;
    prevCount = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);
  }

  return await page.evaluate((maxC) => {
    var comments = [];
    var els = document.querySelectorAll('[class*="comment"], .comment');
    for (var i = 0; i < Math.min(els.length, maxC); i++) {
      var el = els[i];
      // Skip reply wrappers — look for actual text nodes
      var bodyEl = el.querySelector('[class*="body"], [class*="text"], p');
      var body = bodyEl ? bodyEl.textContent.trim() : el.textContent.trim();
      body = body.substring(0, 500);
      if (!body || body.length < 10) continue;
      comments.push({ body: body, score: 1 });
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
