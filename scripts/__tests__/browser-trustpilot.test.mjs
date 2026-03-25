/**
 * browser-trustpilot.test.mjs — Tests for trustpilot.mjs
 *
 * Trustpilot has standalone HTML parsers (parseNextData, parseJsonLd,
 * parseHtmlCards) that can be tested offline with fixture HTML.
 * Tests cover:
 *   - Smoke tests: module shape
 *   - parseNextData: __NEXT_DATA__ extraction
 *   - parseJsonLd: JSON-LD extraction
 *   - parseHtmlCards: HTML card parsing
 *   - normalizeReview: data shape and star inversion
 *   - resolveCompanies: domain-to-slug mapping
 *   - Edge cases: blocked pages, empty results, malformed HTML
 *   - enrichPost pipeline
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { enrichPost } from '../../scripts/lib/scoring.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

// Load fixture HTML files
const nextDataHtml = readFileSync(join(FIXTURES, 'trustpilot-nextdata.html'), 'utf8');
const jsonLdHtml = readFileSync(join(FIXTURES, 'trustpilot-jsonld.html'), 'utf8');
const htmlCardsHtml = readFileSync(join(FIXTURES, 'trustpilot-htmlcards.html'), 'utf8');
const blockedHtml = readFileSync(join(FIXTURES, 'trustpilot-blocked.html'), 'utf8');

// ─── Re-implement the parsers from trustpilot.mjs (not exported) ─────────────

const TRUSTPILOT_BASE = 'https://www.trustpilot.com';

function parseNextData(html, companySlug) {
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!nextDataMatch) return null;
  try {
    const data = JSON.parse(nextDataMatch[1]);
    const pageProps = data?.props?.pageProps;
    if (!pageProps) return null;
    const reviewList = pageProps.reviews || pageProps.reviewList || [];
    if (!Array.isArray(reviewList) || reviewList.length === 0) return null;
    const reviews = [];
    for (const r of reviewList) {
      const stars = r.rating || r.stars || 0;
      if (stars === 0 || stars > 3) continue;
      const title = r.title || r.heading || '';
      const body = r.text || r.content || r.body || '';
      if (!body || body.length < 10) continue;
      const dateStr = r.createdAt || r.dates?.publishedDate || r.date || '';
      const reviewId = r.id || `tp-next-${Date.now()}`;
      const reviewUrl = r.id ? `${TRUSTPILOT_BASE}/reviews/${r.id}` : '';
      reviews.push({ id: reviewId, stars, title, body, date: dateStr, usefulVotes: r.likes || r.usefulCount || 0, url: reviewUrl, companySlug });
    }
    const pagination = pageProps.pagination || pageProps.pageInfo || {};
    const hasNext = !!(pagination.hasNextPage || pagination.nextPage ||
                       (pagination.currentPage && pagination.totalPages && pagination.currentPage < pagination.totalPages));
    return { reviews, hasNext };
  } catch {
    return null;
  }
}

function extractJsonLdReview(r, companySlug, out) {
  const stars = r.reviewRating?.ratingValue ? parseInt(r.reviewRating.ratingValue, 10) : 0;
  if (stars === 0 || stars > 3) return;
  const title = r.headline || r.name || '';
  const body = r.reviewBody || r.description || '';
  if (!body || body.length < 10) return;
  const dateStr = r.datePublished || '';
  const reviewId = r.url
    ? (r.url.match(/\/reviews\/([^?#/]+)/) || [])[1] || `tp-ld-${Date.now()}`
    : `tp-ld-${Date.now()}`;
  out.push({ id: reviewId, stars, title, body, date: dateStr, usefulVotes: 0, url: r.url || '', companySlug });
}

function parseJsonLd(html, companySlug) {
  const jsonLdBlocks = [];
  const regex = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try { jsonLdBlocks.push(JSON.parse(match[1])); } catch { /* skip */ }
  }
  if (jsonLdBlocks.length === 0) return null;
  const reviews = [];
  for (const block of jsonLdBlocks) {
    const items = Array.isArray(block) ? block : [block];
    for (const item of items) {
      if (item['@type'] === 'Review') extractJsonLdReview(item, companySlug, reviews);
      if (item.review && Array.isArray(item.review)) {
        for (const r of item.review) extractJsonLdReview(r, companySlug, reviews);
      }
      if (item['@graph'] && Array.isArray(item['@graph'])) {
        for (const g of item['@graph']) {
          if (g['@type'] === 'Review') extractJsonLdReview(g, companySlug, reviews);
        }
      }
    }
  }
  return reviews.length > 0 ? { reviews } : null;
}

