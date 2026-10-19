'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountSessionRegistry } = require('../lib/account-session');

/**
 * Regression tests for issue #81: a two-car account with two push sessions.
 *
 * Every device used to build its own OAuth, API and WebSocket client, so an
 * account with two cars logged in twice, handshaked twice on every app start,
 * and - once Mercedes started refusing - ran two independent 429 backoff
 * ladders. The user's log shows both: two `consecutive rate-limited attempts`
 * series counting up separately, and each token refresh persisting to exactly
 * one of the two devices. Nine hours, never recovering.
 *
 * These pin the shape of the fix: one session per account, every car on it,
 * and exactly one of everything that talks to Mercedes.
 */

function makeHomey() {
  const lines = [];
  return {
    lines,
    app: {
      log: (...args) => lines.push(args.join(' ')),
      error: (...args) => lines.push(args.join(' ')),
    },
  };
}

/** A token that is valid for an hour, unless told otherwise. */
function token(name, secondsFromNow = 3600) {
  return {
    access_token: name,
    refresh_token: `${name}-refresh`,
    expires_at: Math.floor(Date.now() / 1000) + secondsFromNow,
  };
}

class FakeOAuth {
  constructor(region, deviceGuid) {
    this.region = region;
    this.deviceGuid = deviceGuid;
    this.token = null;
    this.logins = 0;
    this.onTokenUpdate = null;
  }

  setTokenUpdateCallback(cb) {
    this.onTokenUpdate = cb;
  }

  async login(username, password) {
    this.logins += 1;
    this.username = username;
    this.password = password;
    this.token = token(`fresh-${this.logins}`);
    return this.token;
  }
}

class FakeApi {
  constructor(oauth, region) {
    this.oauth = oauth;
    this.region = region;
    this.initialized = 0;
    this.connects = 0;
    this.disconnects = 0;
    this.pushHandler = null;
    this.onCommandFailed = null;
    this.onRelogin = null;
    this.healthy = false;
  }

  async initialize() {
    this.initialized += 1;
  }

  async connectWebSocket(handler) {
    this.connects += 1;
    this.pushHandler = handler;
    this.healthy = true;
  }

  async disconnectWebSocket() {
    this.disconnects += 1;
    this.healthy = false;
  }

  setCommandFailedHandler(handler) {
    this.onCommandFailed = handler;
  }

  setReloginHandler(handler) {
    this.onRelogin = handler;
  }
}

/** A registry whose clients are inspectable, with no linger unless asked. */
function makeRegistry(homey = makeHomey()) {
  const created = { oauths: [], apis: [] };

  const registry = new AccountSessionRegistry(homey, {
    createOAuth: (region, deviceGuid) => {
      const oauth = new FakeOAuth(region, deviceGuid);
      created.oauths.push(oauth);
      return oauth;
    },
    createApi: (oauth, region) => {
      const api = new FakeApi(oauth, region);
      created.apis.push(api);
      return api;
    },
  });
  registry.LINGER_MS = 0;

  return { registry, created, homey };
}

/** A device-shaped subscriber that records what it was handed. */
function makeDevice(vin, overrides = {}) {
  const received = { push: [], failures: [], tokens: [] };

  return {
    received,
    subscriber: {
      vin,
      region: 'Europe',
      deviceGuid: 'guid-1',
      username: 'driver@example.invalid',
      password: 'hunter2',
      token: token('paired'),
      onPushData: async (pushVin, data, full) => received.push.push({ vin: pushVin, data, full }),
      onCommandFailed: async (failure) => received.failures.push(failure),
      onTokenRefresh: async (newToken) => received.tokens.push(newToken),
      ...overrides,
    },
  };
}

