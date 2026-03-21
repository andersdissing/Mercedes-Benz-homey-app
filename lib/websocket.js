'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');
const https = require('https');

/**
 * Mercedes-Benz WebSocket Client
 * Handles real-time push updates from Mercedes API
 * Based on Home Assistant mbapi2020 websocket implementation
 */
class MercedesWebSocket {
  constructor(homey, oauth, region, protoParser) {
    this.homey = homey;
    this.oauth = oauth;
    this.region = region;
    this.protoParser = protoParser;

    this.ws = null;
    this.isConnecting = false;
    this.isStopping = false;
    this.connectionState = 'disconnected';

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

    // Timeouts (matching HA implementation)
    this.INITIAL_WATCHDOG_TIMEOUT = 30000; // 30 seconds
    this.DEFAULT_WATCHDOG_TIMEOUT = 30000; // 30 seconds
    this.PING_INTERVAL = 32000; // 32 seconds

    // Account blocking detection
    this.accountBlocked = false;
    this.blockedSinceTime = null;

    // Error context for close handler
    this._lastError = null;
    this._needsTokenRefresh = false;

    // Custom HTTPS agent with ECDSA-first cipher order (required by Mercedes TLS fingerprinting)
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

    // DEBUG: Log token format (first 30 chars)
    const tokenPreview = accessToken ? accessToken.substring(0, 30) + '...' : 'null';
    this.homey.app.log(`[WS] Auth token format: ${tokenPreview}`);
    if (accessToken && accessToken.startsWith('Bearer ')) {
      this.homey.app.log('[WS] WARNING: Token includes "Bearer " prefix - may need to remove it');
    }

    const headers = {
      'Authorization': accessToken,
      'APP-SESSION-ID': this.sessionId,
      'OUTPUT-FORMAT': 'PROTO',
      'X-SessionId': this.sessionId,
      'X-TrackingId': crypto.randomUUID().toUpperCase(),
      'ris-os-name': 'ios',
      'ris-os-version': '26.3',
      'ris-sdk-version': '3.26.2',
      'X-Locale': 'en-GB',
      'User-Agent': 'Mercedes-Benz/3044 CFNetwork/3860.400.22 Darwin/25.3.0',
      'X-ApplicationName': 'mycar-store-ece',
      'ris-application-version': '1.63.0 (3044)'
    };

    return headers;
  }

