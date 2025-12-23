'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');

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
    this.maxReconnectDelay = 120000; // 2 minutes max
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
      'ris-os-version': '15.1',
      'ris-sdk-version': '3.55.0',
      'X-Locale': 'en-GB',
      'User-Agent': 'MyCar/2168 CFNetwork/1494.0.7 Darwin/23.4.0',
      'X-ApplicationName': 'mycar-store-ece',
      'ris-application-version': '1.61.0'
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
      await this._connectInternal();
    } catch (error) {
      this.homey.app.error('[WS] Connection failed:', error.message);
      this.isConnecting = false;
      this._scheduleReconnect();
    }
  }

  /**
   * Internal connection method
   */
  async _connectInternal() {
    const url = this._getWebSocketUrl();
    const headers = await this._getConnectionHeaders();

    this.homey.app.log(`[WS] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url, {
          headers: headers,
          handshakeTimeout: 30000
        });

        // Connection opened
        this.ws.on('open', () => {
          this.homey.app.log('[WS] Connected to Mercedes WebSocket');
          this.connectionState = 'connected';
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.accountBlocked = false;
          this.blockedSinceTime = null;

          // Start watchdog timers
          this._startConnectionWatchdog();
          this._startPingWatchdog();

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

        // Connection error
        this.ws.on('error', (error) => {
          this.homey.app.error('[WS] WebSocket error:', error.message);

          // Check for 429 (rate limiting)
          if (error.message && error.message.includes('429')) {
            this.accountBlocked = true;
            this.blockedSinceTime = Date.now();
            this.homey.app.error('[WS] Account blocked (HTTP 429) - too many requests');
          }

          reject(error);
        });

        // Connection closed
        this.ws.on('close', (code, reason) => {
          this.homey.app.log(`[WS] Connection closed - Code: ${code}, Reason: ${reason || 'No reason'}`);
          this.connectionState = 'disconnected';
          this.isConnecting = false;

          this._stopWatchdogs();

          // Reconnect if not intentionally stopped
          if (!this.isStopping) {
            this._scheduleReconnect();
          }
        });

        // Ping/Pong
        this.ws.on('pong', () => {
          this._resetPingWatchdog();
        });

      } catch (error) {
        this.homey.app.error('[WS] Failed to create WebSocket:', error.message);
        reject(error);
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
          this.homey.app.log('[WS] Received assigned vehicles');
          ackMessage = Buffer.from('ba0100', 'hex');
          break;

        case 'apptwin_pending_command_request':
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
      this.homey.app.error('[WS] Cannot send message - WebSocket not connected');
      return;
    }

    try {
      const buffer = Buffer.isBuffer(message) ? message : message.serializeToString();
      this.ws.send(buffer);
    } catch (error) {
      this.homey.app.error('[WS] Error sending message:', error.message);
    }
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

    // Add for rate limiting (HTTP 429)
    if (this.accountBlocked) {
      delay = Math.max(delay, 60000); // At least 1 minute for blocked accounts
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
      6: 'FAILED'
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
   * Send command to vehicle via WebSocket with response tracking
   * @param {Buffer} message - Serialized protobuf command message
   * @param {String} requestId - Command request ID (extracted for tracking)
   * @param {Number} timeout - Timeout in ms (default 30000)
   * @returns {Promise} Resolves when command completes, rejects on failure/timeout
   */
  async sendCommand(message, requestId, timeout = 30000) {
    // Wait for connection if needed
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.homey.app.log('[WS] Waiting for connection to send command...');

      // Try to connect
      if (!this.isConnecting) {
        await this.connect(this.messageHandler);
      }

      // Wait up to 5 seconds for connection
      for (let i = 0; i < 50; i++) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not available for command');
    }

    // Create promise for command response
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error('Command timeout - no response from vehicle'));
      }, timeout);

      // Track pending command
      this.pendingCommands.set(requestId, {
        resolve,
        reject,
        timeout: timeoutHandle,
        sentAt: Date.now()
      });

      // Send command
      this._sendMessage(message).catch(error => {
        clearTimeout(timeoutHandle);
        this.pendingCommands.delete(requestId);
        reject(error);
      });

      this.homey.app.log(`[WS] Command ${requestId} sent, waiting for response...`);
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    this.homey.app.log('[WS] Disconnecting...');
    this.isStopping = true;

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
