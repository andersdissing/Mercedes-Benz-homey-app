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
**16 trigger cards:** vehicle locked/unlocked, door opened/closed, window opened/closed, engine started/stopped, charging started/stopped/completed, low battery, geofence entered/left, warning light activated, vehicle alarm.

**12 condition cards:** is locked, engine running, charging, windows closed, tire pressure OK, preconditioning, any door open, warning active, sunroof open, battery level above threshold, aux heat active, in geofence.

**19 action cards:** lock/unlock, start/stop climate, flash lights, start/stop engine, open/close windows, open/close/tilt sunroof, start/stop preconditioning, send route, configure max SOC, configure departure time, configure temperature, configure seat heating, sound horn, refresh data.

### Real-Time Updates
- WebSocket connection for instant push updates from the vehicle
- Automatic fallback to REST API polling when WebSocket is unavailable
- Configurable polling interval (60-3600 seconds)

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

### HTTP 418 Errors
Mercedes periodically updates their API requirements. If you see HTTP 418 errors, the app's API headers may need updating to match the current Mercedes mobile app version. Check the [mbapi2020](https://github.com/ReneNulschDE/mbapi2020) integration for reference.

### Widget Not Showing
- Widgets require Homey firmware >= 12.3.0
- Look under **Dashboards > + Add Widget > Apps tab** (not the Home screen)
- If you previously ran `homey app run`, reinstall with `homey app install`

## Development

```bash
npm install                 # Install dependencies
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
