/**
 * Citation verification tests — loadCiteKeys, loadSections, findEvidenceArrays logic
 *
 * Since verify-citations.mjs does not export its functions, we test the logic
 * by examining the algorithm indirectly and verifying the end-to-end behavior
 * via file I/O with temp fixtures.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const TEMP_DIR = resolve(import.meta.dirname, 'fixtures', '_tmp_citations');

before(() => {
  mkdirSync(TEMP_DIR, { recursive: true });
});

after(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

function cleanTempDir() {
  for (const f of readdirSync(TEMP_DIR)) {
    unlinkSync(join(TEMP_DIR, f));
  }
}

function writeScanFile(filename, posts) {
  writeFileSync(
    join(TEMP_DIR, filename),
    JSON.stringify({ data: { posts } }),
    'utf8'
  );
}

function writeSectionFile(filename, data) {
  writeFileSync(
    join(TEMP_DIR, filename),
    JSON.stringify(data),
    'utf8'
  );
}

function runVerifyCitations() {
  const scriptPath = resolve(import.meta.dirname, '..', 'verify-citations.mjs');
  try {
    const stdout = execFileSync('node', [scriptPath, '--scan-dir', TEMP_DIR, '--sections', TEMP_DIR], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return { exitCode: 0, output: JSON.parse(stdout) };
  } catch (err) {
    // Non-zero exit codes throw
    const stdout = err.stdout || '';
    try {
      return { exitCode: err.status || 1, output: JSON.parse(stdout) };
    } catch {
      return { exitCode: err.status || 1, output: null, stderr: err.stderr };
    }
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('verify-citations', () => {
  beforeEach(() => {
    cleanTempDir();
  });

  it('passes when all citeKeys in sections exist in scan data', () => {
    writeScanFile('gapscout-reddit.json', [
      { citeKey: 'RD-abc', id: 'reddit-001', title: 'Post 1' },
      { citeKey: 'RD-def', id: 'reddit-002', title: 'Post 2' },
    ]);

    writeSectionFile('gapscout-section-pricing.json', {
      category: 'pricing',
      mentionCount: 2,
      evidence: [
        { citeKey: 'RD-abc', url: 'https://example.com/1' },
        { citeKey: 'RD-def', url: 'https://example.com/2' },
      ],
    });

    const result = runVerifyCitations();
    assert.equal(result.exitCode, 0, `Expected exit code 0, stderr: ${result.stderr || ''}`);
    assert.ok(result.output.verified);
    assert.equal(result.output.phantomCitations.length, 0);
  });

  it('fails when a citeKey in section is not in scan data (phantom)', () => {
    writeScanFile('gapscout-reddit.json', [
      { citeKey: 'RD-abc', id: 'reddit-001', title: 'Post 1' },
    ]);

    writeSectionFile('gapscout-section-pricing.json', {
      category: 'pricing',
      evidence: [
        { citeKey: 'RD-abc', url: 'https://example.com/1' },
        { citeKey: 'PHANTOM-xyz', url: 'https://example.com/2' },
      ],
    });

    const result = runVerifyCitations();
    assert.equal(result.exitCode, 1);
    assert.ok(!result.output.verified);
    assert.ok(result.output.phantomCitations.length > 0);
    assert.equal(result.output.phantomCitations[0].citeKey, 'PHANTOM-xyz');
  });

  it('reports missing URLs', () => {
    writeScanFile('gapscout-reddit.json', [
      { citeKey: 'RD-abc', id: 'reddit-001', title: 'Post 1' },
    ]);

    writeSectionFile('gapscout-section-test.json', {
      evidence: [
        { citeKey: 'RD-abc' },  // no URL
      ],
    });

    const result = runVerifyCitations();
    // Missing URL is not a failure condition, but should be reported
    assert.ok(result.output.missingUrls.length > 0);
    assert.equal(result.output.missingUrls[0].citeKey, 'RD-abc');
  });

  it('detects mentionCount mismatch', () => {
    writeScanFile('gapscout-reddit.json', [
      { citeKey: 'RD-abc', id: 'reddit-001', title: 'Post 1' },
      { citeKey: 'RD-def', id: 'reddit-002', title: 'Post 2' },
      { citeKey: 'RD-ghi', id: 'reddit-003', title: 'Post 3' },
    ]);

    writeSectionFile('gapscout-section-count.json', {
      category: 'test',
      mentionCount: 1,
      evidence: [
        { citeKey: 'RD-abc', url: 'https://example.com/1' },
        { citeKey: 'RD-def', url: 'https://example.com/2' },
        { citeKey: 'RD-ghi', url: 'https://example.com/3' },
      ],
    });

    const result = runVerifyCitations();
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.countMismatches.length > 0);
    assert.equal(result.output.countMismatches[0].mentionCount, 1);
    assert.equal(result.output.countMismatches[0].evidenceLength, 3);
  });

  it('handles nested evidence arrays in section data', () => {
    writeScanFile('gapscout-reddit.json', [
      { citeKey: 'RD-abc', id: 'r1' },
      { citeKey: 'RD-def', id: 'r2' },
    ]);

    writeSectionFile('gapscout-section-nested.json', {
      painPoints: [
        {
          name: 'pricing',
          evidence: [
            { citeKey: 'RD-abc', url: 'https://example.com/1' },
          ],
        },
        {
          name: 'availability',
          evidence: [
            { citeKey: 'RD-def', url: 'https://example.com/2' },
          ],
        },
      ],
    });

    const result = runVerifyCitations();
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.totalCitations, 2);
  });

  it('validates using post id as fallback key', () => {
    writeScanFile('gapscout-reddit.json', [
      { id: 'reddit-001', title: 'Post without citeKey' },
    ]);

    writeSectionFile('gapscout-section-id.json', {
      evidence: [
        { citeKey: 'reddit-001', url: 'https://example.com/1' },
      ],
    });

    const result = runVerifyCitations();
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.verified);
  });

  it('returns verified=true with 0 citations when no sections exist', () => {
    writeScanFile('gapscout-reddit.json', [{ citeKey: 'RD-abc' }]);
    // No section files written

    const result = runVerifyCitations();
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.verified);
    assert.equal(result.output.totalCitations, 0);
  });
});
