/**
 * output-envelope.mjs — Standardized output envelope for gapscout
 *
 * Every source module should use these functions for consistent output shape.
 */

import { getGlobalRateMonitor } from './rate-monitor.mjs';

// ─── severity constants ─────────────────────────────────────────────────────

export const SEVERITY = /** @type {const} */ ({
  OK:       'OK',
  WARNING:  'WARNING',
  DEGRADED: 'DEGRADED',
  CRITICAL: 'CRITICAL',
});

// ─── createObservability ────────────────────────────────────────────────────

/**
 * Create a default observability object. Sources can build one incrementally
 * by passing only the fields they want to override.
 *
 * @param {object} [overrides={}]
 * @returns {object} A fully-populated observability object
 */
export function createObservability(overrides = {}) {
  const defaults = {
    scanId: null,
    severity: SEVERITY.OK,
    completeness: {
      terminated_early: false,
      pages_completed: 0,
      pages_attempted: 0,
    },
    coverage: {
      posts_fetched: 0,
      posts_scored: 0,
      posts_included: 0,
    },
    warnings: [],
    metrics: {
      duration_ms: 0,
      api_calls: 0,
      rate_limit_events: 0,
    },
  };

  return {
    ...defaults,
    ...overrides,
    completeness: { ...defaults.completeness, ...(overrides.completeness || {}) },
    coverage:     { ...defaults.coverage,     ...(overrides.coverage || {}) },
    warnings:     [...(overrides.warnings || [])],
    metrics:      { ...defaults.metrics,      ...(overrides.metrics || {}) },
  };
}

// ─── internal helpers ───────────────────────────────────────────────────────

/**
 * Merge RateMonitor summary entries into the warnings array.
 * Each warning/block/error from the monitor becomes a structured warning entry.
 *
 * @param {Array} warnings - Existing warnings array (mutated in place)
 * @returns {Array} The same array, with monitor entries appended
 */
function mergeRateMonitorWarnings(warnings) {
  let monitor;
  try {
    monitor = getGlobalRateMonitor();
  } catch {
    return warnings;
  }

  if (!monitor || !monitor.hasIssues()) return warnings;

  const summary = monitor.getSummary();

  for (const w of summary.warnings) {
    warnings.push({
      severity: 'WARNING',
      source: w.source,
      message: w.message,
    });
  }
  for (const b of summary.blocks) {
    warnings.push({
      severity: 'CRITICAL',
      source: b.source,
      message: b.message,
    });
  }
  for (const e of summary.errors) {
    warnings.push({
      severity: 'DEGRADED',
      source: e.source,
      message: e.message,
    });
  }

  return warnings;
}

// ─── outputSuccess ──────────────────────────────────────────────────────────

/**
 * Emit a successful scan result.
 *
 * @param {object} data - The data payload. Should contain at least { source, posts }
 * @param {object} [meta={}] - Additional metadata (fetched_at, api_calls, etc.)
 * @param {object} [observability] - Optional observability data (see createObservability)
 * @returns {object} The envelope object
 */
export function outputSuccess(data, meta = {}, observability) {
  const source = data.source || 'unknown';
  const posts = data.posts || [];
  const envelope = {
    ok: true,
    data: {
      ...data,
      source,
      posts,
      stats: {
        total_results: posts.length,
        fetched_at: new Date().toISOString(),
        ...meta,
      },
    },
  };

  // Only attach observability when caller opts in (or when RateMonitor has issues)
  if (observability) {
    const obs = createObservability(observability);
    mergeRateMonitorWarnings(obs.warnings);
    envelope.observability = obs;
  } else {
    // Even without explicit observability, surface RateMonitor issues if present
    let monitor;
    try {
      monitor = getGlobalRateMonitor();
    } catch {
      // rate-monitor not available — nothing to surface
    }
    if (monitor && monitor.hasIssues()) {
      const obs = createObservability();
      mergeRateMonitorWarnings(obs.warnings);
      if (obs.warnings.length > 0) {
        // Escalate severity based on what the monitor captured
        const summary = monitor.getSummary();
        if (summary.blocks.length > 0) {
          obs.severity = SEVERITY.CRITICAL;
        } else if (summary.errors.length > 0) {
          obs.severity = SEVERITY.DEGRADED;
        } else {
          obs.severity = SEVERITY.WARNING;
        }
        envelope.observability = obs;
      }
    }
  }

  return envelope;
}

// ─── outputError ────────────────────────────────────────────────────────────

/**
 * Emit an error result.
 *
 * @param {string} message - Error description
 * @param {string} [code='ERR_API_ERROR'] - Error code
 * @param {object} [context={}] - Additional context
 * @param {string} [severity='CRITICAL'] - Severity level
 * @returns {object} The envelope object
 */
export function outputError(message, code = 'ERR_API_ERROR', context = {}, severity = 'CRITICAL') {
  return {
    ok: false,
    error: {
      message,
      code,
      context,
      severity,
    },
  };
}
