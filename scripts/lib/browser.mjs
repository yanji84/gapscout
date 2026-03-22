/**
 * browser.mjs — Shared browser connection utilities for pain-point-finder
 *
 * Consolidates duplicated browser connection logic from all Puppeteer-based
 * source modules (reddit-browser, producthunt, reviews, crowdfunding,
 * appstore, google-autocomplete, websearch).
 */

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { sleep, log, fail } from './utils.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_DELAY_MS = 1500;
export const DEFAULT_JITTER_MS = 500;

// Common Chrome executable paths for fallback launching
export const CHROME_EXECUTABLES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/local/bin/chromium',
];

// ─── politeDelay ─────────────────────────────────────────────────────────────

/**
 * Wait a polite amount of time between page loads to avoid rate-limiting.
 * @param {number} ms - Base delay in milliseconds (default: 1500)
 * @param {number} jitter - Random jitter in milliseconds (default: 500)
 */
export async function politeDelay(ms = DEFAULT_PAGE_DELAY_MS, jitter = DEFAULT_JITTER_MS) {
  await sleep(ms + Math.floor(Math.random() * jitter));
}

// ─── probePort ───────────────────────────────────────────────────────────────

/**
 * Probe a Chrome debug port and return the WebSocket debugger URL if alive.
 * Returns null if the port is not responding.
 */
export async function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.webSocketDebuggerUrl || null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ─── getWSFromPort ───────────────────────────────────────────────────────────

/**
 * Get the WebSocket debugger URL from a Chrome debug port.
 * Throws if the port is unreachable or returns invalid JSON.
 */
export function getWSFromPort(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body).webSocketDebuggerUrl); }
        catch (err) { reject(new Error(`Cannot parse Chrome debug info: ${err.message}`)); }
      });
    }).on('error', reject);
  });
}

// ─── findChromeWSEndpoint ────────────────────────────────────────────────────

/**
 * Auto-detect a running Chrome instance by scanning tmpdir for Puppeteer
 * profile directories containing DevToolsActivePort files.
 *
 * @param {string} [logTag='browser'] - Tag for log messages
 * @returns {Promise<string|null>} WebSocket URL or null
 */
export async function findChromeWSEndpoint(logTag = 'browser') {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpdir = os.default.tmpdir();
  let entries;
  try { entries = fs.default.readdirSync(tmpdir); } catch { return null; }
  const candidates = [];
  for (const entry of entries) {
    if (entry.startsWith('puppeteer_dev_chrome_profile')) {
      const portFile = path.default.join(tmpdir, entry, 'DevToolsActivePort');
      if (fs.default.existsSync(portFile)) {
        const content = fs.default.readFileSync(portFile, 'utf8').trim();
        const lines = content.split('\n');
        if (lines.length >= 2) {
          candidates.push({ port: lines[0].trim(), wsPath: lines[1].trim() });
        }
      }
    }
  }
  // Validate each candidate by probing the HTTP endpoint
  for (const { port, wsPath } of candidates) {
    const wsUrl = await probePort(parseInt(port, 10));
    if (wsUrl) {
      log(`[${logTag}] found Chrome at ws://127.0.0.1:${port}${wsPath}`);
      return wsUrl;
    }
    log(`[${logTag}] Chrome port ${port} not responding, skipping`);
  }
  return null;
}

// ─── findChromeExecutable ────────────────────────────────────────────────────

/**
 * Find a Chrome/Chromium executable on the system.
 * @returns {Promise<string|null>} Path to executable or null
 */
export async function findChromeExecutable() {
  const { existsSync } = await import('node:fs').then(m => m.default || m);
  for (const exe of CHROME_EXECUTABLES) {
    if (existsSync(exe)) return exe;
  }
  return null;
}

// ─── connectBrowser ──────────────────────────────────────────────────────────

