'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * The REST poll stands down for a REST rate limit, and for nothing else.
 *
 * v1.1.42 paused it whenever the *WebSocket* was rate-limited, on the theory
 * that Mercedes limits the account rather than one endpoint. The app's own
 * captures say otherwise: the upgrade comes back 429 while the widget and
 * geofencing endpoints answer 200 in the same second, and the three-day
 * outage in issue #69 polled successfully throughout. Pausing therefore
 * bought nothing and cost the user the only values still arriving - battery,
 * range and position went stale too, for as long as the block lasted, which
 * is what "every value shown is last-known" meant in the field.
 *
 * device.js cannot be required outside Homey (`Class extends value undefined`),
 * so these exercise the guard against a stand-in carrying the same logic.
 */

/** Minimal stand-in for the device's poll guard and refresh action. */
function makeDevice({ restBlockedFor = 0, wsBlockedFor = 0 } = {}) {
  const calls = { polls: 0, logs: [] };

  const device = {
    api: {
      getRestRateLimitRemaining: () => restBlockedFor,
      getWebSocketRateLimitRemaining: () => wsBlockedFor,
      getVehicleData: async () => { calls.polls++; return { soc: 50 }; },
    },
    log: (...args) => calls.logs.push(args.join(' ')),
    error: (...args) => calls.logs.push(args.join(' ')),

    async pollVehicleData() {
      const remaining = this.api.getRestRateLimitRemaining();
      if (remaining > 0) {
        this.log(
          `[POLL] Skipped - Mercedes is rate-limiting the data endpoints for another `
          + `${Math.ceil(remaining / 60000)} min.`,
        );
        return false;
      }
      await this.api.getVehicleData();
      return true;
    },

    async refreshDataAction() {
      const remaining = this.api.getRestRateLimitRemaining();
      if (remaining > 0) {
        const minutes = Math.ceil(remaining / 60000);
        throw new Error(
          `Mercedes is rate-limiting this account. Vehicle data cannot be refreshed for another `
          + `~${minutes} min, and refreshing now would extend the block.`,
        );
      }
      await this.pollVehicleData();
      return true;
    },
  };

  return { device, calls };
}

test('the poll is skipped while REST is rate-limited', async () => {
  const { device, calls } = makeDevice({ restBlockedFor: 20 * 60000 });

  const result = await device.pollVehicleData();

  assert.equal(result, false, 'a skipped poll must report that it did nothing');
  assert.equal(calls.polls, 0, 'no request may be made through a 429 block');
  assert.match(calls.logs.join('\n'), /Skipped/, 'the skip must be explained in the log');
});

test('the poll keeps running while only the push connection is rate-limited', async () => {
  const { device, calls } = makeDevice({ wsBlockedFor: 30 * 60000 });

  const result = await device.pollVehicleData();

  // The endpoints answer 200 throughout a WebSocket block. Skipping here is
  // what froze battery, range and position on top of the capabilities that
  // were already stale, for hours at a time.
  assert.equal(result, true, 'a refused socket is no reason to stop asking REST');
  assert.equal(calls.polls, 1);
});

test('the poll resumes once the window has elapsed', async () => {
  const { device, calls } = makeDevice();

  const result = await device.pollVehicleData();

  assert.equal(result, true);
  assert.equal(calls.polls, 1, 'an unblocked poll must still fetch');
});

test('a manual refresh fails loudly rather than silently doing nothing', async () => {
  const { device, calls } = makeDevice({ restBlockedFor: 35 * 60000 });

  // Returning true here would repeat the exact fault this release fixes:
  // a Flow reporting success for something that never happened.
  await assert.rejects(
    device.refreshDataAction(),
    /rate-limiting this account/,
    'the card must say why it refused',
  );
  assert.equal(calls.polls, 0);
});

test('a manual refresh does not force its way through a REST block', async () => {
  const { device, calls } = makeDevice({ restBlockedFor: 5 * 60000 });

  await device.refreshDataAction().catch(() => {});

  // One refresh card on a retry schedule would renew the block indefinitely,
  // which is the loop the release exists to break.
  assert.equal(calls.polls, 0, 'an explicit refresh must not bypass the backoff');
});

test('a manual refresh works while the push connection is blocked', async () => {
  const { device, calls } = makeDevice({ wsBlockedFor: 45 * 60000 });

  // This is the one escape hatch the user has while push is down. Refusing it
  // because of an unrelated limit left them with no way to get fresh data.
  assert.equal(await device.refreshDataAction(), true);
  assert.equal(calls.polls, 1);
});

test('the refusal states how long is left', async () => {
  const { device } = makeDevice({ restBlockedFor: 35 * 60000 });

  const error = await device.refreshDataAction().then(() => null, (e) => e);

  assert.ok(error, 'precondition: the refresh was refused');
  assert.match(error.message, /35 min/, 'a wait with no duration tells the user nothing');
});
