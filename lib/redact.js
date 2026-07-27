'use strict';

/**
 * Shared PII-redaction engine for Mercedes-Benz Homey app logs.
 *
 * Used two ways:
 *  - at runtime, via lib/log-redactor.js, which wraps this.log/this.error on
 *    the App/Driver/Device instances so nothing identifying ever reaches a
 *    user-submitted diagnostic report in the first place
 *  - offline, via scripts/redact-log.js, as a safety net for logs that
 *    already exist (older app versions, third-party captures, etc.)
 *
 * See scripts/README-redact-log.md for the full behavior writeup.
 */

const crypto = require('crypto');

const PLACEHOLDER = {
  VIN: '[VIN_REDACTED]',
  LAT: '[LAT_REDACTED]',
  LON: '[LON_REDACTED]',
  LOG_ID: '[LOG_ID_REDACTED]',
  ZONE_NAME: '[ZONE_NAME_REDACTED]',
  FENCE_ID: '[FENCE_ID_REDACTED]',
  VIOLATION_ID: '[VIOLATION_ID_REDACTED]',
  HEX_VIN: '[HEX_VIN_REDACTED]',
};

const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/;
const VIN_PATTERN_G = new RegExp(VIN_PATTERN.source, 'g');

// Context-anchored patterns used to (a) find the canonical value and
// (b) rewrite that exact spot. Applied before the generic fallback passes
// so a value discovered once via context gets scrubbed everywhere else too.
const CONTEXT_PATTERNS = [
  { name: 'vin_field', re: /\bVIN:\s*([A-HJ-NPR-Z0-9]{17})\b/g, type: 'VIN' },
  { name: 'vin_json', re: /"vin":\s*"([A-HJ-NPR-Z0-9]{17})"/g, type: 'VIN' },
  { name: 'vin_for', re: /\bfor\s+([A-HJ-NPR-Z0-9]{17})\b/g, type: 'VIN' },
  // Note: Homey's own [Device:<uuid>] log tag is deliberately NOT redacted -
  // it's a random Homey-internal device ID that doesn't map to anything
  // outside the user's own Homey install, so it isn't PII.
  { name: 'log_id', re: /Log ID:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g, type: 'LOG_ID' },
  { name: 'fence_id', re: /"fenceId":(\d{5,})/g, type: 'FENCE_ID' },
  { name: 'violation_id', re: /,"id":(\d{6,})/g, type: 'VIOLATION_ID' },
  { name: 'zone_name', re: /"name":"([^"]+)"/g, type: 'ZONE_NAME' },
  { name: 'lat_lon_prose', re: /(Setting location:\s*)(-?\d+\.\d+)(,\s*)(-?\d+\.\d+)/g, type: 'LATLON_PAIR' },
  { name: 'lat_prose', re: /(Setting latitude(?: from geofence)?:\s*)(-?\d+\.\d+)/g, type: 'LAT' },
  { name: 'lon_prose', re: /(Setting longitude(?: from geofence)?:\s*)(-?\d+\.\d+)/g, type: 'LON' },
  { name: 'lat_json', re: /("latitude":)(-?\d+\.\d+)/g, type: 'LAT' },
  { name: 'lon_json', re: /("longitude":)(-?\d+\.\d+)/g, type: 'LON' },
];

function makeHasher(salt) {
  return (type, value) => {
    const digest = crypto.createHmac('sha256', salt).update(`${type}:${value}`).digest('hex');
    return digest.slice(0, 8).toUpperCase();
  };
}

// Default opts: blanket typed placeholders, no pseudonymization. Runtime
// logging always uses this - correlating values across a live session isn't
// worth the extra complexity/cost of hashing on every log call.
const DEFAULT_OPTS = { pseudonymize: false, hash: null };

function placeholderFor(type, value, opts) {
  if (!opts.pseudonymize) return PLACEHOLDER[type];
  const base = PLACEHOLDER[type].slice(1, -1); // strip [ ]
  return `[${base}_${opts.hash(type, value)}]`;
}

/**
 * Redact one text blob. Returns { output, knownVins } - knownVins feeds the
 * encoded-blob pass so hex/base64 dumps can be checked against real values,
 * not just the generic shape regex.
 */
