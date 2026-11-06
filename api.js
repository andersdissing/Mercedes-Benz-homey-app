'use strict';

/**
 * The app's own Web API, under /api/app/com.mercedes.mbapi/. Routes are
 * declared in the "api" section of .homeycompose/app.json.
 *
 * Not to be confused with lib/api.js, which is the client for Mercedes' API.
 */
module.exports = {
  /**
   * GET /stats - the hourly connection timeline, 60 days of it, as JSON
   * (lib/stats-timeline.js). Not public: Homey requires a token for this
   * Homey to call it, e.g. `homey api raw --path /api/app/com.mercedes.mbapi/stats`.
   */
  async getStats({ homey }) {
    return homey.app.getStats();
  },
};