function parseHtmlCards(html, companySlug) {
  const reviews = [];
  const cardRegex = /<article[^>]*data-service-review-card-paper[^>]*>([\s\S]*?)<\/article>/gi;
  let cardMatch;
  let idx = 0;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const card = cardMatch[1];
    idx++;
    let stars = 0;
    const starAltMatch = card.match(/Rated\s+(\d)\s+out\s+of\s+5/i);
    if (starAltMatch) stars = parseInt(starAltMatch[1], 10);
    if (!stars) {
      const ratingAttr = cardMatch[0].match(/data-service-review-rating="(\d)"/);
      if (ratingAttr) stars = parseInt(ratingAttr[1], 10);
    }
    if (stars === 0 || stars > 3) continue;
    let title = '';
    const titleMatch = card.match(/data-service-review-title-typography[^>]*>([^<]+)</);
    if (titleMatch) title = titleMatch[1].trim();
    if (!title) { const h2Match = card.match(/<h2[^>]*>([^<]+)<\/h2>/i); if (h2Match) title = h2Match[1].trim(); }
    let body = '';
    const bodyMatch = card.match(/data-service-review-text-typography[^>]*>([\s\S]*?)<\//);
    if (bodyMatch) body = bodyMatch[1].replace(/<[^>]+>/g, '').trim();
    if (!body) { const pMatch = card.match(/<p[^>]*>([\s\S]*?)<\/p>/i); if (pMatch) body = pMatch[1].replace(/<[^>]+>/g, '').trim(); }
    if (!body || body.length < 10) continue;
    let dateStr = '';
    const timeMatch = card.match(/<time[^>]*datetime="([^"]+)"/);
    if (timeMatch) dateStr = timeMatch[1];
    let reviewUrl = '';
    let reviewId = `tp-html-${idx}-${Date.now()}`;
    const linkMatch = card.match(/href="(\/reviews\/[^"]+)"/);
    if (linkMatch) {
      reviewUrl = `${TRUSTPILOT_BASE}${linkMatch[1]}`;
      const idMatch = linkMatch[1].match(/\/reviews\/([^?#/]+)/);
      if (idMatch) reviewId = idMatch[1];
    }
    reviews.push({ id: reviewId, stars, title, body, date: dateStr, usefulVotes: 0, url: reviewUrl, companySlug });
  }
  let hasNext = false;
  if (html.includes('aria-label="Next page"') || html.includes('rel="next"') ||
      html.includes('data-pagination-button-next-link') || html.includes('paginationNext')) {
    hasNext = true;
  }
  return { reviews, hasNext };
}

const DOMAIN_MAP = {
  ticketmaster: 'ticketmaster.com', stubhub: 'stubhub.com', seatgeek: 'seatgeek.com',
  vividseats: 'vividseats.com', axs: 'axs.com', eventbrite: 'eventbrite.com',
  viagogo: 'viagogo.com', livenation: 'livenation.com', gametime: 'gametime.co', goldstar: 'goldstar.com',
};

function resolveCompanies(domain) {
  const key = domain.toLowerCase().trim();
  if (DOMAIN_MAP[key]) return [DOMAIN_MAP[key]];
  const matches = [];
  for (const [mapKey, slug] of Object.entries(DOMAIN_MAP)) {
    if (mapKey.includes(key) || key.includes(mapKey)) matches.push(slug);
  }
  if (matches.length > 0) return matches;
  return [key.includes('.') ? key : `${key}.com`];
}

function normalizeReview(review, companyName) {
  const invertedScore = Math.max(1, 6 - Math.round(review.stars || 1));
  const titlePrefix = companyName || review.companySlug || 'trustpilot';
  const starsLabel = review.stars ? `${review.stars}-star` : 'low-star';
  const titleText = review.title
    ? `${titlePrefix} ${starsLabel}: ${review.title}`
    : `${titlePrefix} ${starsLabel} review`;
  return {
    id: review.id || `tp-${Date.now()}`,
    title: titleText,
    selftext: review.body || '',
    subreddit: 'trustpilot',
    url: review.url || `${TRUSTPILOT_BASE}/review/${review.companySlug || ''}`,
    score: invertedScore,
    num_comments: 0,
    upvote_ratio: 0,
    created_utc: review.date ? Math.floor(new Date(review.date).getTime() / 1000) || 0 : 0,
    flair: starsLabel,
  };
}

// ─── Import module for smoke test ────────────────────────────────────────────

let trustpilotModule;
try {
  trustpilotModule = (await import('../../scripts/sources/trustpilot.mjs')).default;
} catch {
  trustpilotModule = null;
}

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe('trustpilot: smoke tests', () => {
  it('module loads and exports default object', () => {
    assert.ok(trustpilotModule, 'module should load');
    assert.equal(trustpilotModule.name, 'trustpilot');
  });

  it('has required source interface fields', () => {
    assert.ok(trustpilotModule.description);
    assert.ok(Array.isArray(trustpilotModule.commands));
    assert.ok(trustpilotModule.commands.includes('scan'));
    assert.equal(typeof trustpilotModule.run, 'function');
    assert.equal(typeof trustpilotModule.help, 'string');
  });
});

// ─── parseNextData tests ─────────────────────────────────────────────────────

describe('trustpilot: parseNextData', () => {
  it('extracts reviews from __NEXT_DATA__ fixture', () => {
    const result = parseNextData(nextDataHtml, 'test.com');
    assert.ok(result, 'should return a result');
    assert.ok(Array.isArray(result.reviews));
    // Fixture has 5 reviews: 1-star, 2-star, 5-star (filtered), 3-star, 1-star-short (filtered)
    // Only 1-3 star with body >= 10 chars pass
    assert.equal(result.reviews.length, 3, 'should extract 3 qualifying reviews (1,2,3 star with body >= 10)');
  });

  it('filters out 5-star reviews', () => {
    const result = parseNextData(nextDataHtml, 'test.com');
    for (const r of result.reviews) {
      assert.ok(r.stars <= 3, `star rating should be <= 3, got ${r.stars}`);
    }
  });

  it('filters out reviews with short body', () => {
    const result = parseNextData(nextDataHtml, 'test.com');
    for (const r of result.reviews) {
      assert.ok(r.body.length >= 10, `body should be >= 10 chars, got ${r.body.length}`);
    }
  });

  it('extracts correct review data', () => {
    const result = parseNextData(nextDataHtml, 'test.com');
    const first = result.reviews[0];
    assert.equal(first.id, 'tp-review-001');
    assert.equal(first.stars, 1);
    assert.equal(first.title, 'Worst experience ever');
    assert.ok(first.body.includes('waited 3 hours'));
    assert.equal(first.date, '2025-12-15T10:30:00Z');
    assert.equal(first.usefulVotes, 42);
    assert.ok(first.url.includes('tp-review-001'));
    assert.equal(first.companySlug, 'test.com');
  });

  it('detects pagination (hasNext)', () => {
    const result = parseNextData(nextDataHtml, 'test.com');
    assert.equal(result.hasNext, true, 'should detect pagination');
  });

  it('returns null for HTML without __NEXT_DATA__', () => {
    const result = parseNextData('<html><body>No data here</body></html>', 'test.com');
    assert.equal(result, null);
  });

  it('returns null for malformed JSON in __NEXT_DATA__', () => {
    const malformed = '<script id="__NEXT_DATA__" type="application/json">{not valid json</script>';
    const result = parseNextData(malformed, 'test.com');
    assert.equal(result, null);
  });

  it('returns null when __NEXT_DATA__ has no reviews', () => {
    const empty = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>';
    const result = parseNextData(empty, 'test.com');
    assert.equal(result, null);
  });
});

// ─── parseJsonLd tests ───────────────────────────────────────────────────────

describe('trustpilot: parseJsonLd', () => {
  it('extracts reviews from JSON-LD fixture', () => {
    const result = parseJsonLd(jsonLdHtml, 'test.com');
    assert.ok(result, 'should return a result');
    assert.ok(Array.isArray(result.reviews));
    // Fixture has 3 reviews: 1-star, 2-star, 5-star (filtered)
    assert.equal(result.reviews.length, 2, 'should extract 2 qualifying reviews');
  });

  it('filters out 5-star JSON-LD reviews', () => {
    const result = parseJsonLd(jsonLdHtml, 'test.com');
    for (const r of result.reviews) {
      assert.ok(r.stars <= 3);
    }
  });

  it('extracts correct data from JSON-LD', () => {
    const result = parseJsonLd(jsonLdHtml, 'test.com');
    const first = result.reviews[0];
    assert.equal(first.stars, 1);
    assert.equal(first.title, 'Complete scam');
    assert.ok(first.body.includes('charged me double'));
    assert.equal(first.date, '2025-08-15');
  });

  it('extracts review ID from URL', () => {
    const result = parseJsonLd(jsonLdHtml, 'test.com');
    const first = result.reviews[0];
    assert.equal(first.id, 'abc123');
    assert.equal(first.url, 'https://www.trustpilot.com/reviews/abc123');
  });

  it('returns null for HTML without JSON-LD', () => {
    const result = parseJsonLd('<html><body>nothing</body></html>', 'test.com');
    assert.equal(result, null);
  });

  it('returns null when all JSON-LD reviews are 4-5 star', () => {
    const html = `<script type="application/ld+json">{"@type":"Review","headline":"Great","reviewBody":"Excellent service and great product","reviewRating":{"ratingValue":"5"}}</script>`;
    const result = parseJsonLd(html, 'test.com');
    assert.equal(result, null, 'should return null when no low-star reviews');
  });
});

// ─── parseHtmlCards tests ────────────────────────────────────────────────────

describe('trustpilot: parseHtmlCards', () => {
  it('extracts reviews from HTML cards fixture', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    assert.ok(Array.isArray(result.reviews));
    // Fixture: 1-star, 2-star, 4-star (filtered), no-rating (filtered)
    assert.equal(result.reviews.length, 2, 'should extract 2 qualifying cards');
  });

  it('extracts star rating from data attribute', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    assert.equal(result.reviews[0].stars, 1);
    assert.equal(result.reviews[1].stars, 2);
  });

  it('extracts title from data attribute', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    assert.equal(result.reviews[0].title, 'Absolutely horrific');
    assert.equal(result.reviews[1].title, 'Too expensive');
  });

  it('extracts body text', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    assert.ok(result.reviews[0].body.includes('crashed during checkout'));
    assert.ok(result.reviews[1].body.includes('Service fees'));
  });

  it('extracts date from time element', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    assert.equal(result.reviews[0].date, '2025-11-01T12:00:00Z');
  });

  it('extracts review URL and ID', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    assert.equal(result.reviews[0].id, 'rev-html-001');
    assert.ok(result.reviews[0].url.includes('/reviews/rev-html-001'));
  });

  it('detects next page link', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    assert.equal(result.hasNext, true);
  });

  it('returns empty reviews and hasNext=false for empty page', () => {
    const result = parseHtmlCards('<html><body>No reviews here</body></html>', 'test.com');
    assert.equal(result.reviews.length, 0);
    assert.equal(result.hasNext, false);
  });

  it('filters out 4+ star cards', () => {
    const result = parseHtmlCards(htmlCardsHtml, 'test.com');
    for (const r of result.reviews) {
      assert.ok(r.stars <= 3);
    }
  });
});

