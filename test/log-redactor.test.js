'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText, installRedactedLogging } = require('../lib/log-redactor');

test('redacts a VIN', () => {
  const out = redactText('VIN: WDD2050461R123456, Region: Europe');
  assert.equal(out, 'VIN: [VIN_REDACTED], Region: Europe');
});

test('redacts latitude/longitude next to their label, leaves unrelated decimals alone', () => {
  assert.equal(
    redactText('[POLL] Setting latitude from geofence: 55.676098'),
    '[POLL] Setting latitude from geofence: [LAT_REDACTED]',
  );
  assert.equal(
    redactText('[POLL] Setting longitude from geofence: 12.568337'),
    '[POLL] Setting longitude from geofence: [LON_REDACTED]',
  );

  const tirePressure = '- doubleValue: 312.5';
  assert.equal(redactText(tirePressure), tirePressure);
});

test('redacts geofence zone names, quoted and unquoted', () => {
  assert.equal(
    redactText('Geofence zone found via snapshot.name: "Home"'),
    'Geofence zone found via snapshot.name: "[ZONE_REDACTED]"',
  );
  assert.equal(
    redactText('[UPDATE] Setting geofence zone to: Home'),
    '[UPDATE] Setting geofence zone to: [ZONE_REDACTED]',
  );
});

test('preserves non-PII telemetry', () => {
  const line = 'Setting odometer to: 73449 km, battery to: 78%, driving time to: 15 min';
  assert.equal(redactText(line), line);
});

test('installRedactedLogging does not crash on a non-writable log/error property', () => {
  // Mirrors the Homey SDK App/Device instance: `log`/`error` are defined
  // as non-writable own properties, so `instance.log = fn` throws
  // "Cannot assign to read only property" under strict mode (the crash
  // reported against v1.1.33).
  class FakeHomeyBase {
    constructor() {
      Object.defineProperty(this, 'log', {
        value: (...args) => { this.lastLog = args; },
        writable: false,
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(this, 'error', {
        value: (...args) => { this.lastError = args; },
        writable: false,
        configurable: true,
        enumerable: false,
      });
    }
  }
  const instance = new FakeHomeyBase();

  assert.throws(() => { instance.log = () => {}; }, TypeError);
  assert.doesNotThrow(() => installRedactedLogging(instance));

  instance.log('VIN: WDD2050461R123456');
  assert.deepEqual(instance.lastLog, ['VIN: [VIN_REDACTED]']);

  instance.error('failed:', 'VIN: WDD2050461R123456');
  assert.deepEqual(instance.lastError, ['failed:', 'VIN: [VIN_REDACTED]']);
});
