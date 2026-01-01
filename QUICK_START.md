# Quick Start Guide - Mercedes-Benz Homey App

## Prerequisites

- Node.js installed (v18 or higher recommended)
- Homey CLI installed globally: `npm install -g homey`
- A Homey Pro (2023) or compatible device
- Mercedes Me account (without 2FA enabled)
- Mercedes-Benz vehicle

## Step 1: Install Dependencies

```bash
cd "Homey Repo/com.mercedes.mbapi"
npm install
```

This will install:
- axios (HTTP client)
- ws (WebSocket client)
- homey (SDK dev dependency)

## Step 2: Validate App Structure

```bash
homey app validate
```

Expected output: App validation should pass (may warn about missing images)

## Step 3: Create Placeholder Images (Temporary)

Before you can run the app, you need three images. For testing, create simple placeholder images:

**Linux/Mac:**
```bash
cd assets/images
# Create simple colored rectangles as placeholders
convert -size 250x175 xc:silver small.png
convert -size 500x350 xc:silver large.png
convert -size 1000x700 xc:silver xlarge.png
```

**Windows (using Paint or online tool):**
- Create 250x175 PNG → save as small.png
- Create 500x350 PNG → save as large.png
- Create 1000x700 PNG → save as xlarge.png

Or download Mercedes logo and resize to these dimensions.

## Step 4: Run the App

### Option A: Test on Real Homey Device

```bash
homey app run
```

This will:
1. Bundle the app
2. Install it on your Homey
3. Start the app
4. Show live logs

### Option B: Install to Homey

```bash
homey app install
```

Then check the app in:
- Homey Web App → Apps → Mercedes-Benz
- Add device via → Devices → Add Device → Mercedes-Benz

## Step 5: Pair Your Vehicle

1. Go to Devices → Add Device
2. Select "Mercedes-Benz"
3. Enter your Mercedes Me credentials (email/password)
4. Select your region (Europe, North America, Asia-Pacific)
5. Select your vehicle from the list
6. Complete pairing

## Step 6: Configure PIN (Optional but Recommended)

1. Go to the device settings
2. Enter your Mercedes Me security PIN
3. Set polling interval (default 180 seconds is good)

The PIN is required for:
- Unlocking doors
- Starting engine
- Opening windows
- Opening sunroof

## Troubleshooting First Run

### App Validation Fails
**Error:** "Missing required images"
**Fix:** Create placeholder images (see Step 3)

### Authentication Fails
**Error:** "Login failed" or "2FA not supported"
**Check:**
- Credentials are correct
- Account does NOT have 2FA enabled
- Try logging into Mercedes Me app first
- Account is not locked/blocked

### No Vehicles Found
**Possible causes:**
- No vehicles associated with account
- API connection issue
- Wrong region selected

**Debug:**
Check Homey logs: `homey app log`

### Device Pairing Hangs
**Check:**
- Internet connection
- Homey can reach Mercedes API (https://id.mercedes-benz.com)
- Check logs for specific error

## Viewing Logs

```bash
# Live logs
homey app log

# Or in Homey Web App
Apps → Mercedes-Benz → View App → Logs
```

## Testing Flow Cards

### Test 1: Flash Lights (Safest First Test)

Create a test flow:
```
WHEN: This Flow is started
THEN: Flash lights (select your vehicle)
```

Run the flow and check if your vehicle lights flash.

### Test 2: Lock Status

Create a test flow:
```
WHEN: This Flow is started
AND: Vehicle is locked (condition)
THEN: Send notification "Vehicle is locked"
```

### Test 3: Lock/Unlock (Requires PIN)

Create a test flow:
```
WHEN: This Flow is started
THEN: Lock vehicle
WAIT: 30 seconds
THEN: Unlock vehicle
```

**⚠️ Warning:** Make sure you have physical access to your vehicle in case unlock fails!

## Known Issues in First Version

1. **Vehicle data might not update correctly**
   - Reason: Protobuf parsing not implemented
   - Workaround: Check if basic data appears
   - Fix needed: See IMPLEMENTATION_NOTES.md

2. **Real-time updates don't work**
   - Reason: WebSocket not implemented
   - Workaround: Use polling (adjust interval in settings)
   - Fix needed: See IMPLEMENTATION_NOTES.md

3. **Some capabilities might show as "unknown"**
   - Reason: API response format assumptions
   - Workaround: Check Homey logs for actual API responses
   - Fix needed: Adjust data parsing based on real responses

## Development Commands

```bash
# Validate app structure
homey app validate

# Run app on Homey (auto-reload on changes)
homey app run

# Install app to Homey
homey app install

# View logs
homey app log

# Build app for distribution
homey app build

# Run with specific Homey
homey app run --homey <homey-ip>
```

## Getting Help

1. **Check logs first:** `homey app log`
2. **Read documentation:**
   - IMPLEMENTATION_NOTES.md for technical issues
   - README.md for user issues
3. **Check Homey Community:** https://community.homey.app/
4. **Report bugs:** (GitHub URL - update when repository is created)

## Next Steps After Successful Pairing

1. **Test all capabilities:**
   - Check device card shows battery, pressure, lock status
   - Verify data updates after polling interval

2. **Test all commands:**
   - Lock/Unlock (with PIN configured)
   - Climate control start/stop
   - Flash lights
   - Engine start/stop (if supported by your vehicle)

3. **Create useful flows:**
   - Auto-lock when leaving home
   - Preheat before departure
   - Low battery notifications

4. **Optimize settings:**
   - Adjust polling interval based on usage
   - Test with different intervals to find balance

## Safety Notes

- **Never** rely solely on app for vehicle security
- Always verify vehicle is locked physically
- Keep backup key accessible when testing remote start
- Be aware of API rate limiting (don't poll too frequently)
- Monitor your Mercedes Me account for blocking warnings

## Support

For issues specific to:
- **Homey platform:** Homey Community Forum
- **Mercedes API:** Mercedes Me app support
- **This app:** GitHub Issues (link to be added)

---

**Happy automation!** 🚗⚡