function redactText(input, opts = DEFAULT_OPTS) {
  let text = input;
  const knownVins = new Set();

  // Layer 1: exact-match known values via context anchors.
  for (const ctx of CONTEXT_PATTERNS) {
    text = text.replace(ctx.re, (full, ...groups) => {
      if (ctx.type === 'VIN') {
        const value = groups[0];
        knownVins.add(value);
        return full.replace(value, placeholderFor('VIN', value, opts));
      }
      if (ctx.type === 'LOG_ID') {
        const value = groups[0];
        return full.replace(value, placeholderFor(ctx.type, value, opts));
      }
      if (ctx.type === 'FENCE_ID' || ctx.type === 'VIOLATION_ID') {
        const value = groups[0];
        return full.replace(value, placeholderFor(ctx.type, value, opts));
      }
      if (ctx.type === 'ZONE_NAME') {
        const value = groups[0];
        return `"name":"${placeholderFor('ZONE_NAME', value, opts)}"`;
      }
      if (ctx.type === 'LATLON_PAIR') {
        const [prefix, lat, sep, lon] = groups;
        return `${prefix}${placeholderFor('LAT', lat, opts)}${sep}${placeholderFor('LON', lon, opts)}`;
      }
      if (ctx.type === 'LAT') {
        const [prefix, lat] = groups;
        return `${prefix}${placeholderFor('LAT', lat, opts)}`;
      }
      if (ctx.type === 'LON') {
        const [prefix, lon] = groups;
        return `${prefix}${placeholderFor('LON', lon, opts)}`;
      }
      return full;
    });
  }

  // Layer 2: generic regex fallback for values regex-shaped like a VIN that
  // weren't already caught above (e.g. a future log line format).
  text = text.replace(VIN_PATTERN_G, (value) => {
    knownVins.add(value);
    return placeholderFor('VIN', value, opts);
  });

  // Layer 3: encoded copies. Scan hex dumps ("... (hex): <hexstring>") and
  // redact any run whose decoded bytes contain a known/likely VIN. Must run
  // last so plaintext passes above have already populated knownVins.
  text = text.replace(/\(hex\):\s*([0-9a-fA-F]+)/g, (full, hexStr) => {
    const redactedHex = redactHexForVin(hexStr, knownVins, opts);
    return full.replace(hexStr, redactedHex);
  });

  // Same idea for base64 blobs, best-effort: only touches tokens that
  // actually decode to something containing a known/likely VIN.
  text = text.replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, (token) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) return token;
    let decoded;
    try {
      decoded = Buffer.from(token, 'base64').toString('latin1');
    } catch {
      return token;
    }
    const found = findVinIn(decoded, knownVins);
    return found ? PLACEHOLDER.HEX_VIN : token;
  });

  return { output: text, knownVins };
}

function findVinIn(decodedAscii, knownVins) {
  for (const vin of knownVins) {
    if (decodedAscii.includes(vin)) return vin;
  }
  const m = decodedAscii.match(VIN_PATTERN);
  return m ? m[0] : null;
}

/**
 * Hex-decode a run and look for a VIN inside the decoded bytes. Mercedes
 * protobuf dumps encode the VIN as a length-prefixed ASCII string, so a
 * straight ASCII/latin1 decode of the whole buffer is enough to spot it as
 * a substring; we then map that substring back to its hex offset and
 * redact only that slice, leaving surrounding protobuf framing bytes intact.
 */
function redactHexForVin(hexStr, knownVins, opts) {
  const clean = hexStr.length % 2 === 0 ? hexStr : hexStr.slice(0, -1);
  let bytes;
  try {
    bytes = Buffer.from(clean, 'hex');
  } catch {
    return hexStr;
  }
  const ascii = bytes.toString('latin1');
  const vin = findVinIn(ascii, knownVins);
  if (!vin) return hexStr;

  const charIndex = ascii.indexOf(vin);
  if (charIndex === -1) return hexStr;
  const hexStart = charIndex * 2;
  const hexEnd = hexStart + vin.length * 2;
  const replacement = opts.pseudonymize
    ? `[HEX_VIN_${opts.hash('VIN', vin)}]`
    : PLACEHOLDER.HEX_VIN;
  return hexStr.slice(0, hexStart) + replacement + hexStr.slice(hexEnd);
}

/**
 * Re-scan already-redacted output for anything that still looks like raw
 * PII. This is the acceptance gate for the offline scrubber - callers
 * should refuse to emit output that fails this check.
 */
function findSurvivingPii(text) {
  const offenders = [];

  for (const m of text.matchAll(VIN_PATTERN_G)) {
    offenders.push({ type: 'VIN', value: m[0] });
  }
  for (const m of text.matchAll(/Log ID:\s*([0-9a-fA-F-]{36})/g)) {
    offenders.push({ type: 'LOG_ID', value: m[1] });
  }
  for (const m of text.matchAll(/"fenceId":(\d{5,})/g)) {
    offenders.push({ type: 'FENCE_ID', value: m[1] });
  }
  for (const m of text.matchAll(/,"id":(\d{6,})/g)) {
    offenders.push({ type: 'VIOLATION_ID', value: m[1] });
  }
  for (const m of text.matchAll(/"latitude":(-?\d+\.\d+)/g)) {
    offenders.push({ type: 'LAT', value: m[1] });
  }
  for (const m of text.matchAll(/"longitude":(-?\d+\.\d+)/g)) {
    offenders.push({ type: 'LON', value: m[1] });
  }
  for (const m of text.matchAll(/Setting (?:location|latitude|longitude)[^\n]*?(-?\d+\.\d+)/g)) {
    offenders.push({ type: 'COORD', value: m[1] });
  }
  // Encoded-VIN leak check: hex dumps that still decode to a VIN shape.
  for (const m of text.matchAll(/\(hex\):\s*([0-9a-fA-F]+)/g)) {
    const clean = m[1].length % 2 === 0 ? m[1] : m[1].slice(0, -1);
    let ascii = '';
    try {
      ascii = Buffer.from(clean, 'hex').toString('latin1');
    } catch {
      continue;
    }
    const vinMatch = ascii.match(VIN_PATTERN);
    if (vinMatch) offenders.push({ type: 'HEX_VIN', value: vinMatch[0] });
  }

  return offenders;
}

module.exports = { redactText, findSurvivingPii, PLACEHOLDER, makeHasher, DEFAULT_OPTS };
