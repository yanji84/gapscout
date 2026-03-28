#!/usr/bin/env node

/**
 * index.mjs — GapScout team web service entry point.
 *
 * Wires Express middleware, session auth, scan API, report serving,
 * and the web dashboard. Initializes SQLite + seeds admin user on first run.
 */

import express from 'express';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb, createUser, getUserByUsername, createSession, deleteSession, listScans as dbListScans, cleanExpiredSessions, createScan as dbCreateScan, getScan } from './db.mjs';
import { authMiddleware, hashPassword, verifyPassword, generateSessionId, SESSION_MAX_AGE_MS } from './auth.mjs';
import { cleanupStale, getActiveCount, getQueueLength, startScan, checkProgress } from './scanner.mjs';
import { createScansRouter } from './routes/scans.mjs';
import { createReportsRouter } from './routes/reports.mjs';
import { createChatRouter } from './routes/chat.mjs';
import { rateLimiter, securityHeaders, requestSizeLimiter, loginRateLimiter } from './middleware/security.mjs';
import {
  renderLogin, renderDashboard, renderNewScan, renderScanDetail,
  renderSettings,
} from './views.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT) || 3000;
const DATA_DIR = resolve(process.env.DATA_DIR || './data');
const BASE_PATH = process.env.BASE_PATH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ─── Ensure data directories ────────────────────────────────────────────────

mkdirSync(resolve(DATA_DIR, 'scans'), { recursive: true });

// ─── Initialize DB ──────────────────────────────────────────────────────────

const db = initDb(DATA_DIR);

// Cleanup expired sessions on startup
cleanExpiredSessions(db);

// Mark any stale "running" scans from a previous crash
cleanupStale(db);

// ─── Seed admin user on first run ───────────────────────────────────────────

const existingAdmin = getUserByUsername(db, 'admin');
if (!existingAdmin) {
  const tempPassword = crypto.randomBytes(8).toString('hex');
  const hash = await hashPassword(tempPassword);
  createUser(db, { id: crypto.randomUUID(), username: 'admin', passwordHash: hash });
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │  GapScout — First Run Setup              │');
  console.log('  │                                          │');
  console.log(`  │  Admin username: admin                   │`);
  console.log(`  │  Admin password: ${tempPassword}         │`);
  console.log('  │                                          │');
  console.log('  │  Change this in Settings after login.    │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
}

// ─── Express app ────────────────────────────────────────────────────────────

const app = express();

// Trust proxy (behind Caddy reverse proxy)
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Security middleware
app.use(securityHeaders());
app.use(requestSizeLimiter());
app.use(rateLimiter({ windowMs: 60000, max: 60 }));

// Simple cookie parser (no dependency needed)
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const pair of header.split(';')) {
      const [name, ...rest] = pair.trim().split('=');
      if (name) req.cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
    }
  }
  next();
});

// ─── Public routes (no auth) ────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.type('html').send(renderLogin(null, { basePath: BASE_PATH }));
});

app.post('/login', loginRateLimiter(), async (req, res) => {
  const { username, password } = req.body;
  const user = getUserByUsername(db, username);

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.type('html').send(renderLogin('Invalid username or password.', { basePath: BASE_PATH }));
  }

  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
  createSession(db, { id: sessionId, userId: user.id, expiresAt });

  res.setHeader('Set-Cookie', `gapscout_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}`);
  res.redirect(BASE_PATH + '/');
});

app.post('/logout', (req, res) => {
  const sid = req.cookies?.gapscout_sid;
  if (sid) deleteSession(db, sid);
  res.setHeader('Set-Cookie', 'gapscout_sid=; Path=/; HttpOnly; Max-Age=0');
  res.redirect(BASE_PATH + '/login');
});

// ─── Auth wall ──────────────────────────────────────────────────────────────

app.use(authMiddleware(db));

// ─── API routes ─────────────────────────────────────────────────────────────

app.use('/api', createChatRouter(db, DATA_DIR));  // Chat routes first (more specific: /scans/:id/chat)
app.use('/api/scans', rateLimiter({ windowMs: 60000, max: 10, keyFn: req => req.user?.id || req.ip }), createScansRouter(db, DATA_DIR));
app.use('/api/reports', createReportsRouter(db, DATA_DIR));

