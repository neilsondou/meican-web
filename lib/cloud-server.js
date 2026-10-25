'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const SESSION_DAYS = 90;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 10;
const MAX_SNAPSHOT_BYTES = 3_800_000;

let pool;
let schemaPromise;

function getConnectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  ).trim();
}

function getPool() {
  if (pool) return pool;
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new HttpError(503, '云同步尚未配置数据库，请在 Vercel 中添加 DATABASE_URL。');
  }
  const needsSsl = !/localhost|127\.0\.0\.1/.test(connectionString);
  pool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (error) => {
    console.error('postgres pool error:', error.message);
  });
  return pool;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const defaults = [
    'https://meican.dou.asia',
    'https://www.dou.asia',
    'http://localhost:8899',
    'http://127.0.0.1:8899',
  ];
  const configured = (process.env.MEICAN_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = new Set([...defaults, ...configured]);
  const permitted =
    allowed.has(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
  if (!permitted) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  return true;
}

function readJsonBody(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (body.length > MAX_SNAPSHOT_BYTES) {
      throw new HttpError(413, '请求内容过大。');
    }
    try {
      body = JSON.parse(body || '{}');
    } catch (_) {
      throw new HttpError(400, '请求内容不是有效的 JSON。');
    }
  }
  if (body == null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求内容格式不正确。');
  }
  return body;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return (forwarded || String(req.headers['x-real-ip'] || '')).slice(0, 120);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().slice(0, 40);
}

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptHash(password, salt)}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = Buffer.from(scryptHash(password, parts[1]), 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const db = getPool();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGSERIAL PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(
        'CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)',
      );
      await client.query(
        'CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at)',
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS snapshots (
          user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 0,
          data JSONB,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS auth_attempts (
          id BIGSERIAL PRIMARY KEY,
          ip TEXT NOT NULL,
          username TEXT NOT NULL,
          attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        'CREATE INDEX IF NOT EXISTS auth_attempts_ip_idx ON auth_attempts(ip, attempted_at)',
      );
      await client.query(
        "DELETE FROM auth_attempts WHERE attempted_at < now() - interval '1 day'",
      );
      await seedUsers(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      schemaPromise = null;
      throw error;
    } finally {
      client.release();
    }
  })();
  return schemaPromise;
}

async function seedUsers(client) {
  const raw = (process.env.MEICAN_USERS || '').trim();
  if (!raw) return;
  let users;
  try {
    users = JSON.parse(raw);
  } catch (_) {
    console.error('MEICAN_USERS 不是有效的 JSON，已跳过账号初始化。');
    return;
  }
  if (!users || typeof users !== 'object' || Array.isArray(users)) return;
  const force = process.env.MEICAN_USERS_RESET === '1';
  for (const [rawName, rawPassword] of Object.entries(users)) {
    const username = normalizeUsername(rawName);
    const password = String(rawPassword || '');
    if (!username || password.length < 6) continue;
    const passwordHash = hashPassword(password);
    if (force) {
      await client.query(
        `INSERT INTO users (username, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (username)
         DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [username, passwordHash],
      );
    } else {
      await client.query(
        `INSERT INTO users (username, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (username) DO NOTHING`,
        [username, passwordHash],
      );
    }
  }
}

async function authenticate(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (token.length < 32 || token.length > 200) return null;
  const db = getPool();
  const { rows } = await db.query(
    `SELECT u.id, u.username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] || null;
}

async function tooManyFailures(db, ip) {
  if (!ip) return false;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS failures
       FROM auth_attempts
      WHERE ip = $1 AND attempted_at > now() - ($2 || ' minutes')::interval`,
    [ip, String(LOGIN_WINDOW_MINUTES)],
  );
  return (rows[0]?.failures || 0) >= LOGIN_MAX_FAILURES;
}

async function recordFailure(db, ip, username) {
  await db.query(
    'INSERT INTO auth_attempts (ip, username) VALUES ($1, $2)',
    [ip, username],
  );
}

async function handleLogin(req, res) {
  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: '此来源未被允许。' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '只支持 POST 请求。' });
    return;
  }

  try {
    await ensureSchema();
    const body = readJsonBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    if (!username || !password) {
      throw new HttpError(400, '请输入账号和密码。');
    }
    if (password.length > 200) {
      throw new HttpError(400, '账号或密码不正确。');
    }

    const db = getPool();
    const ip = clientIp(req);
    if (await tooManyFailures(db, ip)) {
      throw new HttpError(429, '尝试次数过多，请稍后再试。');
    }

    const { rows } = await db.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username],
    );
    const user = rows[0];
    const valid = user
      ? verifyPassword(password, user.password_hash)
      : verifyPassword(password, hashPassword('dummy-password'));
    if (!user || !valid) {
      await recordFailure(db, ip, username);
      throw new HttpError(401, '账号或密码不正确。');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
    await db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [sha256(token), user.id, expiresAt],
    );
    await db.query(
      'DELETE FROM auth_attempts WHERE ip = $1 AND username = $2',
      [ip, username],
    );
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    sendJson(res, 200, { token, username: user.username });
  } catch (error) {
    sendError(res, error, '登录失败，请稍后重试。');
  }
}

async function handleLogout(req, res) {
  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: '此来源未被允许。' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '只支持 POST 请求。' });
    return;
  }
  try {
    await ensureSchema();
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
      const db = getPool();
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [
        sha256(token),
      ]);
    }
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendError(res, error, '退出登录失败，请稍后重试。');
  }
}

async function handleSync(req, res) {
  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: '此来源未被允许。' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'PUT') {
    sendJson(res, 405, { error: '只支持 GET 或 PUT 请求。' });
    return;
  }

  try {
    await ensureSchema();
    const user = await authenticate(req);
    if (!user) {
      throw new HttpError(401, '登录已过期，请重新登录。');
    }
    const db = getPool();

    if (req.method === 'GET') {
      const { rows } = await db.query(
        'SELECT revision, data FROM snapshots WHERE user_id = $1',
        [user.id],
      );
      const snapshot = rows[0];
      sendJson(res, 200, {
        revision: snapshot ? snapshot.revision : 0,
        data: snapshot ? snapshot.data : null,
      });
      return;
    }

    const body = readJsonBody(req);
    const baseRevision = Number(body.baseRevision);
    const data = body.data;
    if (
      !Number.isInteger(baseRevision) ||
      baseRevision < 0 ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data)
    ) {
      throw new HttpError(400, '同步数据格式不正确。');
    }
    if (data.version !== 1 || !Array.isArray(data.meals) ||
        !Array.isArray(data.weights) || !data.profile ||
        typeof data.profile !== 'object') {
      throw new HttpError(400, '同步数据格式不正确。');
    }
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) {
      throw new HttpError(413, '本机数据体积过大，无法上传。');
    }

    const { rows } = await db.query(
      `INSERT INTO snapshots AS s (user_id, revision, data, updated_at)
       VALUES ($1, 1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
         SET revision = s.revision + 1,
             data = EXCLUDED.data,
             updated_at = now()
       WHERE s.revision = $3
       RETURNING revision`,
      [user.id, serialized, baseRevision],
    );
    if (!rows[0]) {
      sendJson(res, 409, { error: '云端数据已更新，请重新同步。' });
      return;
    }
    sendJson(res, 200, { revision: rows[0].revision });
  } catch (error) {
    sendError(res, error, '云端同步失败，请稍后重试。');
  }
}

function sendError(res, error, fallback) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  console.error('cloud api error:', error.message);
  sendJson(res, 500, { error: fallback });
}

module.exports = {
  ensureSchema,
  handleLogin,
  handleLogout,
  handleSync,
};
