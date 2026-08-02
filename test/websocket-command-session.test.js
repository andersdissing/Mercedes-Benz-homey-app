'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const MercedesWebSocket = require('../lib/websocket');

/**
 * Regression tests for the command session path (issue #57, sub-issue #56).
 *
 * The real failure: sending any vehicle command recycled the shared socket
 * through disconnect() - the "user asked us to stop" path - which abandons
 * the old socket with its listeners still attached. That socket's late
 * 'close' event then fired against the *new* socket: it stopped the live
 * watchdogs (no keepalive ping, no liveness detection) and scheduled a
 * spurious reconnect. The connection degraded into a zombie that still
 * reported readyState OPEN while receiving nothing, so push capabilities
 * froze and the next command failed with "WebSocket connection not
 * available for command" until the app was restarted.
 */

function makeWs() {
  const homey = { app: { log() {}, error() {} } };
  const oauth = { getAccessToken: async () => 'token', refreshToken: async () => {} };
  return new MercedesWebSocket(homey, oauth, 'Europe', {});
}

/** Scriptable stand-in for a `ws` client. */
class ScriptedSocket {
  constructor() {
    this.readyState = WebSocket.CONNECTING;
    this.handlers = {};
    this.closed = false;
    this.listenersRemoved = false;
    this.pings = 0;
    this.sent = [];
    this.sendError = null;
  }

  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of [...(this.handlers[event] || [])]) fn(...args);
  }

  hasListeners() {
    return Object.values(this.handlers).some((fns) => fns.length > 0);
  }

  removeAllListeners() {
    this.handlers = {};
    this.listenersRemoved = true;
  }

  close() {
    this.closed = true;
  }

  ping() {
    this.pings += 1;
  }

  send(buffer, options, callback) {
    if (this.sendError) {
      callback(this.sendError);
      return;
    }
    this.sent.push(buffer);
    callback(null);
  }
}

/**
 * Install a socket factory that hands out `sockets` in order and opens each
 * one on the next tick (the 'open' event has to land after
 * _connectInternal() attaches its handlers).
 */
