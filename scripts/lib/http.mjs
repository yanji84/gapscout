/**
 * http.mjs — Shared HTTP client and rate limiter for gapscout
 *
 * Consolidates HTTP request logic, retry/backoff, and rate limiting
 * from reddit-api.mjs and hackernews.mjs into reusable utilities.
 */

import https from 'node:https';
import { sleep, log } from './utils.mjs';
import { getGlobalRateMonitor } from './rate-monitor.mjs';

// ─── configurable constants ──────────────────────────────────────────────────

export const MIN_DELAY_MS = 1000;
export const MAX_PER_MIN = 30;
export const MAX_RETRIES = 5;
export const BACKOFF_BASE_MS = 2000;
export const REQUEST_TIMEOUT_MS = 15000;

/**
 * Reddit-compliant User-Agent string.
 * Reddit requires: <platform>:<app_id>:<version> (by /u/<username>)
 */
export const REDDIT_USER_AGENT = 'node:gapscout:5.0 (by /u/gapscout-bot)';

/** Generic User-Agent for non-Reddit APIs */
export const DEFAULT_USER_AGENT = 'gapscout/5.0';

/**
 * Global _rateLimitWarning flag. When set to true, rate limit warnings
 * are emitted to stderr so the user sees them immediately.
 */
export let _rateLimitWarning = false;

export function setRateLimitWarning(value) {
  _rateLimitWarning = value;
}

function emitRateLimitWarning(message) {
  setRateLimitWarning(true);
  process.stderr.write(`\n⚠ RATE LIMIT WARNING: ${message}\n\n`);
}

// ─── RateLimiter ─────────────────────────────────────────────────────────────

/**
 * Per-minute + per-run rate limiter with minimum delay between requests.
 *
 * @param {object} [options]
 * @param {number} [options.minDelayMs=1000] - Minimum ms between requests
 * @param {number} [options.jitterMs=200] - Random jitter added to min delay
 * @param {number} [options.maxPerMin=30] - Max requests per rolling minute
 * @param {number} [options.maxPerRun=Infinity] - Max total requests per limiter lifetime
 */
export class RateLimiter {
  constructor(options = {}) {
    this.minDelayMs = options.minDelayMs ?? MIN_DELAY_MS;
    this.jitterMs = options.jitterMs ?? 200;
    this.maxPerMin = options.maxPerMin ?? MAX_PER_MIN;
    this.maxPerRun = options.maxPerRun ?? Infinity;
    this.timestamps = [];
    this.totalRequests = 0;
    this.lastRequestAt = 0;
  }

  async wait() {
    if (this.totalRequests >= this.maxPerRun) {
      emitRateLimitWarning(`max ${this.maxPerRun} requests per run exceeded — stopping`);
      getGlobalRateMonitor().reportError('http', `Per-run limit exceeded (${this.maxPerRun} requests)`);
      throw new Error(`Rate limit: max ${this.maxPerRun} requests per run exceeded`);
    }

    // Warn when approaching per-run limit (90% threshold)
    if (this.maxPerRun < Infinity) {
      const remaining = this.maxPerRun - this.totalRequests;
      const threshold = Math.max(10, Math.floor(this.maxPerRun * 0.1));
      if (remaining === threshold) {
        emitRateLimitWarning(`approaching rate limit: ${remaining} requests remaining out of ${this.maxPerRun}`);
        getGlobalRateMonitor().reportWarning('http', `Approaching per-run limit: ${remaining}/${this.maxPerRun} requests remaining`);
      }
    }

    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60000);

    // Warn when approaching per-minute limit (80% threshold)
    const perMinRemaining = this.maxPerMin - this.timestamps.length;
    if (perMinRemaining <= Math.max(3, Math.floor(this.maxPerMin * 0.2)) && perMinRemaining > 0) {
      if (!this._perMinWarned) {
        this._perMinWarned = true;
        emitRateLimitWarning(`approaching per-minute rate limit: ${perMinRemaining} requests remaining this minute (max ${this.maxPerMin}/min)`);
      }
    } else {
      this._perMinWarned = false;
    }

