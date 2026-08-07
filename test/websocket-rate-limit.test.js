'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MercedesWebSocket = require('../lib/websocket');

/**
 * Regression tests for the HTTP 429 backoff (issue #69).
 *
 * The real failure: a user's app spent three days refusing to reconnect.
 * Every 10 minutes it retried the handshake, collected another 429, and
 * opened another window of exactly the same length. Meanwhile the REST poll
 * kept working, so battery and range stayed fresh while doors, windows, lock
 * state and sunroof - which only arrive over the socket - were frozen for
 * days. These tests pin the escape route: the window has to widen, survive
 * the client being rebuilt, and not be handshaked through.
 */

function makeWs() {
  const homey = { app: { log() {}, error() {} } };
  const oauth = { getAccessToken: async () => 'token', refreshToken: async () => {} };
  return new MercedesWebSocket(homey, oauth, 'Europe', {});
}

test('the first window is short enough to survive a restart', () => {
  const ws = makeWs();

  ws._registerRateLimit();

  // Nearly every 429 the app sees is the one it earns by restarting while its
  // previous session is still open at Mercedes; that clears in seconds. A
  // ten-minute opening window charged every app update for a block that was
  // already over - and, with the poll standing down too, showed the user a
  // frozen car for ten minutes each time.
  assert.ok(
    ws.getRateLimitRemaining() <= 60000,
    `first window (${ws.getRateLimitRemaining()} ms) must not punish a restart`,
  );
});

test('consecutive 429s widen the backoff window', () => {
  const ws = makeWs();

  ws._registerRateLimit();
  const first = ws.getRateLimitRemaining();

  // The original bug: the second window was the same length as the first,
  // and so was the thousandth.
  ws._registerRateLimit();
  const second = ws.getRateLimitRemaining();

  ws._registerRateLimit();
  const third = ws.getRateLimitRemaining();

  assert.ok(first > 0, 'a 429 must open a backoff window');
  assert.ok(second > first, `second window (${second}) must exceed the first (${first})`);
  assert.ok(third > second, `third window (${third}) must exceed the second (${second})`);
});

test('the backoff window is capped', () => {
  const ws = makeWs();

  for (let i = 0; i < 20; i++) ws._registerRateLimit();

  assert.ok(
    ws.getRateLimitRemaining() <= ws.MAX_RATE_LIMIT_BACKOFF,
    'an unbounded window would strand the app permanently, which is the bug in mirror image',
  );
});

test('a successful connection clears the strike count', () => {
  const ws = makeWs();

  ws._registerRateLimit();
  ws._registerRateLimit();

  // What the 'open' handler does.
  ws.accountBlocked = false;
  ws.blockedSinceTime = null;
  ws.blockedFor = 0;
  ws.rateLimitStrikes = 0;

  ws._registerRateLimit();

  assert.equal(
    ws.getRateLimitRemaining(),
    ws.RATE_LIMIT_BACKOFF,
    'a 429 after a healthy connection starts over at the shortest window',
  );
});

test('an elapsed window makes re-authentication available again', () => {
  const ws = makeWs();

  ws._registerRateLimit();
  ws._tokenRefreshAttempts = ws.MAX_TOKEN_REFRESH_ATTEMPTS;

  // Wind the window back so it has expired.
  ws.blockedSinceTime = Date.now() - ws.blockedFor - 1000;

  assert.equal(ws.getRateLimitRemaining(), 0, 'precondition: window elapsed');
  assert.equal(
    ws._tokenRefreshAttempts,
    0,
    'the refresh budget only reset on a successful open, which never comes while blocked',
  );
  assert.ok(ws.rateLimitStrikes > 0, 'strikes must survive so the next window is longer');
});

test('rate-limit state survives the client being replaced', () => {
  const old = makeWs();
  old._registerRateLimit();
  old._registerRateLimit();

  const state = old.getRateLimitState();
  const replacement = makeWs();
  replacement.restoreRateLimitState(state);

  assert.equal(
    replacement.rateLimitStrikes,
    old.rateLimitStrikes,
    'carrying only the deadline resets the escalation on every rebuild - the device health '
    + 'check rebuilds the client every 5 minutes',
  );

  // The inherited window must be served out as-is, not rounded back to the
  // default length.
  const inherited = replacement.getRateLimitRemaining();
  assert.ok(
    inherited > replacement.RATE_LIMIT_BACKOFF,
    `inherited window (${inherited}) must reflect the escalated one, not the default`,
  );
  assert.ok(inherited <= old.blockedFor, 'inherited window must not exceed what remained');
});

