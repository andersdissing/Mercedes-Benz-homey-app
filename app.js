'use strict';

const Homey = require('homey');

class MercedesMeApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Mercedes-Benz app has been initialized');

    // Register flow cards
    this._registerFlowCards();
  }

  /**
   * Register all flow card listeners
   */
  _registerFlowCards() {
    try {
      // ==================== Action Flow Cards ====================

      const lockVehicleAction = this.homey.flow.getActionCard('lock_vehicle');
      lockVehicleAction.registerRunListener(async (args) => {
        return args.device.lockVehicleAction();
      });

      const unlockVehicleAction = this.homey.flow.getActionCard('unlock_vehicle');
      unlockVehicleAction.registerRunListener(async (args) => {
        return args.device.unlockVehicleAction();
      });

      const startClimateAction = this.homey.flow.getActionCard('start_climate');
      startClimateAction.registerRunListener(async (args) => {
        return args.device.startClimateAction();
      });

      const stopClimateAction = this.homey.flow.getActionCard('stop_climate');
      stopClimateAction.registerRunListener(async (args) => {
        return args.device.stopClimateAction();
      });

      const flashLightsAction = this.homey.flow.getActionCard('flash_lights');
      flashLightsAction.registerRunListener(async (args) => {
        return args.device.flashLightsAction();
      });

      const startEngineAction = this.homey.flow.getActionCard('start_engine');
      startEngineAction.registerRunListener(async (args) => {
        return args.device.startEngineAction();
      });

      const stopEngineAction = this.homey.flow.getActionCard('stop_engine');
      stopEngineAction.registerRunListener(async (args) => {
        return args.device.stopEngineAction();
      });

      const openWindowsAction = this.homey.flow.getActionCard('open_windows');
      openWindowsAction.registerRunListener(async (args) => {
        return args.device.openWindowsAction();
      });

      const closeWindowsAction = this.homey.flow.getActionCard('close_windows');
      closeWindowsAction.registerRunListener(async (args) => {
        return args.device.closeWindowsAction();
      });

      const openSunroofAction = this.homey.flow.getActionCard('open_sunroof');
      openSunroofAction.registerRunListener(async (args) => {
        return args.device.openSunroofAction();
      });

      const closeSunroofAction = this.homey.flow.getActionCard('close_sunroof');
      closeSunroofAction.registerRunListener(async (args) => {
        return args.device.closeSunroofAction();
      });

      const tiltSunroofAction = this.homey.flow.getActionCard('tilt_sunroof');
      tiltSunroofAction.registerRunListener(async (args) => {
        return args.device.tiltSunroofAction();
      });

      const sendRouteAction = this.homey.flow.getActionCard('send_route');
      sendRouteAction.registerRunListener(async (args) => {
        return args.device.sendRouteAction(args.title, args.latitude, args.longitude);
      });

      const configureMaxSocAction = this.homey.flow.getActionCard('configure_max_soc');
      configureMaxSocAction.registerRunListener(async (args) => {
        return args.device.configureMaxSocAction(args.max_soc, args.charge_program);
      });

      const startPrecondAction = this.homey.flow.getActionCard('start_precond');
      startPrecondAction.registerRunListener(async (args) => {
        return args.device.startPrecondAction();
      });

      const stopPrecondAction = this.homey.flow.getActionCard('stop_precond');
      stopPrecondAction.registerRunListener(async (args) => {
        return args.device.stopPrecondAction();
      });

      const configureDepartureTimeAction = this.homey.flow.getActionCard('configure_departure_time');
      configureDepartureTimeAction.registerRunListener(async (args) => {
        return args.device.configureDepartureTimeAction(args.hour, args.minute, args.mode);
      });

      const configureTemperatureAction = this.homey.flow.getActionCard('configure_temperature');
      configureTemperatureAction.registerRunListener(async (args) => {
        return args.device.configureTemperatureAction(args.temperature);
      });

      const configureSeatHeatingAction = this.homey.flow.getActionCard('configure_seat_heating');
      configureSeatHeatingAction.registerRunListener(async (args) => {
        return args.device.configureSeatHeatingAction(args.front_left, args.front_right, args.rear_left, args.rear_right);
      });

      const soundHornAction = this.homey.flow.getActionCard('sound_horn');
      soundHornAction.registerRunListener(async (args) => {
        return args.device.soundHornAction(args.mode);
      });

      // ==================== Condition Flow Cards ====================

      const isLockedCondition = this.homey.flow.getConditionCard('is_locked');
      isLockedCondition.registerRunListener(async (args) => {
        return args.device.isLocked();
      });

      const isEngineRunningCondition = this.homey.flow.getConditionCard('is_engine_running');
      isEngineRunningCondition.registerRunListener(async (args) => {
        return args.device.isEngineRunning();
      });

      const isChargingCondition = this.homey.flow.getConditionCard('is_charging');
      isChargingCondition.registerRunListener(async (args) => {
        return args.device.isCharging();
      });

      const windowsClosedCondition = this.homey.flow.getConditionCard('windows_closed');
      windowsClosedCondition.registerRunListener(async (args) => {
        return args.device.windowsClosed();
      });

      const tirePressureOkCondition = this.homey.flow.getConditionCard('tire_pressure_ok');
      tirePressureOkCondition.registerRunListener(async (args) => {
        return args.device.tirePressureOk();
      });

      const isPreconditioningCondition = this.homey.flow.getConditionCard('is_preconditioning');
      isPreconditioningCondition.registerRunListener(async (args) => {
        return args.device.isPreconditioning();
      });

      const anyDoorOpenCondition = this.homey.flow.getConditionCard('any_door_open');
      anyDoorOpenCondition.registerRunListener(async (args) => {
        return args.device.anyDoorOpen();
      });

      const warningActiveCondition = this.homey.flow.getConditionCard('warning_active');
      warningActiveCondition.registerRunListener(async (args) => {
        return args.device.warningActive();
      });

      const sunroofOpenCondition = this.homey.flow.getConditionCard('sunroof_open');
      sunroofOpenCondition.registerRunListener(async (args) => {
        return args.device.sunroofOpen();
      });

      const batteryLevelCondition = this.homey.flow.getConditionCard('battery_level');
      batteryLevelCondition.registerRunListener(async (args) => {
        return args.device.batteryLevelAbove(args.threshold);
      });

      const isAuxHeatActiveCondition = this.homey.flow.getConditionCard('is_auxheat_active');
      isAuxHeatActiveCondition.registerRunListener(async (args) => {
        return args.device.isAuxHeatActive();
      });

      const isInGeofenceCondition = this.homey.flow.getConditionCard('is_in_geofence');
      isInGeofenceCondition.registerRunListener(async (args) => {
        return args.device.isInGeofence(args.zone_name);
      });

      this.log('Flow cards registered successfully');
    } catch (error) {
      this.error('Error registering flow cards:', error.message);
      this.log('Flow cards will be unavailable, but app will continue to run');
    }
  }
}

module.exports = MercedesMeApp;
