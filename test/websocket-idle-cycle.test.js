'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const MercedesWebSocket = require('../lib/websocket');
const MercedesAPI = require('../lib/api');

/**
 * The idle cycle: close the push connection once the car has nothing to say,
 * the way mbapi2020 does, instead of holding it open around the clock.
 *
 * Every test runs on a fake clock - the behaviour under test is made of
 * 30-second, 60-second and 5-minute timers, and waiting them out for real
 * would make the suite take as long as a parked car.
 */

/** Scriptable stand-in for a `ws` client that answers pings like a live one. */
class ScriptedSocket {
  constructor() {
    this.readyState = WebSocket.CONNECTING;
    this.handlers = {};
    this.closedWith = null;
    this.pings = 0;
    this.sent = [];
    this.answerPings = true;
  }

  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of [...(this.handlers[event] || [])]) fn(...args);
  }

  removeAllListeners() { this.handlers = {}; }

  close(code, reason) {
    this.closedWith = { code, reason };
    this.readyState = WebSocket.CLOSED;
  }

  terminate() { this.readyState = WebSocket.CLOSED; }

  ping() {
    this.pings++;
    if (this.answerPings) this.emit('pong');
  }

  send(buffer, options, callback) {
    this.sent.push(buffer);
    callback(null);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** isConnected() answers null rather than false once the socket is gone. */
const isOpen = (ws) => Boolean(ws.isConnected());

function makeWs({ ignitionStates } = {}) {
  const logs = [];
  const homey = {
    app: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
    },
  };
  const oauth = { getAccessToken: async () => 'token', refreshToken: async () => {} };
  const ws = new MercedesWebSocket(homey, oauth, 'Europe', {}, null, { ignitionStates });

  const sockets = [];
  ws._createSocket = () => {
    const sock = new ScriptedSocket();
    sockets.push(sock);
    return sock;
  };

  // Each pushed frame decodes to whatever the test queued for it.
  let next = null;
  ws.protoParser = {
    parsePushMessage: () => next,
    extractVehicleData: (update) => ({ ...update.data }),
    createAcknowledgeVepUpdatesByVin: () => Buffer.from('ack'),
    createAcknowledgeAppTwinCommandStatusUpdateByVin: () => Buffer.from('ack'),
  };
  ws.messageHandler = async () => {};

  const push = async (sock, message) => {
    next = message;
    sock.emit('message', Buffer.from('frame'));
    await flush();
  };

  return { ws, sockets, logs, push };
}

/** A vepUpdates frame carrying `data` for one car. */
function vep(data, vin = 'VIN1') {
  return {
    msg: 'vepUpdates',
    vepUpdates: { sequenceNumber: 1, updates: { [vin]: { fullUpdate: false, data } } },
  };
}

/** Run one connect attempt and let the scripted socket open. */
async function connectAndOpen(ws, sockets) {
  const attempt = ws.connectOrThrow(ws.messageHandler);
  await flush();
  const sock = sockets[sockets.length - 1];
  sock.readyState = WebSocket.OPEN;
  sock.emit('open');
  await attempt;
  return sock;
}

/** Forget the reconnect a close scheduled, so the test drives the next one. */
function cancelReconnect(ws) {
  if (ws.reconnectTimer) clearTimeout(ws.reconnectTimer);
  ws.reconnectTimer = null;
}

function useFakeClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
}

// --- Step 1: close after 30s without data ---------------------------------

test('an idle connection is closed 30s after it opened', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);

    t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT - 1);
    assert.equal(isOpen(ws), true, 'not a moment early');

    t.mock.timers.tick(1);
    assert.equal(isOpen(ws), false);
    assert.deepEqual(sock.closedWith, { code: 1000, reason: 'Idle' }, 'a normal close, not an abort');
    assert.equal(ws.connectionState, 'idle');
    assert.equal(ws.stats.closes.idle, 1);
    assert.equal(ws.isStopping, false, 'an idle close is not a shutdown');
  } finally {
    ws.disconnect();
  }
});

