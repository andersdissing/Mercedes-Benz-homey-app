# Log PII redaction

Strips personally identifiable / account-linkable data out of this app's logs before they're shared, submitted to support, or committed.

There are two layers, sharing one detection engine (`lib/redact.js`):

1. **Runtime redaction (primary defense)** — `lib/log-redactor.js` wraps `this.log`/`this.error` on the App, Driver, and Device instances (`app.js`, `drivers/mercedes-vehicle/driver.js`, `drivers/mercedes-vehicle/device.js`), as the very first thing each does in `onInit()`. Every log line the app writes from then on is redacted before it reaches Homey's log buffer — including everything logged by `lib/api.js`, `lib/websocket.js`, and `lib/oauth.js`, since they all log via `this.homey.app.log(...)`, which is the same wrapped App method. This is what actually keeps VIN/coordinates/zone names out of a user's "Send Diagnostic Report" — nothing to run, nothing to remember.
2. **`scripts/redact-log.js` (safety net)** — a standalone CLI for logs that predate this fix, come from an older app version, or get pasted into a GitHub issue by hand.

Note: the `[Device:<uuid>]` / `[MercedesMeApp]` tags visible in `homey app log` output are intentionally left alone. That UUID is a random Homey-internal device identifier — it doesn't map to anything outside the user's own Homey install, doesn't identify the person or the car, and shows up in every Homey app's diagnostics. Not PII, so nothing to redact there.

## CLI usage

```sh
# In-place: writes <file>.redacted next to each input, leaves the original untouched
node scripts/redact-log.js app.log
node scripts/redact-log.js app1.log app2.log

# Piped
cat app.log | node scripts/redact-log.js -

# Deterministic pseudonyms instead of blanket placeholders (same raw value
# -> same token everywhere, so you can still correlate lines while debugging)
node scripts/redact-log.js --pseudonymize --salt "$(openssl rand -hex 16)" app.log
# or: REDACT_SALT=... node scripts/redact-log.js --pseudonymize app.log
```

Exit code is non-zero (and, in file mode, no `.redacted` file is written) if the self-verify pass finds any raw PII still present in the output. That's the acceptance gate — treat a non-zero exit as "do not share this log."

Run the tests with:

```sh
node --test scripts/redact-log.test.js lib/log-redactor.test.js
```

## What's redacted

| Type | Example source | Placeholder |
|---|---|---|
| VIN (plaintext) | `VIN: WDB...`, `"vin":"..."`, `for <VIN>` in geofence violations | `[VIN_REDACTED]` |
| VIN (hex-encoded) | `First 50 bytes (hex): 1211...` protobuf dumps | `[HEX_VIN_REDACTED]` |
| VIN (base64-encoded) | any base64 blob that decodes to a known VIN | `[HEX_VIN_REDACTED]` |
| GPS coordinates | `Setting location: <lat>, <lon>`, `Setting latitude/longitude from geofence:`, `"latitude"/"longitude"` in JSON | `[LAT_REDACTED]` / `[LON_REDACTED]` |
| Geofence zone name | `"name":"..."` inside a geofence snapshot | `[ZONE_NAME_REDACTED]` |
| Geofence/account IDs | `"fenceId":<n>`, top-level `,"id":<n>` (6+ digits) on a violation | `[FENCE_ID_REDACTED]` / `[VIOLATION_ID_REDACTED]` |
| Log submission ID | `Log ID: <uuid>` | `[LOG_ID_REDACTED]` |

With `--pseudonymize`, each placeholder gets a stable 8-hex-char suffix derived from an HMAC-SHA256 of the raw value and your salt (e.g. `[VIN_REDACTED_7FDCCB56]`) — same input always produces the same token for a given salt, but the raw value isn't recoverable from it.

Structural zeros are left alone on purpose: a geofence snapshot's own `"id":0` field is not an account-linked ID and stays as-is; only the outer violation `id` (a large real integer) is redacted.

## What's preserved

Tire pressure, battery %, odometer, ranges, eco scores, timestamps, headings, door/window/charging state values, and everything else that's operational telemetry rather than an identifier. Over-redaction defeats the point — a scrubbed log still needs to be useful for debugging.

## Detection order matters

1. **Exact-match, context-anchored** — canonical values found via a labeled context (`VIN:`, `Log ID:`, `"fenceId":`, etc.) are redacted at that spot, and every other literal occurrence of that same value elsewhere in the log is redacted too.
2. **Generic regex fallback** — catches VIN-shaped tokens that show up without a recognized label (future log formats).
3. **Encoded-blob pass** — runs last, on purpose. Hex dumps (`(hex): ...`) are decoded and checked for a VIN substring (from step 1/2, or a fresh regex match on the decoded bytes); only the matching hex slice is replaced, so the surrounding protobuf framing bytes stay readable. Base64 tokens get the same treatment. Doing this last means a VIN that was already redacted in plaintext is still in `knownVins` and gets caught inside its encoded copy too — a naive scrubber that only does plaintext regex passes misses this.

## Fix at source

This is done — see "Runtime redaction" above. `lib/log-redactor.js` is the `redact()`-before-writing fix; the CLI script remains useful only for logs that were captured before this was wired in, or that come from third parties.
