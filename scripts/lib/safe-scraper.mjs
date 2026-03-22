/**
 * safe-scraper.mjs — Safety wrapper for browser-based scraping
 *
 * Enforces request caps, block detection, and minimum delays.
 * Sources wrap their page-fetch logic in `request(fn)` to get
 * automatic rate limiting, block counting, and graceful degradation.
 */

import { RateMonitor, getGlobalRateMonitor } from './rate-monitor.mjs';

// ─── SafeScraper ─────────────────────────────────────────────────────────────

export class SafeScraper {
  /**
   * @param {string} source - Source name for logging (e.g. 'reviews', 'trustpilot')
   * @param {object} [options]
   * @param {number} [options.maxRequests=100] - Hard cap on total requests
   * @param {number} [options.maxBlocksBeforeStop=3] - Stop after N consecutive blocks
   * @param {number} [options.minDelayMs=1500] - Minimum delay between requests
   * @param {number} [options.maxDelayMs=5000] - Maximum delay (for jitter)
   * @param {RateMonitor} [options.rateMonitor] - RateMonitor instance (defaults to global)
   */
  constructor(source, options = {}) {
    this.source = source;
    this.maxRequests = options.maxRequests ?? 100;
    this.maxBlocksBeforeStop = options.maxBlocksBeforeStop ?? 3;
    this.minDelayMs = options.minDelayMs ?? 1500;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.rateMonitor = options.rateMonitor ?? getGlobalRateMonitor();

    // Internal state
    this._requestCount = 0;
    this._blockCount = 0;
    this._consecutiveBlocks = 0;
    this._warningCount = 0;
    this._stopped = false;
    this._lastRequestTime = 0;
  }

  /**
   * Wrap a request function with delay, block detection, and counting.
   *
   * The provided `fn` should:
   *   - Return a result on success
   *   - Throw an error with `isBlock = true` if a block/CAPTCHA is detected
   *   - Throw a normal error for transient failures
   *
   * @param {Function} fn - Async function that performs the actual request
   * @returns {Promise<*>} Result of fn, or null if blocked/capped
   */
  async request(fn) {
    // Check if we should stop
    if (!this.canContinue()) {
      return null;
    }

    // Enforce minimum delay with jitter
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    const jitter = Math.floor(Math.random() * (this.maxDelayMs - this.minDelayMs));
    const targetDelay = this.minDelayMs + jitter;
    if (this._lastRequestTime > 0 && elapsed < targetDelay) {
      await new Promise(r => setTimeout(r, targetDelay - elapsed));
    }

    this._requestCount++;
    this._lastRequestTime = Date.now();

    // Warn when approaching the request cap
    const remaining = this.maxRequests - this._requestCount;
    if (remaining === Math.floor(this.maxRequests * 0.15)) {
      this._warningCount++;
      this.rateMonitor.reportWarning(
        this.source,
        `Rate limit approaching: ${remaining} requests remaining out of ${this.maxRequests}`
      );
    }

    try {
      const result = await fn();
      // Successful request resets consecutive block counter
      this._consecutiveBlocks = 0;
      return result;
    } catch (err) {
      if (err.isBlock) {
        this._blockCount++;
        this._consecutiveBlocks++;
        this.rateMonitor.reportBlock(
          this.source,
          `${err.message || 'Blocked'} after ${this._requestCount} requests. Returning partial results.`,
          { requestCount: this._requestCount, consecutiveBlocks: this._consecutiveBlocks }
        );

        if (this._consecutiveBlocks >= this.maxBlocksBeforeStop) {
          this._stopped = true;
          this.rateMonitor.reportWarning(
            this.source,
            `Stopping: ${this._consecutiveBlocks} consecutive blocks reached limit of ${this.maxBlocksBeforeStop}. Returning partial results.`
          );
        }
        return null;
      }

      // Handle HTTP status-based errors
      const status = err.statusCode || err.status;
      if (status === 429) {
        this._warningCount++;
        this.rateMonitor.reportError(
          this.source,
          `HTTP 429 Too Many Requests after ${this._requestCount} requests`,
          { statusCode: 429, requestCount: this._requestCount }
        );
        // Back off on 429 — wait extra time
        await new Promise(r => setTimeout(r, this.maxDelayMs * 2));
        return null;
      }
      if (status === 403) {
        this._blockCount++;
        this._consecutiveBlocks++;
        this.rateMonitor.reportError(
          this.source,
          `HTTP 403 Forbidden after ${this._requestCount} requests`,
          { statusCode: 403, requestCount: this._requestCount }
        );
        return null;
      }
      if (status >= 500) {
        this.rateMonitor.reportError(
          this.source,
          `HTTP ${status} server error after ${this._requestCount} requests`,
          { statusCode: status, requestCount: this._requestCount }
        );
        return null;
      }

      // Re-throw unexpected errors
      throw err;
    }
  }

  /**
   * Check whether this scraper can continue making requests.
   * Returns false if maxRequests hit or too many consecutive blocks.
   * @returns {boolean}
   */
  canContinue() {
    if (this._stopped) return false;

    if (this._requestCount >= this.maxRequests) {
      if (!this._stopped) {
        this._stopped = true;
        this.rateMonitor.reportWarning(
          this.source,
          `Request cap reached: ${this._requestCount}/${this.maxRequests}. Returning partial results.`
        );
      }
      return false;
    }

    if (this._consecutiveBlocks >= this.maxBlocksBeforeStop) {
      return false;
    }

    return true;
  }

  /**
   * Get statistics about this scraper's activity.
   * @returns {{ requests: number, blocks: number, warnings: number, partialResults: boolean }}
   */
  getStats() {
    return {
      requests: this._requestCount,
      blocks: this._blockCount,
      warnings: this._warningCount,
      partialResults: this._stopped || this._blockCount > 0,
    };
  }
}
