// Unit tests for the Workers/D1 pure rules (port of backend/tests/test_engine.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine.js';

const ITEMS = [
  { id: 1, name: 'Usb Cable', unit: 'pcs', buy_rate: 37, sell_rate: 40, stock: 87, active: true },
  { id: 2, name: 'Mobile Cover', unit: 'pcs', buy_rate: 53, sell_rate: 57, stock: 10, active: true },
  { id: 3, name: 'Camara Lens', unit: 'doz', buy_rate: 140, sell_rate: 150, stock: 10, active: true },
  { id: 4, name: 'Steel Ring', unit: 'kg', buy_rate: 600, sell_rate: 642, stock: 5, active: true },
  { id: 5, name: 'P B C Sticket', unit: 'kg', buy_rate: null, sell_rate: 717, stock: 4, active: true },
];

test('taxable base benchmark', () => {
  assert.deepEqual(engine.taxableBase(7500, 13), { base: 6637.17, vat: 862.83 });
});

test('taxable base zero vat', () => {
  assert.deepEqual(engine.taxableBase(1000, 0), { base: 1000, vat: 0 });
});

test('rate conversion pcs/dozen', () => {
  assert.equal(engine.convertRate(57, 'pcs', 'doz'), 684);
  assert.equal(engine.convertRate(684, 'doz', 'pcs'), 57);
  assert.equal(engine.convertRate(40, 'pcs', 'pcs'), 40);
});

test('kg is isolated and qty conversion is inverse', () => {
  assert.equal(engine.convertRate(642, 'kg', 'pcs'), null);
  assert.equal(engine.convertQty(1, 'pcs', 'doz'), 1 / 12);
  assert.equal(engine.convertQty(2, 'doz', 'pcs'), 24);
});

test('valid count rules', () => {
  assert.equal(engine.validCount('pcs', 10), true);
  assert.equal(engine.validCount('pcs', 1.5), false);
  assert.equal(engine.validCount('doz', 22.5), true);
  assert.equal(engine.validCount('doz', 22.3), false);
  assert.equal(engine.validCount('kg', 0.333), true);
  assert.equal(engine.validCount('kg', 0), false);
});

test('rate for count', () => {
  assert.equal(engine.rateForCount(557.52, 10), 55.75);
  assert.equal(engine.rateForCount(600, 15), 40);
});

test('qty for rate', () => {
  assert.equal(engine.qtyForRate(3210, 642), 5);
  assert.equal(engine.qtyForRate(2654.87, 642), 4.135);
});

test('band statuses', () => {
  assert.equal(engine.bandStatus(39, 37).status, 'OK');
  assert.equal(engine.bandStatus(40, 37).status, 'OVER_TAX');
  assert.equal(engine.bandStatus(38, 37).status, 'LOSS');
  assert.equal(engine.bandStatus(40, null).status, 'UNKNOWN_COST');
});

test('band boundaries', () => {
  assert.equal(engine.bandStatus(37 * 1.05, 37).status, 'OK');
  assert.equal(engine.bandStatus(37 * 1.07, 37).status, 'OK');
  assert.equal(engine.bandStatus(37 * 1.071, 37).status, 'OVER_TAX');
});

test('match usb confident', () => {
  const match = engine.matchItems('usb cable', 40, 'pcs', ITEMS);
  assert.equal(match.confident, true);
  assert.equal(match.item.name, 'Usb Cable');
  assert.equal(match.suggestions[0].rate_gap_pct, 0);
});

test('match rate-only goes to review', () => {
  const match = engine.matchItems('random gadget', 12.34, 'pcs', ITEMS);
  assert.equal(match.confident, false);
  assert.equal(match.method, 'rate_only');
  assert.equal(match.suggestions.length, 3);
  assert.equal(match.suggestions[0].name, 'Camara Lens');
});

test('match synonym and dozen conversion', () => {
  const match = engine.matchItems('camara lens', 150, 'doz', ITEMS);
  assert.equal(match.confident, true);
  assert.equal(match.item.name, 'Camara Lens');
});

test('match kg isolated to kg items', () => {
  const match = engine.matchItems('usb cable', 40, 'kg', ITEMS);
  assert.equal(match.confident, false);
  assert.ok(match.suggestions.length > 0);
  assert.ok(match.suggestions.every((s) => s.unit === 'kg'));
  assert.ok(match.suggestions.every((s) => s.name !== 'Usb Cable'));
});

test('match unknown cost suggestion', () => {
  const match = engine.matchItems('p b c sticket', 717, 'kg', ITEMS);
  assert.equal(match.confident, true);
  assert.equal(match.item.name, 'P B C Sticket');
});

test('bill totals paisa variance', () => {
  const totals = engine.billTotals([{ subtotal: 358.40 }], 405, 13);
  assert.equal(totals.taxable_base, 358.41);
  assert.equal(totals.lines_total, 358.40);
  assert.equal(totals.variance, -0.01);
});
