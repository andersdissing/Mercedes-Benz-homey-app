'use strict';

const Homey = require('homey');

class MercedesMeApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Mercedes-Benz app has been initialized');
    // Flow cards are registered in driver.js (SDK3 best practice)
  }

  /**
   * Get list of available devices for widget car selector
   * @returns {Array} List of devices with id and name
   */
  async getDeviceList() {
    const driver = this.homey.drivers.getDriver('mercedes-vehicle');
    const devices = driver.getDevices();
    return devices.map(d => ({
      id: d.getData().id,
      name: d.getName(),
    }));
  }

  /**
   * Get device status for widget API
   * @param {string} deviceId - The Homey device ID to get status for
   * @returns {object} Device status object
   */
  async getDeviceStatus(deviceId) {
    const driver = this.homey.drivers.getDriver('mercedes-vehicle');
    const devices = driver.getDevices();

    let device;
    if (deviceId) {
      device = devices.find(d => d.getData().id === deviceId);
    }
    if (!device) {
      device = devices[0];
    }

    if (!device) {
      throw new Error('Device not found');
    }

    const getValue = (cap) => {
      try {
        return device.getCapabilityValue(cap);
      } catch (e) {
        return null;
      }
    };

    return {
      locked: getValue('locked'),
      battery: getValue('measure_battery'),
      fuel: getValue('measure_fuel'),
      rangeElectric: getValue('measure_range_electric'),
      rangeLiquid: getValue('measure_range_liquid'),
      doors: {
        frontLeft: getValue('door_front_left'),
        frontRight: getValue('door_front_right'),
        rearLeft: getValue('door_rear_left'),
        rearRight: getValue('door_rear_right'),
        trunk: getValue('door_trunk'),
        hood: getValue('door_hood'),
      },
      windows: {
        frontLeft: getValue('window_front_left'),
        frontRight: getValue('window_front_right'),
        rearLeft: getValue('window_rear_left'),
        rearRight: getValue('window_rear_right'),
      },
      sunroof: getValue('window_sunroof'),
      chargingStatus: getValue('text_charging_status'),
      engineRunning: getValue('onoff.engine'),
      climateOn: getValue('onoff.climate'),
      model: device.getName(),
      pollingInterval: (device.getSetting('polling_interval') || 180) * 1000,
    };
  }
}

module.exports = MercedesMeApp;
