'use strict';

const WebSocket = require('ws');
const https = require('https');
const crypto = require('crypto');

/**
 * Backend command-failure codes worth saying in plain language.
 *
 * Mercedes reports these on a command status update, usually with an empty
 * message field, and the raw code is what ends up on a Homey flow card -
 * where it tells the user nothing about what to do next. Only codes whose
 * meaning is actually established belong here; anything else keeps falling
 * through to the code-and-message form, which is still better than a guess.
 */
const COMMAND_ERROR_MESSAGES = {
  // Reported by Mercedes as "this command is already running": the backend
  // refuses to dispatch while it still has an earlier command open for the
  // vehicle. A command the app already reported as accepted can stay open for
  // minutes - e.g. when the car is asleep and the command is queued behind a
  // wake-up - so this is what a second flow action tends to hit.
  RIS_COULD_NOT_SEND_COMMAND:
    'Mercedes is still busy with an earlier command for this vehicle, so it refused this one. '
    + 'Wait for the previous command to finish and try again.',
};

/**
 * Mercedes-Benz WebSocket Client
 * Handles real-time push updates from Mercedes API
 * Based on Home Assistant mbapi2020 websocket implementation
 */
class MercedesWebSocket {
  constructor(homey, oauth, region, protoParser, sessionId = null) {
    this.homey = homey;
    this.oauth = oauth;
    this.region = region;
    this.protoParser = protoParser;

    this.ws = null;
    this.isConnecting = false;
    this.isStopping = false;
    this.connectionState = 'disconnected';

    // In-flight connect attempt. Callers that arrive while a connect is
    // running await this instead of silently no-op'ing: an early return
    // used to leave the caller thinking a connection existed, and a
    // never-cleared `isConnecting` flag latched the client offline for good.
    this._connectPromise = null;

    // Last connection failure, so callers (notably sendCommand) can report
    // *why* there is no socket instead of a generic "not available".
    this._lastConnectError = null;

    // Timestamp of the last proof of life (open, message or pong).
    this.lastMessageAt = null;

    // Serializes commands - each one recycles the shared socket, so two
    // concurrent commands would tear down each other's session.
    this._commandChain = Promise.resolve();

    // APP-SESSION-ID: one identity for this installation's push session.
    //
    // It must outlive *this object*, not just the reconnects it handles. The
    // client is thrown away and rebuilt on every recovery (see
    // MercedesAPI.connectWebSocket), so minting the id here meant Mercedes
    // saw a brand-new app session every few minutes during an outage - while
    // the sessions it had already opened were still counted as live. That is
    // the shape of a handshake the backend answers with 429, and every retry
    // deepened it. The owner passes the id in; mbapi2020 keeps one for the
    // lifetime of the integration the same way.
    this.sessionId = sessionId || crypto.randomUUID().toUpperCase();

    // Message queue
    this.messageQueue = [];
    this.messageHandler = null;

    // Command tracking for responses
    this.pendingCommands = new Map();

    // The most recent command Mercedes has not reported as ended.
    // See _awaitPreviousCommandCompletion().
    this._commandInFlight = null;

    // Called when a command fails after its caller has already been answered.
    // Tracking outlives the caller (see COMMAND_TRACKING_TIMEOUT), so by then
    // rejecting the caller's promise settles nothing - without this the
    // failure reaches the log and nowhere else. See setCommandFailedHandler().
    this._onCommandFailed = null;

    // A command's caller and the command itself end at different times.
    //
    // The caller is a Homey flow card, so it must be released or failed
    // quickly. Mercedes, meanwhile, can hold the command open long after
    // that - a command queued behind a wake-up on a sleeping car - and
    // refuses any other command while it does. Tracking has to outlive the
    // caller for the app to know that, but not indefinitely: past
    // COMMAND_TRACKING_TIMEOUT the app stops believing the command is open
    // rather than blocking every later command on a status that never came.
    this.COMMAND_CALLER_TIMEOUT = 90000; // 90s - flow card gives up
    this.COMMAND_TRACKING_TIMEOUT = 300000; // 5 min - app stops tracking
    this.COMMAND_COMPLETION_WAIT = 60000; // how long a new command waits

    // Reconnection management
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 600000; // 10 minutes max
    this.reconnectTimer = null;

    // Watchdog timers
    this.connectionWatchdog = null;
    this.pingWatchdog = null;

    // Timeouts.
    //
    // The ping interval MUST stay comfortably below the connection
    // watchdog timeout: the ping is what produces the `pong` that proves
    // the connection is alive. Previously the watchdog (30s) expired
    // *before* the first ping (32s) was ever sent, so an idle connection
    // — a parked car with no telemetry changes is the normal case — was
    // guaranteed to be declared dead on every single connection.
    this.INITIAL_WATCHDOG_TIMEOUT = 60000; // 60 seconds
    this.DEFAULT_WATCHDOG_TIMEOUT = 60000; // 60 seconds
    this.PING_INTERVAL = 20000; // 20 seconds

    // A socket that has produced nothing (not even a pong) for this long is
    // treated as dead even if `readyState` still says OPEN. That state is
    // real: a dropped TCP path with no FIN/RST leaves a half-open socket
    // that never emits 'close', so readyState alone cannot detect it.
    // Three watchdog periods, so a healthy-but-idle connection - which
    // still pongs every 20s - is never mistaken for a zombie.
    this.STALE_TIMEOUT = 180000; // 3 minutes

    // A command can take ~60s and the vehicle may push nothing meanwhile, so
    // the liveness watchdog is relaxed while one is pending (mbapi2020 uses
    // the same 180s command timeout).
    this.COMMAND_WATCHDOG_TIMEOUT = 180000; // 3 minutes

    // How long to treat an HTTP 429 as "stay away". Applies to reconnect
    // backoff and to commands, and survives the client being re-created.
    //
    // The window has to *grow* with each consecutive 429. A fixed window is a
    // closed loop: it expires, the app makes one attempt, collects another
    // 429, and starts another window of exactly the same length - forever. A
    // user sat in that loop for three days, poking a rate-limited account
    // every 10 minutes and never giving Mercedes' limiter the quiet period it
    // wanted, while every capability that only arrives over the socket
    // (doors, windows, lock, sunroof) stayed frozen.
    //
    // But the first window must stay short. The overwhelmingly common 429 is
    // the one every app restart earns: the previous session is still open at
    // Mercedes when the new one handshakes seconds later, and the documented
    // recovery - re-authenticate, reconnect - has always taken about twelve
    // seconds. Opening with a ten-minute window (and, once the poll stood
    // down too, ten minutes of nothing updating at all) charged every restart
    // for a block that was already over. Start at half a minute, triple each
    // time, and settle at a half-hourly knock: quiet enough for a limiter
    // that means it, cheap for one that does not. mbapi2020 retries a 429 on
    // 10*n^2 seconds, which is quicker still.
    this.RATE_LIMIT_BACKOFF = 30000; // 30 seconds - first window
    this.RATE_LIMIT_BACKOFF_FACTOR = 3; // 30s, 90s, 4.5 min, 13.5 min, ...
    this.MAX_RATE_LIMIT_BACKOFF = 1800000; // 30 minutes - cap

    // Account blocking detection
    this.accountBlocked = false;
    this.blockedSinceTime = null;

    // Length of the window currently being served, and how many consecutive
    // rate-limited handshakes produced it. Strikes survive the window
    // elapsing - that is what makes the next one longer - and are cleared
    // only by a connection that actually comes up.
    this.blockedFor = 0;
    this.rateLimitStrikes = 0;

    // Bounded re-authentication after a 429 (see the error handler).
    this._tokenRefreshAttempts = 0;
    this.MAX_TOKEN_REFRESH_ATTEMPTS = 3;

    // Full re-login after a 429 that refreshing the token did not clear.
    //
    // A refresh returns a token for the session Mercedes is already refusing;
    // a login opens a new one, which is the only lever the app has when the
    // block is about the session rather than the token. Costly and heavily
    // bounded: one per episode, and only once the account has been refused
    // repeatedly. mbapi2020 does the same (INITIATE_RELOGIN_AFTER_429).
    this._onRelogin = null;
    this._reloginAttempts = 0;
    this.MAX_RELOGIN_ATTEMPTS = 1;
    this.RELOGIN_AFTER_STRIKES = 3;
    this._needsRelogin = false;

    // Error context for close handler
    this._lastError = null;
    this._needsTokenRefresh = false;

    // Socket factory seam. Production always uses the real `ws` client;
    // tests override this to drive the open/error/close event sequence,
    // which is where the reconnect dead-ends have historically hidden.
    this._createSocket = (url, options) => new WebSocket(url, options);

    // Custom HTTPS agent with TLS cipher order matching Mercedes mobile app.
    // Mercedes uses TLS fingerprinting to identify clients — Node.js default
    // cipher order (RSA before ECDSA) is silently rejected for vehicle commands.
    // Matching Python/aiohttp cipher order (ECDSA first) resolves this.
    this._agent = new https.Agent({
      ciphers: [
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305',
      ].join(':'),
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ecdhCurve: 'X25519:prime256v1:secp384r1',
      maxCachedSessions: 0,
    });

    this.homey.app.log('[WS] MercedesWebSocket initialized');
  }

