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
  // Only the pending command under test here; the 180s hold after a command
  // has tests of its own (step 4).
  ws.COMMAND_HOLD_OPEN = 0;

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

// --- Step 2: come back 60s after a close, never inside a 429 window --------

/**
 * Advance the fake clock a second at a time, letting the async connect path
 * run as it goes.
 *
 * One big tick() is wrong for chained timers: the mock moves the clock to the
 * *end* of the tick before running what fell due, so a close that fell due
 * halfway through runs with Date.now() at the end - and arms its 60s wait
 * from there.
 */
async function advance(t, ms) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(1000, left);
    t.mock.timers.tick(step);
    left -= step;
    await flush();
  }
}

/** Open the socket the reconnect timer just created. */
async function openLatest(sockets) {
  const sock = sockets[sockets.length - 1];
  sock.readyState = WebSocket.OPEN;
  sock.emit('open');
  await flush();
  return sock;
}

test('after an idle close the next connection comes 60s later, not sooner', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT);
    assert.equal(sockets.length, 1);

    await advance(t, ws.RECONNECT_AFTER_CLOSE - 1);
    assert.equal(sockets.length, 1, 'no handshake inside the 60s');

    await advance(t, 1);
    assert.equal(sockets.length, 2, 'one handshake at 60s');
    assert.equal(ws.reconnectAttempts, 0, 'a close is not a failed attempt');
  } finally {
    ws.disconnect();
  }
});

test('a 1001 rotation, a 1000 and a drop all come back on the 60s cycle', async (t) => {
  useFakeClock(t);

  for (const code of [1001, 1000, 1006]) {
    const { ws, sockets, push } = makeWs();
    try {
      const sock = await connectAndOpen(ws, sockets);
      // While driving: held open, so it is Mercedes that ends it.
      await push(sock, vep({ ignitionstate: 4 }));
      await advance(t, 5000);

      sock.readyState = WebSocket.CLOSED;
      sock.emit('close', code, Buffer.from(''));

      await advance(t, ws.RECONNECT_AFTER_CLOSE - 1);
      assert.equal(sockets.length, 1, `close ${code} must not reconnect inside the cycle`);
      await advance(t, 1);
      assert.equal(sockets.length, 2, `close ${code} reconnects at 60s`);
    } finally {
      ws.disconnect();
    }
  }
});

test('a connection the liveness watchdog gave up on comes back on the cycle too', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    await push(sock, vep({ ignitionstate: 4 }));
    sock.answerPings = false; // half-open: nothing comes back

    await advance(t, ws.INITIAL_WATCHDOG_TIMEOUT);
    assert.equal(isOpen(ws), false, 'declared dead');
    assert.equal(ws.stats.closes.drop, 1);

    await advance(t, ws.RECONNECT_AFTER_CLOSE - 1);
    assert.equal(sockets.length, 1);
    await advance(t, 1);
    assert.equal(sockets.length, 2);
  } finally {
    ws.disconnect();
  }
});

test('a parked car cycles: one handshake every 90s', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    for (let cycle = 0; cycle < 3; cycle++) {
      await advance(t, ws.IDLE_CLOSE_TIMEOUT);
      await advance(t, ws.RECONNECT_AFTER_CLOSE);
      await openLatest(sockets);
    }

    // 30s open + 60s closed. Around 40 handshakes an hour, as mbapi2020.
    assert.equal(ws.stats.handshakes, 4);
    assert.equal(ws.stats.closes.idle, 3);
    assert.equal(isOpen(ws), true);
  } finally {
    ws.disconnect();
  }
});

