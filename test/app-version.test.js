'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AppVersionManager, RIS_SDK_VERSION, RIS_APPLICATION_VERSION } = require('../lib/app-version');

/**
 * The app identity we present to Mercedes.
 *
 * Hardcoding a version is a slow leak: it works until Mercedes ships an app
 * update and starts refusing the old one - first with HTTP 418, and (as seen
 * in the field) eventually with an HTTP 429 at the WebSocket upgrade that no
 * amount of backoff clears, because it was never about request volume. These
 * tests pin the contract ported from mbapi2020's app_version.py: only ask when
 * told to, only believe FORCE / INFORM_ALWAYS, and never let the lookup itself
 * become a way to fail a request.
 */

function makeManager(region = 'Europe') {
  const logs = [];
  const homey = { app: { log: (...args) => logs.push(args.join(' ')), error() {} } };
  const manager = new AppVersionManager(homey, region);
  return { manager, logs };
}

/** Replace the manager's HTTP client with scripted responses per URL fragment. */
function scriptHttp(manager, routes) {
  const calls = [];
  manager._client = {
    get: async (url, options = {}) => {
      calls.push({ url, params: options.params });
      for (const [fragment, response] of Object.entries(routes)) {
        if (url.includes(fragment)) return response;
      }
      return { status: 404, data: null };
    },
  };
  return calls;
}

test('the defaults stay on the pair whose REST payload we can decode', () => {
  const { manager } = makeManager();

  // These are deliberately NOT mbapi2020's current values. Declaring SDK
  // 4.10.0 / app 1.68.0 (3060) makes the widget endpoint answer a different,
  // newer message schema (vin at field 1, payload at fields 108/109) that
  // VEPUpdate.decode rejects - which silently kills every polled capability.
  // Verified against the live endpoint: 651 decodable bytes on the pair below,
  // 365 undecodable bytes on theirs. Bumping these requires porting the parser.
  assert.equal(RIS_SDK_VERSION, '4.4.2');
  assert.equal(RIS_APPLICATION_VERSION, '1.65.1 (3174)');
  assert.equal(manager.applicationVersion, '1.65.1 (3174)');
  assert.equal(manager.applicationName, 'mycar-store-ece');
});

test('every region gets its own application identity', () => {
  assert.equal(makeManager('Europe').manager.applicationName, 'mycar-store-ece');
  assert.equal(makeManager('North America').manager.applicationName, 'mycar-store-us');
  assert.equal(makeManager('Asia-Pacific').manager.applicationName, 'mycar-store-ap');

  // China runs a different app on a different SDK line entirely.
  const china = makeManager('China').manager;
  assert.equal(china.applicationName, 'mycar-store-cn');
  assert.equal(china.sdkVersion, '2.132.2');
  assert.match(china.websocketUserAgent(), /MyStarCN/);
});

test('a version bump is applied when Mercedes says the build is too old', async () => {
  const { manager } = makeManager();

  scriptHttp(manager, {
    '/v1/config': { status: 200, data: { forceUpdate: { status: 'FORCE', storeUrl: 'https://apps.apple.com/de/app/mercedes-me/id1080186371' } } },
    'itunes.apple.com': { status: 200, data: { results: [{ version: '9.9.9' }] } },
  });

  assert.equal(await manager.refresh('https://bff.example.com'), true);
  assert.equal(manager.applicationVersion, '9.9.9');
});

test('a healthy status leaves the version alone', async () => {
  const { manager } = makeManager();
  const before = manager.applicationVersion;

  const calls = scriptHttp(manager, {
    '/v1/config': { status: 200, data: { forceUpdate: { status: 'NONE', storeUrl: 'https://apps.apple.com/de/app/x/id1080186371' } } },
    'itunes.apple.com': { status: 200, data: { results: [{ version: '9.9.9' }] } },
  });

  assert.equal(await manager.refresh('https://bff.example.com'), false);
  assert.equal(manager.applicationVersion, before);

  // And it must not have gone shopping: the App Store lookup is only justified
  // once Mercedes has actually said the running version is unacceptable.
  assert.equal(calls.filter((c) => c.url.includes('itunes')).length, 0);
});

