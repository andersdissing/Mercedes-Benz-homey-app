'use strict';

const WebSocket = require('ws');
const https = require('https');
const crypto = require('crypto');
const { AppVersionManager } = require('./app-version');

/**
 * Mercedes-Benz WebSocket Client
 * Handles real-time push updates from Mercedes API
 * Based on Home Assistant mbapi2020 websocket implementation
 */
class MercedesWebSocket {
  constructor(homey, oauth, region, protoParser, appVersion = null) {
    this.homey = homey;
    this.oauth = oauth;
    this.region = region;
    this.protoParser = protoParser;

    // Shared with the REST client so both present the same app identity, and
    // so one refresh serves every caller. Falls back to its own instance when
    // constructed standalone (tests).
    this.appVersion = appVersion || new AppVersionManager(homey, region);

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

    // Session ID - persistent across reconnects
    this.sessionId = crypto.randomUUID().toUpperCase();

    // Message queue
    this.messageQueue = [];
    this.messageHandler = null;

    // Command tracking for responses
    this.pendingCommands = new Map(); // requestId -> { resolve, reject, timeout, commandType }

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
    this.RATE_LIMIT_BACKOFF = 600000; // 10 minutes

    // Account blocking detection
    this.accountBlocked = false;
    this.blockedSinceTime = null;

    // Bounded re-authentication after a 429 (see the error handler).
    this._tokenRefreshAttempts = 0;
    this.MAX_TOKEN_REFRESH_ATTEMPTS = 3;

    // Error context for close handler
    this._lastError = null;
    this._needsTokenRefresh = false;

    // Set when a 429 calls for a full re-login rather than a refresh grant.
    this._needsReauthentication = false;

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

    // Ask Mercedes whether the app version we present is still acceptable
    // before handshaking. A stale version is one of the ways this upgrade ends
    // in a long-lived HTTP 429 that no backoff clears.
    await this.appVersion.refresh(this.oauth.endpoints && this.oauth.endpoints.rest);

    const headers = {
      'Authorization': accessToken,
      'APP-SESSION-ID': this.sessionId,
      'OUTPUT-FORMAT': 'PROTO',
      'X-SessionId': this.sessionId,
      'X-TrackingId': crypto.randomUUID().toUpperCase(),
      'X-Locale': 'en-GB',
    };

    return this.appVersion.applyWebSocketHeaders(headers);
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
      // A 429 at the upgrade needs a *full* login, not a refresh grant: the
      // identity service will happily mint a fresh access token that the
      // WebSocket then rejects all the same, because what Mercedes invalidated
      // is the session. mbapi2020 draws the same line (INITIATE_RELOGIN_AFTER_429
      // calls async_login_new, not a refresh), and only the full login clears it.
      if (this._needsReauthentication) {
        this._needsReauthentication = false;
        this.homey.app.log('[WS] Re-authenticating before reconnect (429 recovery)...');
        try {
          const ok = await this.oauth.reauthenticate();
          if (ok) {
            // A new session deserves a clean slate: the old one is what was
            // being refused, so do not keep serving its backoff.
            this.accountBlocked = false;
            this.blockedSinceTime = null;
            this.homey.app.log('[WS] Re-authentication succeeded - clearing the rate-limit backoff');
          }
        } catch (reauthError) {
          this.homey.app.error('[WS] Re-authentication failed:', reauthError.message);
        }
        this._needsTokenRefresh = false;
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
          this._tokenRefreshAttempts = 0;
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
            this.accountBlocked = true;
            this.blockedSinceTime = Date.now();
            this.homey.app.error('[WS] Account rate-limited (HTTP 429) - backing off');

            // A 429 on the upgrade is often the backend having invalidated the
            // session rather than pure request volume, so do a full re-login
            // before the next attempt - bounded, so a genuinely blocked account
            // doesn't turn into a login loop (mbapi2020 retries login 3x too).
            if (this._tokenRefreshAttempts < this.MAX_TOKEN_REFRESH_ATTEMPTS) {
              this._tokenRefreshAttempts++;
              this._needsReauthentication = true;
              this.homey.app.log(`[WS] Will re-authenticate before the next attempt (${this._tokenRefreshAttempts}/${this.MAX_TOKEN_REFRESH_ATTEMPTS})`);
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

          if (message.apptwinCommandStatusUpdatesByVin.sequenceNumber) {
            ackMessage = this.protoParser.createAcknowledgeAppTwinCommandStatusUpdateByVin(
              message.apptwinCommandStatusUpdatesByVin.sequenceNumber
            );
          }
          break;

        case 'service_status_updates':
        case 'serviceStatusUpdates':
          {
            const ssu = message.serviceStatusUpdates || message.service_status_updates;
            if (ssu && ssu.sequenceNumber) {
              ackMessage = this.protoParser.createAcknowledgeServiceStatusUpdate(ssu.sequenceNumber);
            }
          }
          break;

        case 'user_data_update':
        case 'userDataUpdate':
          {
            const udu = message.userDataUpdate || message.user_data_update;
            if (udu && udu.sequenceNumber) {
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
   * Start connection watchdog timer
   */
  _startConnectionWatchdog() {
    this._stopConnectionWatchdog();

    // While a command is in flight the vehicle can go quiet for a minute or
    // more, so use the longer command timeout - tearing the socket down mid
    // command would abort it for no reason.
    const timeout = this.pendingCommands.size > 0
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
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingCommands.clear();

    // Fail an in-flight connect attempt too. Its socket is about to lose
    // its listeners, so nothing would ever settle its promise otherwise -
    // and an unsettled `_connectPromise` blocks every future connect.
    if (this._abortConnect) {
      this._abortConnect(new Error('WebSocket connection attempt aborted by teardown'));
      this._abortConnect = null;
    }

    if (this.ws) {
      try {
        // Drop listeners first: this socket is being abandoned, and its
        // late 'close' event must not drive reconnect scheduling (the
        // caller owns that decision).
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Client reconnect');
        }
      } catch (error) {
        this.homey.app.error('[WS] Error closing WebSocket during teardown:', error.message);
      }

      this.ws = null;
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
  _scheduleReconnect() {
    if (this.isStopping || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff: 10s * attempts^2, capped at maxReconnectDelay (10 min)
    let delay = Math.min(
      10000 * Math.pow(this.reconnectAttempts, 2),
      this.maxReconnectDelay
    );

    // Add for rate limiting (HTTP 429) - need long backoff to let rate limit expire.
    //
    // A pending re-authentication is the exception. Waiting out the full window
    // only makes sense when the next attempt would be a repeat of the one that
    // was refused; a full re-login is a materially different attempt, and
    // sitting on it for ten minutes is how a session-invalidation block turns
    // into hours of downtime. Bounded by MAX_TOKEN_REFRESH_ATTEMPTS, so this
    // cannot become a fast retry loop against a genuinely throttled account.
    const blockedFor = this.getRateLimitRemaining();
    if (blockedFor > 0 && !this._needsReauthentication) {
      delay = Math.max(delay, blockedFor);
    }

    this.homey.app.log(`[WS] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay/1000}s`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      if (!this.isStopping) {
        this.homey.app.log('[WS] Attempting reconnection...');
        await this.connect(this.messageHandler);
      }
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
        if (state === 'ACKED_BY_APPTWIN' || state === 'PIN_VALID' || state === 'FINISHED') {
          clearTimeout(pending.timeout);
          this.homey.app.log(`[WS] Command ${requestId} accepted (${state})`);
          pending.resolve({ success: true, state });
          this.pendingCommands.delete(requestId);
        } else if (state === 'FAILED') {
          clearTimeout(pending.timeout);
          this.homey.app.error(`[WS] Command ${requestId} failed`);

          let errorMessage = 'Command failed';
          if (status.errors && status.errors.length > 0) {
            for (const err of status.errors) {
              this.homey.app.error(`[WS] Error: Code=${err.code}, Message=${err.message}`);
              if (err.message) errorMessage += `: ${err.message}`;
              if (err.code) errorMessage += ` (${err.code})`;
            }
          }

          pending.reject(new Error(errorMessage));
          this.pendingCommands.delete(requestId);
        }
        // For INITIATED, ENQUEUED, PROCESSING, WAITING states, keep waiting (timeout remains active)
      }
    }
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
  async sendCommand(message, requestId) {
    // One command at a time: a command that has to open the connection
    // temporarily swaps `messageHandler` to watch for the warmup update.
    const run = this._commandChain.then(
      () => this._sendCommandExclusive(message, requestId),
      () => this._sendCommandExclusive(message, requestId),
    );

    // Keep the chain alive regardless of this command's outcome.
    this._commandChain = run.then(() => {}, () => {});

    return run;
  }

  /**
   * Run a single command. Callers go through sendCommand(), which serializes
   * access.
   */
  async _sendCommandExclusive(message, requestId) {
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
    await this._sendMessage(message);
    this.homey.app.log(`[WS] Command ${requestId} sent, waiting for completion...`);

    // Wait for FINISHED or FAILED status
    const commandPromise = new Promise((resolve, reject) => {
      const timeoutMs = 90000; // 90 seconds (commands can take ~60s)
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error('Command timed out after 90 seconds'));
      }, timeoutMs);

      this.pendingCommands.set(requestId, { resolve, reject, timeout });
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
      const minutes = Math.ceil(blockedFor / 60000);
      throw new Error(
        `Mercedes is rate-limiting this account (HTTP 429). Not reconnecting for another ~${minutes} min — `
        + 'commands and vehicle updates will resume automatically.',
      );
    }

    this.homey.app.log('[WS] No usable connection for command - connecting first...');

    // A reconnect scheduled earlier must not fire in the middle of the
    // command and replace the socket underneath it.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // We only get here when isHealthy() is false, which includes a socket
    // that is stale (no traffic for STALE_TIMEOUT) but still reports
    // readyState OPEN - connectOrThrow() below never closes `this.ws` itself,
    // it just points `this.ws` at a brand-new socket. Without this teardown,
    // that stale socket stayed open on Mercedes' side while a second live
    // handshake went out on the same session/APP-SESSION-ID, which is exactly
    // the "two connections at once" pattern Mercedes' backend answers with an
    // HTTP 429 - and mbapi2020 never risks it because it only reconnects when
    // the connection object is already `.closed`.
    if (this.ws) {
      this._teardownSocket('Replacing a stale connection before sending a command');
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
   * Milliseconds left on the current HTTP 429 backoff window, or 0.
   *
   * Clears the flag once the window has passed, so a single 429 can't pin
   * every later reconnect to the maximum delay forever.
   */
  getRateLimitRemaining() {
    if (!this.accountBlocked) return 0;

    const elapsed = this.blockedSinceTime ? Date.now() - this.blockedSinceTime : this.RATE_LIMIT_BACKOFF;
    const remaining = this.RATE_LIMIT_BACKOFF - elapsed;

    if (remaining <= 0) {
      this.homey.app.log('[WS] Rate-limit backoff window elapsed - resuming normal backoff');
      this.accountBlocked = false;
      this.blockedSinceTime = null;
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
   */
  getRateLimitState() {
    const remaining = this.getRateLimitRemaining();
    return remaining > 0 ? { blockedUntil: Date.now() + remaining } : null;
  }

  restoreRateLimitState(state) {
    if (!state || !state.blockedUntil || state.blockedUntil <= Date.now()) return;

    this.accountBlocked = true;
    this.blockedSinceTime = state.blockedUntil - this.RATE_LIMIT_BACKOFF;
    this.homey.app.log(`[WS] Inherited rate-limit backoff, ${Math.ceil((state.blockedUntil - Date.now()) / 1000)}s remaining`);
  }
}

module.exports = MercedesWebSocket;