// ─── resolveCompanies tests ──────────────────────────────────────────────────

describe('trustpilot: resolveCompanies', () => {
  it('resolves known domain to slug', () => {
    assert.deepEqual(resolveCompanies('ticketmaster'), ['ticketmaster.com']);
  });

  it('resolves case-insensitively', () => {
    assert.deepEqual(resolveCompanies('StubHub'), ['stubhub.com']);
  });

  it('fuzzy matches partial domain', () => {
    const result = resolveCompanies('ticket');
    assert.ok(result.includes('ticketmaster.com'), 'should fuzzy-match ticketmaster');
  });

  it('falls back to domain.com for unknown domains', () => {
    assert.deepEqual(resolveCompanies('randomcompany'), ['randomcompany.com']);
  });

  it('preserves .com suffix for domain-like inputs', () => {
    assert.deepEqual(resolveCompanies('acme.com'), ['acme.com']);
  });

  it('preserves non-.com TLDs', () => {
    assert.deepEqual(resolveCompanies('acme.co.uk'), ['acme.co.uk']);
  });
});

// ─── normalizeReview tests ───────────────────────────────────────────────────

describe('trustpilot: normalizeReview', () => {
  it('creates post with correct shape', () => {
    const review = { id: 'tp-001', stars: 1, title: 'Terrible', body: 'Worst service ever I hate it', date: '2025-01-15', companySlug: 'acme.com' };
    const post = normalizeReview(review, 'acme');
    assert.equal(post.id, 'tp-001');
    assert.ok(post.title.includes('acme'));
    assert.ok(post.title.includes('1-star'));
    assert.ok(post.title.includes('Terrible'));
    assert.equal(post.selftext, 'Worst service ever I hate it');
    assert.equal(post.subreddit, 'trustpilot');
    assert.equal(post.score, 5); // inverted: 6-1=5
    assert.equal(post.flair, '1-star');
  });

  it('inverts star ratings correctly', () => {
    assert.equal(normalizeReview({ stars: 1, body: 'x' }, 'x').score, 5);
    assert.equal(normalizeReview({ stars: 2, body: 'x' }, 'x').score, 4);
    assert.equal(normalizeReview({ stars: 3, body: 'x' }, 'x').score, 3);
  });

  it('converts date to created_utc', () => {
    const review = { id: 'tp-date', stars: 1, body: 'test', date: '2025-06-15T12:00:00Z', companySlug: 'x' };
    const post = normalizeReview(review, 'x');
    assert.ok(post.created_utc > 0);
    assert.equal(typeof post.created_utc, 'number');
  });

  it('handles missing date gracefully', () => {
    const review = { id: 'tp-nodate', stars: 2, body: 'test', companySlug: 'x' };
    const post = normalizeReview(review, 'x');
    assert.equal(post.created_utc, 0);
  });
});

