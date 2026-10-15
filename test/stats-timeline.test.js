'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { StatsTimeline } = require('../lib/stats-timeline');
const ConnectionStats = require('../lib/connection-stats');
const MercedesWebSocket = require('../lib/websocket');

/**
 * The 60-day hourly connection timeline behind GET /stats.
 *
 * All on a fake clock: the subject is clock hours, restarts within and across
 * them, and 60 days of retention.
 */

const HOUR = 3600000;
// 10:00 UTC on 15 Oct 2026 - a clock-hour boundary, so offsets read as times.
const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);

function useFakeClock(t, now = T0) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
}

/** homey.settings, counting writes and keeping what was written as JSON. */
function fakeSettings(initial = {}) {
  const store = { ...initial };
  return {
    writes: 0,
    get(key) { return store[key] === undefined ? undefined : JSON.parse(store[key]); },
    set(key, value) { this.writes++; store[key] = JSON.stringify(value); },
    raw(key) { return store[key]; },
  };
}

const sumOf = (records, field, slot) => records.reduce((n, r) => n + ((r[field] || [])[slot] || 0), 0);

// --- counting, writing, restarting ------------------------------------------

test('counting stays in memory: a thousand events, no writes', (t) => {
  useFakeClock(t);
  const settings = fakeSettings();
  const timeline = new StatsTimeline(settings);
  timeline.load();

  for (let i = 0; i < 500; i++) { timeline.count('open'); timeline.count('idle'); }
  assert.equal(settings.writes, 0);

  timeline.flush();
  assert.equal(settings.writes, 1);
  assert.deepEqual(settings.get('connectionTimeline').cur, { t: T0 / 1000, h: [500], c: [500] });
});

test('records follow clock hours, whenever the write happens', (t) => {
  useFakeClock(t, T0 + 59 * 60000); // 10:59
  const timeline = new StatsTimeline(fakeSettings());
  timeline.load();

  timeline.count('open');
  t.mock.timers.tick(2 * 60000); // 11:01
  timeline.count('open');
  timeline.count('open');

  const { hours } = timeline.toJSON();
  assert.deepEqual(hours, [
    { t: T0 / 1000, h: [1] },
    { t: (T0 + HOUR) / 1000, h: [2] },
  ]);
});

test('an hour with nothing in it still gets a record while the app runs', (t) => {
  useFakeClock(t);
  const timeline = new StatsTimeline(fakeSettings());
  timeline.load();

  timeline.count('open');
  t.mock.timers.tick(3 * HOUR);

  const { hours } = timeline.toJSON();
  assert.equal(hours.length, 2, 'the 10:00 hour and the one in progress');
  timeline.flush();
  t.mock.timers.tick(HOUR);
  timeline.flush();
  assert.deepEqual(timeline.toJSON().hours.map((r) => r.t - T0 / 1000), [0, 3 * 3600, 4 * 3600]);
});

test('a restart within the hour carries on counting into the same record', (t) => {
  useFakeClock(t, T0 + 10 * 60000);
  const settings = fakeSettings();

  const before = new StatsTimeline(settings);
  before.load();
  for (let i = 0; i < 7; i++) before.count('open');
  before.count('429');
  before.flush(); // onUninit

  t.mock.timers.tick(5 * 60000); // back at 10:15
  const after = new StatsTimeline(settings);
  after.load();
  for (let i = 0; i < 3; i++) after.count('open');

  const { hours } = after.toJSON();
  assert.equal(hours.length, 1, 'one record for the hour, not two');
  assert.deepEqual(hours[0], { t: T0 / 1000, h: [10, 1] }, 'nothing lost, nothing counted twice');
});

test('restarting twice within the hour still counts every event once', (t) => {
  useFakeClock(t, T0 + 5 * 60000);
  const settings = fakeSettings();

  for (let run = 0; run < 3; run++) {
    const timeline = new StatsTimeline(settings);
    timeline.load();
    timeline.count('idle');
    timeline.count('idle');
    timeline.flush();
    t.mock.timers.tick(60000);
  }

  const stored = settings.get('connectionTimeline');
  assert.deepEqual(stored.hours, []);
  assert.deepEqual(stored.cur, { t: T0 / 1000, c: [6] });
});