test('a 429 window longer than the cycle is waited out in full', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT); // closed, cycle armed for 60s

    // Another path collects a 429 ten seconds later: Mercedes asks for 2 min.
    await advance(t, 10000);
    ws._registerRateLimit(120000);

    // The cycle timer fires at 60s, re-reads the window and keeps waiting.
    await advance(t, 50000);
    assert.equal(sockets.length, 1, 'the cycle must not handshake into a live window');

    await advance(t, 120000 - 50000 - 1);
    assert.equal(sockets.length, 1);
    await advance(t, 1);
    assert.equal(sockets.length, 2, 'and comes back the moment it ends');
  } finally {
    ws.disconnect();
  }
});

test('a window already running when the connection closes sets the wait', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    ws._registerRateLimit(300000);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT); // 270s of the window left

    await advance(t, 270000 - 1);
    assert.equal(sockets.length, 1);
    await advance(t, 1);
    assert.equal(sockets.length, 2);
  } finally {
    ws.disconnect();
  }
});

test('a failed handshake keeps the escalating backoff, not the cycle', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT);
    await advance(t, ws.RECONNECT_AFTER_CLOSE);
    assert.equal(sockets.length, 2);

    // Not a 429: a transport failure on the handshake.
    sockets[1].emit('error', new Error('ECONNRESET'));
    await flush();

    await advance(t, 10000 - 1);
    assert.equal(sockets.length, 2);
    await advance(t, 1);
    assert.equal(sockets.length, 3, 'first retry after a failure is 10s, as before');
  } finally {
    ws.disconnect();
  }
});

test('a connection that opens cancels the cycle armed for the one before it', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT);
    assert.ok(ws.reconnectTimer, 'the cycle is armed');

    // Something connects in the meantime without cancelling the cycle.
    await advance(t, 20000);
    await connectAndOpen(ws, sockets);
    assert.equal(sockets.length, 2);

    assert.equal(ws.reconnectTimer, null, 'the stale cycle is cancelled by the open');

    // The stale timer would have fired here, 60s after the *first* close -
    // ten seconds after this connection idled out.
    await advance(t, 40000);
    assert.equal(isOpen(ws), false, 'idled out at 30s');
    assert.equal(sockets.length, 2, 'and the old cycle did not cut the new wait short');

    await advance(t, ws.RECONNECT_AFTER_CLOSE - 10000 - 1);
    assert.equal(sockets.length, 2);
    await advance(t, 1);
    assert.equal(sockets.length, 3, '60s after its own close');
  } finally {
    ws.disconnect();
  }
});

// --- Step 3: a connection resting between cycles is not a dead one ---------

/**
 * The real device class, loaded against a stand-in for the Homey runtime -
 * device.js cannot be required outside Homey otherwise. Only the health
 * check and the staleness warning are exercised, on a bare instance.
 */
function loadDeviceClass() {
  const homeyPath = require.resolve('homey');
  require.cache[homeyPath] = {
    id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: class {} },
  };
  return require('../drivers/mercedes-vehicle/device');
}

function makeDevice({ api, session }) {
  const MercedesVehicleDevice = loadDeviceClass();
  const device = Object.create(MercedesVehicleDevice.prototype);
  device.api = api;
  device.session = session;
  device.logs = [];
  device.warnings = [];
  device.log = (...args) => device.logs.push(args.join(' '));
  device.error = (...args) => device.logs.push(args.join(' '));
  device.setWarning = async (message) => { device.warnings.push(message); };
  device.unsetWarning = async () => {};
  return device;
}

/**
 * A real MercedesAPI whose push client is the scripted one. Its own OAuth
 * refuses to hand out a token, so if anything does rebuild the client the
 * replacement fails before it can open a socket - nothing here reaches the
 * network.
 */
function makeApiAround(ws) {
  const homey = { app: { log() {}, error() {} } };
  const oauth = {
    endpoints: { rest: 'https://rest.invalid', widget: 'https://widget.invalid' },
    getAccessToken: async () => { throw new Error('no token in tests'); },
  };
  const api = new MercedesAPI(homey, oauth, 'Europe');
  api.protoParserInitialized = true;
  api.websocket = ws;
  return api;
}

