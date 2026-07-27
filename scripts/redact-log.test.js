'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scrub, findSurvivingPii } = require('./redact-log');

// Synthetic fixture shaped like a real app log (same structure reported in
// issue #47), built with fabricated values - no real user data.
const VIN = 'W1K2C4KB9NA123456';
const DEVICE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOG_UUID = '11111111-2222-3333-4444-555555555555';
const LAT = '52.520008';
const LON = '13.404954';
const FENCE_ID = '123456';
const VIOLATION_ID = '987654321';
const ZONE_NAME = 'Home 2026-01-01';

const vinHex = Buffer.from(VIN, 'ascii').toString('hex');

function buildFixture() {
  return [
    `Log ID: ${LOG_UUID} User Message: Vehicle not reporting everything`,
    `2026-07-27T07:19:32.101Z [log] [MercedesMeApp] [PARSER] tirepressureRearLeft:`,
    `2026-07-27T07:19:32.102Z [log] [MercedesMeApp] - doubleValue: 312.5`,
    `2026-07-27T07:19:32.102Z [log] [MercedesMeApp] - displayValue: "310"`,
    `2026-07-27T07:19:32.102Z [log] [MercedesMeApp] - pressureUnit: KPA`,
    `2026-07-27T07:19:32.102Z [log] [MercedesMeApp] - selected value: 3.125`,
    `2026-07-27T07:19:32.104Z [log] [MercedesMeApp] Extracted 129 vehicle attributes`,
    `2026-07-27T07:19:32.105Z [log] [MercedesMeApp] [API] VEPUpdate parsed - VIN: ${VIN}, Attributes count: 15`,
    `2026-07-27T07:19:32.105Z [log] [ManagerDrivers] [Driver:mercedes-vehicle] [Device:${DEVICE_UUID}] [WEBSOCKET] Received FULL update for vehicle`,
    `2026-07-27T07:19:32.110Z [log] [ManagerDrivers] [Driver:mercedes-vehicle] [Device:${DEVICE_UUID}] [UPDATE] Setting battery to: 78%`,
    `2026-07-27T07:19:32.125Z [log] [ManagerDrivers] [Driver:mercedes-vehicle] [Device:${DEVICE_UUID}] [UPDATE] Setting odometer to: 73449 km`,
    `2026-07-27T07:19:32.133Z [log] [ManagerDrivers] [Driver:mercedes-vehicle] [Device:${DEVICE_UUID}] [UPDATE] Setting acceleration eco score to: 0`,
    `2026-07-27T07:19:32.138Z [log] [ManagerDrivers] [Driver:mercedes-vehicle] [Device:${DEVICE_UUID}] [UPDATE] Setting location: ${LAT}, ${LON}`,
    `2026-07-27T07:19:32.220Z [log] [MercedesMeApp] [API] First 50 bytes (hex): 1211${vinHex}290a0f706f736974696f6e48656164696e67121608f18598d30650f6ffed`,
    `2026-07-27T07:19:32.665Z [log] [ManagerDrivers] [Driver:mercedes-vehicle] [Device:${DEVICE_UUID}] [POLL] Setting latitude from geofence: ${LAT}`,
    `2026-07-27T07:19:32.669Z [log] [ManagerDrivers] [Driver:mercedes-vehicle] [Device:${DEVICE_UUID}] [POLL] Setting longitude from geofence: ${LON}`,
    `2026-07-27T07:19:32.665Z [log] [MercedesMeApp] [API] Geofencing last violation: {"coordinate":{"latitude":${LAT},"longitude":${LON}},"fenceId":${FENCE_ID},"id":${VIOLATION_ID},"snapshot":{"activeTimes":{"begin":0,"days":[1,2,3,4,5,6,7],"end":1439},"id":0,"isActive":false,"name":"${ZONE_NAME}","shape":{"circle":{"center":{"latitude":${LAT},"longitude":${LON}},"radius":7010}},"violationType":"LEAVE"},"time":1784370678,"type":"LEAVE"}`,
    `2026-07-27T07:20:02.073Z [log] [MercedesMeApp] [WS] Connection watchdog expired - no data received`,
    `stderr: n/a`,
  ].join('\n');
}

