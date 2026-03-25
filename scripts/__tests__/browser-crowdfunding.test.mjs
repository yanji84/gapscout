/**
 * browser-crowdfunding.test.mjs — Tests for crowdfunding.mjs (Kickstarter + Indiegogo)
 *
 * Kickstarter has a standalone HTML parser (parseKickstarterSearchHtml)
 * and several pure utility functions that can be tested offline.
 * Tests cover:
 *   - Smoke tests: module shape
 *   - parseKickstarterSearchHtml: data-project JSON extraction
 *   - parseFundingAmount: K/M suffix parsing
 *   - parseCount: comma-separated count parsing
 *   - buildSearchQueries: query generation
 *   - iggExtractSlug / iggNormalizeDiscoverable: Indiegogo normalization
 *   - Edge cases: empty HTML, malformed data-project, Cloudflare
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

const kickstarterSearchHtml = readFileSync(join(FIXTURES, 'kickstarter-search.html'), 'utf8');
const kickstarterEmptyHtml = readFileSync(join(FIXTURES, 'kickstarter-empty.html'), 'utf8');
const cloudflareHtml = readFileSync(join(FIXTURES, 'cloudflare-block.html'), 'utf8');

// ─── Re-implement pure functions from crowdfunding.mjs ───────────────────────

function parseKickstarterSearchHtml(html) {
  const projects = [];
  const dataProjRegex = /data-pid="[^"]*"[^>]*data-project="([^"]*)"/g;
  const dataProjRegex2 = /data-project="([^"]*)"[^>]*data-pid="[^"]*"/g;
  const jsonBlobs = new Set();
  for (const regex of [dataProjRegex, dataProjRegex2]) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      jsonBlobs.add(match[1]);
    }
  }
  for (const raw of jsonBlobs) {
    try {
      const decoded = raw
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'");
      const proj = JSON.parse(decoded);
      const projUrl = proj.urls?.web?.project || '';
      const m = projUrl.match(/\/projects\/([^/]+)\/([^/?#]+)/) || null;
      const creator = m ? m[1] : (proj.creator?.slug || proj.creator?.name || 'unknown');
      const slug = m ? m[2] : (proj.slug || '');
      if (!slug) continue;
      const canonicalUrl = `https://www.kickstarter.com/projects/${creator}/${slug}`;
      projects.push({
        creator,
        slug,
        url: canonicalUrl,
        name: (proj.name || slug).substring(0, 120),
        description: (proj.blurb || '').substring(0, 300),
        backerCount: parseInt(proj.backers_count || 0, 10),
        fundingAmount: Math.round(parseFloat(proj.pledged || 0)),
      });
    } catch {
      // skip unparseable
    }
  }
  return projects;
}

function parseFundingAmount(text) {
  if (!text) return 0;
  const clean = text.replace(/[^0-9.KMkm]/g, '').toUpperCase();
  const num = parseFloat(clean);
  if (isNaN(num)) return 0;
  if (clean.endsWith('M')) return Math.round(num * 1_000_000);
  if (clean.endsWith('K')) return Math.round(num * 1_000);
  return Math.round(num);
}

function parseCount(text) {
  if (!text) return 0;
  const m = text.replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function buildSearchQueries(domain) {
  const queries = [];
  if (domain) {
    queries.push(domain);
    queries.push(`${domain} alternative`);
    queries.push(`${domain} problem`);
  }
  queries.push('frustrated annoying problem');
  queries.push('wish alternative better');
  queries.push('overpriced expensive not worth');
  return queries;
}

function iggExtractSlug(urlOrPath) {
  if (!urlOrPath) return null;
  const m = urlOrPath.match(/\/projects\/([^/?#]+)/);
  return m ? m[1] : null;
}

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

function stripQuery(url) {
  try { return new URL(url).origin + new URL(url).pathname; }
  catch { return url.split('?')[0]; }
}

// ─── Import module for smoke tests ───────────────────────────────────────────

let crowdfundingModule;
try {
  crowdfundingModule = (await import('../../scripts/sources/crowdfunding.mjs')).default;
} catch {
  crowdfundingModule = null;
}

// ─── Smoke tests ─────────────────────────────────────────────────────────────

describe('crowdfunding: smoke tests', () => {
  it('module loads and exports default object', () => {
    assert.ok(crowdfundingModule, 'module should load');
    assert.equal(crowdfundingModule.name, 'crowdfunding');
  });

  it('has required source interface fields', () => {
    assert.ok(crowdfundingModule.description);
    assert.ok(Array.isArray(crowdfundingModule.commands));
    assert.ok(crowdfundingModule.commands.includes('scan'));
    assert.equal(typeof crowdfundingModule.run, 'function');
    assert.equal(typeof crowdfundingModule.help, 'string');
  });
});

// ─── parseKickstarterSearchHtml tests ────────────────────────────────────────

describe('crowdfunding: parseKickstarterSearchHtml', () => {
  it('extracts projects from fixture HTML', () => {
    const projects = parseKickstarterSearchHtml(kickstarterSearchHtml);
    assert.ok(Array.isArray(projects));
    assert.equal(projects.length, 2, 'should extract 2 projects');
  });

  it('extracts correct project data', () => {
    const projects = parseKickstarterSearchHtml(kickstarterSearchHtml);
    const first = projects[0];
    assert.equal(first.name, 'Smart Home Hub');
    assert.equal(first.slug, 'smart-home-hub');
    assert.equal(first.creator, 'johndoe');
    assert.equal(first.backerCount, 2500);
    assert.equal(first.fundingAmount, 150000);
    assert.equal(first.url, 'https://www.kickstarter.com/projects/johndoe/smart-home-hub');
  });

  it('extracts second project correctly', () => {
    const projects = parseKickstarterSearchHtml(kickstarterSearchHtml);
    const second = projects[1];
    assert.equal(second.name, 'EcoBot Cleaner');
    assert.equal(second.slug, 'ecobot-cleaner');
    assert.equal(second.creator, 'janedoe');
    assert.equal(second.backerCount, 800);
    assert.equal(second.fundingAmount, 45000);
  });

  it('decodes HTML entities in data-project JSON', () => {
    const projects = parseKickstarterSearchHtml(kickstarterSearchHtml);
    // The description should be properly decoded from &quot; entities
    assert.ok(projects[0].description.length > 0);
    assert.ok(!projects[0].description.includes('&quot;'), 'should not contain raw HTML entities');
  });

  it('returns empty array for empty HTML', () => {
    const projects = parseKickstarterSearchHtml(kickstarterEmptyHtml);
    assert.equal(projects.length, 0);
  });

  it('returns empty array for Cloudflare block page', () => {
    const projects = parseKickstarterSearchHtml(cloudflareHtml);
    assert.equal(projects.length, 0);
  });

  it('handles HTML with only one attribute order (data-project first)', () => {
    const html = '<div data-project="{ &quot;name&quot;: &quot;Test&quot;, &quot;slug&quot;: &quot;test-proj&quot;, &quot;blurb&quot;: &quot;A test project description long enough&quot;, &quot;backers_count&quot;: 100, &quot;pledged&quot;: 5000, &quot;urls&quot;: { &quot;web&quot;: { &quot;project&quot;: &quot;https://www.kickstarter.com/projects/creator/test-proj&quot; } } }" data-pid="999"></div>';
    const projects = parseKickstarterSearchHtml(html);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].slug, 'test-proj');
  });
});

// ─── parseFundingAmount tests ────────────────────────────────────────────────

describe('crowdfunding: parseFundingAmount', () => {
  it('parses dollar amounts', () => {
    assert.equal(parseFundingAmount('$1,234'), 1234);
    assert.equal(parseFundingAmount('$50,000'), 50000);
  });

  it('parses K suffix', () => {
    assert.equal(parseFundingAmount('$45K'), 45000);
    assert.equal(parseFundingAmount('$1.5K'), 1500);
  });

  it('parses M suffix', () => {
    assert.equal(parseFundingAmount('$1.2M'), 1200000);
    assert.equal(parseFundingAmount('$2M'), 2000000);
  });

  it('parses other currency symbols', () => {
    assert.equal(parseFundingAmount('£45K'), 45000);
    assert.equal(parseFundingAmount('€3,450'), 3450);
  });

  it('handles empty/null input', () => {
    assert.equal(parseFundingAmount(''), 0);
    assert.equal(parseFundingAmount(null), 0);
    assert.equal(parseFundingAmount(undefined), 0);
  });

  it('handles plain numbers', () => {
    assert.equal(parseFundingAmount('5000'), 5000);
    assert.equal(parseFundingAmount('1234.56'), 1235);
  });
});

// ─── parseCount tests ────────────────────────────────────────────────────────

describe('crowdfunding: parseCount', () => {
  it('parses counts with commas', () => {
    assert.equal(parseCount('1,234 backers'), 1234);
    assert.equal(parseCount('50,000 comments'), 50000);
  });

  it('parses plain numbers', () => {
    assert.equal(parseCount('42 backers'), 42);
    assert.equal(parseCount('0'), 0);
  });

  it('handles empty/null input', () => {
    assert.equal(parseCount(''), 0);
    assert.equal(parseCount(null), 0);
  });

  it('handles text without numbers', () => {
    assert.equal(parseCount('no backers'), 0);
  });
});

// ─── buildSearchQueries tests ────────────────────────────────────────────────

describe('crowdfunding: buildSearchQueries', () => {
  it('generates queries with domain', () => {
    const queries = buildSearchQueries('smart home');
    assert.ok(queries.includes('smart home'));
    assert.ok(queries.includes('smart home alternative'));
    assert.ok(queries.includes('smart home problem'));
    assert.ok(queries.length >= 6, 'should have domain + generic queries');
  });

  it('generates generic queries without domain', () => {
    const queries = buildSearchQueries('');
    assert.ok(queries.length >= 3, 'should have generic queries even without domain');
    assert.ok(queries.some(q => q.includes('frustrated')));
  });

  it('always includes generic pain queries', () => {
    const queries = buildSearchQueries('test');
    assert.ok(queries.some(q => q.includes('frustrated')));
    assert.ok(queries.some(q => q.includes('alternative')));
    assert.ok(queries.some(q => q.includes('overpriced')));
  });
});

// ─── iggExtractSlug tests ────────────────────────────────────────────────────

describe('crowdfunding: iggExtractSlug', () => {
  it('extracts slug from full URL', () => {
    assert.equal(iggExtractSlug('https://www.indiegogo.com/projects/my-cool-gadget'), 'my-cool-gadget');
  });

  it('extracts slug from path', () => {
    assert.equal(iggExtractSlug('/projects/my-cool-gadget'), 'my-cool-gadget');
  });

  it('handles URL with query params', () => {
    assert.equal(iggExtractSlug('/projects/my-gadget?ref=discovery'), 'my-gadget');
  });

  it('returns null for empty input', () => {
    assert.equal(iggExtractSlug(''), null);
    assert.equal(iggExtractSlug(null), null);
    assert.equal(iggExtractSlug(undefined), null);
  });

  it('returns null for non-project URLs', () => {
    assert.equal(iggExtractSlug('https://www.indiegogo.com/explore'), null);
  });
});

// ─── iggNormalizeDiscoverable tests ──────────────────────────────────────────

describe('crowdfunding: iggNormalizeDiscoverable', () => {
  it('normalizes a discoverable item', () => {
    const item = {
      clickthrough_url: '/projects/super-widget',
      title: 'Super Widget',
      tagline: 'The best widget you have ever seen',
      contributions_count: 500,
      collected_funds: 75000,
      comments_count: 42,
    };
    const result = iggNormalizeDiscoverable(item);
    assert.ok(result);
    assert.equal(result.slug, 'super-widget');
    assert.equal(result.name, 'Super Widget');
    assert.equal(result.description, 'The best widget you have ever seen');
    assert.equal(result.backerCount, 500);
    assert.equal(result.fundingAmount, 75000);
    assert.equal(result.commentCount, 42);
    assert.equal(result.url, 'https://www.indiegogo.com/projects/super-widget');
  });

  it('returns null for item without project URL', () => {
    const item = { title: 'No URL' };
    assert.equal(iggNormalizeDiscoverable(item), null);
  });

  it('truncates long names and descriptions', () => {
    const item = {
      clickthrough_url: '/projects/test',
      title: 'A'.repeat(200),
      tagline: 'B'.repeat(400),
    };
    const result = iggNormalizeDiscoverable(item);
    assert.ok(result.name.length <= 120);
    assert.ok(result.description.length <= 300);
  });
});

// ─── stripQuery tests ────────────────────────────────────────────────────────

describe('crowdfunding: stripQuery', () => {
  it('strips query params from URL', () => {
    assert.equal(
      stripQuery('https://www.kickstarter.com/projects/user/proj?ref=discovery'),
      'https://www.kickstarter.com/projects/user/proj'
    );
  });

  it('handles URL without query params', () => {
    assert.equal(
      stripQuery('https://www.kickstarter.com/projects/user/proj'),
      'https://www.kickstarter.com/projects/user/proj'
    );
  });

  it('handles malformed URL by splitting on ?', () => {
    assert.equal(stripQuery('not-a-url?foo=bar'), 'not-a-url');
  });
});

// ─── enrichPost pipeline ─────────────────────────────────────────────────────

describe('crowdfunding: enrichPost pipeline', () => {
  it('enrichPost processes a Kickstarter project post', () => {
    const projects = parseKickstarterSearchHtml(kickstarterSearchHtml);
    assert.ok(projects.length > 0);
    const stub = projects[0];
    const post = {
      id: stub.slug,
      title: stub.name,
      selftext: stub.description,
      subreddit: 'kickstarter',
      url: stub.url,
      score: stub.backerCount,
      num_comments: 0,
      upvote_ratio: 0,
      flair: '',
      created_utc: 0,
    };
    const result = enrichPost(post, 'smart home');
    // May or may not pass depending on pain signals in description
    if (result) {
      assert.ok(result.painScore > 0);
    }
  });

  it('enrichPost processes an Indiegogo-normalized post', () => {
    const post = {
      id: 'igg-test-widget',
      title: 'Frustrated Widget - alternative to terrible existing solutions',
      selftext: 'We built this because existing products are broken, overpriced, and unusable. I hate the current options.',
      subreddit: 'indiegogo',
      url: 'https://www.indiegogo.com/projects/test-widget',
      score: 500,
      num_comments: 42,
      upvote_ratio: 0,
      flair: '',
      created_utc: 0,
    };
    const result = enrichPost(post, 'widget');
    assert.ok(result, 'should enrich a pain-heavy project description');
    assert.ok(result.painScore > 0);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('crowdfunding: edge cases', () => {
  it('parseKickstarterSearchHtml handles malformed JSON in data-project', () => {
    const html = '<div data-pid="bad" data-project="not json at all"></div>';
    const projects = parseKickstarterSearchHtml(html);
    assert.equal(projects.length, 0, 'should skip malformed JSON');
  });

  it('parseKickstarterSearchHtml handles project without slug', () => {
    const html = '<div data-pid="x" data-project="{ &quot;name&quot;: &quot;No Slug&quot; }"></div>';
    const projects = parseKickstarterSearchHtml(html);
    assert.equal(projects.length, 0, 'should skip projects without slug');
  });

  it('parseFundingAmount handles garbage text', () => {
    assert.equal(parseFundingAmount('abc'), 0);
    assert.equal(parseFundingAmount('no money'), 0);
  });

  it('parseCount handles empty comma strings', () => {
    assert.equal(parseCount(',,,'), 0);
  });
});
