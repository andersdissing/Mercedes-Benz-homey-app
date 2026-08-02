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

  // The bytes come along too. The summary is an interpretation, and when the
  // interpretation is wrong - as it was for temperaturePoints in issue #61 -
  // the payload is the only way to find that out without another capture.
  assert.match(reported[0], new RegExp(`raw hex: ${attrBytes.toString('hex')}`));
});

test('an unreadable attribute reports the strings and numbers it carries', async () => {
  const { parser, lines } = makeParser();
  await parser.initialize();

  // temperaturePoints, the attribute issue #61 could not get a usable dump of:
  // a zone string and a temperature per entry. The old walker read the leading
  // `f` of "frontLeft" as a tag byte and reported `1:{12:?wire6}`, naming
  // neither.
  const { temperaturePoints } = require('./fixtures/issue-61-attributes');

  const frame = parser.PushMessageRaw.encode({
    vepUpdates: {
      updates: { VIN1: { vin: 'VIN1', attributes: { temperaturePoints: temperaturePoints.bytes } } },
    },
  }).finish();

  const message = parser.parsePushMessage(frame);
  parser.extractVehicleData(message.vepUpdates.updates.VIN1, frame);

  const reported = lines.filter(l => l.includes('No value read for "temperaturePoints"'));
  assert.equal(reported.length, 1);
  assert.match(reported[0], /1:"frontLeft"/);
  assert.match(reported[0], /2:fixed64=21\.5\(dbl\)/);
  assert.ok(!reported[0].includes('?wire6'), 'a string field must not be walked as a message');
});

test('an undeclared field holding opaque bytes is reported, not walked into', async () => {
  const { parser, lines } = makeParser();
  await parser.initialize();

  const { len } = require('./fixtures/issue-61-attributes');

  // Field 45 is undeclared, and its payload is neither a message nor text.
  // Reporting it as bytes is the correct answer; guessing at a structure is
  // what produced `?wire6`.
  const attrBytes = len(45, Buffer.from([0xff, 0x00, 0xfe, 0x81]));

  const frame = parser.PushMessageRaw.encode({
    vepUpdates: { updates: { VIN1: { vin: 'VIN1', attributes: { odd: attrBytes } } } },
  }).finish();

  const message = parser.parsePushMessage(frame);
  const data = parser.extractVehicleData(message.vepUpdates.updates.VIN1, frame);

  assert.ok(!('odd' in data));

  const reported = lines.filter(l => l.includes('No value read for "odd"'));
  assert.equal(reported.length, 1);
  assert.match(reported[0], /raw fields: 45:len\(4\)=0xff00fe81/);
});

test('a VIN inside a reported attribute survives neither as text nor as hex', async () => {
  const { parser, lines } = makeParser();
  await parser.initialize();

  const { redactText } = require('../lib/log-redactor');
  const { len } = require('./fixtures/issue-61-attributes');

  // The report now carries the payload as hex as well as a decoded summary, so
  // both are new places a VIN could reach the log. log-redactor scans hex runs
  // for exactly this reason - hex, not base64, is why.
  const vin = 'WDD1234567890ABCD';
  const attrBytes = len(45, len(1, vin));

  const frame = parser.PushMessageRaw.encode({
    vepUpdates: { updates: { VIN1: { vin: 'VIN1', attributes: { withVin: attrBytes } } } },
  }).finish();

  parser.extractVehicleData(parser.parsePushMessage(frame).vepUpdates.updates.VIN1, frame);

  const reported = lines.filter(l => l.includes('No value read for "withVin"'));
  assert.equal(reported.length, 1);
  assert.ok(reported[0].includes(vin), 'the raw line does carry it - redaction is what removes it');

  const redacted = redactText(reported[0]);
  assert.ok(!redacted.includes(vin), 'plaintext VIN must not survive');
  assert.ok(!redacted.includes(Buffer.from(vin, 'ascii').toString('hex')), 'hex-encoded VIN must not survive');
});

test('a diagnostic never breaks the update path', async () => {
  const { parser } = makeParser();
  await parser.initialize();

  // An attribute always decodes as a VehicleAttributeStatus by the time it
  // reaches here - a frame that did not would have failed in parsePushMessage
  // first - so the bytes are fed to the describer directly. Whatever it is
  // handed, an update must not be lost to its own diagnostic.
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([0xff]),
    Buffer.from([0x0a, 0x28]), // claims 40 bytes that are not there
    Buffer.from([(12 << 3) | 6]), // the impossible wire type from issue #61
    null,
  ]) {
    assert.doesNotThrow(() => parser._describeRawAttribute(bytes));
  }
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
