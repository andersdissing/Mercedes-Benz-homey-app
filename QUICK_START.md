# Quick Start Guide - Mercedes-Benz Homey App

## Prerequisites

- Node.js v18 or higher
- Homey CLI: `npm install -g homey`
- Homey Pro (Early 2023) or later, firmware >= 12.3.0
- Mercedes Me account (2FA must be disabled)
- Mercedes-Benz vehicle with Mercedes Me connectivity

## Step 1: Install Dependencies

```bash
cd com.mercedes.mbapi
npm install
```

## Step 2: Validate and Build

```bash
npx homey app validate
npx homey app build
```

## Step 3: Install to Homey

```bash
npx homey app install
```

Or for development with live logs:
```bash
npx homey app run
```

**Note:** After using `homey app run`, you must run `homey app install` again for the app to persist.

## Step 4: Pair Your Vehicle

1. Go to **Devices > Add Device > Mercedes-Benz**
2. Enter your Mercedes Me credentials (email and password)
3. Select your region (Europe, North America, Asia-Pacific, or China)
4. Select your vehicle from the list
5. Complete pairing

## Step 5: Configure Settings

In device settings:
- **PIN:** Enter your Mercedes Me security PIN (required for unlock, engine start, window/sunroof open)
- **Polling interval:** Set data refresh interval in seconds (default: 180, range: 60-3600)

## Step 6: Add the Dashboard Widget

1. Go to **Dashboards** in the Homey app
2. Tap **+ Add Widget**
3. Go to the **Apps** tab
4. Select **Car Status**

## Testing Flow Cards

### Test 1: Flash Lights (Safest First Test)
```
WHEN: This Flow is started
THEN: Flash lights (select your vehicle)
```

### Test 2: Lock Status Check
```
WHEN: This Flow is started
AND: Vehicle is locked
THEN: Send notification "Vehicle is locked"
```

## Troubleshooting

### Authentication Fails
- Ensure 2FA is disabled on your Mercedes Me account
- Verify credentials by logging into the Mercedes Me app first
- Check that your account is not locked or blocked

### No Data After Pairing
- The app uses WebSocket for real-time updates with REST API polling as fallback
- Check logs with `homey app log` for connection errors
- HTTP 418 errors indicate outdated API headers (see CHANGELOG.md)

### Widget Not Visible
- Widgets require firmware >= 12.3.0
- Look under **Dashboards > + Add Widget > Apps tab** (not Home screen)
- After `homey app run`, reinstall with `homey app install`

## Development Commands

```bash
npx homey app validate      # Validate app structure
npx homey app build         # Build the app
npx homey app run           # Run with live logs
npx homey app install       # Install to Homey
npx homey app log           # View app logs
```

## Safety Notes

- Never rely solely on the app for vehicle security
- Always verify vehicle is locked physically
- Keep backup key accessible when testing remote start
- Be aware of API rate limiting (don't poll too frequently)