test('two cars on one account share a single connection', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111');
  const b = makeDevice('WDD2222222B222222');

  const sessionA = registry.acquire(a.subscriber);
  const sessionB = registry.acquire(b.subscriber);

  // One OAuth identity, one API client, one push session. Two of each is what
  // put the user's account behind two backoff ladders for nine hours.
  assert.equal(sessionA, sessionB, 'both cars must be on the same session');
  assert.equal(registry.size, 1);
  assert.equal(created.oauths.length, 1, 'one login identity per account');
  assert.equal(created.apis.length, 1, 'one API client per account');
});

test('cars arriving together produce one login and one handshake', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111', { token: null });
  const b = makeDevice('WDD2222222B222222', { token: null });

  // Homey initialises devices concurrently, which is exactly when a
  // check-then-create race produces two of everything.
  const sessionA = registry.acquire(a.subscriber);
  const sessionB = registry.acquire(b.subscriber);

  await Promise.all([sessionA.ensurePushConnection(), sessionB.ensurePushConnection()]);

  assert.equal(created.oauths[0].logins, 1, 'one set of credentials, one login');
  assert.equal(created.apis[0].connects, 1, 'one handshake, not one per car');
});

test('each car is handed only its own push updates', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111');
  const b = makeDevice('WDD2222222B222222');

  const session = registry.acquire(a.subscriber);
  registry.acquire(b.subscriber);
  await session.ensurePushConnection();

  const push = created.apis[0].pushHandler;
  await push('WDD1111111A111111', { soc: 80 }, true);
  await push('WDD2222222B222222', { soc: 40 }, false);
  await push('WDD3333333C333333', { soc: 10 }, true); // a car nobody added

  assert.deepEqual(a.received.push.map((u) => u.data.soc), [80]);
  assert.deepEqual(b.received.push.map((u) => u.data.soc), [40]);
});

test('a late command failure reaches the car it was about', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111');
  const b = makeDevice('WDD2222222B222222');

  registry.acquire(a.subscriber);
  registry.acquire(b.subscriber);

  // Reported minutes after the flow card returned, over a client that now
  // serves both cars - so the VIN is the only thing that can route it.
  await created.apis[0].onCommandFailed({
    requestId: 'req-1',
    vin: 'WDD2222222B222222',
    commandName: 'windowsClose',
    code: 'CMD_TIMEOUT',
    message: '',
  });

  assert.equal(a.received.failures.length, 0, 'the other car must not be told');
  assert.deepEqual(b.received.failures.map((f) => f.commandName), ['windowsClose']);
});

test('a refreshed token is persisted by every car on the account', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111');
  const b = makeDevice('WDD2222222B222222');

  registry.acquire(a.subscriber);
  registry.acquire(b.subscriber);

  await created.oauths[0].onTokenUpdate(token('refreshed'));

  // Each device keeps its own copy, so any one of them can stand the session
  // back up after a restart - and removing one strands nobody.
  assert.deepEqual(a.received.tokens.map((t) => t.access_token), ['refreshed']);
  assert.deepEqual(b.received.tokens.map((t) => t.access_token), ['refreshed']);
});

test('the session survives one car leaving and closes with the last', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111');
  const b = makeDevice('WDD2222222B222222');

  const session = registry.acquire(a.subscriber);
  registry.acquire(b.subscriber);
  await session.ensurePushConnection();

  await session.detach(a.subscriber.vin);

  assert.equal(created.apis[0].disconnects, 0, 'the remaining car keeps the connection');
  assert.equal(registry.size, 1);

  await session.detach(b.subscriber.vin);

  assert.equal(created.apis[0].disconnects, 1, 'the last car out closes the session');
  assert.equal(registry.size, 0, 'and the session is retired');
});

test('a device that is only re-initialising keeps its session', async () => {
  const { registry, created } = makeRegistry();
  registry.LINGER_MS = 50;

  const a = makeDevice('WDD1111111A111111');
  const session = registry.acquire(a.subscriber);
  await session.ensurePushConnection();

  // A repair or a disable/enable calls onUninit then onInit. Closing and
  // handshaking again seconds later is the sequence Mercedes answers with 429.
  await session.detach(a.subscriber.vin);
  const again = registry.acquire(a.subscriber);

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(again, session, 'the same session must be picked back up');
  assert.equal(created.apis[0].disconnects, 0, 'the connection must not have been torn down');
  assert.equal(registry.size, 1);
});