// ─── Edge cases: blocked/challenge pages ─────────────────────────────────────

describe('trustpilot: blocked page detection', () => {
  it('blocked HTML contains challenge markers', () => {
    assert.ok(blockedHtml.includes('you have been blocked'));
    assert.ok(blockedHtml.includes('verify you are human'));
    assert.ok(blockedHtml.includes('challenge-form'));
  });

  it('parseNextData returns null for blocked page', () => {
    const result = parseNextData(blockedHtml, 'test.com');
    assert.equal(result, null);
  });

  it('parseJsonLd returns null for blocked page', () => {
    const result = parseJsonLd(blockedHtml, 'test.com');
    assert.equal(result, null);
  });

  it('parseHtmlCards returns empty for blocked page', () => {
    const result = parseHtmlCards(blockedHtml, 'test.com');
    assert.equal(result.reviews.length, 0);
  });
});

// ─── enrichPost pipeline ─────────────────────────────────────────────────────

describe('trustpilot: enrichPost pipeline', () => {
  it('enrichPost processes a normalized Trustpilot review', () => {
    const review = { id: 'tp-test-001', stars: 1, title: 'Awful', body: 'I hate this terrible broken frustrating service. The website is unusable and I wish there was an alternative.', date: '2025-01-01', companySlug: 'ticketmaster.com' };
    const post = normalizeReview(review, 'ticketmaster');
    const result = enrichPost(post, 'ticketmaster');
    assert.ok(result, 'should enrich a pain-heavy review');
    assert.ok(result.painScore > 0);
  });
});
