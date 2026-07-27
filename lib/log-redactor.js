'use strict';

// VIN: 17-char ISO 3779 identifier (letters minus I/O/Q, plus digits).
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;

// Coordinates are only redacted next to their identifying label, so
// operational floats (tire pressure, SoC, ranges, ...) stay intact.
const LAT_RE = /(latitude[^0-9-]{0,30})(-?\d{1,3}\.\d+)/gi;
const LON_RE = /(longitude[^0-9-]{0,30})(-?\d{1,3}\.\d+)/gi;

// Geofence zone names are user-authored labels (e.g. "Home").
const ZONE_NAME_RE = /((?:snapshot|fence)\.name\s*:\s*)"[^"]*"/gi;
const ZONE_VALUE_RE = /(Setting geofence zone to:\s*)(\S+)/gi;

function redactText(text) {
  return text
    .replace(VIN_RE, '[VIN_REDACTED]')
    .replace(LAT_RE, (match, prefix) => `${prefix}[LAT_REDACTED]`)
    .replace(LON_RE, (match, prefix) => `${prefix}[LON_REDACTED]`)
    .replace(ZONE_NAME_RE, (match, prefix) => `${prefix}"[ZONE_REDACTED]"`)
    .replace(ZONE_VALUE_RE, (match, prefix) => `${prefix}[ZONE_REDACTED]`);
}

function redactArg(arg) {
  return typeof arg === 'string' ? redactText(arg) : arg;
}

/**
 * Wraps log/error on a Homey App/Driver/Device instance so VIN, GPS
 * coordinates and geofence zone names never reach the log output that
 * diagnostic reports are built from.
 *
 * Defines a new own property rather than assigning to `log`/`error`
 * directly: those are inherited getters on the Homey SDK prototype with
 * no setter, so `instance.log = ...` throws "Cannot assign to read only
 * property" under strict mode. `Object.defineProperty` creates a new own
 * property that shadows the inherited one instead of writing through it.
 */
function installRedactedLogging(instance) {
  for (const methodName of ['log', 'error']) {
    const original = instance[methodName];
    if (typeof original !== 'function') continue;

    const bound = original.bind(instance);
    Object.defineProperty(instance, methodName, {
      value: (...args) => bound(...args.map(redactArg)),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

module.exports = { installRedactedLogging, redactText };
