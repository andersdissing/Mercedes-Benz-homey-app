# Working on this app with Claude Code

Notes for future sessions. The most useful thing here is the **live log
watcher**: testing this app means driving a real car from a real Homey, and
without a way to watch what the app does you are guessing.

## Check main first

Work on this app tends to happen in bursts across sessions. Before starting,
`git fetch` and read what landed on `main` — a session once rebuilt command
tracking that main had already shipped in a better form, and only found out
at merge time. `git log --oneline HEAD..origin/main` costs nothing.

## Watching the app run on the real Homey

There is no local run: `homey app run` needs Docker, which is not installed.
Use `--remote`, which builds locally, installs onto the Homey itself and
streams its stdout back.

**1. Deploy in the background** — run this with `run_in_background: true`:

```
npx homey app run --remote
```

The harness writes the stream to a file and returns its path. That file is
the log.

**Do not pipe it through PowerShell** (`| Select-String`, `| Tee-Object`):
the pipeline buffers and you see nothing until the process exits, which for
a long-running app is never.

**2. Arm the watcher** with the `Monitor` tool, `persistent: true`:

```
tail -f "<output-file>" | grep -E --line-buffered \
  "\[WS\]|\[FLOW\]|\[TRIGGER\]|\[err\]|Setting charging|HTTP 4[0-9][0-9]|Uncaught|Running \`"
```

Each matching line arrives as a notification while you keep working, so you
see commands and failures as they happen.

**Filter discipline.** `grep -E "[Ee]rror"` floods: the vehicle payload
contains `vehiclePositionErrorCode`, so every routine position update
matches. Key off Homey's own `[err]` level marker plus the specific tags you
want. A monitor producing too many events gets stopped automatically.

**3. Redeploying.** `TaskStop` both the monitor and the app task, start a
fresh `homey app run --remote`, and re-arm the monitor on the new output
file — each deploy writes to a new path.

## What the log tells you

Tags: `[WS]` websocket/commands, `[FLOW]` flow actions, `[TRIGGER]` trigger
cards, `[UPDATE]` capability writes, `[POLL]` REST poll, `[PARSER]` protobuf.

A command's life:

```
[FLOW] Close windows action triggered
[WS] Sending command <id> on the existing session <session>
[WS] Command <id> accepted (ACKED_BY_APPTWIN) - still open at Mercedes
[FLOW] Windows closed successfully                    ← caller answered, 60-300 ms
[WS] Command <id> finished                            ← 8-13 s later
```

Measured: acceptance 59-290 ms, window commands complete in 7.5-12.8 s,
unlock ~4 s. Faster when the car is already awake.

The idle cycle (1.1.54), on a parked car, repeats every ~90 s:

```
[WS] Connected to Mercedes WebSocket
[WS] No data from the car for 30s - closing the connection until it is needed
[WS] Connection closed while idle - next connection in 60s
```

Once an hour: `[WS] Connection stats for the last 60 min: handshakes=…
(open=, 429=, failed=), closes: idle=, 1001=, drop=, other=, commands: …`.

## Reading the 60-day connection timeline

The same counts, by clock hour, are kept for 60 days in `homey.settings`
(`lib/stats-timeline.js`) and served by `GET /stats`:

```
npx homey@4 api raw --path /api/app/com.mercedes.mbapi/stats --json
```

The CLI pinned in `devDependencies` (3.9.x) has no `api` command; 4.x does.
The endpoint is `"public": false` — Homey has no owner-only option for app
endpoints, so "not public" means a token for this Homey is required. The
response carries its own legend (`keys`). Records hold an hour and counters
only (`t`, `h`, `c`, `i`, `k`, `w`, `l`) — a test drives the real pipeline with a
VIN, e-mail, position and token and checks none of them gets in. `w` counts
the times a car sent a newer `vtime` (its own clock at its last report, read
as local time): a car waking and reporting, beside the app's own handshakes
in `h`. `l` counts the logins the push connection asked for: ahead of the
session limit (see the 18-hour fact below), after 429s, and failed. Counted
in memory, written hourly and in the app's `onUninit`; the hour in progress
is stored as `cur` and resumed after a restart in the same hour, so an hour
is not counted twice. The `onUninit` write does not land when an install
replaces the app, so an install can cost what was counted since the last
hourly write. A missing hour means the app was not running.

## Things that look like bugs but are not

- **HTTP 429 on every app restart.** Restarting tears down the old session
  and handshakes seconds later; Mercedes answers 429. Recovery re-authenticates
  and reconnects in ~12 s. Expected — and the reason the first backoff window
  is 30 s, not minutes: a long opening window bills every app update for a
  block that was already over.
- **The push connection is closed most of the time.** On purpose since
  1.1.54: closed 30 s after the last frame from the car, back 60 s later, so
  a parked car handshakes about 40 times an hour. The health check and the
  staleness warning treat that rest as healthy (`isResting()`).
