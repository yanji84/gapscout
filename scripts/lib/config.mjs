/**
 * config.mjs — Configuration system for gapscout
 *
 * Loads ~/.pain-pointsrc (JSON format) and provides a merge-precedence
 * configuration: CLI args > domain config > global config > defaults.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── defaults ───────────────────────────────────────────────────────────────

const DEFAULTS = {
  global: {
    chrome: {
      port: 9222,
      timeout_ms: 30000,
    },
    rate_limit: {
      max_per_minute: 30,
      min_delay_ms: 1000,
    },
  },
  domains: {},
};

// ─── ConfigManager ──────────────────────────────────────────────────────────

export class ConfigManager {
  /**
   * @param {object} [cliArgs={}] - CLI arguments (highest precedence)
   * @param {string} [configPath] - Path to config file (default: ~/.pain-pointsrc)
   */
  constructor(cliArgs = {}, configPath) {
    this._cliArgs = cliArgs;
    this._configPath = configPath || resolve(homedir(), '.pain-pointsrc');
    this._fileConfig = this._loadConfigFile();
    this._merged = this._mergeAll();
  }

  /**
   * Load the config file. Returns empty config if file doesn't exist.
   */
  _loadConfigFile() {
    try {
      const raw = readFileSync(this._configPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      // File doesn't exist or invalid JSON — use defaults
      return {};
    }
  }

  /**
   * Deep merge two objects (source into target).
   */
  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  /**
   * Merge all config sources.
   */
  _mergeAll() {
    // Start with defaults
    let config = JSON.parse(JSON.stringify(DEFAULTS));

    // Merge file config
    if (this._fileConfig.global) {
      config.global = this._deepMerge(config.global, this._fileConfig.global);
    }
    if (this._fileConfig.domains) {
      config.domains = this._deepMerge(config.domains, this._fileConfig.domains);
    }

    return config;
  }

  /**
   * Get a config value by dot-separated path.
   *
   * @param {string} path - e.g. 'global.chrome.port' or 'domains.ticketing.sources'
   * @param {*} [fallback] - Default value if path not found
   * @returns {*}
   */
  get(path, fallback) {
    // Check CLI args first (flat keys)
    const cliKey = path.split('.').pop();
    if (this._cliArgs[cliKey] !== undefined) {
      return this._cliArgs[cliKey];
    }

    // Walk the merged config
    const parts = path.split('.');
    let current = this._merged;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return fallback;
      current = current[part];
    }
    return current !== undefined ? current : fallback;
  }

  /**
   * Get source list for a domain.
   * Falls back to all available sources if not configured.
   *
   * @param {string} [domainName]
   * @returns {string[]}
   */
  getSources(domainName) {
    if (domainName && this._merged.domains[domainName]?.sources) {
      return this._merged.domains[domainName].sources;
    }
    return this._cliArgs.sources
      ? String(this._cliArgs.sources).split(',').map(s => s.trim())
      : [];
  }

  /**
   * Get source quality multiplier overrides.
   * @returns {object}
   */
  getSourceQuality() {
    return this.get('global.source_quality', {});
  }

  /**
   * Get Chrome/browser config.
   * @returns {{ port: number, timeout_ms: number }}
   */
  getChromeConfig() {
    return {
      port: this._cliArgs.port || this.get('global.chrome.port', 9222),
      timeout_ms: this.get('global.chrome.timeout_ms', 30000),
    };
  }

  /**
   * Get the scoring profile name for a domain.
   *
   * @param {string} [domainName]
   * @returns {string}
   */
  getScoringProfile(domainName) {
    if (domainName && this._merged.domains[domainName]?.scoring_profile) {
      return this._merged.domains[domainName].scoring_profile;
    }
    return this._cliArgs.scoringProfile || 'default';
  }

  /**
   * Get the full merged config (for debugging).
   * @returns {object}
   */
  toJSON() {
    return this._merged;
  }
}

// ─── token loader ────────────────────────────────────────────────────────────

/**
 * Read tokens from ~/.pain-pointsrc and export them as environment variables.
 * Call this early in the CLI entry point (before any source is loaded)
 * so all sources benefit from persisted tokens via process.env.
 *
 * Only sets env vars that are not already set (env takes precedence).
 */
export function loadAndExportTokens(configPath) {
  const rcPath = configPath || resolve(homedir(), '.pain-pointsrc');
  let rc;
  try {
    const raw = readFileSync(rcPath, 'utf8');
    rc = JSON.parse(raw);
  } catch {
    return; // no config file or invalid JSON — nothing to do
  }

  const tokens = rc && rc.tokens;
  if (!tokens || typeof tokens !== 'object') return;

  for (const [key, value] of Object.entries(tokens)) {
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
