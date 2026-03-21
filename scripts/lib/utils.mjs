/**
 * utils.mjs — Shared utilities for pain-point-finder
 */

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

export function ok(data) {
  console.log(JSON.stringify({ ok: true, data }, null, 2));
}

export function fail(message, details) {
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
  if (args.port) args.port = parseInt(args.port, 10);
  if (typeof args.subreddits === 'string') {
    args.subreddits = args.subreddits.split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}