test('back after the hour ended: the stored hour is closed as it was, and a new one begins', (t) => {
  useFakeClock(t, T0 + 50 * 60000); // 10:50
  const settings = fakeSettings();

  const before = new StatsTimeline(settings);
  before.load();
  before.count('open');
  before.count('idle');
  before.flush();

  t.mock.timers.tick(2 * HOUR + 20 * 60000); // back at 13:10
  const after = new StatsTimeline(settings);
  after.load();
  after.count('open');

  const { hours } = after.toJSON();
  assert.deepEqual(hours, [
    { t: T0 / 1000, h: [1], c: [1] },
    { t: (T0 + 3 * HOUR) / 1000, h: [1] },
  ], 'no record for 11:00 or 12:00: the app was not running');
});

test('a crash loses what came after the last write, and counts nothing twice', (t) => {
  useFakeClock(t, T0 + 5 * 60000);
  const settings = fakeSettings();

  const before = new StatsTimeline(settings);
  before.load();
  before.count('open');
  before.flush(); // the hourly write
  before.count('open'); // ...then the process dies before onUninit

  const after = new StatsTimeline(settings);
  after.load();
  assert.deepEqual(after.toJSON().hours, [{ t: T0 / 1000, h: [1] }]);
});

test('a stored value that is not a timeline is set aside, not crashed on', (t) => {
  useFakeClock(t);
  const settings = fakeSettings({ connectionTimeline: JSON.stringify({ hours: 'garbage', cur: { t: 'x' } }) });
  const timeline = new StatsTimeline(settings);

  timeline.load();
  timeline.count('open');
  assert.deepEqual(timeline.toJSON().hours, [{ t: T0 / 1000, h: [1] }]);
});

test('the ignition flag marks every hour it was on in, and only those', (t) => {
  useFakeClock(t, T0 + 50 * 60000);
  const timeline = new StatsTimeline(fakeSettings());
  timeline.load();

  timeline.ignition(true); // 10:50, on
  t.mock.timers.tick(30 * 60000); // 11:20, still on: the hour counts too
  timeline.ignition(false);
  t.mock.timers.tick(HOUR); // 12:20, off all hour
  timeline.count('idle');

  assert.deepEqual(timeline.toJSON().hours.map((r) => r.i || 0), [1, 1, 0]);
});

test('60 days are kept: 1440 records, the oldest dropped first', (t) => {
  useFakeClock(t);
  const timeline = new StatsTimeline(fakeSettings());
  timeline.load();

  for (let h = 0; h < 61 * 24; h++) {
    timeline.count('open');
    t.mock.timers.tick(HOUR);
  }

  const { hours } = timeline.toJSON();
  assert.equal(hours.length, 1440);
  const oldestKept = hours[0].t * 1000;
  assert.equal(Date.now() - oldestKept, 1439 * HOUR, 'the hour in progress plus the 1439 before it');
});

// --- size -------------------------------------------------------------------

/**
 * Homey documents no size limit for app settings, so this sets its own: the
 * whole value is rewritten every hour and kept in an app's memory, so 60 days
 * of it should cost about as much as a small image, not more.
 */
function storedSizeOf(t, makeHour) {
  useFakeClock(t, T0 - 1440 * HOUR);
  const settings = fakeSettings();
  const timeline = new StatsTimeline(settings);
  timeline.load();

  for (let h = 0; h < 1440; h++) {
    makeHour(timeline);
    t.mock.timers.tick(HOUR);
  }
  makeHour(timeline);
  timeline.flush();

  const stored = settings.get('connectionTimeline');
  assert.equal(stored.hours.length + 1, 1440, '1440 records, the last in progress');
  return Buffer.byteLength(settings.raw('connectionTimeline'));
}

