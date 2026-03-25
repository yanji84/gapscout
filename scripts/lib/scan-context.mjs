/**
 * scan-context.mjs — Per-scan context for gapscout
 *
 * Holds scanId and scanDir, provides helpers for output paths,
 * manifest writing, and atomic result writing.
 */

import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export class ScanContext {
  /**
   * @param {object} opts
   * @param {string|null} opts.scanId  - Optional scan identifier
   * @param {string|null} opts.scanDir - Optional directory for per-scan output
   */
  constructor({ scanId = null, scanDir = null } = {}) {
    this.scanId = scanId;
    this.scanDir = scanDir;

    // Ensure scanDir exists when provided
    if (this.scanDir) {
      mkdirSync(this.scanDir, { recursive: true });
    }
  }

  /**
   * Get the output file path for a given source.
   *
   * - If scanDir is set: <scanDir>/<sourceName>-result.json
   * - Otherwise: /tmp/gapscout-<sourceName>-raw.json (backward-compatible default)
   *
   * @param {string} sourceName
   * @returns {string}
   */
  getScanOutputPath(sourceName) {
    if (this.scanDir) {
      return join(this.scanDir, `${sourceName}-result.json`);
    }
    return `/tmp/gapscout-${sourceName}-raw.json`;
  }

  /**
   * Write a manifest.json to scanDir listing expected sources and scan metadata.
   * No-op if scanDir is not set.
   *
   * @param {string[]} expectedSources - List of source names that will be scanned
   */
  writeManifest(expectedSources) {
    if (!this.scanDir) return;

    const manifest = {
      scanId: this.scanId,
      createdAt: new Date().toISOString(),
      expectedSources,
      status: 'running',
    };

    const manifestPath = join(this.scanDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  /**
   * Atomically write a result file: write to .tmp first, then rename.
   *
   * @param {string} sourceName
   * @param {object} envelope - The output envelope to serialize
   */
  writeResult(sourceName, envelope) {
    const finalPath = this.getScanOutputPath(sourceName);
    const tmpPath = finalPath + '.tmp';

    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, finalPath);
  }
}
