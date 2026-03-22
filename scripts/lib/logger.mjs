/**
 * logger.mjs — Structured logging for pain-point-finder
 */

// ─── log levels ──────────────────────────────────────────────────────────────

export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

// ─── Logger class ────────────────────────────────────────────────────────────

export class Logger {
  /**
   * @param {string} tag - Component tag (e.g. 'reddit-api', 'report')
   * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL'} [level='INFO'] - Minimum log level
   */
  constructor(tag, level = 'INFO') {
    this.tag = tag;
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
    this._startTime = Date.now();
    this._events = [];
  }

  _emit(levelNum, message, data = {}) {
    if (levelNum < this.level) return;
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed: Date.now() - this._startTime,
      level: LEVEL_NAMES[levelNum],
      tag: this.tag,
      message,
      ...data,
    };
    this._events.push(entry);
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  debug(message, data) { this._emit(LOG_LEVELS.DEBUG, message, data); }
  info(message, data)  { this._emit(LOG_LEVELS.INFO, message, data); }
  warn(message, data)  { this._emit(LOG_LEVELS.WARN, message, data); }
  error(message, data) { this._emit(LOG_LEVELS.ERROR, message, data); }
  fatal(message, data) { this._emit(LOG_LEVELS.FATAL, message, data); }

  /**
   * Emit a progress event for tracking multi-step operations.
   *
   * @param {string} step - Current step name
   * @param {number} current - Current progress count
   * @param {number} total - Total expected count
   * @param {object} [data] - Additional data
   */
  progress(step, current, total, data = {}) {
    this._emit(LOG_LEVELS.INFO, `${step} [${current}/${total}]`, {
      step,
      current,
      total,
      pct: total > 0 ? Math.round((current / total) * 100) : 0,
      ...data,
    });
  }

  /**
   * Export all logged events.
   * @returns {object[]}
   */
  export() {
    return [...this._events];
  }
}