// ─── Page routes ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const scans = dbListScans(db, { limit: 50 });
  const activeCount = getActiveCount();
  const queueLength = getQueueLength();

  // Merge live progress into running scans
  for (const scan of scans.scans) {
    if (scan.status === 'running' && scan.scan_dir) {
      const progress = checkProgress(scan.scan_dir);
      scan.progress_pct = progress.pct;
      scan.progress_detail = progress.detail;
    }
  }

  res.type('html').send(renderDashboard(scans, activeCount, queueLength, { user: req.user, basePath: BASE_PATH }));
});

app.get('/scans/new', (req, res) => {
  res.type('html').send(renderNewScan({ user: req.user, basePath: BASE_PATH }));
});

app.post('/scans', (req, res) => {
  const { name, domain, sources, mode } = req.body;
  if (!domain) return res.redirect(BASE_PATH + '/scans/new');

  const id = crypto.randomUUID();
  const scanDir = resolve(DATA_DIR, 'scans', id);
  mkdirSync(scanDir, { recursive: true });

  dbCreateScan(db, {
    id,
    name: name || domain,
    domain,
    mode: mode || 'full',
    sources: sources || null,
    config: null,
    scanDir,
    createdBy: req.user.id,
  });

  startScan(db, { id, domain, sources: sources || undefined, scanDir, mode: mode || 'full' });

  res.redirect(`${BASE_PATH}/scans/${id}`);
});

app.get('/scans/:id', (req, res) => {
  const scan = getScan(db, req.params.id);
  if (!scan) return res.status(404).type('html').send('Not found');

  let progress = { pct: 0, detail: 'Waiting...' };
  if (scan.status === 'running' && scan.scan_dir) {
    progress = checkProgress(scan.scan_dir);
  } else if (scan.status === 'completed') {
    progress = { pct: 100, detail: 'Complete' };
  }

  res.type('html').send(renderScanDetail(scan, progress, { user: req.user, basePath: BASE_PATH }));
});

// ─── Settings routes ────────────────────────────────────────────────────────

app.get('/settings', (req, res) => {
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  res.type('html').send(renderSettings(users, req.user, { basePath: BASE_PATH }));
});

app.post('/settings/users', async (req, res) => {
  const { username, password } = req.body;
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();

  if (!username || !password) {
    return res.type('html').send(renderSettings(users, req.user, { error: 'Username and password required.', basePath: BASE_PATH }));
  }

  if (password.length < 6) {
    return res.type('html').send(renderSettings(users, req.user, { error: 'Password must be at least 6 characters.', basePath: BASE_PATH }));
  }

  const existing = getUserByUsername(db, username);
  if (existing) {
    return res.type('html').send(renderSettings(users, req.user, { error: `User "${username}" already exists.`, basePath: BASE_PATH }));
  }

  const hash = await hashPassword(password);
  createUser(db, { id: crypto.randomUUID(), username, passwordHash: hash });

  const updatedUsers = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();
  res.type('html').send(renderSettings(updatedUsers, req.user, { message: `User "${username}" created.`, basePath: BASE_PATH }));
});

app.post('/settings/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all();

  if (!current_password || !new_password) {
    return res.type('html').send(renderSettings(users, req.user, { error: 'Both fields required.', basePath: BASE_PATH }));
  }

  const user = getUserByUsername(db, req.user.username);
  if (!(await verifyPassword(current_password, user.password_hash))) {
    return res.type('html').send(renderSettings(users, req.user, { error: 'Current password is incorrect.', basePath: BASE_PATH }));
  }

  if (new_password.length < 6) {
    return res.type('html').send(renderSettings(users, req.user, { error: 'New password must be at least 6 characters.', basePath: BASE_PATH }));
  }

  const hash = await hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);

  res.type('html').send(renderSettings(users, req.user, { message: 'Password updated.', basePath: BASE_PATH }));
});

// ─── Start server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`GapScout server running at http://localhost:${PORT}`);
  if (BASE_PATH) console.log(`Base path: ${BASE_PATH}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Max concurrent scans: ${parseInt(process.env.MAX_CONCURRENT_SCANS) || 3}`);
});