function scriptSockets(ws, count) {
  const sockets = [];

  ws._createSocket = () => {
    const sock = new ScriptedSocket();
    sockets.push(sock);
    setImmediate(() => {
      if (sock.listenersRemoved) return;
      sock.readyState = WebSocket.OPEN;
      sock.emit('open');
    });
    return sock;
  };

  assert.ok(count === undefined || count > 0);
  return sockets;
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for: ${message}`);
}

/**
 * Release every timer a test may have left running.
 *
 * Use the real shutdown path rather than clearing timers by hand: it also
 * releases the socket, so a command still queued behind the chain fails
 * immediately instead of sending on a fake socket that still claims to be
 * OPEN and arming a 90-second completion timer that outlives the test.
 */
function cleanup(ws) {
  ws.disconnect();
}

test('a command goes over the existing session instead of opening a new one', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths
  const pushSocket = sockets[0];
  const sessionId = ws.sessionId;
  assert.equal(ws.ws, pushSocket);

  const command = ws.sendCommand(Buffer.from('command'), 'req-1');
  command.catch(() => {});

  await waitFor(() => ws.pendingCommands.has('req-1'), 'the command was sent and is being tracked');

  try {
    // mbapi2020 sends car commands on the long-lived connection with one
    // session ID. Handshaking a fresh session per command is what got
    // accounts rate-limited (HTTP 429) - and left the app with no
    // connection at all when that handshake was refused.
    assert.equal(sockets.length, 1, 'a command must not open a second socket');
    assert.equal(ws.ws, pushSocket, 'the live socket must be reused');
    assert.equal(pushSocket.closed, false, 'the live socket must not be torn down');
    assert.equal(pushSocket.listenersRemoved, false);
    assert.equal(ws.sessionId, sessionId, 'the session ID must not be rotated per command');
    assert.deepEqual(pushSocket.sent, [Buffer.from('command')]);

    assert.ok(ws.pingWatchdog, 'the live socket must keep its keepalive ping');
    assert.ok(ws.connectionWatchdog, 'the live socket must keep its liveness watchdog');
    assert.equal(ws.reconnectTimer, null, 'no reconnect may be scheduled for a healthy session');
    assert.equal(ws.isStopping, false, 'sending a command is not a shutdown');
  } finally {
    cleanup(ws);
  }
});

test('the liveness watchdog is relaxed while a command is in flight', async () => {
  const ws = makeWs();
  scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths

  const command = ws.sendCommand(Buffer.from('command'), 'req-1');
  command.catch(() => {});
  await waitFor(() => ws.pendingCommands.has('req-1'), 'the command is in flight');

  try {
    // A command can take ~60s with no vehicle push in between. Tearing the
    // socket down on the normal idle timeout would abort it for no reason.
    assert.ok(
      ws.COMMAND_WATCHDOG_TIMEOUT > ws.INITIAL_WATCHDOG_TIMEOUT,
      'the command watchdog must be the longer of the two',
    );
    assert.equal(
      ws.connectionWatchdog._idleTimeout,
      ws.COMMAND_WATCHDOG_TIMEOUT,
      'a pending command must extend the connection watchdog',
    );
  } finally {
    cleanup(ws);
  }
});

test('a command does not handshake through a 429 backoff', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  // Rate-limited, and no usable socket - exactly the state a 429 leaves
  // behind. Retrying here is what keeps the block alive.
  ws.accountBlocked = true;
  ws.blockedSinceTime = Date.now();

  await assert.rejects(
    ws.sendCommand(Buffer.from('command'), 'req-1'),
    /rate-limiting this account \(HTTP 429\)/,
  );

  try {
    assert.equal(sockets.length, 0, 'no handshake may be attempted while blocked');
    assert.equal(ws.pendingCommands.size, 0);
  } finally {
    cleanup(ws);
  }
});

test('a command still works on a live socket while rate-limited', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths

  // The block applies to opening connections, not to the one already open -
  // reusing it needs no handshake, so the command must go through.
  ws.accountBlocked = true;
  ws.blockedSinceTime = Date.now();

  const command = ws.sendCommand(Buffer.from('command'), 'req-1');
  command.catch(() => {});

  await waitFor(() => ws.pendingCommands.has('req-1'), 'the command was sent on the live session');

  try {
    assert.deepEqual(sockets[0].sent, [Buffer.from('command')]);
  } finally {
    cleanup(ws);
  }
});

test('the 429 backoff survives the client being replaced', () => {
  const blocked = makeWs();
  blocked.accountBlocked = true;
  blocked.blockedSinceTime = Date.now();

  const state = blocked.getRateLimitState();
  assert.ok(state && state.blockedUntil > Date.now(), 'a blocked client must export its window');

  // The device health check builds a brand-new client every 5 minutes. If
  // that client started clean it would handshake straight through a
  // 10-minute block and keep renewing it.
  const replacement = makeWs();
  replacement.restoreRateLimitState(state);

  assert.ok(replacement.getRateLimitRemaining() > 0, 'the replacement must inherit the block');

  // An expired window must not be inherited.
  const afterExpiry = makeWs();
  afterExpiry.restoreRateLimitState({ blockedUntil: Date.now() - 1000 });
  assert.equal(afterExpiry.getRateLimitRemaining(), 0);
  assert.equal(afterExpiry.accountBlocked, false);
});

test('the 429 backoff window expires on its own', () => {
  const ws = makeWs();
  ws.accountBlocked = true;
  ws.blockedSinceTime = Date.now() - (ws.RATE_LIMIT_BACKOFF + 1000);

  // Otherwise a single 429 pins every later reconnect to the maximum delay
  // until some connection happens to succeed.
  assert.equal(ws.getRateLimitRemaining(), 0);
  assert.equal(ws.accountBlocked, false, 'the flag must clear once the window passes');
});

test('a 429 schedules a bounded re-authentication', async () => {
  const ws = makeWs();
  let attempts = 0;

  ws._createSocket = () => {
    const sock = new ScriptedSocket();
    setImmediate(() => {
      sock.emit('error', new Error('Unexpected server response: 429'));
      sock.emit('close', 1006, Buffer.from(''));
    });
    return sock;
  };

  try {
    for (let i = 0; i < ws.MAX_TOKEN_REFRESH_ATTEMPTS + 2; i++) {
      await assert.rejects(ws.connectOrThrow(() => {}), /429/);
      if (ws._needsTokenRefresh) attempts++;
      ws._needsTokenRefresh = false; // connectOrThrow would consume it
    }

    // A 429 on the upgrade is often a rejected token, so re-authenticating
    // helps - but a genuinely blocked account must not become a refresh loop.
    assert.equal(attempts, ws.MAX_TOKEN_REFRESH_ATTEMPTS);
  } finally {
    cleanup(ws);
  }
});

test('a superseded socket cannot stop the watchdogs or schedule a reconnect', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths
  const first = sockets[0];

  // Whatever the reason a socket stops being current, its late events must
  // be inert - the handlers belong to a connection that no longer exists.
  const replacement = new ScriptedSocket();
  replacement.readyState = WebSocket.OPEN;
  ws.ws = replacement;

  first.emit('close', 1006, Buffer.from(''));

  try {
    assert.equal(ws.ws, replacement, 'the current socket must not be dropped');
    assert.ok(ws.pingWatchdog, 'watchdogs belong to the current socket');
    assert.equal(ws.reconnectTimer, null, 'a superseded socket must not drive reconnects');
    assert.equal(ws.connectionState, 'connected');
  } finally {
    cleanup(ws);
  }
});

test('disconnect() releases the socket and clears isConnecting', () => {
  const ws = makeWs();
  const sock = new ScriptedSocket();
  sock.readyState = WebSocket.OPEN;
  ws.ws = sock;
  ws.isConnecting = true; // a connect that was in flight when we stopped

  ws.disconnect();

  // A stale isConnecting flag used to make every later connect() a silent
  // no-op, which is how the client ended up permanently offline.
  assert.equal(ws.isConnecting, false, 'disconnect must not leave a connect flag set');
  assert.equal(sock.listenersRemoved, true, 'an abandoned socket must lose its listeners');
  assert.equal(sock.closed, true);
  assert.equal(ws.ws, null);
  assert.equal(ws.isStopping, true, 'disconnect is still a genuine stop');
});

test('concurrent connects share one attempt instead of stranding a caller', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  const [a, b] = await Promise.all([
    ws.connectOrThrow(() => {}),
    ws.connectOrThrow(() => {}),
  ]).then((results) => results, (error) => assert.fail(`neither caller may be stranded: ${error.message}`));

  try {
    assert.equal(sockets.length, 1, 'only one socket may be opened');
    assert.equal(ws.connectionState, 'connected');
    assert.equal(a, b);
    assert.equal(ws.isConnecting, false);
    assert.equal(ws._connectPromise, null);
  } finally {
    cleanup(ws);
  }
});

test('a failed connect leaves no latched state behind', async () => {
  const ws = makeWs();

  ws._createSocket = () => {
    const sock = new ScriptedSocket();
    setImmediate(() => {
      sock.emit('error', new Error('Unexpected server response: 401'));
      sock.emit('close', 1006, Buffer.from(''));
    });
    return sock;
  };

  await assert.rejects(ws.connectOrThrow(() => {}), /401/);

  try {
    assert.equal(ws.isConnecting, false, 'a failed attempt must not latch isConnecting');
    assert.equal(ws._connectPromise, null, 'a failed attempt must not latch the shared promise');
  } finally {
    cleanup(ws);
  }
});

test('a command that cannot connect reports why', async () => {
  const ws = makeWs();

  ws._createSocket = () => {
    const sock = new ScriptedSocket();
    setImmediate(() => {
      sock.emit('error', new Error('Unexpected server response: 401'));
      sock.emit('close', 1006, Buffer.from(''));
    });
    return sock;
  };

  // The flow card shows this message to the user, so "not available" on its
  // own is useless - the reason has to survive.
  await assert.rejects(
    ws.sendCommand(Buffer.from('command'), 'req-1'),
    /WebSocket connection not available for command: .*401/,
  );

  try {
    assert.equal(ws.pendingCommands.size, 0, 'a failed command must not leave tracking behind');
    assert.ok(ws.reconnectTimer, 'the push connection must still be scheduled to come back');
  } finally {
    cleanup(ws);
  }
});

test('a send failure does not leak a pending command', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths

  sockets[0].sendError = new Error('send failed');

  await assert.rejects(ws.sendCommand(Buffer.from('command'), 'req-1'), /send failed/);

  try {
    assert.equal(ws.pendingCommands.size, 0, 'no pending command may outlive a failed send');
  } finally {
    cleanup(ws);
  }
});

test('commands do not overlap and clobber each other\'s session', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths

  const first = ws.sendCommand(Buffer.from('first'), 'req-1');
  const second = ws.sendCommand(Buffer.from('second'), 'req-2');
  first.catch(() => {});
  second.catch(() => {});

  await waitFor(() => ws.pendingCommands.has('req-1'), 'the first command is in flight');

  try {
    // The second command waits for the first to settle rather than
    // interleaving with it.
    assert.deepEqual(sockets[0].sent, [Buffer.from('first')], 'the second command must not be sent yet');
    assert.equal(ws.pendingCommands.has('req-2'), false);
  } finally {
    cleanup(ws);
  }
});

test('an open socket that has gone silent is not considered healthy', async () => {
  const ws = makeWs();
  scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths

  try {
    assert.equal(ws.isHealthy(), true, 'a fresh connection is healthy');

    // A dropped TCP path with no close frame leaves readyState OPEN
    // forever. Only the absence of traffic reveals it.
    ws.lastMessageAt = Date.now() - (ws.STALE_TIMEOUT + 1000);

    assert.equal(ws.isConnected(), true, 'precondition: the zombie still reports OPEN');
    assert.equal(ws.isHealthy(), false, 'a socket with no traffic must be treated as dead');
    assert.ok(ws.getIdleTime() > ws.STALE_TIMEOUT);
  } finally {
    cleanup(ws);
  }
});

test('a healthy but idle connection is not mistaken for a zombie', async () => {
  const ws = makeWs();
  const sockets = scriptSockets(ws);

  await ws.connect(() => {}); // plain connect: identical setup on both code paths

  try {
    // A parked car pushes no telemetry, but the keepalive pong still proves
    // the connection is alive - that must count as traffic.
    ws.lastMessageAt = Date.now() - (ws.STALE_TIMEOUT + 1000);
    sockets[0].emit('pong');

    assert.equal(ws.isHealthy(), true, 'a pong must refresh liveness');
  } finally {
    cleanup(ws);
  }
});
