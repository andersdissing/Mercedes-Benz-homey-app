'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MercedesAPI = require('../lib/api');

/**
 * REST rate limiting is tracked on its own, from actual HTTP 429 answers.
 *
 * The app used to have no REST window at all: the poll borrowed the
 * WebSocket's, which meant it stopped for a limit that was never about these
 * endpoints, and would have kept hammering one that was.
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

test('REST is not blocked until REST says 429', () => {
  const api = makeApi();

  assert.equal(api.getRestRateLimitRemaining(), 0);

  api._noteRestResult({ response: { status: 503 } });
  assert.equal(api.getRestRateLimitRemaining(), 0, 'only a 429 opens the window');

  api._noteRestResult({ message: 'socket hang up' }); // no HTTP answer at all
  assert.equal(api.getRestRateLimitRemaining(), 0, 'a transport failure is not a rate limit');
});

test('a REST 429 opens a backoff window', () => {
  const api = makeApi();

  api._noteRestResult({ response: { status: 429 } });

  const remaining = api.getRestRateLimitRemaining();
  assert.ok(remaining > 0, 'a 429 must pause polling');
  assert.ok(remaining <= api.REST_RATE_LIMIT_BACKOFF);
});

test('consecutive REST 429s widen the window, capped', () => {
  const api = makeApi();

  api._noteRestResult({ response: { status: 429 } });
  const first = api.getRestRateLimitRemaining();

  api._noteRestResult({ response: { status: 429 } });
  const second = api.getRestRateLimitRemaining();

  // A window that never grows is a closed loop: it expires, the app pokes the
  // limiter once, and starts another window of exactly the same length.
  assert.ok(second > first, `second window (${second}) must exceed the first (${first})`);

  for (let i = 0; i < 20; i++) api._noteRestResult({ response: { status: 429 } });
  assert.ok(
    api.getRestRateLimitRemaining() <= api.MAX_REST_RATE_LIMIT_BACKOFF,
    'an unbounded window would strand the poll permanently',
  );
});

test('a successful REST call ends the block and the escalation', () => {
  const api = makeApi();

  api._noteRestResult({ response: { status: 429 } });
  api._noteRestResult({ response: { status: 429 } });
  assert.ok(api.getRestRateLimitRemaining() > 0, 'precondition: blocked');

  api._noteRestResult(null);

  assert.equal(api.getRestRateLimitRemaining(), 0, 'a 200 means the limit has cleared');
  assert.equal(api._restRateLimitStrikes, 0, 'the next block must start at the shortest window');
});

test('an elapsed REST window reopens polling', () => {
  const api = makeApi();

  api._noteRestResult({ response: { status: 429 } });
  api._restBlockedUntil = Date.now() - 1000;

  assert.equal(api.getRestRateLimitRemaining(), 0, 'the window must expire on its own');
});

test('a Retry-After on the 429 replaces the ten-minute guess', () => {
  const api = makeApi();

  api._noteRestResult({ response: { status: 429, headers: { 'retry-after': '45' } } });

  const remaining = api.getRestRateLimitRemaining();
  assert.ok(
    remaining > 40000 && remaining <= 45000,
    `window (${remaining} ms) must be the 45s Mercedes asked for - pausing for ten minutes `
    + 'instead costs the user nine and a half minutes of stale battery, range and position',
  );
});

test('an absurd or zero Retry-After is clamped', () => {
  const hot = makeApi();
  hot._noteRestResult({ response: { status: 429, headers: { 'retry-after': '0' } } });
  assert.ok(
    hot.getRestRateLimitRemaining() > 1000,
    'Retry-After: 0 must not turn the poll into a hot retry loop',
  );

  const forever = makeApi();
  forever._noteRestResult({ response: { status: 429, headers: { 'retry-after': '999999' } } });
  assert.ok(
    forever.getRestRateLimitRemaining() <= forever.MAX_REST_RATE_LIMIT_BACKOFF,
    'nothing the server says may pause polling past the app\'s own cap',
  );
});

test('an unreadable Retry-After falls back to the app\'s own backoff', () => {
  const api = makeApi();

  api._noteRestResult({ response: { status: 429, headers: { 'retry-after': 'soon' } } });

  const remaining = api.getRestRateLimitRemaining();
  assert.ok(
    remaining > 500000,
    `a value the app cannot read is no answer (${remaining} ms must be the 10-minute window)`,
  );
});

test('a REST header that keeps being refused through stops shortening the wait', () => {
  const api = makeApi();

  const refuse = () => api._noteRestResult({
    response: { status: 429, headers: { 'retry-after': '10' } },
  });

  refuse();
  assert.ok(api.getRestRateLimitRemaining() <= 10000, 'the first one is taken at its word');

  refuse();
  refuse();

  assert.ok(
    api.getRestRateLimitRemaining() > 60000,
    'a limiter that keeps saying "ten seconds" and refusing anyway is the fixed-window loop again',
  );
});

test('a WebSocket 429 does not pause REST', () => {
  const api = makeApi();

  api._wsRateLimitState = { blockedUntil: Date.now() + 3600000, strikes: 4 };

  assert.equal(
    api.getRestRateLimitRemaining(),
    0,
    'the endpoints answer 200 through a refused upgrade - conflating the two froze everything',
  );
});
