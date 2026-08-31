'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyFromFeatures,
  resolvePowertrain,
  capabilityPlan,
  EV_CAPABILITIES
} = require('../lib/powertrain');

/**
 * A diesel GLC 220d was paired as a battery device sitting at 0% and Homey
 * raised a low-battery alert for it (#79). The powertrain has to be decided
 * from what Mercedes says the car can be commanded to do, because 0% is a
 * legitimate reading and a missing attribute means nothing.
 */

// What /capabilities/commands looks like for a diesel: standheizung and
// remote engine start, no charging anything.
const DIESEL_FEATURES = {
  DOORS_LOCK: true,
  DOORS_UNLOCK: true,
  AUXHEAT_START: true,
  AUXHEAT_STOP: true,
  AUXHEAT_CONFIGURE: true,
  ENGINE_START: true,
  ENGINE_STOP: true,
  WINDOWS_OPEN: true,
  SIGPOS_START: true
};

const BEV_FEATURES = {
  DOORS_LOCK: true,
  CHARGE_PROGRAM_CONFIGURE: true,
  CHARGE_OPT_START: true,
  CHARGE_OPT_STOP: true,
  ZEV_PRECONDITIONING_START: true,
  ZEV_PRECONDITIONING_STOP: true,
  WINDOWS_OPEN: true
};

test('a diesel is combustion', () => {
  assert.equal(classifyFromFeatures(DIESEL_FEATURES), 'ice');
});

test('a battery-electric car is electric', () => {
  assert.equal(classifyFromFeatures(BEV_FEATURES), 'ev');
});

test('a plug-in hybrid counts as electric and keeps everything', () => {
  // Both marker families. There is no hybrid state on purpose: the EV verdict
  // keeps every capability, which is what a PHEV needs.
  const phev = { ...DIESEL_FEATURES, ...BEV_FEATURES };
  assert.equal(classifyFromFeatures(phev), 'ev');
  assert.deepEqual(capabilityPlan(classifyFromFeatures(phev)).remove, []);
});

test('the camelCase feature dict matches the same markers', () => {
  // /capabilities returns features in camelCase, /capabilities/commands in
  // SCREAMING_SNAKE, and getVehicleFeatures() merges both into one map.
  assert.equal(classifyFromFeatures({ chargeProgramConfigure: true }), 'ev');
  assert.equal(classifyFromFeatures({ auxheatStart: true }), 'ice');
});

test('a command the car does not offer is not a marker', () => {
  // Every car is sent the same catalogue; only isAvailable says anything.
  assert.equal(classifyFromFeatures({ CHARGE_PROGRAM_CONFIGURE: false, AUXHEAT_START: true }), 'ice');
  assert.equal(classifyFromFeatures({ CHARGE_PROGRAM_CONFIGURE: false, AUXHEAT_START: false }), 'unknown');
});

test('no answer at all is unknown, not electric', () => {
  // Both endpoints 401 for some cars, and getVehicleFeatures() returns {}.
  assert.equal(classifyFromFeatures({}), 'unknown');
  assert.equal(classifyFromFeatures(null), 'unknown');
  assert.equal(classifyFromFeatures(undefined), 'unknown');
  assert.equal(classifyFromFeatures({ DOORS_LOCK: true, WINDOWS_OPEN: true }), 'unknown');
});

test('the setting overrides detection in both directions', () => {
  assert.equal(resolvePowertrain({ override: 'ice', detected: 'ev' }), 'ice');
  assert.equal(resolvePowertrain({ override: 'ev', detected: 'ice' }), 'ev');
  assert.equal(resolvePowertrain({ override: 'ice', detected: 'unknown' }), 'ice');
  assert.equal(resolvePowertrain({ override: 'ev', detected: 'unknown' }), 'ev');
});

test('auto defers to detection', () => {
  assert.equal(resolvePowertrain({ override: 'auto', detected: 'ice' }), 'ice');
  assert.equal(resolvePowertrain({ override: 'auto', detected: 'ev' }), 'ev');
  assert.equal(resolvePowertrain({ override: 'auto', detected: 'unknown' }), 'unknown');
  // An unset or unrecognised setting behaves like auto.
  assert.equal(resolvePowertrain({ detected: 'ice' }), 'ice');
  assert.equal(resolvePowertrain({ override: 'diesel', detected: 'ice' }), 'ice');
  assert.equal(resolvePowertrain(), 'unknown');
});

test('a combustion car loses the EV capabilities and the battery declaration', () => {
  const plan = capabilityPlan('ice');
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.remove, EV_CAPABILITIES);
  assert.ok(plan.remove.includes('measure_battery'));
  assert.equal(plan.batteries, false);
});

test('an electric car keeps them and is declared battery-powered', () => {
  const plan = capabilityPlan('ev');
  assert.deepEqual(plan.add, EV_CAPABILITIES);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.batteries, true);
});

test('an undetected car keeps every capability but raises no battery alert', () => {
  // Removing a capability destroys its history and breaks flows using it -
  // far too destructive to do on a guess. Not declaring batteries is enough
  // to silence the alert.
  const plan = capabilityPlan('unknown');
  assert.deepEqual(plan.add, EV_CAPABILITIES);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.batteries, false);
});
