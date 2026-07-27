'use strict';

const Homey = require('homey');
const MercedesOAuth = require('../../lib/oauth');

class MercedesVehicleDriver extends Homey.Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Mercedes Vehicle Driver has been initialized');

    // Register flow card handlers
    this._registerFlowCards();
  }

  /**
   * Register all flow card listeners
   */
  _registerFlowCards() {
    this.log('Registering flow cards...');

    try {
      // ==================== ACTION CARDS ====================

      // Lock vehicle
      this.homey.flow.getActionCard('lock_vehicle')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Lock vehicle action triggered');
          await args.device.lockVehicleAction();
          return true;
        });

      // Unlock vehicle
      this.homey.flow.getActionCard('unlock_vehicle')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Unlock vehicle action triggered');
          await args.device.unlockVehicleAction();
          return true;
        });

      // Start climate control
      this.homey.flow.getActionCard('start_climate')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Start climate action triggered');
          await args.device.startClimateAction();
          return true;
        });

      // Stop climate control
      this.homey.flow.getActionCard('stop_climate')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Stop climate action triggered');
          await args.device.stopClimateAction();
          return true;
        });

      // Flash lights
      this.homey.flow.getActionCard('flash_lights')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Flash lights action triggered');
          await args.device.flashLightsAction();
          return true;
        });

      // Start engine
      this.homey.flow.getActionCard('start_engine')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Start engine action triggered');
          await args.device.startEngineAction();
          return true;
        });

      // Stop engine
      this.homey.flow.getActionCard('stop_engine')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Stop engine action triggered');
          await args.device.stopEngineAction();
          return true;
        });

      // Open windows
      this.homey.flow.getActionCard('open_windows')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Open windows action triggered');
          await args.device.openWindowsAction();
          return true;
        });

      // Close windows
      this.homey.flow.getActionCard('close_windows')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Close windows action triggered');
          await args.device.closeWindowsAction();
          return true;
        });

      // Refresh vehicle data
      this.homey.flow.getActionCard('refresh_data')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Refresh data action triggered');
          await args.device.refreshDataAction();
          return true;
        });

      // Open sunroof
      this.homey.flow.getActionCard('open_sunroof')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Open sunroof action triggered');
          await args.device.openSunroofAction();
          return true;
        });

      // Close sunroof
      this.homey.flow.getActionCard('close_sunroof')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Close sunroof action triggered');
          await args.device.closeSunroofAction();
          return true;
        });

      // Tilt sunroof
      this.homey.flow.getActionCard('tilt_sunroof')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Tilt sunroof action triggered');
          await args.device.tiltSunroofAction();
          return true;
        });

      // Start charging (resume)
      this.homey.flow.getActionCard('start_charging')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Start charging action triggered');
          await args.device.startChargingAction();
          return true;
        });

      // Stop charging (pause)
      this.homey.flow.getActionCard('stop_charging')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Stop charging action triggered');
          await args.device.stopChargingAction();
          return true;
        });

      // Start preconditioning
      this.homey.flow.getActionCard('start_precond')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Start preconditioning action triggered');
          await args.device.startPrecondAction();
          return true;
        });

      // Stop preconditioning
      this.homey.flow.getActionCard('stop_precond')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Stop preconditioning action triggered');
          await args.device.stopPrecondAction();
          return true;
        });

      // Send route
      this.homey.flow.getActionCard('send_route')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Send route action triggered');
          await args.device.sendRouteAction(args.title, args.latitude, args.longitude);
          return true;
        });

      // Sound horn
      this.homey.flow.getActionCard('sound_horn')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Sound horn action triggered');
          await args.device.soundHornAction(args.mode);
          return true;
        });

      // Configure departure time
      this.homey.flow.getActionCard('configure_departure_time')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Configure departure time action triggered');
          await args.device.configureDepartureTimeAction(args.hour, args.minute, args.mode);
          return true;
        });

      // Configure max SoC
      this.homey.flow.getActionCard('configure_max_soc')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Configure max SoC action triggered');
          await args.device.configureMaxSocAction(args.max_soc);
          return true;
        });

      // Configure seat heating
      this.homey.flow.getActionCard('configure_seat_heating')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Configure seat heating action triggered');
          await args.device.configureSeatHeatingAction(args.front_left, args.front_right, args.rear_left, args.rear_right);
          return true;
        });

      // Configure temperature
      this.homey.flow.getActionCard('configure_temperature')
        .registerRunListener(async (args) => {
          this.log('[FLOW] Configure temperature action triggered');
          await args.device.configureTemperatureAction(args.temperature);
          return true;
        });

      // ==================== CONDITION CARDS ====================

      // Is locked?
      this.homey.flow.getConditionCard('is_locked')
        .registerRunListener(async (args) => {
          return await args.device.isLocked();
        });

      // Is engine running?
      this.homey.flow.getConditionCard('is_engine_running')
        .registerRunListener(async (args) => {
          return await args.device.isEngineRunning();
        });

      // Is charging?
      this.homey.flow.getConditionCard('is_charging')
        .registerRunListener(async (args) => {
          return await args.device.isCharging();
        });

      // Is connector connected?
      this.homey.flow.getConditionCard('is_connector_connected')
        .registerRunListener(async (args) => {
          return await args.device.isConnectorConnected();
        });

      // Tire pressure OK?
      this.homey.flow.getConditionCard('tire_pressure_ok')
        .registerRunListener(async (args) => {
          return await args.device.tirePressureOk();
        });

      // Windows closed?
      this.homey.flow.getConditionCard('windows_closed')
        .registerRunListener(async (args) => {
          return await args.device.windowsClosed();
        });

      // Any door open?
      this.homey.flow.getConditionCard('any_door_open')
        .registerRunListener(async (args) => {
          return await args.device.anyDoorOpen();
        });

      // Is preconditioning active?
      this.homey.flow.getConditionCard('is_preconditioning')
        .registerRunListener(async (args) => {
          return await args.device.isPreconditioning();
        });

      // Sunroof open?
      this.homey.flow.getConditionCard('sunroof_open')
        .registerRunListener(async (args) => {
          return await args.device.sunroofOpen();
        });

      // Warning light active?
      this.homey.flow.getConditionCard('warning_active')
        .registerRunListener(async (args) => {
          return await args.device.warningActive();
        });

      // Battery level above/below threshold?
      this.homey.flow.getConditionCard('battery_level')
        .registerRunListener(async (args) => {
          return await args.device.batteryLevelAbove(args.threshold);
        });

      // Is auxiliary heating active?
      this.homey.flow.getConditionCard('is_auxheat_active')
        .registerRunListener(async (args) => {
          return await args.device.isAuxHeatActive();
        });

      // Is in geofence zone?
      this.homey.flow.getConditionCard('is_in_geofence')
        .registerRunListener(async (args) => {
          return await args.device.isInGeofence(args.zone_name);
        });

      this.log('Flow cards registered successfully');
    } catch (error) {
      this.error('Error registering flow cards:', error.message);
      this.error('Stack:', error.stack);
    }
  }

  /**
   * Pre-select a likely Mercedes me account region from the Homey's timezone.
   * This is only a starting point for the pair view's dropdown — the account
   * region is where the Mercedes me account was registered, not where the
   * Homey physically sits, so the user must be able to override it.
   */
  _defaultRegionFromTimezone(tz) {
    if (tz === 'Asia/Shanghai' || tz === 'Asia/Urumqi') return 'China';
    if (tz && tz.startsWith('America/')) return 'North America';
    if (tz && (tz.startsWith('Australia/') || tz.startsWith('Pacific/') || tz.startsWith('Asia/'))) {
      return 'Asia-Pacific';
    }
    return 'Europe'; // Europe/*, Africa/*, Atlantic/*, and fallback
  }

  /**
   * onPair is called when a user starts pairing
   */
  async onPair(session) {
    let credentials = {};
    let region = 'Europe';
    let oauth = null;
    let vehicles = [];
    let deviceGuid = null;

    // Provide a sensible default for the pair view's region dropdown
    session.setHandler('get_default_region', async () => {
      return this._defaultRegionFromTimezone(this.homey.clock.getTimezone());
    });

    // Handle login credentials
    session.setHandler('login', async (data) => {
      region = Object.keys(MercedesOAuth.ENDPOINTS).includes(data.region) ? data.region : 'Europe';
      this.log(`Login attempt with email: ${data.username} (selected region: ${data.region}, using: ${region})`);

      credentials = {
        username: data.username,
        password: data.password
      };

      try {
        // Initialize OAuth with the selected region and generate a persistent deviceGuid
        oauth = new MercedesOAuth(this.homey, region);
        deviceGuid = oauth.deviceGuid; // Store for later use

        // Attempt login
        await oauth.login(credentials.username, credentials.password);
        this.log('Login successful');

        // Fetch vehicles immediately after login
        try {
          vehicles = await oauth.getVehicles();
          this.log(`Found ${vehicles.length} vehicle(s)`);
        } catch (vehicleError) {
          // Check if it's a rate limit error (418)
          if (vehicleError.message && (vehicleError.message.includes('418') || vehicleError.message.includes('status code 418'))) {
            this.error('Rate limited by Mercedes API');
            throw new Error('Too many requests. Please wait 15-30 minutes and try again.');
          }
          // A 404 here means login succeeded but the region's backend has
          // no record of this account — almost always a region mismatch.
          if (vehicleError.message && (vehicleError.message.includes('404') || vehicleError.message.includes('status code 404'))) {
            throw new Error(this.homey.__('pair.vehicles_region_mismatch', { region }));
          }
          throw vehicleError;
        }

        return true;
      } catch (error) {
        this.error('Login or vehicle fetch failed:', error.message);
        this._persistLoginDiagnostic('pair', region, credentials.username, oauth, error);
        throw new Error(this._buildLoginErrorMessage(region, oauth, error));
      }
    });

    // Show available vehicles for pairing
    session.setHandler('list_devices', async () => {
      this.log('list_devices called, returning', vehicles.length, 'vehicles');

      if (!vehicles || vehicles.length === 0) {
        throw new Error(this.homey.__('pair.no_vehicles_found', { region }));
      }

      return vehicles.map(vehicle => {
        // Log the vehicle object to see what fields are available
        this.log('Vehicle data:', JSON.stringify(vehicle, null, 2));

        // Use vin or fin (matches HA implementation)
        const vin = vehicle.vin || vehicle.fin || 'UNKNOWN';

        // Try different field names for model/designation
        // Check salesRelatedInformation.baumuster.baumusterDescription first (this is where it actually is!)
        const model = vehicle.salesDesignation
          || vehicle.salesRelatedInformation?.baumuster?.baumusterDescription
          || vehicle.model
          || vehicle.vehicleModel
          || 'Mercedes-Benz';

        // Try different field names for license plate
        const licensePlate = vehicle.licensePlate || vehicle.licenseplate || '';

        // Build device name - ensure it's never empty or undefined
        let deviceName = '';
        if (licensePlate) {
          deviceName = `${model} (${licensePlate})`;
        } else if (vin && vin !== 'UNKNOWN') {
          // Show last 6 chars of VIN for privacy
          const vinShort = vin.length > 6 ? vin.substring(vin.length - 6) : vin;
          deviceName = `${model} (${vinShort})`;
        } else {
          deviceName = model;
        }

        this.log('Creating device:', deviceName, 'with VIN:', vin);

        const deviceObj = {
          name: deviceName,
          data: {
            id: vin,
            vin: vin
          },
          icon: '/drivers/mercedes-vehicle/assets/icon.svg',
          capabilities: [
            'locked',
            'measure_battery',
            'measure_charge_power',
            'odometer',
            'distance_start',
            'distance_electrical',
            'driven_time_start',
            'ecoscore_accel',
            'ecoscore_const',
            'ecoscore_freewhl',
            'alarm_generic',
            'tire_pressure_bar.tire_fl',
            'tire_pressure_bar.tire_fr',
            'tire_pressure_bar.tire_rl',
            'tire_pressure_bar.tire_rr',
            'engine_running',
            'climate_active'
          ],
          store: {
            username: credentials.username,
            password: credentials.password,
            region: region,
            model: model,
            licensePlate: licensePlate,
            deviceGuid: deviceGuid,
            token: oauth.token
          },
          settings: {
            vin: vin,
            pin: '',
            polling_interval: 180
          }
        };

        this.log('Device object created:', JSON.stringify(deviceObj, null, 2));
        return deviceObj;
      });
    });
  }

  /**
   * onRepair is called when a user starts the repair flow for a device.
   * Re-authenticates credentials, refreshes the stored token, and purges
   * obsolete onoff.* / onoff_* subcapabilities so flow tags render correctly.
   */
  async onRepair(session, device) {
    this.log('Repair flow started for device:', device.getName());

    const storedRegion = device.getStoreValue('region') || 'Europe';

    // The repair view is the same custom login_credentials.html used for pairing
    // (it includes the region dropdown), so pre-select the device's current
    // region rather than guessing from the Homey's timezone.
    session.setHandler('get_default_region', async () => storedRegion);

    session.setHandler('login', async (data) => {
      this.log('Repair login attempt for:', data.username);

      // Allow the user to correct the region during repair (e.g. the account
      // was actually registered in a different region than originally stored).
      const region = Object.keys(MercedesOAuth.ENDPOINTS).includes(data.region) ? data.region : storedRegion;
      const existingDeviceGuid = device.getStoreValue('deviceGuid') || null;

      let oauth = null;
      try {
        oauth = new MercedesOAuth(this.homey, region, existingDeviceGuid);
        await oauth.login(data.username, data.password);
        this.log('Repair login successful');

        await device.setStoreValue('username', data.username);
        await device.setStoreValue('password', data.password);
        await device.setStoreValue('region', region);
        await device.setStoreValue('token', oauth.token);
        if (!existingDeviceGuid) {
          await device.setStoreValue('deviceGuid', oauth.deviceGuid);
        }

        await this._migrateVehicleCapabilities(device);

        if (device.pollInterval) {
          clearInterval(device.pollInterval);
          device.pollInterval = null;
        }
        if (device.api && typeof device.api.disconnectWebSocket === 'function') {
          try {
            await device.api.disconnectWebSocket();
          } catch (wsError) {
            this.error('WebSocket disconnect during repair failed (non-fatal):', wsError.message);
          }
        }

        if (typeof device.onInit === 'function') {
          try {
            await device.onInit();
          } catch (reinitError) {
            this.error('Device re-init after repair failed (non-fatal):', reinitError.message);
          }
        }

        await device.setAvailable().catch(() => {});

        return true;
      } catch (error) {
        this.error('Repair login failed:', error.message);
        this._persistLoginDiagnostic('repair', region, data.username, oauth, error);
        throw new Error(this._buildLoginErrorMessage(region, oauth, error));
      }
    });
  }

  /**
   * Build the message shown to the user in the pairing/repair error dialog.
   *
   * Diagnostic reports have repeatedly failed to capture any login logging, so
   * the error dialog is the one channel guaranteed to reach the user. This puts
   * the actionable facts right in front of them: a friendly hint for known
   * failures, plus which step the login reached and the underlying cause
   * (which already carries the HTTP status / network code from the OAuth layer).
   * The user can screenshot this popup instead of relying on a diagnostic report.
   */
  _buildLoginErrorMessage(region, oauth, error) {
    const rawMessage = error && error.message ? error.message : String(error);

    let hint;
    if (rawMessage.includes('418') || rawMessage.includes('status code 418')) {
      hint = 'Too many requests. Please wait 15-30 minutes and try again.';
    } else if (rawMessage.includes('403') || rawMessage.includes('status code 403')) {
      hint = 'Access denied. Please check your credentials.';
    } else if (rawMessage.includes('2FA')) {
      hint = 'Two-factor authentication is not supported. Please disable 2FA.';
    } else {
      hint = 'Login failed.';
    }

    const trace = oauth && typeof oauth.getTrace === 'function' ? oauth.getTrace() : [];
    const steps = trace
      .map((line) => line.replace(/^\S+\s/, '')) // drop the ISO timestamp prefix
      .filter((line) => line.startsWith('[Login'));
    const reached = steps.length ? steps[steps.length - 1] : 'no request was sent';

    return `${hint}\n\n— Diagnostic (please screenshot) —\nRegion: ${region}\nReached: ${reached}\nCause: ${rawMessage}`;
  }

  /**
   * Persist the last login attempt's step-by-step trace to app settings.
   *
   * Diagnostic reports from failing logins have repeatedly contained only
   * post-startup lines — the app appears to re-initialise around a failed
   * pairing attempt, discarding the stdout that held the login logging. By
   * saving the trace here it survives that restart, and MercedesMeApp re-logs
   * it on the next init so it shows up in the following diagnostic report.
   * No password is stored.
   */
  _persistLoginDiagnostic(flow, region, email, oauth, error) {
    try {
      this.homey.settings.set('lastLoginDiagnostic', {
        at: new Date().toISOString(),
        flow,
        region,
        email,
        steps: oauth && typeof oauth.getTrace === 'function' ? oauth.getTrace() : [],
        error: error && error.message ? error.message : String(error),
      });
    } catch (e) {
      this.error('Failed to persist login diagnostic (non-fatal):', e.message);
    }
  }

  /**
   * Drop deprecated onoff.engine/ignition/climate subcapabilities and
   * onoff_engine/ignition/climate intermediates, then ensure the new
   * top-level capabilities exist.
   */
  async _migrateVehicleCapabilities(device) {
    const migrations = [
      { deprecated: ['onoff.ignition', 'onoff_ignition'], current: 'ignition_on' },
      { deprecated: ['onoff.engine', 'onoff_engine'], current: 'engine_running' },
      { deprecated: ['onoff.climate', 'onoff_climate'], current: 'climate_active' },
    ];

    for (const { deprecated, current } of migrations) {
      for (const old of deprecated) {
        if (device.hasCapability(old)) {
          this.log(`[REPAIR] Removing deprecated capability ${old}`);
          await device.removeCapability(old);
        }
      }
      if (!device.hasCapability(current)) {
        this.log(`[REPAIR] Adding capability ${current}`);
        await device.addCapability(current);
      }
    }
  }
}

module.exports = MercedesVehicleDriver;