- **1001 "Going away" every ~13 minutes.** Mercedes rotates connections. It
  shows on a connection held open (ignition on, command under way or sent
  < 180 s ago), and while that hold lasts the app reconnects at once, as
  mbapi2020 does. Only with nothing holding the connection does a 1001 wait
  the 60 s cycle.
- **The Flow editor's Test button reports timeouts that never happened.** It
  abandons a run after well under 30 s and blames whichever card it was
  nearest, so any Flow with a delay shows a timeout even though every card
  succeeded and the Flow ran to completion — confirmed at 30 s and 120 s
  delays with cards returning in under 150 ms. Test from the phone or a real
  trigger card and judge by the log and the car. This cost a session most of
  an afternoon and two wrong diagnoses.

## Hard-won facts about the Mercedes API

- **Acceptance is not completion, and the caller ends before the command
  does.** `ACKED_BY_APPTWIN` means the backend took the request; the car
  reports `FINISHED` ~8-13 s later. `COMMAND_CALLER_TIMEOUT` (90 s) bounds
  the flow card, `COMMAND_TRACKING_TIMEOUT` (5 min) bounds the app's belief
  that the command is still open. Do not collapse these into one.
- **Do not make the flow card wait for completion.** It was tried. Beyond the
  delay it adds, completion rides a stream that stalls: one capture went
  silent for 34.5 s — no statuses, no `vepUpdates` — then flushed the backlog
  in a burst of six duplicate `FINISHED` frames and dropped 83 s later. The
  car had done the job throughout.
- **Mercedes refuses a command while one is open** for the vehicle
  (`RIS_COULD_NOT_SEND_COMMAND`). The app holds a new command rather than
  letting it be refused — see `_awaitPreviousCommandCompletion()`.
- **A refreshed token does not clear a WebSocket 429; a full login does.**
  Measured on a live block (4 Aug 2026): three consecutive refusals, each one
  after a successfully refreshed token, then one `oauth.login()` and the
  socket opened in 194 ms. The refusal is about the session, and a refresh
  returns a token for the session being refused. Hence the re-login
  escalation on the second strike — at most one per backoff window, because a
  login is the heaviest request the app makes. It was one per episode until
  the 12 Aug 2026 outage showed a single failed login ending recovery for a
  five-hour block; mbapi2020 budgets three the same way
  (`MAX_RELOGIN_ATTEMPTS`, incremented on failure). Three per *episode* was
  still too few, as #81 showed: the ladder caps at half an hour on the fifth
  strike, so a long block spends every login in its first ten minutes and then
  knocks half-hourly with nothing but the refresh that cannot work — nine
  hours of `Will re-authenticate before the next attempt (1/3)` →
  `Token refresh successful` → 429. The budget now bounds how *closely spaced*
  logins can be, not how many an outage gets: once the window is at the cap,
  the knock the app was going to make anyway is spent on a login instead of a
  refresh.
- **A session is refused at about 18 hours old, so it is renewed at 16.**
  The idle-close test build on a parked car (15-18 Oct 2026, read from
  `GET /stats`)
  met two WebSocket 429s every 18 hours, in the same clock hour each time:
  20:00, 14:00, 08:00, 02:00, 20:00. Each episode was a refreshed token
  refused again and then the escalation's login let through, and that login
  started the next 18 hours. With hourly records that puts the limit within
  about a quarter of an hour of 18 h. So `login()` stamps the token with
  `logged_in_at`, a refresh carries the stamp over, and `connectOrThrow()`
  logs in before the handshake once the session is 16 h old
  (`SESSION_RENEW_AFTER`; a token without the stamp counts as due). Sixteen,
  not seventeen, in case the limit counts handshakes: about 680 went by
  between episodes, and the interval with a drive had fewer and still lasted
  18 h. A failed renewal still handshakes and is retried 15 min later.
  Whether this ends the 429s is read from `l[0]` and `h[1]` in `GET /stats`.
- **There is no REST source for doors, windows, lock or sunroof.** Checked
  against mbapi2020's `webapi.py` (Aug 2026): the only vehicle-state REST
  endpoint anyone knows is the widget `vehicleattributes` one the app already
  polls, and it carries only the ~15-attribute subset (position, ranges, SoC
  — visible in any `[POLL]` log line). Commands likewise travel only over the
  push session. So during a WebSocket 429 block those capabilities *cannot*
  be refreshed from anywhere; the only lever on their staleness is how fast
  the episode ends. Don't go looking for a fallback endpoint again.
