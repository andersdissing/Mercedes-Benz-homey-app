'use strict';

module.exports = {
  async getStatus({ homey }) {
    return homey.app.getDeviceStatus(null);
  },
  async getDeviceStatus({ homey, params }) {
    return homey.app.getDeviceStatus(params.deviceId);
  }, // path: /status/:deviceId
  async getDevices({ homey }) {
    return homey.app.getDeviceList();
  },
};
