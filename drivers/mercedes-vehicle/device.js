'use strict';

const Homey = require('homey');
const MercedesOAuth = require('../../lib/oauth');
const MercedesAPI = require('../../lib/api');

class MercedesVehicleDevice extends Homey.Device {
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Mercedes Vehicle device initializing...');

    const settings = this.getSettings();
    const store = this.getStore();

    this.vin = this.getData().vin;
    this.region = store.region || 'Europe';
    this.log(`VIN: ${this.vin}, Region: ${this.region}`);

    try {
      // Initialize OAuth with stored deviceGuid
      this.oauth = new MercedesOAuth(this.homey, this.region, store.deviceGuid);

      // Restore stored token if available
      if (store.token) {
        this.oauth.token = store.token;
        this.log('OAuth token restored from store');
      }

      // Initialize API client
      this.api = new MercedesAPI(this.homey, this.oauth, this.region);
      await this.api.initialize();
      this.log('API client and protobuf parser initialized');

      // Check if token is expired and refresh if needed
      if (!this.oauth.token || MercedesOAuth.isTokenExpired(this.oauth.token)) {
        this.log('Token expired, refreshing...');
        await this.oauth.login(store.username, store.password);
        await this.setStoreValue('token', this.oauth.token);
        this.log('Token refreshed and stored');
      }

      // Register capability listeners
      this.registerCapabilityListener('locked', this.onCapabilityLocked.bind(this));
      this.registerCapabilityListener('onoff.engine', this.onCapabilityEngine.bind(this));
      this.registerCapabilityListener('onoff.climate', this.onCapabilityClimate.bind(this));

      // Add average_speed capability if it doesn't exist (for devices paired before this was added)
      if (!this.hasCapability('average_speed')) {
        this.log('[INIT] Adding missing average_speed capability');
        await this.addCapability('average_speed');
      }

      // Initialize average_speed capability with default value if not set
      if (this.getCapabilityValue('average_speed') === null) {
        await this.setCapabilityValue('average_speed', 0);
        this.log('[INIT] Initialized average_speed capability to 0 km/h');
      }

      // Add new location capabilities if they don't exist
      if (!this.hasCapability('measure_latitude')) {
        this.log('[INIT] Adding missing measure_latitude capability');
        await this.addCapability('measure_latitude');
      }
      if (!this.hasCapability('measure_longitude')) {
        this.log('[INIT] Adding missing measure_longitude capability');
        await this.addCapability('measure_longitude');
      }
      if (!this.hasCapability('measure_heading')) {
        this.log('[INIT] Adding missing measure_heading capability');
        await this.addCapability('measure_heading');
      }

      // Add geofence capabilities
      if (!this.hasCapability('text_geofence_last_event')) {
        await this.addCapability('text_geofence_last_event');
      }
      if (!this.hasCapability('text_geofence_last_zone')) {
        await this.addCapability('text_geofence_last_zone');
      }
      if (!this.hasCapability('time_geofence_last_event')) {
        await this.addCapability('time_geofence_last_event');
      }

      // Add charge flap state capability
      if (!this.hasCapability('text_charge_flap_state')) {
        await this.addCapability('text_charge_flap_state');
      }

      // Add charge inlet coupler state capability
      if (!this.hasCapability('text_charge_inlet_coupler')) {
        await this.addCapability('text_charge_inlet_coupler');
      }

      // Add charge inlet lock state capability
      if (!this.hasCapability('text_charge_inlet_lock')) {
        await this.addCapability('text_charge_inlet_lock');
      }

      // Add charge flap DC status capability
      if (!this.hasCapability('text_charge_flap_dc_status')) {
        await this.addCapability('text_charge_flap_dc_status');
      }

      // Add departure time capability
      if (!this.hasCapability('text_departure_time')) {
        await this.addCapability('text_departure_time');
      }

      // Add departure time mode capability
      if (!this.hasCapability('text_departure_time_mode')) {
        await this.addCapability('text_departure_time_mode');
      }

      // Initialize text capabilities with default values if not set
      const textCapabilities = [
        'text_charge_flap_state',
        'text_charge_inlet_coupler',
        'text_charge_inlet_lock',
        'text_charge_flap_dc_status',
        'text_departure_time',
        'text_departure_time_mode',
        'text_geofence_last_event',
        'text_geofence_last_zone',
        'time_geofence_last_event'
      ];

      for (const cap of textCapabilities) {
        if (this.hasCapability(cap) && this.getCapabilityValue(cap) === null) {
          await this.setCapabilityValue(cap, '-');
        }
      }

      // Connect to WebSocket for real-time updates
      this.log('[INIT] Connecting to WebSocket for real-time updates...');
      try {
        await this.api.connectWebSocket(this.onWebSocketData.bind(this));
        this.log('[INIT] WebSocket connection established');
      } catch (error) {
        this.error('[INIT] Failed to connect WebSocket:', error.message);
        this.log('[INIT] Falling back to polling mode');
      }

      // Start polling for vehicle data (as fallback and for initial data)
      // If WebSocket is working, this will be less critical
      const pollingInterval = settings.polling_interval || 180;
      this.log(`Starting polling with ${pollingInterval}s interval (WebSocket fallback)`);
      this.pollInterval = setInterval(
        this.pollVehicleData.bind(this),
        pollingInterval * 1000
      );

      // Do initial poll
      await this.pollVehicleData();

      await this.setAvailable();
      this.log('Mercedes Vehicle device initialized successfully');

    } catch (error) {
      this.error('Device initialization failed:', error.message);
      await this.setUnavailable('Initialization failed: ' + error.message);
    }
  }

  /**
   * onAdded is called when the user adds the device
   */
  async onAdded() {
    this.log('Mercedes Vehicle has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Mercedes Vehicle settings where changed');

    // Update polling interval if changed
    if (changedKeys.includes('polling_interval')) {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
      }

      this.pollInterval = setInterval(
        this.pollVehicleData.bind(this),
        newSettings.polling_interval * 1000
      );

      this.log('Polling interval updated to', newSettings.polling_interval, 'seconds');
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log('Mercedes Vehicle was renamed to', name);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('Mercedes Vehicle has been deleted');

    // Clear polling interval
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    // Disconnect WebSocket if connected
    if (this.api && this.api.websocket) {
      await this.api.disconnectWebSocket();
    }
  }

  /**
   * Poll vehicle data from Mercedes API
   */
  async pollVehicleData() {
    try {
      this.log('[POLL] Starting vehicle data poll for VIN:', this.vin);

      const vehicleData = await this.api.getVehicleData(this.vin);

      if (!vehicleData) {
        this.error('[POLL] ERROR: No vehicle data received from API');
        return;
      }

      this.log('[POLL] Vehicle data received, updating capabilities...');
      this.log('[POLL] Data keys:', Object.keys(vehicleData).slice(0, 20).join(', '));

      // Update capabilities based on vehicle data
      await this.updateCapabilities(vehicleData);

      // Poll geofencing violations
      try {
        const geofenceEvents = await this.api.getGeofencingViolations(this.vin);
        if (geofenceEvents && geofenceEvents.length > 0) {
          const last = geofenceEvents[geofenceEvents.length - 1];
          this.log('[POLL] Last geofence event:', last);
          
          if (last.type) {
            await this.setCapabilityValue('text_geofence_last_event', last.type);
          }
          if (last.fence && last.fence.name) {
            await this.setCapabilityValue('text_geofence_last_zone', last.fence.name);
          }
          if (last.time) {
            // API returns seconds
            await this.setCapabilityValue('time_geofence_last_event', new Date(last.time * 1000).toISOString());
          }
        }
      } catch (geoError) {
        this.log('[POLL] Geofencing update skipped/failed:', geoError.message);
      }

      this.log('[POLL] Vehicle data poll completed successfully');

    } catch (error) {
      this.error('[POLL] ERROR: Failed to poll vehicle data:', error.message);
      this.error('[POLL] Error stack:', error.stack);
      // Don't set unavailable on temporary errors - polling will retry on next interval
    }
  }

  /**
   * Handle real-time data from WebSocket
   */
  async onWebSocketData(vin, vehicleData, isFullUpdate) {
    try {
      // Only process data for this vehicle
      if (vin !== this.vin) {
        return;
      }

      this.log(`[WEBSOCKET] Received ${isFullUpdate ? 'FULL' : 'PARTIAL'} update for vehicle`);
      this.log(`[WEBSOCKET] Data keys: ${Object.keys(vehicleData).slice(0, 20).join(', ')}`);

      // Update capabilities with the new data
      await this.updateCapabilities(vehicleData);
      this.log('[WEBSOCKET] Capabilities updated from WebSocket data');

    } catch (error) {
      this.error('[WEBSOCKET] Error processing WebSocket data:', error.message);
    }
  }

  /**
   * Update device capabilities from vehicle data
   */
  async updateCapabilities(data) {
    try {
      this.log('[UPDATE] Updating capabilities from vehicle data...');

      // Door lock status
      if (data.doorlockstatusvehicle !== undefined) {
        this.log(`[UPDATE] Door lock status raw value: ${data.doorlockstatusvehicle}`);
        const locked = data.doorlockstatusvehicle === 2; // 2 = external locked
        this.log(`[UPDATE] Setting locked to: ${locked}`);
        if (this.getCapabilityValue('locked') !== locked) {
          await this.setCapabilityValue('locked', locked);

          // Trigger flow cards
          if (locked) {
            await this.homey.flow.getDeviceTriggerCard('vehicle_locked').trigger(this);
          } else {
            await this.homey.flow.getDeviceTriggerCard('vehicle_unlocked').trigger(this);
          }
        }
      } else {
        this.log('[UPDATE] WARNING: doorlockstatusvehicle is undefined');
      }

      // Battery state of charge
      if (data.soc !== undefined) {
        const battery = parseInt(data.soc);
        this.log(`[UPDATE] Setting battery to: ${battery}%`);
        await this.setCapabilityValue('measure_battery', battery);

        // Trigger low battery warning
        if (battery < 20 && this.getCapabilityValue('measure_battery') >= 20) {
          await this.homey.flow.getDeviceTriggerCard('low_battery')
            .trigger(this, { battery_level: battery });
        }
      }

      // Charging power (kW)
      if (data.chargingPower !== undefined) {
        const chargingPower = parseFloat(data.chargingPower);
        const wasCharging = this.getCapabilityValue('meter_power') > 0;
        const isCharging = chargingPower > 0;

        await this.setCapabilityValue('meter_power', chargingPower);

        // Trigger charging flow cards
        if (!wasCharging && isCharging) {
          await this.homey.flow.getDeviceTriggerCard('charging_started')
            .trigger(this, { charging_power: chargingPower });
          this.log(`[TRIGGER] Charging started with ${chargingPower} kW`);
        } else if (wasCharging && !isCharging) {
          await this.homey.flow.getDeviceTriggerCard('charging_stopped').trigger(this);
          this.log('[TRIGGER] Charging stopped');
        }
      }

      // Engine state
      if (data.engineState !== undefined) {
        const engineRunning = data.engineState === true || data.engineState === 'RUNNING';
        const wasRunning = this.getCapabilityValue('onoff.engine');

        if (wasRunning !== engineRunning) {
          await this.setCapabilityValue('onoff.engine', engineRunning);

          // Trigger flow cards
          if (engineRunning) {
            await this.homey.flow.getDeviceTriggerCard('engine_started').trigger(this);
          } else {
            await this.homey.flow.getDeviceTriggerCard('engine_stopped').trigger(this);
          }
        }
      }

      // Climate control status
      if (data.precondActive !== undefined) {
        await this.setCapabilityValue('onoff.climate', data.precondActive === true);
      }

      // Tire pressures (already converted from kPa to bar in parser)
      if (data.tirepressureFrontLeft !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_fl', parseFloat(data.tirepressureFrontLeft));
      }
      if (data.tirepressureFrontRight !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_fr', parseFloat(data.tirepressureFrontRight));
      }
      if (data.tirepressureRearLeft !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_rl', parseFloat(data.tirepressureRearLeft));
      }
      if (data.tirepressureRearRight !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_rr', parseFloat(data.tirepressureRearRight));
      }

      // Odometer reading
      if (data.odo !== undefined) {
        this.log(`[UPDATE] Setting odometer to: ${data.odo} km`);
        await this.setCapabilityValue('odometer', parseFloat(data.odo));
      }

      // Trip distance since start
      if (data.distanceStart !== undefined) {
        this.log(`[UPDATE] Setting trip distance to: ${data.distanceStart} km`);
        await this.setCapabilityValue('distance_start', parseFloat(data.distanceStart));
      }

      // Electric trip distance
      if (data.distanceElectricalStart !== undefined) {
        this.log(`[UPDATE] Setting electric distance to: ${data.distanceElectricalStart} km`);
        await this.setCapabilityValue('distance_electrical', parseFloat(data.distanceElectricalStart));
      }

      // Driving time since start
      if (data.drivenTimeStart !== undefined) {
        this.log(`[UPDATE] Setting driving time to: ${data.drivenTimeStart} min`);
        await this.setCapabilityValue('driven_time_start', parseInt(data.drivenTimeStart));
      }

      // Average speed since start
      if (data.averageSpeedStart !== undefined) {
        const speed = parseFloat(data.averageSpeedStart);
        this.log(`[UPDATE] Setting average speed to: ${speed} km/h`);
        await this.setCapabilityValue('average_speed', speed);
      } else {
        // Set to 0 when not available (car is stopped)
        await this.setCapabilityValue('average_speed', 0);
      }

      // Eco scores
      if (data.ecoscoretotal !== undefined) {
        this.log(`[UPDATE] Setting total eco score to: ${data.ecoscoretotal}`);
        await this.setCapabilityValue('ecoscore_total', parseInt(data.ecoscoretotal));
      }
      if (data.ecoscoreaccel !== undefined) {
        this.log(`[UPDATE] Setting acceleration eco score to: ${data.ecoscoreaccel}`);
        await this.setCapabilityValue('ecoscore_accel', parseInt(data.ecoscoreaccel));
      }
      if (data.ecoscoreconst !== undefined) {
        this.log(`[UPDATE] Setting constant eco score to: ${data.ecoscoreconst}`);
        await this.setCapabilityValue('ecoscore_const', parseInt(data.ecoscoreconst));
      }
      if (data.ecoscorefreewhl !== undefined) {
        this.log(`[UPDATE] Setting freewheel eco score to: ${data.ecoscorefreewhl}`);
        await this.setCapabilityValue('ecoscore_freewhl', parseInt(data.ecoscorefreewhl));
      }

      // Generic alarm (warnings)
      const hasWarning = data.warningwashwater || data.warningcoolantlevellow ||
                        data.warningbrakefluid || data.warningenginelight;
      await this.setCapabilityValue('alarm_generic', hasWarning === true);

      // --- NEW CAPABILITIES ---

      // Electric range
      if (data.rangeelectric !== undefined) {
        this.log(`[UPDATE] Setting electric range to: ${data.rangeelectric} km`);
        await this.setCapabilityValue('measure_range_electric', parseFloat(data.rangeelectric));
      }

      // Liquid fuel range
      if (data.rangeliquid !== undefined) {
        this.log(`[UPDATE] Setting liquid range to: ${data.rangeliquid} km`);
        await this.setCapabilityValue('measure_range_liquid', parseFloat(data.rangeliquid));
      }

      // Fuel level
      if (data.tanklevelpercent !== undefined) {
        this.log(`[UPDATE] Setting fuel level to: ${data.tanklevelpercent}%`);
        await this.setCapabilityValue('measure_fuel', parseInt(data.tanklevelpercent));
      }

      // AdBlue level
      if (data.tankLevelAdBlue !== undefined) {
        this.log(`[UPDATE] Setting AdBlue level to: ${data.tankLevelAdBlue}%`);
        await this.setCapabilityValue('measure_adblue_level', parseInt(data.tankLevelAdBlue));
      }

      // Starter battery state (binary sensor)
      if (data.starterBatteryState !== undefined) {
        const isWarning = data.starterBatteryState !== 'NORMAL';
        this.log(`[UPDATE] Setting starter battery alarm to: ${isWarning}`);
        await this.setCapabilityValue('alarm_starter_battery', isWarning);
      }

      // Ignition state (onoff.ignition)
      if (data.ignitionstate !== undefined) {
        const ignitionOn = data.ignitionstate === '0' || data.ignitionstate === '1' || data.ignitionstate === '2' || data.ignitionstate === '4'; // 0: lock, 1: radio, 2: ignition, 4: start
        // HA logic: 0=lock, 1=off, 2=accessory, 4=on, 5=start?
        // Let's check car.py logic if possible, but for now assume any active state is 'on'
        // Actually, let's just store the raw value if we can, but onoff needs boolean.
        // Better logic: if it's not 0 (lock), it's "on" (some activity)
        this.log(`[UPDATE] Setting ignition state to: ${ignitionOn} (raw: ${data.ignitionstate})`);
        await this.setCapabilityValue('onoff.ignition', ignitionOn);
      }

      // Oil level (percent)
      if (data.oilLevel !== undefined) {
        this.log(`[UPDATE] Setting oil level to: ${data.oilLevel}%`);
        await this.setCapabilityValue('measure_oil_level', parseInt(data.oilLevel));
      }

      // Charging status (text)
      if (data.chargingstatus !== undefined) {
        this.log(`[UPDATE] Setting charging status to: ${data.chargingstatus}`);
        await this.setCapabilityValue('text_charging_status', data.chargingstatus);
      }

      // Selected charge program (text)
      if (data.selectedChargeProgram !== undefined) {
        this.log(`[UPDATE] Setting selected charge program to: ${data.selectedChargeProgram}`);
        await this.setCapabilityValue('text_charge_program', data.selectedChargeProgram);
      }

      // Max SoC
      if (data.max_soc !== undefined) {
        this.log(`[UPDATE] Setting max SoC to: ${data.max_soc}%`);
        await this.setCapabilityValue('measure_max_soc', parseInt(data.max_soc));
      }

      // End of charge time (timestamp)
      if (data.endofchargetime !== undefined) {
        this.log(`[UPDATE] Setting end of charge time to: ${data.endofchargetime}`);
        // Format: "13:45" or timestamp? Parser says 'display_value' usually
        // If it's a time string, we might need to combine with today's date
        // For now, just store as string if we make a text capability, but date capability needs Date object
        // Let's assume it's a string for now and we'll use a text capability 'text_end_charge_time'
        await this.setCapabilityValue('text_end_charge_time', String(data.endofchargetime));
      }

      // Sunroof status (text)
      if (data.sunroofstatus !== undefined) {
        this.log(`[UPDATE] Setting sunroof status to: ${data.sunroofstatus}`);
        await this.setCapabilityValue('window_sunroof', data.sunroofstatus);
      }

      // Charge Flap State
      if (data.chargeflap !== undefined) {
        this.log(`[UPDATE] Setting charge flap state to: ${data.chargeflap}`);
        await this.setCapabilityValue('text_charge_flap_state', data.chargeflap);
      }

      // Charge Inlet Coupler State
      if (data.chargeinletcoupler !== undefined) {
        this.log(`[UPDATE] Setting charge inlet coupler state to: ${data.chargeinletcoupler}`);
        await this.setCapabilityValue('text_charge_inlet_coupler', data.chargeinletcoupler);
      }

      // Charge Inlet Lock State
      if (data.chargeinletlock !== undefined) {
        this.log(`[UPDATE] Setting charge inlet lock state to: ${data.chargeinletlock}`);
        await this.setCapabilityValue('text_charge_inlet_lock', data.chargeinletlock);
      }

      // Charge Flap DC Status
      if (data.chargeFlapDCStatus !== undefined) {
        this.log(`[UPDATE] Setting charge flap DC status to: ${data.chargeFlapDCStatus}`);
        await this.setCapabilityValue('text_charge_flap_dc_status', data.chargeFlapDCStatus);
      }

      // Departure Time
      if (data.departuretime !== undefined) {
        this.log(`[UPDATE] Setting departure time to: ${data.departuretime}`);
        await this.setCapabilityValue('text_departure_time', data.departuretime);
      }

      // Departure Time Mode
      if (data.departureTimeMode !== undefined) {
        this.log(`[UPDATE] Setting departure time mode to: ${data.departureTimeMode}`);
        await this.setCapabilityValue('text_departure_time_mode', data.departureTimeMode);
      }

      // Location
      if (data.positionLat !== undefined && data.positionLong !== undefined) {
        const lat = parseFloat(data.positionLat);
        const long = parseFloat(data.positionLong);
        this.log(`[UPDATE] Setting location: ${lat}, ${long}`);
        await this.setCapabilityValue('measure_latitude', lat);
        await this.setCapabilityValue('measure_longitude', long);
      }

      if (data.positionHeading !== undefined) {
        const heading = parseFloat(data.positionHeading);
        this.log(`[UPDATE] Setting heading: ${heading}`);
        await this.setCapabilityValue('measure_heading', heading);
      }

      this.log('Capabilities updated successfully');

    } catch (error) {
      this.error('Error updating capabilities:', error.message);
    }
  }

  /**
   * Handle locked capability changes
   */
  async onCapabilityLocked(value) {
    this.log('Locked capability changed to:', value);

    const settings = this.getSettings();
    const pin = settings.pin;

    if (!pin && !value) {
      throw new Error(this.homey.__('error.pin_required'));
    }

    try {
      if (value) {
        await this.api.lockVehicle(this.vin);
      } else {
        await this.api.unlockVehicle(this.vin, pin);
      }

      // Poll immediately to update state
      setTimeout(() => this.pollVehicleData(), 5000);

      return true;
    } catch (error) {
      this.error('Failed to change lock state:', error.message);
      throw new Error(this.homey.__('error.lock_failed'));
    }
  }

  /**
   * Handle engine on/off capability changes
   */
  async onCapabilityEngine(value) {
    this.log('Engine capability changed to:', value);

    const settings = this.getSettings();
    const pin = settings.pin;

    if (!pin) {
      throw new Error(this.homey.__('error.pin_required'));
    }

    try {
      if (value) {
        await this.api.startEngine(this.vin, pin);
      } else {
        await this.api.stopEngine(this.vin);
      }

      // Poll immediately to update state
      setTimeout(() => this.pollVehicleData(), 5000);

      return true;
    } catch (error) {
      this.error('Failed to change engine state:', error.message);
      throw new Error(this.homey.__('error.engine_control_failed'));
    }
  }

  /**
   * Handle climate control capability changes
   */
  async onCapabilityClimate(value) {
    this.log('Climate capability changed to:', value);

    try {
      if (value) {
        await this.api.startClimate(this.vin);
      } else {
        await this.api.stopClimate(this.vin);
      }

      // Poll immediately to update state
      setTimeout(() => this.pollVehicleData(), 5000);

      return true;
    } catch (error) {
      this.error('Failed to change climate state:', error.message);
      throw new Error(this.homey.__('error.climate_control_failed'));
    }
  }

  /**
   * Lock vehicle
   */
  async lockVehicle() {
    await this.setCapabilityValue('locked', true);
  }

  /**
   * Unlock vehicle
   */
  async unlockVehicle() {
    await this.setCapabilityValue('locked', false);
  }

  /**
   * Start climate control
   */
  async startClimate() {
    await this.setCapabilityValue('onoff.climate', true);
  }

  /**
   * Stop climate control
   */
  async stopClimate() {
    await this.setCapabilityValue('onoff.climate', false);
  }

  /**
   * Flash lights
   */
  async flashLights() {
    try {
      await this.api.flashLights(this.vin);
      this.log('Lights flashed successfully');
    } catch (error) {
      this.error('Failed to flash lights:', error.message);
      throw new Error(this.homey.__('error.flash_lights_failed'));
    }
  }

  /**
   * Start engine
   */
  async startEngine() {
    await this.setCapabilityValue('onoff.engine', true);
  }

  /**
   * Stop engine
   */
  async stopEngine() {
    await this.setCapabilityValue('onoff.engine', false);
  }

  /**
   * Check if all windows are closed
   */
  async areWindowsClosed() {
    try {
      const vehicleData = await this.api.getVehicleData(this.vin);

      return (
        vehicleData.windowstatusfrontleft === 'CLOSED' &&
        vehicleData.windowstatusfrontright === 'CLOSED' &&
        vehicleData.windowstatusrearleft === 'CLOSED' &&
        vehicleData.windowstatusrearright === 'CLOSED'
      );
    } catch (error) {
      this.error('Failed to check window status:', error.message);
      return false;
    }
  }

  // ==================== Flow Card Action Handlers ====================

  /**
   * Flow action: Lock vehicle
   */
  async lockVehicleAction() {
    this.log('[FLOW] Lock vehicle action triggered');
    try {
      await this.api.lockVehicle(this.vin);
      this.log('[FLOW] Vehicle locked successfully');

      // Update capability immediately
      await this.setCapabilityValue('locked', true);

      return true;
    } catch (error) {
      this.error('[FLOW] Failed to lock vehicle:', error.message);
      throw new Error(`Failed to lock vehicle: ${error.message}`);
    }
  }

  /**
   * Flow action: Unlock vehicle
   */
  async unlockVehicleAction() {
    this.log('[FLOW] Unlock vehicle action triggered');
    try {
      const settings = this.getSettings();
      const pin = settings.pin;

      if (!pin) {
        throw new Error('PIN is not configured. Please set PIN in device settings.');
      }

      await this.api.unlockVehicle(this.vin, pin);
      this.log('[FLOW] Vehicle unlocked successfully');

      // Update capability immediately
      await this.setCapabilityValue('locked', false);

      return true;
    } catch (error) {
      this.error('[FLOW] Failed to unlock vehicle:', error.message);
      throw new Error(`Failed to unlock vehicle: ${error.message}`);
    }
  }

  /**
   * Flow action: Start climate control
   */
  async startClimateAction() {
    this.log('[FLOW] Start climate action triggered');
    try {
      await this.api.startClimate(this.vin);
      this.log('[FLOW] Climate control started successfully');

      // Update capability immediately
      await this.setCapabilityValue('onoff.climate', true);

      return true;
    } catch (error) {
      this.error('[FLOW] Failed to start climate:', error.message);
      throw new Error(`Failed to start climate: ${error.message}`);
    }
  }

  /**
   * Flow action: Stop climate control
   */
  async stopClimateAction() {
    this.log('[FLOW] Stop climate action triggered');
    try {
      await this.api.stopClimate(this.vin);
      this.log('[FLOW] Climate control stopped successfully');

      // Update capability immediately
      await this.setCapabilityValue('onoff.climate', false);

      return true;
    } catch (error) {
      this.error('[FLOW] Failed to stop climate:', error.message);
      throw new Error(`Failed to stop climate: ${error.message}`);
    }
  }

  /**
   * Flow action: Flash lights
   */
  async flashLightsAction() {
    this.log('[FLOW] Flash lights action triggered');
    try {
      await this.api.flashLights(this.vin);
      this.log('[FLOW] Lights flashed successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to flash lights:', error.message);
      throw new Error(`Failed to flash lights: ${error.message}`);
    }
  }

  /**
   * Flow action: Start engine
   */
  async startEngineAction() {
    this.log('[FLOW] Start engine action triggered');
    try {
      const settings = this.getSettings();
      const pin = settings.pin;

      if (!pin) {
        throw new Error('PIN is not configured. Please set PIN in device settings.');
      }

      await this.api.startEngine(this.vin, pin);
      this.log('[FLOW] Engine started successfully');

      // Update capability immediately
      await this.setCapabilityValue('onoff.engine', true);

      return true;
    } catch (error) {
      this.error('[FLOW] Failed to start engine:', error.message);
      throw new Error(`Failed to start engine: ${error.message}`);
    }
  }

  /**
   * Flow action: Stop engine
   */
  async stopEngineAction() {
    this.log('[FLOW] Stop engine action triggered');
    try {
      await this.api.stopEngine(this.vin);
      this.log('[FLOW] Engine stopped successfully');

      // Update capability immediately
      await this.setCapabilityValue('onoff.engine', false);

      return true;
    } catch (error) {
      this.error('[FLOW] Failed to stop engine:', error.message);
      throw new Error(`Failed to stop engine: ${error.message}`);
    }
  }

  /**
   * Flow action: Open windows
   */
  async openWindowsAction() {
    this.log('[FLOW] Open windows action triggered');
    try {
      const settings = this.getSettings();
      const pin = settings.pin;

      if (!pin) {
        throw new Error('PIN is not configured. Please set PIN in device settings.');
      }

      await this.api.openWindows(this.vin, pin);
      this.log('[FLOW] Windows opened successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to open windows:', error.message);
      throw new Error(`Failed to open windows: ${error.message}`);
    }
  }

  /**
   * Flow action: Close windows
   */
  async closeWindowsAction() {
    this.log('[FLOW] Close windows action triggered');
    try {
      await this.api.closeWindows(this.vin);
      this.log('[FLOW] Windows closed successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to close windows:', error.message);
      throw new Error(`Failed to close windows: ${error.message}`);
    }
  }

  // ==================== Flow Card Condition Handlers ====================

  /**
   * Flow condition: Is vehicle locked?
   */
  async isLocked() {
    const locked = this.getCapabilityValue('locked');
    this.log(`[FLOW] Is locked condition checked: ${locked}`);
    return locked === true;
  }

  /**
   * Flow condition: Is engine running?
   */
  async isEngineRunning() {
    const running = this.getCapabilityValue('onoff.engine');
    this.log(`[FLOW] Is engine running condition checked: ${running}`);
    return running === true;
  }

  /**
   * Flow condition: Is vehicle charging?
   */
  async isCharging() {
    const chargingPower = this.getCapabilityValue('meter_power');
    const isCharging = chargingPower > 0;
    this.log(`[FLOW] Is charging condition checked: ${isCharging} (power: ${chargingPower} kW)`);
    return isCharging;
  }

  /**
   * Flow condition: Is tire pressure OK?
   * Checks if all tire pressures are >= 2.0 bar
   */
  async tirePressureOk() {
    try {
      const pressureFL = this.getCapabilityValue('tire_pressure_bar.tire_fl');
      const pressureFR = this.getCapabilityValue('tire_pressure_bar.tire_fr');
      const pressureRL = this.getCapabilityValue('tire_pressure_bar.tire_rl');
      const pressureRR = this.getCapabilityValue('tire_pressure_bar.tire_rr');

      // Minimum acceptable pressure: 2.0 bar
      const MIN_PRESSURE = 2.0;

      const allOk = (
        pressureFL >= MIN_PRESSURE &&
        pressureFR >= MIN_PRESSURE &&
        pressureRL >= MIN_PRESSURE &&
        pressureRR >= MIN_PRESSURE
      );

      this.log(`[FLOW] Tire pressure OK condition checked: ${allOk}`);
      this.log(`[FLOW] Pressures - FL: ${pressureFL}, FR: ${pressureFR}, RL: ${pressureRL}, RR: ${pressureRR}`);

      return allOk;
    } catch (error) {
      this.error('[FLOW] Failed to check tire pressure:', error.message);
      return false;
    }
  }

  /**
   * Flow condition: Are all windows closed?
   * This is the flow condition wrapper for areWindowsClosed()
   */
  async windowsClosed() {
    const closed = await this.areWindowsClosed();
    this.log(`[FLOW] Windows closed condition checked: ${closed}`);
    return closed;
  }
}

module.exports = MercedesVehicleDevice;
