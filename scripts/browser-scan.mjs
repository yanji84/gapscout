#!/usr/bin/env node

/**
 * browser-scan.mjs
 *
 * Browser-based pain point discovery on Reddit via Puppeteer.
 * Connects to an existing Chrome instance (e.g. from puppeteer-mcp-server)
 * or launches a new one. Scrapes old.reddit.com for real-time data.
 *
 * Subcommands: scan, deep-dive
 *
 * Output format matches pain-points.mjs:
 *   { ok: true,  data: { ... } }
 *   { ok: false, error: { message, details? } }
 */

import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';

// ─── constants ───────────────────────────────────────────────────────────────

const OLD_REDDIT = 'https://old.reddit.com';
const PAGE_DELAY_MS = 2000; // polite delay between page loads
const JITTER_MS = 500;
const MAX_PAGES_PER_RUN = 50;

// ─── pain signal keywords (shared with pain-points.mjs) ─────────────────────

const PAIN_SIGNALS = {
  frustration: [
    'frustrated', 'frustrating', 'annoying', 'annoyed',
    'fed up', 'sick of', 'tired of', 'giving up', 'nightmare',
    'terrible', 'awful', 'broken', 'buggy', 'unusable',
    'horrible', 'worst', 'garbage', 'trash', 'joke',
    'hate', 'ruining', 'killing', 'destroying',
  ],
  desire: [
    'wish there was', 'looking for', 'alternative to',
    'switched from', 'better than', 'anything else',
    'does anyone know', 'recommendations for',
    'is there a', 'need something',
  ],
  cost: [
    'too expensive', 'price hike', 'overpriced', 'not worth',
    'hidden fees', 'ripoff', 'rip off', 'gouging',
    'cost went up', 'raised prices',
  ],
  agreement: [
    'same here', 'me too', 'can confirm', 'exactly this',
    'this is why', 'i had the same', 'happened to me',
    'i agree', 'so true', "couldn't agree more",
    'yep same', 'deal breaker for me too',
  ],
  solution: [
    'i switched to', 'i ended up using', 'the workaround is',
    'i built my own', 'i just use', 'try using',
    'we moved to', 'what worked for me', 'i found that',
    'we use', 'i use', 'we went with', 'i went with',
    'check out', 'look into', 'have you tried',
  ],
  willingness_to_pay: [
    'paid for', 'paying for', 'bought', 'purchased', 'subscribed',
    'subscription', 'hired', 'consultant', 'freelancer',
    'wasted hours', 'wasted days', 'wasted weeks', 'spent hours',
    'spent days', 'worth paying', 'shut up and take my money',
    'take my money', 'would pay', "i'd pay", 'happy to pay',
    'gladly pay', 'budget for', 'invested in', 'cost me',
    'money on', 'dollars on', 'per month', 'per year',
    'annual plan', 'monthly plan', 'enterprise plan', 'pro plan',
  ],
  intensity: [
    'literally', 'absolutely', 'completely', 'utterly',
    'beyond frustrated', 'pulling my hair', 'losing my mind',
    'want to scream', 'at my wits end', "can't take it",
    'last straw', 'final straw', 'deal breaker', 'dealbreaker',
    'unacceptable', 'inexcusable', 'ridiculous', 'insane',
    'blows my mind', 'how is this', 'why is this so',
    'every single time', 'constantly', 'always breaks',
    'never works', 'still broken', 'years and still',
  ],
};

const EXPANDED_AGREEMENT = [
  'absolutely', 'this exactly', '+1', 'yup', 'ugh same', 'preach',
  'for real', 'right?', 'totally', 'tell me about it', 'story of my life',
  'facts', 'this right here', 'nailed it', 'spot on', '100%',
  'the worst part', 'and on top of that', 'not to mention',
  'yeah the', 'yep the', 'seriously', 'no kidding',
];

const PAIN_FLAIRS = new Set([
  'rant', 'complaint', 'help', 'vent', 'venting', 'frustrated',
  'issue', 'problem', 'bug', 'support',
]);

const POSITIVE_CONTEXT = [
  'happy', 'glad', 'love', 'great', 'best', 'worth it', 'no issues',
  'no problems', 'amazing', 'perfect', 'excellent', 'fantastic',
  'recommend', 'impressed', 'enjoy', 'smooth', 'solid',
];
const NEGATIVE_CONTEXT = [
  'hate', 'regret', 'waste', 'terrible', 'awful', 'not worth',
  'unfortunately', 'disappointed', 'annoying', 'broken', 'sucks',
  'horrible', 'useless', 'worse', 'painful', 'unacceptable',
];

