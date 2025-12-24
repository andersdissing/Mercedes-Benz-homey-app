// Test script to verify API call and protobuf parsing
const axios = require('axios');
const ProtoParser = require('./lib/proto/parser');

// Mock homey object for testing
const mockHomey = {
  app: {
    log: (...args) => console.log('[LOG]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
  }
};

async function testApiCall() {
  console.log('=== Testing Mercedes API Call & Protobuf Parsing ===\n');

  // You need to provide these values from your actual login
  const TEST_ACCESS_TOKEN = 'YOUR_ACCESS_TOKEN_HERE'; // Get this from a successful login
  const TEST_VIN = 'YOUR_VIN_HERE'; // Your vehicle VIN
  const REGION = 'Europe';

  if (TEST_ACCESS_TOKEN === 'YOUR_ACCESS_TOKEN_HERE') {
    console.error('ERROR: Please update TEST_ACCESS_TOKEN and TEST_VIN in the script first!');
    console.error('You can get these values by running the app and checking the logs.');
    return;
  }

  try {
    // Initialize protobuf parser
    console.log('Step 1: Initializing protobuf parser...');
    const parser = new ProtoParser(mockHomey);
    await parser.initialize();
    console.log('✓ Protobuf parser initialized\n');

    // Make API call
    console.log('Step 2: Calling Mercedes widget API...');
    const restUrl = 'https://bff.emea-prod.mobilesdk.mercedes-benz.com';
    const widgetUrl = restUrl.replace('bff.emea-prod', 'widget.emea-prod');
    const url = `${widgetUrl}/v1/vehicle/${TEST_VIN}/vehicleattributes`;

    console.log(`URL: ${url}`);

    const headers = {
      'Authorization': `Bearer ${TEST_ACCESS_TOKEN}`,
      'X-SessionId': 'TEST-SESSION-ID',
      'X-TrackingId': 'TEST-TRACKING-ID',
      'X-ApplicationName': 'mycar-store-ece',
      'ris-application-version': '1.61.0',
      'ris-os-name': 'ios',
      'ris-os-version': '12',
      'ris-sdk-version': '3.55.0',
      'X-Locale': 'de-DE',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15',
      'Content-Type': 'application/json; charset=UTF-8'
    };

    const response = await axios.get(url, {
      headers,
      responseType: 'arraybuffer',
      timeout: 30000
    });

    console.log(`✓ API call successful! Status: ${response.status}`);
    console.log(`Response data length: ${response.data.byteLength} bytes\n`);

    // Parse protobuf
    console.log('Step 3: Parsing protobuf response...');
    const buffer = Buffer.from(response.data);
    console.log(`First 100 bytes (hex): ${buffer.slice(0, 100).toString('hex')}\n`);

    const vepUpdate = parser.parseVEPUpdate(buffer);
    console.log('✓ Protobuf parsed successfully!');
    console.log(`VIN: ${vepUpdate.vin}`);
    console.log(`Sequence Number: ${vepUpdate.sequenceNumber}`);
    console.log(`Emit Timestamp: ${vepUpdate.emitTimestampInMs}`);
    console.log(`Full Update: ${vepUpdate.fullUpdate}`);
    console.log(`Number of attributes: ${Object.keys(vepUpdate.attributes || {}).length}\n`);

    // Show first 10 attributes
    console.log('Step 4: First 10 attributes:');
    const attrEntries = Object.entries(vepUpdate.attributes || {}).slice(0, 10);
    for (const [key, attr] of attrEntries) {
      const value = attr.intValue ?? attr.boolValue ?? attr.stringValue ?? attr.doubleValue ?? attr.displayValue;
      console.log(`  ${key}: ${value} (type: ${attr.attributeType})`);
    }

    // Extract vehicle data
    console.log('\nStep 5: Extracting vehicle data...');
    const vehicleData = parser.extractVehicleData(vepUpdate);
    console.log(`✓ Extracted ${Object.keys(vehicleData).length} fields`);
    console.log('\nSample extracted data:');
    console.log(JSON.stringify(vehicleData, null, 2).slice(0, 1000) + '...');

    console.log('\n✓✓✓ All tests passed!');

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error('Error stack:', error.stack);

    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', error.response.data);
    }
  }
}

testApiCall();
