'use strict';

/**
 * Protobuf wire-format inspector.
 *
 * This is the tool that turns "the car sent an attribute we cannot decode" into
 * "here is the field number, wire type and value it actually carries", which is
 * the whole input to declaring that attribute in vehicle-events.proto.
 *
 * It exists because the walker this replaces (ProtoParser._describeRawAttribute)
 * assumed every length-delimited field was a nested message and descended into
 * all of them. A protobuf string is also wire type 2, so a string field got read
 * as if its first character were a tag byte: `"frontLeft"` starts with `f`
 * (0x66), which reads as field 12 wire type 6, and 6 is not a valid wire type.
 * That is where `1:{12:?wire6}` in issue #61 came from - not a corrupt payload,
 * just a string the walker refused to consider. Everything after it in that
 * sub-message was abandoned, so the field that mattered was never reported.
 *
 * The fix is to decide what a length-delimited payload is before descending:
 * only bytes that parse cleanly and completely as a message are treated as one.
 * Anything else is reported as text, packed varints or raw hex. Scalars now
 * print their value too - a `fixed64` that used to print as a bare `2:fixed64`
 * is a double, and printing it is the difference between knowing a field exists
 * and knowing it holds the cabin temperature.
 *
 * Nothing here throws. It runs inside the live update path, where a diagnostic
 * that can fail is worse than no diagnostic at all.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

// A varint is at most 10 bytes (64 bits in 7-bit groups).
const MAX_VARINT_BYTES = 10;
const U64_MAX = (1n << 64n) - 1n;
const U64_SIGN_BIT = 1n << 63n;
const U64_RANGE = 1n << 64n;

// Field numbers are 29 bits, so a tag never exceeds 32 bits.
const MAX_TAG = 0xffffffffn;

// How deep to descend before giving up. The old limit of 3 was reached by real
// payloads (weeklyProfile nests four levels), and it reported the cut as an
// ordinary `len(n)` field, which is indistinguishable from an actual opaque
// blob. Both are fixed: deeper, and the cut says so.
const DEFAULT_MAX_DEPTH = 8;

// Raw bytes and long strings are previewed rather than dumped whole in the
// one-line summary - one attribute must not be able to fill the app log. The
// full payload is logged separately as hex, and formatTree() shows everything.
const HEX_PREVIEW_BYTES = 16;
const TEXT_PREVIEW_CHARS = 80;

// Two more bounds on the one-line summary. Any run of printable bytes is a
// valid message of some shape - 300 `x` bytes parse as 150 varint fields - so
// capping strings alone does not bound the line. The per-message cap keeps it
// readable; the overall cap is the backstop that makes the bound absolute.
const MAX_FIELDS_PER_MESSAGE = 24;
const MAX_SUMMARY_CHARS = 1500;

/**
 * Read one base-128 varint.
 * @returns {{ok: true, value: BigInt, next: Number}|{ok: false, reason: String}}
 */
function readVarint(buf, pos) {
  let value = 0n;
  let shift = 0n;

  for (let i = pos; i < buf.length; i += 1) {
    const byte = buf[i];
    value |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { ok: true, value: value & U64_MAX, next: i + 1 };
    }

    shift += 7n;
    if (i - pos + 1 >= MAX_VARINT_BYTES) {
      return { ok: false, reason: 'varint-overlong' };
    }
  }

  return { ok: false, reason: 'varint-truncated' };
}

/**
 * Split a buffer into wire-format fields.
 *
 * `ok` is the whole point: it is what lets a caller ask "are these bytes a
 * message?" without guessing. A payload only counts as a message if every field
 * in it is well formed and the fields consume the buffer exactly - a string
 * that happens to start with a plausible tag byte fails somewhere before the
 * end and is rejected.
 *
 * On failure, `error.offset` is where the *field* that failed starts - its tag
 * byte, not whichever byte inside it tripped. That is the offset to look at in
 * a hex dump of the payload.
 *
 * @param {Buffer} buf
 * @returns {{ok: Boolean, fields: Array, error: Object|null}}
 */
