'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ProtoParser = require('../lib/proto/parser');

/**
 * electric_consumption_start: trip consumption in kWh/100 km, read from the
 * attribute's display value as mbapi2020 reads it, and added to a device only
 * once its car has actually reported it.
 */

/**
 * The real device class, loaded against a stand-in for the Homey runtime -
 * device.js cannot be required outside Homey otherwise.
 */
function loadDeviceClass() {
  const homeyPath = require.resolve('homey');
  require.cache[homeyPath] = {
    id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: class {} },
  };
  return require('../drivers/mercedes-vehicle/device');
}

/** A bare device with the capabilities a fresh pairing gives it. */
function makeDevice({ already = [] } = {}) {
  const MercedesVehicleDevice = loadDeviceClass();
  const device = Object.create(MercedesVehicleDevice.prototype);

  const caps = new Map(['distance_start', 'average_speed', 'alarm_generic', ...already].map((c) => [c, null]));
  device.caps = caps;
  device.added = [];
  device.logs = [];
  device.hasCapability = (id) => caps.has(id);
  device.addCapability = async (id) => { device.added.push(id); caps.set(id, null); };
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

/** What the parser hands the device for a car reporting 18.5 kWh/100 km. */
const REPORTED = {
  electricconsumptionstart: 18.53,
  electricconsumptionstart_display: '18.5',
  electricconsumptionstart_unit: 'KWH_PER_100KM',
};

test('the parser hands over the display value and the unit it is in', async () => {
  const lines = [];
  const parser = new ProtoParser({ app: { log: (...a) => lines.push(a.join(' ')), error() {} } });
  await parser.initialize();

  const frame = parser.PushMessage.encode({
    vepUpdates: {
      updates: {
        VIN1: {
          vin: 'VIN1',
          attributes: {
            electricconsumptionstart: {
              status: 0, doubleValue: 18.53, displayValue: '18.5', electricityConsumptionUnit: 1,
            },
          },
        },
      },
    },
  }).finish();

  const message = parser.parsePushMessage(frame);
  const data = parser.extractVehicleData(message.vepUpdates.updates.VIN1, frame);

  assert.equal(data.electricconsumptionstart_display, '18.5');
  assert.equal(data.electricconsumptionstart_unit, 'KWH_PER_100KM');
});

test('a car that never reports it never gets the capability', async () => {
  const device = makeDevice();

  await device.updateCapabilities({ distancestart: 12.4, soc: 80 });
  await device.updateCapabilities({ distancestart: 15.0 });
  await device.updateCapabilities({ chargingactive: true });

  assert.deepEqual(device.added.filter((c) => c === 'electric_consumption_start'), []);
  assert.equal(device.hasCapability('electric_consumption_start'), false);
  assert.equal(device.caps.get('distance_start'), 15, 'the trip distance beside it still updates');
});

test('the first report adds the capability and sets it; later ones only update it', async () => {
  const device = makeDevice();

  await device.updateCapabilities({ distancestart: 12.4, ...REPORTED });
  assert.deepEqual(device.added, ['electric_consumption_start']);
  assert.equal(device.caps.get('electric_consumption_start'), 18.5);

  await device.updateCapabilities({ ...REPORTED, electricconsumptionstart: 21.02, electricconsumptionstart_display: '21.0' });
  assert.deepEqual(device.added, ['electric_consumption_start'], 'added once, not on every push');
  assert.equal(device.caps.get('electric_consumption_start'), 21);
});

test('it reads the display value, as mbapi2020 does, not the raw number', async () => {
  const device = makeDevice();

  await device.updateCapabilities(REPORTED);
  assert.equal(device.caps.get('electric_consumption_start'), 18.5, 'the figure the Mercedes app shows');
});

test('a device that already has it (after a restart) is not given it again', async () => {
  const device = makeDevice({ already: ['electric_consumption_start'] });

  await device.updateCapabilities(REPORTED);
  assert.deepEqual(device.added, []);
  assert.equal(device.caps.get('electric_consumption_start'), 18.5);
});

test('a consumption in another unit is not shown under kWh/100 km', async () => {
  const device = makeDevice();

  await device.updateCapabilities({ ...REPORTED, electricconsumptionstart_display: '5.4', electricconsumptionstart_unit: 'KM_PER_KWH' });
  await device.updateCapabilities({ ...REPORTED, electricconsumptionstart_display: '5.6', electricconsumptionstart_unit: 'KM_PER_KWH' });

  assert.equal(device.hasCapability('electric_consumption_start'), false);
  assert.equal(device.logs.filter((l) => l.includes('arrives in KM_PER_KWH')).length, 1, 'said once');
});

test('pairing does not hand it out: it is not in the driver\'s capability list', () => {
  const compose = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'drivers', 'mercedes-vehicle', 'driver.compose.json'), 'utf8',
  ));
  assert.ok(compose.capabilities.includes('distance_start'));
  assert.ok(!compose.capabilities.includes('electric_consumption_start'));
});

test('the capability is read-only, in kWh/100 km, and logged to Insights', () => {
  const definition = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '.homeycompose', 'capabilities', 'electric_consumption_start.json'), 'utf8',
  ));
  assert.equal(definition.type, 'number');
  assert.equal(definition.setable, false);
  assert.equal(definition.getable, true);
  assert.equal(definition.insights, true);
  assert.equal(definition.units.en, 'kWh/100 km');
});