test('isResting: only the cycle\'s own wait, or a connect already under way', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    assert.equal(ws.isResting(), false, 'never connected: nothing is coming back');

    const sock = await connectAndOpen(ws, sockets);
    assert.equal(ws.isResting(), false, 'open is healthy, not resting');

    await advance(t, ws.IDLE_CLOSE_TIMEOUT);
    assert.equal(ws.isResting(), true, 'closed idle, cycle pending');

    await advance(t, ws.RECONNECT_AFTER_CLOSE);
    assert.equal(ws.isConnecting, true);
    assert.equal(ws.isResting(), true, 'the cycle is reconnecting');

    // That handshake fails: the retry is the failure backoff, not the cycle.
    sockets[1].emit('error', new Error('ECONNRESET'));
    await flush();
    assert.ok(ws.reconnectTimer);
    assert.equal(ws.isResting(), false, 'a retry after a failure is not covered');

    assert.ok(sock);
  } finally {
    ws.disconnect();
  }
  assert.equal(ws.isResting(), false, 'stopped is not resting');
});

test('a 1001 rotation rests on the cycle too', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    sock.readyState = WebSocket.CLOSED;
    sock.emit('close', 1001, Buffer.from('rotation'));
    assert.equal(ws.isResting(), true);
  } finally {
    ws.disconnect();
  }
});

test('a stranded client - closed, nothing pending - is not resting', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT);
    cancelReconnect(ws);
    assert.equal(ws.isResting(), false, 'this is what the health check is for');
  } finally {
    ws.disconnect();
  }
});

test('the API leaves a resting client alone instead of rebuilding it', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();
  const api = makeApiAround(ws);

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT);
    assert.equal(api.isWebSocketResting(), true);

    await api.connectWebSocket(() => {});
    assert.equal(api.websocket, ws, 'the resting client is kept');
    assert.equal(ws.isStopping, false, 'and not disposed');
    assert.equal(sockets.length, 1, 'no handshake inside the 60s wait');
  } finally {
    ws.disconnect();
    await api.disconnectWebSocket();
  }
});

test('the health check does not reconnect inside the 60s wait; the cycle does at 60s', async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();
  const api = makeApiAround(ws);
  const device = makeDevice({
    api,
    session: { ensurePushConnection: () => api.connectWebSocket(() => {}) },
  });
  // A tick that lands 10s into the wait, and another 50s in.
  device.WS_HEALTH_CHECK_INTERVAL = 40000;

  try {
    device._startWebSocketHealthCheck();
    await connectAndOpen(ws, sockets);

    await advance(t, ws.IDLE_CLOSE_TIMEOUT + ws.RECONNECT_AFTER_CLOSE - 1);
    assert.equal(sockets.length, 1, 'no handshake from the health check');
    assert.equal(api.websocket, ws, 'and no rebuilt client');
    assert.equal(device.logs.filter((l) => l.includes('reconnecting')).length, 0);

    await advance(t, 1);
    assert.equal(sockets.length, 2, 'the cycle brings it back on time');
  } finally {
    device._stopWebSocketHealthCheck();
    ws.disconnect();
    await api.disconnectWebSocket();
  }
});

test('the health check still rescues a stranded connection', async (t) => {
  useFakeClock(t);
  let rescues = 0;
  const device = makeDevice({
    api: {
      isWebSocketHealthy: () => false,
      isWebSocketResting: () => false,
      isWebSocketConnected: () => false,
      getWebSocketIdleTime: () => null,
      getWebSocketRateLimitRemaining: () => 0,
      getRestRateLimitRemaining: () => 0,
    },
    session: { ensurePushConnection: async () => { rescues++; } },
  });

  try {
    device._startWebSocketHealthCheck();
    await advance(t, 300000);
    assert.equal(rescues, 1);
  } finally {
    device._stopWebSocketHealthCheck();
  }
});