function scan(buf) {
  const fields = [];
  let pos = 0;

  while (pos < buf.length) {
    const start = pos;

    const tagRead = readVarint(buf, pos);
    if (!tagRead.ok) return { ok: false, fields, error: { reason: tagRead.reason, offset: start } };
    if (tagRead.value > MAX_TAG) return { ok: false, fields, error: { reason: 'tag-too-large', offset: start } };

    const tag = Number(tagRead.value);
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (field === 0) return { ok: false, fields, error: { reason: 'zero-field-number', offset: start } };

    pos = tagRead.next;

    switch (wireType) {
      case WIRE_VARINT: {
        const read = readVarint(buf, pos);
        if (!read.ok) return { ok: false, fields, error: { reason: read.reason, offset: start } };
        fields.push({ field, wireType, start, end: read.next, value: read.value });
        pos = read.next;
        break;
      }

      case WIRE_FIXED64: {
        if (pos + 8 > buf.length) {
          return { ok: false, fields, error: { reason: 'fixed64-truncated', offset: start } };
        }
        fields.push({ field, wireType, start, end: pos + 8, raw: buf.subarray(pos, pos + 8) });
        pos += 8;
        break;
      }

      case WIRE_LEN: {
        const lenRead = readVarint(buf, pos);
        if (!lenRead.ok) return { ok: false, fields, error: { reason: lenRead.reason, offset: start } };

        const size = Number(lenRead.value);
        const available = buf.length - lenRead.next;
        if (!Number.isSafeInteger(size) || size > available) {
          return {
            ok: false,
            fields,
            error: { reason: 'length-overrun', offset: start, need: size, have: available },
          };
        }

        fields.push({
          field,
          wireType,
          start,
          end: lenRead.next + size,
          bytes: buf.subarray(lenRead.next, lenRead.next + size),
        });
        pos = lenRead.next + size;
        break;
      }

      case WIRE_FIXED32: {
        if (pos + 4 > buf.length) {
          return { ok: false, fields, error: { reason: 'fixed32-truncated', offset: start } };
        }
        fields.push({ field, wireType, start, end: pos + 4, raw: buf.subarray(pos, pos + 4) });
        pos += 4;
        break;
      }

      default:
        // Wire types 3 and 4 are proto2 groups, 6 and 7 do not exist. None can
        // appear in a Mercedes payload, so seeing one means these bytes are not
        // a message - which is exactly the signal the caller wants.
        return { ok: false, fields, error: { reason: `bad-wire-type-${wireType}`, offset: start } };
    }
  }

  return { ok: true, fields, error: null };
}

/**
 * Decode a payload as text, or null if it is not printable UTF-8.
 * Control characters disqualify it: protobuf tag bytes for the low field
 * numbers are control characters, so requiring printability is most of what
 * separates a string from a message.
 */
function asText(buf) {
  if (!buf.length) return null;

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (err) {
    return null;
  }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  return text;
}

/** Two consecutive letters - enough to tell "frontLeft" from a byte that prints. */
function looksLikeWord(text) {
  return /[A-Za-zÀ-ɏ]{2,}/.test(text);
}

/** A clean run of varints, i.e. a packed repeated scalar field. */
function asPackedVarints(buf) {
  const values = [];
  let pos = 0;

  while (pos < buf.length) {
    const read = readVarint(buf, pos);
    if (!read.ok) return null;
    values.push(read.value);
    pos = read.next;
  }

  return values.length ? values : null;
}

/** Two's-complement reading of a varint, which is how a negative int64 arrives. */
function asSigned(unsigned) {
  return unsigned >= U64_SIGN_BIT ? unsigned - U64_RANGE : unsigned;
}

/** ZigZag reading, which is how a negative sint32/sint64 arrives. */
function asZigzag(unsigned) {
  return (unsigned >> 1n) ^ -(unsigned & 1n);
}

// A double that could plausibly be what the field means. An int64 misread as a
// double lands in the denormal range or in the 1e15+ range, so this keeps the
// compact output from confidently printing nonsense.
function isPlausibleReal(value) {
  if (!Number.isFinite(value)) return false;
  if (value === 0) return true;
  const magnitude = Math.abs(value);
  return magnitude >= 1e-6 && magnitude < 1e15;
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  return null;
}

/**
 * Work out what a length-delimited payload holds.
 *
 * Order matters. A message that parses cleanly is reported as a message, but if
 * it is also readable text the text comes along as a hint, because those bytes
 * are genuinely ambiguous and picking one silently is how the original walker
 * went wrong. Text that does not parse as a message is unambiguous and needs no
 * hedging.
 */
