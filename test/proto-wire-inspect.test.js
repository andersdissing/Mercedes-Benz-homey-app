'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const wire = require('../lib/proto/wire-inspect');
const fixtures = require('./fixtures/issue-61-attributes');

const { vint, len, f64, f32, cat } = fixtures;

/**
 * Tests for the protobuf wire-format inspector - the tool that has to be right
 * before any of the five attributes in issue #61 can be declared, because it is
 * the only thing that says what field numbers and types they actually use.
 *
 * The first block is the important one. It runs the *replaced* walker against
 * the fixtures and asserts it produces the exact strings the issue was written
 * from. That is what makes the fixtures trustworthy: they are not a guess at
 * the payloads, they are payloads that provably render the way the real ones
 * did. Everything after it can then be read as "and here is what those same
 * bytes really contain".
 */

// ---------------------------------------------------------------------------
// A verbatim copy of ProtoParser._describeRawAttribute as it stood before this
// change. Kept only as a witness: it is what the issue's field dumps came out
// of, and pinning its behaviour is what proves the fixtures reproduce them.
// Do not fix anything in here.
// ---------------------------------------------------------------------------
const protobuf = require('protobufjs');

function legacyDescribe(bytes, depth = 0) {
  const parts = [];

  try {
    const reader = protobuf.Reader.create(bytes);

    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const field = tag >>> 3;
      const wireType = tag & 7;

      switch (wireType) {
        case 0:
          parts.push(`${field}:varint=${reader.uint64().toString()}`);
          break;
        case 1:
          reader.skip(8);
          parts.push(`${field}:fixed64`);
          break;
        case 2: {
          const sub = reader.bytes();
          const nested = depth < 3 ? legacyDescribe(sub, depth + 1) : null;
          parts.push(nested ? `${field}:{${nested}}` : `${field}:len(${sub.length})`);
          break;
        }
        case 5:
          reader.skip(4);
          parts.push(`${field}:fixed32`);
          break;
        default:
          parts.push(`${field}:?wire${wireType}`);
          return parts.join(' ');
      }
    }
  } catch (err) {
    parts.push('<truncated>');
  }

  return parts.join(' ');
}