test('resting between cycles never raises the push-down warning; really down does', async (t) => {
  useFakeClock(t);
  let resting = true;
  const device = makeDevice({
    api: {
      isWebSocketHealthy: () => false,
      isWebSocketResting: () => resting,
      isWebSocketConnected: () => false,
      getWebSocketIdleTime: () => null,
      getWebSocketRateLimitRemaining: () => 0,
      getRestRateLimitRemaining: () => 0,
    },
    session: { ensurePushConnection: async () => {} },
  });

  try {
    device._startWebSocketHealthCheck();

    // A parked car: the health check catches it between cycles every time.
    for (let i = 0; i < 24; i++) await advance(t, 300000); // 2 hours
    assert.equal(device.warnings.length, 0);
    assert.equal(device._wsDownSince, null);

    // Really down: the hour counts from here.
    resting = false;
    for (let i = 0; i < 12; i++) await advance(t, 300000);
    assert.equal(device.warnings.length, 0, 'not before the hour');
    await advance(t, 300000);
    assert.equal(device.warnings.length, 1);
  } finally {
    device._stopWebSocketHealthCheck();
  }
});

// --- Step 4: commands skip the 60s wait (not a 429), and hold for 180s -----

/** A command status frame for one request on VIN1 (7 accepted, 5 finished). */
function commandStatus(requestId, state, sequenceNumber = 2) {
  return {
    msg: 'apptwinCommandStatusUpdatesByVin',
    apptwinCommandStatusUpdatesByVin: {
      sequenceNumber,
      updatesByVin: { VIN1: { updatesByPid: { 1: { requestId, state } } } },
    },
  };
}

const ACCEPTED = 7;
const FINISHED = 5;

/** Has this socket carried the given command buffer? */
const carried = (sock, text) => sock.sent.some((b) => Buffer.from(b).toString() === text);

test('a command during the 60s wait connects at once instead of waiting for the cycle', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT); // idle close at 30s, cycle due at 90s
    await advance(t, 10000);

    const command = ws.sendCommand(Buffer.from('lock'), 'REQ1', 'lock', 'VIN1');
    await flush();
    assert.equal(sockets.length, 2, 'handshake at 40s, not at 90s');
    assert.equal(ws.reconnectTimer, null, 'the cycle is cancelled, not left to fire on top');

    const sock = await openLatest(sockets);
    await push(sock, vep({ soc: 80 })); // the session warms up
    await advance(t, 1000);
    assert.ok(carried(sock, 'lock'), 'the command went out on the new connection');

    await push(sock, commandStatus('REQ1', ACCEPTED));
    assert.deepEqual(await command, { success: true, state: 'ACKED_BY_APPTWIN' });

    await advance(t, 60000);
    assert.equal(sockets.length, 2, 'and no second handshake when the old cycle would have fired');
  } finally {
    ws.disconnect();
  }
});

test('inside a 429 window a command is refused at once, without a handshake', { timeout: 10000 }, async (t) => {
  useFakeClock(t);
  const { ws, sockets } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    ws._registerRateLimit(300000);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT); // closed; the window has 270s left
    await advance(t, 10000);

    // Checked before awaiting the outcome: a command that did handshake would
    // wait on a socket that never opens, and the test would hang, not fail.
    const outcome = ws.sendCommand(Buffer.from('lock'), 'REQ1', 'lock', 'VIN1')
      .then(() => null, (error) => error);
    await flush();
    assert.equal(sockets.length, 1, 'no handshake into the window');

    const error = await outcome;
    assert.ok(error, 'the command is refused');
    assert.match(
      error.message,
      /rate-limiting the push connection \(HTTP 429\)\. Not reconnecting for another ~5 min/,
    );
    assert.ok(ws.reconnectTimer, 'and the wait for the window is left in place');

    await advance(t, 260000 - 1);
    assert.equal(sockets.length, 1);
    await advance(t, 1);
    assert.equal(sockets.length, 2, 'the connection comes back when the window ends');
  } finally {
    ws.disconnect();
  }
});