- **The re-login only ever worked when the SSO session had already expired.**
  While the identity provider still recognises the previous login — the
  normal state during an outage, since a login already ran in that process —
  `/as/authorization.oauth2` skips the login form and 302s straight to
  `rismycar://login-callback?code=...`. follow-redirects cannot follow that
  scheme and threw `ERR_FR_REDIRECTION_FAILURE`, killing the login and
  discarding the code Mercedes had just issued. That is how a user sat behind
  a WebSocket 429 for 4 h 50 min on v1.1.44 (12 Aug 2026 report): every
  escalation crashed, and only a Homey restart cleared it. Two-part fix in
  `lib/oauth.js`: `login()` calls `_resetSession()` first (drops the old
  session's cookies, so a *new* session — the whole point of the escalation —
  is actually opened), and `_getAuthorizationResume()` captures a
  `rismycar://` Location via axios' `beforeRedirect` hook and returns
  `{code}` so a short-circuit becomes a code grant instead of a crash. The
  hook is the only place that Location is reachable; tested against a real
  local server in `test/oauth-sso-short-circuit.test.js`.
- **The 429 on the WebSocket upgrade is not an account-wide block.** Every
  capture says so: the upgrade is refused while the widget and geofencing
  endpoints answer 200 in the same second, and the three-day outage in issue
  #69 polled successfully throughout. v1.1.42 assumed one limit and stood the
  poll down for a refused socket, which froze battery, range and position on
  top of the capabilities that were already stale and bought nothing back.
  The two windows are tracked separately — `getWebSocketRateLimitRemaining()`
  and `getRestRateLimitRemaining()`. Don't merge them again.
