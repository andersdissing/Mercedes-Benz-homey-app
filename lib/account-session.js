'use strict';

const crypto = require('crypto');
const MercedesOAuth = require('./oauth');
const MercedesAPI = require('./api');

/**
 * One Mercedes connection per account, shared by every car on it.
 *
 * Each Homey device used to build its own MercedesOAuth, MercedesAPI and
 * WebSocket client, which meant a two-car account opened *two* push sessions
 * to Mercedes - two logins, two APP-SESSION-IDs, two handshakes on every app
 * start, and, once refused, two independent HTTP 429 backoff ladders knocking
 * on their own schedules.
 *
 * That is issue #81. Its report is nine hours of refusals whose stderr carries
 * two interleaved series of `consecutive rate-limited attempts`, each counting
 * up on its own (9 at 12:58 and 9 at 13:06, 10 at 13:28 and 10 at 13:36, ...):
 * two clients, each backing off half an hour, so the account was knocked every
 * fifteen minutes on average and never gave the limiter the quiet period the
 * escalating ladder exists to buy. Every token refresh in that log persists to
 * exactly one of the two devices, and the two "not reconnecting for another
 * Ns" countdowns disagree - the same duplication seen from the other side.
 *
 * One session was always enough: the push stream is account-wide, not
 * per-vehicle. `vepUpdates.updates` and `apptwin_command_status_updates_by_vin`
 * both arrive keyed by VIN, and every device threw away the keys that were not
 * its own. mbapi2020 keeps one connection per account for the same reason.
 *
 * So the devices share one session and this registry owns it: the account's
 * OAuth identity and token, one API client, one push connection, and the
 * fan-out that hands each VIN's updates to the device that wants them.
 */

/** Stable, non-identifying label for an account, for the log. */
function accountLabel(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
}

class AccountSession {
  /**
   * @param {Object} homey
   * @param {String} key - registry key this session is filed under
   * @param {Object} deps - { createOAuth, createApi, onEmpty }
   */
  constructor(homey, key, deps) {
    this.homey = homey;
    this.key = key;
    this.label = accountLabel(key);
    this._deps = deps;

    /** VIN (upper case) -> subscriber, one per Homey device. */
    this._subscribers = new Map();

    /** Account credentials, adopted from the first device that has them. */
    this.credentials = null;

    this.oauth = null;
    this.api = null;

    this._readyPromise = null;
    this._connectPromise = null;
    this._lingerTimer = null;
    this._unknownVins = new Set();

    // Set the moment closing begins, not when it finishes. A session that is
    // on its way out must never be handed to a device arriving in that gap,
    // and must never reconnect: either would leave the account with two push
    // connections again, which is the whole fault this file removes.
    this._closed = false;

    // How long the session stays open after its last device lets go.
    //
    // A device that is merely re-initialising (repair, disable/enable) would
    // otherwise tear the account's session down and handshake a new one
    // seconds later - which is precisely the sequence Mercedes answers with
    // 429. Lingering makes that a no-op instead.
    this.LINGER_MS = 15000;
  }

  /**
   * Attach a device to this session.
   *
   * @param {Object} subscriber - { vin, region, deviceGuid, username, password,
   *   token, onPushData, onCommandFailed, onTokenRefresh }
   */
  attach(subscriber) {
    const vin = String(subscriber.vin).toUpperCase();

    if (this._lingerTimer) {
      clearTimeout(this._lingerTimer);
      this._lingerTimer = null;
    }

    this._subscribers.set(vin, { ...subscriber, vin });

    if (!this.oauth) this._build(subscriber);

    // A device arriving with a longer-lived token was authenticated more
    // recently than this session was, so its token - and the credentials that
    // produced it - are the ones to keep. That is what carries a repair
    // through: the repaired device re-attaches with a token just minted, and
    // the account's other cars ride the same refreshed session rather than
    // being disconnected to make room for it.
    if (this._isFresherToken(subscriber.token)) {
      this.oauth.token = subscriber.token;
      if (subscriber.username && subscriber.password) {
        this.credentials = { username: subscriber.username, password: subscriber.password };
      }
      this.homey.app.log(`[SESSION ${this.label}] Adopted the newer token of a joining vehicle`);
    }

    if (!this.credentials && subscriber.username && subscriber.password) {
      this.credentials = { username: subscriber.username, password: subscriber.password };
    }

    this.homey.app.log(
      `[SESSION ${this.label}] Vehicle attached - ${this._subscribers.size} on this account's push session`,
    );

    return this;
  }

