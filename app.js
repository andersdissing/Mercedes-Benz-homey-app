'use strict';

const Homey = require('homey');

class MercedesMeApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Mercedes-Benz app has been initialized');

    //  Note: Flow cards are not working yet - build system issue
    // TODO: Fix flow card registration once Homey Compose is properly configured
    // this._registerFlowCards();
  }

  /**
   * Register all flow card listeners
   */
  _registerFlowCards() {
    try {
      // Action flow cards
      const lockVehicleAction = this.homey.flow.getActionCard('lock_vehicle');
      lockVehicleAction.registerRunListener(async (args) => {
        await args.device.lockVehicle();
        return true;
      });

      const unlockVehicleAction = this.homey.flow.getActionCard('unlock_vehicle');
      unlockVehicleAction.registerRunListener(async (args) => {
        await args.device.unlockVehicle();
        return true;
      });

      const startClimateAction = this.homey.flow.getActionCard('start_climate');
      startClimateAction.registerRunListener(async (args) => {
        await args.device.startClimate();
        return true;
      });

      const stopClimateAction = this.homey.flow.getActionCard('stop_climate');
      stopClimateAction.registerRunListener(async (args) => {
        await args.device.stopClimate();
        return true;
      });

      const flashLightsAction = this.homey.flow.getActionCard('flash_lights');
      flashLightsAction.registerRunListener(async (args) => {
        await args.device.flashLights();
        return true;
      });

      const startEngineAction = this.homey.flow.getActionCard('start_engine');
      startEngineAction.registerRunListener(async (args) => {
        await args.device.startEngine();
        return true;
      });

      const stopEngineAction = this.homey.flow.getActionCard('stop_engine');
      stopEngineAction.registerRunListener(async (args) => {
        await args.device.stopEngine();
        return true;
      });

      // Condition flow cards
      const isLockedCondition = this.homey.flow.getConditionCard('is_locked');
      isLockedCondition.registerRunListener(async (args) => {
        return args.device.getCapabilityValue('locked');
      });

      const isEngineRunningCondition = this.homey.flow.getConditionCard('is_engine_running');
      isEngineRunningCondition.registerRunListener(async (args) => {
        return args.device.getCapabilityValue('onoff.engine');
      });

      const windowsClosedCondition = this.homey.flow.getConditionCard('windows_closed');
      windowsClosedCondition.registerRunListener(async (args) => {
        return args.device.areWindowsClosed();
      });

      this.log('Flow cards registered');
    } catch (error) {
      this.error('Error registering flow cards:', error.message);
      this.log('Flow cards will be unavailable, but app will continue to run');
    }
  }
}

module.exports = MercedesMeApp;