  /**
   * Get WebSocket URL for region
   */
  _getWebSocketUrl() {
    const urls = {
      'Europe': 'wss://websocket.emea-prod.mobilesdk.mercedes-benz.com/v2/ws',
      'North America': 'wss://websocket.amap-prod.mobilesdk.mercedes-benz.com/v2/ws',
      'Asia-Pacific': 'wss://websocket.amap-prod.mobilesdk.mercedes-benz.com/v2/ws',
      'China': 'wss://websocket.cn-prod.mobilesdk.mercedes-benz.com/v2/ws'
    };

    return urls[this.region] || urls['Europe'];
  }

  /**
   * Get connection headers
   */
  async _getConnectionHeaders() {
    const accessToken = await this.oauth.getAccessToken();

    const headers = {
      'Authorization': accessToken,
      'APP-SESSION-ID': this.sessionId,
      'OUTPUT-FORMAT': 'PROTO',
      'X-SessionId': this.sessionId,
      'X-TrackingId': crypto.randomUUID().toUpperCase(),
      'ris-os-name': 'ios',
      'ris-os-version': '26.3',
      'ris-sdk-version': '4.4.2',
      'X-Locale': 'en-GB',
      'User-Agent': 'Mercedes-Benz/3044 CFNetwork/3860.400.22 Darwin/25.3.0',
      'X-ApplicationName': 'mycar-store-ece',
      'ris-application-version': '1.65.1 (3174)'
    };

    return headers;
  }

  /**
   * Connect to WebSocket.
   *
   * Failures are absorbed here (logged, then retried via backoff) because
   * the main caller is the background push connection, which must keep
   * retrying rather than surface an error. Callers that need to know
   * whether a socket actually came up - sendCommand() - use
   * `connectOrThrow()` instead.
   */
  async connect(onDataReceived) {
    try {
      await this.connectOrThrow(onDataReceived);
    } catch (error) {
      this.homey.app.error('[WS] Connection failed:', error.message);
      this._scheduleReconnect();
    }
  }

  /**
   * Connect, rejecting if the socket does not come up.
   *
   * Concurrent callers share the single in-flight attempt instead of being
   * told "already connecting" and left with nothing: that early return used
   * to strand callers (and, when `isConnecting` was never cleared - see
   * disconnect() - it stranded the client permanently).
   */
  async connectOrThrow(onDataReceived) {
    if (this.isStopping) {
      throw new Error('WebSocket client is stopping');
    }

    if (this._connectPromise) {
      this.homey.app.log('[WS] Connect already in progress, awaiting it');
      return this._connectPromise;
    }

    this.messageHandler = onDataReceived;
    this.isConnecting = true;

    this._connectPromise = (async () => {
      // A block that survived several refreshed tokens is about the session,
      // not the token. Log in again to open a new one before handshaking.
      if (this._needsRelogin && this._onRelogin) {
        this._needsRelogin = false;
        this._reloginAttempts++;
        this.homey.app.log(`[WS] Re-authenticating from scratch before reconnect (${this._reloginAttempts}/${this.MAX_RELOGIN_ATTEMPTS})`);
        try {
          await this._onRelogin();
          this.homey.app.log('[WS] Full re-login successful');
          this._needsTokenRefresh = false;
        } catch (loginError) {
          this.homey.app.error('[WS] Full re-login failed:', loginError.message);
        }
      }

      // Refresh token before reconnect if previous attempt indicated auth failure
      if (this._needsTokenRefresh) {
        this.homey.app.log('[WS] Refreshing token before reconnect...');
        try {
          await this.oauth.refreshToken();
          this.homey.app.log('[WS] Token refreshed successfully');
        } catch (refreshError) {
          this.homey.app.error('[WS] Token refresh failed:', refreshError.message);
        }
        this._needsTokenRefresh = false;
      }

      // Re-check, because everything above is asynchronous. A reconnect
      // timer clears its own handle before awaiting connect(), so a
      // disconnect() landing in this gap finds no timer to cancel and the
      // disposed client handshakes anyway - two upgrades ~200 ms apart,
      // observed in the field, doubling the request rate into a rate limiter
      // at the exact moment it must not be provoked.
      if (this.isStopping) {
        throw new Error('WebSocket client is stopping');
      }

      await this._connectInternal();
    })();

    try {
      await this._connectPromise;
      this._lastConnectError = null;
    } catch (error) {
      this._lastConnectError = error;
      throw error;
    } finally {
      // Always clear, on every path: a stuck `isConnecting` is what makes
      // every later connect attempt - reconnect timer, health check,
      // command - a silent no-op.
      this.isConnecting = false;
      this._connectPromise = null;
    }
  }