function classify(buf, depth, maxDepth, base) {
  if (buf.length === 0) return { kind: 'empty', bytes: buf };
  if (depth >= maxDepth) return { kind: 'depth-limit', bytes: buf };

  const scanned = scan(buf);
  const text = asText(buf);

  if (scanned.ok && scanned.fields.length > 0) {
    return {
      kind: 'message',
      bytes: buf,
      fields: scanned.fields.map((field) => describeField(field, depth + 1, maxDepth, base)),
      // Only flagged when it reads like an actual word, so the hint means
      // something when it appears instead of decorating every second field.
      text: text !== null && looksLikeWord(text) ? text : null,
    };
  }

  if (text !== null) return { kind: 'string', bytes: buf, text };

  const packed = asPackedVarints(buf);
  if (packed) return { kind: 'packed', bytes: buf, values: packed };

  return { kind: 'bytes', bytes: buf };
}

/**
 * @param {Object} field - one entry from scan()
 * @param {Number} depth
 * @param {Number} maxDepth
 * @param {Number} base - absolute offset of the buffer this field was scanned
 *   from. Offsets are reported against the whole attribute rather than against
 *   whichever sub-buffer they were found in, so they can be matched up with a
 *   hex dump of the payload.
 */
function describeField(field, depth, maxDepth, base) {
  const node = {
    field: field.field,
    wireType: field.wireType,
    start: base + field.start,
    end: base + field.end,
  };

  switch (field.wireType) {
    case WIRE_VARINT:
      return {
        ...node,
        kind: 'varint',
        unsigned: field.value,
        signed: asSigned(field.value),
        zigzag: asZigzag(field.value),
      };

    case WIRE_FIXED64:
      return {
        ...node,
        kind: 'fixed64',
        double: field.raw.readDoubleLE(0),
        unsigned: field.raw.readBigUInt64LE(0),
        signed: field.raw.readBigInt64LE(0),
        hex: field.raw.toString('hex'),
      };

    case WIRE_FIXED32:
      return {
        ...node,
        kind: 'fixed32',
        float: field.raw.readFloatLE(0),
        unsigned: BigInt(field.raw.readUInt32LE(0)),
        signed: BigInt(field.raw.readInt32LE(0)),
        hex: field.raw.toString('hex'),
      };

    default:
      // The payload starts where the field ends, minus its own length.
      return { ...node, ...classify(field.bytes, depth, maxDepth, node.end - field.bytes.length) };
  }
}

/**
 * Describe a buffer as a tree of field nodes.
 *
 * @param {Buffer|Uint8Array|Array} bytes
 * @param {Object} [options]
 * @param {Number} [options.maxDepth]
 * @returns {{fields: Array, error: Object|null, bytes: Buffer}}
 */
function inspect(bytes, options = {}) {
  const buf = toBuffer(bytes);
  if (!buf) return { fields: [], error: { reason: 'not-bytes', offset: 0 }, bytes: Buffer.alloc(0) };

  const maxDepth = options.maxDepth === undefined ? DEFAULT_MAX_DEPTH : options.maxDepth;
  const scanned = scan(buf);

  return {
    bytes: buf,
    error: scanned.error,
    fields: scanned.fields.map((field) => describeField(field, 0, maxDepth, 0)),
  };
}

function formatError(error) {
  let detail = '';
  if (error.reason === 'length-overrun') detail = `(need ${error.need}, have ${error.have})`;
  return `!${error.reason}@${error.offset}${detail}`;
}

function hexPreview(buf) {
  const head = buf.subarray(0, HEX_PREVIEW_BYTES).toString('hex');
  return buf.length > HEX_PREVIEW_BYTES ? `${head}...` : head;
}

function textPreview(text) {
  return text.length > TEXT_PREVIEW_CHARS
    ? `${JSON.stringify(text.slice(0, TEXT_PREVIEW_CHARS))}...(${text.length} chars)`
    : JSON.stringify(text);
}

function formatNode(node) {
  switch (node.kind) {
    case 'varint': {
      // A negative int64 arrives as a huge unsigned value. Printing only the
      // unsigned reading is how 18446744073709551615 got read as a sentinel in
      // issue #61 when it is just -1.
      const signed = node.unsigned >= U64_SIGN_BIT ? `/${node.signed}` : '';
      return `${node.field}:varint=${node.unsigned}${signed}`;
    }

    case 'fixed64':
      return isPlausibleReal(node.double)
        ? `${node.field}:fixed64=${node.double}(dbl)`
        : `${node.field}:fixed64=${node.unsigned}(u64)`;

    case 'fixed32':
      return isPlausibleReal(node.float)
        ? `${node.field}:fixed32=${node.float}(flt)`
        : `${node.field}:fixed32=${node.unsigned}(u32)`;

    case 'message': {
      const shown = node.fields.slice(0, MAX_FIELDS_PER_MESSAGE);
      const parts = shown.map(formatNode);
      if (node.fields.length > shown.length) parts.push(`...(+${node.fields.length - shown.length} fields)`);

      const hint = node.text === null ? '' : `~${textPreview(node.text)}`;
      return `${node.field}:{${parts.join(' ')}}${hint}`;
    }

    case 'string':
      return `${node.field}:${textPreview(node.text)}`;

    case 'packed':
      return `${node.field}:packed[${node.values.join(',')}]`;

    case 'empty':
      return `${node.field}:len(0)`;

    case 'depth-limit':
      return `${node.field}:len(${node.bytes.length})=depth-limit`;

    default:
      return `${node.field}:len(${node.bytes.length})=0x${hexPreview(node.bytes)}`;
  }
}

