import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getSession } from './db.mjs';

export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function generateSessionId() {
  return crypto.randomUUID();
}

export function authMiddleware(db) {
  return (req, res, next) => {
    const sid = req.cookies?.gapscout_sid;

    if (!sid) {
      return deny(req, res);
    }

    const result = getSession(db, sid);

    if (!result) {
      return deny(req, res);
    }

    const { session, user } = result;

    if (new Date(session.expires_at) <= new Date()) {
      return deny(req, res);
    }

    req.user = user;
    next();
  };
}

function deny(req, res) {
  const acceptsHtml =
    req.headers.accept && req.headers.accept.includes('text/html');

  if (acceptsHtml) {
    const basePath = process.env.BASE_PATH || '';
    return res.redirect(basePath + '/login');
  }

  return res.status(401).json({ error: 'Unauthorized' });
}
