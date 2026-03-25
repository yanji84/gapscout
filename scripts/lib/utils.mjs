/**
 * utils.mjs — Shared utilities for gapscout
 */

import { PainError, handleError } from './errors.mjs';
import { outputSuccess, outputError } from './output-envelope.mjs';

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Log to stderr. When called with a Logger instance as the first argument,
 * delegates to logger.info(). Otherwise writes plain text to stderr (backwards compat).
 */
export function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

/**
 * Output success JSON. Optionally uses the standardized envelope when
 * `useEnvelope` is true (for source modules that opt in).
 */
export function ok(data, { useEnvelope = false, meta = {} } = {}) {
  if (useEnvelope) {
    console.log(JSON.stringify(outputSuccess(data, meta), null, 2));
  } else {
    console.log(JSON.stringify({ ok: true, data }, null, 2));
  }
}

/**
 * Output failure JSON and exit.
 * Internally uses PainError for structured error data, but maintains
 * the original { ok: false, error: { message, details } } shape for
 * backwards compatibility.
 */
export function fail(message, details) {
  // Maintain exact backwards-compatible output shape
  console.log(JSON.stringify({ ok: false, error: { message, details } }, null, 2));
  process.exit(1);
}

export function excerpt(text, maxLen = 200) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).trim() + '...';
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

export function daysAgoUnix(days) {
  return unixNow() - days * 86400;
}

export function utcToDate(utc) {
  return new Date(utc * 1000).toISOString().split('T')[0];
}

export function parseArgs(argv) {
  const result = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i++;
      }
    } else {
      result._.push(arg);
      i++;
    }
  }
  return result;
}

export function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function normalizeArgs(argv) {
  const raw = parseArgs(argv);
  const args = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_') args._ = v;
    else args[toCamelCase(k)] = v;
  }
  if (args.limit) args.limit = parseInt(args.limit, 10);
  if (args.days) args.days = parseInt(args.days, 10);
  if (args.minScore) args.minScore = parseInt(args.minScore, 10);
  if (args.minComments) args.minComments = parseInt(args.minComments, 10);
  if (args.pages) args.pages = parseInt(args.pages, 10);
  if (args.top) args.top = parseInt(args.top, 10);
  if (args.maxComments) args.maxComments = parseInt(args.maxComments, 10);
  if (args.maxPages) args.maxPages = parseInt(args.maxPages, 10);
  if (args.maxApps) args.maxApps = parseInt(args.maxApps, 10);
  if (args.maxReviewsPerApp) args.maxReviewsPerApp = parseInt(args.maxReviewsPerApp, 10);
  if (args.maxAge) args.maxAge = parseInt(args.maxAge, 10);
  if (args.batchSize) args.batchSize = parseInt(args.batchSize, 10);
  if (args.port) args.port = parseInt(args.port, 10);
  if (args.serve) args.serve = parseInt(args.serve, 10);
  if (args.timeout) args.timeout = parseInt(args.timeout, 10);
  if (typeof args.subreddits === 'string') {
    args.subreddits = args.subreddits.split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}
