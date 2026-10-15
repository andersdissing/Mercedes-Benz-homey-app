'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * starter_battery_state: the 12 V battery as the car rates it
 * (starterBatteryState 0-4), added the first time a car sends it.
 */

const root = path.join(__dirname, '..');
const definition = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/capabilities/starter_battery_state.json'), 'utf8'));
const ids = definition.values.map((v) => v.id);

function makeDevice({ already = false } = {}) {
  const homeyPath = require.resolve('homey');
  require.cache[homeyPath] = { id: homeyPath, filename: homeyPath, loaded: true, exports: { Device: class {} } };
  const MercedesVehicleDevice = require('../drivers/mercedes-vehicle/device');
  const device = Object.create(MercedesVehicleDevice.prototype);

  const caps = new Map(['distance_start', 'average_speed', 'alarm_generic', ...(already ? ['starter_battery_state'] : [])].map((c) => [c, null]));
  device.caps = caps;
  device.added = [];
  device.logs = [];
  device.hasCapability = (id) => caps.has(id);
  device.addCapability = async (id) => { device.added.push(id); caps.set(id, null); };
  device.setCapabilityValue = async (id, value) => {
    if (!caps.has(id)) throw new Error(`Invalid Capability: ${id}`);
    if (id === 'starter_battery_state' && !ids.includes(value)) throw new Error(`invalid enum value ${value}`);
    caps.set(id, value);
  };
  device.getCapabilityValue = (id) => (caps.has(id) ? caps.get(id) : null);
  device.log = (...args) => device.logs.push(args.join(' '));
  device.error = (...args) => device.logs.push(args.join(' '));
  device.homey = { flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) }, i18n: { getLanguage: () => 'en' } };
  return device;
}

test('the definition: read-only enum 0-4 with the agreed titles, logged to Insights', () => {
  assert.equal(definition.type, 'enum');
  assert.deepEqual(definition.title, { en: '12 V battery', no: '12 V batteri' });
  assert.deepEqual(definition.values.map((v) => [v.id, v.title.en, v.title.no]), [
    ['0', 'Green', 'Grønn'],
    ['1', 'Yellow', 'Gul'],
    ['2', 'Red', 'Rød'],
    ['3', 'Orange', 'Oransje'],
    ['4', 'Green-Yellow', 'Grønn-gul'],
  ]);
  assert.equal(definition.setable, false);
  assert.equal(definition.getable, true);
  assert.equal(definition.insights, true);

  const compose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/mercedes-vehicle/driver.compose.json'), 'utf8'));
  assert.ok(!compose.capabilities.includes('starter_battery_state'), 'not handed out at pairing');
});

test('a car that never sends it never gets the capability', async () => {
  const device = makeDevice();
  await device.updateCapabilities({ soc: 60, distancestart: 52.5 });
  assert.equal(device.hasCapability('starter_battery_state'), false);
});

test('the first report adds it and sets the state; later ones only update it', async () => {
  const device = makeDevice();

  await device.updateCapabilities({ starterBatteryState: 1 });
  assert.deepEqual(device.added, ['starter_battery_state']);
  assert.equal(device.caps.get('starter_battery_state'), '1');

  for (const code of [0, 2, 3, 4]) {
    await device.updateCapabilities({ starterBatteryState: code });
    assert.equal(device.caps.get('starter_battery_state'), String(code));
  }
  assert.equal(device.added.length, 1, 'added once');
});

test('a device that already has it is not given it again', async () => {
  const device = makeDevice({ already: true });
  await device.updateCapabilities({ starterbatterystate: 0 });
  assert.deepEqual(device.added, []);
  assert.equal(device.caps.get('starter_battery_state'), '0');
});

test('a code outside 0-4 is logged once and not written', async () => {
  const device = makeDevice({ already: true });
  await device.updateCapabilities({ starterBatteryState: 1 });
  await device.updateCapabilities({ starterBatteryState: 7 });
  await device.updateCapabilities({ starterBatteryState: 7 });

  assert.equal(device.caps.get('starter_battery_state'), '1', 'the last known state stays');
  assert.equal(device.logs.filter((l) => l.includes('Unknown 12 V battery state 7')).length, 1);
  assert.equal(device.logs.filter((l) => /Error updating 12 V/.test(l)).length, 0);
});
