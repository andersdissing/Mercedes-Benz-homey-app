'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const MercedesWebSocket = require('../lib/websocket');

/**
 * Regression tests for the reconnect state machine (issue #47).
 *
 * The real failure: capabilities that only arrive over the WebSocket
 * (windows, doors, tire pressure, odometer) silently froze because the
 * connection died ~30s after init and never came back. These tests pin the
 * state machine so it can't regress into another silent dead-end.
 */

function makeWs() {
  const homey = {
    app: { log() {}, error() {} },
  };
  const oauth = { getAccessToken: async () => 'token', refreshToken: async () => {} };
  return new MercedesWebSocket(homey, oauth, 'Europe', {});
}

/** Fake socket standing in for a live `ws` instance. */
function fakeSocket(readyState = WebSocket.OPEN) {
  return {
    readyState,
    closed: false,
    listenersRemoved: false,
    close() { this.closed = true; },
    removeAllListeners() { this.listenersRemoved = true; },
    ping() {},
  };
}

test('ping interval stays below the connection watchdog timeout', () => {
  const ws = makeWs();

  // The ping is what produces the pong that proves liveness. If it fires
  // after the watchdog expires it can never prevent a teardown, which is
  // what made every idle connection die on a 30s timer.
  assert.ok(
    ws.PING_INTERVAL < ws.INITIAL_WATCHDOG_TIMEOUT,
    `PING_INTERVAL (${ws.PING_INTERVAL}) must be < INITIAL_WATCHDOG_TIMEOUT (${ws.INITIAL_WATCHDOG_TIMEOUT})`,
  );
  assert.ok(
    ws.PING_INTERVAL < ws.DEFAULT_WATCHDOG_TIMEOUT,
    `PING_INTERVAL (${ws.PING_INTERVAL}) must be < DEFAULT_WATCHDOG_TIMEOUT (${ws.DEFAULT_WATCHDOG_TIMEOUT})`,
  );
});

test('connection timeout schedules a reconnect instead of stopping for good', () => {
  const ws = makeWs();
  ws.ws = fakeSocket();
  ws.messageHandler = () => {};

  ws._handleConnectionTimeout();

  try {
    // The original bug: _handleConnectionTimeout() called disconnect(),
    // which set isStopping = true, so _scheduleReconnect() returned
    // immediately and the socket stayed dead forever.
    assert.equal(ws.isStopping, false, 'timeout recovery must not set isStopping');
    assert.ok(ws.reconnectTimer, 'a reconnect must actually be scheduled');
  } finally {
    if (ws.reconnectTimer) clearTimeout(ws.reconnectTimer);
    ws._stopWatchdogs();
  }
});

test('_teardownSocket releases the socket without blocking reconnects', () => {
  const ws = makeWs();
  const sock = fakeSocket();
  ws.ws = sock;

  ws._teardownSocket();

  assert.equal(ws.isStopping, false, 'teardown is a recovery path, not a stop');
  assert.equal(ws.ws, null, 'socket reference must be released');
  assert.equal(sock.closed, true, 'underlying socket must be closed');
  assert.equal(sock.listenersRemoved, true, 'abandoned socket must not keep driving events');
  assert.equal(ws.isConnecting, false);
  assert.equal(ws.connectionState, 'disconnected');
});

test('_teardownSocket rejects pending commands so callers do not hang', async () => {
  const ws = makeWs();
  ws.ws = fakeSocket();

  const pending = new Promise((resolve, reject) => {
    ws.pendingCommands.set('req-1', {
      resolve,
      reject,
      timeout: setTimeout(() => {}, 60000),
      commandType: 'doorsLock',
    });
  });

  ws._teardownSocket();

  await assert.rejects(pending, /command was pending/);
  assert.equal(ws.pendingCommands.size, 0, 'pending commands must be cleared');
});

test('a user-initiated disconnect still blocks reconnects', () => {
  const ws = makeWs();
  ws.ws = fakeSocket();

  ws.disconnect();
  ws._scheduleReconnect();

  // isStopping means "the user asked us to stop" - it must still win.
  assert.equal(ws.isStopping, true);
  assert.equal(ws.reconnectTimer, null, 'must not reconnect after an intentional disconnect');
});

test('_scheduleReconnect does not stack duplicate timers', () => {
  const ws = makeWs();
  ws.messageHandler = () => {};

  ws._scheduleReconnect();
  const first = ws.reconnectTimer;
  ws._scheduleReconnect();

  try {
    assert.equal(ws.reconnectTimer, first, 'second call must not replace the pending timer');
    assert.equal(ws.reconnectAttempts, 1, 'a suppressed call must not inflate backoff');
  } finally {
    if (ws.reconnectTimer) clearTimeout(ws.reconnectTimer);
  }
});

/**
 * Scriptable stand-in for the `ws` client, so tests can drive the real
 * open/error/close event sequence through _connectInternal().
 */
class ScriptedSocket {
  constructor() {
    this.readyState = WebSocket.CONNECTING;
    this.handlers = {};
    this.closed = false;
  }

  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) fn(...args);
  }

  removeAllListeners() { this.handlers = {}; }
  close() { this.closed = true; }
  ping() {}
}

/**
 * Connect `ws` using a scripted socket that comes up successfully.
 * The 'open' event has to fire *after* _connectInternal() attaches its
 * handlers, otherwise connect()'s promise never resolves.
 */
async function connectWithScriptedSocket(ws) {
  const sock = new ScriptedSocket();
  ws._createSocket = () => {
    setImmediate(() => {
      sock.readyState = WebSocket.OPEN;
      sock.emit('open');
    });
    return sock;
  };

  await ws.connect(() => {});
  return sock;
}

test('mid-session drop after an error still reconnects (close-handler path)', async () => {
  const ws = makeWs();

  // Socket came up successfully - connect()'s promise is now resolved, so
  // its catch block can never fire for anything that happens later.
  const sock = await connectWithScriptedSocket(ws);
  assert.equal(ws.connectionState, 'connected');
  assert.equal(ws.reconnectTimer, null, 'no reconnect should be pending while healthy');

  // Now the connection drops mid-session, with an error recorded first
  // (exactly how a real network drop arrives). This used to leave the
  // socket permanently dead: the close handler skipped _scheduleReconnect()
  // whenever _lastError was set.
  sock.emit('error', new Error('socket hang up'));
  sock.emit('close', 1006, Buffer.from(''));

  try {
    assert.ok(ws._lastError, 'precondition: the error was recorded');
    assert.ok(ws.reconnectTimer, 'a reconnect must be scheduled after a mid-session drop');
  } finally {
    if (ws.reconnectTimer) clearTimeout(ws.reconnectTimer);
    ws._stopWatchdogs();
  }
});

test('a clean mid-session close also reconnects', async () => {
  const ws = makeWs();

  const sock = await connectWithScriptedSocket(ws);
  sock.emit('close', 1000, Buffer.from(''));

  try {
    assert.ok(ws.reconnectTimer, 'reconnect must be scheduled even on a clean close');
  } finally {
    if (ws.reconnectTimer) clearTimeout(ws.reconnectTimer);
    ws._stopWatchdogs();
  }
});

test('an intentional disconnect prevents the close handler from reconnecting', async () => {
  const ws = makeWs();

  const sock = await connectWithScriptedSocket(ws);

  ws.disconnect();      // user-initiated stop
  sock.emit('close', 1000, Buffer.from(''));

  assert.equal(ws.reconnectTimer, null, 'must stay down after an intentional disconnect');
});
