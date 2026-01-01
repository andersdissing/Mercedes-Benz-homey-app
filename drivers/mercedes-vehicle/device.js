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

      // Remove deprecated capabilities (migration)
      try {
        if (this.hasCapability('text_charge_flap_state')) {
          this.log('[INIT] Removing deprecated text_charge_flap_state capability');
          await this.removeCapability('text_charge_flap_state');
        }
      } catch (e) {
        this.log('[INIT] Could not remove text_charge_flap_state:', e.message);
      }
      try {
        if (this.hasCapability('ecoscore_total')) {
          this.log('[INIT] Removing deprecated ecoscore_total capability');
          await this.removeCapability('ecoscore_total');
        }
      } catch (e) {
        this.log('[INIT] Could not remove ecoscore_total:', e.message);
      }

      // Remove deprecated charge inlet capabilities
      const chargeInletCaps = ['text_charge_inlet_coupler', 'text_charge_inlet_lock', 'text_charge_flap_dc_status'];
      for (const cap of chargeInletCaps) {
        try {
          if (this.hasCapability(cap)) {
            this.log(`[INIT] Removing deprecated ${cap} capability`);
            await this.removeCapability(cap);
          }
        } catch (e) {
          this.log(`[INIT] Could not remove ${cap}:`, e.message);
        }
      }

      // Add text capabilities that might be missing
      const textCaps = [
        'text_charging_status', 'text_charge_program', 'text_end_charge_time',
        'window_sunroof', 'measure_fuel', 'measure_adblue_level',
        'measure_max_soc', 'measure_oil_level',
        'ecoscore_accel', 'ecoscore_const', 'ecoscore_freewhl',
        'distance_start', 'distance_electrical', 'driven_time_start',
        'odometer', 'meter_power', 'alarm_generic'
      ];
      for (const cap of textCaps) {
        if (!this.hasCapability(cap)) {
          this.log(`[INIT] Adding missing ${cap} capability`);
          await this.addCapability(cap);
        }
      }

      // Add tire pressure capabilities
      const tirePressureCaps = ['tire_pressure_bar.tire_fl', 'tire_pressure_bar.tire_fr', 'tire_pressure_bar.tire_rl', 'tire_pressure_bar.tire_rr'];
      for (const cap of tirePressureCaps) {
        if (!this.hasCapability(cap)) {
          this.log(`[INIT] Adding missing ${cap} capability`);
          await this.addCapability(cap);
        }
      }

      // Remove old window_status.* capabilities and add new window_* capabilities
      const oldWindowCaps = ['window_status.front_left', 'window_status.front_right', 'window_status.rear_left', 'window_status.rear_right'];
      for (const cap of oldWindowCaps) {
        try {
          if (this.hasCapability(cap)) {
            this.log(`[INIT] Removing old ${cap} capability`);
            await this.removeCapability(cap);
          }
        } catch (e) {
          this.log(`[INIT] Could not remove ${cap}:`, e.message);
        }
      }

      const windowCaps = ['window_front_left', 'window_front_right', 'window_rear_left', 'window_rear_right'];
      for (const cap of windowCaps) {
        try {
          if (!this.hasCapability(cap)) {
            this.log(`[INIT] Adding missing ${cap} capability`);
            await this.addCapability(cap);
          }
        } catch (e) {
          this.log(`[INIT] Could not add ${cap}:`, e.message);
        }
      }

      // Remove old door_status.* capabilities and add new door_* capabilities
      const oldDoorCaps = ['door_status.front_left', 'door_status.front_right', 'door_status.rear_left', 'door_status.rear_right', 'door_status.trunk', 'door_status.hood'];
      for (const cap of oldDoorCaps) {
        try {
          if (this.hasCapability(cap)) {
            this.log(`[INIT] Removing old ${cap} capability`);
            await this.removeCapability(cap);
          }
        } catch (e) {
          this.log(`[INIT] Could not remove ${cap}:`, e.message);
        }
      }

      const doorCaps = ['door_front_left', 'door_front_right', 'door_rear_left', 'door_rear_right', 'door_trunk', 'door_hood'];
      for (const cap of doorCaps) {
        try {
          if (!this.hasCapability(cap)) {
            this.log(`[INIT] Adding missing ${cap} capability`);
            await this.addCapability(cap);
          }
        } catch (e) {
          this.log(`[INIT] Could not add ${cap}:`, e.message);
        }
      }

      // Migrate parking brake capability from alarm_parking_brake to parking_brake_engaged
      if (this.hasCapability('alarm_parking_brake')) {
        this.log('[INIT] Removing deprecated alarm_parking_brake capability');
        await this.removeCapability('alarm_parking_brake');
      }
      if (!this.hasCapability('parking_brake_engaged')) {
        this.log('[INIT] Adding missing parking_brake_engaged capability');
        await this.addCapability('parking_brake_engaged');
      }

      // Remove deprecated alarm_starter_battery capability
      try {
        if (this.hasCapability('alarm_starter_battery')) {
          this.log('[INIT] Removing deprecated alarm_starter_battery capability');
          await this.removeCapability('alarm_starter_battery');
        }
      } catch (e) {
        this.log('[INIT] Could not remove alarm_starter_battery:', e.message);
      }

      // Remove deprecated tire temperature capabilities
      const tireTempCaps = ['tire_temperature.tire_fl', 'tire_temperature.tire_fr', 'tire_temperature.tire_rl', 'tire_temperature.tire_rr'];
      for (const cap of tireTempCaps) {
        try {
          if (this.hasCapability(cap)) {
            this.log(`[INIT] Removing deprecated ${cap} capability`);
            await this.removeCapability(cap);
          }
        } catch (e) {
          this.log(`[INIT] Could not remove ${cap}:`, e.message);
        }
      }

      // Remove deprecated alarm_tire_warning capability
      try {
        if (this.hasCapability('alarm_tire_warning')) {
          this.log('[INIT] Removing deprecated alarm_tire_warning capability');
          await this.removeCapability('alarm_tire_warning');
        }
      } catch (e) {
        this.log('[INIT] Could not remove alarm_tire_warning:', e.message);
      }

      // Add theft alarm capability
      if (!this.hasCapability('alarm_theft')) {
        this.log('[INIT] Adding missing alarm_theft capability');
        await this.addCapability('alarm_theft');
      }

      // Add service interval days capability
      if (!this.hasCapability('measure_service_days')) {
        this.log('[INIT] Adding missing measure_service_days capability');
        await this.addCapability('measure_service_days');
      }

      // Add battery temperature capability
      if (!this.hasCapability('measure_battery_temperature')) {
        this.log('[INIT] Adding missing measure_battery_temperature capability');
        await this.addCapability('measure_battery_temperature');
      }

      // Add range capabilities
      if (!this.hasCapability('measure_range_electric')) {
        this.log('[INIT] Adding missing measure_range_electric capability');
        await this.addCapability('measure_range_electric');
      }
      if (!this.hasCapability('measure_range_liquid')) {
        this.log('[INIT] Adding missing measure_range_liquid capability');
        await this.addCapability('measure_range_liquid');
      }

      // Add preconditioning status capability
      if (!this.hasCapability('onoff_precond')) {
        this.log('[INIT] Adding missing onoff_precond capability');
        await this.addCapability('onoff_precond');
      }

      // Add auxiliary heating status capability
      if (!this.hasCapability('onoff_auxheat')) {
        this.log('[INIT] Adding missing onoff_auxheat capability');
        await this.addCapability('onoff_auxheat');
      }

      // Add remote start status capability
      if (!this.hasCapability('onoff_remote_start')) {
        this.log('[INIT] Adding missing onoff_remote_start capability');
        await this.addCapability('onoff_remote_start');
      }

      // Add onoff.ignition capability
      if (!this.hasCapability('onoff.ignition')) {
        this.log('[INIT] Adding missing onoff.ignition capability');
        await this.addCapability('onoff.ignition');
      }

      // Add onoff.engine capability
      if (!this.hasCapability('onoff.engine')) {
        this.log('[INIT] Adding missing onoff.engine capability');
        await this.addCapability('onoff.engine');
      }

      // Add onoff.climate capability
      if (!this.hasCapability('onoff.climate')) {
        this.log('[INIT] Adding missing onoff.climate capability');
        await this.addCapability('onoff.climate');
      }

      // Migrate theft system armed capability from alarm_theft_system to theft_system_armed
      if (this.hasCapability('alarm_theft_system')) {
        this.log('[INIT] Removing deprecated alarm_theft_system capability');
        await this.removeCapability('alarm_theft_system');
      }
      if (!this.hasCapability('theft_system_armed')) {
        this.log('[INIT] Adding missing theft_system_armed capability');
        await this.addCapability('theft_system_armed');
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

          // Extract location from geofence event (this is where lat/long come from!)
          if (last.coordinate) {
            if (last.coordinate.latitude !== undefined) {
              this.log(`[POLL] Setting latitude from geofence: ${last.coordinate.latitude}`);
              await this.setCapabilityValue('measure_latitude', parseFloat(last.coordinate.latitude));
            }
            if (last.coordinate.longitude !== undefined) {
              this.log(`[POLL] Setting longitude from geofence: ${last.coordinate.longitude}`);
              await this.setCapabilityValue('measure_longitude', parseFloat(last.coordinate.longitude));
            }
          }

          // Check if this is a new event
          const lastEventTime = this.getCapabilityValue('time_geofence_last_event');
          const newEventTime = last.time ? new Date(last.time * 1000).toISOString() : null;
          const isNewEvent = newEventTime && newEventTime !== lastEventTime;

          if (last.type) {
            await this.setCapabilityValue('text_geofence_last_event', last.type);
          }
          if (last.snapshot && last.snapshot.name) {
            await this.setCapabilityValue('text_geofence_last_zone', last.snapshot.name);
          } else if (last.fence && last.fence.name) {
            await this.setCapabilityValue('text_geofence_last_zone', last.fence.name);
          }
          if (newEventTime) {
            await this.setCapabilityValue('time_geofence_last_event', newEventTime);
          }

          // Trigger flow cards for new geofence events
          if (isNewEvent) {
            const zoneName = (last.snapshot && last.snapshot.name) || (last.fence && last.fence.name) || 'Unknown';
            const eventType = String(last.type).toUpperCase();

            if (eventType === 'ENTER' || eventType === 'ENTERED' || eventType === 'LEAVE_TO_ENTER') {
              await this.homey.flow.getDeviceTriggerCard('geofence_entered')
                .trigger(this, { zone_name: zoneName });
            } else if (eventType === 'LEAVE' || eventType === 'LEFT' || eventType === 'ENTER_TO_LEAVE') {
              await this.homey.flow.getDeviceTriggerCard('geofence_left')
                .trigger(this, { zone_name: zoneName });
            }
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

      // Charging power (kW) - check both lowercase and camelCase variants
      const chargingPowerValue = data.chargingpower ?? data.chargingPower;
      if (chargingPowerValue !== undefined) {
        const chargingPower = parseFloat(chargingPowerValue);
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

      // Engine state - check both lowercase and camelCase variants
      const engineStateValue = data.enginestate ?? data.engineState;
      if (engineStateValue !== undefined) {
        const engineRunning = engineStateValue === true || engineStateValue === 'RUNNING';
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
      // Check both lowercase and camelCase variants for API compatibility
      const tirePressureFL = data.tirepressurefrontleft ?? data.tirepressureFrontLeft;
      if (tirePressureFL !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_fl', parseFloat(tirePressureFL));
      }
      const tirePressureFR = data.tirepressurefrontright ?? data.tirepressureFrontRight;
      if (tirePressureFR !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_fr', parseFloat(tirePressureFR));
      }
      const tirePressureRL = data.tirepressurerearleft ?? data.tirepressureRearLeft;
      if (tirePressureRL !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_rl', parseFloat(tirePressureRL));
      }
      const tirePressureRR = data.tirepressurerearright ?? data.tirepressureRearRight;
      if (tirePressureRR !== undefined) {
        await this.setCapabilityValue('tire_pressure_bar.tire_rr', parseFloat(tirePressureRR));
      }

      // Odometer reading
      if (data.odo !== undefined) {
        this.log(`[UPDATE] Setting odometer to: ${data.odo} km`);
        await this.setCapabilityValue('odometer', parseFloat(data.odo));
      }

      // Trip distance since start - check both lowercase and camelCase variants
      const distanceStartValue = data.distancestart ?? data.distanceStart;
      if (distanceStartValue !== undefined) {
        this.log(`[UPDATE] Setting trip distance to: ${distanceStartValue} km`);
        await this.setCapabilityValue('distance_start', parseFloat(distanceStartValue));
      }

      // Electric trip distance - check both lowercase and camelCase variants
      const distanceElectricalValue = data.distanceelectricalstart ?? data.distanceElectricalStart;
      if (distanceElectricalValue !== undefined) {
        this.log(`[UPDATE] Setting electric distance to: ${distanceElectricalValue} km`);
        await this.setCapabilityValue('distance_electrical', parseFloat(distanceElectricalValue));
      }

      // Driving time since start - check both lowercase and camelCase variants
      const drivenTimeValue = data.driventimestart ?? data.drivenTimeStart;
      if (drivenTimeValue !== undefined) {
        this.log(`[UPDATE] Setting driving time to: ${drivenTimeValue} min`);
        await this.setCapabilityValue('driven_time_start', parseInt(drivenTimeValue));
      }

      // Average speed since start - check both lowercase and camelCase variants
      const averageSpeedValue = data.averagespeedstart ?? data.averageSpeedStart;
      if (averageSpeedValue !== undefined) {
        const speed = parseFloat(averageSpeedValue);
        this.log(`[UPDATE] Setting average speed to: ${speed} km/h`);
        await this.setCapabilityValue('average_speed', speed);
      } else {
        // Set to 0 when not available (car is stopped)
        await this.setCapabilityValue('average_speed', 0);
      }

      const ecoScoreAccel = data.ecoscoreaccel ?? data.ecoScoreAccel ?? data.ecoscoreAccel;
      if (ecoScoreAccel !== undefined) {
        this.log(`[UPDATE] Setting acceleration eco score to: ${ecoScoreAccel}`);
        await this.setCapabilityValue('ecoscore_accel', parseInt(ecoScoreAccel));
      }
      const ecoScoreConst = data.ecoscoreconst ?? data.ecoScoreConst ?? data.ecoscoreConst;
      if (ecoScoreConst !== undefined) {
        this.log(`[UPDATE] Setting constant eco score to: ${ecoScoreConst}`);
        await this.setCapabilityValue('ecoscore_const', parseInt(ecoScoreConst));
      }
      const ecoScoreFreeWhl = data.ecoscorefreewhl ?? data.ecoScoreFreeWhl ?? data.ecoscoreFreeWhl ?? data.ecoScoreFreewheel;
      if (ecoScoreFreeWhl !== undefined) {
        this.log(`[UPDATE] Setting freewheel eco score to: ${ecoScoreFreeWhl}`);
        await this.setCapabilityValue('ecoscore_freewhl', parseInt(ecoScoreFreeWhl));
      }

      // Generic alarm (warnings) with trigger
      const hasWarning = data.warningwashwater || data.warningcoolantlevellow ||
                        data.warningbrakefluid || data.warningenginelight;
      const hadWarning = this.getCapabilityValue('alarm_generic');
      await this.setCapabilityValue('alarm_generic', hasWarning === true);

      // Trigger warning light activated when a new warning appears
      if (hasWarning === true && hadWarning !== true) {
        await this.homey.flow.getDeviceTriggerCard('warning_light_activated').trigger(this);
      }

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

      // Charging status (text) with charging completed trigger
      if (data.chargingstatus !== undefined) {
        const oldStatus = this.getCapabilityValue('text_charging_status');
        this.log(`[UPDATE] Setting charging status to: ${data.chargingstatus}`);
        await this.setCapabilityValue('text_charging_status', String(data.chargingstatus));

        // Trigger charging completed when status changes to completed/finished
        const completedStatuses = ['FINISHED', 'COMPLETED', 'END', '4'];
        const wasCharging = oldStatus && !completedStatuses.includes(String(oldStatus).toUpperCase());
        const isCompleted = completedStatuses.includes(String(data.chargingstatus).toUpperCase());

        if (wasCharging && isCompleted) {
          const batteryLevel = this.getCapabilityValue('measure_battery') || 0;
          await this.homey.flow.getDeviceTriggerCard('charging_completed')
            .trigger(this, { battery_level: batteryLevel });
        }
      }

      // Selected charge program (text)
      if (data.selectedChargeProgram !== undefined) {
        this.log(`[UPDATE] Setting selected charge program to: ${data.selectedChargeProgram}`);
        await this.setCapabilityValue('text_charge_program', String(data.selectedChargeProgram));
      }

      // Max SoC (check both maxSoc and max_soc as API may use either)
      const maxSocValue = data.maxSoc !== undefined ? data.maxSoc : data.max_soc;
      if (maxSocValue !== undefined) {
        this.log(`[UPDATE] Setting max SoC to: ${maxSocValue}%`);
        await this.setCapabilityValue('measure_max_soc', parseInt(maxSocValue));
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
        const sunroofMap = {
          0: 'Closed',
          1: 'Open',
          2: 'Tilted',
          3: 'Running',
          4: 'Anti-Booming',
          5: 'Intermediate',
          6: 'Opening',
          7: 'Closing'
        };
        const sunroofStatus = sunroofMap[data.sunroofstatus] || String(data.sunroofstatus);
        this.log(`[UPDATE] Setting sunroof status to: ${sunroofStatus} (raw: ${data.sunroofstatus})`);
        await this.setCapabilityValue('window_sunroof', sunroofStatus);
      }

      // Departure Time
      if (data.departuretime !== undefined) {
        this.log(`[UPDATE] Setting departure time to: ${data.departuretime}`);
        await this.setCapabilityValue('text_departure_time', data.departuretime);
      }

      // Departure Time Mode (check multiple possible field names)
      const departureTimeModeRaw = data.departureTimeMode !== undefined ? data.departureTimeMode :
                                   data.departuretimemode !== undefined ? data.departuretimemode :
                                   data.departuretime_mode;
      if (departureTimeModeRaw !== undefined) {
        const departureModeMap = {
          0: 'Inactive',
          1: 'Single',
          2: 'Weekly'
        };
        const departureTimeModeValue = departureModeMap[departureTimeModeRaw] || String(departureTimeModeRaw);
        this.log(`[UPDATE] Setting departure time mode to: ${departureTimeModeValue} (raw: ${departureTimeModeRaw})`);
        await this.setCapabilityValue('text_departure_time_mode', departureTimeModeValue);
      }

      // Position latitude/longitude are NOT available in vehicle attributes API
      // They come from geofencing violations API (polled separately)
      const posLat = data.positionlat ?? data.positionLat ?? data.latitude ?? data.gpsLat ?? data.gpslat;
      const posLong = data.positionlong ?? data.positionLong ?? data.longitude ?? data.gpsLon ?? data.gpslon;
      if (posLat !== undefined && posLong !== undefined) {
        const lat = parseFloat(posLat);
        const long = parseFloat(posLong);
        this.log(`[UPDATE] Setting location: ${lat}, ${long}`);
        await this.setCapabilityValue('measure_latitude', lat);
        await this.setCapabilityValue('measure_longitude', long);
      }

      // Heading - the correct field name is positionHeading (camelCase)
      const posHeading = data.positionHeading ?? data.positionheading ?? data.heading ?? data.gpsHeading ?? data.gpsheading;
      if (posHeading !== undefined) {
        const heading = parseFloat(posHeading);
        this.log(`[UPDATE] Setting heading: ${heading}`);
        await this.setCapabilityValue('measure_heading', heading);
      }

      // Window statuses with flow triggers
      const windowMappings = [
        { key: 'windowstatusfrontleft', cap: 'window_front_left', name: 'front_left' },
        { key: 'windowstatusfrontright', cap: 'window_front_right', name: 'front_right' },
        { key: 'windowstatusrearleft', cap: 'window_rear_left', name: 'rear_left' },
        { key: 'windowstatusrearright', cap: 'window_rear_right', name: 'rear_right' }
      ];

      for (const win of windowMappings) {
        if (data[win.key] !== undefined) {
          try {
            if (!this.hasCapability(win.cap)) {
              this.log(`[UPDATE] Skipping ${win.cap} - capability not available (re-pair device to fix)`);
              continue;
            }
            const windowStatusMap = {
              0: 'Intermediate',
              1: 'Open',
              2: 'Closed',
              3: 'Airing',
              4: 'Running'
            };
            const rawStatus = data[win.key];
            const newStatus = windowStatusMap[rawStatus] || String(rawStatus);
            const oldStatus = this.getCapabilityValue(win.cap);
            await this.setCapabilityValue(win.cap, newStatus);

            // Trigger flow cards on status change
            if (oldStatus !== newStatus) {
              if (newStatus === 'Closed' || newStatus === 'CLOSED' || newStatus === '2') {
                await this.homey.flow.getDeviceTriggerCard('window_closed')
                  .trigger(this, { window: win.name });
              } else if (newStatus === 'Open' || newStatus === 'OPEN' || newStatus === '1' || newStatus === 'Intermediate' || newStatus === 'Airing') {
                await this.homey.flow.getDeviceTriggerCard('window_opened')
                  .trigger(this, { window: win.name });
              }
            }
          } catch (e) {
            this.log(`[UPDATE] Error updating ${win.cap}:`, e.message);
          }
        }
      }

      // Door statuses with flow triggers
      const doorMappings = [
        { keys: ['doorstatusfrontleft', 'doorStatusFrontLeft', 'doorFrontLeftStatus'], cap: 'door_front_left', name: 'front_left' },
        { keys: ['doorstatusfrontright', 'doorStatusFrontRight', 'doorFrontRightStatus'], cap: 'door_front_right', name: 'front_right' },
        { keys: ['doorstatusrearleft', 'doorStatusRearLeft', 'doorRearLeftStatus'], cap: 'door_rear_left', name: 'rear_left' },
        { keys: ['doorstatusrearright', 'doorStatusRearRight', 'doorRearRightStatus'], cap: 'door_rear_right', name: 'rear_right' },
        { keys: ['decklidstatus', 'decklidStatus', 'trunkStatus'], cap: 'door_trunk', name: 'trunk' },
        { keys: ['enginehoodstatus', 'engineHoodStatus', 'hoodStatus'], cap: 'door_hood', name: 'hood' }
      ];

      for (const door of doorMappings) {
        // Find the first matching key
        const matchingKey = door.keys.find(k => data[k] !== undefined);
        if (matchingKey !== undefined && data[matchingKey] !== undefined) {
          try {
            if (!this.hasCapability(door.cap)) {
              this.log(`[UPDATE] Skipping ${door.cap} - capability not available (re-pair device to fix)`);
              continue;
            }
            const doorData = data[matchingKey];
            const newStatus = doorData === true ? 'Open' : doorData === false ? 'Closed' : String(doorData);
            const oldStatus = this.getCapabilityValue(door.cap);
            await this.setCapabilityValue(door.cap, newStatus);

            // Trigger flow cards on status change
            if (oldStatus !== newStatus) {
              if (newStatus === 'Closed' || newStatus === 'CLOSED' || newStatus === 'false' || newStatus === '0') {
                await this.homey.flow.getDeviceTriggerCard('door_closed')
                  .trigger(this, { door: door.name });
              } else if (newStatus === 'Open' || newStatus === 'OPEN' || newStatus === 'true' || newStatus === '1') {
                await this.homey.flow.getDeviceTriggerCard('door_opened')
                  .trigger(this, { door: door.name });
              }
            }
          } catch (e) {
            this.log(`[UPDATE] Error updating ${door.cap}:`, e.message);
          }
        }
      }

      // Parking brake status
      if (data.parkbrakestatus !== undefined) {
        const parkBrakeEngaged = data.parkbrakestatus === true || data.parkbrakestatus === 'true' || data.parkbrakestatus === 1;
        await this.setCapabilityValue('parking_brake_engaged', parkBrakeEngaged);
      }

      // Service interval days
      if (data.serviceintervaldays !== undefined) {
        await this.setCapabilityValue('measure_service_days', parseInt(data.serviceintervaldays));
      }

      // Battery temperature (EV) - check various possible attribute names
      // Mercedes uses different naming conventions: temperaturehvbattery, hvbatterytemperature, etc.
      const batteryTempValue = data.temperaturehvbattery ?? data.temperatureHVBattery ??
        data.hvbatterytemperature ?? data.hvBatteryTemperature ??
        data.ecoelectricbatterytemperature ?? data.ecoElectricBatteryTemperature ??
        data.batterytemperature ?? data.batteryTemperature;
      if (batteryTempValue !== undefined) {
        this.log('[DATA] Battery temperature found:', batteryTempValue);
        await this.setCapabilityValue('measure_battery_temperature', parseFloat(batteryTempValue));
      }

      // Debug: Log all attributes containing 'temp' or 'battery' to find correct key
      const tempBatteryKeys = Object.keys(data).filter(k =>
        k.toLowerCase().includes('temp') || k.toLowerCase().includes('battery')
      );
      if (tempBatteryKeys.length > 0) {
        this.log('[DEBUG] Temperature/Battery related attributes:', tempBatteryKeys.map(k => `${k}=${data[k]}`).join(', '));
      }

      // Preconditioning status - check both lowercase and camelCase variants
      const precondActiveValue = data.precondactive ?? data.precondActive;
      if (precondActiveValue !== undefined) {
        const precondActive = precondActiveValue === true || precondActiveValue === 'true' || precondActiveValue === 1;
        await this.setCapabilityValue('onoff_precond', precondActive);
      }

      // Auxiliary heating status - check both lowercase and camelCase variants
      const auxheatActiveValue = data.auxheatactive ?? data.auxheatActive;
      if (auxheatActiveValue !== undefined) {
        const auxheatActive = auxheatActiveValue === true || auxheatActiveValue === 'true' || auxheatActiveValue === 1;
        await this.setCapabilityValue('onoff_auxheat', auxheatActive);
      }

      // Remote start status - check both lowercase and camelCase variants
      const remoteStartActiveValue = data.remotestartactive ?? data.remoteStartActive;
      if (remoteStartActiveValue !== undefined) {
        const remoteStartActive = remoteStartActiveValue === true || remoteStartActiveValue === 'true' || remoteStartActiveValue === 1;
        await this.setCapabilityValue('onoff_remote_start', remoteStartActive);
      }

      // Theft system armed status - check both lowercase and camelCase variants
      const theftSystemArmedValue = data.theftsystemarmed ?? data.theftSystemArmed;
      if (theftSystemArmedValue !== undefined) {
        const theftArmed = theftSystemArmedValue === true || theftSystemArmedValue === 'true' || theftSystemArmedValue === 1;
        await this.setCapabilityValue('theft_system_armed', theftArmed);
      }

      // Theft alarm status - check both lowercase and camelCase variants
      const theftAlarmActiveValue = data.theftalarmactive ?? data.theftAlarmActive;
      const lastTheftWarningValue = data.lasttheftwarning ?? data.lastTheftWarning;
      if (theftAlarmActiveValue !== undefined || lastTheftWarningValue !== undefined) {
        const theftActive = theftAlarmActiveValue === true || theftAlarmActiveValue === 1;
        const wasTheftActive = this.getCapabilityValue('alarm_theft');
        await this.setCapabilityValue('alarm_theft', theftActive);

        // Trigger vehicle alarm flow card when alarm activates
        if (theftActive && !wasTheftActive) {
          const reasonValue = data.lasttheftwarningreason ?? data.lastTheftWarningReason;
          const reason = reasonValue || 'UNKNOWN';
          await this.homey.flow.getDeviceTriggerCard('vehicle_alarm')
            .trigger(this, { reason: String(reason) });
        }
      }

      // Geofence data from WebSocket (if available) - check multiple possible field names
      const geofenceZone = data.geofencename ?? data.geofenceName ?? data.geofence_name ??
                           data.lastgeofencezone ?? data.lastGeofenceZone ?? data.currentzone ?? data.currentZone;
      if (geofenceZone !== undefined) {
        this.log(`[UPDATE] Setting geofence zone to: ${geofenceZone}`);
        await this.setCapabilityValue('text_geofence_last_zone', String(geofenceZone));
      }

      const geofenceEvent = data.geofenceevent ?? data.geofenceEvent ?? data.geofence_event ??
                            data.lastgeofenceevent ?? data.lastGeofenceEvent;
      if (geofenceEvent !== undefined) {
        this.log(`[UPDATE] Setting geofence event to: ${geofenceEvent}`);
        await this.setCapabilityValue('text_geofence_last_event', String(geofenceEvent));
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

  /**
   * Flow action: Open sunroof
   */
  async openSunroofAction() {
    this.log('[FLOW] Open sunroof action triggered');
    try {
      const settings = this.getSettings();
      const pin = settings.pin;

      if (!pin) {
        throw new Error('PIN is not configured. Please set PIN in device settings.');
      }

      await this.api.openSunroof(this.vin, pin);
      this.log('[FLOW] Sunroof opened successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to open sunroof:', error.message);
      throw new Error(`Failed to open sunroof: ${error.message}`);
    }
  }

  /**
   * Flow action: Close sunroof
   */
  async closeSunroofAction() {
    this.log('[FLOW] Close sunroof action triggered');
    try {
      await this.api.closeSunroof(this.vin);
      this.log('[FLOW] Sunroof closed successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to close sunroof:', error.message);
      throw new Error(`Failed to close sunroof: ${error.message}`);
    }
  }

  /**
   * Flow action: Tilt sunroof
   */
  async tiltSunroofAction() {
    this.log('[FLOW] Tilt sunroof action triggered');
    try {
      await this.api.tiltSunroof(this.vin);
      this.log('[FLOW] Sunroof tilted successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to tilt sunroof:', error.message);
      throw new Error(`Failed to tilt sunroof: ${error.message}`);
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

  /**
   * Flow condition: Is preconditioning active?
   */
  async isPreconditioning() {
    const active = this.getCapabilityValue('onoff_precond');
    this.log(`[FLOW] Is preconditioning condition checked: ${active}`);
    return active === true;
  }

  /**
   * Flow condition: Is auxiliary heating active?
   */
  async isAuxHeatActive() {
    const active = this.getCapabilityValue('onoff_auxheat');
    this.log(`[FLOW] Is auxiliary heating active condition checked: ${active}`);
    return active === true;
  }

  /**
   * Flow condition: Is any door open?
   */
  async anyDoorOpen() {
    const doors = [
      this.getCapabilityValue('door_front_left'),
      this.getCapabilityValue('door_front_right'),
      this.getCapabilityValue('door_rear_left'),
      this.getCapabilityValue('door_rear_right'),
      this.getCapabilityValue('door_trunk'),
      this.getCapabilityValue('door_hood')
    ];

    const anyOpen = doors.some(status =>
      status === 'OPEN' || status === 'true' || status === '1'
    );

    this.log(`[FLOW] Any door open condition checked: ${anyOpen}`);
    return anyOpen;
  }

  /**
   * Flow condition: Is any warning light active?
   */
  async warningActive() {
    const warning = this.getCapabilityValue('alarm_generic');
    this.log(`[FLOW] Warning active condition checked: ${warning}`);
    return warning === true;
  }

  /**
   * Flow condition: Is sunroof open?
   */
  async sunroofOpen() {
    const status = this.getCapabilityValue('window_sunroof');
    const isOpen = status !== 'CLOSED' && status !== '0' && status !== null && status !== '-';
    this.log(`[FLOW] Sunroof open condition checked: ${isOpen} (status: ${status})`);
    return isOpen;
  }

  /**
   * Flow condition: Battery level above threshold
   * @param {number} threshold - Battery percentage threshold
   */
  async batteryLevelAbove(threshold) {
    const batteryLevel = this.getCapabilityValue('measure_battery') || 0;
    const isAbove = batteryLevel >= threshold;
    this.log(`[FLOW] Battery level condition: ${batteryLevel}% >= ${threshold}% = ${isAbove}`);
    return isAbove;
  }

  /**
   * Flow condition: Is vehicle in geofence zone
   * @param {string} zoneName - Name of the geofence zone to check
   */
  async isInGeofence(zoneName) {
    const lastEvent = this.getCapabilityValue('text_geofence_last_event');
    const lastZone = this.getCapabilityValue('text_geofence_last_zone');

    // Vehicle is in zone if last event was 'enter' or 'ENTER' and zone matches
    const isEnter = lastEvent && (lastEvent.toUpperCase() === 'ENTER' || lastEvent.toUpperCase() === 'ENTERED');
    const zoneMatches = lastZone && lastZone.toLowerCase() === zoneName.toLowerCase();
    const inZone = isEnter && zoneMatches;

    this.log(`[FLOW] Is in geofence condition: zone=${zoneName}, lastEvent=${lastEvent}, lastZone=${lastZone}, result=${inZone}`);
    return inZone;
  }

  /**
   * Flow action: Send route to car
   * @param {string} title - Destination name
   * @param {number} latitude - Latitude coordinate
   * @param {number} longitude - Longitude coordinate
   */
  async sendRouteAction(title, latitude, longitude) {
    this.log(`[FLOW] Send route action: ${title} (${latitude}, ${longitude})`);
    try {
      await this.api.sendRoute(this.vin, title, latitude, longitude, '', '', '');
      this.log('[FLOW] Route sent successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to send route:', error.message);
      throw new Error(`Failed to send route: ${error.message}`);
    }
  }

  /**
   * Flow action: Configure maximum state of charge
   * @param {number} maxSoc - Maximum state of charge percentage (50-100)
   * @param {string} chargeProgram - Charge program ID (0=Default, 2=Home, 3=Work)
   */
  async configureMaxSocAction(maxSoc, chargeProgram) {
    this.log(`[FLOW] Configure max SOC action: ${maxSoc}%, program=${chargeProgram}`);
    try {
      await this.api.configureBatteryMaxSoc(this.vin, maxSoc, parseInt(chargeProgram, 10));
      this.log('[FLOW] Max SOC configured successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to configure max SOC:', error.message);
      throw new Error(`Failed to configure max SOC: ${error.message}`);
    }
  }

  /**
   * Flow action: Start preconditioning (ZEV electric climate)
   */
  async startPrecondAction() {
    this.log('[FLOW] Start preconditioning action');
    try {
      await this.api.startPrecond(this.vin);
      this.log('[FLOW] Preconditioning started successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to start preconditioning:', error.message);
      throw new Error(`Failed to start preconditioning: ${error.message}`);
    }
  }

  /**
   * Flow action: Stop preconditioning (ZEV electric climate)
   */
  async stopPrecondAction() {
    this.log('[FLOW] Stop preconditioning action');
    try {
      await this.api.stopPrecond(this.vin);
      this.log('[FLOW] Preconditioning stopped successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to stop preconditioning:', error.message);
      throw new Error(`Failed to stop preconditioning: ${error.message}`);
    }
  }

  /**
   * Flow action: Configure departure time for preconditioning
   * @param {number} hour - Hour (0-23)
   * @param {number} minute - Minute (0-59)
   * @param {string} mode - Mode (0=disabled, 1=single, 2=weekly)
   */
  async configureDepartureTimeAction(hour, minute, mode) {
    const departureTime = hour * 60 + minute;  // Convert to minutes from midnight
    this.log(`[FLOW] Configure departure time action: ${hour}:${minute} (${departureTime} min), mode=${mode}`);
    try {
      await this.api.configurePrecondDeparture(this.vin, departureTime, parseInt(mode, 10));
      this.log('[FLOW] Departure time configured successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to configure departure time:', error.message);
      throw new Error(`Failed to configure departure time: ${error.message}`);
    }
  }

  /**
   * Flow action: Configure cabin temperature
   * @param {number} temperature - Temperature in Celsius (16-28)
   */
  async configureTemperatureAction(temperature) {
    this.log(`[FLOW] Configure temperature action: ${temperature}°C`);
    try {
      // Set all zones to the same temperature
      const zones = [
        { zone: 'frontLeft', temperature },
        { zone: 'frontRight', temperature }
      ];
      await this.api.configureTemperature(this.vin, zones);
      this.log('[FLOW] Temperature configured successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to configure temperature:', error.message);
      throw new Error(`Failed to configure temperature: ${error.message}`);
    }
  }

  /**
   * Flow action: Configure seat heating
   * @param {boolean} frontLeft - Front left seat heating
   * @param {boolean} frontRight - Front right seat heating
   * @param {boolean} rearLeft - Rear left seat heating
   * @param {boolean} rearRight - Rear right seat heating
   */
  async configureSeatHeatingAction(frontLeft, frontRight, rearLeft, rearRight) {
    this.log(`[FLOW] Configure seat heating action: FL=${frontLeft}, FR=${frontRight}, RL=${rearLeft}, RR=${rearRight}`);
    try {
      await this.api.configureSeatHeating(this.vin, frontLeft, frontRight, rearLeft, rearRight);
      this.log('[FLOW] Seat heating configured successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to configure seat heating:', error.message);
      throw new Error(`Failed to configure seat heating: ${error.message}`);
    }
  }

  /**
   * Flow action: Sound horn
   * @param {string} mode - 'horn_light', 'horn_only', or 'panic'
   */
  async soundHornAction(mode) {
    this.log(`[FLOW] Sound horn action with mode: ${mode}`);
    try {
      await this.api.soundHorn(this.vin, mode);
      this.log('[FLOW] Horn activated successfully');
      return true;
    } catch (error) {
      this.error('[FLOW] Failed to sound horn:', error.message);
      throw new Error(`Failed to sound horn: ${error.message}`);
    }
  }
}

module.exports = MercedesVehicleDevice;
