'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StatsTimeline } = require('../lib/stats-timeline');

/**
 * A car "wakes" when it reports a newer vtime - its own clock at its last
 * report. Each one is counted in the connection timeline (w) beside the
 * app's handshakes (h), to see whether the app's activity wakes the car.
 */

const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);

function makeDevice() {
  const homeyPath = require.resolve('homey');
  require.cache[homeyPath] = { id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: class {} } };
  const MercedesVehicleDevice = require('../drivers/mercedes-vehicle/device');
  const device = Object.create(MercedesVehicleDevice.prototype);
  const caps = new Map([['distance_start', null], ['average_speed', null], ['alarm_generic', null]]);
  const store = {};
  const timeline = new StatsTimeline({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
  timeline.load();
  device.timeline = timeline;
  device.logs = [];
  device.hasCapability = (id) => caps.has(id);
  device.addCapability = async (id) => { caps.set(id, null); };
  device.setCapabilityValue = async (id, value) => { caps.set(id, value); };
  device.getCapabilityValue = (id) => (caps.has(id) ? caps.get(id) : null);
  device.log = (...args) => device.logs.push(args.join(' '));
  device.error = (...args) => device.logs.push(args.join(' '));
  device.homey = {
    app: { getStatsTimeline: () => timeline },
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    i18n: { getLanguage: () => 'en' },
  };
  return device;
}

const wakes = (device) => device.timeline.toJSON().hours.reduce((n, r) => n + (r.w || 0), 0);

test('a newer vtime is a wake; the first after a start, and the same again, are not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const device = makeDevice();

  await device.updateCapabilities({ vtime: 1792027385 }); // first sighting: nothing to compare with
  await device.updateCapabilities({ vtime: 1792027385 }); // unchanged
  await device.updateCapabilities({ soc: 60 }); // no vtime at all
  assert.equal(wakes(device), 0);

  await device.updateCapabilities({ vtime: 1792031000 });
  assert.equal(wakes(device), 1);
  assert.ok(device.logs.some((l) => l.includes('counted as a wake')));
});

test('an older vtime (the poll lagging the push) is not a wake, and does not reset the comparison', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const device = makeDevice();

  await device.updateCapabilities({ vtime: 1792031000 });
  await device.updateCapabilities({ vtime: 1792027385 }); // older, from the poll
  await device.updateCapabilities({ vtime: 1792031000 }); // the push's value again
  assert.equal(wakes(device), 0);

  await device.updateCapabilities({ vtime: 1792034600 });
  assert.equal(wakes(device), 1);
});
