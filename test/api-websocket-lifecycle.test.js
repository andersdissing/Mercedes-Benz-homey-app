'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MercedesAPI = require('../lib/api');

/**
 * The API layer owns WebSocket client lifecycle: it decides when to replace
 * the client. That decision is where an HTTP 429 backoff can be silently
 * defeated - a brand-new client starts with a clean rate-limit slate, and the
 * device health check builds one every 5 minutes.
 */

function makeApi() {
  const homey = { app: { log() {}, error() {} } };
  const oauth = {
    endpoints: {
      rest: 'https://rest.invalid',
      widget: 'https://widget.invalid',
      login: 'https://login.invalid',
    },
  };

  const api = new MercedesAPI(homey, oauth, 'Europe');
  api.protoParserInitialized = true; // skip loading .proto files
  return api;
}

/** Stand-in for a MercedesWebSocket that is down and rate-limited. */
function blockedClient(blockedUntil) {
  return {
    disposed: false,
    isHealthy: () => false,
    isConnected: () => false,
    getRateLimitState: () => (blockedUntil > Date.now() ? { blockedUntil } : null),
    getIdleTime: () => null,
    disconnect() { this.disposed = true; },
  };
}

test('the API does not rebuild the WebSocket client while rate-limited', async () => {
  const api = makeApi();
  const client = blockedClient(Date.now() + 60000);
  api.websocket = client;

  await api.connectWebSocket(() => {});

  // Replacing the client here would reset accountBlocked and handshake
  // straight through the block, renewing it every 5 minutes.
  assert.equal(api.websocket, client, 'the blocked client must be kept');
  assert.equal(client.disposed, false, 'the blocked client must not be disposed');
  assert.ok(api._wsRateLimitState, 'the window must be remembered');
});

test('a remembered 429 window blocks a reconnect even with no client left', async () => {
  const api = makeApi();
  api.websocket = null;
  api._wsRateLimitState = { blockedUntil: Date.now() + 60000 };

  await api.connectWebSocket(() => {});

  assert.equal(api.websocket, null, 'no client may be built during the backoff window');
});

test('an expired 429 window does not block reconnecting', async () => {
  const api = makeApi();
  api.websocket = null;
  api._wsRateLimitState = { blockedUntil: Date.now() - 1000 };

  // Fail authentication so no socket is ever opened: the client is still
  // built, which is what proves the guard let this attempt through.
  api.oauth.getAccessToken = async () => { throw new Error('no token in tests'); };

  await api.connectWebSocket(() => {});

  try {
    assert.ok(api.websocket, 'an elapsed window must not block building a client');
    assert.ok(!api.websocket.isConnected(), 'and no socket should have opened');
  } finally {
    if (api.websocket) api.websocket.disconnect();
  }
});