  /**
   * Is this token more use than the one the session holds?
   *
   * Compared by expiry rather than by arrival: devices init in any order, and a
   * device that has been offline can turn up holding a token older than the one
   * the session is already running on.
   */
  _isFresherToken(token) {
    if (!token || !token.access_token) return false;
    if (!this.oauth.token || !this.oauth.token.access_token) return true;

    return (token.expires_at || 0) > (this.oauth.token.expires_at || 0);
  }

  /** Build the account's OAuth and API clients. Called once. */
  _build(subscriber) {
    this.region = subscriber.region;

    this.oauth = this._deps.createOAuth(subscriber.region, subscriber.deviceGuid);
    if (subscriber.token) this.oauth.token = subscriber.token;

    // Every device of the account keeps its own copy of the token, so any one
    // of them can still stand up a session on its own after a restart - and so
    // that removing one device does not strand the rest without a token.
    this.oauth.setTokenUpdateCallback(async (token) => {
      await this._persistToken(token);
    });

    this.api = this._deps.createApi(this.oauth, subscriber.region);

    // Routed by VIN: one client now serves the whole account, so a failure
    // that arrives minutes after its flow card returned has to find its way
    // back to the one device it belongs to.
    this.api.setCommandFailedHandler((failure) => this._dispatchCommandFailure(failure));

    // The last lever against a WebSocket 429: a refreshed token belongs to the
    // session being refused, so only a fresh login can be given a new one.
    this.api.setReloginHandler(async () => {
      const credentials = this.credentials;
      if (!credentials) {
        throw new Error('No stored credentials - re-pair the vehicle to enable re-login');
      }

      await this.oauth.login(credentials.username, credentials.password);
      await this._persistToken(this.oauth.token);
      this.homey.app.log(`[SESSION ${this.label}] Re-login completed, token stored`);
    });

    this.homey.app.log(`[SESSION ${this.label}] Opened a push session for this account`);
  }

  /** Hand a new token to every device on the account. */
  async _persistToken(token) {
    for (const subscriber of this._subscribers.values()) {
      if (!subscriber.onTokenRefresh) continue;
      try {
        await subscriber.onTokenRefresh(token);
      } catch (error) {
        this.homey.app.error(
          `[SESSION ${this.label}] Could not persist the token for a vehicle:`,
          error.message,
        );
      }
    }
  }

  /**
   * Protobuf parser loaded and a usable token in hand.
   *
   * Deduplicated because Homey initialises devices concurrently: without this,
   * a two-car account logs in twice at startup for one set of credentials.
   */
  async ensureReady() {
    if (!this._readyPromise) {
      this._readyPromise = this._prepare().catch((error) => {
        this._readyPromise = null; // let the next device retry
        throw error;
      });
    }

    return this._readyPromise;
  }

  async _prepare() {
    await this.api.initialize();

    if (this.oauth.token && !MercedesOAuth.isTokenExpired(this.oauth.token)) return;

    if (!this.credentials) {
      throw new Error('No stored credentials and no valid token - re-pair the vehicle');
    }

    this.homey.app.log(`[SESSION ${this.label}] No usable token - logging in`);
    await this.oauth.login(this.credentials.username, this.credentials.password);
    await this._persistToken(this.oauth.token);
  }

