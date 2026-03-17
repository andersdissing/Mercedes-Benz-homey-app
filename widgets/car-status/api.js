'use strict';

module.exports = {
  async getStatus({ homey, query }) {
    return homey.app.getDeviceStatus(query.deviceId);
  },
  async getDevices({ homey }) {
    return homey.app.getDeviceList();
  },
};
