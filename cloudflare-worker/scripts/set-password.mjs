// Writes the SQL that sets the shop password, using the same PBKDF2 settings
// as src/auth.js. Run it, then apply the file it writes:
//
//   node scripts/set-password.mjs "the shop password"
//   npx wrangler d1 execute a-to-z-counter --remote --file .password.sql
//
// Use --local instead of --remote for the local dev database. Applying it also
// clears every session, so all devices are signed out and must use the new
// password. This is the recovery path if the password is ever lost.
// Pass the password as an argument, or as "-" to read it from stdin
// (keeps it out of the shell history and the process list):
//   printf '%s' "$PASSWORD" | node scripts/set-password.mjs -
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const ITERATIONS = 100000; // Workers caps PBKDF2 at 100,000
const OUT = '.password.sql';

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pbkdf2(password, salt, iterations) {
  const key = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return base64Url(new Uint8Array(bits));
}

const arg = (process.argv[2] ?? '').trim();
const password = (arg === '-' || arg === '' ? readFileSync(0, 'utf8') : arg).trim();
if (!password) {
  console.error('usage: node scripts/set-password.mjs "new shop password"');
  console.error('       printf \'%s\' "$PASSWORD" | node scripts/set-password.mjs -');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Use at least 8 characters.');
  process.exit(1);
}

const salt = webcrypto.getRandomValues(new Uint8Array(16));
const hash = await pbkdf2(password, salt, ITERATIONS);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const sql = `INSERT INTO auth(id, password_hash, salt, iterations, updated_at)
VALUES (1, '${hash}', '${base64Url(salt)}', ${ITERATIONS}, '${now}')
ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, salt=excluded.salt,
  iterations=excluded.iterations, updated_at=excluded.updated_at;
DELETE FROM sessions;
`;

writeFileSync(OUT, sql);
console.log(`Wrote ${OUT} for a ${password.length}-character password.`);
console.log('Apply it with:');
console.log('  npx wrangler d1 execute a-to-z-counter --remote --file .password.sql');
