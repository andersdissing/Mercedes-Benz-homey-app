#!/usr/bin/env node
'use strict';

/**
 * Offline inspector for vehicle attributes the parser cannot decode.
 *
 * Development-only. It is excluded from the published Homey bundle and nothing
 * in the app requires it.
 *
 * The app reports an attribute it could not read as one log line carrying both
 * a field summary and the raw hex:
 *
 *   [PARSER] No value read for "temperaturePoints" (attributeType: none,
 *     status: 0, raw fields: 20:{...}, raw hex: a20154...)
 *
 * That hex is the input here. The point of re-analysing offline is that the
 * summary in the log is only as good as the inspector that produced it - issue
 * #61 was written from a summary that had silently mangled a string field, and
 * without the bytes there was no way to find that out short of re-running the
 * app against the car.
 *
 * Usage:
 *   node tools/inspect-attribute.js --hex a2015408...
 *   node tools/inspect-attribute.js --base64 ogFUCA...
 *   node tools/inspect-attribute.js --log run.log
 *   node tools/inspect-attribute.js --frame capture.bin [--attr temperaturePoints]
 *   node tools/inspect-attribute.js --demo
 *
 * --frame accepts either a WebSocket PushMessage frame or a bare VEPUpdate, so
 * the /vehicleattributes response saved out of a browser's network tab works
 * without any conversion.
 *
 * Options:
 *   --name <Name>   name for the suggested .proto message
 *   --depth <n>     how deep to descend (default 8)
 *   --no-proto      skip the suggested schema
 *   --compact       print only the one-line summary
 */

const fs = require('fs');
const path = require('path');

const wire = require('../lib/proto/wire-inspect');

const USAGE = `
Inspect a Mercedes vehicle attribute that the parser could not decode.

  node tools/inspect-attribute.js --hex <hex>
  node tools/inspect-attribute.js --base64 <base64>
  node tools/inspect-attribute.js --log <run.log>
  node tools/inspect-attribute.js --frame <file.bin> [--attr <key>]
  node tools/inspect-attribute.js --demo

  --frame takes either a WebSocket PushMessage frame or a bare VEPUpdate - the
  body of GET {widget}/v1/vehicle/{vin}/vehicleattributes, which is what a
  browser network tab gives you. It works out which it was handed.

  --name <Name>   name for the suggested .proto message (default RecoveredValue)
  --depth <n>     how deep to descend into nested messages (default ${wire.DEFAULT_MAX_DEPTH})
  --attr <key>    only this attribute, when a source carries several
  --no-proto      skip the suggested .proto skeleton
  --compact       one-line summary only
`.trim();

function parseArgs(argv) {
  const options = { proto: true, compact: false, maxDepth: wire.DEFAULT_MAX_DEPTH };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--hex': options.hex = value(); break;
      case '--base64': options.base64 = value(); break;
      case '--log': options.log = value(); break;
      case '--frame': options.frame = value(); break;
      case '--attr': options.attr = value(); break;
      case '--name': options.name = value(); break;
      case '--depth': options.maxDepth = Number(value()); break;
      case '--no-proto': options.proto = false; break;
      case '--compact': options.compact = true; break;
      case '--demo': options.demo = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  return options;
}

function parseHex(text) {
  const cleaned = text.replace(/[^0-9a-fA-F]/g, '');
  if (!cleaned.length || cleaned.length % 2 !== 0) {
    throw new Error('hex input must be an even number of hex digits');
  }
  return Buffer.from(cleaned, 'hex');
}

/**
 * Pull the attributes out of a captured protobuf payload.
 *
 * Two shapes carry vehicle attributes and both are worth accepting, because
 * they come from different places:
 *
 *   PushMessage - a WebSocket frame, what lib/websocket.js receives.
 *   VEPUpdate   - the body of GET {widget}/v1/vehicle/{vin}/vehicleattributes,
 *                 what lib/api.js polls and what the Mercedes-Benz Data
 *                 Explorer fetches. Saving that response from a browser's
 *                 network tab is the least work for a capture.
 *
 * Which one a saved .bin holds is not obvious from looking at it, so this tries
 * both rather than making the caller know.
 *
 * Either way it decodes through the raw mirror messages in vehicle-events.proto,
 * so every attribute comes back as opaque bytes whether or not the schema
 * declares its value field. That is the whole reason those mirrors exist.
 */
