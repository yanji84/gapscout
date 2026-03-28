// Rate limiting and security middleware — Node built-ins only, no npm deps.

// ── rateLimiter ─────────────────────────────────────────────────────────────

/**
 * In-memory sliding-window rate limiter.
 *
 * @param {object}   opts
 * @param {number}   opts.windowMs  Window size in ms (default 60 000)
 * @param {number}   opts.max       Max requests per window (default 60)
 * @param {function} opts.keyFn     (req) => string  — key per client (default: req.ip)
 * @returns Express-style middleware
 */
export function rateLimiter({ windowMs = 60_000, max = 60, keyFn } = {}) {
  const hits = new Map(); // key → [timestamp, ...]

  // Prune entries that have gone completely stale every 5 minutes.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < now - windowMs) {
        hits.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  cleanup.unref();

  return (req, res, next) => {
    const key = typeof keyFn === 'function' ? keyFn(req) : (req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = hits.get(key);
    if (!timestamps) {
      timestamps = [];
      hits.set(key, timestamps);
    }

    // Prune expired entries for this key.
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      const retryAfter = Math.ceil((timestamps[0] - windowStart) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Try again later.' }));
      return;
    }

    timestamps.push(now);
    next();
  };
}

// ── securityHeaders ─────────────────────────────────────────────────────────

/**
 * Sets common security-related HTTP headers and removes X-Powered-By.
 */
export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    );
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.removeHeader('X-Powered-By');
    next();
  };
}

// ── requestSizeLimiter ──────────────────────────────────────────────────────

/**
 * Rejects requests whose Content-Length exceeds maxBytes (default 1 MB).
 * Returns 413 Payload Too Large.
 */
export function requestSizeLimiter(maxBytes = 1_048_576) {
  return (req, res, next) => {
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large.' }));
      return;
    }
    next();
  };
}

// ── loginRateLimiter ────────────────────────────────────────────────────────

/**
 * Stricter rate limiter for login routes: 5 requests / minute per IP.
 * On block, returns an HTML error page via renderLogin instead of JSON.
 */
export function loginRateLimiter() {
  const hits = new Map();

  const windowMs = 60_000;
  const max = 5;

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < now - windowMs) {
        hits.delete(key);
      }
    }
  }, 5 * 60 * 1000);
  cleanup.unref();

  return async (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = hits.get(key);
    if (!timestamps) {
      timestamps = [];
      hits.set(key, timestamps);
    }

    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      const retryAfter = Math.ceil((timestamps[0] - windowStart) / 1000);
      res.setHeader('Retry-After', String(retryAfter));

      try {
        const { renderLogin } = await import('../views.mjs');
        const html = renderLogin({ error: 'Too many login attempts. Try again later.' });
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        // Fallback if views.mjs is unavailable.
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>429 Too Many Requests</h1><p>Too many login attempts. Try again later.</p>');
      }
      return;
    }

    timestamps.push(now);
    next();
  };
}
