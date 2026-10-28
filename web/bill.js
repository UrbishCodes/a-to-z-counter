/*
 * Backend link: connection, item search, saving bills, matching review and alerts.
 * Loaded after calc.js, which provides window.Counter.
 */
(function () {
  'use strict';

  const C = window.Counter;
  const { st, els, S, toast, fmt2, fmtQty } = C;
  const $ = (id) => document.getElementById(id);

  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : v;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (e) {
        // private mode: settings simply will not persist
      }
    },
  };

  // The backend address and the session live in session.js, shared with the
  // data sheet and the sign-in page.
  st.apiBase = LS.get('cs.apiBase', Session.defaultBase);
  let lastBill = null;

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, Session.headers());
    if (opts.body) headers['Content-Type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
    let res;
    try {
      res = await fetch(st.apiBase.replace(/\/+$/, '') + path, {
        method: opts.method || 'GET',
        body: opts.body,
        headers,
        signal: ctrl.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const d = data && data.detail;
      const msg = typeof d === 'string' ? d : (d ? JSON.stringify(d) : `HTTP ${res.status}`);
      if (res.status === 401) {
        // The session ended (expired, or the password was changed elsewhere).
        Session.clear();
        Session.goToLogin();
        throw new ApiError(401, 'Your session ended. Signing you in again…');
      }
      throw new ApiError(res.status, msg);
    }
    return data;
  }

  function setConn(text, cls) {
    const el = $('connState');
    el.textContent = text;
    el.className = 'conn' + (cls ? ' ' + cls : '');
  }

  function setSaveMsg(text, cls) {
    const m = $('saveMsg');
    m.textContent = text;
    m.className = 'msg' + (cls ? ' ' + cls : '');
  }

  function updateSave() {
    const ok = st.online && !st.busy && C.baseNow() && C.billLines().length > 0;
    $('saveBtn').disabled = !ok;
  }

  // ---------- connection ----------

  let connectError = null;

  async function connect() {
    setConn('Connecting…', '');
    try {
      const h = await api('/api/health', { timeoutMs: 4000 });
      st.online = true;
      st.rules = await api('/api/settings', { timeoutMs: 4000 });
      if (!els.vat.dataset.touched) els.vat.value = String(st.rules.vat_pct);
      setConn(`Connected · ${h.items} items · bills are saved`, 'ok');
      els.itemBox.hidden = false;
      connectError = null;
      await loadAlerts();
    } catch (e) {
      st.online = false;
      connectError = e;
      els.itemBox.hidden = true;
      $('alertsCard').hidden = true;
      if (e instanceof ApiError && e.status === 401) {
        setConn('Signed out. Taking you to the sign-in page…', 'off');
      } else {
        setConn('Offline: calculator only. Bills are NOT saved. Write them in the book.', 'off');
      }
    }
    C.renderBandHint();
    C.recalc();
  }

  // ---------- item search (step 2) ----------

  function itemButton(name, sub, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cand';
    const strong = document.createElement('strong');
    strong.textContent = name;
    const sp = document.createElement('span');
    sp.textContent = sub;
    b.append(strong, sp);
    b.addEventListener('click', onClick);
    return b;
  }

  async function searchItems() {
    const q = els.itemSearch.value.trim();
    const box = els.itemResults;
    box.innerHTML = '';
    box.hidden = true;
    if (!st.online || q.length < 2) return;

    let rows;
    try {
      rows = await api(`/api/items?q=${encodeURIComponent(q)}&limit=40`, { timeoutMs: 6000 });
    } catch (e) {
      toast('Item search failed. Check the connection.');
      return;
    }
    if (els.itemSearch.value.trim() !== q) return; // a newer search has replaced this one

    const list = rows.filter((it) => it.active && S.compatible(st.unit, it.unit)).slice(0, 6);
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No item matches. On save, the typed text is matched by name and rate.';
      box.append(p);
      box.hidden = false;
      return;
    }
    list.forEach((it) => {
      const sell = S.r2(S.convertRate(it.sell_rate, it.unit, st.unit));
      box.append(itemButton(it.name, `max NPR ${fmt2(sell)} per ${st.unit} · stock ${it.stock} ${it.unit}`,
        () => C.chooseItem(it)));
    });
    box.hidden = false;
  }
  C.searchItems = searchItems;

  // ---------- saving (step 4) ----------

  async function saveBill() {
    if (!st.online || st.busy) return;
    const b = C.baseNow();
    const lines = C.billLines();
    if (!b || !lines.length) return;

    const flagged = lines.filter((l) => {
      const band = C.bandOf(l);
      return band && (band.status === 'LOSS' || band.status === 'OVER_TAX');
    }).length;
    if (flagged && !window.confirm(
      `${flagged} line(s) are outside the ${st.rules.band_low_pct}% to ${st.rules.band_high_pct}% band. Save anyway?`)) {
      return;
    }

    const body = {
      gross_total: b.gross,
      vat_pct: b.vatPct,
      note: '',
      created_by: $('staff').value.trim(),
      lines: lines.map((l) => ({
        description: l.description,
        item_id: l.item_id,
        sale_unit: l.sale_unit,
        qty: l.qty,
        unit_rate: l.unit_rate,
      })),
    };

    st.busy = true;
    updateSave();
    setSaveMsg('Saving…', '');
    try {
      const bill = await api('/api/bills', { method: 'POST', body: JSON.stringify(body) });
      lastBill = bill;
      showBill(bill);
      C.clearBill();
      await loadAlerts();
    } catch (e) {
      const network = e instanceof TypeError;
      setSaveMsg(network
        ? 'Not saved: the backend could not be reached. Check the bill list before saving again, so the bill is not recorded twice. Your entries are still on screen.'
        : `Not saved: ${e.message}. Your entries are still on screen.`, 'bad');
    } finally {
      st.busy = false;
      C.recalc();
    }
  }

  function showBill(bill) {
    const complete = bill.status === 'complete';
    const diff = bill.variance ? ` Lines differ from the base by NPR ${fmt2(Math.abs(bill.variance))}.` : '';
    setSaveMsg(
      `Saved ${bill.bill_no}. Base NPR ${fmt2(bill.taxable_base)}, VAT NPR ${fmt2(bill.vat_amount)}.${diff} ` +
      (complete ? 'All lines matched and stock deducted.' : 'Some lines are not matched yet: pick the item below.'),
      complete ? 'ok' : 'warn');
    renderReview(bill);
  }

  // ---------- matching review ----------

  function renderReview(bill) {
    const box = $('confirmBox');
    box.innerHTML = '';
    bill.lines.forEach((l) => {
      const card = document.createElement('div');
      card.className = l.confirmed ? 'review done' : 'review';
      const title = document.createElement('p');
      title.textContent = `Line ${l.line_no}: ${l.description || 'no name'} · ${fmtQty(l.qty, l.sale_unit)} × NPR ${fmt2(l.unit_rate)}`;
      card.append(title);

      if (l.confirmed) {
        const info = document.createElement('p');
        info.className = 'small';
        const margin = l.margin_status
          ? `${l.margin_status}${l.margin_pct != null ? ' ' + l.margin_pct + '%' : ''}`
          : 'no buy rate';
        info.textContent = `Matched (${l.match_method}). Margin ${margin}. Stock deducted.`;
        card.append(info);
      } else {
        const hint = document.createElement('p');
        hint.className = 'small';
        hint.textContent = l.suggestions.length
          ? 'Closest items by name and rate. Tap the right one:'
          : 'No close match. Search for the item:';
        card.append(hint);
        if (l.suggestions.length) {
          const pick = document.createElement('div');
          pick.className = 'cands-list';
          l.suggestions.forEach((s) => {
            const sell = S.r2(S.convertRate(s.sell_rate, s.unit, l.sale_unit));
            pick.append(itemButton(s.name,
              `max NPR ${fmt2(sell)} · gap ${s.rate_gap_pct}% · ${s.margin_status}`,
              () => confirmLine(bill.id, l.line_no, s.item_id)));
          });
          card.append(pick);
        }
        card.append(searchBox(bill, l));
      }
      box.append(card);
    });
  }

  function searchBox(bill, line) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search item for this line';
    input.setAttribute('aria-label', `Search item for line ${line.line_no}`);
    const results = document.createElement('div');
    results.className = 'cands-list';
    wrap.append(input, results);

    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        results.innerHTML = '';
        if (q.length < 2) return;
        try {
          const rows = await api(`/api/items?q=${encodeURIComponent(q)}&limit=20`, { timeoutMs: 6000 });
          rows.filter((it) => it.active && S.compatible(line.sale_unit, it.unit)).slice(0, 6).forEach((it) => {
            const sell = S.r2(S.convertRate(it.sell_rate, it.unit, line.sale_unit));
            results.append(itemButton(it.name, `max NPR ${fmt2(sell)} · stock ${it.stock} ${it.unit}`,
              () => confirmLine(bill.id, line.line_no, it.id)));
          });
        } catch (e) {
          setSaveMsg('Search failed. Check the connection.', 'bad');
        }
      }, 250);
    });
    return wrap;
  }

  async function confirmLine(billId, lineNo, itemId) {
    try {
      const bill = await api(`/api/bills/${billId}/lines/${lineNo}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ item_id: itemId }),
      });
      lastBill = bill;
      renderReview(bill);
      const done = bill.status === 'complete';
      setSaveMsg(done
        ? `${bill.bill_no} complete. Stock deducted.`
        : `${bill.bill_no}: line ${lineNo} matched. Other lines still need an item.`,
        done ? 'ok' : 'warn');
      await loadAlerts();
    } catch (e) {
      setSaveMsg(`Could not match the line: ${e.message}`, 'bad');
    }
  }

  // ---------- stock alerts ----------

  async function loadAlerts() {
    const card = $('alertsCard');
    const list = $('alertsList');
    if (!st.online) {
      card.hidden = true;
      return;
    }
    let rows;
    try {
      rows = await api('/api/alerts', { timeoutMs: 6000 });
    } catch (e) {
      return;
    }
    list.innerHTML = '';
    card.hidden = rows.length === 0;
    rows.forEach((a) => {
      const box = document.createElement('div');
      box.className = 'alert' + (a.severity === 'high' ? '' : ' medium');
      const p = document.createElement('p');
      p.textContent = a.message;
      const ack = document.createElement('button');
      ack.type = 'button';
      ack.className = 'ghost-dark';
      ack.textContent = a.acknowledged_at ? 'Seen' : 'Mark as seen';
      ack.disabled = Boolean(a.acknowledged_at);
      ack.addEventListener('click', async () => {
        try {
          await api(`/api/alerts/${a.id}/ack`, { method: 'POST' });
        } catch (e) {
          toast('Could not mark as seen');
        }
        loadAlerts();
      });
      box.append(p, ack);
      list.append(box);
    });
  }

  // ---------- wiring ----------

  $('apiBase').value = st.apiBase;
  $('saveSettings').addEventListener('click', async () => {
    st.apiBase = $('apiBase').value.trim();
    LS.set('cs.apiBase', st.apiBase);
    await connect();
    if (st.online) {
      toast('Connected');
    } else if (connectError instanceof ApiError && connectError.status === 401) {
      toast('Signed out. Open the sign-in page.');
    } else {
      toast('Could not connect. Check the address.');
    }
  });
  $('signOut').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (e) {
      // already signed out, or the network is down: clearing locally is enough
    }
    Session.clear();
    Session.goToLogin();
    setConn('Signed out.', 'off');
  });
  $('changePassword').addEventListener('click', async () => {
    const current = $('currentPassword').value;
    const next = $('newPassword').value;
    const msg = $('passwordMsg');
    msg.className = 'msg';
    msg.textContent = '';
    if (next.length < 8) {
      msg.className = 'msg bad';
      msg.textContent = 'The new password needs at least 8 characters.';
      return;
    }
    try {
      await api('/api/password', {
        method: 'POST',
        body: JSON.stringify({ current, next }),
      });
      $('currentPassword').value = '';
      $('newPassword').value = '';
      msg.className = 'msg ok';
      msg.textContent = 'Password changed. Other devices have been signed out.';
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = e.message;
    }
  });
  $('saveBtn').addEventListener('click', saveBill);
  document.addEventListener('counter:change', updateSave);
  document.addEventListener('counter:reset', () => {
    $('confirmBox').innerHTML = '';
    setSaveMsg('', '');
    lastBill = null;
  });

  connect();
  updateSave();
})();
