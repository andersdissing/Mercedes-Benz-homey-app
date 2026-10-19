'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Capability icons: every one a capability names exists, and the
 * capabilities added for #85 use Material Design Icons (Apache 2.0), with
 * the licence shipped beside them.
 */

const root = path.join(__dirname, '..');
const capDir = path.join(root, '.homeycompose', 'capabilities');
const read = (id) => JSON.parse(fs.readFileSync(path.join(capDir, `${id}.json`), 'utf8'));

test('every capability icon exists', () => {
  for (const file of fs.readdirSync(capDir)) {
    const { icon } = JSON.parse(fs.readFileSync(path.join(capDir, file), 'utf8'));
    if (!icon) continue;
    assert.ok(fs.existsSync(path.join(root, icon)), `${file}: ${icon} is missing`);
  }
});

test('MDI icons only on the capabilities added for #85; the others keep their own', () => {
  const added = {
    distance_reset: 'map-marker-distance',
    electric_consumption_start: 'chart-line',
    electric_consumption_reset: 'chart-line',
  };
  const licence = fs.readFileSync(path.join(root, 'assets', 'icons', 'LICENSE-mdi.txt'), 'utf8');

  for (const [capability, icon] of Object.entries(added)) {
    assert.equal(read(capability).icon, `/assets/icons/${icon}.svg`, capability);
    const svg = fs.readFileSync(path.join(root, 'assets', 'icons', `${icon}.svg`), 'utf8');
    assert.match(svg, /viewBox="0 0 24 24" fill="currentColor"/, `${icon}: monochrome, 24x24`);
    assert.match(svg, new RegExp(`Material Design Icons "${icon}"`), `${icon}: names its source`);
    assert.ok(licence.includes(`${icon}.svg`), `${icon}: listed in LICENSE-mdi.txt`);
  }
  assert.match(licence, /Apache License\s+Version 2\.0/);

  // Capabilities that were here before keep the icons they came with.
  assert.equal(read('distance_start').icon, '/assets/icons/distance_start.svg');
  assert.equal(read('driven_time_start').icon, '/assets/icons/driven_time.svg');
  assert.equal(read('average_speed').icon, '/assets/speed.svg');

  // And no MDI icon is shipped that nothing uses.
  for (const unused of ['clock-check-outline', 'speedometer']) {
    assert.ok(!fs.existsSync(path.join(root, 'assets', 'icons', `${unused}.svg`)), `${unused}.svg`);
    assert.ok(!licence.includes(`${unused}.svg`), `${unused} not listed`);
  }
});
