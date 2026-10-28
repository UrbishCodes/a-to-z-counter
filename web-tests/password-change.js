// Change-password, driven through the page like a person would.
// LOCAL ONLY: it really changes the password on the backend it points at, then
// puts it back. Never run it against the live deployment.
// Run: API_BASE=http://127.0.0.1:8832 SHOP_PASSWORD=... node password-change.js
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fs = require('fs');
const assert = require('assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '..', 'web');
const API = process.env.API_BASE || 'http://127.0.0.1:8832';
const PASSWORD = process.env.SHOP_PASSWORD || '';
const TEMP = `${PASSWORD}-temp-1`;

if (!PASSWORD) {
  console.error('SHOP_PASSWORD is required');
  process.exit(1);
}
if (/workers\.dev|vercel\.app/.test(API)) {
  console.error('Refusing to change the password on a deployed backend.');
  process.exit(1);
}

const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return; } catch (e) { /* keep waiting */ }
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the page');
    await new Promise((r) => setTimeout(r, 40));
  }
};

async function login(password) {
  const res = await fetch(`${API}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (!/Not implemented: navigation/.test(e.message)) console.error(e.message);
});
const dom = new JSDOM(fs.readFileSync(`${dir}/index.html`, 'utf8'), {
  url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
});
const w = dom.window;
const d = w.document;
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
w.confirm = () => true;
w.localStorage.setItem('cs.apiBase', API);
w.fetch = (url, opts = {}) => fetch(url, { ...opts, signal: undefined });

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 4).join('\n     ')}`);
  }
};

(async () => {
  const first = await login(PASSWORD);
  assert.equal(first.status, 200);
  w.localStorage.setItem('cs.session', first.data.token);
  for (const f of ['session.js', 'solver.js', 'calc.js', 'bill.js']) {
    w.eval(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  }
  await waitFor(() => /Connected/.test(d.getElementById('connState').textContent));

  const $ = (id) => d.getElementById(id);
  const change = async (current, next, expected) => {
    $('currentPassword').value = current;
    $('newPassword').value = next;
    $('changePassword').click();
    await waitFor(() => expected.test($('passwordMsg').textContent), 15000);
  };

  await check('the page changes the password', async () => {
    await change(PASSWORD, TEMP, /Password changed/);
  });

  await check('the old password stops working, the new one works', async () => {
    assert.equal((await login(PASSWORD)).status, 401);
    const fresh = await login(TEMP);
    assert.equal(fresh.status, 200);
    assert.ok(fresh.data.token);
  });

  await check('other sessions were signed out, this one still works', async () => {
    const res = await fetch(`${API}/api/session`, {
      headers: { authorization: `Bearer ${w.localStorage.getItem('cs.session')}` },
    });
    assert.equal(res.status, 200);
  });

  await check('a wrong current password is refused', async () => {
    await change('not the current one', 'whatever-123', /not right|wrong|not correct/i);
    assert.equal((await login(TEMP)).status, 200); // unchanged
  });

  await check('a short new password is refused', async () => {
    await change(TEMP, 'short', /at least 8 characters/);
  });

  await check('the password is put back', async () => {
    await change(TEMP, PASSWORD, /Password changed/);
    assert.equal((await login(PASSWORD)).status, 200);
  });

  await check('no uncaught errors', async () => assert.deepEqual(errors, []));

  console.log(`\n${failed ? `${failed} failed` : 'all checks passed'}`);
  process.exitCode = failed ? 1 : 0;
})();