- **The 429's own answer beats any ladder — and reading it means owning the
  teardown.** Every backoff window used to be invented: the only thing taken
  off a refused upgrade was the status code, scraped out of `ws`'s error
  *message*. The response itself is reachable only through an
  `unexpected-response` listener, and `emit()` returning true is exactly what
  makes `ws` skip its own `abortHandshake()` — so listening for it means the
  request is never destroyed and the failure never reported, and the connect
  promise hangs forever (the dead-end class of #47 and #57). The listener
  drains the body and calls `socket.terminate()`, which runs the same abort
  `ws` would have; destroying the request by hand instead leaves the client
  stuck in CONNECTING with no `close` ever emitted. It then reports the
  failure itself, because that abort announces itself as "WebSocket was closed
  before the connection was established" with no status in it — a 429 reported
  that way is a transport blip, and neither the backoff, the token refresh nor
  the re-login escalation runs.
- **Mercedes sends no `Retry-After` on the WebSocket 429 — measured, so stop
  wondering.** Captured on the routine restart 429 (7 Aug 2026), the refusal
  carried exactly: `content-security-policy, referrer-policy,
  strict-transport-security, vary, x-content-type-options, x-frame-options,
  x-permitted-cross-domain-policies, date, content-length`. No `Retry-After`,
  no `x-ratelimit-*`, nothing about the limit at all. The escalating ladder is
  therefore the real mechanism on this path and not a placeholder. The app
  reads the header anyway and prefers it when present, which costs nothing and
  is the only way a change on Mercedes' side gets noticed; whether the *REST*
  429 carries one is still unmeasured, because REST answers 200 through a
  refused upgrade. Both paths log what they were sent
  (`[WS] Handshake refused with HTTP 429 - rate-limit headers: ...`,
  `[API] REST refused with HTTP 429 - ...`), so the next block re-checks this
  for free.
- **One push session per account, not per car.** The stream is account-wide —
  `vepUpdates.updates` and `apptwin_command_status_updates_by_vin` arrive keyed
  by VIN and every device drops the keys that are not its own — so a second
  session buys nothing and costs a second login, a second APP-SESSION-ID, a
  second handshake on every app start and, once refused, a second 429 backoff
  ladder. #81 is what that looks like from the log: two interleaved
  `consecutive rate-limited attempts` series counting up separately (9 at
  12:58 and 9 at 13:06, 10 at 13:28 and 10 at 13:36, …), each backing off half
  an hour, so the account was knocked every fifteen minutes and never got the
  quiet period the ladder exists to buy — nine hours, two cars, no recovery.
  `lib/account-session.js` owns one OAuth, one `MercedesAPI` and one socket per
  account now, keyed on login+region (*not* deviceGuid — that differs between
  pairing runs of the same account); devices attach by VIN and the session
  fans updates back out. Commands are gated per VIN for the same reason
  Mercedes refuses them per VIN. mbapi2020 keeps one connection per account
  too. Don't give a device its own client again.
- **APP-SESSION-ID must outlive the WebSocket client object.** The client is
  rebuilt on every recovery (`MercedesAPI.connectWebSocket`), so a session id
  minted in its constructor meant a new app session every few minutes during
  an outage while the earlier ones were still live at Mercedes. `MercedesAPI`
  owns it now; mbapi2020 keeps one per integration lifetime.
- **`precondActive` is not "preconditioning is running".** A manual start -
  the Preheat button in the Mercedes me app, or our own command - flips
  `precondNow`; only a departure-time start flips `precondActive`. Driving
  climate_active from `precondActive` alone meant every manual start from
  the me app went unseen (#73). mbapi2020 ORs the two with precondState's
  activation flag; `lib/precond-status.js` does the same, with last-known
  values merged because partial pushes carry only what changed. And
  `precondState` field 3 - the one varint ever seen, 1 on an idle car - is
  `precond_immediate_support`, not a state; the running flag is field 1,
  omitted when false (layout read out of mbapi2020's `vehicle_events_pb2.py`).
- **Nil attributes never reach `data`.** The parser drops attributes Mercedes
  sends as `nilValue`, so `if (data.x !== undefined)` never runs for them.
  `chargingPower` is nil whenever the car is not charging, which left
  `onoff_charging` stuck true forever and the widget animating a charging
  battery on an unplugged car. Prefer an attribute the car always sends
  (`chargingactive`, `chargingstatus`) over one that disappears.
- **The push connection idles out, as mbapi2020's does (1.1.54).** Holding
  it open around the clock - ping every 20 s, the health check reconnecting
  at once - is the suspected cause of hours-long WebSocket 429 blocks, during
  which no command (preheat included) gets through. mbapi2020 closes after
  30 s without data and reconnects 60 s later and is not seen blocked. The
  rules, all in `lib/websocket.js`: 30 s after the last *frame* (a pong is
  not data); held open while any car on the account has `ignitionstate` 4
  (mbapi2020's definition - the `ignition_on` capability also counts 1/2),
  while a command is queued or awaiting its caller, and for 180 s after a
  command is sent (an accepted command that never finishes holds no longer
  than that); after our own idle close, the next handshake is 60 s later
  (mbapi2020's `RECONNECT_WATCHDOG_TIMEOUT`); after Mercedes closes it or it
  drops (1001, 1000, 1006, liveness timeout), it comes back at once while a
  hold applies - mbapi2020 reconnects at once after *any* server close
  (`websocket.py` 440-443, 525-544) - but at most once per 60 s, a brake
  mbapi2020 does not have, against a connection closed straight after it
  opens; with no hold, 60 s, which is this app's own choice and not
  mbapi2020's; a command skips any wait but never a 429 window; ping every
  32 s. The 429 ladder clears after 5 min of stable
  connection (1dab8c4) *or* 5 clean idle cycles in a row - one is not
  enough, that is #83's loop.
- **A failed upgrade is not a closed connection.** `ws` reports every failed
  upgrade - 429, 401, 418, ECONNREFUSED, timeout - as `'error'` and then
  `'close'` 1006, on a socket that never opened, and after a network event the
  close runs *before* `connect()`'s catch. Ask the `opened` flag set in the
  `'open'` handler, never `settled`: taking that close for an open
  connection's put every refusal on the flat 60 s cycle, skipped the failure
  backoff and the ladder's 30 s first step, and counted refusals as drops. A
  scripted test socket must fail the same way (error, then close 1006) and
  deliver refusals from a macrotask (`fromNetwork()` in
  `test/websocket-idle-cycle.test.js`) - emitted from promise code the order
  inverts and the bug hides; the real-`ws` tests in
  `test/websocket-handshake-response.test.js` pin it.
- **PIN-gated commands** (open windows, open/tilt sunroof) need the PIN in
  device settings. Re-pairing wipes it, along with the widget's device
  selection — the widget stores the Homey device ID and re-pairing mints a
  new one.

## Checks before shipping

```
npm test                              # node:test, no network
npx homey app validate --level publish
npx homey app build                   # regenerates app.json from .homeycompose
```

`app.json` is generated — edit `.homeycompose/` and rebuild. Version lives in
`.homeycompose/app.json`; add a matching `.homeychangelog.json` entry with
`en`/`nl`/`de` text. Publishing is the `publish.yml` workflow, which is
`workflow_dispatch` only and runs against the default branch.

`require()`ing a driver or device file outside Homey fails with
`Class extends value undefined` — that is the runtime being absent, not a
syntax error. Use `node --check <file>` for syntax. To *test* `device.js` or
`app.js`, put a stand-in for `homey` in `require.cache` first (`exports:
{ Device: class {} }` or `{ App: class {} }`) and call methods on
`Object.create(Class.prototype)` - see `loadDeviceClass()` in
`test/websocket-idle-cycle.test.js`. That tests the real code; a copy of its
logic in the test does not.

Timer tests use `node:test`'s `mock.timers`. Its `tick(ms)` moves the clock
to the *end* before running what fell due, so a timer armed inside a callback
starts from the wrong time - step in small increments (`advance()` in
`test/websocket-idle-cycle.test.js`) when timers chain.
