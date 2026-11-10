'use strict';

// #91: ZevPrecondStop.type was declared at field 1, so every stop went out as
// `08 03` - which Mercedes reads as type UNKNOWN (0), and the car kept running
// its climate. mbapi2020's vehicle_commands_pb2.py has
// ZEVPreconditioningStop.type = 2 (checked against master, Nov 2026), with
// CommandRequest.zev_preconditioning_stop = 22 and NOW = 3.
//
// The expected bytes are written out by hand from that reference, not taken
// from the app's schema: a wrong schema would otherwise agree with itself.
// Regression test contributed in the issue by diehassenhaeuser-dev.

const test = require('node:test');
const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const ProtoParser = require('../lib/proto/parser');

function wireFields(buffer) {
  const fields = [];
  let offset = 0;
  function varint() {
    let value = 0, shift = 0, byte;
    do {
      assert.ok(offset < buffer.length, 'truncated varint');
      byte = buffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      assert.ok(shift <= 49, 'unexpected large varint');
    } while (byte & 0x80);
    return value;
  }
  while (offset < buffer.length) {
    const tag = varint(), number = tag >>> 3, type = tag & 7;
    if (type === 0) fields.push({ number, type, value: varint() });
    else if (type === 2) {
      const length = varint();
      assert.ok(offset + length <= buffer.length, 'truncated message');
      fields.push({ number, type, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else assert.fail(`unexpected wire type ${type}`);
  }
  return fields;
}

function nested(buffer, number) {
  const matches = wireFields(buffer).filter(f => f.number === number && f.type === 2);
  assert.equal(matches.length, 1, `one message at field ${number}`);
  return matches[0].value;
}

async function parser() {
  const instance = new ProtoParser({ app: { log() {}, error() {} } });
  await instance.initialize();
  // Empty ids keep the encoded bytes deterministic.
  instance._generateRequestId = () => '';
  return instance;
}

test('stop preconditioning encodes NOW at field 2, not field 1', async () => {
  const p = await parser();
  const command = p.createStopPrecondCommand('');
  assert.equal(command.commandName, 'zevPrecondStop');
  const stop = nested(nested(command.buffer, 3), 22);
  assert.deepEqual([...stop], [0x10, 0x03], 'Stop(NOW) must be 10 03');
  assert.deepEqual(wireFields(stop), [{ number: 2, type: 0, value: 3 }]);
});

test('a decoder built from the reference layout reads NOW out of the stop', async () => {
  const p = await parser();
  const stop = nested(nested(p.createStopPrecondCommand('').buffer, 3), 22);
  const ReferenceStop = protobuf.parse(`syntax = "proto3";
    message ReferenceStop { enum Kind { UNKNOWN = 0; NOW = 3; } Kind type = 2; }
  `).root.lookupType('ReferenceStop');
  const decoded = ReferenceStop.toObject(ReferenceStop.decode(stop), { defaults: true });
  assert.equal(decoded.type, 3, 'receiver must not see default UNKNOWN=0');
  const oldEncoding = ReferenceStop.toObject(ReferenceStop.decode(Buffer.from([0x08, 0x03])), { defaults: true });
  assert.equal(oldEncoding.type, 0, 'the old field-1 encoding reads as UNKNOWN');
});

test('start preconditioning keeps its reference bytes', async () => {
  const p = await parser();
  const command = p.createStartPrecondCommand('');
  assert.equal(command.commandName, 'zevPrecondStart');
  const start = nested(nested(command.buffer, 3), 21);
  assert.deepEqual([...start], [0x08, 0x00, 0x10, 0x03]);
});

test('auxiliary-heater start and stop keep their fields and empty payloads', async () => {
  const p = await parser();
  assert.equal(nested(nested(p.createStartClimateCommand('').buffer, 3), 2).length, 0);
  assert.equal(nested(nested(p.createStopClimateCommand('').buffer, 3), 3).length, 0);
});