test('1440 parked-car hours: well under 64 KB', (t) => {
  const bytes = storedSizeOf(t, (timeline) => {
    for (let i = 0; i < 40; i++) { timeline.count('open'); timeline.count('idle'); }
  });
  t.diagnostic(`1440 parked hours: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`);
  assert.ok(bytes < 64 * 1024, `${bytes} bytes`);
});

test('1440 hours with every field in use: still under 128 KB', (t) => {
  const bytes = storedSizeOf(t, (timeline) => {
    for (let i = 0; i < 99; i++) { timeline.count('open'); timeline.count('idle'); }
    for (let i = 0; i < 12; i++) { timeline.count('429'); timeline.count('failed'); timeline.count('drop'); }
    for (let i = 0; i < 9; i++) {
      timeline.count('1001'); timeline.count('other');
      timeline.count('cmdOk'); timeline.count('cmdFailed'); timeline.count('cmdLate');
    }
    timeline.ignition(true);
  });
  t.diagnostic(`1440 busy hours: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`);
  assert.ok(bytes < 128 * 1024, `${bytes} bytes`);
});

// --- nothing in it that identifies anyone -----------------------------------

/** Scriptable stand-in for a `ws` client. */
class ScriptedSocket {
  constructor() {
    this.readyState = WebSocket.CONNECTING;
    this.handlers = {};
  }

