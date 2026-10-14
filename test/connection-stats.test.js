'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const ConnectionStats = require('../lib/connection-stats');
const MercedesWebSocket = require('../lib/websocket');
const MercedesAPI = require('../lib/api');

/**
 * The hourly connection tally: one line that makes two builds comparable on
 * the numbers that matter to a rate limiter - handshakes, refusals, and why
 * connections ended.
 */

/** Minimal scriptable stand-in for a `ws` client. */
class ScriptedSocket {
  constructor() {
    this.readyState = WebSocket.CONNECTING;
    this.handlers = {};
  }

  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of [...(this.handlers[event] || [])]) fn(...args);
  }

  removeAllListeners() { this.handlers = {}; }

  close() { this.readyState = WebSocket.CLOSED; }

  terminate() { this.readyState = WebSocket.CLOSED; }

  ping() {}
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeWs(stats) {
  const homey = { app: { log() {}, error() {} } };
  const oauth = { getAccessToken: async () => 'token', refreshToken: async () => {} };
  const ws = new MercedesWebSocket(homey, oauth, 'Europe', {}, null, { stats });
  const sockets = [];
  ws._createSocket = () => {
    const sock = new ScriptedSocket();
    sockets.push(sock);
    return sock;
  };
  return { ws, sockets };
}

/** Run one connect attempt and let the scripted socket open. */
async function connectAndOpen(ws, sockets) {
  const attempt = ws.connectOrThrow(() => {});
  await flush();
  const sock = sockets[sockets.length - 1];
  sock.readyState = WebSocket.OPEN;
  sock.emit('open');
  await attempt;
  return sock;
}

test('the summary line counts handshakes and closes, then starts over', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const stats = new ConnectionStats();

  stats.noteHandshake();
  stats.noteHandshake();
  stats.noteHandshake();
  stats.noteOpened();
  stats.noteRateLimited();
  stats.noteFailed();
  stats.noteClose('idle');
  stats.noteClose('1001');
  stats.noteClose('drop');
  stats.noteClose('something-new');

  t.mock.timers.tick(3600000);

  assert.equal(
    stats.takeLine(),
    '[WS] Connection stats for the last 60 min: handshakes=3 (open=1, 429=1, failed=1), '
      + 'closes: idle=1, 1001=1, drop=1, other=1',
  );
  assert.equal(
    stats.describe(),
    '[WS] Connection stats for the last 0 min: handshakes=0 (open=0, 429=0, failed=0), '
      + 'closes: idle=0, 1001=0, drop=0, other=0',
    'taking the line starts a fresh period',
  );
});

test('the WebSocket client counts an opened handshake and a 1001 rotation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const stats = new ConnectionStats();
  const { ws, sockets } = makeWs(stats);

  try {
    const sock = await connectAndOpen(ws, sockets);
    assert.equal(stats.handshakes, 1);
    assert.equal(stats.opened, 1);

    sock.readyState = WebSocket.CLOSED;
    sock.emit('close', 1001, Buffer.from('rotation'));
    assert.equal(stats.closes[1001], 1);
    assert.equal(stats.closes.drop, 0);
  } finally {
    ws.disconnect();
  }
});

test('an abnormal close and a dead socket both count as drops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const stats = new ConnectionStats();
  const { ws, sockets } = makeWs(stats);

  try {
    const first = await connectAndOpen(ws, sockets);
    first.readyState = WebSocket.CLOSED;
    first.emit('close', 1006, Buffer.alloc(0));
    assert.equal(stats.closes.drop, 1, '1006 is a lost connection');

    if (ws.reconnectTimer) clearTimeout(ws.reconnectTimer);
    ws.reconnectTimer = null;

    // The liveness watchdog tears a silent socket down without its 'close'
    // ever reaching the handler, so it has to be counted on its own.
    await connectAndOpen(ws, sockets);
    t.mock.timers.tick(ws.INITIAL_WATCHDOG_TIMEOUT);
    assert.equal(stats.closes.drop, 2, 'a socket the watchdog gave up on is a drop too');
    assert.equal(stats.handshakes, 2);
  } finally {
    ws.disconnect();
  }
});

test('a 429 on the upgrade is counted as a refusal, not as a failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const stats = new ConnectionStats();
  const { ws, sockets } = makeWs(stats);

  try {
    const attempt = ws.connectOrThrow(() => {});
    await flush();
    sockets[0].emit('unexpected-response', {}, { statusCode: 429, headers: {}, resume() {} });
    sockets[0].emit('error', new Error('socket hang up'));
    await assert.rejects(attempt, /429/);

    assert.equal(stats.handshakes, 1);
    assert.equal(stats.rateLimited, 1);
    assert.equal(stats.failed, 0, 'the teardown error after a 429 is not a second failure');
    assert.equal(stats.opened, 0);
  } finally {
    ws.disconnect();
  }
});

test('the API logs one summary line an hour and stops when disconnected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });

  const lines = [];
  const homey = { app: { log(line) { lines.push(String(line)); }, error() {} } };
  const oauth = { endpoints: { rest: 'https://rest.invalid', widget: 'https://widget.invalid' } };
  const api = new MercedesAPI(homey, oauth, 'Europe');
  api.protoParserInitialized = true;

  // Healthy, so connectWebSocket() returns early: only the timer is under test.
  api.websocket = { isHealthy: () => true, disconnect() {} };

  await api.connectWebSocket(() => {});
  api.connectionStats.noteHandshake();

  t.mock.timers.tick(api.STATS_INTERVAL - 1);
  assert.equal(lines.filter((l) => l.includes('Connection stats')).length, 0);

  t.mock.timers.tick(1);
  const stats = lines.filter((l) => l.includes('Connection stats'));
  assert.equal(stats.length, 1);
  assert.match(stats[0], /last 60 min: handshakes=1 /);

  // A second connect must not start a second timer.
  await api.connectWebSocket(() => {});
  t.mock.timers.tick(api.STATS_INTERVAL);
  assert.equal(lines.filter((l) => l.includes('Connection stats')).length, 2);

  await api.disconnectWebSocket();
  t.mock.timers.tick(api.STATS_INTERVAL * 3);
  assert.equal(lines.filter((l) => l.includes('Connection stats')).length, 2, 'no lines after disconnect');
});
