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

      this.log('Flow cards registered successfully');
    } catch (error) {
      this.error('Error registering flow cards:', error.message);
      this.error('Stack:', error.stack);
    }
  }

  /**
   * onPair is called when a user starts pairing
   */
  async onPair(session) {
    let credentials = {};
    const region = 'Europe'; // Default to Europe region
    let oauth = null;
    let vehicles = [];
    let deviceGuid = null;

    // Handle login credentials
    session.setHandler('login', async (data) => {
      this.log('Login attempt with email:', data.username);

      credentials = {
        username: data.username,
        password: data.password
      };

      try {
        // Initialize OAuth with Europe region and generate persistent deviceGuid
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
          throw vehicleError;
        }

        return true;
      } catch (error) {
        this.error('Login or vehicle fetch failed:', error.message);

        // Provide better error messages
        if (error.message && (error.message.includes('418') || error.message.includes('status code 418'))) {
          throw new Error('Too many requests. Please wait 15-30 minutes and try again.');
        } else if (error.message && (error.message.includes('403') || error.message.includes('status code 403'))) {
          throw new Error('Access denied. Please check your credentials.');
        } else if (error.message && error.message.includes('2FA')) {
          throw new Error('Two-factor authentication is not supported. Please disable 2FA.');
        } else {
          throw new Error(error.message || this.homey.__('pair.login_failed'));
        }
      }
    });

    // Show available vehicles for pairing
    session.setHandler('list_devices', async () => {
      this.log('list_devices called, returning', vehicles.length, 'vehicles');

      if (!vehicles || vehicles.length === 0) {
        throw new Error(this.homey.__('pair.no_vehicles_found'));
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
          icon: '../../../assets/icon.svg',
          capabilities: [
            'locked',
            'measure_battery',
            'meter_power',
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
            'onoff.engine',
            'onoff.climate'
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
}

module.exports = MercedesVehicleDriver;
