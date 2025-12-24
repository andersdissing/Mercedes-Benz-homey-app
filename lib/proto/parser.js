'use strict';

const protobuf = require('protobufjs');
const path = require('path');

/**
 * Mercedes Protocol Buffer Parser
 * Parses binary protobuf responses from Mercedes widget API
 */
class ProtoParser {
  constructor(homey) {
    this.homey = homey;
    this.root = null;
    this.commandRoot = null;  // Separate root for commands
    this.VEPUpdate = null;
    this.VEPUpdatesByVIN = null;
    this.PushMessage = null;
    this.ClientMessage = null;
    this.CommandClientMessage = null;  // ClientMessage from client.proto
    this.CommandRequest = null;
    this.initialized = false;
  }

  /**
   * Initialize the protobuf parser by loading the .proto schema
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Load vehicle-events.proto for parsing incoming WebSocket messages
      const eventsProtoPath = path.join(__dirname, 'vehicle-events.proto');
      this.homey.app.log('Loading protobuf schema from:', eventsProtoPath);
      this.root = await protobuf.load(eventsProtoPath);

      // Get message types for receiving data
      this.VEPUpdate = this.root.lookupType('proto.VEPUpdate');
      this.VEPUpdatesByVIN = this.root.lookupType('proto.VEPUpdatesByVIN');
      this.PushMessage = this.root.lookupType('proto.PushMessage');
      this.ClientMessage = this.root.lookupType('proto.ClientMessage');

      // Load client.proto for creating command messages
      const clientProtoPath = path.join(__dirname, 'client.proto');
      this.homey.app.log('Loading command protobuf schema from:', clientProtoPath);
      this.commandRoot = await protobuf.load(clientProtoPath);

      // Get message types for sending commands
      this.CommandClientMessage = this.commandRoot.lookupType('proto.ClientMessage');
      this.CommandRequest = this.commandRoot.lookupType('proto.CommandRequest');

      this.initialized = true;
      this.homey.app.log('Protobuf parser initialized successfully (events + commands)');
    } catch (error) {
      this.homey.app.error('Failed to initialize protobuf parser:', error.message);
      this.homey.app.error('Error stack:', error.stack);
      throw error;
    }
  }

  /**
   * Parse binary protobuf data into VEPUpdate message
   * @param {Buffer} buffer - Binary protobuf data from Mercedes API
   * @returns {Object} Parsed VEPUpdate message
   */
  parseVEPUpdate(buffer) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized. Call initialize() first.');
    }

    try {
      // Decode the binary buffer
      const message = this.VEPUpdate.decode(buffer);

      // Convert to plain JavaScript object
      const object = this.VEPUpdate.toObject(message, {
        longs: Number,  // Convert long values to JavaScript numbers
        enums: String,  // Convert enum values to strings
        bytes: String,  // Convert bytes to strings
        defaults: true, // Include default values (important for zero values!)
        arrays: true,   // Always include arrays even if empty
        objects: true,  // Always include objects even if empty
        oneofs: true    // Include virtual oneof fields
      });

      return object;
    } catch (error) {
      this.homey.app.error('Failed to parse protobuf data:', error.message);
      this.homey.app.error('Error stack:', error.stack);
      throw error;
    }
  }

  /**
   * Extract vehicle data from VEPUpdate message and convert to simple key-value format
   * @param {Object} vepUpdate - Parsed VEPUpdate message
   * @returns {Object} Vehicle data in simple format
   */
  extractVehicleData(vepUpdate) {
    if (!vepUpdate || !vepUpdate.attributes) {
      this.homey.app.error('Invalid VEPUpdate message: no attributes found');
      return {};
    }

    const vehicleData = {
      vin: vepUpdate.vin,
      timestamp: vepUpdate.emitTimestampInMs || vepUpdate.emitTimestamp,  // camelCase!
      full_update: vepUpdate.fullUpdate  // camelCase!
    };

    // Extract all attributes from the map
    // Note: protobufjs converts snake_case to camelCase (int_value -> intValue)
    for (const [key, attribute] of Object.entries(vepUpdate.attributes)) {
      // Get the actual value based on the attribute_type oneof field
      let value = null;
      let unit = null;

      // Special handling for tire pressure - convert kPa to bar
      // Mercedes returns tire pressure in kPa (e.g., 340 kPa)
      // Custom tire_pressure_bar capability uses bar units
      // Conversion: 1 bar = 100 kPa, so 340 kPa = 3.4 bar
      if (key.includes('tirepressure')) {
        if (attribute.displayValue !== undefined && attribute.displayValue !== null && attribute.displayValue !== "") {
          // Parse the display value which is in kPa (e.g., "340" kPa)
          const match = attribute.displayValue.match(/[\d.]+/);
          if (match) {
            const kPa = parseFloat(match[0]);
            value = kPa / 100; // Convert kPa to bar (340 kPa = 3.4 bar)
          } else {
            value = attribute.displayValue;
          }
        }
      } else {
        // For other attributes, use the standard priority
        if (attribute.intValue !== undefined && attribute.intValue !== null) {
          value = attribute.intValue;
        } else if (attribute.boolValue !== undefined && attribute.boolValue !== null) {
          value = attribute.boolValue;
        } else if (attribute.stringValue !== undefined && attribute.stringValue !== null) {
          value = attribute.stringValue;
        } else if (attribute.doubleValue !== undefined && attribute.doubleValue !== null) {
          value = attribute.doubleValue;
        } else if (attribute.displayValue !== undefined && attribute.displayValue !== null && attribute.displayValue !== "") {
          value = attribute.displayValue;
        }
      }

      // Extract unit information if available
      if (attribute.pressureUnit !== undefined) {
        unit = attribute.pressureUnit;
      } else if (attribute.temperatureUnit !== undefined) {
        unit = attribute.temperatureUnit;
      }

      // Log tire pressure values for debugging
      if (key.includes('tirepressure')) {
        this.homey.app.log(`[PARSER] ${key}:`);
        this.homey.app.log(`  - intValue: ${attribute.intValue}`);
        this.homey.app.log(`  - doubleValue: ${attribute.doubleValue}`);
        this.homey.app.log(`  - displayValue: "${attribute.displayValue}"`);
        this.homey.app.log(`  - pressureUnit: ${attribute.pressureUnit}`);
        this.homey.app.log(`  - selected value: ${value}`);
      }

      // Store the value with the attribute key
      if (value !== null && value !== undefined) {
        vehicleData[key] = value;
      }

      // Also store display value separately if available
      if (attribute.displayValue && attribute.displayValue !== "" && attribute.displayValue !== value) {
        vehicleData[`${key}_display`] = attribute.displayValue;
      }

      // Store unit if available
      if (unit) {
        vehicleData[`${key}_unit`] = unit;
      }
    }

    this.homey.app.log(`Extracted ${Object.keys(vehicleData).length} vehicle attributes`);
    return vehicleData;
  }

  /**
   * Parse WebSocket PushMessage
   * @param {Buffer} buffer - Binary protobuf data from WebSocket
   * @returns {Object} Parsed PushMessage with msg type
   */
  parsePushMessage(buffer) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized. Call initialize() first.');
    }

    try {
      // Decode the binary buffer
      const message = this.PushMessage.decode(buffer);

      // Convert to plain JavaScript object
      const object = this.PushMessage.toObject(message, {
        longs: Number,
        enums: String,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true
      });

      // Determine which oneof field is set
      // Log all keys in the object for debugging
      this.homey.app.log('[PARSER] Decoded message keys:', Object.keys(object).join(', '));

      // DEBUG: Log full decoded structure
      try {
        const debugJson = JSON.stringify(object, null, 2);
        if (debugJson.length < 5000) {
          this.homey.app.log('[PARSER] Full decoded message:', debugJson);
        } else {
          this.homey.app.log('[PARSER] Full decoded message (truncated):', debugJson.substring(0, 5000) + '...');
        }
      } catch (e) {
        this.homey.app.log('[PARSER] Could not stringify message:', e.message);
      }

      // Check for empty messages (no data fields)
      const hasData = Object.keys(object).filter(k => k !== 'msg').length > 0;
      if (!hasData) {
        this.homey.app.log('[PARSER] WARNING: Message has no data fields!');
      }

      // Check each possible field in the oneof msg
      if (object.vepUpdates) {
        object.msg = 'vepUpdates';
      } else if (object.debugMessage) {
        object.msg = 'debugMessage';
      } else if (object.apptwinCommandStatusUpdatesByVin) {
        object.msg = 'apptwin_command_status_updates_by_vin';
      } else if (object.assignedVehicles) {
        object.msg = 'assigned_vehicles';
      } else if (object.apptwinPendingCommandRequest) {
        object.msg = 'apptwin_pending_command_request';
      } else if (object.serviceStatusUpdates) {
        object.msg = 'service_status_updates';
      } else if (object.userDataUpdate) {
        object.msg = 'user_data_update';
      }

      return object;
    } catch (error) {
      this.homey.app.error('Failed to parse PushMessage:', error.message);
      throw error;
    }
  }

  /**
   * Parse WebSocket VEPUpdatesByVIN message (sent inside debugMessage)
   * @param {Buffer} buffer - Binary protobuf data from WebSocket debugMessage
   * @returns {Object} Parsed VEPUpdatesByVIN object
   */
  parseVepUpdatesByVin(buffer) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized. Call initialize() first.');
    }

    try {
      // Decode the binary buffer
      const message = this.VEPUpdatesByVIN.decode(buffer);

      // Convert to plain JavaScript object
      const object = this.VEPUpdatesByVIN.toObject(message, {
        longs: Number,
        enums: String,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true
      });

      this.homey.app.log('[PARSER] VEPUpdatesByVIN parsed - sequence:', object.sequenceNumber);

      return object;
    } catch (error) {
      this.homey.app.error('Failed to parse VEPUpdatesByVIN:', error.message);
      throw error;
    }
  }

  /**
   * Create acknowledgment message for VEPUpdatesByVIN
   * @param {Number} sequenceNumber - Sequence number from vepUpdates message
   * @returns {Buffer} Serialized acknowledgment message
   */
  createAcknowledgeVepUpdatesByVin(sequenceNumber) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized');
    }

    try {
      const ackMessage = this.ClientMessage.create({
        acknowledgeVepUpdatesByVin: {
          sequenceNumber: sequenceNumber
        }
      });

      return Buffer.from(this.ClientMessage.encode(ackMessage).finish());
    } catch (error) {
      this.homey.app.error('Failed to create ACK message:', error.message);
      throw error;
    }
  }

  /**
   * Create acknowledgment for AppTwin command status update
   */
  createAcknowledgeAppTwinCommandStatusUpdateByVin(sequenceNumber) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized');
    }

    try {
      const ackMessage = this.ClientMessage.create({
        acknowledgeApptwinCommandStatusUpdateByVin: {
          sequenceNumber: sequenceNumber
        }
      });

      return Buffer.from(this.ClientMessage.encode(ackMessage).finish());
    } catch (error) {
      this.homey.app.error('Failed to create AppTwin ACK:', error.message);
      throw error;
    }
  }

  /**
   * Create acknowledgment for service status update
   */
  createAcknowledgeServiceStatusUpdate(sequenceNumber) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized');
    }

    try {
      const ackMessage = this.ClientMessage.create({
        acknowledgeServiceStatusUpdate: {
          sequenceNumber: sequenceNumber
        }
      });

      return Buffer.from(this.ClientMessage.encode(ackMessage).finish());
    } catch (error) {
      this.homey.app.error('Failed to create service status ACK:', error.message);
      throw error;
    }
  }

  /**
   * Create acknowledgment for user data update
   */
  createAcknowledgeUserDataUpdate(sequenceNumber) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized');
    }

    try {
      const ackMessage = this.ClientMessage.create({
        acknowledgeUserDataUpdate: {
          sequenceNumber: sequenceNumber
        }
      });

      return Buffer.from(this.ClientMessage.encode(ackMessage).finish());
    } catch (error) {
      this.homey.app.error('Failed to create user data ACK:', error.message);
      throw error;
    }
  }

  // ==================== COMMAND MESSAGE BUILDERS ====================

  /**
   * Generate a UUID v4 for command request_id
   */
  _generateRequestId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Create a ClientMessage with CommandRequest
   * @param {String} vin - Vehicle VIN
   * @param {Object} commandData - Command-specific data (e.g., {doorsLock: {}})
   * @returns {Object} {buffer: Buffer, requestId: String} - Serialized message and requestId for tracking
   */
  _createCommandMessage(vin, commandData) {
    if (!this.initialized) {
      throw new Error('Protobuf parser not initialized');
    }

    try {
      const requestId = this._generateRequestId();

      const message = this.CommandClientMessage.create({
        commandRequest: {
          vin: vin,
          requestId: requestId,
          ...commandData
        }
      });

      this.homey.app.log('[PARSER] Created command message:', JSON.stringify(commandData), 'requestId:', requestId);

      const buffer = Buffer.from(this.CommandClientMessage.encode(message).finish());
      return { buffer, requestId };
    } catch (error) {
      this.homey.app.error('Failed to create command message:', error.message);
      this.homey.app.error('Error stack:', error.stack);
      throw error;
    }
  }

  /**
   * Create lock vehicle command
   * @param {String} vin - Vehicle VIN
   * @returns {Buffer} Serialized command message
   */
  createLockCommand(vin) {
    return this._createCommandMessage(vin, {
      doorsLock: {
        doors: []  // Empty array locks all doors
      }
    });
  }

  /**
   * Create unlock vehicle command
   * @param {String} vin - Vehicle VIN
   * @param {String} pin - Security PIN
   * @returns {Buffer} Serialized command message
   */
  createUnlockCommand(vin, pin) {
    return this._createCommandMessage(vin, {
      doorsUnlock: {
        pin: pin,
        doors: []  // Empty array unlocks all doors
      }
    });
  }

  /**
   * Create flash lights command (sigpos_start)
   * @param {String} vin - Vehicle VIN
   * @returns {Buffer} Serialized command message
   */
  createFlashLightsCommand(vin) {
    return this._createCommandMessage(vin, {
      sigposStart: {
        lightType: 1,    // DIPPED_HEAD_LIGHT
        sigposType: 0    // LIGHT_ONLY
      }
    });
  }

  /**
   * Create start climate control command (auxheat_start)
   * @param {String} vin - Vehicle VIN
   * @returns {Buffer} Serialized command message
   */
  createStartClimateCommand(vin) {
    return this._createCommandMessage(vin, {
      auxheatStart: {}
    });
  }

  /**
   * Create stop climate control command (auxheat_stop)
   * @param {String} vin - Vehicle VIN
   * @returns {Buffer} Serialized command message
   */
  createStopClimateCommand(vin) {
    return this._createCommandMessage(vin, {
      auxheatStop: {}
    });
  }

  /**
   * Create start engine command
   * @param {String} vin - Vehicle VIN
   * @param {String} pin - Security PIN
   * @returns {Buffer} Serialized command message
   */
  createStartEngineCommand(vin, pin) {
    return this._createCommandMessage(vin, {
      engineStart: {
        pin: pin
      }
    });
  }

  /**
   * Create stop engine command
   * @param {String} vin - Vehicle VIN
   * @returns {Buffer} Serialized command message
   */
  createStopEngineCommand(vin) {
    return this._createCommandMessage(vin, {
      engineStop: {}
    });
  }

  /**
   * Create open windows command
   * @param {String} vin - Vehicle VIN
   * @param {String} pin - Security PIN
   * @returns {Buffer} Serialized command message
   */
  createOpenWindowsCommand(vin, pin) {
    return this._createCommandMessage(vin, {
      windowsOpen: {
        pin: pin
      }
    });
  }

  /**
   * Create close windows command
   * @param {String} vin - Vehicle VIN
   * @returns {Buffer} Serialized command message
   */
  createCloseWindowsCommand(vin) {
    return this._createCommandMessage(vin, {
      windowsClose: {}
    });
  }
}

module.exports = ProtoParser;