test('data from the car restarts the 30s', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);

    t.mock.timers.tick(20000);
    await push(sock, vep({ soc: 80 }));

    t.mock.timers.tick(20000);
    assert.equal(isOpen(ws), true, '20s after the last data is not idle yet');

    t.mock.timers.tick(10000);
    assert.equal(isOpen(ws), false, '30s after the last data is');
  } finally {
    ws.disconnect();
  }
});

test('a pong is not data: it does not keep an idle connection open', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);

    t.mock.timers.tick(20000);
    sock.emit('pong');
    t.mock.timers.tick(10000);

    assert.equal(isOpen(ws), false);
  } finally {
    ws.disconnect();
  }
});

test('an idle connection is closed before it is ever pinged', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT);

    // mbapi2020's 32s ping lands after its 30s idle close. A 20s ping sent
    // one pointless frame per cycle on every parked car.
    assert.equal(ws.PING_INTERVAL, 32000);
    assert.equal(sock.pings, 0);
  } finally {
    ws.disconnect();
  }
});

test('ignitionstate 4 holds the connection open, and its end lets it close', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push, logs } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    await push(sock, vep({ ignitionstate: 4 }));

    // Ten minutes parked at the lights with nothing new to say. The ping and
    // its pong keep the liveness watchdog satisfied meanwhile.
    for (let i = 0; i < 20; i++) t.mock.timers.tick(30000);
    assert.equal(isOpen(ws), true, 'the ignition is on');
    assert.ok(sock.pings > 0, 'liveness is still proven while held open');
    assert.equal(
      logs.filter((l) => l.includes('keeping the connection open')).length,
      1,
      'said once, not every 30s for the length of a drive',
    );

    await push(sock, vep({ ignitionstate: 0 }));
    t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT);
    assert.equal(isOpen(ws), false, 'ignition off, so idle closes again');
  } finally {
    ws.disconnect();
  }
});

test('ignitionstate 1 and 2 do not hold the connection open (mbapi2020: 4 only)', async (t) => {
  useFakeClock(t);

  for (const state of [1, 2]) {
    const { ws, sockets, push } = makeWs();
    try {
      const sock = await connectAndOpen(ws, sockets);
      await push(sock, vep({ ignitionstate: state }));
      t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT);
      assert.equal(isOpen(ws), false, `ignitionstate ${state} must not hold it open`);
    } finally {
      ws.disconnect();
    }
  }
});

test('any car on the account with the ignition on holds the shared connection', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    await push(sock, vep({ ignitionstate: 4 }, 'VIN2'));
    await push(sock, vep({ ignitionstate: 0 }, 'VIN1'));

    t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT * 3);
    assert.equal(isOpen(ws), true);
  } finally {
    ws.disconnect();
  }
});

test('the ignition state outlives the client, so a rebuilt one still holds open', async (t) => {
  useFakeClock(t);
  const shared = {};

  const first = makeWs({ ignitionStates: shared });
  const sock = await connectAndOpen(first.ws, first.sockets);
  await first.push(sock, vep({ ignitionstate: 4 }));
  first.ws.disconnect();

  // Partial pushes carry only what changed: the new client may never be told
  // the ignition is on, because it has not changed.
  const second = makeWs({ ignitionStates: shared });
  try {
    await connectAndOpen(second.ws, second.sockets);
    t.mock.timers.tick(second.ws.IDLE_CLOSE_TIMEOUT * 2);
    assert.equal(isOpen(second.ws), true);
  } finally {
    second.ws.disconnect();
  }
});

test('the API hands every client it builds the same ignition map', async () => {
  const homey = { app: { log() {}, error() {} } };
  const oauth = {
    endpoints: { rest: 'https://rest.invalid', widget: 'https://widget.invalid' },
    // Fail authentication so no socket is ever opened: building the client is
    // all this needs.
    getAccessToken: async () => { throw new Error('no token in tests'); },
  };
  const api = new MercedesAPI(homey, oauth, 'Europe');
  api.protoParserInitialized = true;

  try {
    await api.connectWebSocket(() => {});
    assert.ok(api.websocket);
    assert.equal(api.websocket.ignitionStates, api.ignitionStates);
  } finally {
    if (api.websocket) api.websocket.disconnect();
    await api.disconnectWebSocket();
  }
});