test('the connection stays open 180s after a command, then closes', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    await advance(t, 5000);

    const command = ws.sendCommand(Buffer.from('lock'), 'REQ1', 'lock', 'VIN1');
    await flush();
    await push(sock, commandStatus('REQ1', ACCEPTED));
    await command;

    await advance(t, 10000);
    await push(sock, commandStatus('REQ1', FINISHED, 3));
    assert.equal(ws.pendingCommands.size, 0, 'finished at 15s');

    // Nothing more from the car. Without the hold this closed at 45s.
    await advance(t, 185000 - 15000 - 1000);
    assert.equal(isOpen(ws), true, 'still open at 184s');
    await advance(t, 1000);
    assert.equal(isOpen(ws), false, 'closed at 185s: 180s after the command');
    assert.equal(ws.stats.closes.idle, 1);

    await advance(t, ws.RECONNECT_AFTER_CLOSE);
    assert.equal(sockets.length, 2, 'and back on the cycle 60s later');
  } finally {
    ws.disconnect();
  }
});

test('data near the end of the hold still gets its own 30s', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    const command = ws.sendCommand(Buffer.from('lock'), 'REQ1', 'lock', 'VIN1');
    await flush();
    await push(sock, commandStatus('REQ1', FINISHED));
    await command;

    await advance(t, 170000);
    await push(sock, vep({ doorlockstatusvehicle: 2 }));

    await advance(t, 29000);
    assert.equal(isOpen(ws), true, 'the hold has ended, but the data is only 29s old');
    await advance(t, 1000);
    assert.equal(isOpen(ws), false, '30s after the data');
  } finally {
    ws.disconnect();
  }
});

test('a second command inside the hold uses the open connection and extends it', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    const sock = await connectAndOpen(ws, sockets);
    const first = ws.sendCommand(Buffer.from('lock'), 'REQ1', 'lock', 'VIN1');
    await flush();
    await push(sock, commandStatus('REQ1', FINISHED));
    await first;

    await advance(t, 100000);
    const second = ws.sendCommand(Buffer.from('windows'), 'REQ2', 'windows', 'VIN1');
    await flush();
    assert.ok(carried(sock, 'windows'), 'sent on the connection the hold kept');
    assert.equal(sockets.length, 1, 'no handshake for the second command');
    await push(sock, commandStatus('REQ2', FINISHED, 3));
    await second;

    await advance(t, 179000);
    assert.equal(isOpen(ws), true, 'held 180s from the second command, not the first');
    await advance(t, 1000);
    assert.equal(isOpen(ws), false);
  } finally {
    ws.disconnect();
  }
});

test('a command arriving while the cycle reconnects joins it and goes once it warms up', async (t) => {
  useFakeClock(t);
  const { ws, sockets, push } = makeWs();

  try {
    await connectAndOpen(ws, sockets);
    await advance(t, ws.IDLE_CLOSE_TIMEOUT + ws.RECONNECT_AFTER_CLOSE);
    assert.equal(ws.isConnecting, true, 'the cycle is mid-handshake');

    const command = ws.sendCommand(Buffer.from('lock'), 'REQ1', 'lock', 'VIN1');
    await flush();
    assert.equal(sockets.length, 2, 'it joins the handshake under way, not a second one');

    const sock = await openLatest(sockets);
    await push(sock, vep({ soc: 80 }));
    await advance(t, 1000);

    // Joining an attempt that was already under way used to leave the warmup
    // unseen - the attempt kept the handler it started with - so the command
    // sat out the full 30s before going.
    assert.ok(carried(sock, 'lock'), 'sent within a second of the session warming up');

    await push(sock, commandStatus('REQ1', ACCEPTED));
    await command;
  } finally {
    ws.disconnect();
  }
});
