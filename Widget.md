# Car Status Widget

## Overview
Dashboard widget showing real-time Mercedes-Benz vehicle status at a glance.
Located under **Dashboards > + Add Widget > Apps tab > "Car Status"**.

## Features
- [x] Lock status indicator (green locked / red unlocked icon)
- [x] Door status: front left, front right, rear left, rear right, trunk, hood (green = closed, red = open)
- [x] Window status: front left, front right, rear left, rear right (green = closed, orange = airing/tilted, red = open)
- [x] Sunroof status (green = closed, orange = tilted, red = open)
- [x] Battery bar with % and electric range in km (EV)
- [x] Fuel bar with % and liquid range in km (ICE)
- [x] Auto-detects EV/ICE/PHEV — shows one or both bars based on available data
- [x] Error display when API fails
- [x] 30-second auto-refresh polling
- [x] Light/dark theme support via Homey CSS variables

## Requirements
- Homey Pro (Early 2023) or Homey Cloud
- Homey firmware >= 12.3.0
- Homey mobile app >= v9.0.0
- At least one paired Mercedes-Benz vehicle

## File Structure
```
widgets/car-status/
  widget.compose.json    # Widget config (name, height, API routes)
  api.js                 # Backend API handler — calls app.getDeviceStatus()
  preview-light.png      # 512x512 preview for light mode
  preview-dark.png       # 512x512 preview for dark mode
  public/
    index.html           # Widget frontend (HTML + CSS + JS, inline SVG car diagram)
```

## API
- **GET /** — Returns device status object via `app.getDeviceStatus(deviceId)`
- Response: `{ locked, battery, fuel, rangeElectric, rangeLiquid, doors, windows, sunroof, chargingStatus, engineRunning, model }`
- Falls back to first available device if no deviceId specified

## Technical Notes
- `Homey.api()` uses Promises, NOT callbacks: `await Homey.api('GET', '/', {})`
- `Homey.ready({ height: 260 })` must pass height object
- `onHomeyReady` must be `async`
- Body uses `class="homey-widget"` — Homey handles padding/background
- Preview images must be square (512x512), build generates resized versions

## References
- [Widgets SDK Docs](https://apps.developer.homey.app/the-basics/widgets)
- [Widget Settings](https://apps.developer.homey.app/the-basics/widgets/settings)
- [Widget Styling](https://apps.developer.homey.app/the-basics/widgets/styling)
- [Tesla widget (working reference)](https://github.com/RonnyWinkler/homey.tesla/tree/main/widgets/car_main)
