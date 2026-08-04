# Mercedes-Benz for Homey

Stay connected to your Mercedes-Benz, wherever you are. Monitor your vehicle's status, control locks, climate, windows, and more -- all from your Homey smart home hub.

## Features

### Vehicle Status
- Battery level, fuel level, and range (electric/liquid)
- Door and window status (all positions including trunk, hood, sunroof)
- Lock status
- Tire pressure monitoring
- Charging status and end-of-charge time
- Engine and preconditioning status
- Odometer, eco scores, and trip data
- GPS position and heading
- Service interval tracking

### Remote Control
- Lock/unlock doors (PIN required for unlock)
- Start/stop climate control (preconditioning)
- Start/stop engine (PIN required)
- Open/close windows (PIN required for open)
- Open/close/tilt sunroof (PIN required for open)
- Flash lights
- Sound horn
- Send route to navigation
- Configure max state of charge and charge program
- Configure departure time and seat heating

### Dashboard Widget
A compact "Car Status" widget for the Homey dashboard showing:
- Vehicle name
- Battery bar with % and electric range in km
- Fuel bar with % and liquid range in km
- Lock status indicator (green/red)
- Door/window/sunroof open status
- Auto-detects EV/ICE/PHEV and shows relevant energy bars

Find the widget under **Dashboards > + Add Widget > Apps tab > "Car Status"**.

### Flow Cards
**19 trigger cards:** vehicle locked/unlocked, door opened/closed, window opened/closed, engine started/stopped, charging started/stopped/completed, connector connected/disconnected, low battery, geofence entered/left, warning light activated, vehicle alarm, vehicle command failed.

**13 condition cards:** is locked, engine running, charging, connector connected, windows closed, tire pressure OK, preconditioning, any door open, warning active, sunroof open, battery level above threshold, aux heat active, in geofence.

**23 action cards:** lock/unlock, start/stop climate, flash lights, start/stop engine, open/close windows, open/close/tilt sunroof, start/stop preconditioning, start/stop charging, send route, configure max SOC, configure departure time, configure temperature, configure seat heating, sound horn, refresh data.

#### What an action card's result means
An action card finishes as soon as Mercedes **accepts** the command, which
takes 60-300 ms. That is not the same as the car having carried it out — the
vehicle reports completion roughly 8-13 seconds later, beyond what a Flow
card can wait for. Acceptance is all the card can honestly report, so the app
keeps tracking the command afterwards.

A command can therefore be accepted and still fail. The **Vehicle command
failed** trigger fires in exactly that case, carrying `command`
(e.g. `windowsClose`) and `reason` (e.g. `CMD_TIMEOUT`), so a failure that
arrives after the card already reported success can still start a
notification Flow.

### Real-Time Updates
- WebSocket connection for instant push updates from the vehicle
- Automatic reconnection with exponential backoff if the connection drops, plus a periodic health check that restores it if it ever goes down unnoticed
- Keepalive ping/pong so an idle connection (parked car with nothing to report) is not mistaken for a dead one
- Automatic fallback to REST API polling when WebSocket is unavailable
- Configurable polling interval (60-3600 seconds)

Note: the WebSocket carries the full vehicle payload, while the REST poll
returns only a subset (battery, ranges, position, fuel). Door, window,
tire-pressure and odometer updates therefore depend on the WebSocket being
connected.

Mercedes rate-limits the push connection and the data endpoints separately,
and the app treats them separately.

When the **push connection** is refused (HTTP 429 on the upgrade), the app
retries after 30 seconds and triples the wait after each further refusal, up
to a half-hour cap. A refusal is usually about the session rather than the
account — a refreshed token belongs to the session being refused — so after
the second one the app logs in from scratch, which in practice clears it
immediately. The REST poll keeps running throughout, so battery, range and
position stay current; only the capabilities that arrive over the socket
(doors, windows, lock, sunroof) go stale.

When the **data endpoints** are refused, which is rarer, the poll stands
down for 10 minutes and doubles after each further refusal, up to two hours.
Nothing updates during that window. The manual "refresh data" card refuses
with the time remaining rather than reporting a refresh that did not happen.

Either way, once the live connection has been down for an hour the device
shows a warning naming what is actually stale, and retracts it as soon as
data flows again.

## Requirements

- Homey Pro (Early 2023) or later
- Homey firmware >= 12.3.0
- Mercedes Me account (2FA must be disabled)
- Mercedes-Benz vehicle with Mercedes Me connectivity
- **The Mercedes Me account used to log in must be an admin/owner of the vehicle.** Non-admin accounts have restricted access and many features will not work, including geofence triggers, remote commands, and real-time status updates.

## Installation

### From Homey App Store
Search for "Mercedes-Benz" in the Homey App Store and install.

### From Source
```bash
git clone https://github.com/andersdissing/Mercedes-Benz-homey-app.git
cd Mercedes-Benz-homey-app
npm install
npx homey app install
```

## Setup

1. Go to **Devices > Add Device > Mercedes-Benz**
2. Enter your Mercedes Me credentials (email and password)
3. Select your region (Europe, North America, Asia-Pacific, or China)
4. Select your vehicle from the list
5. Complete pairing

### Configure PIN (Recommended)
Go to the device settings and enter your Mercedes Me security PIN. The PIN is required for:
- Unlocking doors
- Starting the engine
- Opening windows and sunroof

### Configure Polling Interval
In device settings, set the polling interval (default: 180 seconds, range: 60-3600 seconds). This controls how often the app fetches data when the WebSocket connection is unavailable.

## Supported Regions

| Region | REST API | WebSocket |
|--------|----------|-----------|
| Europe | emea-prod | emea-prod |
| North America | amap-prod | amap-prod |
| Asia-Pacific | amap-prod | amap-prod |
| China | cn-prod | cn-prod |

