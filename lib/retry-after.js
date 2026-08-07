'use strict';

/**
 * Reading Mercedes' own answer to "how long should I wait?".
 *
 * Every backoff window in this app used to be invented: the only thing taken
 * from a rate-limited handshake was the status code, scraped out of an error
 * message string, and the wait that followed was a ladder chosen by us. RFC
 * 9110 §15.5.30 says a 429 *should* carry `Retry-After`, and if it does, that
 * number beats any guess - the common 429 (the one every app restart earns)
 * clears in seconds, while a guessed ladder makes the user sit out a block
 * that was already over.
 */

/**
 * Parse an HTTP `Retry-After` value into milliseconds.
 *
 * Both forms in the spec are in real use: delta-seconds ("120") and an
 * HTTP-date ("Fri, 07 Aug 2026 12:00:00 GMT"). Anything that is not clearly
 * one of them returns null rather than a number: a value the app cannot read
 * is worse than no value at all, because it would be honoured as whatever
 * `parseInt` happened to salvage from it ("3 weeks" -> 3 seconds).
 *
 * @param {String|Number} value - raw header value
 * @param {Number} [now] - reference time, only used by the date form
 * @returns {Number|null} milliseconds to wait (never negative), or null
 */
function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null) return null;

  // A header read off a duplicated field arrives as an array.
  const raw = String(Array.isArray(value) ? value[0] : value).trim();
  if (!raw) return null;

  // delta-seconds. Digits only, deliberately: a negative or fractional value
  // is malformed, and falling back to the app's own backoff is safer than
  // guessing what was meant.
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  // Every HTTP-date form in the spec names a month, so a value with no letters
  // in it is not a date - and must not be handed to Date.parse, which reads
  // "-5" as a year and would turn a malformed delta into "retry now".
  if (!/[a-zA-Z]/.test(raw)) return null;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;

  // A date already in the past means "you may retry now".
  return Math.max(0, at - now);
}

/**
 * Choose the backoff window to serve, given what the server asked for and
 * what the app would have picked on its own.
 *
 * `retryAfterMs` wins while it is still trusted - that is the whole point of
 * reading the header. Clamped at both ends, because the app has to survive a
 * value that is hostile or simply wrong: `Retry-After: 0` must not become a
 * hot retry loop, and an absurd one must not pin the app offline for a day.
 *
 * Once refusals keep arriving *despite* the header being honoured, the
 * server's number is no longer the whole story and `fallbackMs` becomes a
 * floor. A limiter that keeps saying "a few seconds" and refusing anyway is
 * exactly the fixed-window loop that froze an account for three days (issue
 * #69), wearing a header: it expires, the app knocks once, and another window
 * of the same length opens. The app's own window has to keep widening
 * underneath.
 *
 * @param {Object} options
 * @param {Number|null} options.retryAfterMs - parsed header, or null if absent
 * @param {Number} options.fallbackMs - the app's own escalating window
 * @param {Number} options.minMs - shortest window worth serving
 * @param {Number} options.maxMs - longest window the app will ever serve
 * @param {Boolean} [options.trusted] - false once the header has been honoured
 *   and refused through anyway; the fallback then acts as a floor
 * @returns {{ ms: Number, askedMs: Number|null }}
 */
function resolveBackoff({ retryAfterMs, fallbackMs, minMs, maxMs, trusted = true }) {
  const own = Math.min(fallbackMs, maxMs);

  if (retryAfterMs === null || retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) {
    return { ms: own, askedMs: null };
  }

  const asked = Math.min(Math.max(retryAfterMs, minMs), maxMs);

  return {
    ms: trusted ? asked : Math.max(asked, own),
    askedMs: retryAfterMs,
  };
}

/**
 * The headers worth saying out loud when a request is refused: what the
 * limiter is willing to tell us about itself. Everything else on the response
 * is noise (or, in the case of cookies, not ours to log).
 */
function describeRateLimitHeaders(headers = {}) {
  const interesting = Object.entries(headers)
    .filter(([name]) => {
      const key = name.toLowerCase();
      return key === 'retry-after' || key.includes('ratelimit') || key.includes('rate-limit');
    })
    .map(([name, value]) => `${name}: ${value}`);

  return interesting.length ? interesting.join(', ') : 'none';
}

module.exports = { parseRetryAfter, resolveBackoff, describeRateLimitHeaders };
