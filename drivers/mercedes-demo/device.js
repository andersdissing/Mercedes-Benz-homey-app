'use strict';

const Homey = require('homey');

// Hardcoded demo data per vehicle
const DEMO_DATA = {
  DEMO_VIN_EQA_00001: {
    locked: true,
    measure_battery: 72,
    measure_charge_power: 0,
    odometer: 14523,
    distance_start: 42.3,
    distance_electrical: 38.1,
    driven_time_start: 35,
    average_speed: 72,
    ecoscore_accel: 80,
    ecoscore_const: 75,
    ecoscore_freewhl: 90,
    alarm_generic: false,
    measure_range_electric: 265,
    measure_range_liquid: 0,
    measure_fuel: 0,
    measure_adblue_level: 0,
    'onoff.ignition': false,
    measure_oil_level: 0,
    text_charging_status: 'Unplugged',
    text_charge_program: 'Home',
    measure_max_soc: 80,
    text_end_charge_time: '-',
    window_sunroof: 'Closed',
    text_departure_time: '07:30',
    text_departure_time_mode: 'Weekly',
    measure_latitude: 55.6761,
    measure_longitude: 12.5683,
    measure_heading: 180,
    text_geofence_last_event: '-',
    text_geofence_last_zone: '-',
    time_geofence_last_event: '-',
    'tire_pressure_bar.tire_fl': 2.4,
    'tire_pressure_bar.tire_fr': 2.4,
    'tire_pressure_bar.tire_rl': 2.5,
    'tire_pressure_bar.tire_rr': 2.5,
    window_front_left: 'Closed',
    window_front_right: 'Closed',
    window_rear_left: 'Closed',
    window_rear_right: 'Closed',
    door_front_left: 'Closed',
    door_front_right: 'Closed',
    door_rear_left: 'Closed',
    door_rear_right: 'Closed',
    door_trunk: 'Closed',
    door_hood: 'Closed',
    parking_brake_engaged: true,
    alarm_theft: false,
    measure_service_days: 142,
    measure_battery_temperature: 22,
    onoff_precond: false,
    onoff_auxheat: false,
    onoff_remote_start: false,
    theft_system_armed: true,
    'onoff.engine': false,
    'onoff.climate': false,
  },
  DEMO_VIN_EQB_00002: {
    locked: false,
    measure_battery: 45,
    measure_charge_power: 11.0,
    odometer: 32180,
    distance_start: 128.7,
    distance_electrical: 95.2,
    driven_time_start: 98,
    average_speed: 85,
    ecoscore_accel: 65,
    ecoscore_const: 70,
    ecoscore_freewhl: 85,
    alarm_generic: false,
    measure_range_electric: 148,
    measure_range_liquid: 0,
    measure_fuel: 0,
    measure_adblue_level: 0,
    'onoff.ignition': false,
    measure_oil_level: 0,
    text_charging_status: 'Charging',
    text_charge_program: 'Default',
    measure_max_soc: 100,
    text_end_charge_time: '23:45',
    window_sunroof: 'Closed',
    text_departure_time: '08:00',
    text_departure_time_mode: 'Single',
    measure_latitude: 55.6867,
    measure_longitude: 12.5701,
    measure_heading: 45,
    text_geofence_last_event: 'ENTER',
    text_geofence_last_zone: 'Home',
    time_geofence_last_event: '24 Mar 2026 09:15',
    'tire_pressure_bar.tire_fl': 2.3,
    'tire_pressure_bar.tire_fr': 2.3,
    'tire_pressure_bar.tire_rl': 2.4,
    'tire_pressure_bar.tire_rr': 2.4,
    window_front_left: 'Closed',
    window_front_right: 'Closed',
    window_rear_left: 'Closed',
    window_rear_right: 'Closed',
    door_front_left: 'Open',
    door_front_right: 'Closed',
    door_rear_left: 'Closed',
    door_rear_right: 'Closed',
    door_trunk: 'Open',
    door_hood: 'Closed',
    parking_brake_engaged: true,
    alarm_theft: false,
    measure_service_days: 87,
    measure_battery_temperature: 28,
    onoff_precond: false,
    onoff_auxheat: false,
    onoff_remote_start: false,
    theft_system_armed: false,
    'onoff.engine': false,
    'onoff.climate': false,
  },
};

class MercedesDemoDevice extends Homey.Device {
  async onInit() {
    this.log('Mercedes Demo device initializing...');

    const vin = this.getData().vin;
    const demoData = DEMO_DATA[vin] || DEMO_DATA.DEMO_VIN_EQA_00001;

    // Set all capability values from hardcoded data
    for (const [capability, value] of Object.entries(demoData)) {
      try {
        if (this.hasCapability(capability)) {
          await this.setCapabilityValue(capability, value);
        }
      } catch (e) {
        this.log(`[DEMO] Could not set ${capability}: ${e.message}`);
      }
    }

    // Register capability listeners that just toggle the value locally
    this.registerCapabilityListener('locked', async (value) => {
      this.log(`[DEMO] Lock toggled to: ${value}`);
      return true;
    });

    this.registerCapabilityListener('onoff.engine', async (value) => {
      this.log(`[DEMO] Engine toggled to: ${value}`);
      return true;
    });

    this.registerCapabilityListener('onoff.climate', async (value) => {
      this.log(`[DEMO] Climate toggled to: ${value}`);
      return true;
    });

    await this.setAvailable();
    this.log('Mercedes Demo device initialized successfully');
  }

  async onDeleted() {
    this.log('Mercedes Demo device has been deleted');
  }
}

module.exports = MercedesDemoDevice;