  /**
   * Connect to WebSocket
   */
  async connect(onDataReceived) {
    if (this.isConnecting || this.isStopping) {
      this.homey.app.log('[WS] Already connecting or stopping, skipping connect request');
      return;
    }

    this.messageHandler = onDataReceived;
    this.isConnecting = true;
    this.isStopping = false;

    try {
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
    } catch (error) {
      this.homey.app.error('[WS] Connection failed:', error.message);
      this.isConnecting = false;
      this._scheduleReconnect();
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

      try {
        this.ws = new WebSocket(url, {
          headers: headers,
          handshakeTimeout: 30000,
          perMessageDeflate: false,
          agent: this._agent,
        });

        // Connection opened
        this.ws.on('open', () => {
          this.homey.app.log('[WS] Connected to Mercedes WebSocket');
          this.connectionState = 'connected';
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.accountBlocked = false;
          this.blockedSinceTime = null;
          this._lastError = null;

          // Start watchdog timers
          this._startConnectionWatchdog();
          this._startPingWatchdog();

          settled = true;
          resolve();
        });

        // Message received
        this.ws.on('message', async (data) => {
          try {
            // Reset watchdog timers on message receipt
            this._resetConnectionWatchdog();
            this._resetPingWatchdog();

            // DEBUG: Log raw message info
            this.homey.app.log(`[WS] Received ${data.length} bytes`);
            if (data.length < 200) {
              // For small messages, show hex dump
              this.homey.app.log(`[WS] Hex dump: ${data.toString('hex')}`);
            } else {
              // For large messages, show first 100 bytes
              this.homey.app.log(`[WS] First 100 bytes (hex): ${data.slice(0, 100).toString('hex')}...`);
            }

            // Queue message for processing
            await this._processMessage(data);
          } catch (error) {
            this.homey.app.error('[WS] Error processing message:', error.message);
          }
        });

        // Connection error (fires before 'close' on handshake failure)
        this.ws.on('error', (error) => {
          const httpStatus = this._extractHttpStatus(error);
          this.homey.app.error(`[WS] WebSocket error: ${error.message} (HTTP status: ${httpStatus || 'N/A'})`);

          // Store error context for the close handler
          this._lastError = { message: error.message, httpStatus };

          if (httpStatus === 429) {
            this.accountBlocked = true;
            this.blockedSinceTime = Date.now();
            this.homey.app.error('[WS] Account rate-limited (HTTP 429) - backing off');
          } else if (httpStatus === 401 || httpStatus === 403) {
            this.homey.app.error('[WS] Authentication rejected - token may be expired');
            this._needsTokenRefresh = true;
          } else if (httpStatus === 418) {
            this.homey.app.error('[WS] Server rejected handshake (HTTP 418) - will refresh token and retry');
            this._needsTokenRefresh = true;
          }

          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        // Connection closed
        this.ws.on('close', (code, reason) => {
          const reasonStr = reason ? reason.toString() : '';
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

          // Reconnect if not intentionally stopped
          if (!this.isStopping) {
            if (settled) {
              // Connection was open, then closed unexpectedly (mid-session drop)
              // The error handler already rejected, so connect()'s catch handles
              // reconnect for handshake failures. For mid-session drops, schedule here.
              if (!this._lastError) {
                this._scheduleReconnect();
              }
            } else {
              // Connection never opened
              settled = true;
              reject(new Error(`WebSocket closed with code ${code}`));
            }
          }
        });

        // Ping/Pong
        this.ws.on('pong', () => {
          this._resetPingWatchdog();
        });

      } catch (error) {
        this.homey.app.error('[WS] Failed to create WebSocket:', error.message);
        if (!settled) {
          settled = true;
          reject(error);
        }
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
      this.homey.app.log(`[WS] Received message type: ${messageType}`);

      // Handle different message types
      let ackMessage = null;

      switch (messageType) {
        case 'vepUpdates':
          // VEPUpdatesByVIN - main vehicle data updates
          this.homey.app.log('[WS] Processing vepUpdates message');
          
          if (message.vepUpdates && message.vepUpdates.updates) {
            this.homey.app.log(`[WS] Received updates for ${Object.keys(message.vepUpdates.updates).length} vehicles`);
            
            // Process updates for each vehicle
            for (const [vin, vepUpdate] of Object.entries(message.vepUpdates.updates)) {
              this.homey.app.log(`[WS] Processing update for VIN: ${vin}`);
              
              try {
                // Extract vehicle data
                const vehicleData = this.protoParser.extractVehicleData(vepUpdate);
                
                // Call message handler
                if (this.messageHandler) {
                  await this.messageHandler(vin, vehicleData, vepUpdate.fullUpdate);
                }
              } catch (err) {
                this.homey.app.error(`[WS] Error processing update for VIN ${vin}:`, err.message);
              }
            }
            
            // Send acknowledgment
            if (message.vepUpdates.sequenceNumber) {
              ackMessage = this.protoParser.createAcknowledgeVepUpdatesByVin(message.vepUpdates.sequenceNumber);
            }
          }
          break;

        case 'assigned_vehicles':
        case 'assignedVehicles':
          this.homey.app.log('[WS] Received assigned vehicles');
          ackMessage = Buffer.from('ba0100', 'hex');
          break;

        case 'apptwin_pending_command_request':
        case 'apptwinPendingCommandRequest':
          this.homey.app.log('[WS] Received apptwin pending command request');
          ackMessage = Buffer.from('aa0100', 'hex');
          break;

        case 'apptwin_command_status_updates_by_vin':
          this.homey.app.log('[WS] Command status update');

          // Handle command responses
          this._handleCommandStatusUpdates(message.apptwinCommandStatusUpdatesByVin);

          if (message.apptwinCommandStatusUpdatesByVin.sequenceNumber) {
            ackMessage = this.protoParser.createAcknowledgeAppTwinCommandStatusUpdateByVin(
              message.apptwinCommandStatusUpdatesByVin.sequenceNumber
            );
          }
          break;

        case 'service_status_updates':
          // Note: HA uses ServiceStatusUpdatesByVIN (9), but our proto might use ServiceStatusUpdate (13) or 6. 
          // If parser identifies it, we just ack it.
          if (message.service_status_updates && message.service_status_updates.sequenceNumber) {
             ackMessage = this.protoParser.createAcknowledgeServiceStatusUpdate(
              message.service_status_updates.sequenceNumber
            );
          }
          break;

        case 'user_data_update':
          if (message.user_data_update && message.user_data_update.sequenceNumber) {
            ackMessage = this.protoParser.createAcknowledgeUserDataUpdate(
              message.user_data_update.sequenceNumber
            );
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
      throw new Error('Cannot send message - WebSocket not connected');
    }

    const buffer = Buffer.isBuffer(message) ? message : message.serializeToString();
    return new Promise((resolve, reject) => {
      this.ws.send(buffer, { binary: true }, (err) => {
        if (err) reject(err);
        else resolve();
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

    this.connectionWatchdog = setTimeout(() => {
      this.homey.app.log('[WS] Connection watchdog expired - no data received');
      this._handleConnectionTimeout();
    }, this.INITIAL_WATCHDOG_TIMEOUT);
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
   * Handle connection timeout
   */
  _handleConnectionTimeout() {
    this.homey.app.log('[WS] Connection timeout - initiating reconnect');
    this.disconnect();
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

    // Exponential backoff: 10s * attempts^2, max 120s
    let delay = Math.min(
      10000 * Math.pow(this.reconnectAttempts, 2),
      this.maxReconnectDelay
    );

    // Add for rate limiting (HTTP 429) - need long backoff to let rate limit expire
    if (this.accountBlocked) {
      delay = Math.max(delay, 600000); // At least 10 minutes for rate-limited accounts
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
      1: 'INITIATED',
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
      12: 'COMMAND_SENT',
    };

    // Process each VIN's status updates
    for (const [vin, pidUpdates] of Object.entries(statusUpdates.updatesByVin)) {
      if (!pidUpdates.updatesByPid) continue;

      for (const status of Object.values(pidUpdates.updatesByPid)) {
        const requestId = status.requestId;
        const stateCode = status.state;
        const state = STATE_MAP[stateCode] || 'UNKNOWN';
        
        this.homey.app.log(`[WS] Command ${requestId} status: ${state} (${stateCode})`);

        // Check if we're tracking this command
        const pending = this.pendingCommands.get(requestId);
        if (!pending) {
          continue;
        }

        // Clear timeout
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }

        // Resolve or reject based on state
        if (state === 'FINISHED') {
          this.homey.app.log(`[WS] Command ${requestId} completed successfully`);
          pending.resolve({ success: true, state });
          this.pendingCommands.delete(requestId);
        } else if (state === 'FAILED') {
          this.homey.app.error(`[WS] Command ${requestId} failed`);
          
          let errorMessage = 'Command failed';
          if (status.errors) {
            this.homey.app.error(`[WS] Error details: Code=${status.errors.code}, Message=${status.errors.message}`);
            if (status.errors.message) {
              errorMessage += `: ${status.errors.message}`;
            }
            if (status.errors.code) {
              errorMessage += ` (${status.errors.code})`;
            }
          }
          
          pending.reject(new Error(errorMessage));
          this.pendingCommands.delete(requestId);
        }
        // For INITIATED, ENQUEUED, PROCESSING states, keep waiting
      }
    }
  }

  /**
   * Send command to vehicle via WebSocket with response tracking.
   *
   * Mercedes silently drops commands sent on a persistent data-push session.
   * Each command requires a fresh WebSocket session with a new session ID.
   * We disconnect, reconnect, wait for an initial vepUpdate (session warmup),
   * then send the command and wait for FINISHED/FAILED.
   *
   * @param {Buffer} message - Serialized protobuf command message
   * @param {String} requestId - Command request ID (for tracking response)
   * @returns {Promise} Resolves when command reaches FINISHED, rejects on failure/timeout
   */
  async sendCommand(message, requestId) {
    this.homey.app.log(`[WS] sendCommand: starting fresh session for command ${requestId}`);

    // Save current handler so we restore it after the command session
    const savedHandler = this.messageHandler;

    // Disconnect the current data-push session
    this.disconnect();
    this.isStopping = false;

    // Generate a fresh session ID — required by Mercedes to accept commands
    this.sessionId = crypto.randomUUID().toUpperCase();
    this.homey.app.log(`[WS] sendCommand: new sessionId ${this.sessionId}`);

    // Warmup flag: set when the first vepUpdate arrives on the fresh session
    let commandReady = false;
    const warmupHandler = async (vin, vehicleData, fullUpdate) => {
      commandReady = true;
      if (savedHandler) await savedHandler(vin, vehicleData, fullUpdate);
    };

    // Connect with warmup handler
    await this.connect(warmupHandler);

    // Wait up to 30s for the first vepUpdate (session warmup)
    for (let i = 0; i < 300; i++) {
      if (commandReady) break;
      await new Promise(r => setTimeout(r, 100));
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.messageHandler = savedHandler;
      throw new Error('WebSocket connection not available for command');
    }

    if (!commandReady) {
      this.homey.app.log('[WS] sendCommand: warmup vepUpdate not received within 30s, proceeding anyway');
    }

    // Restore original handler for ongoing data-push after the command
    this.messageHandler = savedHandler;

    // Register the command promise (90s — FINISHED can take ~60s in real conditions)
    const commandPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error('Command timed out after 90 seconds'));
      }, 90000);

      this.pendingCommands.set(requestId, { resolve, reject, timeout, sentAt: Date.now() });
    });

    // Send the command
    try {
      this.homey.app.log(`[WS] Command buffer (hex): ${message.toString('hex')}`);
      await this._sendMessage(message);
      this.homey.app.log(`[WS] Command ${requestId} sent, waiting for FINISHED/FAILED...`);
    } catch (error) {
      const pending = this.pendingCommands.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingCommands.delete(requestId);
      }
      throw error;
    }

    return commandPromise;
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    this.homey.app.log('[WS] Disconnecting...');
    this.isStopping = true;

    // Reject any pending commands so their Promises don't hang
    for (const [reqId, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebSocket disconnected while command was pending'));
    }
    this.pendingCommands.clear();

    // Stop reconnection
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Stop watchdogs
    this._stopWatchdogs();

    // Close WebSocket
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Client shutdown');
        }
      } catch (error) {
        this.homey.app.error('[WS] Error closing WebSocket:', error.message);
      }

      this.ws = null;
    }

    this.connectionState = 'disconnected';
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
}

module.exports = MercedesWebSocket;
