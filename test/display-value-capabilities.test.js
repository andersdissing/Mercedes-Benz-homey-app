'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ProtoParser = require('../lib/proto/parser');
const { parseDisplayNumber } = require('../lib/display-value');

/**
 * distance_reset and electric_consumption_reset: distance and consumption
 * since the trip computer was reset, read from the attribute's display value
 * as mbapi2020 reads them, and added only once a car reports them.
 *
 * Reference values from the owner's Mercedes app when these were added:
 * 1430.7 km and 21.5 kWh/100 km.
 */

function loadDeviceClass() {
  const homeyPath = require.resolve('homey');
  require.cache[homeyPath] = {
    id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: class {} },
  };
  return require('../drivers/mercedes-vehicle/device');
}

function makeDevice({ already = [], failToAdd = [] } = {}) {
  const MercedesVehicleDevice = loadDeviceClass();
  const device = Object.create(MercedesVehicleDevice.prototype);

  const caps = new Map(['distance_start', 'average_speed', 'alarm_generic', ...already].map((c) => [c, null]));
  device.caps = caps;
  device.added = [];
  device.logs = [];
  device.hasCapability = (id) => caps.has(id);
  device.addCapability = async (id) => {
    if (failToAdd.includes(id)) throw new Error(`could not add ${id}`);
    device.added.push(id);
    caps.set(id, null);
  };
  device.setCapabilityValue = async (id, value) => {
    if (!caps.has(id)) throw new Error(`Invalid Capability: ${id}`);
    caps.set(id, value);
  };
  device.getCapabilityValue = (id) => (caps.has(id) ? caps.get(id) : null);
  device.log = (...args) => device.logs.push(args.join(' '));
  device.error = (...args) => device.logs.push(args.join(' '));
  device.homey = {
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    i18n: { getLanguage: () => 'en' },
  };
  return device;
}

/** What the parser hands the device for the reference values. */
const REPORTED = {
  distanceReset: 1430.7,
  distanceReset_display: '1430.7',
  distanceReset_unit: 'KILOMETERS',
  electricconsumptionreset: 21.49,
  electricconsumptionreset_display: '21.5',
  electricconsumptionreset_unit: 'KWH_PER_100KM',
};

// --- reading the display value ----------------------------------------------

test('display values are read whatever separators the locale uses', () => {
  const cases = [
    ['1430.7', 1430.7],
    ['1,430.7', 1430.7],
    ['1.430,7', 1430.7],
    ['1 430,7', 1430.7],
    ['1 430,7', 1430.7],
    ['1,430', 1430],
    ['1.430.250', 1430250],
    ['21.5', 21.5],
    ['21,5', 21.5],
    ['99.9', 99.9],
    [18.53, 18.53],
  ];
  for (const [shown, expected] of cases) {
    assert.equal(parseDisplayNumber(shown), expected, JSON.stringify(shown));
  }
});

test('a display value with no number in it is not a number', () => {
  for (const shown of ['', '-', 'n/a', '--.-', null, undefined, '1,5,3']) {
    assert.ok(Number.isNaN(parseDisplayNumber(shown)), JSON.stringify(shown));
  }
});

test('the parser hands over the display values and the units they are in', async () => {
  const parser = new ProtoParser({ app: { log() {}, error() {} } });
  await parser.initialize();

  const frame = parser.PushMessage.encode({
    vepUpdates: {
      updates: {
        VIN1: {
          vin: 'VIN1',
          attributes: {
            distanceReset: { status: 0, doubleValue: 1430.7, displayValue: '1430.7', distanceUnit: 1 },
            electricconsumptionreset: {
              status: 0, doubleValue: 21.49, displayValue: '21.5', electricityConsumptionUnit: 1,
            },
          },
        },
      },
    },
  }).finish();

  const message = parser.parsePushMessage(frame);
  const data = parser.extractVehicleData(message.vepUpdates.updates.VIN1, frame);

  assert.equal(data.distanceReset_display, '1430.7');
  assert.equal(data.distanceReset_unit, 'KILOMETERS');
  assert.equal(data.electricconsumptionreset_display, '21.5');
  assert.equal(data.electricconsumptionreset_unit, 'KWH_PER_100KM');
});