async function attributesFromFrame(file) {
  const protobuf = require('protobufjs');

  const root = await protobuf.load(path.join(__dirname, '..', 'lib', 'proto', 'vehicle-events.proto'));
  const frame = file === '-' ? fs.readFileSync(0) : fs.readFileSync(file);

  const collect = (updates) => {
    const found = [];
    for (const [vin, update] of Object.entries(updates)) {
      for (const [key, bytes] of Object.entries((update && update.attributes) || {})) {
        found.push({ source: `${vin} / ${key}`, key, bytes });
      }
    }
    return found;
  };

  // Decoding as the wrong type mostly yields nothing rather than throwing -
  // protobufjs skips fields it does not recognise - so "no attributes" is the
  // signal to try the other shape, not just a thrown error.
  const attempts = [
    ['PushMessage', () => {
      const type = root.lookupType('proto.PushMessageRaw');
      const object = type.toObject(type.decode(frame), { bytes: Buffer });
      return collect((object.vepUpdates && object.vepUpdates.updates) || {});
    }],
    ['VEPUpdate', () => {
      const type = root.lookupType('proto.VEPUpdateRaw');
      const object = type.toObject(type.decode(frame), { bytes: Buffer });
      return collect({ [object.vin || 'vehicle']: object });
    }],
  ];

  for (const [shape, attempt] of attempts) {
    let found;
    try {
      found = attempt();
    } catch (err) {
      continue;
    }

    if (found.length) {
      process.stderr.write(`note: read ${file} as a ${shape} payload (${found.length} attributes)\n`);
      return found;
    }
  }

  throw new Error(`${file} did not decode as a PushMessage or a VEPUpdate carrying attributes`);
}

/**
 * Recover attributes from an app log.
 *
 * Matches the `raw hex:` the parser now emits for every attribute it could not
 * read. Lines from a build before that existed carry only the summary, and are
 * reported as such rather than silently skipped - a log with nothing to
 * re-analyse is a different situation from a log with no problems in it.
 */
function attributesFromLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  let withoutBytes = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('No value read for')) continue;

    const key = (line.match(/No value read for "([^"]+)"/) || [])[1] || 'unknown';
    const hex = (line.match(/raw hex:\s*([0-9a-fA-F]+)/) || [])[1];

    if (!hex) {
      withoutBytes += 1;
      continue;
    }

    found.push({ source: `${file} / ${key}`, key, bytes: Buffer.from(hex, 'hex') });
  }

  if (withoutBytes) {
    process.stderr.write(
      `note: ${withoutBytes} report(s) in this log carry no "raw hex:" - they predate that being logged, `
      + 'so only the summary in the line itself is available.\n',
    );
  }

  return found;
}

function demoAttributes() {
  let fixtures;
  try {
    // Dev-only, and test/ is excluded from the published bundle - so is this file.
    // eslint-disable-next-line global-require
    fixtures = require('../test/fixtures/issue-61-attributes');
  } catch (err) {
    throw new Error('--demo needs test/fixtures/issue-61-attributes.js, which is not present');
  }

  return fixtures.all.map((fixture) => ({
    source: `issue #61 fixture / ${fixture.key}`,
    key: fixture.key,
    bytes: fixture.bytes,
    was: fixture.observedDescription,
  }));
}

function report(entry, options) {
  const heading = `=== ${entry.source} (${entry.bytes.length} bytes) ===`;
  const out = [heading];

  if (options.compact) {
    out.push(wire.formatFields(entry.bytes, options));
    return out.join('\n');
  }

  if (entry.was) {
    out.push('', 'previously reported as:', `  ${entry.was}`);
  }

  out.push('', 'fields:', `  ${wire.formatFields(entry.bytes, options)}`);
  out.push('', 'structure:');
  out.push(
    wire
      .formatTree(entry.bytes, options)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );

  if (options.proto) {
    const name = options.name || `${entry.key.charAt(0).toUpperCase()}${entry.key.slice(1)}Value`;

    out.push('', 'suggested schema (a draft - field names cannot be recovered from the wire):');
    out.push(
      wire
        .suggestProto(entry.bytes, { ...options, name })
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    out.push(
      '',
      '  To use it: add the top-level field to the attribute_type oneof in',
      '  VehicleAttributeStatus (lib/proto/vehicle-events.proto), then unwrap it',
      '  in extractVehicleData() the way chargeProgramsValue is.',
    );
  }

  out.push('', 'raw hex:', `  ${entry.bytes.toString('hex')}`);
  return out.join('\n');
}

async function collect(options) {
  if (options.demo) return demoAttributes();
  if (options.hex) return [{ source: 'hex input', key: 'attribute', bytes: parseHex(options.hex) }];
  if (options.base64) return [{ source: 'base64 input', key: 'attribute', bytes: Buffer.from(options.base64, 'base64') }];
  if (options.log) return attributesFromLog(options.log);
  if (options.frame) return attributesFromFrame(options.frame);
  return null;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let entries;
  try {
    entries = await collect(options);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (entries === null) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.attr) entries = entries.filter((entry) => entry.key === options.attr);

  if (!entries.length) {
    process.stdout.write('nothing to inspect\n');
    return;
  }

  process.stdout.write(`${entries.map((entry) => report(entry, options)).join('\n\n')}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
});
