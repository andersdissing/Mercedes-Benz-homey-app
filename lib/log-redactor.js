'use strict';

const { redactText } = require('./redact');

/**
 * Wrap an instance's log()/error() so PII never reaches the log buffer that
 * Homey packages into a user-submitted diagnostic report.
 *
 * Call this as the very first thing in onInit(), before any other logging,
 * on the App instance, and on every Driver/Device instance. lib/api.js,
 * lib/websocket.js and lib/oauth.js all log via `this.homey.app.log(...)`,
 * so wrapping the App instance once covers them too; Driver and Device log
 * via their own this.log/this.error and need their own wrap.
 *
 * Only string arguments are redacted - every VIN/coordinate/zone-name log
 * line in this app is built as a template string before it reaches
 * log()/error(), so that covers the actual risk surface without risking
 * mangling non-string args (errors, objects, arrays of key names, etc).
 */
function installRedactedLogging(instance) {
  if (instance.__piiRedactionInstalled) return;
  instance.__piiRedactionInstalled = true;

  for (const method of ['log', 'error']) {
    const original = instance[method];
    if (typeof original !== 'function') continue;
    const boundOriginal = original.bind(instance);
    instance[method] = (...args) => boundOriginal(...args.map(redactArg));
  }
}

function redactArg(arg) {
  if (typeof arg !== 'string') return arg;
  return redactText(arg).output;
}

module.exports = { installRedactedLogging, redactArg };