## Architecture

```
app.js                          # Main app, flow card registration, widget API
drivers/mercedes-vehicle/
  driver.js                     # Pairing flow (login, region, vehicle selection)
  device.js                     # Device capabilities, polling, commands
lib/
  oauth.js                      # OAuth2 PKCE authentication
  api.js                        # REST API client + WebSocket management
  websocket.js                  # WebSocket client for real-time updates
  proto/
    parser.js                   # Protobuf message parser
    vehicle-events.proto        # Vehicle event protobuf schema
    client.proto                # Command protobuf schema
widgets/car-status/
  widget.compose.json           # Widget configuration
  api.js                        # Widget backend API
  public/index.html             # Widget frontend
test/
  log-redactor.test.js          # PII redaction tests
  websocket-reconnect.test.js   # WebSocket reconnect state machine tests
```

## Troubleshooting

### Authentication Fails
- Ensure 2FA is disabled on your Mercedes Me account
- Verify credentials are correct by logging in to the Mercedes Me app
- Check that your account is not locked or blocked

### No Data Updates
- Check the WebSocket connection status in the app logs
- Verify the polling interval in device settings
- Ensure your vehicle has active Mercedes Me connectivity

### Some Values Update, Others Are Stuck
If fields like battery, range and position keep updating but doors,
windows, tire pressure or odometer stay frozen, the WebSocket connection
is down and only the REST poll is running — the poll does not carry those
attributes. Look for `[WS]` lines in the app logs: a healthy connection
reconnects on its own (`[WS] Scheduling reconnect attempt ...`), and a
`[WS-HEALTH]` line indicates the periodic health check stepped in.

### The Device Shows a Warning About the Live Connection
Mercedes is refusing the push connection. The log shows
`[WS] Push connection rate-limited (HTTP 429) - backing off for 30s`; the
first retry is 30 seconds later and each further refusal triples the wait,
up to half an hour. Battery, range and position keep updating throughout —
only the capabilities that arrive over the socket (doors, windows, lock,
sunroof) are stale.

This resolves itself. A short refusal after an app update is normal: the
previous session is still open at Mercedes when the new one connects. If it
persists, the app logs in from scratch after the second refusal
(`[WS] Re-authenticating from scratch before reconnect`), which opens a new
session and typically reconnects within a second.

**Restarting the app repeatedly makes it worse**, because each restart
handshakes immediately and earns a fresh refusal. Leave it alone and it
reconnects on its own.

### Nothing Updates At All
The data endpoints are rate-limited too, which is rarer. The log shows
`[API] REST endpoints rate-limited (HTTP 429)` and
`[POLL] Skipped - Mercedes is rate-limiting the data endpoints ...`. The
poll stands down for 10 minutes, doubling with each further refusal up to
two hours, so every value is last-known until the block clears.

### HTTP 418 Errors
Mercedes periodically updates their API requirements. If you see HTTP 418 errors, the app's API headers may need updating to match the current Mercedes mobile app version. Check the [mbapi2020](https://github.com/ReneNulschDE/mbapi2020) integration for reference.

### Widget Not Showing
- Widgets require Homey firmware >= 12.3.0
- Look under **Dashboards > + Add Widget > Apps tab** (not the Home screen)
- If you previously ran `homey app run`, reinstall with `homey app install`
- After re-pairing the vehicle the widget loses its selection, because it
  stores the device's Homey ID and re-pairing mints a new one. Re-pick the
  car in the widget's settings. The PIN is a device setting and is lost the
  same way, so PIN-gated commands (open windows, open/tilt sunroof) will
  fail until it is set again.

### A Flow Reports a Timeout That Never Happened
The Flow editor's **Test** button gives up on a run after well under 30
seconds and blames whichever card it was nearest — so any Flow containing a
delay reports a timeout even though every card succeeded and the Flow ran to
completion. Verified at both 30 s and 120 s delays, with the action cards
returning in under 150 ms. Trigger the Flow for real (from the mobile app,
or via its trigger card) and judge by what the car does.

## Development

```bash
npm install                 # Install dependencies
npm test                    # Run unit tests (Node's built-in test runner)
npx homey app validate      # Validate app structure
npx homey app build         # Build the app
npx homey app run           # Run on Homey (live logs)
npx homey app install       # Install to Homey
```

## Mercedes-Benz Data Explorer

A companion browser-based tool that lets you log in with your Mercedes Me credentials and inspect the raw vehicle data returned by the Mercedes-Benz backend API. Useful for debugging, verifying capability mappings, and understanding what data your vehicle exposes.

**Live version:** https://stmercedesexplore01.z6.web.core.windows.net/

**Source code:** https://github.com/andersdissing/mercedes-explore

### What it does

- Log in with your Mercedes Me credentials (OAuth2 PKCE, same as the Homey app)
- Select your vehicle and fetch data (protobuf) from the Mercedes-Benz API
- View data in two tables:
  - **Capabilities** — vehicle data points mapped to Homey capabilities, showing the processed value and the raw API key/value
  - **Logic Flows** — Homey flow cards (actions, conditions, triggers) available for your vehicle
- Copy the capabilities table or raw key/value data to clipboard
- Refresh data without re-logging in
- Progress log showing each step of the login and data fetch process

## Credits

- Based on the [mbapi2020](https://github.com/ReneNulschDE/mbapi2020) Home Assistant integration by ReneNulschDE
- Protobuf schemas derived from the Mercedes-Benz mobile app

## License

ISC

## Support

- [GitHub Issues](https://github.com/andersdissing/Mercedes-Benz-homey-app/issues)
- [Homey Community](https://community.homey.app/)