/**
 * One-line `field:type=value` summary, for the app log.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {Object} [options]
 * @returns {String}
 */
function formatFields(bytes, options = {}) {
  try {
    const tree = inspect(bytes, options);
    const parts = tree.fields.map(formatNode);
    if (tree.error) parts.push(formatError(tree.error));

    const summary = parts.join(' ');
    return summary.length > MAX_SUMMARY_CHARS
      ? `${summary.slice(0, MAX_SUMMARY_CHARS)}...(summary truncated; run tools/inspect-attribute.js on the raw hex)`
      : summary;
  } catch (err) {
    // Unreachable by design, and still not worth breaking an update over.
    return `!inspector-failed(${err.message})`;
  }
}

const KIND_LABEL = {
  varint: 'varint',
  fixed64: 'fixed64',
  fixed32: 'fixed32',
  message: 'message',
  string: 'string',
  packed: 'packed varints',
  empty: 'empty',
  'depth-limit': 'not decoded (depth limit)',
  bytes: 'bytes',
};

function treeLines(nodes, indent, out) {
  for (const node of nodes) {
    const pad = '  '.repeat(indent);
    const label = KIND_LABEL[node.kind] || node.kind;
    const at = `@${node.start}`;

    switch (node.kind) {
      case 'varint': {
        const alts = [];
        if (node.signed !== node.unsigned) alts.push(`i64=${node.signed}`);
        alts.push(`zigzag=${node.zigzag}`);
        out.push(`${pad}${node.field}  ${label}  ${node.unsigned}  (${alts.join(', ')})  ${at}`);
        break;
      }

      case 'fixed64': {
        const signed = node.signed === node.unsigned ? '' : `  i64=${node.signed}`;
        out.push(`${pad}${node.field}  ${label}  dbl=${node.double}  u64=${node.unsigned}${signed}  hex=${node.hex}  ${at}`);
        break;
      }

      case 'fixed32': {
        const signed = node.signed === node.unsigned ? '' : `  i32=${node.signed}`;
        out.push(`${pad}${node.field}  ${label}  flt=${node.float}  u32=${node.unsigned}${signed}  hex=${node.hex}  ${at}`);
        break;
      }

      case 'message': {
        const hint = node.text === null ? '' : `  (also reads as text ${JSON.stringify(node.text)})`;
        out.push(`${pad}${node.field}  ${label}  ${node.fields.length} field(s), ${node.bytes.length} bytes${hint}  ${at}`);
        treeLines(node.fields, indent + 1, out);
        break;
      }

      case 'string':
        out.push(`${pad}${node.field}  ${label}  ${JSON.stringify(node.text)}  (${node.bytes.length} bytes)  ${at}`);
        break;

      case 'packed':
        out.push(`${pad}${node.field}  ${label}  [${node.values.join(', ')}]  ${at}`);
        break;

      case 'empty':
        out.push(`${pad}${node.field}  ${label}  ${at}`);
        break;

      default:
        out.push(`${pad}${node.field}  ${label}  ${node.bytes.length} bytes  hex=${node.bytes.toString('hex')}  ${at}`);
        break;
    }
  }

  return out;
}

/**
 * Indented, fully annotated rendering - every reading of every scalar, with
 * byte offsets, for working out what a field means rather than just that it is
 * there.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {Object} [options]
 * @returns {String}
 */
function formatTree(bytes, options = {}) {
  try {
    const tree = inspect(bytes, options);
    const lines = treeLines(tree.fields, 0, []);
    if (tree.error) lines.push(`${formatError(tree.error)}  <- bytes from here on were not decoded`);
    return lines.length ? lines.join('\n') : '(no fields)';
  } catch (err) {
    return `!inspector-failed(${err.message})`;
  }
}

// ==================== .proto skeleton generation ====================

