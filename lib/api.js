'use strict';

const axios = require('axios');
const crypto = require('crypto');
const ProtoParser = require('./proto/parser');
const MercedesWebSocket = require('./websocket');

/**
 * Mercedes-Benz REST API Client
 * Handles all vehicle data retrieval and command execution
 */
class MercedesAPI {
  constructor(homey, oauth, region) {
    this.homey = homey;
    this.oauth = oauth;
    this.region = region;

    // Access endpoints property directly from oauth instance
    this.endpoints = oauth.endpoints;

    if (!this.endpoints) {
      throw new Error('OAuth endpoints not initialized');
    }

    this.sessionId = crypto.randomUUID().toUpperCase();

    // Create axios instance
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15'
      }
    });

    // Initialize protobuf parser
    this.protoParser = new ProtoParser(homey);
    this.protoParserInitialized = false;

    // WebSocket client (initialized later)
    this.websocket = null;

    this.homey.app.log('MercedesAPI initialized with endpoints:', this.endpoints);
  }

  /**
   * Initialize the API client (including protobuf parser)
   */
  async initialize() {
    if (this.protoParserInitialized) {
      return;
    }

    try {
      await this.protoParser.initialize();
      this.protoParserInitialized = true;
      this.homey.app.log('MercedesAPI protobuf parser initialized');
    } catch (error) {
      this.homey.app.error('Failed to initialize protobuf parser:', error.message);
      // Continue without protobuf support (will use fallback)
    }
  }

  /**
   * Get standard request headers
   */
  async _getHeaders() {
    const accessToken = await this.oauth.getAccessToken();

    return {
      'Authorization': `Bearer ${accessToken}`,
      'X-SessionId': this.sessionId,
      'X-TrackingId': crypto.randomUUID().toUpperCase(),
      'X-ApplicationName': 'mycar-store-ece',
      'ris-application-version': '1.61.0',
      'ris-os-name': 'ios',
      'ris-os-version': '12',
      'ris-sdk-version': '3.55.0',
      'X-Locale': 'en-GB',
      'Content-Type': 'application/json; charset=UTF-8',
      'Accept': 'application/json'
    };
  }

  /**
   * Make API request
   */
  async _request(method, endpoint, data = null) {
    const url = `${this.endpoints.rest}${endpoint}`;
    const headers = await this._getHeaders();

    try {
      const config = {
        method,
        url,
        headers
      };

      if (data) {
        config.data = data;
      }

      const response = await this.client.request(config);
      return response.data;

    } catch (error) {
      if (error.response) {
        const errorMsg = error.response.data?.errors || error.response.statusText;
        this.homey.app.error(`API request failed: ${method} ${endpoint} - ${error.response.status} - ${errorMsg}`);
        throw new Error(`API Error: ${errorMsg}`);
      } else {
        this.homey.app.error(`API request failed: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Get vehicle data
   * HA uses: webapi.py get_car_p2b_data_via_rest() - fetches protobuf from widget endpoint
   */
  async getVehicleData(vin) {
    this.homey.app.log(`Fetching vehicle data for VIN: ${vin}`);

    // Make sure protobuf parser is initialized
    await this.initialize();

    try {
      // HA implementation: https://widget.emea-prod.mobilesdk.mercedes-benz.com/v1/vehicle/{vin}/vehicleattributes
      // Returns protobuf data (VEPUpdate message)
      const headers = await this._getHeaders();
      const widgetUrl = this.endpoints.rest.replace('bff.emea-prod', 'widget.emea-prod');
      const url = `${widgetUrl}/v1/vehicle/${vin}/vehicleattributes`;

      this.homey.app.log(`[API] Fetching vehicle data from: ${url}`);

      const response = await this.client.get(url, {
        headers,
        responseType: 'arraybuffer' // Response is protobuf
      });

      this.homey.app.log(`[API] Response received - Status: ${response.status}, Data length: ${response.data?.byteLength || 0} bytes`);

      // Validate response
      if (!this.protoParserInitialized) {
        this.homey.app.error('[API] ERROR: Protobuf parser not initialized!');
        throw new Error('Protobuf parser not initialized');
      }

      if (!response.data || response.data.byteLength === 0) {
        this.homey.app.error('[API] ERROR: Empty response from vehicle data endpoint');
        throw new Error('Empty response from vehicle data endpoint');
      }

      // Convert ArrayBuffer to Buffer and parse
      const buffer = Buffer.from(response.data);
      this.homey.app.log(`[API] Buffer created: ${buffer.length} bytes`);
      this.homey.app.log(`[API] First 50 bytes (hex): ${buffer.slice(0, Math.min(50, buffer.length)).toString('hex')}`);

      this.homey.app.log('[API] Parsing protobuf VEPUpdate message...');
      const vepUpdate = this.protoParser.parseVEPUpdate(buffer);
      this.homey.app.log(`[API] VEPUpdate parsed - VIN: ${vepUpdate.vin}, Attributes count: ${Object.keys(vepUpdate.attributes || {}).length}`);
      this.homey.app.log(`[API] VEPUpdate full_update: ${vepUpdate.fullUpdate}, timestamp: ${vepUpdate.emitTimestampInMs}`);

      this.homey.app.log('[API] Extracting vehicle data from attributes...');
      const vehicleData = this.protoParser.extractVehicleData(vepUpdate);
      this.homey.app.log(`[API] Extracted ${Object.keys(vehicleData).length} vehicle data fields`);
      this.homey.app.log(`[API] Sample data keys: ${Object.keys(vehicleData).slice(0, 15).join(', ')}`);

      // Log specific important values
      if (vehicleData.soc !== undefined) {
        this.homey.app.log(`[API] Battery SOC: ${vehicleData.soc}`);
      }
      if (vehicleData.doorlockstatusvehicle !== undefined) {
        this.homey.app.log(`[API] Door lock status: ${vehicleData.doorlockstatusvehicle}`);
      }

      return vehicleData;

    } catch (error) {
      this.homey.app.error(`Failed to get vehicle data: ${error.message}`);
      throw error; // Re-throw error instead of returning mock data
    }
  }


  /**
   * Send command to vehicle
   */
  async _sendCommand(vin, commandType, commandData = {}) {
    const endpoint = `/v1/vehicle/${vin}/command/${commandType}`;

    this.homey.app.log(`Sending command ${commandType} to vehicle ${vin}`);

    try {
      const response = await this._request('POST', endpoint, commandData);

      // Wait for command to be processed
      await new Promise(resolve => setTimeout(resolve, 2000));

      return response;
    } catch (error) {
      this.homey.app.error(`Command ${commandType} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Lock vehicle doors
   */
  async lockVehicle(vin) {
    this.homey.app.log(`[API] Locking vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createLockCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Unlock vehicle doors (requires PIN)
   */
  async unlockVehicle(vin, pin) {
    if (!pin) {
      throw new Error('PIN is required to unlock the vehicle');
    }

    this.homey.app.log(`[API] Unlocking vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createUnlockCommand(vin, pin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Start engine (requires PIN)
   */
  async startEngine(vin, pin) {
    if (!pin) {
      throw new Error('PIN is required to start the engine');
    }

    this.homey.app.log(`[API] Starting engine for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStartEngineCommand(vin, pin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Stop engine
   */
  async stopEngine(vin) {
    this.homey.app.log(`[API] Stopping engine for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStopEngineCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Start climate control (preconditioning)
   */
  async startClimate(vin) {
    this.homey.app.log(`[API] Starting climate control for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStartClimateCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Stop climate control
   */
  async stopClimate(vin) {
    this.homey.app.log(`[API] Stopping climate control for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStopClimateCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Flash lights (signal position)
   */
  async flashLights(vin) {
    this.homey.app.log(`[API] Flashing lights for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createFlashLightsCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Start auxiliary heating
   */
  async startAuxHeat(vin) {
    return await this._sendCommand(vin, 'auxheat/start', {});
  }

  /**
   * Stop auxiliary heating
   */
  async stopAuxHeat(vin) {
    return await this._sendCommand(vin, 'auxheat/stop', {});
  }

  /**
   * Configure battery max state of charge
   */
  async configureBatteryMaxSoc(vin, maxSoc, chargeProgram = 0) {
    return await this._sendCommand(vin, 'charge/max-soc', {
      max_soc: maxSoc,
      charge_program: chargeProgram
    });
  }

  /**
   * Close windows
   */
  async closeWindows(vin) {
    this.homey.app.log(`[API] Closing windows for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createCloseWindowsCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Open windows (requires PIN)
   */
  async openWindows(vin, pin) {
    if (!pin) {
      throw new Error('PIN is required to open windows');
    }

    this.homey.app.log(`[API] Opening windows for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createOpenWindowsCommand(vin, pin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Open sunroof (requires PIN)
   */
  async openSunroof(vin, pin) {
    if (!pin) {
      throw new Error('PIN is required to open sunroof');
    }

    return await this._sendCommand(vin, 'sunroof/open', { pin });
  }

  /**
   * Close sunroof
   */
  async closeSunroof(vin) {
    return await this._sendCommand(vin, 'sunroof/close', {});
  }

  /**
   * Get geofencing violations
   */
  async getGeofencingViolations(vin) {
    this.homey.app.log(`[API] Getting geofencing violations for ${vin}`);
    try {
      const violations = await this._request('GET', `/v1/geofencing/vehicles/${vin}/fences/violations`);
      return violations || [];
    } catch (error) {
      // Don't log as error since this is often not enabled
      this.homey.app.log(`[API] Geofencing check failed (service might be inactive): ${error.message}`);
      return [];
    }
  }

  /**
   * Send route to vehicle navigation
   */
  async sendRoute(vin, title, latitude, longitude, city, postcode, street) {
    const data = {
      routeTitle: title,
      routeType: 'singlePOI',
      waypoints: [
        {
          city,
          latitude,
          longitude,
          postalCode: postcode,
          street,
          title
        }
      ]
    };

    return await this._request('POST', `/v1/vehicle/${vin}/route`, data);
  }

  /**
   * Get vehicle capabilities
   */
  async getVehicleCapabilities(vin) {
    return await this._request('GET', `/v1/vehicle/${vin}/capabilities`);
  }

  /**
   * Get vehicle command capabilities
   */
  async getVehicleCommandCapabilities(vin) {
    return await this._request('GET', `/v1/vehicle/${vin}/capabilities/commands`);
  }

  /**
   * Connect to WebSocket for real-time push updates
   * @param {Function} onDataReceived - Callback function for handling vehicle data updates
   */
  async connectWebSocket(onDataReceived) {
    // Make sure protobuf parser is initialized
    await this.initialize();

    if (this.websocket && this.websocket.isConnected()) {
      this.homey.app.log('[API] WebSocket already connected');
      return;
    }

    this.homey.app.log('[API] Initializing WebSocket connection...');

    // Create WebSocket client
    this.websocket = new MercedesWebSocket(
      this.homey,
      this.oauth,
      this.region,
      this.protoParser
    );

    // Connect with message handler
    await this.websocket.connect(async (message) => {
      try {
        // Process vepUpdates messages
        if (message.msg === 'vepUpdates' && message.vepUpdates && message.vepUpdates.updates) {
          this.homey.app.log('[API] Processing vepUpdates from WebSocket');

          // Extract VIN and vehicle data from updates
          const updates = message.vepUpdates.updates;

          for (const [vin, vepUpdate] of Object.entries(updates)) {
            this.homey.app.log(`[API] Processing update for VIN: ${vin}`);
            this.homey.app.log(`[API] Full update: ${vepUpdate.fullUpdate}, Attributes count: ${Object.keys(vepUpdate.attributes || {}).length}`);

            // Extract vehicle data from VEPUpdate
            const vehicleData = this.protoParser.extractVehicleData(vepUpdate);

            // Call the data received callback
            if (onDataReceived) {
              await onDataReceived(vin, vehicleData, vepUpdate.fullUpdate);
            }
          }
        }
      } catch (error) {
        this.homey.app.error('[API] Error processing WebSocket message:', error.message);
      }
    });

    this.homey.app.log('[API] WebSocket connection initiated');
  }

  /**
   * Disconnect WebSocket
   */
  async disconnectWebSocket() {
    if (this.websocket) {
      this.homey.app.log('[API] Disconnecting WebSocket...');
      this.websocket.disconnect();
      this.websocket = null;
      this.homey.app.log('[API] WebSocket disconnected');
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isWebSocketConnected() {
    return this.websocket && this.websocket.isConnected();
  }

  /**
   * Get WebSocket connection state
   */
  getWebSocketState() {
    return this.websocket ? this.websocket.getConnectionState() : 'not_initialized';
  }
}

module.exports = MercedesAPI;
