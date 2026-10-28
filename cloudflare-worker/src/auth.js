// Shop password: hashing, sessions and login throttling.
//
// The password itself is never stored. auth keeps a PBKDF2-SHA256 hash with a
// random salt; a login trades the password for a random session token that the
// device keeps, and only the SHA-256 of that token is stored, so neither a
// database copy nor a log is enough to sign in.

// Cloudflare rejects PBKDF2 above 100,000 iterations (NotSupportedError),
// so this is the strongest setting the runtime allows.
const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MINUTES = 15;

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken(bytes = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toBase64Url(new Uint8Array(bits));
}

function sameSecret(a, b) {
  const left = encoder.encode(String(a));
  const right = encoder.encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function iso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function prep(env, sql, ...values) {
  const stmt = env.DB.prepare(sql);
  return values.length ? stmt.bind(...values) : stmt;
}

async function first(env, sql, ...values) {
  return (await prep(env, sql, ...values).first()) ?? null;
}

async function run(env, sql, ...values) {
  return prep(env, sql, ...values).run();
}

// ---------------------------------------------------------------- password

export async function passwordIsSet(env) {
  return Boolean(await first(env, 'SELECT id FROM auth WHERE id=1'));
}

export async function setPassword(env, password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  await run(env,
    `INSERT INTO auth(id, password_hash, salt, iterations, updated_at) VALUES (1,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, salt=excluded.salt,
       iterations=excluded.iterations, updated_at=excluded.updated_at`,
    hash, toBase64Url(salt), iterations, iso(new Date()));
}

export async function checkPassword(env, password) {
  const row = await first(env, 'SELECT * FROM auth WHERE id=1');
  if (!row) return false;
  const candidate = await pbkdf2(String(password ?? ''), fromBase64Url(row.salt), row.iterations);
  return sameSecret(candidate, row.password_hash);
}

// ---------------------------------------------------------------- sessions

export async function createSession(env, label = '') {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await run(env,
    `INSERT INTO sessions(token_hash, label, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?)`,
    await sha256(token), String(label ?? '').slice(0, 80), iso(now), iso(now), iso(expires));
  return { token, expires_at: iso(expires) };
}

export async function sessionFromToken(env, token) {
  if (!token) return null;
  const hash = await sha256(token);
  const row = await first(env, 'SELECT * FROM sessions WHERE token_hash=?', hash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await run(env, 'DELETE FROM sessions WHERE id=?', row.id);
    return null;
  }
  await run(env, 'UPDATE sessions SET last_seen_at=? WHERE id=?', iso(new Date()), row.id);
  return row;
}

export async function deleteSession(env, token) {
  if (!token) return;
  await run(env, 'DELETE FROM sessions WHERE token_hash=?', await sha256(token));
}

export async function deleteOtherSessions(env, token) {
  await run(env, 'DELETE FROM sessions WHERE token_hash<>?', await sha256(token));
}

export async function sessionCount(env) {
  const row = await first(env, `SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?`, iso(new Date()));
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------- throttling

export async function tooManyFailures(env, ip) {
  const since = iso(new Date(Date.now() - FAILURE_WINDOW_MINUTES * 60 * 1000));
  const row = await first(env,
    'SELECT COUNT(*) AS n FROM login_attempts WHERE ip=? AND ok=0 AND at>?', String(ip ?? ''), since);
  return Number(row?.n ?? 0) >= MAX_FAILURES;
}

export async function recordAttempt(env, ip, ok) {
  const now = new Date();
  await run(env, 'INSERT INTO login_attempts(ip, at, ok) VALUES (?,?,?)',
    String(ip ?? ''), iso(now), ok ? 1 : 0);
  // Keep the table small: anything past the window is no longer consulted.
  await run(env, 'DELETE FROM login_attempts WHERE at < ?',
    iso(new Date(now.getTime() - 24 * 60 * 60 * 1000)));
}
