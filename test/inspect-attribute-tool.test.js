'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protobuf = require('protobufjs');
const fixtures = require('./fixtures/issue-61-attributes');

/**
 * End-to-end tests for tools/inspect-attribute.js.
 *
 * The tool is the part of this that a person actually runs when an attribute
 * turns up undecodable, so its input paths are worth exercising for real -
 * argument parsing, log scraping and frame decoding are exactly the places a
 * diagnostic quietly stops working and nobody notices until they need it.
 */

const TOOL = path.join(__dirname, '..', 'tools', 'inspect-attribute.js');

function run(args, options = {}) {
  return execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', ...options });
}

let workdir;

test.before(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-attr-'));
});

test.after(() => {
  if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
});

test('--hex decodes an attribute from the hex the app logs', () => {
  const output = run(['--compact', '--hex', fixtures.temperaturePoints.bytes.toString('hex')]);

  assert.match(output, /1:"frontLeft"/);
  assert.match(output, /2:fixed64=21\.5\(dbl\)/);
});

test('--hex tolerates the whitespace of a copy-paste', () => {
  const spaced = fixtures.precondState.bytes.toString('hex').replace(/(..)/g, '$1 ');
  assert.match(run(['--compact', '--hex', spaced]), /44:\{3:varint=1\}/);
});

test('--base64 works too', () => {
  const output = run(['--compact', '--base64', fixtures.weeklySetHU.bytes.toString('base64')]);
  assert.match(output, /24:\{1:\{2:varint=380\}/);
});

test('--demo shows every attribute in the issue, old rendering beside new', () => {
  const output = run(['--demo']);

  for (const fixture of fixtures.all) {
    assert.ok(output.includes(fixture.key), `${fixture.key} must appear`);
  }

  // The old dump is printed alongside, so the difference is the point.
  assert.match(output, /previously reported as:/);
  assert.match(output, /1:\{12:\?wire6\}/);
  assert.match(output, /1:"frontLeft"/);
});

test('--attr narrows to one attribute', () => {
  const output = run(['--demo', '--compact', '--attr', 'precondState']);

  assert.match(output, /precondState/);
  assert.ok(!output.includes('temperaturePoints'));
});

test('--log recovers attributes from a captured app log', () => {
  const logPath = path.join(workdir, 'run.log');
  const hex = fixtures.temperaturePoints.bytes.toString('hex');

  fs.writeFileSync(
    logPath,
    [
      'something unrelated',
      `2026-08-02 [PARSER] No value read for "temperaturePoints" (attributeType: none, status: 0, raw fields: 20:{...}, raw hex: ${hex})`,
      '2026-08-02 [PARSER] Extracted 84 vehicle attributes',
    ].join('\n'),
  );

  const output = run(['--log', logPath, '--compact']);
  assert.match(output, /temperaturePoints/);
  assert.match(output, /1:"frontLeft"/);
});

test('--log says so when a line predates the raw bytes being logged', () => {
  const logPath = path.join(workdir, 'old.log');
  fs.writeFileSync(
    logPath,
    '[PARSER] No value read for "temperaturePoints" (attributeType: none, status: 0, raw fields: 20:{1:{12:?wire6}})\n',
  );

  // stderr carries the note; stdout has nothing to show.
  const stdout = run(['--log', logPath, '--compact'], { stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(stdout, /nothing to inspect/);
});

function allFixtureAttributes() {
  const attributes = {};
  for (const fixture of fixtures.all) attributes[fixture.key] = fixture.bytes;
  return attributes;
}

test('--frame decodes every attribute out of a captured push frame', async () => {
  const root = await protobuf.load(path.join(__dirname, '..', 'lib', 'proto', 'vehicle-events.proto'));
  const PushMessageRaw = root.lookupType('proto.PushMessageRaw');

  const framePath = path.join(workdir, 'capture.bin');
  fs.writeFileSync(
    framePath,
    PushMessageRaw.encode({
      vepUpdates: {
        updates: { WDD1234567890ABCD: { vin: 'WDD1234567890ABCD', attributes: allFixtureAttributes() } },
      },
    }).finish(),
  );

  const output = run(['--frame', framePath, '--compact']);

  for (const fixture of fixtures.all) assert.ok(output.includes(fixture.key), `${fixture.key} must appear`);
  assert.match(output, /1:"frontLeft"/);
});

test('--frame also takes a bare VEPUpdate, as saved from a browser network tab', async () => {
  // The body of GET {widget}/v1/vehicle/{vin}/vehicleattributes is a VEPUpdate,
  // not a PushMessage - so a capture from the Data Explorer or from DevTools
  // has to work without the caller converting anything.
  const root = await protobuf.load(path.join(__dirname, '..', 'lib', 'proto', 'vehicle-events.proto'));
  const VEPUpdateRaw = root.lookupType('proto.VEPUpdateRaw');

  const vepPath = path.join(workdir, 'vehicleattributes.bin');
  fs.writeFileSync(
    vepPath,
    VEPUpdateRaw.encode({ vin: 'WDD1234567890ABCD', attributes: allFixtureAttributes() }).finish(),
  );

  const output = run(['--frame', vepPath, '--compact']);

  for (const fixture of fixtures.all) assert.ok(output.includes(fixture.key), `${fixture.key} must appear`);
  assert.match(output, /1:"frontLeft"/);
});

test('--frame says which of the two shapes it read', async () => {
  const root = await protobuf.load(path.join(__dirname, '..', 'lib', 'proto', 'vehicle-events.proto'));
  const VEPUpdateRaw = root.lookupType('proto.VEPUpdateRaw');

  const vepPath = path.join(workdir, 'shape.bin');
  fs.writeFileSync(
    vepPath,
    VEPUpdateRaw.encode({ vin: 'WDD1234567890ABCD', attributes: { precondState: fixtures.precondState.bytes } }).finish(),
  );

  // The detection is a guess between two shapes, so it should say which one it
  // landed on rather than leave the reader to assume.
  const result = require('node:child_process').spawnSync(process.execPath, [TOOL, '--frame', vepPath, '--compact'], {
    encoding: 'utf8',
  });

  assert.match(result.stderr, /read .* as a VEPUpdate payload \(1 attributes\)/);
});

test('--frame refuses a file that is neither shape', () => {
  const junkPath = path.join(workdir, 'junk.bin');
  fs.writeFileSync(junkPath, Buffer.from('not a protobuf payload at all', 'utf8'));

  assert.throws(() => run([`--frame`, junkPath]), (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr, /did not decode as a PushMessage or a VEPUpdate/);
    return true;
  });
});

test('the suggested schema is offered with instructions for using it', () => {
  const output = run(['--demo', '--attr', 'temperaturePoints']);

  assert.match(output, /message TemperaturePointsValue/);
  assert.match(output, /attribute_type oneof/);
});

test('an unknown option fails loudly instead of inspecting nothing', () => {
  assert.throws(() => run(['--nope']), (err) => {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /unknown option --nope/);
    return true;
  });
});

test('malformed hex is rejected rather than silently truncated', () => {
  assert.throws(() => run(['--hex', 'abc']), (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr, /even number of hex digits/);
    return true;
  });
});

test('no arguments prints usage', () => {
  assert.throws(() => run([]), (err) => {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /--hex <hex>/);
    return true;
  });
});
