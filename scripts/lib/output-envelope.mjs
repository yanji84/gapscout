/**
 * output-envelope.mjs — Standardized output envelope for pain-point-finder
 *
 * Every source module should use these functions for consistent output shape.
 */

/**
 * Emit a successful scan result.
 *
 * @param {object} data - The data payload. Should contain at least { source, posts }
 * @param {object} [meta={}] - Additional metadata (fetched_at, api_calls, etc.)
 * @returns {object} The envelope object
 */
export function outputSuccess(data, meta = {}) {
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
  return envelope;
}

/**
 * Emit an error result.
 *
 * @param {string} message - Error description
 * @param {string} [code='ERR_API_ERROR'] - Error code
 * @param {object} [context={}] - Additional context
 * @returns {object} The envelope object
 */
export function outputError(message, code = 'ERR_API_ERROR', context = {}) {
  return {
    ok: false,
    error: {
      message,
      code,
      context,
    },
  };
}
