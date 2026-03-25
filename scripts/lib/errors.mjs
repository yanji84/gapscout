/**
 * errors.mjs — Structured error handling for gapscout
 */

// ─── error codes ─────────────────────────────────────────────────────────────

export const ERROR_CODES = {
  ERR_MISSING_ARG:      'ERR_MISSING_ARG',
  ERR_INVALID_ARG:      'ERR_INVALID_ARG',
  ERR_RATE_LIMITED:      'ERR_RATE_LIMITED',
  ERR_TIMEOUT:           'ERR_TIMEOUT',
  ERR_CONNECTION:        'ERR_CONNECTION',
  ERR_CHROME_NOT_FOUND:  'ERR_CHROME_NOT_FOUND',
  ERR_CHROME_TIMEOUT:    'ERR_CHROME_TIMEOUT',
  ERR_API_ERROR:         'ERR_API_ERROR',
  ERR_PARSING:           'ERR_PARSING',
  ERR_FILE_READ:         'ERR_FILE_READ',
  ERR_FILE_WRITE:        'ERR_FILE_WRITE',
};

// ─── PainError ───────────────────────────────────────────────────────────────

export class PainError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} [opts.code]       - One of ERROR_CODES
   * @param {'fatal'|'error'|'warn'|'recoverable'} [opts.severity='error']
   * @param {object} [opts.context]    - Arbitrary context data
   */
  constructor(message, { code = 'ERR_API_ERROR', severity = 'error', context = {} } = {}) {
    super(message);
    this.name = 'PainError';
    this.code = code;
    this.severity = severity;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      ok: false,
      error: {
        message: this.message,
        code: this.code,
        severity: this.severity,
        context: this.context,
        timestamp: this.timestamp,
      },
    };
  }
}

// ─── RetryableError ──────────────────────────────────────────────────────────

export class RetryableError extends PainError {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {number} [opts.maxRetries=3]
   * @param {number} [opts.backoffMs=1000]
   */
  constructor(message, { code = 'ERR_API_ERROR', severity = 'recoverable', context = {}, maxRetries = 3, backoffMs = 1000 } = {}) {
    super(message, { code, severity, context });
    this.name = 'RetryableError';
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
  }
}

// ─── handleError ─────────────────────────────────────────────────────────────

/**
 * Handle an error: output structured JSON to stdout and optionally exit.
 * Only exits on 'fatal' severity.
 *
 * @param {Error} error
 * @param {'fatal'|'error'|'warn'|'recoverable'} [severityOverride]
 */
export function handleError(error, severityOverride) {
  let output;

  if (error instanceof PainError) {
    if (severityOverride) error.severity = severityOverride;
    output = error.toJSON();
  } else {
    const severity = severityOverride || 'error';
    output = {
      ok: false,
      error: {
        message: error.message || String(error),
        code: 'ERR_API_ERROR',
        severity,
        context: {},
        timestamp: new Date().toISOString(),
      },
    };
  }

  console.log(JSON.stringify(output, null, 2));

  if (output.error.severity === 'fatal') {
    process.exit(1);
  }
}