const SCALAR_FOR_KIND = {
  varint: 'int64',
  fixed64: 'double',
  fixed32: 'float',
  string: 'string',
  packed: 'repeated int64',
  bytes: 'bytes',
  empty: 'bytes',
  'depth-limit': 'bytes',
};

function sampleOf(node) {
  if (node.kind === 'varint') return String(node.unsigned);
  if (node.kind === 'fixed64') return String(node.double);
  if (node.kind === 'fixed32') return String(node.float);
  if (node.kind === 'string') return JSON.stringify(node.text);
  return null;
}

/**
 * Merge every observation of a field number into a single shape.
 *
 * `instances` is one entry per occurrence of the *containing* message, not a
 * flat list, and that distinction decides `repeated`. A temperature point
 * carries exactly one zone; two points carry two. Flattening them first would
 * count two occurrences of field 1 and declare the zone repeated, which is
 * wrong in a way that only shows up once a second entry arrives - so the
 * per-instance maximum is what counts.
 */
function mergeShape(instances) {
  const shape = new Map();

  for (const nodes of instances) {
    const perInstance = new Map();

    for (const node of nodes) {
      let entry = shape.get(node.field);
      if (!entry) {
        entry = { field: node.field, maxPerInstance: 0, kinds: new Set(), instances: [], samples: [] };
        shape.set(node.field, entry);
      }

      perInstance.set(node.field, (perInstance.get(node.field) || 0) + 1);
      entry.kinds.add(node.kind);

      if (node.kind === 'message') entry.instances.push(node.fields);

      const sample = sampleOf(node);
      if (sample !== null && entry.samples.length < 4 && !entry.samples.includes(sample)) {
        entry.samples.push(sample);
      }
    }

    for (const [field, count] of perInstance) {
      const entry = shape.get(field);
      entry.maxPerInstance = Math.max(entry.maxPerInstance, count);
    }
  }

  return [...shape.values()].sort((a, b) => a.field - b.field);
}

/**
 * Append `message name {...}` to `defs`, recursing into nested messages.
 * The slot is reserved before recursing so a parent always precedes its
 * children in the output.
 */
function emitMessage(name, instances, defs) {
  const slot = defs.length;
  defs.push(null);

  const lines = [`message ${name} {`];

  for (const entry of mergeShape(instances)) {
    const repeated = entry.maxPerInstance > 1 ? 'repeated ' : '';
    const notes = [];
    if (entry.samples.length) notes.push(`observed ${entry.samples.join(', ')}`);

    if (entry.kinds.size > 1) {
      notes.push(`AMBIGUOUS: seen as ${[...entry.kinds].join(' and ')}`);
      lines.push(`  ${repeated}bytes f${entry.field} = ${entry.field};  // ${notes.join('; ')}`);
      continue;
    }

    const kind = [...entry.kinds][0];

    if (kind === 'message') {
      const childName = `${name}_${entry.field}`;
      lines.push(`  ${repeated}${childName} f${entry.field} = ${entry.field};`);
      emitMessage(childName, entry.instances, defs);
      continue;
    }

    if (kind === 'varint' && entry.samples.every((sample) => sample === '0' || sample === '1')) {
      notes.push('only 0/1 seen - may be bool');
    }

    const type = SCALAR_FOR_KIND[kind] || 'bytes';
    // A packed field is already repeated; do not say so twice.
    const prefix = type.startsWith('repeated') ? '' : repeated;
    lines.push(`  ${prefix}${type} f${entry.field} = ${entry.field};${notes.length ? `  // ${notes.join('; ')}` : ''}`);
  }

  lines.push('}');
  defs[slot] = lines.join('\n');
  return defs;
}

/**
 * Draft a .proto message for an inspected payload.
 *
 * A draft, deliberately: field names are unknown from the wire alone, ints are
 * widened to int64, and anything ambiguous is left as bytes with a comment. It
 * is a starting point for declaring an attribute, not something to paste in
 * unread.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {Object} [options]
 * @param {String} [options.name]
 * @returns {String}
 */
function suggestProto(bytes, options = {}) {
  try {
    const name = options.name || 'RecoveredValue';
    const tree = inspect(bytes, options);
    if (!tree.fields.length) return '// nothing decoded, no schema to suggest';
    return emitMessage(name, [tree.fields], []).join('\n\n');
  } catch (err) {
    return `// could not suggest a schema (${err.message})`;
  }
}

module.exports = {
  inspect,
  formatFields,
  formatTree,
  suggestProto,
  scan,
  DEFAULT_MAX_DEPTH,
};
