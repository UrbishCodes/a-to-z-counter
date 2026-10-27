/*
 * Data sheet: every item the app holds, in the order and with the figures the
 * stock PDF gave, side by side with what is stored now. Corrections are saved
 * to the backend one row at a time.
 *
 * Standalone (no calc.js): the counter's engine expects the counter's markup.
 */
(function () {
  'use strict';

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
        // private mode: the address simply will not stick
      }
    },
  };

  // Same discovery rules as bill.js, so both pages reach the same backend.
  const WORKER_BASE = 'https://a-to-z-counter.g-urbish11.workers.dev';
  const LOCAL_BASE = 'http://localhost:8000';
  const host = location.hostname;
  const isLocal = host === '' || host === 'localhost' || host === '127.0.0.1';
  const DEFAULT_BASE = isLocal
    ? (location.protocol.indexOf('http') === 0 ? '' : LOCAL_BASE)
    : WORKER_BASE;

  const st = {
    apiBase: LS.get('cs.apiBase', DEFAULT_BASE),
    apiKey: LS.get('cs.apiKey', ''),
    items: [],
    editing: null,
    saving: false,
    connected: false,
  };

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (st.apiKey) headers['X-API-Key'] = st.apiKey;
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
      const msg = typeof d === 'string' ? d : (d ? JSON.stringify(d) : `HTTP ${res.status}`);
      throw new ApiError(res.status, msg);
    }
    return data;
  }

  // ---------- small helpers ----------

  function fmt2(n) {
    const v = Number(n);
    return Number.isFinite(v)
      ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—';
  }

  function fmtQty(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function setConn(text, cls) {
    const el = $('connState');
    el.textContent = text;
    el.className = 'conn' + (cls ? ' ' + cls : '');
  }

  function setMsg(text, cls) {
    const el = $('sheetMsg');
    el.textContent = text;
    el.className = 'msg' + (cls ? ' ' + cls : '');
  }

  function cell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  // ---------- loading ----------

  async function load() {
    setConn('Loading…', '');
    setMsg('', '');
    try {
      const rows = await api('/api/items?limit=200&all=1');
      st.items = rows.slice().sort((a, b) => a.id - b.id);
      st.connected = true;
      st.editing = null;
      setConn(`Connected · ${rows.length} items`, 'ok');
      render();
    } catch (e) {
      st.connected = false;
      st.items = [];
      st.editing = null;
      if (e instanceof ApiError && e.status === 401) {
        setConn('Locked: this backend needs its API key. Enter it in Backend settings below.', 'off');
        setMsg('The key is asked for once per browser. Open Backend settings, paste it, then connect.', 'warn');
        $('settingsCard').open = true;
      } else {
        setConn('Offline: the backend could not be reached. Nothing can be saved.', 'off');
        setMsg('Check the backend address in Backend settings, then press Reload.', 'bad');
      }
      render();
    }
  }

  // ---------- table ----------

  function visibleItems() {
    const q = $('sheetSearch').value.trim().toLowerCase();
    if (!q) return st.items;
    return st.items.filter((it) =>
      String(it.name || '').toLowerCase().includes(q) ||
      String(it.source_particulars || '').toLowerCase().includes(q) ||
      String(it.hs_code || '').toLowerCase().includes(q));
  }

  function render() {
    const body = $('sheetBody');
    body.innerHTML = '';

    if (!st.items.length) {
      const tr = document.createElement('tr');
      const td = cell(st.connected ? 'This backend has no items yet.' : 'No rows to show until the backend connects.', 'empty');
      td.colSpan = 11;
      tr.append(td);
      body.append(tr);
      updateCount(0);
      return;
    }

    st.items.forEach((item) => {
      body.append(rowFor(item));
      if (st.editing === item.id) body.append(editorFor(item));
    });
    applyFilter();
  }

  function rowFor(item) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(item.id);
    if (st.editing === item.id) tr.classList.add('editing');
    if (!item.active) tr.classList.add('inactive');

    tr.append(cell(String(item.id), 'num-col sn'));
    tr.append(cell(item.source_particulars || '—', 'pdf-col particulars'));

    const pdfQty = item.source_qty === null || item.source_qty === undefined ? '—' : fmtQty(item.source_qty);
    tr.append(cell(pdfQty, 'num-col qty-pdf'));

    const qty = document.createElement('td');
    qty.className = 'num-col';
    qty.textContent = `${fmtQty(item.stock)} ${item.unit}`;
    if (item.source_qty !== null && item.source_qty !== undefined &&
        Math.abs(Number(item.stock) - Number(item.source_qty)) > 0.0001) {
      const delta = document.createElement('span');
      delta.className = 'delta';
      const diff = Number(item.stock) - Number(item.source_qty);
      delta.textContent = `${diff > 0 ? '+' : '−'}${fmtQty(Math.abs(diff))}`;
      delta.title = 'Difference from the PDF quantity';
      qty.append(' ', delta);
    }
    tr.append(qty);

    tr.append(cell(item.name, 'name-col'));
    tr.append(cell(item.hs_code || '—', 'hs-col'));
    tr.append(cell(item.unit, 'unit-col'));
    tr.append(cell(item.buy_rate === null || item.buy_rate === undefined ? '—' : fmt2(item.buy_rate), 'num-col'));

    const sellCell = cell(fmt2(item.sell_rate), 'num-col sell-col');
    if (item.buy_rate !== null && item.buy_rate !== undefined &&
        Number(item.sell_rate) < Number(item.buy_rate)) {
      const badge = document.createElement('span');
      badge.className = 'badge bad';
      badge.textContent = 'below buy';
      badge.title = `Selling under the buy rate of ${fmt2(item.buy_rate)}`;
      sellCell.append(' ', badge);
    }
    tr.append(sellCell);

    tr.append(cell(fmt2(Number(item.stock) * Number(item.sell_rate)), 'num-col value-col'));

    const actions = document.createElement('td');
    actions.className = 'action-col';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost-dark small';
    btn.textContent = st.editing === item.id ? 'Editing' : 'Edit';
    btn.setAttribute('aria-label', `Edit row ${item.id}, ${item.name}`);
    btn.addEventListener('click', () => {
      st.editing = st.editing === item.id ? null : item.id;
      render();
      if (st.editing === item.id) {
        const input = document.querySelector('tr.editor input[name="name"]');
        if (input) input.focus();
      }
    });
    actions.append(btn);
    tr.append(actions);
    return tr;
  }

  function field(label, control, cls) {
    const wrap = document.createElement('label');
    wrap.className = 'field' + (cls ? ' ' + cls : '');
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, control);
    return wrap;
  }

  function input(name, value, attrs = {}) {
    const el = document.createElement('input');
    el.name = name;
    el.type = attrs.type || 'text';
    if (attrs.type === 'number') {
      el.inputMode = 'decimal';
      el.step = 'any';
      el.min = '0';
    }
    el.value = value === null || value === undefined ? '' : String(value);
    if (attrs.placeholder) el.placeholder = attrs.placeholder;
    el.autocomplete = 'off';
    return el;
  }

  function unitSelect(value) {
    const sel = document.createElement('select');
    sel.name = 'unit';
    ['pcs', 'doz', 'kg'].forEach((unit) => {
      const opt = document.createElement('option');
      opt.value = unit;
      opt.textContent = unit;
      if (unit === value) opt.selected = true;
      sel.append(opt);
    });
    return sel;
  }

  function editorFor(item) {
    const tr = document.createElement('tr');
    tr.className = 'editor';
    const td = document.createElement('td');
    td.colSpan = 11;

    const form = document.createElement('form');
    form.className = 'edit-form';
    form.noValidate = true;

    form.append(field('Name', input('name', item.name)));
    form.append(field('HS code', input('hs_code', item.hs_code || '')));
    form.append(field('Unit', unitSelect(item.unit)));
    form.append(field('Buy rate', input('buy_rate', item.buy_rate, { type: 'number', placeholder: 'none' })));
    form.append(field('Sell rate', input('sell_rate', item.sell_rate, { type: 'number' })));
    form.append(field('Quantity now', input('stock', item.stock, { type: 'number' })));
    form.append(field('Last count', input('last_count', item.last_count, { type: 'number', placeholder: 'none' })));
    form.append(field('Reorder point', input('reorder_point', item.reorder_point, { type: 'number', placeholder: 'none' })));

    const activeWrap = document.createElement('label');
    activeWrap.className = 'check';
    const active = document.createElement('input');
    active.type = 'checkbox';
    active.name = 'active';
    active.checked = Boolean(item.active);
    const activeText = document.createElement('span');
    activeText.textContent = 'Item is in use';
    activeWrap.append(active, activeText);
    form.append(activeWrap);

    const actions = document.createElement('div');
    actions.className = 'edit-actions';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'primary compact';
    save.textContent = 'Save row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost-dark';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      st.editing = null;
      render();
    });
    actions.append(save, cancel);
    form.append(actions);

    const warn = document.createElement('p');
    warn.className = 'edit-warn';
    warn.hidden = true;
    form.append(warn);

    const error = document.createElement('p');
    error.className = 'msg bad';
    form.append(error);

    const note = document.createElement('p');
    note.className = 'hint edit-note';
    note.textContent = `PDF says ${item.source_particulars || 'no particulars'} · quantity ${fmtQty(item.source_qty)} ${item.unit}. Changing the quantity is saved as a stock correction.`;
    form.append(note);

    const check = () => {
      const sell = Number(form.elements.sell_rate.value);
      const buy = Number(form.elements.buy_rate.value);
      const qty = Number(form.elements.stock.value);
      const unit = form.elements.unit.value;
      const notes = [];
      if (form.elements.buy_rate.value !== '' && Number.isFinite(sell) && Number.isFinite(buy) && sell < buy) {
        notes.push('Selling below the buy rate: every sale of this row loses money.');
      }
      if (unit === 'pcs' && Number.isFinite(qty) && qty % 1 !== 0) {
        notes.push('Pieces are counted in whole numbers.');
      }
      if (unit === 'doz' && Number.isFinite(qty) && qty % 0.5 !== 0) {
        notes.push('Dozens are counted in wholes or halves.');
      }
      warn.textContent = notes.join(' ');
      warn.hidden = notes.length === 0;
    };
    form.addEventListener('input', check);
    form.addEventListener('change', check);
    check();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      saveItem(item, form, error, save);
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        st.editing = null;
        render();
      }
    });

    td.append(form);
    tr.append(td);
    return tr;
  }

  // ---------- saving ----------

  async function saveItem(item, form, errorEl, saveBtn) {
    if (st.saving) return;
    errorEl.textContent = '';

    const raw = (name) => form.elements[name].value.trim();
    const nullableNumber = (name) => {
      const v = raw(name);
      return v === '' ? null : Number(v);
    };
    const next = {
      name: raw('name'),
      hs_code: raw('hs_code'),
      unit: form.elements.unit.value,
      buy_rate: nullableNumber('buy_rate'),
      sell_rate: Number(raw('sell_rate')),
      stock: Number(raw('stock')),
      last_count: nullableNumber('last_count'),
      reorder_point: nullableNumber('reorder_point'),
      active: form.elements.active.checked,
    };

    const changes = {};
    Object.keys(next).forEach((key) => {
      const before = key === 'active' ? Boolean(item.active) : item[key];
      const after = next[key];
      if (String(before === null || before === undefined ? '' : before) !==
          String(after === null || after === undefined ? '' : after)) {
        changes[key] = after;
      }
    });

    if (Object.keys(changes).length === 0) {
      st.editing = null;
      render();
      toast('Nothing changed');
      return;
    }
    if (!next.name) {
      errorEl.textContent = 'The name cannot be empty.';
      return;
    }
    if (!Number.isFinite(next.sell_rate) || next.sell_rate <= 0) {
      errorEl.textContent = 'The sell rate must be greater than 0.';
      return;
    }
    if (!Number.isFinite(next.stock) || next.stock < 0) {
      errorEl.textContent = 'The quantity must be 0 or more.';
      return;
    }

    st.saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const updated = await api(`/api/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      st.items = st.items.map((row) => (row.id === updated.id ? updated : row));
      st.editing = null;
      render();
      toast(`Saved row ${updated.id}`);
      setMsg(`Row ${updated.id} saved. The counter now uses these figures.`, 'ok');
    } catch (e) {
      errorEl.textContent = e instanceof ApiError && e.status === 401
        ? 'Locked: the API key was rejected. Check Backend settings.'
        : `Not saved: ${e.message}`;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save row';
    } finally {
      st.saving = false;
    }
  }

  // ---------- filtering ----------

  function applyFilter() {
    const shown = new Set(visibleItems().map((item) => item.id));
    [...$('sheetBody').children].forEach((tr) => {
      const id = Number(tr.dataset.id);
      if (!id) return; // editor rows follow their own row
      tr.hidden = !shown.has(id);
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('editor')) next.hidden = tr.hidden;
    });
    updateCount(shown.size);
  }

  function updateCount(shown) {
    const total = st.items.length;
    if (!total) {
      $('sheetCount').textContent = st.connected ? 'The backend has no items.' : 'Waiting for the backend.';
      return;
    }
    $('sheetCount').textContent = shown === total
      ? `${total} rows. Press Edit on a row to correct it.`
      : `${shown} of ${total} rows match.`;
  }

  // ---------- wiring ----------

  $('apiBase').value = st.apiBase;
  $('apiKey').value = st.apiKey;
  $('saveSettings').addEventListener('click', () => {
    st.apiBase = $('apiBase').value.trim();
    st.apiKey = $('apiKey').value.trim();
    LS.set('cs.apiBase', st.apiBase);
    LS.set('cs.apiKey', st.apiKey);
    load();
  });
  $('reloadBtn').addEventListener('click', load);
  $('sheetSearch').addEventListener('input', applyFilter);

  load();
})();
