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
