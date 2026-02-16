'use strict';

module.exports = {
  async getStatus({ homey, query }) {
    return homey.app.getDeviceStatus(query.deviceId);
  },
};