/**
 * Connect to an existing Chrome instance via Puppeteer.
 * Tries (in order): args.wsUrl, args.port, auto-detect from tmpdir.
 *
 * @param {object} args - CLI args object
 * @param {object} [options] - Additional options
 * @param {string} [options.logTag='browser'] - Tag for log messages
 * @param {boolean} [options.canLaunch=false] - If true, attempt to launch Chrome as fallback
 * @param {boolean} [options.tryPort9222=false] - If true, try default port 9222 before auto-detect
 * @param {boolean} [options.throwOnFail=false] - If true, throw instead of calling fail()
 * @returns {Promise<Browser>} Puppeteer Browser instance
 */
export async function connectBrowser(args, options = {}) {
  const logTag = options.logTag || 'browser';
  const canLaunch = options.canLaunch || false;
  const tryPort9222 = options.tryPort9222 || false;
  const throwOnFail = options.throwOnFail || false;

  if (args.wsUrl) {
    log(`[${logTag}] connecting to ${args.wsUrl}`);
    return await puppeteer.connect({ browserWSEndpoint: args.wsUrl });
  }
  if (args.port) {
    const wsUrl = await getWSFromPort(args.port);
    log(`[${logTag}] connecting via port ${args.port}`);
    return await puppeteer.connect({ browserWSEndpoint: wsUrl });
  }

  // Try default port 9222 if requested
  if (tryPort9222) {
    try {
      const wsUrl = await getWSFromPort(9222);
      log(`[${logTag}] connecting via default port 9222`);
      return await puppeteer.connect({ browserWSEndpoint: wsUrl });
    } catch {
      // Fall through to auto-detect
    }
  }

  const wsUrl = await findChromeWSEndpoint(logTag);
  if (wsUrl) {
    try { return await puppeteer.connect({ browserWSEndpoint: wsUrl }); }
    catch (err) { log(`[${logTag}] auto-detect failed: ${err.message}`); }
  }

  // Attempt to launch Chrome if allowed
  if (canLaunch) {
    const execPath = await findChromeExecutable();
    if (execPath) {
      log(`[${logTag}] launching Chrome: ${execPath}`);
      const browser = await puppeteer.launch({
        executablePath: execPath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--window-size=1280,900',
        ],
      });
      return browser;
    }
  }

  const errorMsg = 'No Chrome browser found. Start puppeteer-mcp-server, or pass --ws-url / --port';
  if (throwOnFail) {
    throw new Error(errorMsg);
  }
  fail(errorMsg);
}

// ─── detectBlock ──────────────────────────────────────────────────────────────

/**
 * Detect common block/CAPTCHA/rate-limit indicators in an HTML string.
 * Returns { blocked: boolean, reason: string|null }.
 *
 * Checks for:
 *  - Cloudflare challenge pages ("Just a moment", cf-browser-verification)
 *  - "Access Denied" / "403 Forbidden"
 *  - CAPTCHA / reCAPTCHA
 *  - "Rate limit exceeded"
 *  - Empty response with error indicators
 *  - Common anti-bot phrases
 */
export function detectBlock(html) {
  if (!html || typeof html !== 'string') {
    return { blocked: true, reason: 'empty-response' };
  }

  const lower = html.toLowerCase();

  // Cloudflare challenge
  if (lower.includes('just a moment') && lower.includes('cloudflare')) {
    return { blocked: true, reason: 'cloudflare-challenge' };
  }
  if (lower.includes('cf-browser-verification') ||
      lower.includes('cf-challenge-running') ||
      lower.includes('cf-error-code') ||
      lower.includes('challenge-form') ||
      lower.includes('checking your browser')) {
    return { blocked: true, reason: 'cloudflare-challenge' };
  }

  // Access denied / 403
  if (lower.includes('access denied') || lower.includes('403 forbidden') ||
      lower.includes('you have been blocked') ||
      lower.includes('access is temporarily restricted')) {
    return { blocked: true, reason: 'access-denied' };
  }

  // CAPTCHA / reCAPTCHA
  if (lower.includes('captcha') || lower.includes('recaptcha') ||
      lower.includes('verify you are human') ||
      lower.includes('prove you are not a robot') ||
      lower.includes('hcaptcha')) {
    return { blocked: true, reason: 'captcha' };
  }

  // Rate limiting
  if (lower.includes('rate limit') || lower.includes('too many requests') ||
      lower.includes('unusual traffic') || lower.includes('unusual activity')) {
    return { blocked: true, reason: 'rate-limited' };
  }

  // Google-specific "sorry" page
  if (lower.includes('<title>sorry') || lower.includes('form[action*="sorry"]') ||
      (lower.includes('sorry') && lower.includes('automated queries'))) {
    return { blocked: true, reason: 'google-sorry' };
  }

  return { blocked: false, reason: null };
}