const NON_PAIN_TITLE_SIGNALS = [
  'tips', 'workflow', 'share your', 'appreciation', 'guide',
  'how i built', 'my setup', 'what are you using', 'best practices',
  'release', 'update:', 'announcement', 'unpopular opinion',
  'showcase', 'show off', 'just finished', 'proud of', 'tutorial',
  'resource', 'cheat sheet', 'comparison', 'review:',
  'how to', 'strategy', 'climbing to', 'deck list', 'tier list',
  'what deck', 'which deck', 'where did everyone',
  // R2: TCG/hobby-specific non-pain signals
  'deck discussion', 'discussion thread', 'regionals', 'tournament results',
  'card art', 'my pulls', 'just pulled', 'check out this', 'look at this',
  'sold too early', 'sold too late', 'what is your', "what's yours",
  'recap', 'results from', 'data says', 'what the data',
  'giveaway', 'drop your', 'comment your', 'favorite',
  'worst looking', 'best looking', 'coolest',
  // R3: celebration/positive posts and writeups
  'just got into', 'first booster', 'look what i got', 'so happy',
  'my collection', 'haul', 'writeup', 'meta thoughts', 'random thoughts',
  'not terrible', 'convert this', 'convert me',
];
const NON_PAIN_FLAIRS = new Set([
  'appreciation', 'resources', 'tips', 'showcase', 'release',
  'announcement', 'meta', 'discussion', 'tutorial', 'guide',
  'deck', 'pulls', 'meme', 'humor', 'art', 'collection',
]);

const WTP_STRONG = new Set([
  'would pay', "i'd pay", 'happy to pay', 'shut up and take my money',
  'take my money', 'worth paying', 'gladly pay', 'budget for',
]);

// R2: Generic commerce words that only count as WTP when near pain/solution context
const WTP_GENERIC = new Set([
  'bought', 'purchased', 'paid for', 'paying for', 'subscribed',
  'subscription', 'per month', 'per year',
]);

function isWtpContextual(text, kwIndex) {
  if (!text) return false;
  const start = Math.max(0, kwIndex - 100);
  const end = Math.min(text.length, kwIndex + 100);
  const window = text.slice(start, end).toLowerCase();
  // Only count generic WTP if near a pain or solution keyword
  const contextWords = [
    'frustrated', 'annoying', 'terrible', 'broken', 'hate', 'awful',
    'alternative', 'switched', 'workaround', 'fix', 'solution',
    'wasted', 'waste of', 'not worth', 'overpriced', 'ripoff',
  ];
  return contextWords.some(w => window.includes(w));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

function ok(data) {
  console.log(JSON.stringify({ ok: true, data }, null, 2));
}

function fail(message, details) {
  console.log(JSON.stringify({ ok: false, error: { message, details } }, null, 2));
  process.exit(1);
}

function excerpt(text, maxLen = 200) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).trim() + '...';
}

async function politeDelay() {
  const delay = PAGE_DELAY_MS + Math.floor(Math.random() * JITTER_MS);
  await sleep(delay);
}

// ─── scoring functions (mirrored from pain-points.mjs) ──────────────────────

function matchSignals(text, category) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return PAIN_SIGNALS[category].filter(kw => lower.includes(kw));
}

function sentimentMultiplier(text, keywordIndex, windowSize = 80) {
  if (!text) return 1.0;
  const start = Math.max(0, keywordIndex - windowSize);
  const end = Math.min(text.length, keywordIndex + windowSize);
  const window = text.slice(start, end).toLowerCase();
  const posHits = POSITIVE_CONTEXT.filter(w => window.includes(w)).length;
  const negHits = NEGATIVE_CONTEXT.filter(w => window.includes(w)).length;
  if (posHits > negHits) return 0.2;
  if (negHits > posHits) return 1.5;
  return 1.0;
}

// R3: negation detection — skip signals preceded by negation words
const NEGATION_WORDS = ['not', 'no', "n't", 'never', 'neither', 'nor', 'without', 'barely'];

function isNegated(text, keywordIndex) {
  if (!text || keywordIndex < 3) return false;
  const before = text.slice(Math.max(0, keywordIndex - 20), keywordIndex).toLowerCase();
  return NEGATION_WORDS.some(neg => before.includes(neg));
}

function matchSignalsWeighted(text, category) {
  if (!text) return { keywords: [], weight: 0 };
  const lower = text.toLowerCase();
  let totalWeight = 0;
  const keywords = [];
  for (const kw of PAIN_SIGNALS[category]) {
    const idx = lower.indexOf(kw);
    if (idx >= 0) {
      // R3: skip negated signals
      if (isNegated(lower, idx)) continue;
      const mult = sentimentMultiplier(lower, idx);
      totalWeight += mult;
      keywords.push(kw);
    }
  }
  return { keywords, weight: totalWeight };
}

