'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Flow cards for the new figures: "12 V battery changed" and "Trip ended"
 * (triggers), "12 V battery is at least", "Consumption since reset is
 * above" and "Distance since reset is above" (conditions). No actions:
 * nothing in Mercedes' command set resets the trip counters.
 */

const root = path.join(__dirname, '..');
const card = (kind, id) => JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/flow', kind, `${id}.json`), 'utf8'));

function stubHomeyModule() {
  const homeyPath = require.resolve('homey');
  require.cache[homeyPath] = {
    id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: class {}, Driver: class {} },
  };
}

function makeDevice({ language = 'en', caps: initial = {} } = {}) {
  stubHomeyModule();
  const MercedesVehicleDevice = require('../drivers/mercedes-vehicle/device');
  const device = Object.create(MercedesVehicleDevice.prototype);
  const caps = new Map(Object.entries({ distance_start: null, average_speed: null, alarm_generic: null, ...initial }));
  device.caps = caps;
  device.triggers = [];
  device.logs = [];
  device.vin = 'VIN1';
  device.hasCapability = (id) => caps.has(id);
  device.addCapability = async (id) => { caps.set(id, null); };
  device.setCapabilityValue = async (id, value) => { caps.set(id, value); };
  device.getCapabilityValue = (id) => (caps.has(id) ? caps.get(id) : null);
  device.unsetWarning = async () => {};
  device.log = (...args) => device.logs.push(args.join(' '));
  device.error = (...args) => device.logs.push(args.join(' '));
  device.homey = {
    flow: { getDeviceTriggerCard: (id) => ({ trigger: async (d, tokens) => { device.triggers.push({ id, tokens }); } }) },
    i18n: { getLanguage: () => language },
  };
  return device;
}

const fired = (device, id) => device.triggers.filter((t) => t.id === id);

// --- definitions -------------------------------------------------------------

test('every new card is in English and Norwegian, and only offered for cars that have the figure', () => {
  const expected = {
    'triggers/starter_battery_changed': 'starter_battery_level',
    'triggers/trip_ended': 'electric_consumption_start',
    'conditions/starter_battery_at_least': 'starter_battery_level',
    'conditions/consumption_reset_above': 'electric_consumption_reset',
    'conditions/distance_reset_above': 'distance_reset',
  };
  for (const [file, capability] of Object.entries(expected)) {
    const [kind, id] = file.split('/');
    const def = card(kind, id);
    assert.ok(def.title.en && def.title.no, `${id}: title en/no`);
    const deviceArg = def.args.find((a) => a.type === 'device');
    assert.equal(deviceArg.filter, `driver_id=mercedes-vehicle&capabilities=${capability}`, id);
  }
  assert.equal(card('triggers', 'starter_battery_changed').title.no, '12 V-batteriet endret seg');
  assert.equal(card('triggers', 'trip_ended').title.no, 'Tur avsluttet');
  assert.deepEqual(card('triggers', 'trip_ended').tokens.map((t) => [t.name, t.type, t.title.no]), [
    ['distance_start', 'number', 'Kjørt strekning fra start (km)'],
    ['driving_time_start', 'number', 'Kjøretid fra start (min)'],
    ['consumption_start', 'number', 'Gjennomsnittsforbruk fra start (kWh/100 km)'],
    ['energy_start', 'number', 'Energi fra start (kWh)'],
    ['average_speed_start', 'number', 'Gjennomsnittshastighet fra start (km/h)'],
  ], 'named as the car names them: the figures can cover more than one drive');
  assert.deepEqual(card('conditions', 'starter_battery_at_least').args[1].values.map((v) => [v.id, v.label.no]), [
    ['1', 'Grønn-gul'], ['2', 'Gul'], ['3', 'Oransje'], ['4', 'Rød'],
  ]);
});

