/**
 * rate-monitor.mjs — Centralized rate limit alerting and monitoring
 *
 * All sources can use this module to report rate limit events.
 * Alerts are printed to stderr immediately for real-time visibility.
 * A summary is available for inclusion in the final report.
 */

// ─── RateMonitor ─────────────────────────────────────────────────────────────

export class RateMonitor {
  constructor() {
    this._warnings = [];
    this._blocks = [];
    this._errors = [];
  }

  /**
   * Report a rate limit warning (approaching limits).
   * @param {string} source - Source name (e.g. 'reddit-api', 'reviews')
   * @param {string} message - Human-readable description
   * @param {object} [details] - Extra metadata (remaining, limit, etc.)
   */
  reportWarning(source, message, details = {}) {
    const entry = { source, message, details, timestamp: new Date().toISOString() };
    this._warnings.push(entry);
    this.alert(source, 'warning', message);
  }

  /**
   * Report a block event (CAPTCHA, Cloudflare challenge, IP block).
   * @param {string} source - Source name
   * @param {string} message - Human-readable description
   * @param {object} [details] - Extra metadata (requestCount, etc.)
   */
  reportBlock(source, message, details = {}) {
    const entry = { source, message, details, timestamp: new Date().toISOString() };
    this._blocks.push(entry);
    this.alert(source, 'block', message);
  }

  /**
   * Report an API error (429, 403, 5xx).
   * @param {string} source - Source name
   * @param {string} message - Human-readable description
   * @param {object} [details] - Extra metadata (statusCode, url, etc.)
   */
  reportError(source, message, details = {}) {
    const entry = { source, message, details, timestamp: new Date().toISOString() };
    this._errors.push(entry);
    this.alert(source, 'error', message);
  }

  /**
   * Get a summary of all recorded events.
   * @returns {{ warnings: Array, blocks: Array, errors: Array }}
   */
  getSummary() {
    return {
      warnings: [...this._warnings],
      blocks: [...this._blocks],
      errors: [...this._errors],
    };
  }

  /**
   * Check if any issues have been recorded.
   * @returns {boolean}
   */
  hasIssues() {
    return this._warnings.length > 0 || this._blocks.length > 0 || this._errors.length > 0;
  }

  /**
   * Get a per-source breakdown of issues.
   * @returns {Map<string, { warnings: number, blocks: number, errors: number }>}
   */
  getSourceBreakdown() {
    const map = new Map();
    const bump = (source, field) => {
      if (!map.has(source)) map.set(source, { warnings: 0, blocks: 0, errors: 0 });
      map.get(source)[field]++;
    };
    for (const w of this._warnings) bump(w.source, 'warnings');
    for (const b of this._blocks) bump(b.source, 'blocks');
    for (const e of this._errors) bump(e.source, 'errors');
    return map;
  }

  /**
   * Print an alert to stderr immediately for real-time visibility.
   * Uses ASCII markers for portability.
   * @param {string} source - Source name
   * @param {'warning'|'block'|'error'} level - Alert level
   * @param {string} message - Human-readable message
   */
  alert(source, level, message) {
    let prefix;
    switch (level) {
      case 'block':
        prefix = '[BLOCKED]';
        break;
      case 'error':
        prefix = '[ERROR]';
        break;
      case 'warning':
      default:
        prefix = '[!]';
        break;
    }
    process.stderr.write(`${prefix} [${source}] ${message}\n`);
  }

  /**
   * Reset all recorded events.
   */
  reset() {
    this._warnings = [];
    this._blocks = [];
    this._errors = [];
  }
}

// ─── singleton ───────────────────────────────────────────────────────────────

let _globalMonitor = null;

/**
 * Get or create the global RateMonitor singleton.
 * @returns {RateMonitor}
 */
export function getGlobalRateMonitor() {
  if (!_globalMonitor) {
    _globalMonitor = new RateMonitor();
  }
  return _globalMonitor;
}