// R3: also apply negation to simple matchSignals
function matchSignalsFiltered(text, category) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return PAIN_SIGNALS[category].filter(kw => {
    const idx = lower.indexOf(kw);
    return idx >= 0 && !isNegated(lower, idx);
  });
}

function computeIntensity(text) {
  if (!text) return 0;
  const matches = matchSignals(text, 'intensity');
  if (matches.length >= 3) return 3;
  if (matches.length >= 2) return 2;
  if (matches.length >= 1) return 1;
  return 0;
}

function computePainScore(post) {
  const title = post.title || '';
  const body = post.selftext || '';
  const fullText = title + ' ' + body;
  const titleLower = title.toLowerCase();

  const titleFrust = matchSignalsWeighted(title, 'frustration');
  const titleDesire = matchSignalsWeighted(title, 'desire');
  const titleCost = matchSignalsWeighted(title, 'cost');
  const bodyFrust = matchSignalsWeighted(body, 'frustration');
  const bodyDesire = matchSignalsWeighted(body, 'desire');
  const bodyCost = matchSignalsWeighted(body, 'cost');

  // R3: cap body signal contribution to prevent long posts from dominating
  const bodyWeight = bodyFrust.weight + bodyDesire.weight + bodyCost.weight;
  const cappedBodyWeight = Math.min(4.0, bodyWeight); // max 4 points from body signals

  const painWeight = (titleFrust.weight + titleDesire.weight + titleCost.weight) * 2.0
    + cappedBodyWeight * 1.0;

  let score = painWeight;

  // R2: reduced engagement cap from 4.0 to 2.5 so pain language drives ranking
  const engagementScore = Math.log2((post.num_comments || 0) + 1) * 0.8
    + Math.log2((post.score || 0) + 1) * 0.4;
  score += Math.min(2.5, engagementScore);

  if (post.upvote_ratio) {
    score += Math.max(0, (post.upvote_ratio - 0.7)) * 3.0;
  }

  const flair = (post.flair || '').toLowerCase();
  if (PAIN_FLAIRS.has(flair)) score += 1.5;

  // R2: context-aware WTP — generic commerce words only count near pain/solution context
  const wtpMatches = matchSignals(fullText, 'willingness_to_pay');
  const effectiveWtpMatches = [];
  for (const kw of wtpMatches) {
    const idx = fullText.toLowerCase().indexOf(kw);
    const sentMult = sentimentMultiplier(fullText, idx);
    if (WTP_STRONG.has(kw)) {
      score += 3.0 * sentMult;
      effectiveWtpMatches.push(kw);
    } else if (WTP_GENERIC.has(kw)) {
      // Only count generic WTP if near pain/solution context
      if (isWtpContextual(fullText, idx)) {
        score += 0.5 * sentMult;
        effectiveWtpMatches.push(kw);
      }
      // else: skip — generic commerce word without pain context
    } else {
      score += 0.5 * sentMult;
      effectiveWtpMatches.push(kw);
    }
  }

  const intensity = computeIntensity(fullText);
  if (painWeight > 0) {
    score += intensity * 1.5;
  }

  const hasNonPainTitle = NON_PAIN_TITLE_SIGNALS.some(s => titleLower.includes(s));
  if (hasNonPainTitle) score -= 4.0;
  const hasNonPainFlair = [...NON_PAIN_FLAIRS].some(f => flair.includes(f));
  if (hasNonPainFlair) score -= 2.0;

  // R2: increased penalty from -5 to -8 for zero-pain posts, uses effective WTP
  if (painWeight === 0 && effectiveWtpMatches.length === 0) {
    score -= 8.0;
  }

  return Math.round(score * 10) / 10;
}

