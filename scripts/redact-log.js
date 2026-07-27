#!/usr/bin/env node
'use strict';

/**
 * CLI safety net for logs that already exist (older app versions,
 * third-party captures, logs copy-pasted into an issue, etc). The real fix
 * is lib/log-redactor.js, wired into app.js/device.js/driver.js, which
 * keeps this data out of new logs in the first place - see
 * scripts/README-redact-log.md.
 *
 * Usage:
 *   node scripts/redact-log.js <file> [file...]   writes <file>.redacted next to each input
 *   cat log.txt | node scripts/redact-log.js -    filters stdin -> stdout
 *
 * Options:
 *   --pseudonymize        replace identifiers with a stable per-value token
 *                         (same raw value -> same token everywhere) instead
 *                         of a blanket typed placeholder
 *   --salt <value>        salt for --pseudonymize (default: read from
 *                         REDACT_SALT env var, or a random one printed to
 *                         stderr - only stable pseudonyms need a fixed salt)
 */

const fs = require('fs');
const crypto = require('crypto');
const { redactText, findSurvivingPii, PLACEHOLDER, makeHasher } = require('../lib/redact');

function scrub(input, opts) {
  const { output } = redactText(input, opts);
  const offenders = findSurvivingPii(output);
  return { output, offenders };
}

function parseArgs(argv) {
  const opts = { pseudonymize: false, salt: process.env.REDACT_SALT || null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pseudonymize') {
      opts.pseudonymize = true;
    } else if (arg === '--salt') {
      opts.salt = argv[++i];
    } else {
      opts.files.push(arg);
    }
  }
  if (opts.pseudonymize && !opts.salt) {
    opts.salt = crypto.randomBytes(16).toString('hex');
    process.stderr.write(`[redact-log] No --salt given, using random salt for this run: ${opts.salt}\n`);
    process.stderr.write('[redact-log] Pseudonyms will not be stable across runs unless you pass the same --salt (or set REDACT_SALT).\n');
  }
  opts.hash = makeHasher(opts.salt || 'redact-log-default-salt');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.files.length === 0) {
    process.stderr.write('Usage: redact-log.js <file> [file...] | redact-log.js -\n');
    process.exit(2);
  }

  if (opts.files.length === 1 && opts.files[0] === '-') {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const { output, offenders } = scrub(Buffer.concat(chunks).toString('utf8'), opts);
      if (offenders.length > 0) {
        reportOffendersAndExit(offenders);
      }
      process.stdout.write(output);
    });
    return;
  }

  let hadFailure = false;
  for (const file of opts.files) {
    const input = fs.readFileSync(file, 'utf8');
    const { output, offenders } = scrub(input, opts);
    if (offenders.length > 0) {
      process.stderr.write(`[redact-log] ${file}: self-verify FAILED, ${offenders.length} raw PII token(s) survived:\n`);
      for (const o of offenders) process.stderr.write(`  - ${o.type}: ${o.value}\n`);
      hadFailure = true;
      continue;
    }
    const outPath = `${file}.redacted`;
    fs.writeFileSync(outPath, output, 'utf8');
    process.stderr.write(`[redact-log] ${file} -> ${outPath}\n`);
  }
  if (hadFailure) process.exit(1);
}

function reportOffendersAndExit(offenders) {
  process.stderr.write(`[redact-log] self-verify FAILED, ${offenders.length} raw PII token(s) survived:\n`);
  for (const o of offenders) process.stderr.write(`  - ${o.type}: ${o.value}\n`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { scrub, redactText, findSurvivingPii, PLACEHOLDER };
