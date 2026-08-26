'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePrecondState, isPrecondRunning, describePrecondState } = require('../lib/precond-status');

/**
 * A preheat started by hand in the Mercedes me app flips `precondNow`, not
 * `precondActive` - and `precondActive` was the only attribute the device
 * read, so climate_active stayed off (#73).
 */

function running(previous, data) {
  const { state, seen } = mergePrecondState(previous, data);
  return { seen, state, on: isPrecondRunning(state) };
}

test('a manual preheat from the Mercedes me app switches climate on', () => {
  // The exact shape of the report: precondNow flips, precondActive stays false.
  const r = running(undefined, { precondNow: true, precondActive: false, precondState: false });
  assert.equal(r.seen, true);
  assert.equal(r.on, true);
});

test('the precondState activation flag alone switches climate on', () => {
  const r = running(undefined, { precondNow: false, precondActive: false, precondState: true });
  assert.equal(r.on, true);
});

test('a departure-time start still switches climate on', () => {
  const r = running(undefined, { precondNow: false, precondActive: true });
  assert.equal(r.on, true);
});

test('idle car is off', () => {
  // precondState is false here because the parser decodes activation_state,
  // not the "immediate preheat supported" flag that reads 1 on an idle car.
  const r = running(undefined, { precondNow: false, precondActive: false, precondState: false });
  assert.equal(r.on, false);
});

test('a partial update that only ends the manual preheat does not kill a departure-time one', () => {
  const full = running(undefined, { precondNow: true, precondActive: true });
  assert.equal(full.on, true);
  const partial = running(full.state, { precondNow: false });
  assert.equal(partial.on, true, 'precondActive was not in the partial update and must be remembered');
});

test('a partial update that ends the only running mode switches off', () => {
  const full = running(undefined, { precondNow: true, precondActive: false });
  const partial = running(full.state, { precondNow: false });
  assert.equal(partial.on, false);
});

test('an update without any precond attribute is not an update', () => {
  const r = running({ now: true }, { soc: 80, rangeelectric: 300 });
  assert.equal(r.seen, false);
  assert.equal(r.on, true, 'the remembered state is untouched');
});

test('string and numeric forms count, as the other status attributes accept them', () => {
  assert.equal(running(undefined, { precondNow: 'true' }).on, true);
  assert.equal(running(undefined, { precondNow: 1 }).on, true);
  assert.equal(running(undefined, { precondnow: true }).on, true, 'lower-case spelling');
  assert.equal(running(undefined, { precondNow: 'false' }).on, false);
  assert.equal(running(undefined, { precondNow: 0 }).on, false);
});

test('the log fragment shows all three inputs', () => {
  const { state } = mergePrecondState(undefined, { precondNow: true, precondActive: false, precondState: false });
  assert.equal(describePrecondState(state), 'precondNow=true, precondActive=false, precondState=false');
});
