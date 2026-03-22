/**
 * Custom deep-dive scraper for top Pokemon TCG pain posts.
 * Scrapes full comment threads from top pain-scoring posts.
 */

import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';

const WS_URL = 'ws://localhost:9222/devtools/browser/1f7c8c9e-01d4-4490-b197-350aa037b687';
const SCAN_FILE = '/tmp/ptcg-browser-scan.json';
const TOP_N = 20;
const MAX_COMMENTS = 200;
const DELAY_MS = 2000;

function log(...args) { process.stderr.write(args.join(' ') + '\n'); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PAIN_KEYWORDS = [
  'frustrated', 'annoying', 'terrible', 'hate', 'overpriced', 'ripoff', 'awful',
  'worst', 'broken', 'unusable', 'quit', 'nightmare', 'garbage', 'expensive',
  'scalper', 'scalping', 'gouge', 'gouging', 'impossible', "can't find", 'sold out',
  'wish', 'alternative', 'switched', 'disappointed', 'scam', 'fake', 'counterfeit',
  'price', 'cost', 'ms', 'rip', 'cheated', 'refund', 'delay', 'damaged', 'missing',
  'error', 'crash', 'bug', 'reset', 'ban', 'banned', 'hoard', 'hoarding',
];

function scorePainText(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of PAIN_KEYWORDS) if (lower.includes(kw)) score += 5;
  return score;
}

function categorizePain(title, body, comments) {
  const allText = (title + ' ' + body + ' ' + comments.map(c => c.body).join(' ')).toLowerCase();
  const categories = [];
  if (/price|expensive|overpriced|ripoff|gouge|scalp|cost|fee/.test(allText)) categories.push('pricing');
  if (/scalper|scalping|hoard|sold out|can't find|impossible to find|limit|restock/.test(allText)) categories.push('availability');
  if (/fake|counterfeit|scam|fraud|shill/.test(allText)) categories.push('authenticity');
  if (/app|crash|bug|glitch|server|login|account|reset|ban|digital/.test(allText)) categories.push('digital-app');
  if (/pack|pull|odds|rare|repack|weigh|rigged/.test(allText)) categories.push('pack-mechanics');
  if (/grade|psa|bgs|cgc|slab|grade|submit|turnaround/.test(allText)) categories.push('grading');
  if (/ship|shipping|damaged|missing|lost|delay|late|fedex|ups/.test(allText)) categories.push('shipping');
  if (/quit|leaving|done|giving up|not worth|sold|retired/.test(allText)) categories.push('churn');
  if (/wish|alternative|mtg|yugioh|one piece|lorcana|switched/.test(allText)) categories.push('alternatives');
  return categories;
}

async function scrapePost(page, postUrl, maxComments) {
  let url = postUrl.replace('www.reddit.com', 'old.reddit.com');
  if (!url.includes('old.reddit.com')) url = url.replace('reddit.com', 'old.reddit.com');
  url = url.replace(/\?.*$/, '') + '?limit=500';

  log(`  Scraping: ${url.substring(0, 100)}`);
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp ? resp.status() : 0;
    log(`  Status: ${status}`);
    if (status === 403 || status === 429) return null;
    await sleep(1500);

    return await page.evaluate((maxC) => {
      var postBody = '';
      var expandoEl = document.querySelector('.expando .md');
      if (expandoEl) postBody = expandoEl.textContent.trim();
      var flairEl = document.querySelector('.linkflair-text, .flair');
      var flair = flairEl ? flairEl.textContent.trim() : '';
      var titleEl = document.querySelector('a.title');
      var title = titleEl ? titleEl.textContent.trim() : '';
      var scoreEl = document.querySelector('.score .number');
      var score = 0;
      if (scoreEl) score = parseInt(scoreEl.textContent.replace(/,/g, ''), 10) || 0;
      else {
        var s2 = document.querySelector('.score');
        if (s2) { var m = s2.textContent.match(/([\d,]+)/); if (m) score = parseInt(m[1].replace(/,/g, ''), 10); }
      }
      var subEl = document.querySelector('.redditname a');
      var subreddit = subEl ? subEl.textContent.trim() : '';
      var comments = [];
      var els = document.querySelectorAll('.comment');
      for (var i = 0; i < Math.min(els.length, maxC); i++) {
        var el = els[i];
        var mdEl = el.querySelector('.md');
        if (!mdEl) continue;
        var scEl = el.querySelector('.score.unvoted');
        var scText = scEl ? scEl.textContent.trim() : '1 point';
        var scMatch = scText.match(/([\-\d]+)\s+point/);
        comments.push({
          body: mdEl.textContent.trim().substring(0, 800),
          score: scMatch ? parseInt(scMatch[1], 10) : 1
        });
      }
      return { title, selftext: postBody, flair, score, subreddit, comments };
    }, maxComments);
  } catch (err) {
    log(`  Error: ${err.message}`);
    return null;
  }
}

