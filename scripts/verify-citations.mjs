#!/usr/bin/env node

/**
 * verify-citations.mjs — Check analyst output for hallucinated citations
 *
 * Runs between Steps 6A and 6B of synthesis. Validates that every citeKey
 * in analyst section files exists in the scan data, checks URL presence,
 * and verifies mention-count consistency.
 *
 * Usage:
 *   pain-points verify-citations --scan-dir /tmp --sections /tmp
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { normalizeArgs, log } from './lib/utils.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Load all scan data files from a directory and build a Set of valid citeKeys. */
function loadCiteKeys(scanDir) {
  const keys = new Set();
  const files = readdirSync(scanDir).filter(
    f => f.startsWith('gapscout-') && f.endsWith('.json') && !f.includes('-section-')
  );

  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(scanDir, f), 'utf8'));
      const posts = raw?.data?.posts || raw?.posts || (Array.isArray(raw) ? raw : []);
      for (const p of posts) {
        if (p.citeKey) keys.add(p.citeKey);
        if (p.id) keys.add(p.id);
      }
    } catch {
      log(`[verify-citations] Warning: could not parse ${f}`);
    }
  }

  return keys;
}

/** Load all analyst section files from a directory. */
function loadSections(sectionsDir) {
  const files = readdirSync(sectionsDir).filter(
    f => f.startsWith('gapscout-section-') && f.endsWith('.json')
  );
  const sections = [];
  for (const f of files) {
    try {
      sections.push({
        file: f,
        data: JSON.parse(readFileSync(join(sectionsDir, f), 'utf8')),
      });
    } catch {
      log(`[verify-citations] Warning: could not parse ${f}`);
    }
  }
  return sections;
}

/** Recursively walk an object, collecting all `evidence` arrays. */
function findEvidenceArrays(obj, path = '') {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...findEvidenceArrays(obj[i], `${path}[${i}]`));
    }
    return results;
  }

  if (Array.isArray(obj.evidence)) {
    results.push({ path, evidence: obj.evidence, mentionCount: obj.mentionCount });
  }

  for (const [key, val] of Object.entries(obj)) {
    if (key === 'evidence') continue; // already handled above
    results.push(...findEvidenceArrays(val, path ? `${path}.${key}` : key));
  }

  return results;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = normalizeArgs(argv);

  if (args.help || argv.includes('--help')) {
    process.stderr.write(`
pain-points verify-citations — Check analyst output for hallucinated citations

Usage:
  pain-points verify-citations --scan-dir /tmp --sections /tmp

Options:
  --scan-dir <path>   Directory containing gapscout-*.json scan files (default: /tmp)
  --sections <path>   Directory containing gapscout-section-*.json analyst outputs (default: /tmp)
  --help              Show this help
`);
    process.exit(0);
  }

  const scanDir = resolve(args.scanDir || '/tmp');
  const sectionsDir = resolve(args.sections || '/tmp');

  log(`[verify-citations] Loading scan data from ${scanDir}`);
  const validKeys = loadCiteKeys(scanDir);
  log(`[verify-citations] Found ${validKeys.size} valid citeKeys`);

  log(`[verify-citations] Loading analyst sections from ${sectionsDir}`);
  const sections = loadSections(sectionsDir);
  log(`[verify-citations] Found ${sections.length} section file(s)`);

  if (sections.length === 0) {
    log('[verify-citations] No section files found. Nothing to verify.');
    process.stdout.write(JSON.stringify({ verified: true, totalCitations: 0, phantomCitations: [], missingUrls: [], countMismatches: [], summary: '0/0 citations verified (0 phantoms, 0 missing URLs)' }, null, 2) + '\n');
    process.exit(0);
  }

  const phantomCitations = [];
  const missingUrls = [];
  const countMismatches = [];
  let totalCitations = 0;

  for (const section of sections) {
    const groups = findEvidenceArrays(section.data);

    for (const { path, evidence, mentionCount } of groups) {
      totalCitations += evidence.length;

      for (const entry of evidence) {
        const key = entry.citeKey || entry.cite_key || entry.id;
        if (key && !validKeys.has(key)) {
          phantomCitations.push({ file: section.file, path, citeKey: key });
        }
        if (!entry.url) {
          missingUrls.push({ file: section.file, path, citeKey: key || '(none)' });
        }
      }

      if (mentionCount != null && evidence.length > mentionCount) {
        countMismatches.push({
          file: section.file,
          path,
          mentionCount,
          evidenceLength: evidence.length,
        });
      }
    }
  }

  const verified = phantomCitations.length === 0 && countMismatches.length === 0;
  const verifiedCount = totalCitations - phantomCitations.length;

  const report = {
    verified,
    totalCitations,
    phantomCitations,
    missingUrls,
    countMismatches,
    summary: `${verifiedCount}/${totalCitations} citations verified (${phantomCitations.length} phantoms, ${missingUrls.length} missing URLs)`,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (!verified) {
    log(`[verify-citations] FAILED: ${report.summary}`);
    process.exit(1);
  }

  log(`[verify-citations] PASSED: ${report.summary}`);
}

main().catch(err => {
  process.stderr.write(`[verify-citations] Fatal: ${err.message}\n`);
  process.exit(1);
});
