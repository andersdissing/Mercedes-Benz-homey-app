# Mercedes-Benz for Homey

Control your Mercedes-Benz vehicle from Homey Pro.

## Features

### Supported Capabilities
- Lock/unlock doors
- Start/stop engine (with PIN)
- Start/stop climate control
- Flash lights
- Monitor battery level (electric vehicles)
- Monitor tire pressure
- Monitor vehicle warnings
- Track vehicle location

### Flow Cards

#### Triggers
- Vehicle was locked
- Vehicle was unlocked
- Engine was started
- Engine was stopped
- Battery is low

#### Conditions
- Vehicle is locked
- Engine is running
- All windows are closed

#### Actions
- Lock vehicle
- Unlock vehicle
- Start climate control
- Stop climate control
- Flash lights
- Start engine (requires PIN)
- Stop engine

## Setup

### Prerequisites
1. A Mercedes-Benz account (Mercedes Me)
2. A compatible Mercedes-Benz vehicle
3. The Mercedes Me mobile app installed and configured

### Important Notes

**Account Security:**
- We **strongly recommend** creating a separate Mercedes-Benz account for Homey integration
- Invite this account to your vehicle (up to 6 additional users allowed)
- Using the same account in multiple places may result in account blocking
- **Two-Factor Authentication (2FA) is NOT supported** - you must use an account without 2FA

**PIN Requirements:**
- Certain operations (unlock, start engine, open windows) require a security PIN
- Set up your PIN in the Mercedes Me mobile app first
- Enter the PIN in the device settings in Homey

**Supported Regions:**
- Europe
- North America
- Asia-Pacific
- China (currently experiencing API issues)

### Installation

1. Install the app from the Homey App Store
2. Go to Devices → Add Device → Mercedes-Benz
3. Enter your Mercedes Me credentials
4. Select your region
5. Select your vehicle(s) from the list
6. Configure the PIN in device settings (optional, but required for certain functions)

## Usage

### Basic Control
Control your vehicle using the device card or create flows:
- Toggle door locks
- Start/stop climate control
- Monitor battery and tire pressure

### Advanced Flows

**Example: Auto-lock when leaving home**
```
WHEN: You leave home
THEN: Lock Mercedes-Benz vehicle
```

**Example: Preheat before departure**
```
WHEN: It's 7:30 AM on weekdays
AND: Outside temperature < 10°C
THEN: Start Mercedes-Benz climate control
```

**Example: Low battery notification**
```
WHEN: Mercedes battery is low
THEN: Send notification "Your Mercedes battery is at {{battery_level}}%"
```

## Settings

### Device Settings
- **VIN**: Vehicle Identification Number (read-only)
- **Security PIN**: Required for unlock, engine start, and window operations
- **Polling Interval**: How often to update vehicle data (60-3600 seconds, default 180)

## Limitations

- Smart cars: Data no longer available after 2025-01-06
- Geofencing features are only available to primary account
- Some features may not be available depending on your vehicle model and region
- API rate limiting may affect frequent updates

## Troubleshooting

### Authentication Failed
- Ensure you're using the correct email and password
- Disable 2FA on your Mercedes Me account
- Try logging into the Mercedes Me mobile app first
- Check if your account is blocked (try official app)

### Commands Not Working
- Verify PIN is correctly set in device settings
- Check if your vehicle supports the command
- Ensure you're not sending commands too frequently (rate limiting)
- Some commands may not work when the vehicle is in certain states

### Data Not Updating
- Check polling interval in device settings
- Ensure your vehicle is connected to Mercedes Me servers
- Try restarting the Homey app
- Re-authenticate if data is very stale

## Privacy & Data

This app communicates directly with Mercedes-Benz servers:
- Login URL: https://id.mercedes-benz.com
- API URL: Region-specific Mercedes-Benz mobile SDK endpoints
- All communication uses HTTPS
- Credentials are stored securely in Homey
- No data is sent to third parties

## Credits

Based on the excellent [mbapi2020](https://github.com/ReneNulschDE/mbapi2020) Home Assistant integration by ReneNulschDE.

## Support

Found a bug or have a feature request?
Please report it on [GitHub Issues](https://github.com/yourusername/com.mercedes.mbapi/issues)

## Disclaimer

This app is not affiliated with, endorsed by, or connected to Mercedes-Benz AG or Daimler AG. All product names, logos, and brands are property of their respective owners.

Use at your own risk. The authors are not responsible for any damage to your vehicle or account.

## License

GPL-3.0 License - see LICENSE file for details
