// Quick test to verify protobuf parser works
const protobuf = require('protobufjs');
const path = require('path');

async function testProtoParser() {
  try {
    console.log('Testing protobuf parser...');

    // Load the proto file
    const protoPath = path.join(__dirname, 'lib/proto/vehicle-events.proto');
    console.log('Loading proto from:', protoPath);

    const root = await protobuf.load(protoPath);
    console.log('✓ Proto file loaded successfully');

    // Get the VEPUpdate message type
    const VEPUpdate = root.lookupType('proto.VEPUpdate');
    console.log('✓ VEPUpdate message type found');

    // Create a test message
    // Note: protobufjs uses camelCase for field names
    const testMessage = {
      sequenceNumber: 1,
      vin: 'TEST123',
      fullUpdate: true,
      emitTimestampInMs: Date.now(),
      attributes: {
        'soc': {
          intValue: 85,  // camelCase!
          status: 4,
          timestampInMs: Date.now()
        },
        'doorlockstatusvehicle': {
          intValue: 2,  // camelCase!
          status: 4,
          timestampInMs: Date.now()
        }
      }
    };

    console.log('Test message created:', JSON.stringify(testMessage, null, 2));

    // Encode to binary
    const errMsg = VEPUpdate.verify(testMessage);
    if (errMsg) {
      throw new Error('Message validation failed: ' + errMsg);
    }

    const message = VEPUpdate.create(testMessage);
    const buffer = VEPUpdate.encode(message).finish();
    console.log('✓ Message encoded to binary, length:', buffer.length, 'bytes');
    console.log('First 50 bytes (hex):', buffer.slice(0, 50).toString('hex'));

    // Decode back
    const decoded = VEPUpdate.decode(buffer);
    const decodedObj = VEPUpdate.toObject(decoded, {
      longs: Number,
      enums: String,
      bytes: String,
      defaults: true,  // Changed to true to include zero values
      arrays: true,
      objects: true,
      oneofs: true
    });

    console.log('✓ Message decoded successfully');
    console.log('Decoded message:', JSON.stringify(decodedObj, null, 2));

    console.log('\n✓✓✓ All tests passed! Protobuf parser is working correctly.');

  } catch (error) {
    console.error('✗ Test failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testProtoParser();