test('strikes travel even when no window is currently open', () => {
  const old = makeWs();
  old._registerRateLimit();
  old.blockedSinceTime = Date.now() - old.blockedFor - 1000;
  assert.equal(old.getRateLimitRemaining(), 0, 'precondition: window elapsed');

  const state = old.getRateLimitState();
  assert.ok(state, 'a client with strikes but no open window still has state worth carrying');

  const replacement = makeWs();
  replacement.restoreRateLimitState(state);
  replacement._registerRateLimit();

  assert.ok(
    replacement.getRateLimitRemaining() > replacement.RATE_LIMIT_BACKOFF,
    'the replacement must continue the escalation, not restart it',
  );
});

test('a reconnect firing into a live window re-arms instead of handshaking', async () => {
  const ws = makeWs();
  ws.messageHandler = () => {};

  let handshakes = 0;
  ws._createSocket = () => { handshakes++; throw new Error('should not handshake while blocked'); };

  // A 429 lands *after* the reconnect was scheduled, so the pending timer's
  // delay was computed before the window existed and is due immediately.
  // Capture the callback rather than waiting out ten real minutes.
  let fire = null;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => { fire = fn; return 'stub-timer'; };
  try {
    ws._scheduleReconnect();
  } finally {
    global.setTimeout = realSetTimeout;
  }

  ws._registerRateLimit();
  const attemptsBefore = ws.reconnectAttempts;

  assert.ok(fire, 'precondition: a reconnect is pending');
  await fire();

  try {
    assert.equal(handshakes, 0, 'must not handshake into a live rate-limit window');
    assert.ok(ws.reconnectTimer, 'must re-arm so the connection is not abandoned');
    assert.equal(
      ws.reconnectAttempts,
      attemptsBefore,
      'waiting out a window is not a failed attempt and must not inflate backoff',
    );
  } finally {
    if (ws.reconnectTimer) clearTimeout(ws.reconnectTimer);
  }
});

test('the backoff cap still lets the app knock regularly', () => {
  const ws = makeWs();

  for (let i = 0; i < 20; i++) ws._registerRateLimit();

  // The cap is the app's steady state for a block that never lifts. At two
  // hours the user was told to wait longer than most outages last; the point
  // of the cap is quiet, not silence.
  assert.ok(
    ws.getRateLimitRemaining() <= 1800000,
    'a blocked account must still be retried at least half-hourly',
  );
});

test('repeated refusals escalate from refreshing the token to logging in', async () => {
  const ws = makeWs();

  let relogins = 0;
  let refreshes = 0;
  ws.setReloginHandler(async () => { relogins++; });
  ws.oauth.refreshToken = async () => { refreshes++; };

  // Drive real 429s through the socket error handler, which is where the
  // escalation is decided.
  const refuse = async () => {
    ws._createSocket = () => {
      const socket = {
        handlers: {},
        on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; },
        close() {},
        removeAllListeners() { this.handlers = {}; },
      };
      // The upgrade is refused before anything is connected.
      setImmediate(() => {
        for (const fn of socket.handlers.error || []) {
          fn(new Error('Unexpected server response: 429'));
        }
      });
      return socket;
    };
    ws.accountBlocked = false; // let this attempt reach the handshake
    await ws.connectOrThrow(() => {}).catch(() => {});
    if (ws.reconnectTimer) {
      clearTimeout(ws.reconnectTimer);
      ws.reconnectTimer = null;
    }
  };

  // A refreshed token belongs to the session Mercedes is refusing, so the
  // first strikes only re-authenticate.
  await refuse();
  assert.equal(ws._needsRelogin, false, 'one refusal is not yet worth a login');

  // It takes a full login to be given a new session - the app's last lever
  // before it can only wait.
  for (let i = 1; i < ws.RELOGIN_AFTER_STRIKES; i++) await refuse();
  assert.equal(ws._needsRelogin, true, 'a block that outlasts refreshed tokens must escalate');

  await refuse();
  assert.ok(refreshes > 0, 'precondition: the cheap recovery was tried first');
  assert.equal(relogins, 1, 'the escalation must actually log in');

  await refuse();
  assert.equal(relogins, 1, 'and must not log in again on every later attempt');
});

