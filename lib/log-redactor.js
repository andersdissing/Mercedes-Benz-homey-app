'use strict';

// VIN: 17-char ISO 3779 identifier (letters minus I/O/Q, plus digits).
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const VIN_TEST_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;

// Email addresses (Mercedes Me login is an email).
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Coordinates are only redacted next to their identifying label, so
// operational floats (tire pressure, SoC, ranges, ...) stay intact.
// Covers both prose ("Setting latitude from geofence: ...") and the raw
// protobuf attribute name ("positionLat":{"doubleValue":...}).
const LAT_RE = /((?:latitude|positionlat)[^0-9-]{0,30})(-?\d{1,3}\.\d+)/gi;
const LON_RE = /((?:longitude|positionlong)[^0-9-]{0,30})(-?\d{1,3}\.\d+)/gi;

// Geofence zone names are user-authored labels (e.g. "Home"), logged both
// as prose ("snapshot.name: "Home"") and inside raw JSON event dumps.
const ZONE_NAME_RE = /((?:snapshot|fence)\.name\s*:\s*)"[^"]*"/gi;
const ZONE_VALUE_RE = /(Setting geofence zone to:\s*)(\S+)/gi;

// Account-linked geofence IDs: redact large IDs, but leave structural
// zeros (e.g. `"id":0` on a snapshot) alone.
const FENCE_ID_RE = /("fenceId"\s*:\s*)\d+/gi;
const VIOLATION_ID_RE = /("id"\s*:\s*)\d{6,}/gi;

// Credentials and account-linked identifiers that show up as JSON-key/value
// pairs when a whole object (login payload, paired-device object, OAuth
// token) gets JSON.stringify'd into a log line.
const SENSITIVE_KEY_PLACEHOLDER = {
  password: 'PASSWORD',
  token: 'TOKEN',
  access_token: 'TOKEN',
  accesstoken: 'TOKEN',
  refresh_token: 'TOKEN',
  refreshtoken: 'TOKEN',
  id_token: 'TOKEN',
  idtoken: 'TOKEN',
  username: 'EMAIL',
  licenseplate: 'LICENSE_PLATE',
  deviceguid: 'DEVICE_ID',
  pin: 'PIN',
  name: 'ZONE',
};
const SENSITIVE_KEY_RE = new RegExp(
  `"(${Object.keys(SENSITIVE_KEY_PLACEHOLDER).join('|')})"(\\s*:\\s*)("[^"]*"|\\{[^{}]*\\}|[^,}\\]]+)`,
  'gi',
);

function redactText(text) {
  return text
    .replace(VIN_RE, '[VIN_REDACTED]')
    .replace(EMAIL_RE, '[EMAIL_REDACTED]')
    .replace(LAT_RE, (match, prefix) => `${prefix}[LAT_REDACTED]`)
    .replace(LON_RE, (match, prefix) => `${prefix}[LON_REDACTED]`)
    .replace(ZONE_NAME_RE, (match, prefix) => `${prefix}"[ZONE_REDACTED]"`)
    .replace(ZONE_VALUE_RE, (match, prefix) => `${prefix}[ZONE_REDACTED]`)
    .replace(FENCE_ID_RE, (match, prefix) => `${prefix}[FENCE_ID_REDACTED]`)
    .replace(VIOLATION_ID_RE, (match, prefix) => `${prefix}[VIOLATION_ID_REDACTED]`)
    .replace(SENSITIVE_KEY_RE, (match, key, sep) => {
      const placeholder = SENSITIVE_KEY_PLACEHOLDER[key.toLowerCase()];
      return `"${key}"${sep}"[${placeholder}_REDACTED]"`;
    });
}

/**
 * Scans hex-dumped byte buffers (e.g. `buffer.toString('hex')`) for a VIN
 * hiding in the decoded bytes and redacts just that slice of hex, leaving
 * the surrounding protobuf framing bytes untouched. Must run after the
 * plaintext passes so a hex-encoded copy can't survive just because the
 * plaintext copy nearby was already caught.
 */
function redactHexEncodedVin(text) {
  return text.replace(/\b(?:[0-9a-fA-F]{2}){10,}\b/g, (hexRun) => {
    let ascii = '';
    for (let i = 0; i < hexRun.length; i += 2) {
      ascii += String.fromCharCode(parseInt(hexRun.substr(i, 2), 16));
    }
    const match = ascii.match(VIN_TEST_RE);
    if (!match) return hexRun;

    const hexStart = match.index * 2;
    const hexLen = match[0].length * 2;
    return `${hexRun.slice(0, hexStart)}[HEX_VIN_REDACTED]${hexRun.slice(hexStart + hexLen)}`;
  });
}

function redactAllText(text) {
  return redactHexEncodedVin(redactText(text));
}

/**
 * Recursively redacts strings found anywhere in a value - not just a bare
 * string argument, but also plain objects/arrays (e.g. the object
 * `_describeError()` builds from an axios error) that get passed straight
 * to log/error and would otherwise bypass string-only scrubbing.
 */
function redactValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return redactAllText(value);
  if (!value || typeof value !== 'object' || depth > 5) return value;
  if (value instanceof Error) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) out[key] = redactValue(val, seen, depth + 1);
  return out;
}

/**
 * Wraps log/error on a Homey App/Driver/Device instance so VIN (plaintext
 * and hex-encoded), GPS coordinates, geofence zone/fence IDs, login email,
 * and credentials (password/OAuth token) never reach the log output that
 * diagnostic reports are built from.
 *
 * Defines a new own property rather than assigning to `log`/`error`
 * directly: those are non-writable properties on Homey App/Driver/Device
 * instances, so `instance.log = ...` throws "Cannot assign to read only
 * property" under strict mode. `Object.defineProperty` creates a new own
 * property that shadows the inherited one instead of writing through it.
 */
function installRedactedLogging(instance) {
  for (const methodName of ['log', 'error']) {
    const original = instance[methodName];
    if (typeof original !== 'function') continue;

    const bound = original.bind(instance);
    Object.defineProperty(instance, methodName, {
      value: (...args) => bound(...args.map((arg) => redactValue(arg))),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

module.exports = { installRedactedLogging, redactText: redactAllText, redactValue };