test('the fixtures reproduce the field dumps issue #61 was written from', () => {
  for (const fixture of fixtures.all) {
    assert.equal(
      legacyDescribe(fixture.bytes),
      fixture.observedDescription,
      `${fixture.key} must render the way the issue reported it`,
    );
  }
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

test('a string field is read as a string instead of descended into', () => {
  const bytes = len(1, 'frontLeft');

  // The old walker read the `f` of "frontLeft" (0x66) as a tag: field 12, wire
  // type 6. Wire type 6 does not exist, so it gave up and reported nothing
  // else in the enclosing message.
  assert.equal(legacyDescribe(bytes), '1:{12:?wire6}');
  assert.equal(wire.formatFields(bytes), '1:"frontLeft"');
});

test('temperaturePoints decodes to zone strings and temperatures', () => {
  const described = wire.formatFields(fixtures.temperaturePoints.bytes);

  assert.equal(
    described,
    '20:{1:{1:"frontLeft" 2:fixed64=21.5(dbl) 3:"21.5"} 1:{1:"frontRight" 2:fixed64=21.5(dbl) 3:"21.5"}}',
  );

  // Nothing in the old output named a zone or carried a temperature - the two
  // things the attribute is actually for.
  assert.ok(!fixtures.temperaturePoints.observedDescription.includes('frontLeft'));
  assert.ok(!fixtures.temperaturePoints.observedDescription.includes('21.5'));
});

test('a fixed64 reports its value instead of only its wire type', () => {
  assert.equal(legacyDescribe(f64(2, 21.5)), '2:fixed64');
  assert.equal(wire.formatFields(f64(2, 21.5)), '2:fixed64=21.5(dbl)');
});

test('a fixed64 that is not a plausible double falls back to the integer reading', () => {
  // A millisecond timestamp stored as sfixed64. Read as a double those bytes
  // are about 8.4e-312, which is not a value any attribute means. Reporting
  // the integer instead is the honest reading.
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(1700000000000n, 0);

  const described = wire.formatFields(cat(Buffer.from([(2 << 3) | 1]), bytes));
  assert.equal(described, '2:fixed64=1700000000000(u64)');
});

test('a fixed32 reports its value', () => {
  assert.equal(legacyDescribe(f32(4, 1.5)), '4:fixed32');
  assert.equal(wire.formatFields(f32(4, 1.5)), '4:fixed32=1.5(flt)');
});

test('a negative varint shows its signed reading', () => {
  // The issue read 18446744073709551615 as an "unset" sentinel. It is -1
  // encoded as int64, and saying so is the difference between inventing a
  // sentinel convention and declaring a signed field.
  assert.equal(wire.formatFields(vint(3, -1)), '3:varint=18446744073709551615/-1');
  assert.equal(wire.formatFields(vint(3, -42)), '3:varint=18446744073709551574/-42');

  // A value that is not in the negative range is not annotated.
  assert.equal(wire.formatFields(vint(3, 380)), '3:varint=380');
});

test('the depth limit is reported as a depth limit, not as opaque bytes', () => {
  let nested = vint(9, 7);
  for (let i = 0; i < 6; i += 1) nested = len(1, nested);

  // The old walker stopped at three levels and printed the cut as `len(n)`,
  // which reads exactly like a field it genuinely could not interpret.
  assert.equal(legacyDescribe(nested), '1:{1:{1:{1:len(6)}}}');

  assert.equal(wire.formatFields(nested), '1:{1:{1:{1:{1:{1:{9:varint=7}}}}}}');
  assert.equal(wire.formatFields(nested, { maxDepth: 2 }), '1:{1:{1:len(8)=depth-limit}}');
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('an empty payload is not mistaken for a message', () => {
  assert.equal(wire.formatFields(len(9, Buffer.alloc(0))), '9:len(0)');
});

test('bytes that are neither message nor text are shown as hex', () => {
  const payload = Buffer.from([0xff, 0x00, 0xfe, 0x81]);
  assert.equal(wire.formatFields(len(7, payload)), '7:len(4)=0xff00fe81');
});

test('a long opaque payload is previewed, not dumped', () => {
  const payload = Buffer.alloc(64, 0xff);
  const described = wire.formatFields(len(7, payload));

  assert.match(described, /^7:len\(64\)=0x(ff){16}\.\.\.$/);
});

test('a long string is previewed, so one attribute cannot fill the log', () => {
  const text = 'frontLeft '.repeat(30);
  const described = wire.formatFields(len(7, text));

  assert.match(described, /^7:".{80}"\.\.\.\(300 chars\)$/);
  // The full text is still there in the tree, which is not what goes to the log.
  assert.ok(wire.formatTree(len(7, text)).includes(text));
});

test('a message with many fields is summarised, not printed in full', () => {
  // 300 `x` bytes are a valid message of 150 varint fields (0x78 is field 15,
  // wire type 0). Capping strings alone would not have bounded this.
  const described = wire.formatFields(len(7, 'x'.repeat(300)));

  assert.match(described, /\.\.\.\(\+126 fields\)/);
  assert.ok(described.length < 600, `summary was ${described.length} chars`);
});

test('the one-line summary has an absolute length bound', () => {
  // Deep nesting can still add up, so the summary is capped outright. The full
  // structure stays available from the raw hex, which is logged beside it.
  let nested = Buffer.alloc(0);
  for (let i = 0; i < 8; i += 1) {
    nested = len(1, cat(nested, ...Array.from({ length: 20 }, (unused, n) => vint(n + 2, 123456789))));
  }

  const described = wire.formatFields(nested, { maxDepth: 16 });
  assert.ok(described.length <= 1600, `summary was ${described.length} chars`);
  assert.match(described, /summary truncated; run tools\/inspect-attribute\.js/);
});

test('a payload that is both a valid message and a word is reported as both', () => {
  // "PP" is 0x50 0x50, which also parses as field 10 carrying varint 80. The
  // bytes really are ambiguous; silently picking one is what went wrong the
  // first time, so both readings are printed.
  const described = wire.formatFields(len(5, 'PP'));

  assert.equal(described, '5:{10:varint=80}~"PP"');
});

test('a message that does not read as a word carries no text hint', () => {
  // The chargePrograms shape from #58: the tag bytes are control characters,
  // so there is nothing to hedge about.
  assert.equal(wire.formatFields(len(31, cat(vint(1, 2), vint(2, 100)))), '31:{1:varint=2 2:varint=100}');
});

test('packed varints are recognised when they are not a valid message', () => {
  // 0xff 0xff 0x03 is varint 65535, which as a tag means wire type 7 - not a
  // message, not text, but a clean varint run.
  assert.equal(wire.formatFields(len(30, Buffer.from([0xff, 0xff, 0x03]))), '30:packed[65535]=0xffff03');
});

test('multi-byte UTF-8 text is read as text', () => {
  assert.equal(wire.formatFields(len(11, '21.5 °C')), '11:"21.5 °C"');
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test('a truncated payload reports how far it got and why it stopped', () => {
  // A field 1 varint, then a length-delimited field claiming 40 bytes that are
  // not there.
  const bytes = cat(vint(1, 2), Buffer.from([(3 << 3) | 2, 40]), Buffer.from([0x01, 0x02]));
  const described = wire.formatFields(bytes);

  // The offset names the start of the broken field, which is the byte to look
  // at in a hex dump - not whichever byte inside it happened to trip.
  assert.equal(described, '1:varint=2 !length-overrun@2(need 40, have 2)');
  assert.equal(bytes[2], (3 << 3) | 2, 'offset 2 is the tag of the field that failed');
});

test('an impossible wire type is named rather than swallowed', () => {
  assert.equal(wire.formatFields(Buffer.from([(12 << 3) | 6])), '!bad-wire-type-6@0');
});

test('a tag with field number zero is rejected', () => {
  assert.equal(wire.formatFields(Buffer.from([0x00, 0x01])), '!zero-field-number@0');
});

test('the inspector never throws, whatever the bytes', () => {
  // A cheap deterministic PRNG - no dependency, and the same cases every run.
  let seed = 0x2f6e2b1;
  const nextByte = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >>> 16) & 0xff;
  };

  for (let i = 0; i < 2000; i += 1) {
    const buf = Buffer.alloc(1 + (nextByte() % 48));
    for (let j = 0; j < buf.length; j += 1) buf[j] = nextByte();

    assert.doesNotThrow(() => wire.formatFields(buf), `threw on ${buf.toString('hex')}`);
    assert.doesNotThrow(() => wire.formatTree(buf), `tree threw on ${buf.toString('hex')}`);
    assert.doesNotThrow(() => wire.suggestProto(buf), `suggest threw on ${buf.toString('hex')}`);
  }
});

test('non-byte input is refused rather than crashing the update path', () => {
  assert.equal(wire.formatFields(null), '!not-bytes@0');
  assert.equal(wire.formatFields('not bytes'), '!not-bytes@0');
});

test('an empty buffer describes as nothing at all', () => {
  assert.equal(wire.formatFields(Buffer.alloc(0)), '');
});

// ---------------------------------------------------------------------------
// The other four attributes from the issue
// ---------------------------------------------------------------------------

test('tcuConnectionStateLowChannel is a plain varint at field 38', () => {
  assert.equal(wire.formatFields(fixtures.tcuConnectionStateLowChannel.bytes), '38:varint=3');
});

test('precondState is a single-field message at field 44', () => {
  assert.equal(wire.formatFields(fixtures.precondState.bytes), '44:{3:varint=1}');
});

test('weeklySetHU keeps the shape the issue reported', () => {
  assert.equal(
    wire.formatFields(fixtures.weeklySetHU.bytes),
    '24:{1:{2:varint=380} 1:{1:varint=1 2:varint=380} 1:{1:varint=2 2:varint=380} '
      + '1:{1:varint=3 2:varint=380} 1:{1:varint=4 2:varint=380}}',
  );
});

test('weeklyProfile shows its -1 fields as -1', () => {
  const described = wire.formatFields(fixtures.weeklyProfile.bytes);

  assert.match(described, /3:varint=18446744073709551615\/-1/);
  assert.match(described, /5:varint=18446744073709551615\/-1/);
  assert.match(described, /6:varint=18446744073709551615\/-1/);
});

test('weeklyProfile field 4 is not claimed to be a message', () => {
  // A live capture renders this as `4:{0:varint=1 <truncated>}` under the old
  // walker. Field number 0 does not exist in protobuf, so those bytes are not a
  // message and that reading was invented - the same failure as the zone
  // strings, one level down and easier to miss because it looks plausible.
  //
  // What field 4 holds is genuinely unknown, so this asserts what must NOT be
  // claimed rather than pinning a structure the capture does not support.
  const described = wire.formatFields(fixtures.weeklyProfile.bytes);

  assert.ok(!/4:\{/.test(described), 'must not report field 4 as a nested message');
  assert.ok(!described.includes('0:varint'), 'field number 0 must never appear');

  // Whatever reading it does offer, the bytes come with it so the reader can
  // judge for themselves.
  assert.match(described, /4:packed\[0,1,18,40\]=0x00011228/);
});

test('a packed reading always carries the bytes it was read from', () => {
  const described = wire.formatFields(len(30, Buffer.from([0xff, 0xff, 0x03])));

  assert.equal(described, '30:packed[65535]=0xffff03');
});

// ---------------------------------------------------------------------------
// Byte offsets
// ---------------------------------------------------------------------------

test('offsets are absolute, so they line up with a hex dump', () => {
  const bytes = fixtures.temperaturePoints.bytes;
  const tree = wire.inspect(bytes);

  const points = tree.fields[0];
  const second = points.fields[1];
  const zone = second.fields[0];

  assert.equal(zone.kind, 'string');
  assert.equal(zone.text, 'frontRight');
  // The offset must point at the string's bytes inside the whole attribute.
  assert.equal(bytes.subarray(zone.start, zone.end).toString('hex').includes('66726f6e74'), true);
  assert.equal(bytes.subarray(zone.end - 'frontRight'.length, zone.end).toString('utf8'), 'frontRight');
});

// ---------------------------------------------------------------------------
// Schema drafting
// ---------------------------------------------------------------------------

test('a schema draft names the repeated entry and the scalars inside it', () => {
  const draft = wire.suggestProto(fixtures.temperaturePoints.bytes, { name: 'TemperaturePointsValue' });

  // The entries repeat; the zone and temperature inside one entry do not. The
  // distinction only holds if occurrences are counted per entry rather than
  // across all of them.
  assert.match(draft, /repeated TemperaturePointsValue_20_1 f1 = 1;/);
  assert.match(draft, /^\s*string f1 = 1;/m);
  assert.match(draft, /^\s*double f2 = 2;/m);
  assert.ok(!/repeated string f1/.test(draft), 'a single zone per entry is not repeated');

  // Parents come before the messages they refer to.
  assert.ok(draft.indexOf('message TemperaturePointsValue {') < draft.indexOf('message TemperaturePointsValue_20 {'));
});

test('a schema draft flags a varint that only ever holds 0 or 1', () => {
  const draft = wire.suggestProto(len(44, vint(3, 1)));
  assert.match(draft, /int64 f3 = 3;.*may be bool/);
});

test('a schema draft refuses to guess when a field changes shape', () => {
  const draft = wire.suggestProto(len(1, cat(len(2, 'text'), len(2, cat(vint(9, 1))))));
  assert.match(draft, /bytes f2 = 2;.*AMBIGUOUS/);
});

test('a schema draft is valid protobuf that protobufjs can load', async () => {
  const draft = wire.suggestProto(fixtures.weeklyProfile.bytes, { name: 'WeeklyProfileValue' });
  const root = protobuf.parse(`syntax = "proto3";\npackage draft;\n${draft}`).root;

  assert.ok(root.lookupType('draft.WeeklyProfileValue'));
});

// ---------------------------------------------------------------------------
// Tree rendering
// ---------------------------------------------------------------------------

test('the tree spells out every reading of a scalar', () => {
  const tree = wire.formatTree(cat(f64(2, 21.5), vint(3, -1)));

  assert.match(tree, /2\s+fixed64\s+dbl=21\.5\s+u64=4626744929681408000/);
  assert.match(tree, /3\s+varint\s+18446744073709551615\s+\(i64=-1, zigzag=-9223372036854775808\)/);
});

test('the tree names the zone strings temperaturePoints carries', () => {
  const tree = wire.formatTree(fixtures.temperaturePoints.bytes);

  assert.match(tree, /string\s+"frontLeft"/);
  assert.match(tree, /string\s+"frontRight"/);
  assert.match(tree, /dbl=21\.5/);
});