  /**
   * Extract HTTP status code from WebSocket handshake error
   */
  _extractHttpStatus(error) {
    if (!error || !error.message) return null;
    const match = error.message.match(/(\d{3})/);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Internal connection method
   */
  async _connectInternal() {
    const url = this._getWebSocketUrl();
    const headers = await this._getConnectionHeaders();

    this.homey.app.log(`[WS] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      let settled = false;

      const settleOk = () => {
        if (settled) return;
        settled = true;
        this._abortConnect = null;
        resolve();
      };

      const settleErr = (error) => {
        if (settled) return;
        settled = true;
        this._abortConnect = null;
        reject(error);
      };

      // Lets a teardown fail this attempt instead of leaving it hanging.
      // A pending connect promise that never settles would keep
      // `_connectPromise` set forever, and every later connect - reconnect
      // timer, health check, command - would just await that dead promise.
      this._abortConnect = settleErr;

      try {
        // Bind every handler to *this* socket rather than to `this.ws`, and
        // check identity before touching shared state. An abandoned socket
        // can still emit 'close' long after it was replaced; without this
        // guard that late event stops the live socket's watchdogs and
        // schedules a bogus reconnect.
        const socket = this._createSocket(url, {
          headers: headers,
          handshakeTimeout: 30000,
          perMessageDeflate: false,
          agent: this._agent,
        });
        this.ws = socket;

        const isCurrent = () => this.ws === socket;

        // Connection opened
        socket.on('open', () => {
          this.homey.app.log('[WS] Connected to Mercedes WebSocket');
          this.connectionState = 'connected';
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.accountBlocked = false;
          this.blockedSinceTime = null;
          this.blockedFor = 0;
          this.rateLimitStrikes = 0;
          this._tokenRefreshAttempts = 0;
          this._reloginAttempts = 0;
          this._needsRelogin = false;
          this._lastError = null;
          this.lastMessageAt = Date.now();

          // Start watchdog timers
          this._startConnectionWatchdog();
          this._startPingWatchdog();

          settleOk();
        });

        // Message received
        socket.on('message', async (data) => {
          if (!isCurrent()) return;

          try {
            // Reset watchdog timers on message receipt
            this.lastMessageAt = Date.now();
            this._resetConnectionWatchdog();
            this._resetPingWatchdog();

            // Process incoming message
            await this._processMessage(data);
          } catch (error) {
            this.homey.app.error('[WS] Error processing message:', error.message);
          }
        });

        // Connection error (fires before 'close' on handshake failure)
        socket.on('error', (error) => {
          const httpStatus = this._extractHttpStatus(error);
          this.homey.app.error(`[WS] WebSocket error: ${error.message} (HTTP status: ${httpStatus || 'N/A'})`);

          // Store error context for the close handler
          this._lastError = { message: error.message, httpStatus };

          if (httpStatus === 429) {
            this._registerRateLimit();

            // A 429 on the upgrade is often the backend rejecting the token
            // rather than pure request volume, so re-authenticate before the
            // next attempt - bounded, so a genuinely blocked account doesn't
            // turn into a token-refresh loop (mbapi2020 retries login 3x too).
            if (this._tokenRefreshAttempts < this.MAX_TOKEN_REFRESH_ATTEMPTS) {
              this._tokenRefreshAttempts++;
              this._needsTokenRefresh = true;
              this.homey.app.log(`[WS] Will re-authenticate before the next attempt (${this._tokenRefreshAttempts}/${this.MAX_TOKEN_REFRESH_ATTEMPTS})`);
            }

            // Refreshed tokens have not helped by now. Escalate once to a
            // full login, which is the only way to be given a new session.
            if (this.rateLimitStrikes >= this.RELOGIN_AFTER_STRIKES
              && this._reloginAttempts < this.MAX_RELOGIN_ATTEMPTS
              && this._onRelogin) {
              this._needsRelogin = true;
              this.homey.app.log('[WS] Refused repeatedly - will log in from scratch before the next attempt');
            }
          } else if (httpStatus === 401 || httpStatus === 403) {
            this.homey.app.error('[WS] Authentication rejected - token may be expired');
            this._needsTokenRefresh = true;
          } else if (httpStatus === 418) {
            this.homey.app.error('[WS] Server rejected handshake (HTTP 418) - will refresh token and retry');
            this._needsTokenRefresh = true;
          }

          settleErr(error);
        });

        // Connection closed
        socket.on('close', (code, reason) => {
          const reasonStr = reason ? reason.toString() : '';

          if (!isCurrent()) {
            // A socket we already replaced. Report it, and fail our own
            // attempt if it never opened, but touch no shared state: the
            // watchdogs and reconnect scheduling belong to whoever owns the
            // current socket.
            this.homey.app.log(`[WS] Ignoring close (code ${code}) from a superseded socket`);
            settleErr(new Error(`WebSocket closed with code ${code} before it was ready`));
            return;
          }

          this.connectionState = 'disconnected';
          this.isConnecting = false;
          this._stopWatchdogs();

          if (code === 1006) {
            // RFC 6455 Section 7.4.1: 1006 = Abnormal Closure
            // Connection closed without a close frame - typically means:
            // - TCP connection dropped
            // - WebSocket handshake failed (HTTP error during upgrade)
            // - Network interruption
            const errCtx = this._lastError;
            if (errCtx && errCtx.httpStatus) {
              this.homey.app.log(`[WS] Abnormal closure (1006) caused by HTTP ${errCtx.httpStatus} during handshake`);
            } else {
              this.homey.app.log('[WS] Abnormal closure (1006) - connection dropped without close frame');
            }
          } else if (code === 1000) {
            this.homey.app.log('[WS] Normal closure (1000)');
          } else if (code === 1001) {
            this.homey.app.log(`[WS] Going away (1001): ${reasonStr}`);
          } else {
            this.homey.app.log(`[WS] Connection closed - Code: ${code}, Reason: ${reasonStr || 'none'}`);
          }

          // A close always ends this attempt one way or the other. Settle
          // first, unconditionally: an unsettled promise here (e.g. a close
          // arriving while isStopping is set) would hang every future
          // connect behind it.
          const wasOpen = settled;
          settleErr(new Error(`WebSocket closed with code ${code}`));

          // Reconnect if not intentionally stopped
          if (!this.isStopping && wasOpen) {
            // Connection was open, then closed unexpectedly (mid-session
            // drop). Always schedule a reconnect here. `_lastError` must
            // not gate this: connect()'s promise already resolved when
            // this socket opened, so its catch block can never fire for
            // a later close, and skipping the reconnect on an error left
            // the connection permanently dead. _lastError still informs
            // backoff/token-refresh via _scheduleReconnect().
            this._scheduleReconnect();
          }
        });

        // Ping/Pong
        socket.on('pong', () => {
          if (!isCurrent()) return;

          // A pong proves the connection is alive even when the vehicle
          // has no new data to push, so it must reset the connection
          // watchdog too - not just the ping watchdog. Otherwise an idle
          // but perfectly healthy connection gets torn down.
          this.lastMessageAt = Date.now();
          this._resetConnectionWatchdog();
          this._resetPingWatchdog();
        });

      } catch (error) {
        this.homey.app.error('[WS] Failed to create WebSocket:', error.message);
        settleErr(error);
      }
    });
  }

  /**
   * Process incoming message
   */
  async _processMessage(data) {
    try {
      // Parse protobuf message
      const message = this.protoParser.parsePushMessage(data);

      if (!message) {
        this.homey.app.error('[WS] Failed to parse push message');
        return;
      }

      const messageType = message.msg;

      // Handle different message types
      let ackMessage = null;

      switch (messageType) {
        case 'vepUpdates':
          if (message.vepUpdates && message.vepUpdates.updates) {
            // Acknowledge before handing the payload to the devices, not after.
            // The ack is a transport-level receipt; the handler is not. Applying
            // an update costs one IPC round-trip per capability plus any flow
            // triggers it fires, so a push carrying ten attributes can outlast
            // the backend's ack timeout - at which point Mercedes re-sends the
            // same sequenceNumber and every capability write and flow trigger in
            // it runs a second time.
            //
            // sequenceNumber 0 is a real sequence number: the previous truthiness
            // check left it unacked, so the backend re-sent it indefinitely.
            if (message.vepUpdates.sequenceNumber !== undefined && message.vepUpdates.sequenceNumber !== null) {
              await this._sendMessage(
                this.protoParser.createAcknowledgeVepUpdatesByVin(message.vepUpdates.sequenceNumber)
              );
            }

            for (const [vin, vepUpdate] of Object.entries(message.vepUpdates.updates)) {

              try {
                // Extract vehicle data
                // The raw frame lets the parser report the field numbers of any
                // attribute this schema cannot decode (see _describeRawAttribute).
                const vehicleData = this.protoParser.extractVehicleData(vepUpdate, data);

                // Call message handler
                if (this.messageHandler) {
                  await this.messageHandler(vin, vehicleData, vepUpdate.fullUpdate);
                }
              } catch (err) {
                this.homey.app.error(`[WS] Error processing update for VIN ${vin}:`, err.message);
              }
            }
          }
          break;

        case 'assigned_vehicles':
        case 'assignedVehicles':
          ackMessage = Buffer.from('ba0100', 'hex');
          break;

        case 'apptwin_pending_command_request':
        case 'apptwinPendingCommandRequest':
          ackMessage = Buffer.from('aa0100', 'hex');
          break;

        case 'apptwin_command_status_updates_by_vin':
        case 'apptwinCommandStatusUpdatesByVin':

          // Handle command responses
          this._handleCommandStatusUpdates(message.apptwinCommandStatusUpdatesByVin);

          // sequenceNumber 0 is a real sequence number - the first update of a
          // session carries it. A truthiness check dropped that ack, leaving
          // the backend re-sending an update it considers undelivered. Same
          // fault as the vepUpdates ack above, same fix.
          if (message.apptwinCommandStatusUpdatesByVin.sequenceNumber != null) {
            ackMessage = this.protoParser.createAcknowledgeAppTwinCommandStatusUpdateByVin(
              message.apptwinCommandStatusUpdatesByVin.sequenceNumber
            );
          }
          break;

        case 'service_status_updates':
        case 'serviceStatusUpdates':
          {
            const ssu = message.serviceStatusUpdates || message.service_status_updates;
            if (ssu && ssu.sequenceNumber != null) {
              ackMessage = this.protoParser.createAcknowledgeServiceStatusUpdate(ssu.sequenceNumber);
            }
          }
          break;

        case 'user_data_update':
        case 'userDataUpdate':
          {
            const udu = message.userDataUpdate || message.user_data_update;
            if (udu && udu.sequenceNumber != null) {
              ackMessage = this.protoParser.createAcknowledgeUserDataUpdate(udu.sequenceNumber);
            }
          }
          break;

        case 'debugMessage':
          this.homey.app.log('[WS] Received debug message:', message.debugMessage.message);
          break;

        default:
          this.homey.app.log(`[WS] Unhandled message type: ${messageType}`);
      }

      // Send acknowledgment if needed
      if (ackMessage) {
        await this._sendMessage(ackMessage);
      }

    } catch (error) {
      this.homey.app.error('[WS] Error processing message:', error.message);
    }
  }

  /**
   * Send message to WebSocket
   */
  async _sendMessage(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
    return new Promise((resolve, reject) => {
      this.ws.send(buffer, { binary: true }, (err) => {
        if (err) {
          this.homey.app.error('[WS] Send error:', err.message);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Send ping to keep connection alive
   */
  _sendPing() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
      this._resetPingWatchdog();
    }
  }

  /**
   * Is a caller still waiting on a command result?
   */
  _hasCommandAwaitingCaller() {
    for (const pending of this.pendingCommands.values()) {
      if (pending.awaitingCaller) return true;
    }
    return false;
  }

  /**
   * Start connection watchdog timer
   */
  _startConnectionWatchdog() {
    this._stopConnectionWatchdog();

    // While a command is in flight the vehicle can go quiet for a minute or
    // more, so use the longer command timeout - tearing the socket down mid
    // command would abort it for no reason.
    //
    // Only a command someone is still waiting on justifies that. A command
    // the app merely keeps tracking to detect collisions must not buy a dead
    // socket three extra minutes of tolerance - a silent socket is exactly
    // the fault behind #56.
    const timeout = this._hasCommandAwaitingCaller()
      ? this.COMMAND_WATCHDOG_TIMEOUT
      : this.INITIAL_WATCHDOG_TIMEOUT;

    this.connectionWatchdog = setTimeout(() => {
      this.homey.app.log('[WS] Connection watchdog expired - no data received');
      this._handleConnectionTimeout();
    }, timeout);
  }

  /**
   * Reset connection watchdog timer
   */
  _resetConnectionWatchdog() {
    this._startConnectionWatchdog();
  }

  /**
   * Stop connection watchdog timer
   */
  _stopConnectionWatchdog() {
    if (this.connectionWatchdog) {
      clearTimeout(this.connectionWatchdog);
      this.connectionWatchdog = null;
    }
  }

  /**
   * Start ping watchdog timer
   */
  _startPingWatchdog() {
    this._stopPingWatchdog();

    this.pingWatchdog = setTimeout(() => {
      this._sendPing();
    }, this.PING_INTERVAL);
  }

  /**
   * Reset ping watchdog timer
   */
  _resetPingWatchdog() {
    this._startPingWatchdog();
  }

  /**
   * Stop ping watchdog timer
   */
  _stopPingWatchdog() {
    if (this.pingWatchdog) {
      clearTimeout(this.pingWatchdog);
      this.pingWatchdog = null;
    }
  }

  /**
   * Stop all watchdog timers
   */
  _stopWatchdogs() {
    this._stopConnectionWatchdog();
    this._stopPingWatchdog();
  }

  /**
   * Tear down the current socket WITHOUT marking the client as stopping.
   *
   * This is the recovery-path counterpart to disconnect(): it releases the
   * socket and timers so a fresh connection can be made, but deliberately
   * leaves `isStopping` alone. `isStopping` means "the user/app asked us to
   * stop, do not come back" and is checked by _scheduleReconnect(), so a
   * recovery path must never set it.
   */
  _teardownSocket(reason = 'WebSocket connection lost while command was pending') {
    this._stopWatchdogs();

    // Reject any pending commands so their Promises don't hang
    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.callerTimeout);
      clearTimeout(pending.trackingTimeout);
      // Release anything queued behind this command too: the session that
      // would have reported its completion is going away.
      if (pending.settleCompletion) pending.settleCompletion();
      pending.reject(new Error(reason));
    }
    this.pendingCommands.clear();
    this._commandInFlight = null;

    // Fail an in-flight connect attempt too. Its socket is about to lose
    // its listeners, so nothing would ever settle its promise otherwise -
    // and an unsettled `_connectPromise` blocks every future connect.
    if (this._abortConnect) {
      this._abortConnect(new Error('WebSocket connection attempt aborted by teardown'));
      this._abortConnect = null;
    }

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;

      try {
        // Drop listeners first: this socket is being abandoned, and its
        // late 'close' event must not drive reconnect scheduling (the
        // caller owns that decision).
        socket.removeAllListeners();

        // ...but leave exactly one 'error' listener behind. Closing a socket
        // that is still CONNECTING makes `ws` abort the handshake, and that
        // abort reports itself by emitting 'error' ("WebSocket was closed
        // before the connection was established") on a *later tick*. An
        // EventEmitter with no 'error' listener throws instead of emitting,
        // so that arrives as an uncaught exception - after this try/catch
        // has already returned, and outside any caller's try/catch too,
        // which is how a routine teardown crashed the app. A socket that
        // fails during its closing handshake does the same. This socket is
        // being discarded either way, so the error carries no information
        // the caller can act on: log it and let it go.
        socket.on('error', (error) => {
          this.homey.app.log(`[WS] Ignoring error from abandoned socket: ${error.message}`);
        });

        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, 'Client reconnect');
        }
      } catch (error) {
        this.homey.app.error('[WS] Error closing WebSocket during teardown:', error.message);
      }
    }

    this.connectionState = 'disconnected';
    this.isConnecting = false;
  }

  /**
   * Handle connection timeout
   */
  _handleConnectionTimeout() {
    this.homey.app.log('[WS] Connection timeout - initiating reconnect');
    // Must NOT call disconnect() here: that sets isStopping = true, which
    // makes the _scheduleReconnect() below silently return without ever
    // scheduling anything, leaving the socket permanently dead.
    this._teardownSocket();
    this._scheduleReconnect();
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  _scheduleReconnect({ countAttempt = true } = {}) {
    if (this.isStopping || this.reconnectTimer) {
      return;
    }

    // Re-arming to wait out a rate-limit window is not a failed attempt, and
    // must not inflate the exponential backoff.
    if (countAttempt) this.reconnectAttempts++;

    // Exponential backoff: 10s * attempts^2, capped at maxReconnectDelay (10 min)
    let delay = Math.min(
      10000 * Math.pow(this.reconnectAttempts, 2),
      this.maxReconnectDelay
    );

    // Add for rate limiting (HTTP 429) - need long backoff to let rate limit expire
    const blockedFor = this.getRateLimitRemaining();
    if (blockedFor > 0) {
      delay = Math.max(delay, blockedFor);
    }

    this.homey.app.log(`[WS] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay/1000}s`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      if (this.isStopping) return;

      // The window is re-read here, not trusted from scheduling time: another
      // path (a command, the device health check) can collect a 429 after
      // this timer was armed. Handshaking into a live block is what renews
      // the block, so wait it out instead.
      const blockedFor = this.getRateLimitRemaining();
      if (blockedFor > 0) {
        this.homey.app.log(`[WS] Reconnect due, but still rate-limited for ${Math.ceil(blockedFor / 1000)}s - waiting`);
        this._scheduleReconnect({ countAttempt: false });
        return;
      }

      this.homey.app.log('[WS] Attempting reconnection...');
      await this.connect(this.messageHandler);
    }, delay);
  }

  /**
   * Handle command status updates from WebSocket
   */
  _handleCommandStatusUpdates(statusUpdates) {
    if (!statusUpdates || !statusUpdates.updatesByVin) {
      this.homey.app.log('[WS] No status updates in message');
      return;
    }

    const STATE_MAP = {
      0: 'UNKNOWN',
      1: 'INITIATION',
      2: 'ENQUEUED',
      3: 'PROCESSING',
      4: 'WAITING',
      5: 'FINISHED',
      6: 'FAILED',
      7: 'ACKED_BY_APPTWIN',
      8: 'PIN_VALID',
      9: 'WAKEUP_SENT',
      10: 'WAITING_WAKEUP',
      11: 'WAITING_SYNC',
      12: 'COMMAND_SENT'
    };

    // Process each VIN's status updates
    for (const [vin, pidUpdates] of Object.entries(statusUpdates.updatesByVin)) {
      if (!pidUpdates.updatesByPid) continue;

      for (const status of Object.values(pidUpdates.updatesByPid)) {
        const requestId = status.requestId;
        const stateCode = status.state;
        const state = STATE_MAP[stateCode] || `UNKNOWN_${stateCode}`;

        this.homey.app.log(`[WS] Command status: ${state} (${stateCode}), requestId: ${requestId}, pending: [${[...this.pendingCommands.keys()].join(', ')}]`);
        if (status.errors && status.errors.length > 0) {
          this.homey.app.log(`[WS] Command errors:`, JSON.stringify(status.errors));
        }

        // Check if we're tracking this command
        const pending = this.pendingCommands.get(requestId);
        if (!pending) {
          continue;
        }

        // Resolve on acceptance (ACKED/PIN_VALID) or completion (FINISHED).
        // Don't wait for FINISHED — it can take 60s+ and exceeds Homey's flow timeout.
        //
        // Acceptance settles the *caller*, not the command: Mercedes still has
        // it open, and refuses an overlapping one with
        // RIS_COULD_NOT_SEND_COMMAND. So keep tracking it until it genuinely
        // ends, which is what the next command waits on.
        if (state === 'ACKED_BY_APPTWIN' || state === 'PIN_VALID') {
          this.homey.app.log(`[WS] Command ${requestId} accepted (${state}) - still open at Mercedes`);
          clearTimeout(pending.callerTimeout);
          pending.awaitingCaller = false;
          pending.resolve({ success: true, state });
        } else if (state === 'FINISHED') {
          this.homey.app.log(`[WS] Command ${requestId} finished`);
          pending.resolve({ success: true, state });
          this._completeCommand(requestId, pending);
        } else if (state === 'FAILED') {
          this.homey.app.error(`[WS] Command ${requestId} failed`);

          let errorMessage = 'Command failed';
          if (status.errors && status.errors.length > 0) {
            const parts = [];
            for (const err of status.errors) {
              this.homey.app.error(`[WS] Error: Code=${err.code}, Message=${err.message}`);

              // Prefer the explanation over Mercedes' own text: these codes
              // usually arrive with an empty message, so the flow card ended
              // up showing nothing but the raw code.
              const explained = COMMAND_ERROR_MESSAGES[err.code];
              if (explained) parts.push(`${explained} (${err.code})`);
              else if (err.message) parts.push(`${err.message} (${err.code})`);
              else if (err.code) parts.push(err.code);
            }
            if (parts.length > 0) errorMessage += `: ${parts.join('; ')}`;
          }

          // A caller that has already been answered cannot be failed: it was
          // resolved at acceptance, so this reject() settles nothing. Report
          // the failure out of band instead - it is the only account of what
          // the vehicle actually did with a command the user was told had
          // been sent.
          if (!pending.awaitingCaller) {
            const first = (status.errors && status.errors[0]) || {};
            this.homey.app.error(`[WS] Command ${requestId} (${pending.commandName}) failed after its caller had already returned`);
            this._notifyCommandFailed({
              requestId,
              commandName: pending.commandName,
              code: first.code || 'UNKNOWN',
              message: COMMAND_ERROR_MESSAGES[first.code] || first.message || '',
            });
          }

          pending.reject(new Error(errorMessage));
          this._completeCommand(requestId, pending);
        }
        // For INITIATED, ENQUEUED, PROCESSING, WAITING states, keep waiting (timeout remains active)
      }
    }
  }

  /**
   * Register a callback for commands that fail after their caller returned.
   *
   * @param {Function} handler - ({ requestId, commandName, code, message })
   */
  setCommandFailedHandler(handler) {
    this._onCommandFailed = handler;
  }

  /**
   * Report such a failure, without letting a faulty handler take the socket
   * down with it - this runs inside the message loop.
   */
  _notifyCommandFailed(details) {
    if (!this._onCommandFailed) return;

    try {
      const result = this._onCommandFailed(details);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          this.homey.app.error('[WS] Command-failed handler rejected:', error.message);
        });
      }
    } catch (error) {
      this.homey.app.error('[WS] Command-failed handler threw:', error.message);
    }
  }

  /**
   * Stop tracking a command that has genuinely ended, and release whatever
   * command is waiting behind it.
   */
  _completeCommand(requestId, pending) {
    clearTimeout(pending.callerTimeout);
    clearTimeout(pending.trackingTimeout);
    pending.awaitingCaller = false;
    this.pendingCommands.delete(requestId);

    if (this._commandInFlight && this._commandInFlight.requestId === requestId) {
      this._commandInFlight = null;
    }

    if (pending.settleCompletion) pending.settleCompletion();
  }

  /**
   * Let the previous command finish before sending another, or say why not.
   *
   * Mercedes will not dispatch a command while it still has one open for the
   * vehicle — it answers RIS_COULD_NOT_SEND_COMMAND ("this command is already
   * running"). The caller's promise resolves at ACKED_BY_APPTWIN so a flow
   * card doesn't sit for a minute waiting on FINISHED, which means a flow's
   * next action would otherwise go straight into that window.
   *
   * A command that has only just been sent is worth waiting for: it normally
   * completes well inside COMMAND_COMPLETION_WAIT, and the second flow action
   * then succeeds instead of failing. One that has already been open longer
   * than that is not — waiting would only postpone a refusal the backend has
   * effectively already given, so fail now and name how long it has been
   * open. That is the fact the user needs and the one the raw backend code
   * never carried.
   */
  async _awaitPreviousCommandCompletion() {
    const previous = this._commandInFlight;
    if (!previous) return;

    const openFor = Date.now() - previous.sentAt;

    if (openFor < this.COMMAND_COMPLETION_WAIT) {
      let timer = null;
      const completed = await Promise.race([
        previous.completion.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), this.COMMAND_COMPLETION_WAIT - openFor);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (completed) return;
    }

    // It may have ended while we waited.
    if (this._commandInFlight !== previous) return;

    const seconds = Math.round((Date.now() - previous.sentAt) / 1000);
    this.homey.app.error(
      `[WS] Refusing to send: command ${previous.requestId} has been open at Mercedes for ${seconds}s`,
    );
    throw new Error(
      `Mercedes has had a command open for this vehicle for ${seconds}s and will refuse another one `
      + 'until it finishes ("this command is already running"). Try again once it has completed.',
    );
  }

  /**
   * Send command to vehicle via WebSocket with response tracking.
   *
   * The command travels over the session that is already open — the same way
   * mbapi2020 (the reference implementation this client follows) does it:
   * `websocket.call(message, car_command=True)` on the long-lived connection,
   * with one session ID for the client's lifetime. We only open a connection
   * if there isn't a usable one.
   *
   * This used to tear the socket down and handshake a brand-new session with
   * a fresh session ID for *every* command, on the theory that Mercedes
   * silently drops commands sent on a data-push session. mbapi2020 does no
   * such thing, and the handshake-per-command is what got accounts
   * rate-limited (HTTP 429 on the upgrade) — after which the app was left
   * with no connection at all.
   *
   * @param {Buffer} message - Serialized protobuf command message
   * @param {String} requestId - Command request ID (for tracking response)
   * @returns {Promise} Resolves when the command is accepted, rejects on failure/timeout
   */
  async sendCommand(message, requestId, commandName = 'unknown') {
    // One command at a time: a command that has to open the connection
    // temporarily swaps `messageHandler` to watch for the warmup update.
    const run = this._commandChain.then(
      () => this._sendCommandExclusive(message, requestId, commandName),
      () => this._sendCommandExclusive(message, requestId, commandName),
    );

    // Keep the chain alive regardless of this command's outcome.
    this._commandChain = run.then(() => {}, () => {});

    return run;
  }

  /**
   * Run a single command. Callers go through sendCommand(), which serializes
   * access.
   */
  async _sendCommandExclusive(message, requestId, commandName = 'unknown') {
    // Mercedes refuses a command while it still has one open for the vehicle,
    // and acceptance is not completion - see _awaitPreviousCommandCompletion().
    await this._awaitPreviousCommandCompletion();

    if (!this.isHealthy()) {
      await this._connectForCommand();
    } else {
      this.homey.app.log(`[WS] Sending command ${requestId} on the existing session ${this.sessionId}`);
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const detail = this._lastError ? this._lastError.message
        : (this._lastConnectError ? this._lastConnectError.message : 'connection dropped before the command was sent');
      this._scheduleReconnect();
      throw new Error(`WebSocket connection not available for command: ${detail}`);
    }

    // Send first, then track. Registering the pending command before the
    // send leaked a 90s timer (and an unhandled rejection) whenever the
    // send itself failed.
    const socket = this.ws;
    await this._sendMessage(message);

    // The socket can be torn down while that send is in flight (shutdown,
    // recovery). Registering afterwards would arm timers nothing will ever
    // clear and leave a command marked as open at Mercedes on a session that
    // no longer exists - which would then fail every later command.
    if (this.ws !== socket) {
      throw new Error('WebSocket connection was replaced while the command was being sent');
    }

    this.homey.app.log(`[WS] Command ${requestId} sent, waiting for completion...`);

    // Settles when Mercedes reports this command finished or failed - which is
    // later than the caller's promise, and is what the next command waits on.
    let settleCompletion;
    const sentAt = Date.now();
    const completion = new Promise((resolve) => { settleCompletion = resolve; });
    this._commandInFlight = { requestId, sentAt, completion };

    // Wait for FINISHED or FAILED status
    const commandPromise = new Promise((resolve, reject) => {
      // The flow card gives up here. Tracking deliberately does not: Mercedes
      // can still have the command open, and the next command needs to know.
      const callerTimeout = setTimeout(() => {
        const pending = this.pendingCommands.get(requestId);
        if (pending) pending.awaitingCaller = false;
        this.homey.app.error(`[WS] Command ${requestId} timed out after ${this.COMMAND_CALLER_TIMEOUT / 1000}s - still tracking it`);
        reject(new Error(`Command timed out after ${this.COMMAND_CALLER_TIMEOUT / 1000} seconds`));
      }, this.COMMAND_CALLER_TIMEOUT);

      // Past this the app stops believing the command is open, rather than
      // blocking every later command on a final status that never came.
      const trackingTimeout = setTimeout(() => {
        const pending = this.pendingCommands.get(requestId);
        if (!pending) return;
        this.homey.app.log(`[WS] No final status for command ${requestId} after ${this.COMMAND_TRACKING_TIMEOUT / 1000}s - no longer tracking it`);
        this._completeCommand(requestId, pending);
      }, this.COMMAND_TRACKING_TIMEOUT);

      this.pendingCommands.set(requestId, {
        resolve,
        reject,
        callerTimeout,
        trackingTimeout,
        settleCompletion,
        sentAt,
        awaitingCaller: true,
        // Kept so a failure arriving minutes later can still name the command
        // it belonged to - by then the buffer is long gone.
        commandName,
      });
    });

    // Restart the watchdog now that the command is registered: it can take a
    // minute to come back with no vehicle push in between, and
    // _startConnectionWatchdog() picks the longer command timeout only while
    // something is pending. Tearing the socket down here would abort the
    // command for no reason (mbapi2020 relaxes its watchdog the same way).
    this._resetConnectionWatchdog();

    return commandPromise;
  }

  /**
   * Open a connection for a command that arrived while there wasn't a usable
   * one, and wait for the session to start pushing data.
   *
   * Unlike the background push channel this reports failures to the caller,
   * so a flow shows the real reason (401, 418, 429, handshake timeout) rather
   * than a bare "not available".
   */
  async _connectForCommand() {
    // Refuse to handshake while Mercedes is rate-limiting us. Retrying here
    // is what keeps the block alive, and the reconnect timer is already
    // counting down — so fail fast and tell the user how long is left.
    const blockedFor = this.getRateLimitRemaining();
    if (blockedFor > 0) {
      const wait = blockedFor < 90000
        ? `${Math.ceil(blockedFor / 1000)}s`
        : `~${Math.ceil(blockedFor / 60000)} min`;
      throw new Error(
        `Mercedes is rate-limiting the push connection (HTTP 429). Not reconnecting for another ${wait} — `
        + 'commands will work again as soon as it is back.',
      );
    }

    this.homey.app.log('[WS] No usable connection for command - connecting first...');

    // A reconnect scheduled earlier must not fire in the middle of the
    // command and replace the socket underneath it.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Track whether we've received the initial vepUpdate (session warmup)
    this._commandReady = false;
    const originalHandler = this.messageHandler;
    const warmupHandler = async (vin, vehicleData, fullUpdate) => {
      this._commandReady = true;
      if (originalHandler) {
        await originalHandler(vin, vehicleData, fullUpdate);
      }
    };

    try {
      await this.connectOrThrow(warmupHandler);
    } catch (error) {
      this.messageHandler = originalHandler;
      // The push connection still needs to come back on its own.
      this._scheduleReconnect();
      throw new Error(`WebSocket connection not available for command: ${error.message}`);
    }

    // Wait up to 30 seconds for the first vepUpdate, so the command lands on
    // a session the backend is already streaming on.
    this.homey.app.log('[WS] Waiting for session warmup (initial vepUpdate)...');
    for (let i = 0; i < 300; i++) {
      if (this._commandReady) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!this._commandReady) {
      this.homey.app.log('[WS] WARNING: No vepUpdate received during warmup, sending command anyway');
    } else {
      this.homey.app.log('[WS] Session warmed up — vepUpdate received');
    }

    // Restore original handler for ongoing data reception
    this.messageHandler = originalHandler;
  }

  /**
   * Disconnect from WebSocket - the genuine "stop, do not come back" path
   * (app/device shutdown, repair, api-level disposal).
   *
   * The teardown itself is shared with the recovery path: the socket must
   * always lose its listeners and always clear `isConnecting`, otherwise an
   * abandoned socket keeps driving state it no longer owns and a stale
   * `isConnecting` turns every later connect into a silent no-op.
   */
  disconnect() {
    this.homey.app.log('[WS] Disconnecting...');
    this.isStopping = true;

    // Stop reconnection
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this._teardownSocket('WebSocket disconnected while command was pending');

    this.homey.app.log('[WS] Disconnected');
  }

  /**
   * Get connection state
   */
  getConnectionState() {
    return this.connectionState;
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Milliseconds since the last proof of life (message, pong or open),
   * or null if the socket has never produced one.
   */
  getIdleTime() {
    return this.lastMessageAt === null ? null : Date.now() - this.lastMessageAt;
  }

  /**
   * Check if the connection is not just open, but actually alive.
   *
   * `readyState` cannot detect a half-open socket: when the TCP path is
   * dropped without a FIN/RST (NAT or carrier timeout, which is the normal
   * fate of an idle mobile-backend connection), the socket stays OPEN
   * forever and no 'close' event is ever emitted. Callers that decide
   * whether to reconnect must use this rather than isConnected(), or a
   * zombie socket is mistaken for a healthy one and the app silently stops
   * receiving vehicle data.
   */
  isHealthy() {
    if (!this.isConnected()) return false;

    const idle = this.getIdleTime();
    return idle !== null && idle < this.STALE_TIMEOUT;
  }

  /**
   * Record a rate-limited handshake and open a backoff window for it.
   *
   * Each consecutive 429 widens the window by RATE_LIMIT_BACKOFF_FACTOR, up
   * to MAX_RATE_LIMIT_BACKOFF.
   * Retrying at a fixed interval is what kept an account blocked
   * indefinitely: Mercedes wants a quiet period, and a window that never
   * grows never provides one.
   */
  _registerRateLimit() {
    this.rateLimitStrikes++;
    this.accountBlocked = true;
    this.blockedSinceTime = Date.now();
    this.blockedFor = Math.min(
      this.RATE_LIMIT_BACKOFF * Math.pow(this.RATE_LIMIT_BACKOFF_FACTOR, this.rateLimitStrikes - 1),
      this.MAX_RATE_LIMIT_BACKOFF
    );

    const wait = this.blockedFor < 90000
      ? `${Math.round(this.blockedFor / 1000)}s`
      : `${Math.round(this.blockedFor / 60000)} min`;

    this.homey.app.error(
      `[WS] Push connection rate-limited (HTTP 429) - backing off for ${wait} `
      + `(consecutive rate-limited attempts: ${this.rateLimitStrikes})`
    );
  }

  /**
   * Register the callback that logs in again from stored credentials.
   *
   * Optional: without it the app still recovers by refreshing the token, it
   * just has nothing left to try when the refusal is about the session.
   */
  setReloginHandler(handler) {
    this._onRelogin = handler;
  }

  /**
   * Milliseconds left on the current HTTP 429 backoff window, or 0.
   *
   * Clears the flag once the window has passed, so a single 429 can't pin
   * every later reconnect to the maximum delay forever. The strike count
   * deliberately survives - the *next* 429 has to back off further than this
   * one did, or the loop never widens.
   */
  getRateLimitRemaining() {
    if (!this.accountBlocked) return 0;

    const windowMs = this.blockedFor || this.RATE_LIMIT_BACKOFF;
    const elapsed = this.blockedSinceTime ? Date.now() - this.blockedSinceTime : windowMs;
    const remaining = windowMs - elapsed;

    if (remaining <= 0) {
      this.homey.app.log('[WS] Rate-limit backoff window elapsed - resuming normal backoff');
      this.accountBlocked = false;
      this.blockedSinceTime = null;
      this.blockedFor = 0;

      // Let re-authentication be tried again on the next 429. The budget is
      // only reset by a successful open otherwise, and no open ever happens
      // while blocked - so after three strikes the app stopped refreshing the
      // token entirely, closing off the one recovery it had if the 429 was
      // the backend rejecting a stale token rather than pure request volume.
      this._tokenRefreshAttempts = 0;
      return 0;
    }

    return remaining;
  }

  /**
   * Export/restore the rate-limit window so it survives this client being
   * replaced.
   *
   * Without this, every re-created client starts with a clean slate: the
   * device health check builds a fresh client every 5 minutes, which would
   * handshake straight through a 10-minute block and keep renewing it.
   *
   * The strike count travels too, and is reported even when no window is
   * currently open. Carrying only the deadline would reset the escalation to
   * 10 minutes on every replacement, which is the fixed-window loop again by
   * another route.
   */
  getRateLimitState() {
    const remaining = this.getRateLimitRemaining();
    if (remaining <= 0 && this.rateLimitStrikes === 0) return null;

    return {
      blockedUntil: remaining > 0 ? Date.now() + remaining : 0,
      strikes: this.rateLimitStrikes,
      // Travels for the same reason the strikes do: a rebuilt client with a
      // fresh login budget would log in again every time the health check
      // replaced it, which is the heaviest request the app can make.
      reloginAttempts: this._reloginAttempts,
    };
  }

  restoreRateLimitState(state) {
    if (!state) return;

    this.rateLimitStrikes = state.strikes || 0;
    this._reloginAttempts = state.reloginAttempts || 0;

    if (!state.blockedUntil || state.blockedUntil <= Date.now()) return;

    // Serve out what is left of the inherited window, rather than
    // back-dating into a window length this client never chose.
    const remaining = state.blockedUntil - Date.now();
    this.accountBlocked = true;
    this.blockedSinceTime = Date.now();
    this.blockedFor = remaining;
    this.homey.app.log(`[WS] Inherited rate-limit backoff, ${Math.ceil(remaining / 1000)}s remaining (strikes: ${this.rateLimitStrikes})`);
  }
}

module.exports = MercedesWebSocket;
