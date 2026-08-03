# Working on this app with Claude Code

Notes for future sessions. The most useful thing here is the **live log
watcher** — testing this app means driving a real car from a real Homey, and
without a way to watch what the app does you are guessing.

## Watching the app run on the real Homey

There is no local run: `homey app run` needs Docker, which is not installed.
Use `--remote`, which builds locally and installs onto the Homey itself,
streaming its stdout back.

**1. Deploy in the background** (it runs until stopped):

```
npx homey app run --remote
```

Run it with `run_in_background: true`. The harness writes the stream to a
file and gives you its path — that file is the log.

**Do not pipe it through PowerShell** (`| Select-String`, `| Tee-Object`):
the pipeline buffers and you see nothing until the process exits, which for
a long-running app is never.

**2. Arm the watcher** with the `Monitor` tool, tailing that file:

```
tail -f "<output-file>" | grep -E --line-buffered \
  "\[WS\]|\[FLOW\]|\[TRIGGER\]|\[err\]|Setting charging|HTTP 4[0-9][0-9]|Uncaught|Running \`"
```

Use `persistent: true`. Each matching line arrives as a notification while
you keep working, so you see commands and failures as they happen.

**Filter discipline.** `grep -E "[Ee]rror"` floods: the vehicle payload
contains `vehiclePositionErrorCode`, so every routine position update
matches. Key off Homey's own `[err]` level marker instead, plus the specific
tags you care about. A monitor that produces too many events gets stopped
automatically.

**3. Redeploying.** Stop the monitor *and* the app task (`TaskStop` both),
then start a fresh `homey app run --remote` and re-arm the monitor on the
new output file. Each deploy gets a new file.

## What the log tells you

Tags: `[WS]` websocket/commands, `[FLOW]` flow actions, `[TRIGGER]` trigger
cards, `[UPDATE]` capability writes, `[POLL]` REST poll, `[PARSER]` protobuf.

A command's life:

```
[FLOW] Close windows action triggered
[WS] Sending command <id> on the existing session <session>
[WS] Command <id> accepted (ACKED_BY_APPTWIN)      ← 60-300 ms, Flow answered here
[FLOW] Windows closed successfully
[WS] Command <id> (windowsClose) confirmed complete at the vehicle   ← 8-13 s later
```

Measured completion times: window commands 7.5-12.8 s, unlock ~4 s. If a
command fails after acceptance you get `FAILED at the vehicle, after the
Flow had already returned` plus a `[TRIGGER]` line.

## Things that look like bugs but are not

- **HTTP 429 on every app restart.** Restarting tears down the old session
  and handshakes seconds later; Mercedes answers 429. The 429 recovery path
  does a full re-login and reconnects in ~12 s. Expected, not a fault.
- **1001 "Going away" every ~13 minutes.** Mercedes rotates connections.
  Reconnect takes ~150 ms.
- **The Flow editor's Test button reports timeouts that did not happen.** It
  abandons a run after well under 30 s and blames whichever card it was
  nearest. Any Flow with a delay will show a timeout even though every card
  succeeded and the Flow ran to completion — verified at both 30 s and 120 s
  delays, with cards returning in under 150 ms. Test flows from the phone or
  a real trigger card; judge by the log and the car, never by the Test view.
  This cost a lot of time and two wrong diagnoses before it was pinned down.

## Hard-won facts about the Mercedes API

- **Acceptance is not completion.** `ACKED_BY_APPTWIN` means the backend took
  the request. The car reports `FINISHED` ~8-13 s later — past what a Homey
  Flow card can wait for, so cards resolve on acceptance and late failures go
  to the `command_failed` trigger. Do not "fix" this by waiting for
  completion; it was tried and it fails (see below).
- **The status stream stalls.** One capture went completely silent for
  34.5 s — no statuses, no `vepUpdates` — then flushed the backlog in a burst
  with six duplicate `FINISHED` frames, and dropped 83 s later. Any design
  that blocks on completion breaks when this happens.
- **Two commands close together fail.** The second is refused with
  `CMD_REJECTED_BY_QUEUE`. Do not overlap test runs.
- **Nil attributes never reach `data`.** The parser drops attributes Mercedes
  sends as `nilValue`, so `if (data.x !== undefined)` never runs for them.
  `chargingPower` is nil whenever the car is not charging, which left
  `onoff_charging` stuck true forever. When deriving state, prefer an
  attribute the car always sends (`chargingactive`, `chargingstatus`) over
  one that disappears.
- **PIN-gated commands** (open windows, open/tilt sunroof) need the PIN in
  device settings. Re-pairing wipes it, along with the widget's device
  selection — the widget stores the Homey device ID, and re-pairing mints a
  new one.

## Checks before shipping

```
npm test                              # node:test, no network
npx homey app validate --level publish
npx homey app build                   # regenerates app.json from .homeycompose
```

`app.json` is generated — edit `.homeycompose/` and rebuild. Version lives in
`.homeycompose/app.json`; add a matching `.homeychangelog.json` entry with
`en`/`nl`/`de` text.

`require()`ing a driver or device file outside Homey fails with
`Class extends value undefined` — that is the runtime being absent, not a
syntax error. Use `node --check <file>` instead.
