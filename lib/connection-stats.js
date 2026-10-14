'use strict';

/**
 * An hourly tally of what the push connection did, logged as one line.
 *
 * Whether the push connection is gentle enough on Mercedes is a question about
 * rates - handshakes per hour, refusals per hour, and why connections ended -
 * and the per-event log lines answer it only by counting them by hand across
 * hours of output. One summary line an hour makes two builds comparable: run
 * one, then the other, and read the lines side by side.
 *
 * Owned by MercedesAPI rather than by the WebSocket client, because the client
 * is rebuilt on recovery and a tally that died with it would undercount
 * exactly the hours worth looking at.
 */
class ConnectionStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.since = Date.now();

    // Upgrade requests sent, and how each one ended. `failed` is any refusal
    // or transport failure before the socket opened that was not a 429.
    this.handshakes = 0;
    this.opened = 0;
    this.rateLimited = 0;
    this.failed = 0;

    // Why connections that had opened came to an end.
    //   idle  - closed by the app because the car had nothing to say
    //   1001  - Mercedes rotating the connection ("Going away")
    //   drop  - lost: 1006, or the liveness watchdog gave up on it
    //   other - any other close code from the server
    this.closes = { idle: 0, 1001: 0, drop: 0, other: 0 };
  }

  noteHandshake() {
    this.handshakes++;
  }

  noteOpened() {
    this.opened++;
  }

  noteRateLimited() {
    this.rateLimited++;
  }

  noteFailed() {
    this.failed++;
  }

  /** @param {'idle'|'1001'|'drop'|'other'} reason */
  noteClose(reason) {
    const key = Object.prototype.hasOwnProperty.call(this.closes, reason) ? reason : 'other';
    this.closes[key]++;
  }

  describe() {
    const minutes = Math.round((Date.now() - this.since) / 60000);
    const c = this.closes;
    return `[WS] Connection stats for the last ${minutes} min: `
      + `handshakes=${this.handshakes} (open=${this.opened}, 429=${this.rateLimited}, failed=${this.failed}), `
      + `closes: idle=${c.idle}, 1001=${c[1001]}, drop=${c.drop}, other=${c.other}`;
  }

  /** The line for the period just ended, starting the next one. */
  takeLine() {
    const line = this.describe();
    this.reset();
    return line;
  }
}

module.exports = ConnectionStats;