/**
 * Detect block indicators in a Puppeteer page context (runs page.evaluate).
 * Returns { blocked: boolean, reason: string|null }.
 */
export async function detectBlockInPage(page) {
  try {
    const result = await page.evaluate(() => {
      const title = (document.title || '').toLowerCase();
      const bodyText = document.body ? document.body.textContent.substring(0, 5000).toLowerCase() : '';

      // Cloudflare
      if (title.includes('just a moment') || title.includes('checking your browser') ||
          document.querySelector('#challenge-form, .cf-challenge-running, .cf-error-code')) {
        return { blocked: true, reason: 'cloudflare-challenge' };
      }

      // Access denied
      if (title.includes('blocked') || title.includes('access denied') || title.includes('403') ||
          bodyText.includes('you have been blocked') || bodyText.includes('access denied') ||
          bodyText.includes('access is temporarily restricted')) {
        return { blocked: true, reason: 'access-denied' };
      }

      // CAPTCHA
      if (title.includes('captcha') || document.querySelector('#captcha-form') ||
          document.querySelector('iframe[src*="recaptcha"]') ||
          document.querySelector('iframe[src*="hcaptcha"]') ||
          document.querySelector('[id*="captcha-container"]') ||
          bodyText.includes('verify you are human') || bodyText.includes('captcha')) {
        return { blocked: true, reason: 'captcha' };
      }

      // Rate limiting
      if (bodyText.includes('rate limit') || bodyText.includes('too many requests') ||
          bodyText.includes('unusual traffic') || bodyText.includes('unusual activity')) {
        return { blocked: true, reason: 'rate-limited' };
      }

      // Google sorry
      if (title.includes('sorry') && (document.querySelector('form[action*="sorry"]') ||
          bodyText.includes('automated queries'))) {
        return { blocked: true, reason: 'google-sorry' };
      }

      return { blocked: false, reason: null };
    });
    return result;
  } catch (err) {
    return { blocked: false, reason: null };
  }
}

/**
 * Block tracking helper. Create one per source scan to count consecutive blocks.
 * When threshold is hit, returns true indicating the source should stop.
 *
 * @param {string} sourceTag - Source name for log messages
 * @param {number} [threshold=3] - Consecutive block count before stopping
 * @returns {{ recordBlock: (reason: string) => boolean, recordSuccess: () => void, stats: { blocked: number, rateLimitWarnings: number } }}
 */
export function createBlockTracker(sourceTag, threshold = 3) {
  let consecutiveBlocks = 0;
  const stats = { blocked: 0, rateLimitWarnings: 0 };
  let totalSuccessful = 0;

  return {
    /**
     * Record a block event. Returns true if threshold reached (caller should stop).
     */
    recordBlock(reason = 'unknown') {
      consecutiveBlocks++;
      stats.blocked++;
      if (reason === 'rate-limited') stats.rateLimitWarnings++;
      if (consecutiveBlocks >= threshold) {
        log(`[${sourceTag}] WARNING: blocked/rate-limited after ${totalSuccessful} requests. Returning partial results.`);
        return true; // signal: stop
      }
      log(`[${sourceTag}] block detected (${reason}), ${consecutiveBlocks}/${threshold} consecutive`);
      return false;
    },
    recordSuccess() {
      consecutiveBlocks = 0;
      totalSuccessful++;
    },
    get stats() {
      return { ...stats };
    },
    get shouldStop() {
      return consecutiveBlocks >= threshold;
    },
  };
}