test('scrub removes all listed PII types', () => {
  const { output, offenders } = scrub(buildFixture(), { pseudonymize: false, hash: () => '' });

  assert.equal(offenders.length, 0, `unexpected offenders: ${JSON.stringify(offenders)}`);

  assert.ok(!output.includes(VIN), 'plaintext VIN survived');
  assert.ok(!output.includes(vinHex), 'hex-encoded VIN survived');
  assert.ok(!output.includes(LOG_UUID), 'log UUID survived');
  assert.ok(!output.includes(LAT), 'latitude survived');
  assert.ok(!output.includes(LON), 'longitude survived');
  assert.ok(!output.includes(ZONE_NAME), 'zone name survived');
  assert.ok(!output.includes(`"fenceId":${FENCE_ID}`), 'fenceId survived');
  assert.ok(!output.includes(`,"id":${VIOLATION_ID}`), 'violation id survived');

  assert.ok(output.includes('[VIN_REDACTED]'));
  assert.ok(output.includes('[HEX_VIN_REDACTED]'));
  assert.ok(output.includes('[LOG_ID_REDACTED]'));
  assert.ok(output.includes('[ZONE_NAME_REDACTED]'));
  assert.ok(output.includes('[FENCE_ID_REDACTED]'));
  assert.ok(output.includes('[VIOLATION_ID_REDACTED]'));
});

test('scrub preserves non-identifying operational telemetry', () => {
  const { output } = scrub(buildFixture(), { pseudonymize: false, hash: () => '' });

  assert.ok(output.includes('312.5'), 'tire pressure doubleValue lost');
  assert.ok(output.includes('displayValue: "310"'), 'tire pressure displayValue lost');
  assert.ok(output.includes('selected value: 3.125'), 'tire pressure computed value lost');
  assert.ok(output.includes('Setting battery to: 78%'), 'battery % lost');
  assert.ok(output.includes('Setting odometer to: 73449 km'), 'odometer lost');
  assert.ok(output.includes('Setting acceleration eco score to: 0'), 'eco score lost');
  assert.ok(output.includes('"id":0'), 'structural zero id was redacted (over-redaction)');
  assert.ok(output.includes('2026-07-27T07:19:32.101Z'), 'timestamp lost');
  assert.ok(output.includes('radius":7010'), 'unrelated numeric field mangled');
  assert.ok(output.includes(DEVICE_UUID), 'Homey device UUID was redacted - it is not PII, it does not identify the person or car');
});

test('scrub is idempotent - already-redacted text has nothing left to redact', () => {
  const first = scrub(buildFixture(), { pseudonymize: false, hash: () => '' });
  const second = scrub(first.output, { pseudonymize: false, hash: () => '' });
  assert.equal(second.offenders.length, 0);
  assert.equal(first.output, second.output);
});

test('pseudonymize mode maps the same VIN to the same stable token across lines', () => {
  const crypto = require('node:crypto');
  const salt = 'test-salt';
  const hash = (type, value) => crypto.createHmac('sha256', salt).update(`${type}:${value}`).digest('hex').slice(0, 8).toUpperCase();
  const fixture = buildFixture() + `\nSecond mention of VIN: ${VIN} for correlation`;

  const { output, offenders } = scrub(fixture, { pseudonymize: true, hash });
  assert.equal(offenders.length, 0);

  const tokenMatches = [...output.matchAll(/\[VIN_REDACTED_[0-9A-F]{8}\]/g)].map((m) => m[0]);
  assert.ok(tokenMatches.length >= 2, 'expected VIN token to appear more than once');
  assert.ok(new Set(tokenMatches).size === 1, 'same VIN produced different tokens across lines');
  assert.ok(!output.includes(VIN));
});

test('self-verify gate flags a deliberately un-scrubbed log', () => {
  const offenders = findSurvivingPii(buildFixture());
  assert.ok(offenders.length > 0, 'expected the raw fixture to fail self-verification');
  const types = offenders.map((o) => o.type);
  assert.ok(types.includes('VIN'));
  assert.ok(types.includes('FENCE_ID'));
  assert.ok(types.includes('VIOLATION_ID'));
});