test('the driver registers the three conditions and they ask the device', async () => {
  stubHomeyModule();
  const MercedesVehicleDriver = require('../drivers/mercedes-vehicle/driver');
  const driver = Object.create(MercedesVehicleDriver.prototype);
  const listeners = {};
  const cardStub = (id) => ({ registerRunListener: (fn) => { listeners[id] = fn; return cardStub(id); } });
  driver.homey = { flow: { getActionCard: cardStub, getConditionCard: cardStub, getDeviceTriggerCard: cardStub } };
  driver.log = () => {};
  driver.error = (...args) => { throw new Error(args.join(' ')); };
  driver._registerFlowCards();

  const calls = [];
  const device = {
    starterBatteryAtLeast: async (n) => { calls.push(['at least', n]); return true; },
    consumptionResetAbove: async (n) => { calls.push(['consumption', n]); return false; },
    distanceResetAbove: async (n) => { calls.push(['distance', n]); return true; },
  };
  assert.equal(await listeners.starter_battery_at_least({ device, colour: '3' }), true);
  assert.equal(await listeners.consumption_reset_above({ device, consumption: 20 }), false);
  assert.equal(await listeners.distance_reset_above({ device, distance: 1000 }), true);
  assert.deepEqual(calls, [['at least', 3], ['consumption', 20], ['distance', 1000]]);
});

// --- trigger: 12 V battery changed --------------------------------------------

test('12 V battery changed: fires on a real change, with level by severity and the colour', async () => {
  const device = makeDevice();

  await device.updateCapabilities({ starterBatteryState: 1 }); // first reading
  await device.updateCapabilities({ starterBatteryState: 1 }); // the same again
  assert.equal(fired(device, 'starter_battery_changed').length, 0, 'neither is a change');

  await device.updateCapabilities({ starterBatteryState: 2 }); // yellow -> red
  assert.deepEqual(fired(device, 'starter_battery_changed').map((t) => t.tokens), [{ level: 4, colour: 'Red' }]);

  await device.updateCapabilities({ starterBatteryState: 7 }); // unknown code
  assert.equal(fired(device, 'starter_battery_changed').length, 1, 'an unknown code changes nothing');
});

test('12 V battery changed: the colour is in the Homey\'s language', async () => {
  const device = makeDevice({ language: 'no' });
  await device.updateCapabilities({ starterBatteryState: 0 });
  await device.updateCapabilities({ starterBatteryState: 4 });
  assert.deepEqual(fired(device, 'starter_battery_changed')[0].tokens, { level: 1, colour: 'Grønn-gul' });
});

// --- trigger: trip ended --------------------------------------------------------

const DRIVE = {
  distanceStart: 52.5, drivenTimeStart: 101, averageSpeedStart: 31,
  electricconsumptionstart: 21.53, electricconsumptionstart_display: '21.5', electricconsumptionstart_unit: 'KWH_PER_100KM',
};

test('trip ended: fires as soon as all four figures are in after the ignition goes off', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = makeDevice();

  device._trackTrip({ ignitionstate: 4, ...DRIVE, distanceStart: 30 });
  device._trackTrip({ ignitionstate: 0, distanceStart: 52.5 });
  assert.equal(fired(device, 'trip_ended').length, 0, 'still waiting for three figures');

  device._trackTrip({ drivenTimeStart: 101, averageSpeedStart: 31, electricconsumptionstart_display: '21.5', electricconsumptionstart: 21.53 });
  assert.deepEqual(fired(device, 'trip_ended').map((x) => x.tokens), [{
    distance_start: 52.5, driving_time_start: 101, consumption_start: 21.5, energy_start: 11.29, average_speed_start: 31,
  }]);
  t.mock.timers.tick(200000);
  assert.equal(fired(device, 'trip_ended').length, 1, 'and only once - the wait was cancelled');
});

test('trip ended: does not hang when a figure never comes - it goes with the latest after 3 minutes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = makeDevice();

  device._trackTrip({ ignitionstate: 4, ...DRIVE });
  device._trackTrip({ ignitionstate: 0 }); // nothing else ever arrives

  t.mock.timers.tick(179999);
  assert.equal(fired(device, 'trip_ended').length, 0);
  t.mock.timers.tick(1);
  assert.equal(fired(device, 'trip_ended').length, 1);
  assert.equal(fired(device, 'trip_ended')[0].tokens.distance_start, 52.5);
  assert.ok(device.logs.some((l) => l.includes('Trip ended (timeout)')));
});

test('trip ended: a figure never seen at all means no trigger, not a made-up value', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = makeDevice();

  device._trackTrip({ ignitionstate: 4, distanceStart: 10, drivenTimeStart: 20, averageSpeedStart: 30 });
  device._trackTrip({ ignitionstate: 0 });
  t.mock.timers.tick(180000);
  assert.equal(fired(device, 'trip_ended').length, 0);
  assert.ok(device.logs.some((l) => l.includes('without consumption')));
});

