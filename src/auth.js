import crypto from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 90;

export async function ensureUser(name) {
  let user = await db.get(`SELECT * FROM users WHERE name = ?`, [name]);
  if (!user) {
    await db.run(`INSERT INTO users (name) VALUES (?)`, [name]);
    user = await db.get(`SELECT * FROM users WHERE name = ?`, [name]);
  }
  return user;
}

export async function findUserByName(name) {
  return db.get(`SELECT * FROM users WHERE name = ?`, [name]);
}

export async function allUsers() {
  return db.all(`SELECT * FROM users ORDER BY id`);
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [token, userId, expires]);
  return { token, expires };
}

export async function getSessionUser(token) {
  if (!token) return null;
  const row = await db.get(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ? AND sessions.expires_at > datetime('now')`,
    [token]
  );
  return row || null;
}

export async function destroySession(token) {
  await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