function analyzeComments(comments, postPainCategories = []) {
  let agreementCount = 0;
  let thematicAgreementCount = 0;
  const agreements = [];
  const solutions = [];
  const mentionedTools = new Set();
  const topQuotes = [];
  const moneyTrail = [];
  let intensityTotal = 0;

  const sorted = [...comments].sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const c of sorted) {
    const body = (c.body || '').trim();
    if (!body || body === '[deleted]' || body === '[removed]') continue;

    const agreeMatches = matchSignals(body, 'agreement');
    const expandedMatches = EXPANDED_AGREEMENT.filter(kw => body.toLowerCase().includes(kw));
    const allAgreeMatches = [...agreeMatches, ...expandedMatches];
    if (allAgreeMatches.length > 0) {
      const upvoteWeight = Math.max(1, Math.log2((c.score || 1) + 1));
      agreementCount += upvoteWeight;
      agreements.push({ body: excerpt(body, 150), score: c.score || 0, signals: allAgreeMatches });
    }

    if (postPainCategories.length > 0) {
      const commentCategories = new Set();
      if (matchSignals(body, 'frustration').length) commentCategories.add('frustration');
      if (matchSignals(body, 'desire').length) commentCategories.add('desire');
      if (matchSignals(body, 'cost').length) commentCategories.add('cost');
      const overlap = postPainCategories.filter(c => commentCategories.has(c));
      if (overlap.length > 0) thematicAgreementCount++;
    }

    const solutionMatches = matchSignals(body, 'solution');
    if (solutionMatches.length > 0) {
      solutions.push({ body: excerpt(body, 200), score: c.score || 0, signals: solutionMatches });

      const TOOL_NOISE = new Set([
        'I', 'It', 'The', 'This', 'That', 'My', 'We', 'They', 'But', 'And',
        'Or', 'So', 'If', 'Is', 'Was', 'Are', 'Not', 'For', 'You', 'Your',
        'Just', 'Also', 'Been', 'Have', 'Has', 'Had', 'Very', 'Really',
        'MIL', 'DIY', 'OP', 'PSA', 'TBH', 'IMO', 'FWIW', 'TIL',
        'AI', 'API', 'LLM', 'LLMs', 'IDE', 'MVC', 'REST', 'SQL', 'CLI',
        'UI', 'UX', 'PR', 'CI', 'CD', 'HTTP', 'SSH', 'CSS', 'HTML',
        'Honestly', 'Actually', 'Basically', 'Generally', 'Recently',
        'Unfortunately', 'Personally', 'Obviously', 'Apparently',
      ]);
      const lower = body.toLowerCase();
      for (const kw of solutionMatches) {
        const idx = lower.indexOf(kw);
        if (idx >= 0) {
          const after = body.slice(idx + kw.length, idx + kw.length + 50);
          const toolMatch = after.match(/\s+([A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)?)/);
          if (toolMatch) {
            const name = toolMatch[1].trim();
            if (!TOOL_NOISE.has(name) && name.length > 1) {
              mentionedTools.add(name);
            }
          }
        }
      }
    }

    const painMatches = [
      ...matchSignals(body, 'frustration'),
      ...matchSignals(body, 'desire'),
      ...matchSignals(body, 'cost'),
    ];
    if (painMatches.length > 0 && (c.score || 0) >= 2) {
      topQuotes.push({ body: excerpt(body, 200), score: c.score || 0, signals: painMatches });
    }

    const wtpMatches = matchSignals(body, 'willingness_to_pay');
    if (wtpMatches.length > 0) {
      moneyTrail.push({ body: excerpt(body, 200), score: c.score || 0, signals: wtpMatches });
    }

    intensityTotal += computeIntensity(body);
  }

  const validComments = comments.filter(c => {
    const b = (c.body || '').trim();
    return b && b !== '[deleted]' && b !== '[removed]';
  });

  const agreementRatio = validComments.length > 0
    ? Math.round((agreementCount / validComments.length) * 100) / 100
    : 0;
  const thematicRatio = validComments.length > 0
    ? Math.round((thematicAgreementCount / validComments.length) * 100) / 100
    : 0;
  const combinedAgreement = agreementCount + thematicAgreementCount * 0.5;
  const combinedRatio = validComments.length > 0
    ? Math.round((combinedAgreement / validComments.length) * 100) / 100
    : 0;

  let validationStrength;
  if (combinedRatio > 0.20 && combinedAgreement >= 8) validationStrength = 'strong';
  else if (combinedRatio > 0.10 && combinedAgreement >= 4) validationStrength = 'moderate';
  else if (combinedRatio > 0.05 || combinedAgreement >= 2) validationStrength = 'weak';
  else validationStrength = 'anecdotal';

  const avgIntensity = validComments.length > 0
    ? Math.round((intensityTotal / validComments.length) * 100) / 100
    : 0;
  let intensityLevel;
  if (avgIntensity >= 1.5) intensityLevel = 'extreme';
  else if (avgIntensity >= 0.8) intensityLevel = 'high';
  else if (avgIntensity >= 0.3) intensityLevel = 'moderate';
  else intensityLevel = 'low';

  return {
    totalComments: validComments.length,
    agreementCount: Math.round(agreementCount * 10) / 10,
    agreementRatio,
    thematicAgreementCount,
    thematicRatio,
    combinedAgreement: Math.round(combinedAgreement * 10) / 10,
    validationStrength,
    intensityLevel,
    avgIntensity,
    moneyTrailCount: moneyTrail.length,
    topQuotes: topQuotes.slice(0, 5),
    agreements: agreements.slice(0, 5),
    solutionAttempts: solutions.slice(0, 10),
    moneyTrail: moneyTrail.slice(0, 10),
    mentionedTools: [...mentionedTools].slice(0, 15),
  };
}

// ─── browser connection ─────────────────────────────────────────────────────

