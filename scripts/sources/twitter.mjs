/**
 * twitter.mjs — Twitter/X source for gapscout
 *
 * Uses @the-convocation/twitter-scraper for direct Twitter search.
 * Supports guest mode (no login) and optional authenticated mode
 * via TWITTER_USERNAME / TWITTER_PASSWORD env vars.
 *
 * Exports { name: 'twitter', commands: ['scan'], run, help }
 */

import { Scraper, SearchMode } from '@the-convocation/twitter-scraper';
import { sleep, log, ok, fail } from '../lib/utils.mjs';
import { enrichPost } from '../lib/scoring.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

/** Delay between search queries to avoid rate limits (ms) */
const QUERY_DELAY_MS = 1500;
const QUERY_JITTER_MS = 500;

/** Max tweets to fetch per query */
const TWEETS_PER_QUERY = 50;

// Pain-revealing search query templates
const PAIN_QUERY_TEMPLATES = [
  '{domain} frustrated OR hate OR terrible',
  '{domain} broken OR unusable OR nightmare',
  '{domain} alternative OR switched OR "wish there was"',
  '{domain} overpriced OR expensive OR "not worth"',
  '{domain} scam OR ripoff OR "giving up"',
  '{domain} bot OR scalper OR unfair',
  '{domain} "can\'t believe" OR ridiculous OR insane',
  '{domain} worst OR garbage OR awful',
];

// ─── helpers ─────────────────────────────────────────────────────────────────

async function queryDelay() {
  const jitter = Math.floor(Math.random() * QUERY_JITTER_MS);
  await sleep(QUERY_DELAY_MS + jitter);
}

/**
 * Normalize a tweet object from the scraper into GapScout's post format.
 */
function normalizeTweet(tweet) {
  const text = tweet.text || '';
  if (!text) return null;

  return {
    id: tweet.id,
    title: text.substring(0, 100),
    selftext: text,
    url: tweet.username
      ? `https://x.com/${tweet.username}/status/${tweet.id}`
      : '',
    score: (tweet.likes || 0) + (tweet.retweets || 0),
    num_comments: tweet.replies || 0,
    created_utc: tweet.timeParsed
      ? new Date(tweet.timeParsed).getTime() / 1000
      : 0,
    subreddit: tweet.username ? `@${tweet.username}` : 'twitter',
    source: 'twitter',
    _source: 'twitter',
  };
}

/**
 * Create and optionally authenticate a Scraper instance.
 * Returns { scraper, authenticated }.
 */
async function createScraper() {
  const scraper = new Scraper();
  let authenticated = false;

  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;

  if (username && password) {
    try {
      log('[twitter] logging in with TWITTER_USERNAME credentials...');
      await scraper.login(username, password);
      authenticated = true;
      log('[twitter] authenticated successfully');
    } catch (err) {
      log(`[twitter] authentication failed: ${err.message}`);
      log('[twitter] falling back to guest mode');
    }
  }

  return { scraper, authenticated };
}

/**
 * Collect tweets from an async generator, up to `maxCount`.
 */
async function collectTweets(tweetsGen, maxCount) {
  const tweets = [];
  try {
    for await (const tweet of tweetsGen) {
      if (!tweet || !tweet.text) continue;
      tweets.push(tweet);
      if (tweets.length >= maxCount) break;
    }
  } catch (err) {
    // The generator may throw on rate limits or end-of-results
    log(`[twitter] tweet collection stopped: ${err.message}`);
  }
  return tweets;
}

