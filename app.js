'use strict';

const Homey = require('homey');
const axios = require('axios');

class MercedesMeApp extends Homey.App {

  async onInit() {
    this.log('Mercedes-Benz app has been initialized');
    this._uuidToDataId = {};
    await this._buildUuidMap();
  }

  async _buildUuidMap() {
    try {
      const token = await this.homey.api.getOwnerApiToken();
      const baseUrl = await this.homey.api.getLocalUrl();
      const response = await axios.get(`${baseUrl}/api/manager/devices/device/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const devices = response.data;
      this._uuidToDataId = {};
      for (const device of Object.values(devices)) {
        if (device.driverId?.includes('com.mercedes.mbapi')) {
          this._uuidToDataId[device.id] = device.data.id;
          this.log(`[uuid-map] ${device.id} → ${device.data.id} (${device.name})`);
        }
      }
    } catch (e) {
      this.log(`[uuid-map] failed: ${e.message}`);
    }
  }

  _getDevices() {
    const devices = [];
    for (const driverId of ['mercedes-vehicle', 'mercedes-demo']) {
      try { devices.push(...this.homey.drivers.getDriver(driverId).getDevices()); } catch (e) {}
    }
    return devices;
  }

  async getDeviceList() {
    return this._getDevices().map(d => ({ id: d.getData().id, name: d.getName() }));
  }

  async getDeviceStatus(deviceId) {
    if (!deviceId) return { error: 'not_configured' };

    // Resolve Homey UUID → pairing data ID (VIN / dummy ID)
    let dataId = this._uuidToDataId[deviceId] || deviceId;
    let device = this._getDevices().find(d => d.getData().id === dataId);

    // If not found, the map may be stale (device added after app init) — rebuild and retry
    if (!device) {
      await this._buildUuidMap();
      dataId = this._uuidToDataId[deviceId] || deviceId;
      device = this._getDevices().find(d => d.getData().id === dataId);
    }

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