  on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }

  emit(event, ...args) { for (const fn of [...(this.handlers[event] || [])]) fn(...args); }

  removeAllListeners() { this.handlers = {}; }

  close() { this.readyState = WebSocket.CLOSED; }

  terminate() { this.readyState = WebSocket.CLOSED; }

  ping() { this.emit('pong'); }

  send(buffer, options, callback) { callback(null); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('no record carries a VIN, an e-mail address, a position or a token', async (t) => {
  useFakeClock(t);
  const VIN = 'W1K2938891F012345';
  const EMAIL = 'driver@example.com';
  const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.c2VjcmV0LXRva2Vu.c2lnbmF0dXJl';
  const LAT = 59.913868;
  const LON = 10.752245;

  const settings = fakeSettings();
  const timeline = new StatsTimeline(settings);
  timeline.load();

  // The real pipeline, fed everything a car and an account can put in front
  // of it: the WebSocket client counts into ConnectionStats, which forwards
  // to the timeline.
  const homey = { app: { log() {}, error() {} } };
  const oauth = { getAccessToken: async () => TOKEN, refreshToken: async () => {} };
  const ws = new MercedesWebSocket(homey, oauth, 'Europe', {}, null, {
    stats: new ConnectionStats({ sink: timeline }),
  });
  const sockets = [];
  ws._createSocket = () => { const s = new ScriptedSocket(); sockets.push(s); return s; };
  let next = null;
  ws.protoParser = {
    parsePushMessage: () => next,
    extractVehicleData: (update) => ({ ...update.data }),
    createAcknowledgeVepUpdatesByVin: () => Buffer.from('ack'),
    createAcknowledgeAppTwinCommandStatusUpdateByVin: () => Buffer.from('ack'),
  };
  ws.messageHandler = async () => {};
  ws.setCommandFailedHandler(() => {});

  try {
    const attempt = ws.connectOrThrow(ws.messageHandler);
    await flush();
    const sock = sockets[0];
    sock.readyState = WebSocket.OPEN;
    sock.emit('open');
    await attempt;

    next = {
      msg: 'vepUpdates',
      vepUpdates: {
        sequenceNumber: 1,
        updates: {
          [VIN]: {
            data: {
              vin: VIN, ignitionstate: 4, positionLat: LAT, positionLong: LON, username: EMAIL,
            },
          },
        },
      },
    };
    sock.emit('message', Buffer.from('frame'));
    await flush();

    const command = ws.sendCommand(Buffer.from('lock'), 'REQ1', 'lock', VIN);
    await flush();
    next = {
      msg: 'apptwinCommandStatusUpdatesByVin',
      apptwinCommandStatusUpdatesByVin: {
        sequenceNumber: 2,
        updatesByVin: { [VIN]: { updatesByPid: { 1: { requestId: 'REQ1', state: 7 } } } },
      },
    };
    sock.emit('message', Buffer.from('frame'));
    await command;
    next = {
      msg: 'apptwinCommandStatusUpdatesByVin',
      apptwinCommandStatusUpdatesByVin: {
        sequenceNumber: 3,
        updatesByVin: {
          [VIN]: { updatesByPid: { 1: { requestId: 'REQ1', state: 6, errors: [{ code: 'X', message: EMAIL }] } } },
        },
      },
    };
    sock.emit('message', Buffer.from('frame'));
    await flush();
  } finally {
    ws.disconnect();
  }

  timeline.flush();
  const served = JSON.stringify(timeline.toJSON());
  const stored = settings.raw('connectionTimeline');

  // Something was recorded, or the rest of this proves nothing.
  const { hours } = timeline.toJSON();
  assert.equal(sumOf(hours, 'h', 0), 1);
  assert.equal(sumOf(hours, 'k', 0), 1);
  assert.equal(sumOf(hours, 'k', 2), 1);
  assert.equal(hours[hours.length - 1].i, 1);

  for (const text of [stored, served]) {
    for (const secret of [VIN, EMAIL, TOKEN, String(LAT), String(LON), '59.91', '10.75']) {
      assert.equal(text.includes(secret), false, `"${secret}" must not be in it`);
    }
  }

  // And by construction: an hour and counters, nothing else.
  for (const record of [...settings.get('connectionTimeline').hours, settings.get('connectionTimeline').cur, ...hours]) {
    for (const [key, value] of Object.entries(record)) {
      assert.ok(['t', 'h', 'c', 'i', 'k'].includes(key), `unexpected key ${key}`);
      const values = Array.isArray(value) ? value : [value];
      assert.ok(values.every(Number.isInteger), `${key} holds only whole numbers`);
    }
  }
});

// --- wiring: app, API and manifest ------------------------------------------

function loadApp(settings) {
  const homeyPath = require.resolve('homey');
  require.cache[homeyPath] = {
    id: homeyPath, filename: homeyPath, loaded: true, exports: { App: class {} },
  };
  const MercedesMeApp = require('../app');
  const app = Object.create(MercedesMeApp.prototype);
  app.homey = { settings };
  app.log = () => {};
  app.error = () => {};
  return app;
}

test('the app writes once an hour and once more when it stops', async (t) => {
  useFakeClock(t);
  const settings = fakeSettings();
  const app = loadApp(settings);

  const timeline = app.getStatsTimeline();
  assert.equal(app.getStatsTimeline(), timeline, 'one timeline for the app');

  for (let i = 0; i < 50; i++) timeline.count('open');
  t.mock.timers.tick(HOUR - 1);
  assert.equal(settings.writes, 0);
  t.mock.timers.tick(1);
  assert.equal(settings.writes, 1);
  t.mock.timers.tick(2 * HOUR);
  assert.equal(settings.writes, 3);

  await app.onUninit();
  assert.equal(settings.writes, 4, 'the hour in progress is stored on the way out');
  t.mock.timers.tick(5 * HOUR);
  assert.equal(settings.writes, 4, 'and the timer stopped with the app');
});

test('GET /stats serves every hour kept, with a legend, from api.js', async (t) => {
  useFakeClock(t);
  const app = loadApp(fakeSettings());
  app.getStatsTimeline().count('open');

  const api = require('../api');
  const body = await api.getStats({ homey: { app } });

  assert.deepEqual(body.hours, [{ t: T0 / 1000, h: [1] }]);
  assert.ok(body.keys.h && body.keys.c && body.keys.k && body.keys.i && body.keys.t);
  app.onUninit();
});

test('GET /stats is not public: it needs a token for this Homey', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.homeycompose', 'app.json'), 'utf8'));
  assert.deepEqual(manifest.api.getStats, { method: 'GET', path: '/stats', public: false });

  const built = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  assert.deepEqual(built.api.getStats, manifest.api.getStats, 'and app.json is rebuilt with it');
});
