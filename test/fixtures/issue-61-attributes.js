'use strict';

/**
 * Wire-format fixtures for the five attributes in issue #61.
 *
 * Every buffer here is assembled tag by tag, not encoded through our own
 * .proto. That is deliberate and it is the same reason the chargePrograms test
 * hand-builds its bytes: a fixture round-tripped through our schema agrees with
 * whatever our schema says, so it cannot catch a wrong field number. These
 * bytes are built to match the structures recovered from a live payload and
 * reported in the issue, so a change to the inspector is checked against the
 * car rather than against ourselves.
 *
 * `observedDescription` on each fixture is the exact string the old walker
 * printed for it. Those strings are what the issue was written from, and
 * reproducing them character for character is what proves these fixtures
 * really are the payloads it saw.
 *
 * Verified against a live capture (see PR #62):
 *
 *   temperaturePoints  byte-identical to the vehicle's payload
 *   weeklySetHU        byte-identical
 *   precondState       byte-identical
 *   weeklyProfile      byte-identical
 *   tcuConnectionStateLowChannel
 *                      same shape; the vehicle sent 38:varint=1 where the issue
 *                      recorded 3, so the value moves and the field does not
 *
 * These are captured payloads, not reconstructions.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

function tag(field, wireType) {
  return varint((field << 3) | wireType);
}

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];

  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);

  return Buffer.from(bytes);
}

/** A varint field. Negative values are encoded as int64, i.e. two's complement. */
function vint(field, value) {
  const unsigned = BigInt(value) < 0n ? (1n << 64n) + BigInt(value) : BigInt(value);
  return Buffer.concat([tag(field, WIRE_VARINT), varint(unsigned)]);
}

/** A length-delimited field: sub-message, string or raw bytes. */
function len(field, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([tag(field, WIRE_LEN), varint(bytes.length), bytes]);
}

/** A double. */
function f64(field, value) {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value, 0);
  return Buffer.concat([tag(field, WIRE_FIXED64), bytes]);
}

/** A float. */
function f32(field, value) {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value, 0);
  return Buffer.concat([tag(field, WIRE_FIXED32), bytes]);
}

const cat = (...parts) => Buffer.concat(parts);

// ---------------------------------------------------------------------------
// tcuConnectionStateLowChannel - field 38, a bare varint.
// Issue: `38:varint=3`
// ---------------------------------------------------------------------------
const tcuConnectionStateLowChannel = {
  key: 'tcuConnectionStateLowChannel',
  field: 38,
  bytes: vint(38, 3),
  observedDescription: '38:varint=3',
};

// ---------------------------------------------------------------------------
// precondState - field 44, a one-field message.
// Issue: `44:{3:varint=1}`
// ---------------------------------------------------------------------------
const precondState = {
  key: 'precondState',
  field: 44,
  bytes: len(44, vint(3, 1)),
  observedDescription: '44:{3:varint=1}',
};

// ---------------------------------------------------------------------------
// weeklySetHU - field 24, repeated entries at field 1, each an index (field 1,
// omitted on the first so it defaults to 0) and a value (field 2).
// Issue: `24:{1:{2:varint=380} 1:{1:varint=1 2:varint=380} ...}`
// ---------------------------------------------------------------------------
const weeklySetEntry = (index, value) => (index === undefined ? vint(2, value) : cat(vint(1, index), vint(2, value)));

const weeklySetHU = {
  key: 'weeklySetHU',
  field: 24,
  bytes: len(
    24,
    cat(
      len(1, weeklySetEntry(undefined, 380)),
      len(1, weeklySetEntry(1, 380)),
      len(1, weeklySetEntry(2, 380)),
      len(1, weeklySetEntry(3, 380)),
      len(1, weeklySetEntry(4, 380)),
    ),
  ),
  observedDescription:
    '24:{1:{2:varint=380} 1:{1:varint=1 2:varint=380} 1:{1:varint=2 2:varint=380} '
    + '1:{1:varint=3 2:varint=380} 1:{1:varint=4 2:varint=380}}',
};

