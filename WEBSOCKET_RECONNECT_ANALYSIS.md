# Capabilities stop updating after ~30s: WebSocket reconnect analysis

Issue: #47 ("not all capabilities are refreshed")

## Symptom

After initialization, some capabilities (battery, range, position) keep
updating over time, while others (windows, doors, tire pressure, odometer,
ignition state) freeze at whatever value they had at startup and never
change again — even though the vehicle's actual state changes.

## Root cause

Three bugs in `lib/websocket.js` compound to permanently kill the
real-time connection about 30 seconds after every init, with no recovery.
After that point the app silently falls back to REST polling, which only
returns a small subset of vehicle attributes — not the ones affected by
this bug.

### Bug 1 — the watchdog always fires before the first keepalive ping

```js
this.INITIAL_WATCHDOG_TIMEOUT = 30000; // 30 seconds
this.DEFAULT_WATCHDOG_TIMEOUT = 30000; // 30 seconds
this.PING_INTERVAL = 32000;            // 32 seconds
```

The connection watchdog (30s) expires *before* the keepalive ping (32s)
ever has a chance to fire and produce a `pong` that could keep the
connection alive. For a parked car with no telemetry changes, nothing
resets the watchdog in that window, so it fires on every single
connection, every time.

Additionally, `pong` only resets the *ping* watchdog:

```js
this.ws.on('pong', () => {
  this._resetPingWatchdog();   // does NOT reset the connection watchdog
});
```

Only a real data message resets the connection watchdog
(`_resetConnectionWatchdog()` inside `ws.on('message', ...)`). So even if
the ping/pong race were fixed, an idle-but-healthy connection with no new
vehicle data would still eventually be killed.

### Bug 2 — the timeout-triggered reconnect is a permanent no-op (the actual killer)

```js
_handleConnectionTimeout() {
  this.homey.app.log('[WS] Connection timeout - initiating reconnect');
  this.disconnect();          // sets this.isStopping = true
  this._scheduleReconnect();  // returns immediately because isStopping is true
}

disconnect() {
  this.homey.app.log('[WS] Disconnecting...');
  this.isStopping = true;     // never cleared anywhere except connect()
  ...
}

_scheduleReconnect() {
  if (this.isStopping || this.reconnectTimer) {
    return;                   // <-- silently does nothing
  }
  ...
}
```

`disconnect()` sets `isStopping = true` and nothing clears it except a
fresh call to `connect()` (line ~130). `_handleConnectionTimeout()` calls
`disconnect()` and *then* `_scheduleReconnect()` — but by that point
`isStopping` is already `true`, so `_scheduleReconnect()` returns
immediately without scheduling anything. The socket is now permanently
dead until the whole app restarts.

**This matches the real submitted log exactly**: the trace ends at
`[WS] Disconnected` / `[WS] Normal closure (1000)` with no
`[WS] Scheduling reconnect attempt N in Xs` line — that log statement is
unreachable from this path.

### Bug 3 — a second, independent dead-end for a mid-session drop

```js
this.ws.on('close', (code, reason) => {
  ...
  if (!this.isStopping) {
    if (settled) {
      // Connection was open, then closed unexpectedly (mid-session drop)
      if (!this._lastError) {
        this._scheduleReconnect();
      }
      // if _lastError IS set: nothing happens — no reconnect scheduled
    }
    ...
  }
});
```

If the socket was open and then dropped with an error already recorded
(`_lastError` set by the `'error'` handler), no reconnect is scheduled at
all. The comment assumes `connect()`'s own `catch` block will handle it,
but `connect()`'s promise already resolved on `'open'` earlier in the
session, so its `catch` can no longer fire for a later, independent
close event.

## Why this produces exactly the reported symptom

Once the socket is dead (via Bug 2, ~30s after every init), the app falls
back to the REST poll (`pollVehicleData` → `api.getVehicleData`). Per the
real submitted log, that poll's protobuf response contains only ~15
attributes:

```
positionHeading, rangeElectricWltp, rangeelectric, tankLevelAdBlue,
tanklevelpercent, overallRange, gasTankLevelPercent, positionLat, soc,
vtime, proximityCalculationForVehiclePositionRequired, positionLong,
vehiclePositionErrorCode, gasTankRange, rangeliquid
```

No window, door, tire pressure, odometer, or ignition fields are in that
set. The full ~129-attribute payload — the one that includes those
fields — only ever arrives over the WebSocket, which is dead. The log
even captures this directly:

```
[UPDATE] WARNING: doorlockstatusvehicle is undefined
```

`updateCapabilities()` correctly leaves a capability untouched when its
field is `undefined` in a given push (so it doesn't clobber a good value
with garbage) — but since the WebSocket never recovers, "untouched" means
"frozen forever" for every field that only the WebSocket ever reports.

Battery/range/position keep updating because they happen to also be in
the REST poll's small attribute set; windows/doors/tires/odometer don't,
so they freeze.

## Fix plan

1. **Fix the reconnect dead-end (Bug 2).** Add an internal teardown
   method (e.g. `_teardownSocket()`) that closes the socket and stops
   watchdogs *without* setting `isStopping`, and use it from
   `_handleConnectionTimeout()` instead of `disconnect()`. Reserve
   `isStopping` for genuine user-initiated shutdown paths (`onDeleted`,
   device repair). This alone restores connectivity.

2. **Fix the watchdog/ping race (Bug 1).** Set `PING_INTERVAL` safely
   below the connection watchdog timeout (e.g. ping every 20s, watchdog
   at 60s), and reset the connection watchdog on `pong` as well as on
   `message`, so a healthy-but-idle connection isn't killed just because
   the vehicle has nothing new to report.

3. **Fix the `_lastError` dead-end (Bug 3).** Always schedule a
   reconnect on an unexpected close unless `isStopping` is true. Use
   `_lastError` only to influence backoff duration or trigger a token
   refresh — not to decide whether to reconnect at all.

4. **Add a connection-health safety net.** A periodic check in
   `device.js` (e.g. alongside the existing poll interval) that calls
   `connect()` if the WebSocket isn't in the `OPEN` state, so no future
   single-point bug in the reconnect state machine can strand the
   connection silently again.

5. **Verify.** Unit-test the reconnect state machine with a fake/mock
   socket: timeout → internal teardown → reconnect actually gets
   scheduled; confirm `isStopping` only blocks reconnection when set via
   a genuine user-initiated stop, not via the timeout path. Run
   `npm test` and `homey app validate` (via the existing CI workflow).

## Open scope question

Steps 1–3 fix the actual bugs. Step 4 is defensive (a backstop against
future regressions in the same state machine) rather than strictly
necessary once 1–3 land. Decide whether to implement all five or just
1–3.