// ─── scan command ─────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const domain = args.domain || '';
  if (!domain) fail('--domain is required');

  const limit = args.limit || 100;

  log(`[twitter] scan domain="${domain}" limit=${limit}`);

  // Build search queries
  const queries = PAIN_QUERY_TEMPLATES.map(t => t.replace('{domain}', domain));

  const postsById = new Map();
  let rateLimitHits = 0;
  let queryErrors = 0;
  let authenticated = false;

  // Create scraper
  let scraper;
  try {
    const result = await createScraper();
    scraper = result.scraper;
    authenticated = result.authenticated;
  } catch (err) {
    log(`[twitter] failed to initialize scraper: ${err.message}`);
    ok({
      mode: 'scraper',
      source: 'twitter',
      posts: [],
      stats: {
        strategy: 'twitter-scraper',
        raw_tweets: 0,
        after_scoring: 0,
        returned: 0,
        blocked: 0,
        rateLimitWarnings: 0,
        error: `Scraper initialization failed: ${err.message}`,
      },
    });
    return;
  }

  const tweetsPerQuery = Math.min(TWEETS_PER_QUERY, Math.ceil((limit * 3) / queries.length));

  for (const query of queries) {
    log(`[twitter] query: "${query.substring(0, 60)}"`);

    try {
      const tweetsGen = scraper.searchTweets(query, tweetsPerQuery, SearchMode.Latest);
      const rawTweets = await collectTweets(tweetsGen, tweetsPerQuery);

      let added = 0;
      for (const tweet of rawTweets) {
        const post = normalizeTweet(tweet);
        if (post && post.id && !postsById.has(post.id)) {
          postsById.set(post.id, post);
          added++;
        }
      }

      log(`[twitter]   got ${rawTweets.length} tweets, ${added} new (${postsById.size} total)`);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('rate') || msg.includes('Rate') || msg.includes('429')) {
        rateLimitHits++;
        log(`[twitter]   rate limited on query, waiting longer...`);
        await sleep(5000 + Math.floor(Math.random() * 3000));

        if (rateLimitHits >= 3) {
          log('[twitter] too many rate limits, stopping queries');
          if (!authenticated) {
            log('[twitter] hint: set TWITTER_USERNAME and TWITTER_PASSWORD env vars for authenticated mode (higher rate limits)');
          }
          break;
        }
      } else {
        queryErrors++;
        log(`[twitter]   query error: ${msg}`);

        if (queryErrors >= 3 && postsById.size === 0 && !authenticated) {
          log('[twitter] multiple failures without auth — set TWITTER_USERNAME and TWITTER_PASSWORD env vars for authenticated mode');
          break;
        }
      }
    }

    // Stop early if we have enough
    if (postsById.size >= limit * 3) {
      log('[twitter] collected enough tweets, stopping early');
      break;
    }

    await queryDelay();
  }

  // ── Graceful failure: no tweets ───────────────────────────────────────────
  if (postsById.size === 0) {
    ok({
      mode: 'scraper',
      source: 'twitter',
      posts: [],
      stats: {
        strategy: 'twitter-scraper',
        raw_tweets: 0,
        after_scoring: 0,
        returned: 0,
        blocked: rateLimitHits,
        rateLimitWarnings: rateLimitHits,
        error: rateLimitHits > 0
          ? 'Rate limited. Try again later or set TWITTER_USERNAME/TWITTER_PASSWORD env vars.'
          : 'No tweets collected. Check domain query or network access.',
      },
    });
    return;
  }

  // ── Score and output ────────────────────────────────────────────────────────
  const scored = [];
  for (const post of postsById.values()) {
    const enriched = enrichPost(post, domain);
    if (enriched) scored.push(enriched);
  }

  scored.sort((a, b) => b.painScore - a.painScore);

  ok({
    mode: 'scraper',
    source: 'twitter',
    posts: scored.slice(0, limit),
    stats: {
      strategy: authenticated ? 'twitter-scraper:authenticated' : 'twitter-scraper:guest',
      raw_tweets: postsById.size,
      after_scoring: scored.length,
      returned: Math.min(scored.length, limit),
      blocked: rateLimitHits,
      rateLimitWarnings: rateLimitHits,
    },
  });
}

// ─── source export ────────────────────────────────────────────────────────────

export default {
  name: 'twitter',
  description: 'Twitter/X — searches tweets via @the-convocation/twitter-scraper',
  commands: ['scan'],
  async run(command, args) {
    switch (command) {
      case 'scan': return cmdScan(args);
      default: fail(`Unknown command: ${command}`);
    }
  },
  help: `
twitter source — Twitter/X tweet scraping for pain points

Uses @the-convocation/twitter-scraper for direct Twitter search.
Supports guest mode (no login required) and optional authenticated
mode for higher rate limits.

Commands:
  scan        Search Twitter for pain-revealing tweets about a domain

scan options:
  --domain <str>        Topic/product to search for (required)
  --limit <n>           Max tweets to return (default: 100)

Authentication (optional, for higher rate limits):
  TWITTER_USERNAME      Environment variable with your Twitter/X username
  TWITTER_PASSWORD      Environment variable with your Twitter/X password

Examples:
  node scripts/cli.mjs twitter scan --domain "scalper bot" --limit 100
  node scripts/cli.mjs x scan --domain "ticket scalping" --limit 200
  TWITTER_USERNAME=myuser TWITTER_PASSWORD=mypass node scripts/cli.mjs twitter scan --domain "SaaS billing"
`,
};