    if (this.timestamps.length >= this.maxPerMin) {
      const oldest = this.timestamps[0];
      const waitMs = 60000 - (now - oldest) + 100;
      emitRateLimitWarning(`per-minute cap hit (${this.maxPerMin}/min), sleeping ${waitMs}ms`);
      getGlobalRateMonitor().reportWarning('http', `Per-minute cap hit (${this.maxPerMin}/min), sleeping ${waitMs}ms`);
      await sleep(waitMs);
    }
    const elapsed = Date.now() - this.lastRequestAt;
    const minWait = this.minDelayMs + Math.floor(Math.random() * this.jitterMs);
    if (elapsed < minWait) {
      await sleep(minWait - elapsed);
    }
    this.timestamps.push(Date.now());
    this.lastRequestAt = Date.now();
    this.totalRequests++;
  }

  get count() { return this.totalRequests; }
}

// ─── httpGet ─────────────────────────────────────────────────────────────────

/**
 * Make an HTTPS GET request and return parsed JSON.
 *
 * @param {string} hostname - Target hostname
 * @param {string} path - Request path (including query string)
 * @param {object} [options]
 * @param {number} [options.timeout=15000] - Request timeout in ms
 * @param {object} [options.headers] - Additional request headers
 * @returns {Promise<any>} Parsed JSON response
 */
export function httpGet(hostname, path, options = {}) {
  const timeout = options.timeout ?? REQUEST_TIMEOUT_MS;
  const headers = {
    'User-Agent': options.headers?.['User-Agent'] || DEFAULT_USER_AGENT,
    ...(options.headers || {}),
  };

  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname,
      path,
      headers,
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`)); }
        } else if (res.statusCode === 429) {
          emitRateLimitWarning(`HTTP 429 Too Many Requests from ${hostname} — being rate limited`);
          getGlobalRateMonitor().reportError('http', `HTTP 429 from ${hostname}`, { statusCode: 429, hostname, path });
          const err = new Error(`HTTP 429 (rate limited)`);
          err.statusCode = 429;
          // Parse Retry-After header if present
          const retryAfter = res.headers['retry-after'];
          if (retryAfter) err.retryAfterSec = parseInt(retryAfter, 10) || 60;
          reject(err);
        } else if (res.statusCode === 403) {
          emitRateLimitWarning(`HTTP 403 Forbidden from ${hostname} — possible IP ban or auth failure`);
          getGlobalRateMonitor().reportBlock('http', `HTTP 403 from ${hostname} — possible IP ban or auth failure`, { statusCode: 403, hostname, path });
          const err = new Error(`HTTP 403 (forbidden/blocked)`);
          err.statusCode = 403;
          reject(err);
        } else {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * Make an HTTPS GET request with automatic retry and exponential backoff.
 *
 * @param {string} hostname - Target hostname
 * @param {string} path - Request path (including query string)
 * @param {object} [options]
 * @param {number} [options.maxRetries=5] - Max retry attempts
 * @param {number} [options.backoffBaseMs=2000] - Base backoff in ms (doubles each retry)
 * @param {number} [options.timeout=15000] - Request timeout in ms
 * @param {object} [options.headers] - Additional request headers
 * @param {RateLimiter} [options.rateLimiter] - Optional rate limiter to call .wait() before each attempt
 * @returns {Promise<any>} Parsed JSON response
 */
export async function httpGetWithRetry(hostname, path, options = {}) {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
  const rateLimiter = options.rateLimiter || null;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (rateLimiter) await rateLimiter.wait();
      if (attempt > 0 && !rateLimiter) {
        const backoff = backoffBaseMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * backoff * 0.5);
        const delay = backoff + jitter;
        log(`[http] retry ${attempt} in ${delay}ms`);
        await sleep(delay);
      }
      return await httpGet(hostname, path, options);
    } catch (err) {
      lastErr = err;
      const code = err.statusCode || 0;

      // 404 is not retryable
      if (code === 404) throw err;

      // 403 — possible ban; do not retry, let caller handle gracefully
      if (code === 403) throw err;

      // Determine max retries for this error type
      let maxForType = maxRetries;
      if (code === 429) maxForType = maxRetries; // always allow full retries for 429
      else if (code >= 500) maxForType = Math.min(maxRetries, 3);
      else if (err.message === 'timeout') maxForType = Math.min(maxRetries, 1);

      if (attempt >= maxForType) break;

      // Exponential backoff; respect Retry-After header for 429s
      let backoff;
      if (code === 429 && err.retryAfterSec) {
        backoff = err.retryAfterSec * 1000;
      } else {
        backoff = backoffBaseMs * Math.pow(2, attempt);
      }
      const jitter = Math.floor(Math.random() * backoff * 0.5);
      const delay = backoff + jitter;
      log(`[http] ${err.message} — retry ${attempt + 1}/${maxForType} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}
