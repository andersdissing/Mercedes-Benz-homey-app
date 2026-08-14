'use strict';

/**
 * The wording of the "no live connection" warning shown on the device.
 *
 * Kept out of device.js so it can be tested: requiring a driver or device file
 * outside Homey fails with `Class extends value undefined`, so anything that
 * lives in there is untestable by construction.
 *
 * The numbers in this message have to be re-rendered on every health tick.
 * They were not: the warning was raised once and the early return above it
 * skipped every later tick, so a banner first written at the one-hour mark
 * still said "for 60 minutes" six hours later, next to a retry countdown
 * frozen at whatever it read that minute. Nothing was miscalculated - the
 * message simply stopped being rewritten.
 */

/**
 * How long the connection has been down, in words.
 *
 * Minutes alone stop meaning anything past an hour, which is exactly the
 * point this warning starts appearing.
 */
function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minutes`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`;

  return rest === 0 ? hourPart : `${hourPart} ${rest} min`;
}

/**
 * How long until the app tries again.
 *
 * Said in seconds while it is still seconds: the first backoff window is 30s,
 * and rounding that up to "~1 min" overstates a wait the user may see end
 * while they are still reading the sentence.
 */
function formatWait(ms) {
  if (ms < 90000) return `~${Math.max(5, Math.round(ms / 1000))}s`;
  return `~${Math.round(ms / 60000)} min`;
}

/**
 * Build the warning text for a push connection that has been down long enough
 * to matter.
 *
 * Names what is actually stale. The two limits fail differently: a refused
 * push connection leaves the polled values (battery, range, position) live,
 * and only a REST block stops everything - so saying "all updates are paused"
 * for the common case was the same half-truth the warning exists to end.
 *
 * @param {Object} state
 * @param {Number} state.downForMs - how long the socket has been down
 * @param {Number} [state.wsBlockedFor] - ms left on the WebSocket 429 window
 * @param {Number} [state.restBlockedFor] - ms left on the REST 429 window
 * @returns {String}
 */
function describePushStaleness({ downForMs, wsBlockedFor = 0, restBlockedFor = 0 }) {
  let detail;

  if (restBlockedFor > 0) {
    detail = 'Mercedes is rate-limiting this account (HTTP 429), so the app has paused its data '
      + `requests for another ${formatWait(restBlockedFor)} to let the limit clear. `
      + 'Every value shown is last-known.';
  } else if (wsBlockedFor > 0) {
    detail = 'Doors, windows, lock state and sunroof are showing their last known values, because '
      + `Mercedes is refusing the push connection (HTTP 429). The app retries in `
      + `${formatWait(wsBlockedFor)}; battery, range and position keep updating meanwhile.`;
  } else {
    detail = 'Battery, range and position still update, but doors, windows, lock state and '
      + 'sunroof are showing their last known values. The app is retrying the connection.';
  }

  return `No live connection to Mercedes for ${formatDuration(downForMs)}. ${detail}`;
}

module.exports = { describePushStaleness, formatDuration, formatWait };
