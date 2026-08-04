'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * The REST poll must stand down while an HTTP 429 backoff window is open
 * (issue #69).
 *
 * The reported three-day outage polled steadily throughout - every 3 minutes,
 * all the way through a block that never lifted. Mercedes rate-limits the
 * account rather than one endpoint, so that traffic spends the budget the app
 * is waiting to get back.
 *
 * It also made the fault hard to see: the poll returns only the reduced widget
 * set, so battery, range and position stayed fresh while doors, windows, lock
 * and sunroof froze. The device looked like a car that had stopped reporting
 * rather than a connection that needed fixing.
 *
 * device.js cannot be required outside Homey (`Class extends value undefined`),
 * so these exercise the guard against a stand-in carrying the same logic.
 */

/** Minimal stand-in for the device's poll guard and refresh action. */
function makeDevice(blockedFor) {
  const calls = { polls: 0, logs: [] };

  const device = {
    api: {
      getWebSocketRateLimitRemaining: () => blockedFor,
      getVehicleData: async () => { calls.polls++; return { soc: 50 }; },
    },
    log: (...args) => calls.logs.push(args.join(' ')),
    error: (...args) => calls.logs.push(args.join(' ')),

    async pollVehicleData() {
      const remaining = this.api.getWebSocketRateLimitRemaining();
      if (remaining > 0) {
        this.log(`[POLL] Skipped - rate-limited by Mercedes for another ${Math.ceil(remaining / 60000)} min.`);
        return false;
      }
      await this.api.getVehicleData();
      return true;
    },

    async refreshDataAction() {
      const remaining = this.api.getWebSocketRateLimitRemaining();
      if (remaining > 0) {
        const minutes = Math.ceil(remaining / 60000);
        throw new Error(
          `Mercedes is rate-limiting this account. Vehicle data cannot be refreshed for another `
          + `~${minutes} min, and refreshing now would extend the block.`
        );
      }
      await this.pollVehicleData();
      return true;
    },
  };

  return { device, calls };
}

test('the poll is skipped while rate-limited', async () => {
  const { device, calls } = makeDevice(20 * 60000);

  const result = await device.pollVehicleData();

  assert.equal(result, false, 'a skipped poll must report that it did nothing');
  assert.equal(calls.polls, 0, 'no request may be made through a 429 block');
  assert.match(calls.logs.join('\n'), /Skipped - rate-limited/, 'the skip must be explained in the log');
});

test('the poll resumes once the window has elapsed', async () => {
  const { device, calls } = makeDevice(0);

  const result = await device.pollVehicleData();

  assert.equal(result, true);
  assert.equal(calls.polls, 1, 'an unblocked poll must still fetch');
});

test('a manual refresh fails loudly rather than silently doing nothing', async () => {
  const { device, calls } = makeDevice(35 * 60000);

  // Returning true here would repeat the exact fault this release fixes:
  // a Flow reporting success for something that never happened.
  await assert.rejects(
    device.refreshDataAction(),
    /rate-limiting this account/,
    'the card must say why it refused',
  );
  assert.equal(calls.polls, 0);
});

test('a manual refresh does not force its way through the block', async () => {
  const { device, calls } = makeDevice(5 * 60000);

  await device.refreshDataAction().catch(() => {});

  // One refresh card on a retry schedule would renew the block indefinitely,
  // which is the loop the release exists to break.
  assert.equal(calls.polls, 0, 'an explicit refresh must not bypass the backoff');
});

test('the refusal states how long is left', async () => {
  const { device } = makeDevice(35 * 60000);

  const error = await device.refreshDataAction().then(() => null, (e) => e);

  assert.ok(error, 'precondition: the refresh was refused');
  assert.match(error.message, /35 min/, 'a wait with no duration tells the user nothing');
});