  /**
   * Make sure the account's push connection is up, without ever opening a
   * second one.
   *
   * Every device's health check calls this every five minutes, so the
   * deduplication is the point: two devices arriving together must produce one
   * handshake. `connectWebSocket()` is itself a no-op on a healthy socket and
   * refuses to handshake through a 429 backoff.
   */
  async ensurePushConnection() {
    if (this._closed) {
      this.homey.app.log(`[SESSION ${this.label}] Asked to connect a closed session - ignoring it`);
      return undefined;
    }

    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      await this.ensureReady();
      await this.api.connectWebSocket((vin, vehicleData, fullUpdate) => this._dispatchPush(
        vin,
        vehicleData,
        fullUpdate,
      ));
    })();

    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /** Hand one vehicle's push update to the device that owns that VIN. */
  async _dispatchPush(vin, vehicleData, fullUpdate) {
    const subscriber = this._subscribers.get(String(vin).toUpperCase());

    if (!subscriber) {
      // Normal for a car on the account that was never added to Homey - worth
      // saying once per VIN, and never again.
      if (!this._unknownVins.has(vin)) {
        this._unknownVins.add(vin);
        this.homey.app.log(`[SESSION ${this.label}] Push update for a vehicle no device owns - ignoring it`);
      }
      return;
    }

    await subscriber.onPushData(vin, vehicleData, fullUpdate);
  }

  /** Route a late command failure to the device whose car it was about. */
  _dispatchCommandFailure(failure) {
    const vin = failure && failure.vin ? String(failure.vin).toUpperCase() : null;
    const subscriber = vin ? this._subscribers.get(vin) : null;

    if (!subscriber || !subscriber.onCommandFailed) {
      this.homey.app.error(
        `[SESSION ${this.label}] Command failure for a vehicle no device owns - not reported`,
      );
      return;
    }

    return subscriber.onCommandFailed(failure);
  }

  /**
   * Detach a device. The session closes once the last one has gone - after
   * LINGER_MS, so a device that is only re-initialising keeps it.
   */
  async detach(vin) {
    const key = String(vin).toUpperCase();
    if (!this._subscribers.delete(key)) return;

    this.homey.app.log(
      `[SESSION ${this.label}] Vehicle detached - ${this._subscribers.size} left on this account`,
    );

    if (this._subscribers.size > 0) return;

    if (this.LINGER_MS > 0) {
      if (this._lingerTimer) clearTimeout(this._lingerTimer);
      this._lingerTimer = setTimeout(() => {
        this._lingerTimer = null;
        this.close().catch(() => {});
      }, this.LINGER_MS);
      return;
    }

    await this.close();
  }

  /** Close the push connection and retire this session. */
  async close() {
    if (this._subscribers.size > 0 || this._closed) return;

    this._closed = true;

    if (this._lingerTimer) {
      clearTimeout(this._lingerTimer);
      this._lingerTimer = null;
    }

    this.homey.app.log(`[SESSION ${this.label}] No vehicles left - closing the push session`);

    try {
      if (this.api) await this.api.disconnectWebSocket();
    } catch (error) {
      this.homey.app.error(`[SESSION ${this.label}] Error closing the push session:`, error.message);
    }

    this._deps.onEmpty(this.key, this);
  }

  /** How many devices are currently attached. */
  get size() {
    return this._subscribers.size;
  }

  /** Closed, or closing: either way, not to be reused. */
  get isClosed() {
    return this._closed;
  }
}

class AccountSessionRegistry {
  /**
   * @param {Object} homey
   * @param {Object} [factories] - test seam for the OAuth/API clients
   */
  constructor(homey, factories = {}) {
    this.homey = homey;
    this._sessions = new Map();

    this._createOAuth = factories.createOAuth
      || ((region, deviceGuid) => new MercedesOAuth(homey, region, deviceGuid));
    this._createApi = factories.createApi
      || ((oauth, region) => new MercedesAPI(homey, oauth, region));

    // Applied to every session created from here, so tests (and a future
    // setting) can change the linger without reaching into each one.
    this.LINGER_MS = null;
  }

  /**
   * The session for a device's account, creating it if this is the first
   * device of that account to ask.
   *
   * Synchronous on purpose: Homey initialises devices concurrently, so two
   * cars can arrive in the same tick. Anything awaited in here would let both
   * see "no session yet" and build one each - which is the bug this file
   * exists to remove. The asynchronous work lives in ensureReady().
   */
  acquire(subscriber) {
    const key = this._key(subscriber);

    let session = this._sessions.get(key);
    if (!session || session.isClosed) {
      session = new AccountSession(this.homey, key, {
        createOAuth: this._createOAuth,
        createApi: this._createApi,
        // By identity, not just by key: a session that closed while its
        // replacement was already filed here must not delete the replacement.
        onEmpty: (sessionKey, closing) => {
          if (this._sessions.get(sessionKey) === closing) this._sessions.delete(sessionKey);
        },
      });
      if (this.LINGER_MS !== null) session.LINGER_MS = this.LINGER_MS;
      this._sessions.set(key, session);
    }

    return session.attach(subscriber);
  }

  /**
   * What counts as "the same account": the login, in the region it logs into.
   *
   * Not the deviceGuid, which differs between separate pairing runs of the
   * same account - keying on it would leave such an account with one session
   * per run, which is the duplication this registry exists to prevent. A
   * device with no stored username keeps a session to itself rather than
   * joining someone else's.
   */
  _key(subscriber) {
    const region = subscriber.region || 'Europe';
    const username = (subscriber.username || '').trim().toLowerCase();

    return username ? `${region}|${username}` : `${region}|vin:${subscriber.vin}`;
  }

  /** Sessions currently open, for diagnostics. */
  get size() {
    return this._sessions.size;
  }
}

module.exports = { AccountSessionRegistry, AccountSession };