async function findChromeWSEndpoint() {
  // Look for DevToolsActivePort files from puppeteer sessions
  const glob = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpdir = os.default.tmpdir();

  // Scan /tmp for puppeteer profile dirs
  const entries = glob.default.readdirSync(tmpdir);
  for (const entry of entries) {
    if (entry.startsWith('puppeteer_dev_chrome_profile')) {
      const portFile = path.default.join(tmpdir, entry, 'DevToolsActivePort');
      if (glob.default.existsSync(portFile)) {
        const content = glob.default.readFileSync(portFile, 'utf8').trim();
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

async function connectBrowser(args) {
  // Priority: --ws-url > --port > auto-detect > launch new
  if (args.wsUrl) {
    log(`[browser] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }

  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[browser] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }

  // Auto-detect existing Chrome
  const wsUrl = await findChromeWSEndpoint();
  if (wsUrl) {
    try {
      return await puppeteer.connect({ browserWSEndpoint: wsUrl });
    } catch (err) {
      log(`[browser] auto-detect connection failed: ${err.message}`);
    }
  }

  fail('No Chrome browser found. Either:\n' +
    '  1. Start puppeteer-mcp-server (it launches Chrome automatically)\n' +
    '  2. Pass --ws-url <websocket_url>\n' +
    '  3. Pass --port <debug_port>');
}

function getWSFromPort(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.webSocketDebuggerUrl);
        } catch (err) {
          reject(new Error(`Cannot parse Chrome debug info: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ─── browser scraping functions ─────────────────────────────────────────────

async function scrapeSearchResults(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1000); // let page settle

  const posts = await page.evaluate(() => {
    var posts = [];
    var els = document.querySelectorAll('.search-result-link');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var a = el.querySelector('a.search-title');
      var meta = el.querySelector('.search-result-meta');
      var body = el.querySelector('.search-result-body');

      // Parse meta: "5,214 points 1,112 comments submitted 10 months ago by User to r/Sub"
      var metaText = meta ? meta.textContent.trim() : '';
      var pointsMatch = metaText.match(/([\d,]+)\s+point/);
      var commentsMatch = metaText.match(/([\d,]+)\s+comment/);
      var subredditMatch = metaText.match(/to\s+r\/(\w+)/);
      var userMatch = metaText.match(/by\s+(\S+)/);

      // Extract post ID from URL
      var href = a ? a.href : '';
      var idMatch = href.match(/\/comments\/([a-z0-9]+)/i);

      posts.push({
        id: idMatch ? idMatch[1] : '',
        title: a ? a.textContent.trim() : '',
        url: href,
        score: pointsMatch ? parseInt(pointsMatch[1].replace(/,/g, ''), 10) : 0,
        num_comments: commentsMatch ? parseInt(commentsMatch[1].replace(/,/g, ''), 10) : 0,
        subreddit: subredditMatch ? subredditMatch[1] : '',
        author: userMatch ? userMatch[1] : '',
        selftext: body ? body.textContent.trim() : '',
        flair: '',
      });
    }
    return posts;
  });

  return posts;
}

async function scrapePostComments(page, postUrl, maxComments = 200) {
  // Use old.reddit.com URL and request all comments
  let url = postUrl.replace('www.reddit.com', 'old.reddit.com');
  if (!url.includes('old.reddit.com')) {
    url = url.replace('reddit.com', 'old.reddit.com');
  }
  // Add ?limit=500 to get more comments
  url = url.replace(/\?.*$/, '') + '?limit=500';

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  const data = await page.evaluate((maxC) => {
    // Get post body
    var postBody = '';
    var expandoEl = document.querySelector('.expando .md');
    if (expandoEl) postBody = expandoEl.textContent.trim();

    // Get post flair
    var flairEl = document.querySelector('.linkflair-text, .flair');
    var flair = flairEl ? flairEl.textContent.trim() : '';

    // Get comments
    var comments = [];
    var els = document.querySelectorAll('.comment');
    for (var i = 0; i < Math.min(els.length, maxC); i++) {
      var el = els[i];
      var mdEl = el.querySelector('.md');
      if (!mdEl) continue;

      var scoreEl = el.querySelector('.score.unvoted');
      var scoreText = scoreEl ? scoreEl.textContent.trim() : '1 point';
      var scoreMatch = scoreText.match(/([\-\d]+)\s+point/);
      var score = scoreMatch ? parseInt(scoreMatch[1], 10) : 1;

      comments.push({
        body: mdEl.textContent.trim().substring(0, 500),
        score: score,
      });
    }
    return { postBody: postBody, flair: flair, comments: comments };
  }, maxComments);

  return data;
}

// ─── subcommand: browser-scan ───────────────────────────────────────────────

async function cmdBrowserScan(args) {
  const subreddits = args.subreddits;
  if (!subreddits || !subreddits.length) fail('--subreddits is required (comma-separated)');

  const domain = args.domain || '';
  const limit = args.limit || 30;
  const timeFilter = args.time || 'year'; // hour, day, week, month, year, all
  const minComments = args.minComments || 3;

  log(`[browser-scan] subreddits=${subreddits.join(',')}, domain="${domain}", time=${timeFilter}, limit=${limit}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();
  let pagesLoaded = 0;

  try {
    // R2: expanded search queries covering more pain categories
    const searchQueries = [
      'frustrated OR annoying OR terrible OR hate OR overpriced',
      'alternative OR switched OR wish OR looking for',
      'expensive OR ripoff OR gouging OR not worth',
      'nightmare OR broken OR unusable OR giving up',
      // R2: new pain categories
      'scam OR fake OR counterfeit OR resealed OR tampered',
      'shipping damage OR damaged OR lost in mail',
      'quit OR quitting OR done with OR leaving the hobby',
      'scalper OR scalping OR sold out OR out of stock',
    ];

    // Add domain-specific queries
    if (domain) {
      searchQueries.push(`${domain} frustrated OR terrible OR hate`);
      searchQueries.push(`${domain} alternative OR switched OR wish`);
    }

    // R2: also search with sort=relevance for a second pass
    const sortModes = ['comments', 'relevance'];

    const postsById = new Map();

    for (const sub of subreddits) {
      for (const sortMode of sortModes) {
        for (const query of searchQueries) {
          if (pagesLoaded >= MAX_PAGES_PER_RUN) {
            log(`[browser-scan] max pages reached (${MAX_PAGES_PER_RUN}), stopping`);
            break;
          }

          const encodedQuery = encodeURIComponent(query);
          const url = `${OLD_REDDIT}/r/${sub}/search?q=${encodedQuery}&restrict_sr=on&sort=${sortMode}&t=${timeFilter}`;

          log(`[browser-scan] r/${sub} sort=${sortMode} q="${query.substring(0, 40)}..."`);

          try {
            const posts = await scrapeSearchResults(page, url);
            pagesLoaded++;

            for (const p of posts) {
              if (p.id && !postsById.has(p.id)) {
                postsById.set(p.id, p);
              }
            }

            log(`[browser-scan]   found ${posts.length} posts (${postsById.size} total unique)`);
          } catch (err) {
            log(`[browser-scan]   failed: ${err.message} — skipping`);
          }

          await politeDelay();
        }
      }
    }

    log(`[browser-scan] ${postsById.size} unique posts after dedup`);

    // Score and filter
    const domainLower = domain.toLowerCase();
    const domainWords = domainLower.split(/\s+/).filter(w => w.length > 2);

    const scored = [];
    for (const post of postsById.values()) {
      if ((post.num_comments || 0) < minComments) continue;

      let painScore = computePainScore(post);

      // domain relevance boost/penalty
      if (domain) {
        const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
        const hasDomain = domainWords.some(w => text.includes(w));
        if (hasDomain) {
          painScore += 3.0;
        } else {
          painScore -= 2.0;
        }
      }

      const fullText = (post.title || '') + ' ' + (post.selftext || '');
      const titleSignals = [
        ...matchSignals(post.title, 'frustration'),
        ...matchSignals(post.title, 'desire'),
        ...matchSignals(post.title, 'cost'),
      ];
      // R2: also capture body pain signals
      const bodySignals = [
        ...matchSignals(post.selftext, 'frustration'),
        ...matchSignals(post.selftext, 'desire'),
        ...matchSignals(post.selftext, 'cost'),
      ];
      const allPainSignals = [...new Set([...titleSignals, ...bodySignals])];
      const wtpSignals = matchSignals(fullText, 'willingness_to_pay');
      const intensity = computeIntensity(fullText);

      // R3: fine-grained pain subcategories
      const painCategories = [];
      if (matchSignals(fullText, 'frustration').length) painCategories.push('frustration');
      if (matchSignals(fullText, 'desire').length) painCategories.push('desire');
      if (matchSignals(fullText, 'cost').length) painCategories.push('cost');
      if (matchSignals(fullText, 'willingness_to_pay').length) painCategories.push('wtp');

      // R3: subcategories based on content keywords
      const painSubcategories = [];
      const ftLower = fullText.toLowerCase();
      if (/scalp|sold out|out of stock|restock|can't find|wiped out/.test(ftLower)) painSubcategories.push('product-availability');
      if (/expensive|overpriced|price|cost|ripoff|goug/.test(ftLower)) painSubcategories.push('pricing');
      if (/scam|fake|counterfeit|reseal|tamper/.test(ftLower)) painSubcategories.push('fraud');
      if (/toxic|rude|harass|threaten|bully|cheat/.test(ftLower)) painSubcategories.push('community-toxicity');
      if (/pokemon company|tpc|tpci|nintendo|print run|reprint/.test(ftLower)) painSubcategories.push('company-policy');
      if (/shipping|damage|lost|fedex|ups|usps/.test(ftLower)) painSubcategories.push('shipping');
      if (/grading|psa|cgc|beckett|tag |slab/.test(ftLower)) painSubcategories.push('grading');
      if (/app|ptcg live|client|online|digital/.test(ftLower)) painSubcategories.push('digital-platform');
      if (/quit|leaving|done with|burnout|burnt out|burn out|giving up/.test(ftLower)) painSubcategories.push('hobby-burnout');

      // R2: hard filter — exclude posts with zero pain signals in title+body
      // unless they have strong WTP signals (genuine intent to pay for a solution)
      const hasStrongWtp = wtpSignals.some(kw => WTP_STRONG.has(kw));
      if (allPainSignals.length === 0 && !hasStrongWtp) {
        continue; // skip this post entirely
      }

      // R3: if only signal is "looking for" with no frustration context, skip
      if (allPainSignals.length === 1 && allPainSignals[0] === 'looking for') {
        const hasFrustration = matchSignals(fullText, 'frustration').length > 0;
        const hasCost = matchSignals(fullText, 'cost').length > 0;
        if (!hasFrustration && !hasCost) continue;
      }

      // R3: minimum engagement floor — very low engagement posts are likely noise
      if ((post.score || 0) < 5 && (post.num_comments || 0) < 10) {
        // Only keep if it has strong pain signals (2+ keywords)
        if (allPainSignals.length < 2) continue;
      }

      painScore = Math.round(painScore * 10) / 10;

      scored.push({
        id: post.id,
        title: post.title || '',
        subreddit: post.subreddit || '',
        url: post.url,
        score: post.score || 0,
        num_comments: post.num_comments || 0,
        selftext_excerpt: excerpt(post.selftext, 200),
        painScore,
        painSignals: [...new Set(titleSignals)],
        bodyPainSignals: [...new Set(bodySignals)],
        painCategories,
        painSubcategories,
        wtpSignals,
        intensity,
        flair: post.flair || null,
      });
    }

    scored.sort((a, b) => b.painScore - a.painScore);
    const topPosts = scored.slice(0, limit);

    ok({
      mode: 'browser',
      posts: topPosts,
      stats: {
        subreddits: subreddits.length,
        pages_loaded: pagesLoaded,
        raw_posts: postsById.size,
        after_filter: topPosts.length,
      },
    });
  } finally {
    await page.close();
    // Don't close browser — it may be shared with MCP server
  }
}

// ─── subcommand: browser-deep-dive ──────────────────────────────────────────

async function cmdBrowserDeepDive(args) {
  const postUrls = [];

  if (args.post) {
    // Single post URL or ID
    let url = args.post;
    if (!url.startsWith('http')) {
      url = `${OLD_REDDIT}/comments/${url}`;
    }
    postUrls.push(url);
  } else if (args.fromScan) {
    // Read scan results from file
    let scanData;
    try {
      const raw = readFileSync(args.fromScan, 'utf8');
      scanData = JSON.parse(raw);
    } catch (err) {
      fail(`Cannot read scan file: ${err.message}`);
    }
    const posts = scanData?.data?.posts || scanData?.posts || [];
    const top = args.top || 10;
    for (const p of posts.slice(0, top)) {
      if (p.url) postUrls.push(p.url);
      else if (p.id) postUrls.push(`${OLD_REDDIT}/comments/${p.id}`);
    }
  } else if (args.fromStdin) {
    let input = '';
    const { stdin } = await import('node:process');
    for await (const chunk of stdin) {
      input += chunk;
    }
    try {
      const scanData = JSON.parse(input);
      const posts = scanData?.data?.posts || scanData?.posts || [];
      const top = args.top || 10;
      for (const p of posts.slice(0, top)) {
        if (p.url) postUrls.push(p.url);
        else if (p.id) postUrls.push(`${OLD_REDDIT}/comments/${p.id}`);
      }
    } catch (err) {
      fail(`Cannot parse stdin JSON: ${err.message}`);
    }
  } else {
    fail('--post <url|id> or --from-scan <file> or --stdin is required');
  }

  const maxComments = args.maxComments || 200;

  log(`[browser-deep-dive] ${postUrls.length} post(s), maxComments=${maxComments}`);

  const browser = await connectBrowser(args);
  const page = await browser.newPage();

  try {
    const results = [];

    for (const postUrl of postUrls) {
      log(`[browser-deep-dive] scraping ${postUrl}`);

      try {
        const data = await scrapePostComments(page, postUrl, maxComments);

        // Build post metadata from the page
        const postTitle = await page.evaluate(() => {
          var el = document.querySelector('a.title');
          return el ? el.textContent.trim() : '';
        });
        const postScore = await page.evaluate(() => {
          var el = document.querySelector('.score .number');
          if (el) return parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
          var el2 = document.querySelector('.score');
          if (el2) {
            var m = el2.textContent.match(/([\d,]+)/);
            return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
          }
          return 0;
        });
        const postSubreddit = await page.evaluate(() => {
          var el = document.querySelector('.redditname a');
          return el ? el.textContent.trim() : '';
        });

        // Extract post ID from URL
        const idMatch = postUrl.match(/\/comments\/([a-z0-9]+)/i);
        const postId = idMatch ? idMatch[1] : '';

        const postMeta = {
          id: postId,
          title: postTitle,
          subreddit: postSubreddit,
          url: postUrl,
          score: postScore,
          num_comments: data.comments.length,
          selftext: data.postBody,
          flair: data.flair,
        };

        // Determine post pain categories for thematic agreement
        const postPainCategories = [];
        const postText = postTitle + ' ' + data.postBody;
        if (matchSignals(postText, 'frustration').length) postPainCategories.push('frustration');
        if (matchSignals(postText, 'desire').length) postPainCategories.push('desire');
        if (matchSignals(postText, 'cost').length) postPainCategories.push('cost');

        const analysis = analyzeComments(data.comments, postPainCategories);

        results.push({
          post: {
            id: postId,
            title: postTitle,
            subreddit: postSubreddit,
            url: postUrl,
            score: postScore,
            num_comments: data.comments.length,
            painScore: computePainScore(postMeta),
            selftext_excerpt: excerpt(data.postBody, 300),
            flair: data.flair,
          },
          analysis,
        });
      } catch (err) {
        log(`[browser-deep-dive] failed for ${postUrl}: ${err.message}`);
        results.push({
          post: { url: postUrl },
          error: err.message,
        });
      }

      await politeDelay();
    }

    ok({
      mode: 'browser',
      results,
      pages_loaded: postUrls.length,
    });
  } finally {
    await page.close();
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i++;
      }
    } else {
      result._.push(arg);
      i++;
    }
  }
  return result;
}

function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes('--help')) {
    log(`
browser-scan — Browser-based Reddit pain point discovery via Puppeteer

Connects to an existing Chrome instance (e.g. from puppeteer-mcp-server)
and scrapes old.reddit.com for real-time data. Uses the same scoring
engine as pain-points.mjs but gets data directly from the browser.

Usage:
  browser-scan.mjs <command> [options]

Commands:
  scan        Broad pain-point search across subreddits (browser-based)
  deep-dive   Deep comment analysis for specific posts (browser-based)

scan options:
  --subreddits <list>   Comma-separated subreddits (required)
  --domain <str>        Domain for relevance boosting
  --time <period>       Time filter: hour, day, week, month, year, all (default: year)
  --minComments <n>     Min comments filter (default: 3)
  --limit <n>           Max posts to return (default: 30)

deep-dive options:
  --post <url|id>       Single post URL or ID
  --from-scan <file>    JSON file from scan output
  --stdin               Read scan JSON from stdin
  --top <n>             Analyze top N posts (default: 10)
  --maxComments <n>     Max comments to scrape per post (default: 200)

Connection options (all commands):
  --ws-url <url>        Chrome WebSocket URL (auto-detected if omitted)
  --port <n>            Chrome debug port (auto-detected if omitted)

Examples:
  node browser-scan.mjs scan --subreddits PokemonTCG,pkmntcg --domain "pokemon tcg"
  node browser-scan.mjs deep-dive --post https://old.reddit.com/r/PokemonTCG/comments/1k8ncn6/i_hate_this_hobby/
  node browser-scan.mjs scan ... > scan.json && node browser-scan.mjs deep-dive --from-scan scan.json --top 5
`);
    process.exit(0);
  }

  const command = argv[0];
  const raw = parseArgs(argv.slice(1));

  const args = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_') args._ = v;
    else args[toCamelCase(k)] = v;
  }

  // Parse types
  if (args.limit) args.limit = parseInt(args.limit, 10);
  if (args.minComments) args.minComments = parseInt(args.minComments, 10);
  if (args.top) args.top = parseInt(args.top, 10);
  if (args.maxComments) args.maxComments = parseInt(args.maxComments, 10);
  if (args.port) args.port = parseInt(args.port, 10);
  if (typeof args.subreddits === 'string') {
    args.subreddits = args.subreddits.split(',').map(s => s.trim()).filter(Boolean);
  }

  switch (command) {
    case 'scan':
      await cmdBrowserScan(args);
      break;
    case 'deep-dive':
      await cmdBrowserDeepDive(args);
      break;
    default:
      fail(`Unknown command: ${command}. Use --help for usage.`);
  }
}

main().catch(err => {
  fail(err.message);
});