// --- the device ---------------------------------------------------------------

test('a car that never reports them never gets the capabilities', async () => {
  const device = makeDevice();

  await device.updateCapabilities({ distancestart: 12.4, soc: 80 });
  await device.updateCapabilities({ chargingactive: true });

  assert.equal(device.hasCapability('distance_reset'), false);
  assert.equal(device.hasCapability('electric_consumption_reset'), false);
});

test('the first report adds both and shows the figures the Mercedes app shows', async () => {
  const device = makeDevice();

  await device.updateCapabilities(REPORTED);
  assert.deepEqual(device.added.sort(), ['distance_reset', 'electric_consumption_reset']);
  assert.equal(device.caps.get('distance_reset'), 1430.7);
  assert.equal(device.caps.get('electric_consumption_reset'), 21.5, 'the display value, not the raw 21.49');

  await device.updateCapabilities({ ...REPORTED, distanceReset_display: '1,452.3' });
  assert.equal(device.added.length, 2, 'added once, not on every push');
  assert.equal(device.caps.get('distance_reset'), 1452.3);
});

test('either spelling of the attribute name is read', async () => {
  const device = makeDevice();

  await device.updateCapabilities({
    distancereset: 1430.7,
    distancereset_display: '1430.7',
    electricConsumptionReset: 21.49,
    electricConsumptionReset_display: '21.5',
  });
  assert.equal(device.caps.get('distance_reset'), 1430.7);
  assert.equal(device.caps.get('electric_consumption_reset'), 21.5);
});

test('a distance in miles is not shown under km, and is said once', async () => {
  const device = makeDevice();

  await device.updateCapabilities({ distanceReset_display: '889.0', distanceReset_unit: 'MILES' });
  await device.updateCapabilities({ distanceReset_display: '890.2', distanceReset_unit: 'MILES' });

  assert.equal(device.hasCapability('distance_reset'), false);
  assert.equal(device.logs.filter((l) => l.includes('distance since reset arrives in MILES')).length, 1);
});

test('one capability that cannot be added does not cost the others', async () => {
  const device = makeDevice({ failToAdd: ['distance_reset'] });

  await device.updateCapabilities(REPORTED);
  assert.equal(device.caps.get('electric_consumption_reset'), 21.5);
  assert.ok(device.logs.some((l) => l.includes('Error updating distance since reset')));
});

test('trip consumption is still read alongside them, 99.9 and all', async () => {
  const device = makeDevice();

  await device.updateCapabilities({
    ...REPORTED,
    electricconsumptionstart: 99.9,
    electricconsumptionstart_display: '99.9',
    electricconsumptionstart_unit: 'KWH_PER_100KM',
  });
  assert.equal(device.caps.get('electric_consumption_start'), 99.9, 'the car\'s own figure, left as it is');
});

// --- definitions --------------------------------------------------------------

test('pairing does not hand them out: they are not in the driver\'s capability list', () => {
  const compose = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'mercedes-vehicle', 'driver.compose.json'), 'utf8',
  ));
  assert.ok(!compose.capabilities.includes('distance_reset'));
  assert.ok(!compose.capabilities.includes('electric_consumption_reset'));
});

test('both are read-only, logged to Insights, with the titles asked for', () => {
  const read = (id) => JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '.homeycompose', 'capabilities', `${id}.json`), 'utf8',
  ));

  const distance = read('distance_reset');
  assert.equal(distance.units.en, 'km');
  assert.equal(distance.title.no, 'Distanse siden tilbakestilling');

  const consumption = read('electric_consumption_reset');
  assert.equal(consumption.units.en, 'kWh/100 km');
  assert.equal(consumption.title.no, 'Forbruk siden tilbakestilling');

  for (const definition of [distance, consumption]) {
    assert.equal(definition.type, 'number');
    assert.equal(definition.setable, false);
    assert.equal(definition.getable, true);
    assert.equal(definition.insights, true);
    assert.equal(definition.decimals, 1);
  }
});
