'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactValue, installRedactedLogging } = require('../lib/log-redactor');

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

test('redacts raw protobuf position attribute names, not just prose', () => {
  const line = '"positionLat":{"doubleValue":55.676098},"positionLong":{"doubleValue":12.568337}';
  assert.equal(
    redactText(line),
    '"positionLat":{"doubleValue":[LAT_REDACTED]},"positionLong":{"doubleValue":[LON_REDACTED]}',
  );
});

test('redacts the device.js "Setting location" line', () => {
  assert.equal(
    redactText('[UPDATE] Setting location - latitude: 55.676098, longitude: 12.568337'),
    '[UPDATE] Setting location - latitude: [LAT_REDACTED], longitude: [LON_REDACTED]',
  );
});

test('redacts email addresses', () => {
  assert.equal(
    redactText('Login attempt with email: someone@example.com (selected region: Europe)'),
    'Login attempt with email: [EMAIL_REDACTED] (selected region: Europe)',
  );
});

test('redacts credentials and account-linked IDs embedded in JSON dumps', () => {
  const deviceObj = JSON.stringify({
    name: 'Mercedes-Benz (AB-123-CD)',
    store: {
      username: 'someone@example.com',
      password: 'hunter2',
      region: 'Europe',
      deviceGuid: '0f4a1c2e-1111-2222-3333-abcdefabcdef',
      token: { access_token: 'abc.def.ghi', refresh_token: 'r-123' },
    },
  });
  const redacted = redactText(deviceObj);

  assert.ok(!redacted.includes('hunter2'), 'password must not survive');
  assert.ok(!redacted.includes('someone@example.com'), 'username/email must not survive');
  assert.ok(!redacted.includes('AB-123-CD'), 'license-plate-bearing name must not survive');
  assert.ok(!redacted.includes('0f4a1c2e-1111-2222-3333-abcdefabcdef'), 'deviceGuid must not survive');
  assert.ok(!redacted.includes('abc.def.ghi') && !redacted.includes('r-123'), 'OAuth tokens must not survive');
  assert.ok(redacted.includes('[PASSWORD_REDACTED]'));
});

test('redacts a PIN passed to a vehicle command', () => {
  const commandData = JSON.stringify({ doorsUnlock: { pin: '1234', doors: [] } });
  const redacted = redactText(commandData);
  assert.ok(!redacted.includes('1234'));
  assert.ok(redacted.includes('[PIN_REDACTED]'));
});

test('redacts large geofence fenceId/violation id, keeps structural zeros', () => {
  const line = '{"fenceId":48213099,"id":918273645,"snapshot":{"id":0,"isActive":false}}';
  const redacted = redactText(line);
  assert.ok(redacted.includes('[FENCE_ID_REDACTED]'));
  assert.ok(redacted.includes('[VIOLATION_ID_REDACTED]'));
  assert.ok(redacted.includes('"id":0'), 'structural zero id must survive');
  assert.ok(!redacted.includes('48213099') && !redacted.includes('918273645'));
});

test('redacts a VIN hex-encoded inside a protobuf byte dump, leaving framing bytes', () => {
  const vin = 'WDD2050461R123456';
  const framingBefore = Buffer.from([0x12, 0x11]);
  const framingAfter = Buffer.from([0x29, 0x0a, 0x0f]);
  const buffer = Buffer.concat([framingBefore, Buffer.from(vin, 'ascii'), framingAfter]);
  const line = `First 50 bytes (hex): ${buffer.toString('hex')}`;

  const redacted = redactText(line);
  assert.ok(redacted.includes('[HEX_VIN_REDACTED]'));
  assert.ok(redacted.includes(framingBefore.toString('hex')), 'framing bytes before the VIN must survive');
  assert.ok(redacted.includes(framingAfter.toString('hex')), 'framing bytes after the VIN must survive');
  assert.ok(!redacted.includes(Buffer.from(vin, 'ascii').toString('hex')), 'hex-encoded VIN bytes must not survive');
});

test('redactValue recursively redacts plain objects/arrays passed as a log arg', () => {
  const described = {
    message: 'Request failed with status code 400',
    status: 400,
    body: 'VIN WDD2050461R123456 not found for someone@example.com',
  };
  const redacted = redactValue(described);
  assert.equal(redacted.status, 400);
  assert.ok(!redacted.body.includes('WDD2050461R123456'));
  assert.ok(!redacted.body.includes('someone@example.com'));
});

test('redactValue leaves Error instances untouched and tolerates circular refs', () => {
  const err = new Error('boom');
  assert.equal(redactValue(err), err);

  const circular = { name: 'x' };
  circular.self = circular;
  assert.doesNotThrow(() => redactValue(circular));
});

test('installRedactedLogging works against a non-writable AND non-configurable log/error property', () => {
  // Mirrors the real Homey SDK App/Driver/Device instance. Two separate
  // production crashes proved `log`/`error` can't be touched at all:
  // `instance.log = fn` throws "Cannot assign to read only property"
  // (non-writable, v1.1.33), and `Object.defineProperty(instance, 'log',
  // ...)` throws "Cannot redefine property" (non-configurable, v1.1.34).
  // installRedactedLogging must not go anywhere near the instance
  // property at all - it patches the global console instead.
  class FakeHomeyBase {
    constructor() {
      Object.defineProperty(this, 'log', {
        value: (...args) => console.log(...args),
        writable: false,
        configurable: false,
        enumerable: false,
      });
      Object.defineProperty(this, 'error', {
        value: (...args) => console.error(...args),
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }
  }
  const instance = new FakeHomeyBase();

  assert.throws(() => { instance.log = () => {}; }, TypeError);
  assert.throws(() => {
    Object.defineProperty(instance, 'log', { value: () => {}, configurable: true });
  }, TypeError);

  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const seenLog = [];
  const seenError = [];
  console.log = (...args) => seenLog.push(args);
  console.error = (...args) => seenError.push(args);
  try {
    assert.doesNotThrow(() => installRedactedLogging());

    instance.log('VIN: WDD2050461R123456');
    instance.error('failed:', 'VIN: WDD2050461R123456');
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  assert.deepEqual(seenLog[0], ['VIN: [VIN_REDACTED]']);
  assert.deepEqual(seenError[0], ['failed:', 'VIN: [VIN_REDACTED]']);
});