async function main() {
  // Load scan file
  let scanData;
  try { scanData = JSON.parse(readFileSync(SCAN_FILE, 'utf8')); }
  catch (err) { process.stderr.write(`Cannot read scan: ${err.message}\n`); process.exit(1); }

  const posts = (scanData?.data?.posts || scanData?.posts || []).slice(0, TOP_N);
  log(`[ptcg-deep-dive] ${posts.length} posts to deep-dive`);

  log(`[ptcg-deep-dive] Connecting to ${WS_URL}`);
  const browser = await puppeteer.connect({ browserWSEndpoint: WS_URL });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  });

  const results = [];

  try {
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const postUrl = post.url;
      if (!postUrl) { log(`[ptcg-deep-dive] Post ${i+1} has no URL, skipping`); continue; }

      log(`[ptcg-deep-dive] ${i+1}/${posts.length}: ${post.title?.substring(0, 60)}`);

      const data = await scrapePost(page, postUrl, MAX_COMMENTS);
      if (!data) {
        log(`[ptcg-deep-dive] Failed or blocked, skipping`);
        results.push({ post: { url: postUrl, title: post.title }, error: 'blocked or failed' });
        continue;
      }

      const idMatch = postUrl.match(/\/comments\/([a-z0-9]+)/i);
      const postId = idMatch ? idMatch[1] : post.id || '';

      // Find top pain comments
      const scoredComments = data.comments
        .map(c => ({ ...c, painScore: scorePainText(c.body) + Math.min(c.score, 100) * 0.1 }))
        .sort((a, b) => b.painScore - a.painScore);

      const painCategories = categorizePain(data.title || post.title, data.selftext, data.comments);

      const topComments = scoredComments.slice(0, 10).map(c => ({
        body_excerpt: c.body.substring(0, 400),
        score: c.score,
        painScore: Math.round(c.painScore),
      }));

      // Extract key pain quotes
      const painQuotes = [];
      for (const c of scoredComments.slice(0, 20)) {
        const sentences = c.body.split(/[.!?]+/).filter(s => s.trim().length > 20);
        for (const s of sentences) {
          const lower = s.toLowerCase();
          if (PAIN_KEYWORDS.some(kw => lower.includes(kw)) && s.length < 200) {
            painQuotes.push(s.trim());
            if (painQuotes.length >= 5) break;
          }
        }
        if (painQuotes.length >= 5) break;
      }

      results.push({
        post: {
          id: postId,
          title: data.title || post.title,
          subreddit: data.subreddit || post.subreddit,
          url: postUrl,
          score: data.score || post.score,
          num_comments: data.comments.length,
          painScore: post.painScore,
          selftext_excerpt: (data.selftext || '').substring(0, 400),
          flair: data.flair || post.flair,
          painCategories,
        },
        analysis: {
          total_comments_scraped: data.comments.length,
          pain_categories: painCategories,
          pain_quotes: painQuotes,
          top_pain_comments: topComments,
          summary: `${painCategories.join(', ')} — ${data.comments.length} comments scraped`,
        },
      });

      log(`[ptcg-deep-dive]   ${data.comments.length} comments, categories: ${painCategories.join(', ')}`);
      await sleep(DELAY_MS + Math.floor(Math.random() * 500));
    }
  } finally {
    await page.close();
    await browser.disconnect();
  }

  const output = { ok: true, data: { mode: 'browser', results, pages_loaded: posts.length } };
  process.stdout.write(JSON.stringify(output, null, 2));
  log(`[ptcg-deep-dive] Done. ${results.filter(r => !r.error).length}/${posts.length} posts deep-dived.`);
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