test('the login budget survives the client being replaced', () => {
  const old = makeWs();
  old.setReloginHandler(async () => {});
  old._registerRateLimit();
  old._reloginAttempts = old.MAX_RELOGIN_ATTEMPTS;

  const replacement = makeWs();
  replacement.restoreRateLimitState(old.getRateLimitState());

  // The health check rebuilds the client every 5 minutes. A fresh budget each
  // time would turn "one login per episode" into a login every 5 minutes -
  // the heaviest request the app makes, aimed at a rate limiter.
  assert.equal(replacement._reloginAttempts, old.MAX_RELOGIN_ATTEMPTS);
});

test('a rebuilt client keeps the same push session identity', () => {
  const first = makeWs();
  const second = new (require('../lib/websocket'))(
    { app: { log() {}, error() {} } },
    { getAccessToken: async () => 'token' },
    'Europe',
    {},
    first.sessionId,
  );

  // Mercedes counts app sessions. Minting a new APP-SESSION-ID on every
  // rebuild meant an outage opened a new session every 5 minutes while the
  // earlier ones were still live - which is what a 429 on the upgrade says.
  assert.equal(second.sessionId, first.sessionId);
});

test('Mercedes\' own answer replaces the guessed window', () => {
  const ws = makeWs();

  ws._registerRateLimit(20000);

  const remaining = ws.getRateLimitRemaining();
  assert.ok(
    remaining > 15000 && remaining <= 20000,
    `window (${remaining} ms) must be the 20s asked for, not the 30s the app made up`,
  );
});

test('an honoured window is not rounded back up when the client is replaced', () => {
  const old = makeWs();
  old._registerRateLimit(10000);

  const replacement = makeWs();
  replacement.restoreRateLimitState(old.getRateLimitState());

  // The device health check rebuilds the client every 5 minutes. Inheriting
  // the strike count but not the window would put the app back on its own
  // ladder and undo the shorter wait Mercedes actually asked for.
  assert.ok(
    replacement.getRateLimitRemaining() <= 10000,
    'the inherited window must still be the one the server named',
  );
});

test('a Retry-After that keeps being refused through stops shortening the wait', () => {
  const ws = makeWs();

  // A limiter that says "5 seconds", refuses, says "5 seconds" again is the
  // fixed-window loop that froze an account for three days (#69) wearing a
  // header. The app's own ladder keeps widening underneath and takes over.
  ws._registerRateLimit(5000);
  const first = ws.getRateLimitRemaining();
  assert.ok(first <= 5000, `first window (${first}) should honour the header`);

  ws._registerRateLimit(5000);
  ws._registerRateLimit(5000);

  const third = ws.getRateLimitRemaining();
  assert.ok(
    third > 60000,
    `third window (${third}) must fall back to the escalating ladder, not stay at 5s`,
  );
});

test('a longer Retry-After is honoured even once the ladder has taken over', () => {
  const ws = makeWs();

  for (let i = 0; i < 3; i++) ws._registerRateLimit(600000);

  const remaining = ws.getRateLimitRemaining();
  assert.ok(
    remaining > 300000,
    `the ladder is a floor (${remaining} ms), not a ceiling - a server asking for longer gets it`,
  );
  assert.ok(remaining <= ws.MAX_RATE_LIMIT_BACKOFF, 'and the cap still applies');
});

test('a disposed client does not handshake anyway', async () => {
  const ws = makeWs();

  let handshakes = 0;
  ws._createSocket = () => { handshakes++; throw new Error('should not handshake after disposal'); };

  // disconnect() lands while connectOrThrow() is awaiting its token refresh -
  // exactly the gap a fired-but-awaiting reconnect timer leaves open, which
  // produced two upgrades ~200 ms apart against a rate limiter.
  ws._needsTokenRefresh = true;
  ws.oauth.refreshToken = async () => { ws.disconnect(); };

  await assert.rejects(ws.connectOrThrow(() => {}), /stopping/);
  assert.equal(handshakes, 0, 'a client told to stop must not connect');
});