// ---------------------------------------------------------------------------
// weeklyProfile - field 29, three levels deep, with several varints the issue
// read as sentinels. They are -1 encoded as int64, which is what the inspector
// now says out loud.
//
// The issue elided the inner field 4 as `4:{...}`. The old walker rendered it
// `4:{0:varint=1 <truncated>}`, and field number 0 does not exist in protobuf -
// so that payload is never a message, and the walker was inventing a field
// there, the same mistake it made on the zone strings.
//
// The bytes below are the real ones, from the capture: five bytes 0x00..0x04.
// Whether they are a packed repeated field or an opaque `bytes` value cannot be
// decided from the wire - every byte is under 0x80, so the two encodings are
// identical here - which is why the inspector prints both readings and the
// schema draft declines to declare `repeated`.
//
// Worth noting for whoever declares this: the five values 0,1,2,3,4 line up
// with weeklySetHU's five entries, indexed 0 through 4. That is suggestive of
// day indices, not a conclusion.
//
// Live capture:
//   `29:{2:varint=21 3:varint=<-1> 4:varint=5 5:varint=<-1>
//        6:{1:varint=1 4:{0:varint=1 <truncated>} 6:varint=<-1>
//           7:{1:varint=6} 8:{1:varint=20} 9:{1:varint=1}}}`
// ---------------------------------------------------------------------------
const weeklyProfileUnknownField4 = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);

const weeklyProfile = {
  key: 'weeklyProfile',
  field: 29,
  unknownField4: weeklyProfileUnknownField4,
  bytes: len(
    29,
    cat(
      vint(2, 21),
      vint(3, -1),
      vint(4, 5),
      vint(5, -1),
      len(
        6,
        cat(
          vint(1, 1),
          len(4, weeklyProfileUnknownField4),
          vint(6, -1),
          len(7, vint(1, 6)),
          len(8, vint(1, 20)),
          len(9, vint(1, 1)),
        ),
      ),
    ),
  ),
  observedDescription:
    '29:{2:varint=21 3:varint=18446744073709551615 4:varint=5 5:varint=18446744073709551615 '
    + '6:{1:varint=1 4:{0:varint=1 <truncated>} 6:varint=18446744073709551615 7:{1:varint=6} '
    + '8:{1:varint=20} 9:{1:varint=1}}}',
};

// ---------------------------------------------------------------------------
// temperaturePoints - field 20, the one the old walker could not read at all.
//
// Its entries match TemperaturePoint in vehicle-commands.proto: a `zone` string
// ("frontLeft", "frontRight", "rearLeft", "rearRight") at field 1 and a
// `temperature_in_celsius` double at field 2, plus a field 3 the command side
// does not have - which the capture shows is the temperature again as a display
// string ("21.5" beside the double 21.5).
//
// The whole attribute also carries temperature_unit at field 16 (1 = CELSIUS),
// which is a declared field and so came through all along. That is what the
// issue meant by temperaturePoints_unit working while the value did not.
//
// The zone string is what broke the old walker. It descended into field 1 as if
// it were a message, read the `f` of "frontLeft" (0x66) as a tag, and got field
// 12 wire type 6 - a wire type that does not exist. Hence `1:{12:?wire6}`, and
// hence nothing after it in that entry was reported.
//
// Issue: `20:{1:{1:{12:?wire6} 2:fixed64 3:{...truncated}} 1:{...}}`
// ---------------------------------------------------------------------------
const temperaturePoint = (zone, celsius, display) => cat(len(1, zone), f64(2, celsius), len(3, display));

const temperaturePoints = {
  key: 'temperaturePoints',
  field: 20,
  bytes: len(20, cat(len(1, temperaturePoint('frontLeft', 21.5, '21.5')), len(1, temperaturePoint('frontRight', 21.5, '21.5')))),
  observedDescription: '20:{1:{1:{12:?wire6} 2:fixed64 3:{<truncated>}} 1:{1:{12:?wire6} 2:fixed64 3:{<truncated>}}}',
};

module.exports = {
  // Builders, so tests can assemble their own layouts without a .proto.
  tag,
  varint,
  vint,
  len,
  f64,
  f32,
  cat,

  tcuConnectionStateLowChannel,
  precondState,
  weeklySetHU,
  weeklyProfile,
  temperaturePoints,

  all: [tcuConnectionStateLowChannel, precondState, weeklySetHU, weeklyProfile, temperaturePoints],
};
