'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const MercedesWebSocket = require('../lib/websocket');

/**
 * The refused upgrade, read properly for the first time (issue #71).
 *
 * `ws` hands the raw handshake response to a listener - and only to a
 * listener. The catch is that `emit()` returning true is exactly what makes
 * `ws` skip its own abortHandshake(), so registering one means the request is
 * never destroyed and the failure is never reported. Added naively that is a
 * hang: the connect promise never settles, `_connectPromise` stays set, and
 * every later connect awaits a dead promise - the dead-end class of #47 and
 * #57.
 *
 * These run against a real `ws` client and a real HTTP server on loopback,
 * because the contract being tested is `ws`'s, not ours. Each test has a
 * timeout: a regression here shows up as a hang, and a hanging suite says
 * nothing about which promise was left unsettled.
 */

/**
 * An HTTP server that refuses the upgrade the way Mercedes does - a raw status
 * line written to the socket, not a WebSocket handshake. Node destroys an
 * upgrade request outright unless the server listens for it, so the refusal
 * has to be written by hand.
 */
function refusingServer(statusLine, headers = {}) {
  const server = http.createServer();

  server.on('upgrade', (req, socket) => {
    const lines = [`HTTP/1.1 ${statusLine}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    lines.push('Content-Length: 0', 'Connection: close', '', '');
    socket.write(lines.join('\r\n'));
    socket.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function makeWs(port) {
  const homey = { app: { log() {}, error() {} } };
  const oauth = { getAccessToken: async () => 'token', refreshToken: async () => {} };
  const ws = new MercedesWebSocket(homey, oauth, 'Europe', {});

  // Real `ws`, real handshake, local server. The app's HTTPS agent carries a
  // TLS cipher order that only means anything to Mercedes.
  ws._createSocket = (url, options) => new WebSocket(
    `ws://127.0.0.1:${port}`,
    { ...options, agent: null },
  );

  return ws;
}

/** Wait for `ws` to finish tearing the refused socket down. */
async function settleClose(ws) {
  for (let i = 0; i < 100; i++) {
    if (ws.ws && ws.ws.readyState === WebSocket.CLOSED) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('a refused upgrade fails the connect attempt instead of hanging', { timeout: 15000 }, async () => {
  const server = await refusingServer('429 Too Many Requests', { 'Retry-After': '17' });
  const ws = makeWs(server.port);

  try {
    await assert.rejects(
      ws.connectOrThrow(() => {}),
      /429/,
      'taking over the teardown means taking over the reporting too',
    );

    assert.equal(ws._connectPromise, null, 'a promise left in place blocks every later connect');
    assert.equal(ws.isConnecting, false);

    assert.ok(
      await settleClose(ws),
      'the request must actually be destroyed - `ws` will not do it once we listen',
    );
  } finally {
    ws.disconnect();
    await server.close();
  }
});

test('Retry-After on the refused upgrade replaces the guessed window', { timeout: 15000 }, async () => {
  const server = await refusingServer('429 Too Many Requests', { 'Retry-After': '17' });
  const ws = makeWs(server.port);

  try {
    await ws.connectOrThrow(() => {}).catch(() => {});

    assert.equal(ws.lastHandshakeRejection.status, 429);
    assert.equal(
      ws.lastHandshakeRejection.retryAfterMs,
      17000,
      'the only thing ever kept from a 429 was the status code, scraped out of a message string',
    );

    const remaining = ws.getRateLimitRemaining();
    assert.ok(
      remaining > 12000 && remaining <= 17000,
      `window (${remaining} ms) must be the 17s Mercedes asked for, not the app's 30s guess`,
    );

    assert.equal(
      ws._lastError.httpStatus,
      429,
      'the teardown reports itself as "socket hang up"; letting that overwrite the real reason '
      + 'is how a rate limit would be logged - and reported to a flow - as a transport blip',
    );
  } finally {
    ws.disconnect();
    await server.close();
  }
});

test('a 429 with no Retry-After still gets the app\'s own backoff', { timeout: 15000 }, async () => {
  const server = await refusingServer('429 Too Many Requests');
  const ws = makeWs(server.port);

  try {
    await ws.connectOrThrow(() => {}).catch(() => {});

    assert.equal(ws.lastHandshakeRejection.retryAfterMs, null, 'nothing to honour');

    const remaining = ws.getRateLimitRemaining();
    assert.ok(
      remaining > 25000 && remaining <= ws.RATE_LIMIT_BACKOFF,
      `window (${remaining} ms) must be the app's own first step - the ladder is still the `
      + 'answer when the server does not give one',
    );
  } finally {
    ws.disconnect();
    await server.close();
  }
});

test('a refusal that is not a rate limit is unaffected', { timeout: 15000 }, async () => {
  const server = await refusingServer('401 Unauthorized');
  const ws = makeWs(server.port);

  try {
    await assert.rejects(ws.connectOrThrow(() => {}), /401/);

    assert.equal(ws.getRateLimitRemaining(), 0, 'only a 429 opens a backoff window');
    assert.equal(ws._needsTokenRefresh, true, 'and 401 must still drive re-authentication');
  } finally {
    ws.disconnect();
    await server.close();
  }
});

/**
 * A failed upgrade is not a closed connection.
 *
 * ws reports every failed upgrade as 'error' and then 'close' 1006, on a
 * socket that never opened, and the close lands before connect() reaches its
 * catch. Read as the close of an open connection, that put each refusal on
 * the idle cycle's flat 60s retry, counted it as a drop and called it resting
 * - and the failure backoff and the 429 ladder's 30s first step never ran.
 * Scripted sockets got the order wrong and hid it, so these use real ones.
 */
function makeLoggingWs(port) {
  const ws = makeWs(port);
  ws.logs = [];
  ws.homey = {
    app: {
      log: (...args) => ws.logs.push(args.join(' ')),
      error: (...args) => ws.logs.push(args.join(' ')),
    },
  };
  return ws;
}

/** A port on loopback with nothing listening, so a connect is refused. */
function closedPort() {
  const server = http.createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Let ws deliver the 'close' 1006 that follows a failed upgrade. */
async function closeDelivered(ws) {
  for (let i = 0; i < 100; i++) {
    if (ws.logs.some((l) => l.includes('Abnormal closure (1006)'))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('ws never reported the close that follows a failed upgrade');
}

test('a real 429 goes on the ladder\'s 30s first step, not the idle cycle', { timeout: 15000 }, async () => {
  const server = await refusingServer('429 Too Many Requests');
  const ws = makeLoggingWs(server.port);

  try {
    await ws.connect(() => {});
    await closeDelivered(ws);

    // What is left of the 30s window when the retry is planned - a real clock
    // has moved on a millisecond or two by then.
    const planned = ws.logs.map((l) => l.match(/Scheduling reconnect attempt 1 in ([\d.]+)s/)).find(Boolean);
    assert.ok(planned, ws.logs.join('\n'));
    const seconds = Number(planned[1]);
    assert.ok(seconds > 25 && seconds <= 30, `the ladder's first step, not ${seconds}s`);
    assert.equal(ws.logs.some((l) => l.includes('next connection in')), false, 'not the 60s cycle');
    assert.equal(ws.reconnectAttempts, 1, 'a failed attempt, counted as one');
    assert.equal(ws.isResting(), false, 'a retry after a refusal is not the cycle resting');
    assert.equal(ws.stats.rateLimited, 1);
    assert.equal(ws.stats.closes.drop, 0, 'a refused upgrade is not a lost connection');
  } finally {
    ws.disconnect();
    await server.close();
  }
});

test('a real refused connection goes on the 10s failure backoff, not the idle cycle', { timeout: 15000 }, async () => {
  const ws = makeLoggingWs(await closedPort());

  try {
    await ws.connect(() => {});
    await closeDelivered(ws);

    assert.ok(ws.logs.some((l) => l.includes('ECONNREFUSED')), ws.logs.join('\n'));
    assert.ok(ws.logs.some((l) => l.includes('Scheduling reconnect attempt 1 in 10s')), ws.logs.join('\n'));
    assert.equal(ws.logs.some((l) => l.includes('next connection in')), false, 'not the 60s cycle');
    assert.equal(ws.isResting(), false);
    assert.equal(ws.stats.failed, 1);
    assert.equal(ws.stats.closes.drop, 0);
  } finally {
    ws.disconnect();
  }
});
