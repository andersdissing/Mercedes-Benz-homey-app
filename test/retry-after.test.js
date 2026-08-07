'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRetryAfter, resolveBackoff, describeRateLimitHeaders } = require('../lib/retry-after');

/**
 * The header the app spent three releases not reading (issue #71).
 *
 * Every backoff window was invented: the only thing taken off a rate-limited
 * handshake was the status code, scraped out of an error message string. If
 * Mercedes says how long to wait, that number beats any ladder we can guess -
 * but only if it is read correctly, and only if a wrong or hostile value
 * cannot do more damage than the guess it replaces.
 */

test('delta-seconds is the common form', () => {
  assert.equal(parseRetryAfter('120'), 120000);
  assert.equal(parseRetryAfter(30), 30000);
  assert.equal(parseRetryAfter('  45  '), 45000);
  assert.equal(parseRetryAfter('0'), 0, 'zero is a real answer: "you may retry now"');
});

test('the HTTP-date form is resolved against now', () => {
  const now = Date.parse('Fri, 07 Aug 2026 12:00:00 GMT');

  assert.equal(
    parseRetryAfter('Fri, 07 Aug 2026 12:02:00 GMT', now),
    120000,
    'RFC 9110 allows either form and servers use both',
  );

  assert.equal(
    parseRetryAfter('Fri, 07 Aug 2026 11:00:00 GMT', now),
    0,
    'a date already past means the block has lifted, not that time runs backwards',
  );
});

test('anything unreadable is no answer at all', () => {
  // Falling back to the app's own backoff is safe. Salvaging a number out of
  // a value we do not understand is not: parseInt('3 weeks') is 3.
  assert.equal(parseRetryAfter('3 weeks'), null);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter('-5'), null, 'a negative delta is malformed, not urgent');
  assert.equal(parseRetryAfter('12.5'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('   '), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(null), null);
});

test('a duplicated header arrives as an array', () => {
  assert.equal(parseRetryAfter(['60', '90']), 60000);
});

test('with no header the app keeps its own window', () => {
  const { ms, askedMs } = resolveBackoff({
    retryAfterMs: null,
    fallbackMs: 90000,
    minMs: 5000,
    maxMs: 1800000,
  });

  assert.equal(ms, 90000);
  assert.equal(askedMs, null, 'the log has to be able to say which of the two it used');
});

test('a server that answers the question is believed, even when it is quicker', () => {
  const { ms } = resolveBackoff({
    retryAfterMs: 20000,
    fallbackMs: 600000,
    minMs: 5000,
    maxMs: 1800000,
  });

  // This is the entire point of reading the header. The routine 429 - the one
  // every app restart earns - clears in seconds, and a guessed ten-minute
  // ladder charges the user for a block that was already over.
  assert.equal(ms, 20000);
});

test('a zero or absurd value cannot be taken literally', () => {
  const hot = resolveBackoff({ retryAfterMs: 0, fallbackMs: 30000, minMs: 5000, maxMs: 1800000 });
  assert.equal(hot.ms, 5000, 'Retry-After: 0 must not become a hot retry loop');

  const forever = resolveBackoff({
    retryAfterMs: 86400000, // a day
    fallbackMs: 30000,
    minMs: 5000,
    maxMs: 1800000,
  });
  assert.equal(forever.ms, 1800000, 'nothing may pin the app offline past its own cap');
});

test('a header that keeps being wrong stops being trusted', () => {
  // A limiter that says "5 seconds", refuses again, says "5 seconds" again is
  // the fixed-window loop of #69 wearing a header: it expires, the app knocks
  // once, and another identical window opens. The app's own ladder has to keep
  // widening underneath and take over as a floor.
  const trusted = resolveBackoff({
    retryAfterMs: 5000,
    fallbackMs: 270000,
    minMs: 5000,
    maxMs: 1800000,
    trusted: true,
  });
  assert.equal(trusted.ms, 5000);

  const distrusted = resolveBackoff({
    retryAfterMs: 5000,
    fallbackMs: 270000,
    minMs: 5000,
    maxMs: 1800000,
    trusted: false,
  });
  assert.equal(distrusted.ms, 270000, 'the ladder becomes a floor, never a ceiling');

  // Still a floor and not a replacement: a longer stated wait wins.
  const longer = resolveBackoff({
    retryAfterMs: 900000,
    fallbackMs: 270000,
    minMs: 5000,
    maxMs: 1800000,
    trusted: false,
  });
  assert.equal(longer.ms, 900000);
});

test('the fallback is capped even when it is the one being used', () => {
  const { ms } = resolveBackoff({
    retryAfterMs: null,
    fallbackMs: 99999999,
    minMs: 5000,
    maxMs: 1800000,
  });

  assert.equal(ms, 1800000);
});

test('rate-limit headers are summarised for the log', () => {
  assert.equal(
    describeRateLimitHeaders({ 'retry-after': '30', 'content-type': 'text/plain' }),
    'retry-after: 30',
  );

  // Whatever shape the limiter reports itself in, it belongs in the log: this
  // is the only evidence of what it actually wants.
  assert.equal(
    describeRateLimitHeaders({ 'x-ratelimit-reset': '1770000000' }),
    'x-ratelimit-reset: 1770000000',
  );

  assert.equal(describeRateLimitHeaders({ 'content-length': '0' }), 'none');
  assert.equal(describeRateLimitHeaders(), 'none');
});