test('trip ended: a new trip starts empty - a figure from the last trip never stands in', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = makeDevice();

  // Trip 1 has every figure.
  device._trackTrip({ ignitionstate: 4, ...DRIVE });
  device._trackTrip({ ignitionstate: 0, ...DRIVE });
  assert.equal(fired(device, 'trip_ended').length, 1);

  // Trip 2 never sends a consumption figure.
  device._trackTrip({ ignitionstate: 4, distanceStart: 12, drivenTimeStart: 20, averageSpeedStart: 36 });
  device._trackTrip({ ignitionstate: 0 });
  t.mock.timers.tick(180000);
  assert.equal(fired(device, 'trip_ended').length, 1, 'trip 2 does not fire on trip 1\'s consumption');
  assert.ok(device.logs.some((l) => l.includes('without consumption')));
});

test('trip ended: trips under 2 km and consumption 99.9 are skipped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const short = makeDevice();
  short._trackTrip({ ignitionstate: 4, ...DRIVE, distanceStart: 1.9 });
  short._trackTrip({ ignitionstate: 0, ...DRIVE, distanceStart: 1.9 });
  assert.equal(fired(short, 'trip_ended').length, 0);

  const noFigure = makeDevice();
  noFigure._trackTrip({ ignitionstate: 4, ...DRIVE });
  noFigure._trackTrip({ ignitionstate: 0, ...DRIVE, electricconsumptionstart: 99.9, electricconsumptionstart_display: '99.9' });
  assert.equal(fired(noFigure, 'trip_ended').length, 0);
});

test('trip ended: the ignition back on before the end cancels it; off without a drive is no trip', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = makeDevice();

  device._trackTrip({ ignitionstate: 0, ...DRIVE }); // parked, never driven in this run
  device._trackTrip({ ignitionstate: 4 });
  device._trackTrip({ ignitionstate: 0 });
  device._trackTrip({ ignitionstate: 4 }); // restarted within the wait
  t.mock.timers.tick(600000);
  assert.equal(fired(device, 'trip_ended').length, 0);
});

test('trip ended: comes from push only - the poll\'s older ignition state starts nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = makeDevice();

  await device.updateCapabilities({ ignitionstate: 4, ...DRIVE }); // as pollVehicleData applies it
  await device.updateCapabilities({ ignitionstate: 0, ...DRIVE });
  t.mock.timers.tick(600000);
  assert.equal(fired(device, 'trip_ended').length, 0);

  await device.onWebSocketData('VIN1', { ignitionstate: 4, ...DRIVE }, false);
  await device.onWebSocketData('VIN1', { ignitionstate: 0, ...DRIVE }, false);
  assert.equal(fired(device, 'trip_ended').length, 1, 'the push path fires it');
});

test('trip ended: a device going away does not fire later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = makeDevice();
  device._stopWebSocketHealthCheck = () => {};

  device._trackTrip({ ignitionstate: 4, ...DRIVE });
  device._trackTrip({ ignitionstate: 0 });
  await device._releaseSession();
  t.mock.timers.tick(600000);
  assert.equal(fired(device, 'trip_ended').length, 0);
});

// --- conditions ------------------------------------------------------------------

test('12 V battery is at least: compares the level by severity', async () => {
  const device = makeDevice({ caps: { starter_battery_level: 2 } }); // yellow
  assert.equal(await device.starterBatteryAtLeast(1), true, 'at least green-yellow');
  assert.equal(await device.starterBatteryAtLeast(2), true, 'at least yellow');
  assert.equal(await device.starterBatteryAtLeast(3), false, 'not at least orange');

  const unknown = makeDevice();
  assert.equal(await unknown.starterBatteryAtLeast(1), false, 'no reading is not a warning');
});

test('consumption and distance since reset are above: strictly above the threshold', async () => {
  const device = makeDevice({ caps: { electric_consumption_reset: 21.5, distance_reset: 1430.7 } });
  assert.equal(await device.consumptionResetAbove(20), true);
  assert.equal(await device.consumptionResetAbove(21.5), false);
  assert.equal(await device.distanceResetAbove(1000), true);
  assert.equal(await device.distanceResetAbove(1500), false);

  const none = makeDevice();
  assert.equal(await none.consumptionResetAbove(0), false);
  assert.equal(await none.distanceResetAbove(0), false);
});
