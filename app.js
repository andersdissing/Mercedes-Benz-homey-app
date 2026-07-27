'use strict';

const Homey = require('homey');
const { installRedactedLogging } = require('./lib/log-redactor');

class MercedesMeApp extends Homey.App {

  async onInit() {
    // Must run before any other logging: lib/api.js, lib/websocket.js and
    // lib/oauth.js all log via this.homey.app.log(), so wrapping it here
    // keeps VIN/coordinates/zone names out of user-submitted diagnostic
    // reports app-wide, not just for this class's own log calls.
    installRedactedLogging(this);

    this.log('Mercedes-Benz app has been initialized');
    this._installCrashHandlers();
    this._logLastCrash();
    this._logLastLoginDiagnostic();
  }

  /**
   * Capture the reason the app process dies unexpectedly.
   *
   * Diagnostic reports for the login failures have shown the app re-initialising
   * mid-pairing (two "app has been initialized" lines minutes apart in a single
   * report), which wipes the stdout that held the login trace and bounces the
   * pairing wizard back to the login page ("keeps going back to the same login
   * page over and over"). An unhandled promise rejection crashes the Node
   * process by default, so it is the prime suspect.
   *
   * These handlers persist the failure to settings and re-log it on the next
   * start, so the following diagnostic report finally shows *why* the app died.
   * They are also intentionally non-fatal: swallowing a stray rejection keeps
   * the app alive and should stop the restart loop.
   */
  _installCrashHandlers() {
    if (MercedesMeApp._crashHandlersInstalled) return;
    MercedesMeApp._crashHandlersInstalled = true;

    process.on('unhandledRejection', (reason) => {
      this._persistCrash('unhandledRejection', reason);
    });
    process.on('uncaughtException', (err) => {
      this._persistCrash('uncaughtException', err);
    });
  }

  /**
   * Record a crash to settings (best-effort — never throws). No credentials are
   * involved here; only the error message and a truncated stack are stored.
   */
  _persistCrash(type, err) {
    try {
      const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
      this.error(`Captured ${type}:`, e.message);

      let stack = e.stack || '';
      if (stack.length > 1500) {
        stack = `${stack.slice(0, 1500)}…[truncated]`;
      }

      this.homey.settings.set('lastCrash', {
        at: new Date().toISOString(),
        type,
        message: e.message,
        stack,
      });
    } catch (persistErr) {
      // Diagnostics must never make a bad situation worse.
    }
  }

  /**
   * Re-log the most recently captured crash, if any, so it appears in the next
   * diagnostic report. Best-effort: never let diagnostics break startup.
   */
  _logLastCrash() {
    try {
      const crash = this.homey.settings.get('lastCrash');
      if (!crash) return;

      this.log('----- Last captured crash (from a previous run) -----');
      this.log(`When: ${crash.at} | Type: ${crash.type}`);
      this.log(`Message: ${crash.message}`);
      if (crash.stack) this.log(`Stack: ${crash.stack}`);
      this.log('----- End last captured crash -----');
    } catch (e) {
      this.error('Failed to log last crash (non-fatal):', e.message);
    }
  }

  /**
   * Re-log the most recent failed login attempt's trace, if one was persisted.
   *
   * Diagnostic reports for the login failures have consistently arrived with
   * only these startup lines and none of the login logging — the app appears to
   * re-initialise around the failed pairing attempt, so the stdout that held the
   * login trace is already gone by the time the report is captured. The driver
   * persists that trace to settings; surfacing it here means the very next
   * diagnostic report finally contains it. Best-effort: never let diagnostics
   * break startup.
   */
  _logLastLoginDiagnostic() {
    try {
      const diag = this.homey.settings.get('lastLoginDiagnostic');
      if (!diag) return;

      this.log('----- Last login attempt diagnostic (from a previous attempt) -----');
      this.log(`When: ${diag.at} | Flow: ${diag.flow} | Region: ${diag.region} | Account: ${diag.email}`);
      this.log(`Final error: ${diag.error}`);
      if (Array.isArray(diag.steps) && diag.steps.length) {
        this.log('Steps:');
        diag.steps.forEach((step) => this.log(`  ${step}`));
      } else {
        this.log('Steps: (none captured — login failed before or at the first request)');
      }
      this.log('----- End last login attempt diagnostic -----');
    } catch (e) {
      this.error('Failed to log last login diagnostic (non-fatal):', e.message);
    }
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
    let device = this._getDevices().find(d => d.__id === deviceId || d.getData().id === deviceId);

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
      charging: getValue('onoff_charging'),
      chargingStatus: getValue('text_charging_status'),
      engineRunning: getValue('engine_running'),
      climateOn: getValue('climate_active'),
      model: device.getName(),
      pollingInterval: (device.getSetting('polling_interval') || 180) * 1000,
    };
  }
}

module.exports = MercedesMeApp;