test('a pending command holds the connection open until Mercedes ends it', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    const command = ws.sendCommand(Buffer.from('cmd'), 'REQ1', 'test', 'VIN1');
    await flush();
    assert.equal(ws.pendingCommands.size, 1);

    t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT * 2);
    assert.equal(isOpen(ws), true, 'closing now would abandon the command');

    await push(sock, {
      msg: 'apptwinCommandStatusUpdatesByVin',
      apptwinCommandStatusUpdatesByVin: {
        sequenceNumber: 2,
        updatesByVin: { VIN1: { updatesByPid: { 1: { requestId: 'REQ1', state: 5 } } } },
      },
    });
    await command;
    await flush();
    assert.equal(ws.pendingCommands.size, 0);

    t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT);
    assert.equal(isOpen(ws), false, 'finished, so idle closes again');
  } finally {
    ws.disconnect();
  }
});

test('a command still queued holds the connection open', () => {
  const { ws } = makeWs();
  assert.equal(ws._idleCloseHoldReason(), null);

  // A command waiting its turn, or waiting for the session to warm up, is in
  // `_commandChains` before anything is in `pendingCommands`.
  ws._commandChains.set('VIN1', new Promise(() => {}));
  assert.equal(ws._idleCloseHoldReason(), 'a command is pending');
});

// --- Step 1: the 429 ladder and 1dab8c4 -----------------------------------

/** One clean cycle: handshake accepted, closed by us for being idle. */
async function cleanCycle(t, ws, sockets) {
  await connectAndOpen(ws, sockets);
  t.mock.timers.tick(ws.IDLE_CLOSE_TIMEOUT);
  cancelReconnect(ws);
}

test('one clean idle close does not clear the ladder; five in a row do', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();
  ws.rateLimitStrikes = 3;

  try {
    for (let i = 1; i <= 4; i++) {
      await cleanCycle(t, ws, sockets);
      assert.equal(ws.rateLimitStrikes, 3, `after ${i} clean cycle(s) the ladder stays`);
    }

    await cleanCycle(t, ws, sockets);
    assert.equal(ws.rateLimitStrikes, 0, 'the fifth clean cycle in a row clears it');
  } finally {
    ws.disconnect();
  }
});

test('a 429 between clean cycles starts the count over', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();
  ws.rateLimitStrikes = 3;

  try {
    for (let i = 0; i < 4; i++) await cleanCycle(t, ws, sockets);

    const refused = ws.connectOrThrow(ws.messageHandler);
    await flush();
    sockets[sockets.length - 1].emit('unexpected-response', {}, { statusCode: 429, headers: {}, resume() {} });
    await assert.rejects(refused, /429/);
    assert.equal(ws.rateLimitStrikes, 4);

    for (let i = 0; i < 4; i++) await cleanCycle(t, ws, sockets);
    assert.equal(ws.rateLimitStrikes, 4, 'four clean cycles after the refusal are not five in a row');

    await cleanCycle(t, ws, sockets);
    assert.equal(ws.rateLimitStrikes, 0);
  } finally {
    ws.disconnect();
  }
});

test('a connection that ends any other way breaks the run', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();
  ws.rateLimitStrikes = 2;

  try {
    for (let i = 0; i < 4; i++) await cleanCycle(t, ws, sockets);

    const rotated = await connectAndOpen(ws, sockets);
    rotated.readyState = WebSocket.CLOSED;
    rotated.emit('close', 1001, Buffer.from('rotation'));
    cancelReconnect(ws);

    await cleanCycle(t, ws, sockets);
    assert.equal(ws.rateLimitStrikes, 2, 'not closed by us, so the run starts over');
  } finally {
    ws.disconnect();
  }
});

test('five minutes of stable connection still clears the ladder (1dab8c4)', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();
  ws.rateLimitStrikes = 4;

  try {
    const sock = await connectAndOpen(ws, sockets);
    await push(sock, vep({ ignitionstate: 4 }));

    t.mock.timers.tick(ws.PROVEN_STABLE_AFTER - 1);
    assert.equal(ws.rateLimitStrikes, 4);
    t.mock.timers.tick(1);
    assert.equal(ws.rateLimitStrikes, 0);
  } finally {
    ws.disconnect();
  }
});
