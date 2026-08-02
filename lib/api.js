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
        'User-Agent': 'Mercedes-Benz/3044 CFNetwork/3860.400.22 Darwin/25.3.0'
      }
    });

    // Initialize protobuf parser
    this.protoParser = new ProtoParser(homey);
    this.protoParserInitialized = false;

    // WebSocket client (initialized later)
    this.websocket = null;

    // Rate-limit window carried across WebSocket client re-creation, so a
    // fresh client can't start with a clean slate and reconnect straight
    // through an HTTP 429 backoff.
    this._wsRateLimitState = null;

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
      'ris-application-version': '1.65.1 (3174)',
      'ris-os-name': 'ios',
      'ris-os-version': '26.3',
      'ris-sdk-version': '4.4.2',
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
      const url = `${this.endpoints.widget}/v1/vehicle/${vin}/vehicleattributes`;

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
   * Start climate control via ZEV preconditioning (EV/PHEV).
   */
  async startClimate(vin) {
    this.homey.app.log(`[API] Starting climate control (ZEV precond) for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStartPrecondCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Stop climate control via ZEV preconditioning (EV/PHEV).
   */
  async stopClimate(vin) {
    this.homey.app.log(`[API] Stopping climate control (ZEV precond) for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStopPrecondCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Start auxiliary heater (ICE vehicles with fossil-fuel standheizung).
   */
  async startAuxheat(vin) {
    this.homey.app.log(`[API] Starting auxheat for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStartClimateCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Stop auxiliary heater.
   */
  async stopAuxheat(vin) {
    this.homey.app.log(`[API] Stopping auxheat for vehicle ${vin}`);
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
   * Sound horn
   * @param {string} vin - Vehicle VIN
   * @param {string} mode - 'horn_light', 'horn_only', or 'panic'
   */
  async soundHorn(vin, mode) {
    this.homey.app.log(`[API] Sounding horn for vehicle ${vin} with mode: ${mode}`);
    const { buffer, requestId } = this.protoParser.createSoundHornCommand(vin, mode);
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
   * Start charging
   */
  async startCharging(vin) {
    this.homey.app.log(`[API] Starting charging for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStartChargingCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Stop charging
   */
  async stopCharging(vin) {
    this.homey.app.log(`[API] Stopping charging for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStopChargingCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Configure battery max state of charge
   *
   * BatteryMaxSocConfigure (the message this used to send) is silently accepted by
   * Mercedes' backend but never applied — see mbapi2020's client.py, which always
   * routes max-SOC changes through ChargingConfigure or ChargeProgramConfigure instead.
   * @param {String} vin - Vehicle VIN
   * @param {Number} maxSoc - Maximum state of charge percentage
   * @param {Number} chargeProgram - Active charge program (0=Default, 2=Home, 3=Work),
   *   only used on the ChargeProgramConfigure fallback path
   */
  async configureBatteryMaxSoc(vin, maxSoc, chargeProgram = 0) {
    this.homey.app.log(`[API] Configuring max SOC for vehicle ${vin}: ${maxSoc}%`);
    const features = await this.getVehicleFeatures(vin);

    let buffer, requestId;
    if (features.CHARGING_CONFIGURE) {
      this.homey.app.log('[API] Using ChargingConfigure (vehicle supports CHARGING_CONFIGURE)');
      ({ buffer, requestId } = this.protoParser.createChargingConfigureMaxSocCommand(vin, maxSoc));
    } else if (features.CHARGE_PROGRAM_CONFIGURE) {
      const clampedMaxSoc = Math.max(maxSoc, 50);
      this.homey.app.log(`[API] Using ChargeProgramConfigure (vehicle supports CHARGE_PROGRAM_CONFIGURE), program ${chargeProgram}, maxSoc clamped to ${clampedMaxSoc}%`);
      ({ buffer, requestId } = this.protoParser.createChargeProgramMaxSocCommand(vin, clampedMaxSoc, chargeProgram));
    } else {
      throw new Error('This vehicle does not support configuring max SOC (missing CHARGING_CONFIGURE / CHARGE_PROGRAM_CONFIGURE capability)');
    }

    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Start ZEV preconditioning (electric climate control)
   */
  async startPrecond(vin) {
    this.homey.app.log(`[API] Starting preconditioning for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStartPrecondCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Stop ZEV preconditioning
   */
  async stopPrecond(vin) {
    this.homey.app.log(`[API] Stopping preconditioning for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createStopPrecondCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Configure preconditioning departure time
   * @param {string} vin - Vehicle VIN
   * @param {number} departureTime - Minutes from midnight (0-1439)
   * @param {number} mode - 0=disabled, 1=single, 2=weekly
   */
  async configurePrecondDeparture(vin, departureTime, mode) {
    this.homey.app.log(`[API] Configuring precond departure for vehicle ${vin}: ${departureTime} min, mode=${mode}`);
    const { buffer, requestId } = this.protoParser.createConfigurePrecondDepartureCommand(vin, departureTime, mode);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Configure temperature zones
   * @param {string} vin - Vehicle VIN
   * @param {Array} zones - Array of {zone, temperature} objects
   */
  async configureTemperature(vin, zones) {
    this.homey.app.log(`[API] Configuring temperature for vehicle ${vin}:`, zones);
    const { buffer, requestId } = this.protoParser.createConfigureTemperatureCommand(vin, zones);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Configure seat heating for preconditioning
   * @param {string} vin - Vehicle VIN
   * @param {boolean} frontLeft - Front left seat heating enabled
   * @param {boolean} frontRight - Front right seat heating enabled
   * @param {boolean} rearLeft - Rear left seat heating enabled
   * @param {boolean} rearRight - Rear right seat heating enabled
   */
  async configureSeatHeating(vin, frontLeft, frontRight, rearLeft, rearRight) {
    this.homey.app.log(`[API] Configuring seat heating for vehicle ${vin}: FL=${frontLeft}, FR=${frontRight}, RL=${rearLeft}, RR=${rearRight}`);
    const { buffer, requestId } = this.protoParser.createConfigureSeatHeatingCommand(vin, frontLeft, frontRight, rearLeft, rearRight);
    return await this.websocket.sendCommand(buffer, requestId);
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

    this.homey.app.log(`[API] Opening sunroof for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createOpenSunroofCommand(vin, pin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Close sunroof
   */
  async closeSunroof(vin) {
    this.homey.app.log(`[API] Closing sunroof for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createCloseSunroofCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Tilt sunroof
   */
  async tiltSunroof(vin) {
    this.homey.app.log(`[API] Tilting sunroof for vehicle ${vin}`);
    const { buffer, requestId } = this.protoParser.createTiltSunroofCommand(vin);
    return await this.websocket.sendCommand(buffer, requestId);
  }

  /**
   * Get geofencing violations
   */
  async getGeofencingViolations(vin) {
    this.homey.app.log(`[API] Getting geofencing violations for ${vin}`);
    const endpoint = `/v1/geofencing/vehicles/${vin}/fences/violations`;
    const url = `${this.endpoints.rest}${endpoint}`;
    const headers = await this._getHeaders();

    try {
      const response = await this.client.request({ method: 'GET', url, headers });
      const violations = response.data;
      this.homey.app.log(`[API] Geofencing response: HTTP ${response.status}, body type: ${typeof violations}, isArray: ${Array.isArray(violations)}, length: ${Array.isArray(violations) ? violations.length : 'N/A'}`);
      if (Array.isArray(violations) && violations.length > 0) {
        this.homey.app.log(`[API] Geofencing first violation keys: ${Object.keys(violations[0]).join(', ')}`);
        this.homey.app.log(`[API] Geofencing last violation: ${JSON.stringify(violations[violations.length - 1]).substring(0, 500)}`);
      } else if (violations && !Array.isArray(violations)) {
        this.homey.app.log(`[API] Geofencing non-array response: ${JSON.stringify(violations).substring(0, 500)}`);
      }
      return violations || [];
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        const body = JSON.stringify(error.response.data || '').substring(0, 500);
        this.homey.app.log(`[API] Geofencing FAILED: HTTP ${status}, body: ${body}`);
        if (status === 401 || status === 403) {
          this.homey.app.log(`[API] Geofencing: AUTH error — token may lack geofencing scope`);
        } else if (status === 404) {
          this.homey.app.log(`[API] Geofencing: NOT FOUND — endpoint may not exist for this vehicle/region`);
        } else if (status === 418) {
          this.homey.app.log(`[API] Geofencing: BLOCKED (418) — SDK/app version headers rejected`);
        }
      } else {
        this.homey.app.log(`[API] Geofencing FAILED (no response): ${error.message}`);
      }
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
   * Get a merged feature flag map for a vehicle (commandName -> isAvailable), combining
   * /capabilities and /capabilities/commands. Mirrors mbapi2020's approach, since both
   * endpoints can 401 for some cars and are best-effort.
   */
  async getVehicleFeatures(vin) {
    const features = {};

    try {
      const capabilities = await this.getVehicleCapabilities(vin);
      if (capabilities && capabilities.features) {
        Object.assign(features, capabilities.features);
      }
    } catch (error) {
      this.homey.app.log(`[API] Vehicle capabilities not available for ${vin}: ${error.message}`);
    }

    try {
      const commandCapabilities = await this.getVehicleCommandCapabilities(vin);
      if (commandCapabilities && Array.isArray(commandCapabilities.commands)) {
        for (const command of commandCapabilities.commands) {
          features[command.commandName] = Boolean(command.isAvailable);

          // CHARGE_PROGRAM_CONFIGURE is only useful to us if it exposes a MAX_SOC parameter
          if (command.commandName === 'CHARGE_PROGRAM_CONFIGURE') {
            const parameters = command.parameters || [];
            features.CHARGE_PROGRAM_CONFIGURE = parameters.some((p) => p.parameterName === 'MAX_SOC');
          }
        }
      }
    } catch (error) {
      this.homey.app.log(`[API] Vehicle command capabilities not available for ${vin}: ${error.message}`);
    }

    return features;
  }

  /**
   * Connect to WebSocket for real-time push updates
   * @param {Function} onDataReceived - Callback function for handling vehicle data updates
   */
  async connectWebSocket(onDataReceived) {
    // Make sure protobuf parser is initialized
    await this.initialize();

    // "Healthy", not merely "open": a half-open socket keeps reporting OPEN
    // forever while receiving nothing, and returning early here would leave
    // that zombie in place so push updates never resume.
    if (this.websocket && this.websocket.isHealthy()) {
      this.homey.app.log('[API] WebSocket already connected');
      return;
    }

    // Never handshake through an HTTP 429 backoff. Re-creating the client
    // resets its rate-limit state, so without this check the 5-minute device
    // health check would punch straight through a 10-minute block every time
    // and keep the account rate-limited indefinitely. The existing client (if
    // any) already has a reconnect scheduled for when the window expires.
    const rateLimit = this.websocket ? this.websocket.getRateLimitState() : this._wsRateLimitState;
    if (rateLimit && rateLimit.blockedUntil > Date.now()) {
      const seconds = Math.ceil((rateLimit.blockedUntil - Date.now()) / 1000);
      this._wsRateLimitState = rateLimit;
      this.homey.app.log(`[API] Rate-limited by Mercedes (HTTP 429) - not reconnecting for another ${seconds}s`);
      return;
    }

    this.homey.app.log('[API] Initializing WebSocket connection...');

    // Dispose of any previous (stale/disconnected) client before replacing it.
    // Without this the old instance is orphaned while its reconnect timer is
    // still pending, which would race a second live socket against this one.
    if (this.websocket) {
      this.homey.app.log('[API] Disposing previous WebSocket client before reconnecting');
      // Carry the rate-limit window over to the replacement.
      this._wsRateLimitState = this.websocket.getRateLimitState();
      try {
        this.websocket.disconnect();
      } catch (error) {
        this.homey.app.error('[API] Error disposing previous WebSocket client:', error.message);
      }
      this.websocket = null;
    }

    // Create WebSocket client
    this.websocket = new MercedesWebSocket(
      this.homey,
      this.oauth,
      this.region,
      this.protoParser
    );

    if (this._wsRateLimitState) {
      this.websocket.restoreRateLimitState(this._wsRateLimitState);
      this._wsRateLimitState = null;
    }

    // Connect with message handler
    // WebSocket internally extracts vehicle data and calls handler with (vin, vehicleData, fullUpdate)
    await this.websocket.connect(onDataReceived);

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
   * Check if the WebSocket is not just open but actually receiving data.
   * Use this to decide whether to reconnect - see MercedesWebSocket.isHealthy().
   */
  isWebSocketHealthy() {
    return Boolean(this.websocket && this.websocket.isHealthy());
  }

  /**
   * Milliseconds since the WebSocket last produced any traffic, or null.
   */
  getWebSocketIdleTime() {
    return this.websocket ? this.websocket.getIdleTime() : null;
  }

  /**
   * Get WebSocket connection state
   */
  getWebSocketState() {
    return this.websocket ? this.websocket.getConnectionState() : 'not_initialized';
  }
}

module.exports = MercedesAPI;
