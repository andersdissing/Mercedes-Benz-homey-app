'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MercedesWebSocket = require('../lib/websocket');

/**
 * Regression tests for vepUpdates acknowledgement ordering.
 *
 * Seen in a live log: a push carrying ten attributes arrived twice with the
 * same sequenceNumber and the same emitTimestamp, and every capability write
 * and flow trigger inside it ran twice. The ack was only sent once the message
 * handler had finished applying the update - one IPC round-trip per capability
 * plus flow triggers - so a large update outran the backend's ack window and
 * Mercedes re-sent it.
 */

function makeWs() {
  const homey = { app: { log() {}, error() {} } };
  const oauth = { getAccessToken: async () => 'token', refreshToken: async () => {} };
  return new MercedesWebSocket(homey, oauth, 'Europe', {});
}

/** Stub the parser and transport, recording the order of what actually happens. */
function instrument(ws, sequenceNumber) {
  const order = [];

  ws.protoParser = {
    parsePushMessage: () => ({
      msg: 'vepUpdates',
      vepUpdates: {
        sequenceNumber,
        updates: { VIN1: { fullUpdate: false, attributes: {} } },
      },
    }),
    extractVehicleData: () => ({ vin: 'VIN1' }),
    createAcknowledgeVepUpdatesByVin: (seq) => ({ ack: seq }),
  };

  ws._sendMessage = async (msg) => { order.push(['ack', msg.ack]); };

  ws.messageHandler = async () => {
    order.push(['handler:start']);
    await new Promise(resolve => setTimeout(resolve, 20));
    order.push(['handler:end']);
  };

  return order;
}

test('vepUpdates is acknowledged before the update is applied', async () => {
  const ws = makeWs();
  const order = instrument(ws, 19);

  await ws._processMessage(Buffer.alloc(0));

  // Acking after the handler is what let a slow update get re-sent and applied
  // twice, double-firing every flow trigger it carried.
  assert.deepEqual(order, [
    ['ack', 19],
    ['handler:start'],
    ['handler:end'],
  ]);
});

test('sequenceNumber 0 is acknowledged', async () => {
  const ws = makeWs();
  const order = instrument(ws, 0);

  await ws._processMessage(Buffer.alloc(0));

  // 0 is a real sequence number. A truthiness check silently skipped it, so the
  // backend never saw a receipt and kept re-sending that update.
  assert.deepEqual(order[0], ['ack', 0]);
});

test('a handler that throws still leaves the update acknowledged', async () => {
  const ws = makeWs();
  const order = instrument(ws, 7);
  ws.messageHandler = async () => { throw new Error('capability write failed'); };

  await ws._processMessage(Buffer.alloc(0));

  // Otherwise one failing capability write earns an endless re-send loop.
  assert.deepEqual(order, [['ack', 7]]);
});

/**
 * The same "0 is a real sequence number" fault existed on the other three ack
 * paths. It matters most on the command channel: a command status update the
 * backend considers undelivered is one it keeps re-sending.
 */
function instrumentAck(ws, message, ackFactoryName) {
  const acked = [];

  ws.protoParser = {
    parsePushMessage: () => message,
    [ackFactoryName]: (seq) => ({ ack: seq }),
  };
  ws._sendMessage = async (msg) => { acked.push(msg.ack); };

  return acked;
}

test('command status update with sequenceNumber 0 is acknowledged', async () => {
  const ws = makeWs();
  const acked = instrumentAck(
    ws,
    {
      msg: 'apptwinCommandStatusUpdatesByVin',
      apptwinCommandStatusUpdatesByVin: { sequenceNumber: 0, updatesByVin: {} },
    },
    'createAcknowledgeAppTwinCommandStatusUpdateByVin',
  );

  await ws._processMessage(Buffer.alloc(0));

  assert.deepEqual(acked, [0]);
});

test('service status update with sequenceNumber 0 is acknowledged', async () => {
  const ws = makeWs();
  const acked = instrumentAck(
    ws,
    { msg: 'serviceStatusUpdates', serviceStatusUpdates: { sequenceNumber: 0 } },
    'createAcknowledgeServiceStatusUpdate',
  );

  await ws._processMessage(Buffer.alloc(0));

  assert.deepEqual(acked, [0]);
});

test('user data update with sequenceNumber 0 is acknowledged', async () => {
  const ws = makeWs();
  const acked = instrumentAck(
    ws,
    { msg: 'userDataUpdate', userDataUpdate: { sequenceNumber: 0 } },
    'createAcknowledgeUserDataUpdate',
  );

  await ws._processMessage(Buffer.alloc(0));

  assert.deepEqual(acked, [0]);
});
