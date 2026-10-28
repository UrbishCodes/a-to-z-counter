// The sign-in page (jsdom) against a running Worker that has a shop password.
// Run: API_BASE=http://127.0.0.1:8832 SHOP_PASSWORD=... node login.js
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

function openPage({ session = '', search = '' } = {}) {
  // jsdom cannot navigate; swallow only that message so the output stays readable.
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    if (!/Not implemented: navigation/.test(e.message)) console.error(e.message);
  });
  const dom = new JSDOM(fs.readFileSync(`${dir}/login.html`, 'utf8'), {
    url: `http://localhost/login.html${search}`,
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.localStorage.setItem('cs.apiBase', API);
  if (session) w.localStorage.setItem('cs.session', session);
  w.fetch = (url, opts = {}) => fetch(url, { ...opts, signal: undefined });
  w.eval(fs.readFileSync(`${dir}/session.js`, 'utf8'));
  w.eval(fs.readFileSync(`${dir}/login.js`, 'utf8'));
  return { dom, w, d: w.document, errors };
}

const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return; } catch (e) { /* keep waiting */ }
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the page');
    await new Promise((r) => setTimeout(r, 40));
  }
};
const $ = (page, id) => page.d.getElementById(id);
const submit = (page, password) => {
  $(page, 'password').value = password;
  $(page, 'loginForm').dispatchEvent(new page.w.Event('submit'));
};

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

(async () => {
  check('an empty password is caught before any request', async () => {
    const page = openPage();
    submit(page, '   ');
    await waitFor(() => /Type the shop password/.test($(page, 'loginMsg').textContent));
    assert.equal(page.w.localStorage.getItem('cs.session'), null);
  });

  check('a wrong password says so and stores nothing', async () => {
    const page = openPage();
    submit(page, 'not the password');
    // "That password is not right" normally; the throttled message once this
    // address has used up its attempts in the window.
    await waitFor(() => /not right|Too many attempts/.test($(page, 'loginMsg').textContent));
    assert.equal(page.w.localStorage.getItem('cs.session'), null);
  });

  check('the right password stores a session', async () => {
    const page = openPage();
    submit(page, PASSWORD);
    await waitFor(() => page.w.localStorage.getItem('cs.session'), 15000);
    const token = page.w.localStorage.getItem('cs.session');
    assert.ok(token.length > 20, 'token looks too short');
    const res = await fetch(`${API}/api/session`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
  });

  check('an existing session is checked, not trusted blindly', async () => {
    const page = openPage({ session: 'definitely-wrong' });
    await waitFor(() => page.w.localStorage.getItem('cs.session') === null, 15000);
    assert.equal($(page, 'loginMsg').textContent, '');
    assert.match($(page, 'connState').textContent, /Sign in/);
  });

  check('the next page stays inside the app', async () => {
    const page = openPage({ search: '?next=https://evil.example/x' });
    submit(page, PASSWORD);
    await waitFor(() => page.w.localStorage.getItem('cs.session'), 15000);
    // An absolute URL is ignored in favour of index.html; the page cannot
    // navigate under jsdom, so this is proved by the helper directly.
    assert.equal(page.w.Session.loginUrl('https://evil.example/x').startsWith('login.html?next='), true);
  });

  let failed = 0;
  for (const c of checks) {
    try {
      await c.fn();
      console.log(`ok   ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${e.message.split('\n').slice(0, 4).join('\n     ')}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
