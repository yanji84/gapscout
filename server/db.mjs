import Database from 'better-sqlite3';
import path from 'node:path';
import crypto from 'node:crypto';

export function initDb(dataDir) {
  const dbPath = path.join(dataDir, 'gapscout.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'quick',
      sources TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      progress_pct INTEGER DEFAULT 0,
      progress_detail TEXT,
      config TEXT,
      pid INTEGER,
      scan_dir TEXT,
      error TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
    CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      scan_id TEXT UNIQUE NOT NULL REFERENCES scans(id),
      claude_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      user_id TEXT REFERENCES users(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

export function createUser(db, { id, username, passwordHash }) {
  const stmt = db.prepare(
    'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
  );
  stmt.run(id, username, passwordHash);
}

export function getUserByUsername(db, username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  return stmt.get(username);
}

export function createSession(db, { id, userId, expiresAt }) {
  const stmt = db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  );
  stmt.run(id, userId, expiresAt);
}

export function getSession(db, id) {
  const stmt = db.prepare(`
    SELECT
      s.id AS session_id,
      s.user_id,
      s.expires_at,
      s.created_at AS session_created_at,
      u.id AS user_id,
      u.username,
      u.password_hash,
      u.created_at AS user_created_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `);
  const row = stmt.get(id);
  if (!row) return null;
  return {
    session: {
      id: row.session_id,
      user_id: row.user_id,
      expires_at: row.expires_at,
      created_at: row.session_created_at,
    },
    user: {
      id: row.user_id,
      username: row.username,
      password_hash: row.password_hash,
      created_at: row.user_created_at,
    },
  };
}

export function deleteSession(db, id) {
  const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  stmt.run(id);
}

export function cleanExpiredSessions(db) {
  const stmt = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')");
  stmt.run();
}

export function createScan(db, { id, name, domain, mode, sources, config, scanDir, createdBy }) {
  const stmt = db.prepare(`
    INSERT INTO scans (id, name, domain, mode, sources, config, scan_dir, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, name, domain, mode || 'quick', sources || null, config || null, scanDir || null, createdBy || null);
}

export function getScan(db, id) {
  const stmt = db.prepare('SELECT * FROM scans WHERE id = ?');
  return stmt.get(id);
}

export function listScans(db, { status, limit = 50, offset = 0 } = {}) {
  let whereClause = '';
  const params = [];

  if (status) {
    whereClause = 'WHERE status = ?';
    params.push(status);
  }

  const countStmt = db.prepare(`SELECT COUNT(*) AS total FROM scans ${whereClause}`);
  const { total } = countStmt.get(...params);

  const dataStmt = db.prepare(
    `SELECT * FROM scans ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  );
  const scans = dataStmt.all(...params, limit, offset);

  return { scans, total };
}

export function updateScan(db, id, fields) {
  const allowed = ['status', 'progress_pct', 'progress_detail', 'pid', 'error', 'started_at', 'completed_at'];
  const columnMap = {
    status: 'status',
    progress_pct: 'progress_pct',
    progress_detail: 'progress_detail',
    pid: 'pid',
    error: 'error',
    started_at: 'started_at',
    completed_at: 'completed_at',
  };

  const setClauses = [];
  const values = [];

  for (const key of allowed) {
    if (key in fields) {
      setClauses.push(`${columnMap[key]} = ?`);
      values.push(fields[key]);
    }
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const stmt = db.prepare(`UPDATE scans SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

export function getRunningScans(db) {
  const stmt = db.prepare("SELECT * FROM scans WHERE status = 'running'");
  return stmt.all();
}

export function getOrCreateChatSession(db, scanId) {
  let session = db.prepare('SELECT * FROM chat_sessions WHERE scan_id = ?').get(scanId);
  if (!session) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO chat_sessions (id, scan_id) VALUES (?, ?)').run(id, scanId);
    session = { id, scan_id: scanId, claude_session_id: null, created_at: new Date().toISOString() };
  }
  return session;
}

export function updateChatSessionClaudeId(db, sessionId, claudeSessionId) {
  db.prepare('UPDATE chat_sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, sessionId);
}

export function addChatMessage(db, { sessionId, userId, role, content }) {
  db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, ?, ?)').run(sessionId, userId, role, content);
}

export function getChatMessages(db, sessionId, limit = 100) {
  return db.prepare(`
    SELECT cm.*, u.username
    FROM chat_messages cm
    LEFT JOIN users u ON cm.user_id = u.id
    WHERE cm.session_id = ?
    ORDER BY cm.created_at ASC
    LIMIT ?
  `).all(sessionId, limit);
}
