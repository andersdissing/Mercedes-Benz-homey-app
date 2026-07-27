'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installRedactedLogging } = require('./log-redactor');

function fakeHomeyInstance() {
  const calls = [];
  return {
    calls,
    log(...args) { calls.push(['log', ...args]); },
    error(...args) { calls.push(['error', ...args]); },
  };
}

test('installRedactedLogging strips PII from string args before they reach the real logger', () => {
  const instance = fakeHomeyInstance();
  installRedactedLogging(instance);

  instance.log(`VIN: W1K2C4KB9NA123456, Region: Europe`);
  instance.log(`[UPDATE] Setting location: 52.520008, 13.404954`);
  instance.error(`Log ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee lookup failed`);

  const logged = instance.calls.map((c) => c.join(' '));
  assert.ok(!logged.some((l) => l.includes('W1K2C4KB9NA123456')));
  assert.ok(!logged.some((l) => l.includes('52.520008')));
  assert.ok(!logged.some((l) => l.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')));
  assert.ok(logged[0].includes('[VIN_REDACTED]'));
  assert.ok(logged[1].includes('[LAT_REDACTED]') && logged[1].includes('[LON_REDACTED]'));
  assert.ok(logged[2].includes('[LOG_ID_REDACTED]'));
});

test('installRedactedLogging leaves the Homey device UUID alone - it is not PII', () => {
  const instance = fakeHomeyInstance();
  installRedactedLogging(instance);

  instance.log('[Device:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee] [UPDATE] Setting battery to: 78%');

  assert.equal(instance.calls[0][1], '[Device:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee] [UPDATE] Setting battery to: 78%');
});

test('installRedactedLogging leaves non-string args and operational telemetry alone', () => {
  const instance = fakeHomeyInstance();
  installRedactedLogging(instance);

  const err = new Error('boom');
  instance.error('Failed:', err);
  instance.log('Setting battery to: 78%');
  instance.log('Sample data keys:', ['soc', 'odo', 'rangeelectric']);

  const [call1] = instance.calls;
  assert.equal(call1[2], err, 'Error object arg was mutated/replaced');
  assert.equal(instance.calls[1][1], 'Setting battery to: 78%');
  assert.deepEqual(instance.calls[2][2], ['soc', 'odo', 'rangeelectric']);
});

test('installRedactedLogging is idempotent - wrapping twice does not double-redact or double-wrap', () => {
  const instance = fakeHomeyInstance();
  installRedactedLogging(instance);
  installRedactedLogging(instance);

  instance.log('VIN: W1K2C4KB9NA123456');
  assert.equal(instance.calls.length, 1);
  assert.equal(instance.calls[0][1], 'VIN: [VIN_REDACTED]');
});