test('the App Store lookup is scoped to the region storefront', async () => {
  const { manager } = makeManager('North America');

  const calls = scriptHttp(manager, {
    '/v1/config': { status: 200, data: { forceUpdate: { status: 'INFORM_ALWAYS', storeUrl: 'https://apps.apple.com/us/app/mercedes-me/id1080186371' } } },
    'itunes.apple.com': { status: 200, data: { results: [{ version: '4.0.0' }] } },
  });

  await manager.refresh('https://bff.example.com');

  const lookup = calls.find((c) => c.url.includes('itunes'));
  assert.deepEqual(lookup.params, { id: '1080186371', country: 'us' });
});

test('a failed lookup keeps the current version instead of breaking the request', async () => {
  const { manager } = makeManager();
  const before = manager.applicationVersion;

  manager._client = { get: async () => { throw new Error('network down'); } };

  // This runs on the hot path of every REST call and every WebSocket connect.
  // Losing the ability to upgrade the version is a slow problem; throwing here
  // would fail the login or the connect outright, which is an immediate one.
  assert.equal(await manager.refresh('https://bff.example.com'), false);
  assert.equal(manager.applicationVersion, before);
});

test('an unusable endpoint is a quiet no-op, not an error', async () => {
  const { manager } = makeManager();
  manager._client = { get: async () => { throw new Error('should never be called'); } };

  // Callers pass whatever endpoint they have; a missing one must not take the
  // surrounding request down with it.
  assert.equal(await manager.refresh(undefined), false);
  assert.equal(await manager.refresh(null), false);
  assert.equal(await manager.refresh(''), false);
});

test('the version is not re-checked on every request', async () => {
  const { manager } = makeManager();

  const calls = scriptHttp(manager, {
    '/v1/config': { status: 200, data: { forceUpdate: { status: 'NONE' } } },
  });

  await manager.refresh('https://bff.example.com');
  await manager.refresh('https://bff.example.com');
  await manager.refresh('https://bff.example.com');

  // Every REST call and every connect asks. Mercedes punishes chattiness, and
  // the version only moves when a release ships.
  assert.equal(calls.length, 1, 'the check interval must suppress repeat lookups');

  assert.equal(await manager.refresh('https://bff.example.com', { force: true }), false);
  assert.equal(calls.length, 2, 'an explicit force still checks');
});

test('concurrent refreshes share one lookup', async () => {
  const { manager } = makeManager();
  let inFlight = 0;
  let maxInFlight = 0;

  manager._client = {
    get: async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return { status: 200, data: { forceUpdate: { status: 'NONE' } } };
    },
  };

  // REST, WebSocket and OAuth can all ask on the same startup.
  await Promise.all([
    manager.refresh('https://bff.example.com'),
    manager.refresh('https://bff.example.com'),
    manager.refresh('https://bff.example.com'),
  ]);

  assert.equal(maxInFlight, 1, 'three callers must not make three round trips');
});

test('applied headers carry the current version on every transport', async () => {
  const { manager } = makeManager();

  scriptHttp(manager, {
    '/v1/config': { status: 200, data: { forceUpdate: { status: 'FORCE', storeUrl: 'https://apps.apple.com/de/app/x/id1080186371' } } },
    'itunes.apple.com': { status: 200, data: { results: [{ version: '2.0.0' }] } },
  });
  await manager.refresh('https://bff.example.com');

  // A bump that only reached one transport would leave the others presenting
  // the version Mercedes just rejected.
  for (const headers of [
    manager.applyWebApiHeaders({}),
    manager.applyWebSocketHeaders({}),
  ]) {
    assert.equal(headers['ris-application-version'], '2.0.0');
    assert.equal(headers['ris-sdk-version'], '4.4.2');
    assert.equal(headers['X-ApplicationName'], 'mycar-store-ece');
  }

  const oauthHeaders = manager.applyOAuthHeaders({});
  assert.equal(oauthHeaders['Ris-Application-Version'], '2.0.0');
  assert.equal(oauthHeaders['Ris-Sdk-Version'], '4.4.2');
});

test('North America gets the extra websocket headers it needs', () => {
  const { manager } = makeManager('North America');
  const headers = manager.applyWebSocketHeaders({});

  assert.equal(headers['X-Locale'], 'en-US');
  assert.equal(headers['Sec-WebSocket-Extensions'], 'permessage-deflate');

  // Europe must not pick these up.
  const europe = makeManager('Europe').manager.applyWebSocketHeaders({});
  assert.equal(europe['Sec-WebSocket-Extensions'], undefined);
});
