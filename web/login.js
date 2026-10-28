/*
 * Sign-in page: trades the shop password for a session token and sends the
 * browser back to the page it came from.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  const st = {
    apiBase: read('cs.apiBase', Session.defaultBase),
  };

  function setConn(text, cls) {
    const el = $('connState');
    el.textContent = text;
    el.className = 'conn' + (cls ? ' ' + cls : '');
  }

  function setMsg(text, cls) {
    const el = $('loginMsg');
    el.textContent = text;
    el.className = 'msg' + (cls ? ' ' + cls : '');
  }

  /** Only ever navigate inside this app: no scheme, no host, no "..". */
  function nextPage() {
    const raw = new URLSearchParams(location.search).get('next') || '';
    if (!raw || /[:/\\]/.test(raw) || raw.startsWith('.')) return 'index.html';
    return raw;
  }

  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    const token = Session.token();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(st.apiBase.replace(/\/+$/, '') + path, {
      method: opts.method || 'GET',
      body: opts.body,
      headers,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const d = data && data.detail;
      const message = typeof d === 'string' ? d : (d ? JSON.stringify(d) : `HTTP ${res.status}`);
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  async function signIn(event) {
    event.preventDefault();
    const button = $('signInBtn');
    const password = $('password').value.trim();
    if (!password) {
      setMsg('Type the shop password.', 'bad');
      return;
    }
    button.disabled = true;
    button.textContent = 'Signing in…';
    setMsg('');
    try {
      const result = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      Session.save(result.token);
      setMsg('Signed in. Opening the counter…', 'ok');
      location.replace(nextPage());
    } catch (e) {
      if (e.status === 429) {
        setMsg('Too many attempts. Wait 15 minutes, then try again.', 'bad');
      } else if (e.status === 401) {
        setMsg('That password is not right.', 'bad');
        $('password').select();
      } else if (e.status === 409) {
        setMsg('No shop password is set up on this backend yet.', 'bad');
      } else if (e.status === 404) {
        setMsg('This backend has no sign-in. Check the address in Backend settings.', 'bad');
      } else {
        setMsg('Could not reach the backend. Check the address in Backend settings.', 'bad');
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  }

  // A token from an earlier visit is enough to skip this page.
  async function skipIfSignedIn() {
    if (!Session.token()) return;
    try {
      await api('/api/session');
      location.replace(nextPage());
    } catch (e) {
      if (e.status === 401) Session.clear();
      setConn('Sign in to continue');
    }
  }

  $('loginForm').addEventListener('submit', signIn);
  $('apiBase').value = st.apiBase;
  $('saveSettings').addEventListener('click', () => {
    st.apiBase = $('apiBase').value.trim();
    try {
      localStorage.setItem('cs.apiBase', st.apiBase);
    } catch (e) {
      // private mode
    }
    setMsg('Address saved.', 'ok');
  });

  skipIfSignedIn();
})();
