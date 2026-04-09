'use strict';

const Homey = require('homey');

class MercedesMeApp extends Homey.App {

  async onInit() {
    this.log('Mercedes-Benz app has been initialized');
  }

  _getDevices() {
    const devices = [];
    for (const driverId of ['mercedes-vehicle']) {
      try { devices.push(...this.homey.drivers.getDriver(driverId).getDevices()); } catch (e) {}
    }
    return devices;
  }

  async getDeviceList() {
    return this._getDevices().map(d => ({ id: d.getData().id, name: d.getName() }));
  }

  async getDeviceStatus(deviceId) {
    if (!deviceId) return { error: 'not_configured' };

    // Match by Homey UUID (widget device picker) or VIN/data.id (backward compat)
    let device = this._getDevices().find(d => d.id === deviceId || d.getData().id === deviceId);

    if (!device) return { error: 'not_configured' };

    const getValue = (cap) => {
      try { return device.getCapabilityValue(cap); } catch (e) { return null; }
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
