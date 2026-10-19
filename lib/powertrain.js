'use strict';

/**
 * Whether a car is electric or combustion, and which capabilities follow.
 *
 * Kept out of device.js so it can be tested: requiring a driver or device file
 * outside Homey fails with `Class extends value undefined`.
 *
 * Every car used to be paired as an EV - `measure_battery` in the manifest and
 * `energy.batteries` on the driver - so a diesel GLC was modelled as a battery
 * device sitting at 0% and Homey raised a low-battery alert for it (#79).
 *
 * The car's own readings cannot decide this. 0% is a legitimate value, and the
 * parser drops nil attributes (`lib/proto/parser.js`), so a missing `soc`
 * means nothing at all - least of all on a freshly paired car that has not
 * woken since. What does decide it is what Mercedes says the car *can be told
 * to do*: `/v1/vehicle/{vin}/capabilities` and `.../capabilities/commands`,
 * merged by `api.getVehicleFeatures()`. That answer is about the car's
 * configuration, so it is valid the second the device is paired and with the
 * car asleep.
 *
 * Three states, and `unknown` is a real one: both endpoints 401 for some cars,
 * and an undetected car keeps its capabilities but is not declared
 * battery-powered - quiet rather than wrong.
 */

const EV = 'ev';
const ICE = 'ice';
const UNKNOWN = 'unknown';

/**
 * The capabilities only an electric or plug-in hybrid car has. This is the
 * only set the powertrain gates: fuel, AdBlue and auxheat stay on every car,
 * because this issue is a diesel showing a battery and stripping fuel tiles
 * off a BEV is a separate, riskier change.
 *
 * `measure_battery` is deliberately not in the driver manifest either: Homey's
 * publish validation demands a driver-level `energy.batteries` for any driver
 * declaring it, which is exactly the declaration that makes every car a
 * battery device. The device adds the capability and calls `setEnergy()` for
 * itself once this module has said which kind of car it is.
 */
const EV_CAPABILITIES = [
  'measure_battery',
  'measure_max_soc',
  'measure_range_electric',
  'measure_battery_temperature',
  'measure_charge_power',
  'onoff_charging',
  'onoff_connector',
  'text_charging_status',
  'text_charge_program',
  'text_end_charge_time',
  'text_connector_status'
];

// The two endpoints do not agree on spelling: /capabilities/commands keys the
// map by SCREAMING_SNAKE command names (CHARGE_PROGRAM_CONFIGURE), while
// /capabilities returns a camelCase feature dict. Both are normalised to the
// same shape before matching.
const EV_MARKERS = ['CHARGE', 'CHARGING', 'ZEV', 'MAX_SOC', 'HV_BATTERY'];
const ICE_MARKERS = ['AUXHEAT', 'AUX_HEAT', 'ENGINE_START', 'ENGINE_STOP', 'TANK', 'FUEL'];

/**
 * `chargeProgramConfigure` and `CHARGE_PROGRAM_CONFIGURE` are the same marker.
 */
function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

function matchesMarker(key, markers) {
  return markers.some((marker) => key === marker || key.startsWith(`${marker}_`) || key.includes(`_${marker}`));
}

/**
 * Classify a car from the merged feature map `api.getVehicleFeatures()`
 * returns (commandName/featureName -> boolean).
 *
 * A car offering any electric marker is electric, even when it also offers
 * auxheat and engine start - that is a plug-in hybrid, and keeping everything
 * is the right answer for one. There is deliberately no separate hybrid state.
 *
 * @param {Object} features
 * @returns {'ev'|'ice'|'unknown'}
 */
function classifyFromFeatures(features) {
  if (!features || typeof features !== 'object') return UNKNOWN;

  let ev = false;
  let ice = false;

  for (const [rawKey, available] of Object.entries(features)) {
    // A command the car lists as unavailable says nothing about its
    // powertrain - every car is sent the same catalogue.
    if (!available) continue;

    const key = normalizeKey(rawKey);
    if (matchesMarker(key, EV_MARKERS)) ev = true;
    else if (matchesMarker(key, ICE_MARKERS)) ice = true;
  }

  if (ev) return EV;
  if (ice) return ICE;
  return UNKNOWN;
}

/**
 * The powertrain setting wins over detection, always: it is the escape hatch
 * for a car Mercedes describes in a vocabulary this app has not seen.
 *
 * @param {Object} input
 * @param {string} [input.override] - the `powertrain` device setting
 * @param {string} [input.detected] - what classifyFromFeatures() said
 * @returns {'ev'|'ice'|'unknown'}
 */
function resolvePowertrain({ override, detected } = {}) {
  if (override === EV || override === ICE) return override;
  return detected === EV || detected === ICE ? detected : UNKNOWN;
}

/**
 * Which capabilities belong on the device, and whether Homey should treat it
 * as a battery-powered device.
 *
 * `unknown` keeps every capability - removing one destroys its history and
 * breaks flows that reference it, which is far too destructive to do on a
 * guess - but is not declared battery-powered, so it cannot raise the alert
 * this issue is about.
 *
 * @param {'ev'|'ice'|'unknown'} powertrain
 * @returns {{add: string[], remove: string[], batteries: boolean}}
 */
function capabilityPlan(powertrain) {
  const keepEv = powertrain !== ICE;

  return {
    add: keepEv ? [...EV_CAPABILITIES] : [],
    remove: keepEv ? [] : [...EV_CAPABILITIES],
    batteries: powertrain === EV
  };
}

module.exports = {
  EV,
  ICE,
  UNKNOWN,
  EV_CAPABILITIES,
  classifyFromFeatures,
  resolvePowertrain,
  capabilityPlan
};