test('a repaired car brings the whole account its new token', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111');
  const b = makeDevice('WDD2222222B222222');

  registry.acquire(a.subscriber);
  registry.acquire(b.subscriber);
  assert.equal(created.oauths[0].token.access_token, 'paired');

  // Repair logs in again and re-inits the device. The token it arrives with
  // outlives the session's, so the session takes it - rather than the repaired
  // car being the only one that works.
  const repaired = makeDevice('WDD1111111A111111', {
    token: token('repaired', 7200),
    password: 'new-password',
  });
  registry.acquire(repaired.subscriber);

  assert.equal(created.oauths[0].token.access_token, 'repaired');
  assert.equal(created.apis.length, 1, 'a repair must not open a second session');

  await created.apis[0].onRelogin();
  assert.equal(created.oauths[0].password, 'new-password', 'and the new credentials with it');
});

test('a car whose token is older than the session does not clobber it', async () => {
  const { registry, created } = makeRegistry();

  registry.acquire(makeDevice('WDD1111111A111111', { token: token('current', 3600) }).subscriber);
  registry.acquire(makeDevice('WDD2222222B222222', { token: token('stale', 60) }).subscriber);

  // Devices init in any order, and one that has been offline can hold a token
  // older than the one the session is already running on.
  assert.equal(created.oauths[0].token.access_token, 'current');
});

test('two accounts keep two sessions', async () => {
  const { registry, created } = makeRegistry();

  registry.acquire(makeDevice('WDD1111111A111111').subscriber);
  registry.acquire(makeDevice('WDD2222222B222222', {
    username: 'other@example.invalid',
  }).subscriber);

  // Sharing is per account. Two logins on one Homey must not be merged.
  assert.equal(registry.size, 2);
  assert.equal(created.apis.length, 2);
});

test('the same account paired twice still shares one session', async () => {
  const { registry } = makeRegistry();

  // A second pairing run mints a new deviceGuid, so keying on that would leave
  // the account with one push session per run - the duplication all over again.
  registry.acquire(makeDevice('WDD1111111A111111', { deviceGuid: 'guid-1' }).subscriber);
  registry.acquire(makeDevice('WDD2222222B222222', { deviceGuid: 'guid-2' }).subscriber);

  assert.equal(registry.size, 1);
});

test('a login failure leaves the next car free to retry', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111', { token: null });

  const session = registry.acquire(a.subscriber);
  created.oauths[0].login = async () => { throw new Error('login crashed'); };

  await assert.rejects(session.ensureReady(), /login crashed/);

  // A cached rejected promise would mean the account never authenticates again
  // until the app restarts.
  created.oauths[0].login = async function () { this.token = token('recovered'); };
  await session.ensureReady();

  assert.equal(created.oauths[0].token.access_token, 'recovered');
});

test('a session on its way out is never handed to an arriving car', async () => {
  const { registry, created } = makeRegistry();
  const a = makeDevice('WDD1111111A111111');

  const session = registry.acquire(a.subscriber);
  await session.ensurePushConnection();

  const closing = session.detach(a.subscriber.vin); // no linger: closes now
  const replacement = registry.acquire(makeDevice('WDD2222222B222222').subscriber);
  await closing;

  // Handing the closing session out - or letting it delete its replacement
  // from the registry on the way down - puts the account back on two push
  // connections, which is the whole fault this file removes.
  assert.notEqual(replacement, session);
  assert.equal(registry.size, 1, 'the replacement must survive the close');
  assert.equal(registry.acquire(makeDevice('WDD3333333C333333').subscriber), replacement);

  await session.ensurePushConnection();
  assert.equal(created.apis[0].connects, 1, 'a closed session must not reconnect');
});
