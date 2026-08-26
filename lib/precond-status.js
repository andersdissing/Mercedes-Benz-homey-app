'use strict';

/**
 * Whether the car is preconditioning right now, from the attributes Mercedes
 * spreads that fact across.
 *
 * Kept out of device.js so it can be tested: requiring a driver or device file
 * outside Homey fails with `Class extends value undefined`.
 *
 * Mercedes does not send one "preconditioning is running" flag. A manual
 * start - the Preheat button in the Mercedes me app, or this app's own
 * command - flips `precondNow`; a departure-time start flips
 * `precondActive`. climate_active and onoff_precond were driven by
 * `precondActive` alone, so a preheat started by hand in the Mercedes me app
 * never showed up in Homey (#73). mbapi2020 hit the same and derives its
 * Preclimate status from precondNow OR precondActive OR precondState's
 * activation flag; so does this.
 *
 * Nil attributes never reach the parsed data, and a partial push carries only
 * what changed, so the last-known value of each attribute is kept and merged:
 * a partial update that says only `precondNow: false` must not switch off a
 * departure-time preconditioning that `precondActive` reported earlier.
 */

// Both spellings, because attribute names have arrived in either case.
const FIELDS = {
  now: ['precondNow', 'precondnow'],
  active: ['precondActive', 'precondactive'],
  state: ['precondState', 'precondstate'],
};

/**
 * Coerce an attribute value to a boolean the way the other status
 * capabilities do: true, 'true' and positive numbers are on.
 */
function toBool(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false' || s === '') return false;
    return Number(s) > 0;
  }
  return false;
}

/**
 * Merge the precond attributes present in `data` over the last-known ones.
 * @param {Object|undefined} previous - result of the last merge, or undefined
 * @param {Object} data - parsed vehicle data (full or partial update)
 * @returns {{ state: Object, seen: boolean }} the merged state and whether
 *   this update carried any of the attributes at all
 */
function mergePrecondState(previous, data) {
  const state = { ...(previous || {}) };
  let seen = false;
  for (const [field, names] of Object.entries(FIELDS)) {
    for (const name of names) {
      if (data && data[name] !== undefined) {
        state[field] = data[name];
        seen = true;
        break;
      }
    }
  }
  return { state, seen };
}

/**
 * Is preconditioning running, given the merged state?
 *
 * `precondState` is the parser's decode of the attribute's activation_state
 * (field 1 of the PrecondState message - see vehicle-events.proto). It is ORed
 * in like mbapi2020 does; on its own it is the least understood of the three,
 * so the log line carries all of them.
 */
function isPrecondRunning(state) {
  return toBool(state.now) || toBool(state.active) || toBool(state.state);
}

/** The merged state as a log fragment. */
function describePrecondState(state) {
  return `precondNow=${state.now}, precondActive=${state.active}, precondState=${state.state}`;
}

module.exports = { mergePrecondState, isPrecondRunning, describePrecondState, toBool };
