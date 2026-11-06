'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MercedesOAuth = require('../lib/oauth');
const MercedesWebSocket = require('../lib/websocket');
const ConnectionStats = require('../lib/connection-stats');

/**
 * Renewing the session before Mercedes refuses it.
 *
 * The 1.1.53 test on a parked car (15-18 Oct 2026) met two WebSocket 429s
 * every 18 hours, in the same clock hour each time, and every episode ended
 * with the escalation's login, which started the next 18 hours. The login
 * now comes first, before a handshake on a session 16 hours old. These tests
 * pin the three parts: the token says when its login was, a refresh keeps
 * that, and the client logs in by it before handshaking.
 */

const HOUR = 3600000;
const quiet = { app: { log() {}, error() {} } };

test('a login stamps the token with when the session began', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1792000000000 });
  const oauth = new MercedesOAuth(quiet, 'Europe', 'device-guid');

  // The network steps are stubbed; login() itself is the real one.
  oauth._getAuthorizationResume = async () => ({ code: 'code' });
  oauth._exchangeCodeForTokens = async () => ({
    access_token: 'a', refresh_token: 'r', expires_in: 3600, expires_at: 1792003600,
  });

  const token = await oauth.login('user@example.com', 'secret');

  assert.equal(token.logged_in_at, 1792000000);
  assert.equal(oauth.token.logged_in_at, 1792000000);
});

test('a refresh keeps the time of the login, not the time of the refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1792036000000 });
  const oauth = new MercedesOAuth(quiet, 'Europe', 'device-guid');
  oauth.token = { access_token: 'old', refresh_token: 'r', expires_at: 1792036000, logged_in_at: 1792000000 };
  oauth.client = { post: async () => ({ data: { access_token: 'new', expires_in: 3600 } }) };

  const token = await oauth.refreshAccessToken('r');

  // A refresh hands out a token for the same session (which is exactly why
  // it never clears the 429), so the session is as old as it was.
  assert.equal(token.access_token, 'new');
  assert.equal(token.logged_in_at, 1792000000);
});

/**
 * A client whose handshake is recorded rather than made, with a token of the
 * given age (in hours; null for a token stored before the stamp existed).
 */
const clocked = new WeakSet();

function makeWs(t, ageHours, { login } = {}) {
  if (!clocked.has(t)) {
    t.mock.timers.enable({ apis: ['Date'], now: 1792000000000 });
    clocked.add(t);
  }
  const events = [];
  const oauth = {
    token: {
      access_token: 'a',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      ...(ageHours === null ? {} : { logged_in_at: Math.floor((Date.now() - ageHours * HOUR) / 1000) }),
    },
    getAccessToken: async () => 'a',
    refreshToken: async () => { events.push('refresh'); },
  };
  const stats = new ConnectionStats();
  const ws = new MercedesWebSocket(quiet, oauth, 'Europe', {}, 'session-id', { stats });

  ws.setReloginHandler(login || (async () => {
    events.push('login');
    oauth.token = { ...oauth.token, logged_in_at: Math.floor(Date.now() / 1000) };
  }));
  ws._connectInternal = async () => { events.push('handshake'); };

  return { ws, oauth, stats, events };
}

test('a session 16 hours old is renewed before the handshake', async (t) => {
  const { ws, stats, events } = makeWs(t, 16);

  await ws.connectOrThrow(() => {});

  assert.deepEqual(events, ['login', 'handshake'], 'the login has to come before the handshake it protects');
  assert.equal(stats.logins.ahead, 1);
});

test('a younger session is left alone', async (t) => {
  const { ws, stats, events } = makeWs(t, 15.9);

  await ws.connectOrThrow(() => {});

  // A login is the heaviest request the app makes; one every idle cycle
  // would be far worse than the two refusals it exists to avoid.
  assert.deepEqual(events, ['handshake']);
  assert.equal(stats.logins.ahead, 0);
});

test('a renewed session is not renewed again on the next handshake', async (t) => {
  const { ws, events } = makeWs(t, 17);

  await ws.connectOrThrow(() => {});
  t.mock.timers.tick(90000); // one idle cycle later
  await ws.connectOrThrow(() => {});

  assert.deepEqual(events, ['login', 'handshake', 'handshake']);
});

test('a token stored before the stamp existed counts as due', async (t) => {
  // Its age is unknown, and one login makes it known. Otherwise the first
  // install of this build would run on into the 18-hour refusal it exists to
  // avoid.
  const { ws, events } = makeWs(t, null);

  await ws.connectOrThrow(() => {});

  assert.deepEqual(events, ['login', 'handshake']);
});

test('a failed renewal still handshakes, and waits before trying again', async (t) => {
  let attempts = 0;
  const { ws, stats, events } = makeWs(t, 16, {
    login: async () => { attempts++; throw new Error('login failed'); },
  });

  // Until the limit itself the session in hand still works, so a failed
  // renewal must not cost the connection.
  await ws.connectOrThrow(() => {});
  assert.deepEqual(events, ['handshake']);
  assert.equal(attempts, 1);
  assert.equal(stats.logins.failed, 1);

  // Not on every idle cycle after it.
  t.mock.timers.tick(ws.SESSION_RENEW_RETRY - 1000);
  await ws.connectOrThrow(() => {});
  assert.equal(attempts, 1, 'a failed renewal must not be retried on the next idle cycle');

  t.mock.timers.tick(2000);
  await ws.connectOrThrow(() => {});
  assert.equal(attempts, 2, 'but it must be retried once the wait is over');
});

test('the wait after a failed renewal survives the client being replaced', async (t) => {
  const { ws: old } = makeWs(t, 16, { login: async () => { throw new Error('login failed'); } });
  await old.connectOrThrow(() => {});

  let attempts = 0;
  const { ws: replacement } = makeWs(t, 16, { login: async () => { attempts++; } });
  replacement.restoreRateLimitState(old.getRateLimitState());
  await replacement.connectOrThrow(() => {});

  // The client is rebuilt on every recovery; a fresh one must not take the
  // failure as never having happened.
  assert.equal(attempts, 0);
});

test('an escalation after 429s is the login, not one of two', async (t) => {
  const { ws, stats, events } = makeWs(t, 17);
  ws._needsRelogin = true;

  await ws.connectOrThrow(() => {});

  assert.deepEqual(events, ['login', 'handshake'], 'one login per handshake, never two back to back');
  assert.equal(stats.logins.after429, 1);
  assert.equal(stats.logins.ahead, 0);
});
