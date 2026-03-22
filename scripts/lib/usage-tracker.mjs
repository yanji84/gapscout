/**
 * usage-tracker.mjs — Daily API usage tracking for pain-point-finder
 *
 * Tracks API request counts per source per day, persisted to ~/.pain-points-usage.json.
 * Auto-detects keyed/authed mode by checking ~/.pain-pointsrc tokens.
 * Cleans up entries older than 7 days on every load.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── Daily limits ────────────────────────────────────────────────────────────

const DAILY_LIMITS = {
  'stackoverflow':        { unkeyed: 300, keyed: 10000 },
  'github-issues':        { unauthed: 1440, authed: 120000 },
  'reddit-api':           { default: 1000 },
  'hackernews':           { default: Infinity },
  'producthunt':          { default: 43200 },
  'google-autocomplete':  { default: 500 },
  'reviews':              { default: 200 },
  'trustpilot':           { default: 500 },
  'twitter':              { default: 300 },
  'crowdfunding':         { default: 300 },
  'appstore':             { default: Infinity },
  'websearch':            { default: Infinity },
};

// ─── Token detection ─────────────────────────────────────────────────────────

function loadTokens() {
  try {
    const rc = JSON.parse(readFileSync(resolve(homedir(), '.pain-pointsrc'), 'utf8'));
    return rc.tokens || {};
  } catch {
    return {};
  }
}

function detectLimit(source) {
  const entry = DAILY_LIMITS[source];
  if (!entry) return Infinity;

  if (source === 'stackoverflow') {
    const tokens = loadTokens();
    const hasKey = !!(tokens.STACKEXCHANGE_KEY || process.env.STACKEXCHANGE_KEY);
    return hasKey ? entry.keyed : entry.unkeyed;
  }

  if (source === 'github-issues') {
    const tokens = loadTokens();
    const hasToken = !!(tokens.GITHUB_TOKEN || tokens.GH_TOKEN ||
                        process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    return hasToken ? entry.authed : entry.unauthed;
  }

  return entry.default;
}

function detectAuthLabel(source) {
  if (source === 'stackoverflow') {
    const tokens = loadTokens();
    const hasKey = !!(tokens.STACKEXCHANGE_KEY || process.env.STACKEXCHANGE_KEY);
    return hasKey ? 'keyed' : 'unkeyed';
  }
  if (source === 'github-issues') {
    const tokens = loadTokens();
    const hasToken = !!(tokens.GITHUB_TOKEN || tokens.GH_TOKEN ||
                        process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    return hasToken ? 'authenticated' : 'unauthenticated';
  }
  if (source === 'producthunt') {
    const tokens = loadTokens();
    const hasToken = !!(tokens.PRODUCTHUNT_TOKEN || process.env.PRODUCTHUNT_TOKEN);
    return hasToken ? 'API token' : null;
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

// ─── UsageTracker ────────────────────────────────────────────────────────────

export class UsageTracker {
  constructor(filePath) {
    this._filePath = filePath || resolve(homedir(), '.pain-points-usage.json');
    this._data = this._load();
    this.cleanup();
  }

  _load() {
    try {
      return JSON.parse(readFileSync(this._filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  _save() {
    try {
      writeFileSync(this._filePath, JSON.stringify(this._data, null, 2), 'utf8');
    } catch {
      // Silently ignore write errors (e.g. permission issues)
    }
  }

  /**
   * Record request(s) for a source.
   */
  increment(source, count = 1) {
    const day = todayKey();
    if (!this._data[day]) this._data[day] = {};
    this._data[day][source] = (this._data[day][source] || 0) + count;
    this._save();
  }

  /**
   * Get today's usage for a source.
   */
  getUsage(source) {
    const day = todayKey();
    const requests = (this._data[day] && this._data[day][source]) || 0;
    return { requests, date: day };
  }

  /**
   * Get today's remaining budget for a source.
   */
  getRemaining(source) {
    const { requests } = this.getUsage(source);
    const limit = detectLimit(source);
    const remaining = limit === Infinity ? Infinity : Math.max(0, limit - requests);
    const pct = limit === Infinity ? 0 : (limit > 0 ? Math.round((requests / limit) * 100) : 100);
    return { used: requests, limit, remaining, pct };
  }

  /**
   * Get all sources' usage for today.
   */
  getAllUsage() {
    const result = {};
    for (const source of Object.keys(DAILY_LIMITS)) {
      const { requests } = this.getUsage(source);
      const { limit, remaining, pct } = this.getRemaining(source);
      result[source] = { requests, limit, remaining, pct, authLabel: detectAuthLabel(source) };
    }
    return result;
  }

  /**
   * Reset a source's counter (or all if no source given).
   */
  reset(source) {
    const day = todayKey();
    if (source) {
      if (this._data[day]) delete this._data[day][source];
    } else {
      delete this._data[day];
    }
    this._save();
  }

  /**
   * Remove entries older than 7 days.
   */
  cleanup() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    let changed = false;
    for (const day of Object.keys(this._data)) {
      if (day < cutoffStr) {
        delete this._data[day];
        changed = true;
      }
    }
    if (changed) this._save();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance = null;

export function getUsageTracker() {
  if (!_instance) {
    _instance = new UsageTracker();
  }
  return _instance;
}

export { DAILY_LIMITS, detectLimit, detectAuthLabel };
