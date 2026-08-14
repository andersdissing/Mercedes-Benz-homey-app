'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describePushStaleness, formatDuration, formatWait } = require('../lib/staleness-message');

/**
 * The staleness warning has to keep counting.
 *
 * It was raised once, at the one-hour mark, and an early return skipped every
 * later health tick - so the banner still read "for 60 minutes" hours into an
 * outage, beside a retry countdown frozen at whatever it said that minute.
 * Neither number was miscalculated; the message just stopped being rewritten.
 * The device now re-renders this on every tick and writes it when it changes,
 * which only helps if the text actually moves with the clock.
 */

test('the message changes as the outage goes on', () => {
  const first = describePushStaleness({ downForMs: 3600000, wsBlockedFor: 1800000 });
  const later = describePushStaleness({ downForMs: 3900000, wsBlockedFor: 1500000 });

  assert.notEqual(first, later, 'a frozen string is what put "60 minutes" on screen for six hours');
});

test('a tick where nothing moved renders identically', () => {
  // What lets the device skip a pointless write, rather than re-setting the
  // same warning every five minutes for the length of the outage.
  const a = describePushStaleness({ downForMs: 3600000, wsBlockedFor: 1800000 });
  const b = describePushStaleness({ downForMs: 3600000, wsBlockedFor: 1800000 });

  assert.equal(a, b);
});

test('past an hour the elapsed time is said in hours', () => {
  assert.equal(formatDuration(59 * 60000), '59 minutes');
  assert.equal(formatDuration(60 * 60000), '1 hour');
  assert.equal(formatDuration(125 * 60000), '2 hours 5 min');
  assert.equal(formatDuration(180 * 60000), '3 hours');

  // "for 360 minutes" is a number nobody converts in their head - and this
  // warning only ever appears after the first hour.
  assert.match(describePushStaleness({ downForMs: 6 * 3600000 }), /6 hours/);
});

test('a short wait is not rounded up to a minute', () => {
  // The first backoff window is 30s. Reporting it as "~1 min" overstates a
  // wait that can end while the sentence is still being read.
  assert.equal(formatWait(30000), '~30s');
  assert.equal(formatWait(90000), '~2 min');
  assert.equal(formatWait(1800000), '~30 min');
});

test('the message names what is actually stale', () => {
  const restBlocked = describePushStaleness({
    downForMs: 3600000,
    wsBlockedFor: 1800000,
    restBlockedFor: 600000,
  });
  assert.match(restBlocked, /paused its data requests/);
  assert.match(restBlocked, /last-known/);

  // A refused push connection leaves battery, range and position live. Saying
  // "all updates are paused" for that case is the half-truth this warning
  // exists to end.
  const pushBlocked = describePushStaleness({ downForMs: 3600000, wsBlockedFor: 1800000 });
  assert.match(pushBlocked, /battery, range and position keep updating/);
  assert.match(pushBlocked, /~30 min/);

  const noLimit = describePushStaleness({ downForMs: 3600000 });
  assert.match(noLimit, /Battery, range and position still update/);
  assert.doesNotMatch(noLimit, /429/, 'no rate limit is in play, so do not blame one');
});
