'use strict';

const HOUR = 3600000;

/**
 * Where each counted event goes in a record: [field, position].
 *
 *   h - handshakes:          [opened, refused with 429, failed otherwise]
 *   c - connections closed:  [idle, 1001 rotation, dropped, other]
 *   k - commands, by result: [ok, failed, failed after the caller was told ok]
 */
const SLOTS = {
  open: ['h', 0],
  429: ['h', 1],
  failed: ['h', 2],
  idle: ['c', 0],
  1001: ['c', 1],
  drop: ['c', 2],
  other: ['c', 3],
  cmdOk: ['k', 0],
  cmdFailed: ['k', 1],
  cmdLate: ['k', 2],
};

const WIDTH = { h: 3, c: 4, k: 3 };

/** Served with the records, so GET /stats explains itself. */
const LEGEND = {
  t: 'start of the hour, UTC, unix seconds',
  h: 'handshakes [opened, refused with HTTP 429, failed otherwise]',
  c: 'connections closed [idle, 1001 rotation by Mercedes, dropped, other]',
  i: '1 if any car on the account had the ignition on during the hour',
  k: 'commands [ok, failed, failed after the flow had been told ok]',
  note: 'missing fields and trailing list entries are 0; hours with no record are hours the app was not running; the last record is the hour in progress',
};

const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR / 1000;

/** A record holds the hour and counters - nothing that could identify anyone. */
function isRecord(r) {
  return Boolean(r) && typeof r === 'object' && Number.isInteger(r.t);
}

/** Full in-memory form of a stored record. */
function expand(r) {
  const full = { t: r.t, i: r.i ? 1 : 0 };
  for (const [field, width] of Object.entries(WIDTH)) {
    const list = Array.isArray(r[field]) ? r[field] : [];
    full[field] = Array.from({ length: width }, (_, n) => (Number.isFinite(list[n]) ? list[n] : 0));
  }
  return full;
}

/**
 * Stored form: short keys, trailing zeros trimmed, empty fields left out.
 *
 * A parked car's hour is about 40 idle cycles and nothing else, which comes
 * out as {"t":1760000400,"h":[40],"c":[40]} - small enough that 60 days of
 * them is a modest settings value rather than a large one.
 */
function compact(full) {
  const r = { t: full.t };
  for (const field of Object.keys(WIDTH)) {
    const list = full[field].slice();
    while (list.length && list[list.length - 1] === 0) list.pop();
    if (list.length) r[field] = list;
  }
  if (full.i) r.i = 1;
  return r;
}

/**
 * The hourly connection tally, kept for 60 days in homey.settings.
 *
 * The log line (lib/connection-stats.js) answers "how did the last hour go"
 * only for as long as the log is kept, and only for whoever is watching it.
 * Comparing builds - always-on against the idle cycle, say - needs weeks of
 * hours side by side, so they are kept here and served by GET /stats.
 *
 * Counting happens in memory. Settings are written once an hour and when the
 * app stops, never per event: a parked car produces dozens of events an hour,
 * and each write rewrites the whole value.
 *
 * The hour in progress is written too (`cur`), so a restart does not lose it.
 * Back within the same hour, the app carries on counting into that same
 * record instead of starting a second one for the hour; back after it, the
 * stored record is closed as it stands. Either way no hour is counted twice.
 * A crash, with no chance to write, loses what came after the last write -
 * never more than an hour, and never by counting anything twice.
 *
 * One timeline for the whole app: with more than one Mercedes account the
 * counts are summed, which is what the comparison is about. Records carry
 * an hour and counters - no VIN, account, position or token.
 */
class StatsTimeline {
  /**
   * @param {Object} settings - homey.settings (get/set)
   * @param {Object} [options]
   */
  constructor(settings, { key = 'connectionTimeline', retentionHours = 1440, log = () => {} } = {}) {
    this.settings = settings;
    this.KEY = key;
    this.RETENTION_HOURS = retentionHours; // 60 days
    this._log = log;

    this._hours = []; // closed hours, compact, oldest first
    this._current = null; // the hour in progress, expanded
    this._ignitionNow = false;
  }

  /** Pick up what an earlier run stored. Never throws. */
  load() {
    let stored = null;
    try {
      stored = this.settings.get(this.KEY);
    } catch (error) {
      this._log(`[STATS] Could not read the stored timeline: ${error.message}`);
    }

    this._hours = stored && Array.isArray(stored.hours) ? stored.hours.filter(isRecord) : [];
    this._current = null;

    const cur = stored && isRecord(stored.cur) ? stored.cur : null;
    if (cur) {
      if (cur.t === hourOf(Date.now())) {
        this._current = expand(cur); // same hour: carry on counting into it
      } else {
        this._hours.push(compact(expand(cur))); // an hour that ended while we were away
      }
    }

    this._prune();
  }

  /** Count one event. In memory only. */
  count(event) {
    const slot = SLOTS[event];
    if (!slot) return;
    const bucket = this._bucket();
    bucket[slot[0]][slot[1]]++;
  }

  /** Note whether an ignition is on; the hour records whether it ever was. */
  ignition(on) {
    // Roll over first: an hour that began with the ignition on was an hour
    // with the ignition on, even if the first thing heard in it is "off".
    const bucket = this._bucket();
    this._ignitionNow = Boolean(on);
    if (this._ignitionNow) bucket.i = 1;
  }

  /** Write closed hours and the hour in progress. Never throws. */
  flush() {
    this._bucket(); // close the previous hour if it has ended
    try {
      this.settings.set(this.KEY, { v: 1, hours: this._hours, cur: compact(this._current) });
    } catch (error) {
      this._log(`[STATS] Could not store the timeline: ${error.message}`);
    }
  }

  /** Every hour kept, the one in progress last - what GET /stats serves. */
  toJSON() {
    this._bucket();
    return { keys: LEGEND, hours: [...this._hours, compact(this._current)] };
  }

  /** The record for this hour, closing the previous one if it has ended. */
  _bucket() {
    const t = hourOf(Date.now());
    if (this._current && this._current.t === t) return this._current;

    if (this._current) this._hours.push(compact(this._current));
    this._current = expand({ t, i: this._ignitionNow ? 1 : 0 });
    this._prune();
    return this._current;
  }

  /** Keep 60 days: the hour in progress plus the 1439 before it. */
  _prune() {
    const oldest = hourOf(Date.now()) - (this.RETENTION_HOURS - 1) * 3600;
    this._hours = this._hours.filter((r) => r.t >= oldest).slice(-(this.RETENTION_HOURS - 1));
  }
}

module.exports = { StatsTimeline, LEGEND };
