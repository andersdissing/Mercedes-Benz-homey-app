'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
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

test('an attribute using an undeclared field reports its field numbers', async () => {
  const { parser, lines } = makeParser();
  await parser.initialize();

  // A VehicleAttributeStatus carrying only field 22, a length-delimited value
  // this schema does not declare - the shape chargePrograms arrives in. status
  // is left at its proto3 default of 0, i.e. the car considers it valid.
  const inner = protobuf.Writer.create().uint32((1 << 3) | 0).uint64(80).finish();
  const attrBytes = protobuf.Writer.create().uint32((22 << 3) | 2).bytes(inner).finish();

  // PushMessageRaw mirrors PushMessage's field numbers, so encoding through it
  // produces a frame the real PushMessage decoder accepts.
  const frame = parser.PushMessageRaw.encode({
    vepUpdates: { updates: { VIN1: { vin: 'VIN1', attributes: { chargePrograms: attrBytes } } } },
  }).finish();

  const message = parser.parsePushMessage(frame);
  const vepUpdate = message.vepUpdates.updates.VIN1;

  // Decoding drops the undeclared field, which is the whole problem.
  assert.equal(vepUpdate.attributes.chargePrograms.attributeType, undefined);

  const data = parser.extractVehicleData(vepUpdate, frame);
  assert.ok(!('chargePrograms' in data));

  const reported = lines.filter(l => l.includes('No value read for "chargePrograms"'));
  assert.equal(reported.length, 1);
  assert.match(reported[0], /raw fields: 22:\{1:varint=80\}/);
});

test('a missing raw frame degrades to the plain report', async () => {
  const { parser, lines } = makeParser();
  await parser.initialize();

  parser.extractVehicleData({
    vin: 'VIN1',
    emitTimestampInMs: 1,
    fullUpdate: true,
    attributes: { chargePrograms: attr({}) },
  });

  const reported = lines.filter(l => l.includes('No value read for "chargePrograms"'));
  assert.equal(reported.length, 1);
  assert.ok(!reported[0].includes('raw fields'), 'no frame, no field numbers - but still reported');
});

test('chargePrograms decodes from the byte layout a real vehicle sends', async () => {
  const { parser } = makeParser();
  await parser.initialize();

  // Rebuilt from an observed payload:
  //   31:{ 1:{2:varint=100} 1:{1:varint=1 2:varint=100} 1:{1:varint=2 2:varint=100} }
  // The first entry omits field 1, so its charge program is the proto3 default 0.
  const program = (chargeProgram, maxSoc) => {
    const writer = protobuf.Writer.create();
    if (chargeProgram !== undefined) writer.uint32((1 << 3) | 0).uint64(chargeProgram);
    writer.uint32((2 << 3) | 0).uint64(maxSoc);
    return writer.finish();
  };

  const programs = protobuf.Writer.create();
  for (const entry of [program(undefined, 100), program(1, 100), program(2, 100)]) {
    programs.uint32((1 << 3) | 2).bytes(entry);
  }
  const attrBytes = protobuf.Writer.create()
    .uint32((31 << 3) | 2).bytes(programs.finish())
    .finish();

  const frame = parser.PushMessageRaw.encode({
    vepUpdates: { updates: { VIN1: { vin: 'VIN1', attributes: { chargePrograms: attrBytes } } } },
  }).finish();

  const message = parser.parsePushMessage(frame);
  const data = parser.extractVehicleData(message.vepUpdates.updates.VIN1, frame);

  assert.deepEqual(data.chargePrograms, [
    { chargeProgram: 0, maxSoc: 100 },
    { chargeProgram: 1, maxSoc: 100 },
    { chargeProgram: 2, maxSoc: 100 },
  ]);
});

test('a decoded chargePrograms attribute is no longer reported as unreadable', async () => {
  const { parser, lines } = makeParser();
  await parser.initialize();

  const frame = parser.PushMessage.encode({
    vepUpdates: {
      updates: {
        VIN1: {
          vin: 'VIN1',
          attributes: {
            chargePrograms: {
              status: 0,
              chargeProgramsValue: { chargeProgramParameters: [{ chargeProgram: 3, maxSoc: 80 }] },
            },
          },
        },
      },
    },
  }).finish();

  const message = parser.parsePushMessage(frame);
  const data = parser.extractVehicleData(message.vepUpdates.updates.VIN1, frame);

  assert.deepEqual(data.chargePrograms, [{ chargeProgram: 3, maxSoc: 80 }]);
  assert.equal(lines.filter(l => l.includes('No value read for "chargePrograms"')).length, 0);
});
