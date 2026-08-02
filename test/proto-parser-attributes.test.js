'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ProtoParser = require('../lib/proto/parser');

/**
 * Tests for attribute extraction out of a VEPUpdate.
 *
 * measure_max_soc stayed null for a vehicle that was pushing a `maxSoc`
 * attribute on every full update. The attribute reached the parser and left it
 * without a value, so the key never existed downstream and nothing anywhere
 * said so - meanwhile maxSocLowerLimit/maxSocUpperLimit, plain ints, worked.
 * An attribute we cannot read is now reported once per key.
 */

function makeParser() {
  const lines = [];
  const homey = { app: { log: (...args) => lines.push(args.join(' ')), error() {} } };
  return { parser: new ProtoParser(homey), lines };
}

function attr(fields) {
  return { timestamp: 1, changed: true, status: 0, displayValue: '', ...fields };
}

test('scalar attributes are extracted, unreadable ones are dropped', () => {
  const { parser } = makeParser();

  const data = parser.extractVehicleData({
    vin: 'VIN1',
    emitTimestampInMs: 1234,
    fullUpdate: true,
    attributes: {
      maxSocUpperLimit: attr({ intValue: 100, attributeType: 'intValue' }),
      chargingactive: attr({ boolValue: true, attributeType: 'boolValue' }),
      serviceintervaldistance: attr({ nilValue: true, attributeType: 'nilValue' }),
    },
  });

  assert.equal(data.maxSocUpperLimit, 100);
  assert.equal(data.chargingactive, true);
  assert.ok(!('serviceintervaldistance' in data), 'a nil attribute must not reach the device');
});

test('an attribute with no readable value is reported once per key', () => {
  const { parser, lines } = makeParser();

  const update = {
    vin: 'VIN1',
    emitTimestampInMs: 1234,
    fullUpdate: true,
    attributes: {
      // No attribute_type set at all - what a field this .proto does not
      // declare decodes to. This is the shape that hid maxSoc.
      maxSoc: attr({}),
    },
  };

  parser.extractVehicleData(update);
  parser.extractVehicleData(update);
  parser.extractVehicleData(update);

  const reported = lines.filter(l => l.includes('No value read for "maxSoc"'));
  assert.equal(reported.length, 1, 'must report once, not once per push');
  assert.match(reported[0], /attributeType: none/);
});

test('each unreadable key is reported separately', () => {
  const { parser, lines } = makeParser();

  parser.extractVehicleData({
    vin: 'VIN1',
    emitTimestampInMs: 1234,
    fullUpdate: true,
    attributes: {
      maxSoc: attr({}),
      chargePrograms: attr({}),
      temperaturePoints: attr({}),
    },
  });

  const reported = lines.filter(l => l.includes('No value read for'));
  assert.equal(reported.length, 3);
});
