# OpenTime

A lean, local-first automatic time tracker for Windows and macOS.

OpenTime runs quietly in the tray, notices which application and window you are
actually working in, and turns that into a timeline, a category breakdown, and a
focus score — with your calendar overlaid beside it. No timers to start. No
screenshots. No account, no server, no subscription: everything stays in a folder
on your machine that you can open, export, back up or delete.

Two global shortcuts work from anywhere, window or not: `Ctrl/Cmd+Alt+O` shows
or hides it, `Ctrl/Cmd+Alt+P` toggles pause — the tray menu has both too, plus
timed pauses (15/30/60 minutes, or until you resume).

When you want to declare rather than observe, start a **focus session**: name the
work, pick a length, optionally play an ambient bed, and it lands on the timeline
as one block when you stop.

![The day calendar](docs/screenshots/calendar.png)

---

## Contents

- [What it does](#what-it-does)
- [Running it](#running-it)
- [Architecture](#architecture)
- [Performance notes](#performance-notes)
- [Storage](#storage)
- [Your data](#your-data)
- [Google Calendar](#google-calendar)
- [Privacy](#privacy)
- [Packaging for Windows and macOS](#packaging-for-windows-and-macos)
- [Testing](#testing)
- [What is not built yet](#what-is-not-built-yet)
- [Relationship to the older Norte tracker](#relationship-to-the-older-norte-tracker)

A category-by-category account of what is shipped, what is deferred, and what
was left out on purpose is in [`docs/feature-inventory.md`](docs/feature-inventory.md).

---

## What it does

**Automatic tracking.** A background loop samples the OS focused window every few
seconds and groups consecutive samples into sessions. Nothing to start or stop.

**Idle detection.** When the OS reports no keyboard or mouse input for longer
than your threshold, the open session closes at its last observed sample and the
loop drops to a 30-second heartbeat that does nothing but watch for your return.
Time away is recorded as an explicit *Away* block, never as work.

**Categorisation.** Sessions resolve to a category through a fixed precedence:
an explicit per-app rule, then a learned keyword rule, then your project
keywords, then `Uncategorized`. Correct a block on the timeline, choose "Whole
app" or "Matching text", and the correction becomes a permanent rule.

**Focus and distraction.** Every session is classified productive / neutral /
distracting. The daily focus score is the productive share of tracked time,
scaled down by how fragmented that time was — the same four hours score worse
when they were chopped into forty pieces.

**Corrections that go beyond relabelling.** Split a block that was really two
pieces of work, merge blocks that were really one, delete one that should not
exist, add time that happened away from the machine, or claim an away block as
work — "I was in a meeting". Claiming a block removes it, so the same minutes are
never counted twice.

**Goals.** Floors and ceilings on a slice of time, daily or weekly. Progress is
paced against how much of the window has elapsed, so a weekly goal is not
"behind" every Monday by construction. No streaks, no badges, and both starter
goals ship switched off.

**Insights.** The few observations worth making out loud: when your focus
actually peaks, how fragmented the day was, what the meetings cost, and how today
compares to your *own* recent baseline. The panel renders nothing when there is
nothing worth saying.

**A day calendar, not a list.** The main view is an hour grid with a column per
kind of work: contiguous sessions fold into one entry, so a morning of real work
is a handful of readable blocks rather than fifty slivers. Folding never changes
a number — an entry's duration is the sum of the sessions in it, so the gaps
between them are still not credited as work. Click a block for the detail card:
what it was, how long, which apps and sites it was spent in, and the corrections.

**Summary column.** Pinned beside the grid: hours worked against yesterday,
progress against a goal you switched on, the day's breakdown as a donut by
category, project or app, and how the time was spent across focus, neutral,
distraction and away.

**Calendar overlay.** Meetings take their own column on the grid, drawn as plans
rather than records, so time in meetings and time in deep work are visible
against each other.

**Focus sessions.** Start a session, name what you are about to do, pick a
length and — if it helps — an ambient bed, and the app gets out of the way: a
dock with the countdown, a way to add fifteen minutes, and a way to stop. It is
not a second tracker. Capture runs throughout exactly as it always does, and
ending the session *seals* it — the rows already recorded for those minutes are
stamped with the session's name, and only the minutes nothing was observed for
are filled in. So the session becomes one block on the timeline with the real
apps still underneath it, and none of the time is counted twice.

The ambient beds are synthesised on your machine from filtered noise. There are
no audio files in the bundle and nothing is streamed.

![Starting a focus session](docs/screenshots/focus.png)

**Music timer.** Background listening with a countdown, separate from a focus
session because it has no consequence for your tracked time at all — pick a
track (lo-fi, whale song, alpha waves, or an original classical-style motif),
pick a length or leave it open-ended, and it plays until you stop it. Three of
the four tracks are generated on your machine the same way the ambient beds
are; the one real recording is a public-domain NOAA field recording, bundled
locally with its source and license on record in
[`docs/audio-licenses.md`](docs/audio-licenses.md). A focus session and a
music timer can run at once.

**Reports over any range.** Week, month, quarter, year, or two dates you pick.
Stepping is by the calendar — the month before March is February, not thirty days
ago — and a custom range slides by its own length. Short ranges get a column per
day, a month also gets a real calendar grid, and a year gets a cell per day laid
out in week columns.

**Light and dark.** Both themes ship and both are looked at — `npx electron
scripts/screenshot.cjs <dir> --theme=both` captures each view in each, and
refuses to write a capture whose resolved `color-scheme` is not the one asked
for. Settings → Appearance follows the OS or pins one.

**Export and backup.** Sessions CSV, a daily-summary CSV, and a full JSON backup
that restores everything. The data is one plain-JSON file per day in a folder you
can open, copy or delete.

![Reports](docs/screenshots/reports.png)

---

## Running it

Requires Node 20+.

```bash
npm install          # the native capture module is an optionalDependency; a failure here is not fatal
npm run dev          # Vite dev server + esbuild watch + Electron
npm test             # unit tests (no Electron needed)
npm run typecheck    # tsc --noEmit
npm run build        # production build into dist/
npm start            # build, then run the app
```

Useful extras:

```bash
npm run package:win  # NSIS installer
npm run package:mac  # dmg
npx electron scripts/screenshot.cjs docs/screenshots   # capture the UI headlessly
```

### If OS capture is not available

`@miniben90/x-win` reads the focused window on Windows, macOS and X11. It cannot
work on Wayland, in containers, or over most remote sessions — Wayland does not
expose the focused window to other applications at all.

On those systems OpenTime does not fail: it falls back to a **demo capture
adapter**, and — only when capture is genuinely unavailable — seeds a fortnight of
realistic history so the app is usable and reviewable. That gate matters. Seeding
synthetic days into a working install would put fiction in someone's real
records; you can also switch seeding off in Settings and get an honest empty
dashboard instead.

Every synthetic row carries `source: 'demo'`, says so in the UI and in exports,
and **Settings → Your data → Remove demo data** deletes exactly the seeded days
plus any demo-adapter rows that landed in a real day. The demo data is generated
through the *real* `SessionBuilder`, so only the window samples are synthetic —
every line of categorisation, splitting and aggregation is the shipping code.

**macOS needs Accessibility**, and its absence is not obvious: without it `x-win`
still loads and still returns an app name while every window title comes back
empty, so the app looks like it is working and records nothing useful. OpenTime
checks the permission directly, says so on the Today view and in Settings, and
`Check again` rebuilds the capture adapter in place — no restart after granting
it.

One detail worth knowing: the native module is probed **in a child process**.
It is a Rust addon, and on an unsupported session it does not throw — it panics,
which aborts the host process. A panic unwinding through napi cannot be caught
by `try/catch`, so probing in-process would kill the app at boot on exactly the
machines that need the fallback. See `src/main/capture/index.ts`.

---

## Architecture

```
src/
  core/          pure logic — no Electron, no I/O, no DOM. Shared by main and renderer.
    types.ts       domain types (the IPC contract's vocabulary)
    day.ts         tracking-day math (configurable rollover hour, local time only)
    categorize.ts  rule precedence + productivity classification
    sessions.ts    SessionBuilder: samples in, batched sessions out
    aggregate.ts   every number the dashboard shows
    edits.ts       split / merge / retime / manual entry / claim an away block
    goals.ts       floors and ceilings on a slice of time
    insights.ts    the few observations worth making out loud
    export.ts      CSV and backup formats
    demo.ts        seeded generator for demo history and the demo adapter
    defaults.ts    factory settings, projects, seed rules, settings validation
  main/          Electron main process
    main.ts        window, tray, IPC, boot
    tracker.ts     the active/idle polling state machine
    capture/       Capture interface + native and demo adapters
    storage/       Storage interface + the sharded, journalled file store
    edits/         applying a correction to the store
    export/        turning the store into a file's worth of bytes
    calendar/      Google OAuth wiring and Calendar REST client
  preload/       contextBridge surface (the only thing the renderer can reach)
  renderer/      React 18 + Vite
    state/         one data hook, plus a browser-only fallback client
    lib/           entry folding and column layout, colour, formatting
    components/    day grid, detail popover, summary panel, charts, inspector
    views/         Dashboard, Calendar, Activity, Projects, Goals, Reports, Settings
  shared/ipc.ts  channel names and the typed API both sides implement
tests/           vitest, node environment
```

Three deliberate boundaries:

1. **`core/` imports nothing.** No Electron, no `fs`, no React. That is why the
   engine is testable without a display, and why the renderer can reuse the exact
   aggregation the main process would compute.
2. **Everything external to `Tracker` is injected** — capture source, idle
   seconds, storage, clock. The whole idle/active state machine runs in tests
   with a fake clock and no real timers.
3. **`Storage` is an interface**, and it exposes only append and per-day read.
   That is the entire query surface the engine needs, which is what makes the
   backend swappable.

Security posture in the renderer: context isolation on, node integration off, a
strict CSP in `index.html`, and `setWindowOpenHandler` sending external links to
the system browser instead of opening an in-app window.

---

## Performance notes

The predecessor to this app was sluggish, and most of that was things that had
no business being in a time tracker's process. The rules here:

**Nothing unrelated ships.** No browser automation, no webcam/vision pipeline,
no speech models, no agent framework, no video sub-application. Runtime
dependencies: **zero**, plus one optional native module for window capture.
React and Vite are dev dependencies that compile away into a single bundle.

**Writes are batched, and bounded.** `SessionBuilder` holds one session in memory
and only emits when the category changes, a sampling gap opens, or the caller
flushes — an hour of unbroken work is one write, not 720. Those writes go to an
append-only journal (a line each) and are checkpointed into per-day files on a
debounce, so the cost of a write is a few kB regardless of how much history you
have. A test asserts that a full minute of polling persists nothing.

**Idle costs nothing.** When the OS reports idle, the sampling interval is torn
down and replaced with a 30-second heartbeat that reads one integer. The capture
module is not touched at all while you are away, and neither is the disk.

**The renderer never aggregates in a component body.** Every summary comes from
a `useMemo` keyed on payload identity. The one per-second timer in the app lives
inside `NowCard`, so the ticking clock re-renders one component rather than the
dashboard. Timeline geometry is precomputed as fractions by `buildTimeline`, so
rendering is a multiply — no layout measurement, no `getBoundingClientRect`, no
resize observers.

**The bundle is one file.** ~223 kB of JS (~69 kB gzipped) and ~24 kB of CSS,
no code splitting: this loads over `file://`, so there is no network waterfall
to optimise and one file parses fastest. Main and preload are built separately
with esbuild in ~10 ms, so a renderer change never rebuilds the main process.

**The window is allowed to be throttled.** `backgroundThrottling` stays on;
tracking lives in the main process and does not need the window awake.

---

## Storage

Everything lives in one folder under Electron's `userData` directory
(`%APPDATA%/OpenTime/opentime` on Windows, `~/Library/Application Support/OpenTime/opentime`
on macOS):

```
opentime/
  meta.json              settings, projects, rules, goals  (small, always in memory)
  days/2026-08-03.json   one tracking day's sessions, idle blocks and events
  journal.jsonl          append-only log of writes not yet checkpointed
```

Plain JSON, readable without OpenTime, and yours to copy, sync or delete.

**Durability.** Every mutation is appended to `journal.jsonl` and awaited *before*
the call returns. Day files are written on a debounce. If the machine loses power
in between, `init()` replays the journal and the write is still there. Each
journal record carries a monotonic sequence and each day file records the highest
sequence already folded into it, so replay is idempotent — that is what makes
"append now, checkpoint later" safe rather than a way to double-count sessions.

**A bounded write.** Persisting one session rewrites one day file of a few kB, not
the whole history. The v0 store rewrote everything, so the cost of a write grew
with the length of your history — exactly backwards.

**A bounded footprint.** Days are loaded on demand and evicted, so a year of data
costs about the same memory as a week. Configuration stays resident because it is
read on every tick and is tiny.

**Failure is contained.** An unreadable `meta.json` costs your settings, not your
history. An unreadable day costs that day. Both are renamed aside for forensics
rather than crash-looping the app at boot.

Upgrading from the v0 single-file store happens once at boot; the original file is
renamed to `.migrated`, never deleted.

That shape is why `Storage` splits its getters: configuration is synchronous
because it is tiny and read constantly, while day records are asynchronous so a
backend is free to answer them from disk. A SQLite implementation would slot in
behind the same interface — it is no longer needed for durability or memory, only
for indexed cross-day queries when a reporting view wants them.

---

## Your data

**Export** (Settings → Your data):

| Format | For |
|---|---|
| Sessions CSV | one row per session — a spreadsheet, or an invoice |
| Daily CSV | one row per day — a quick chart of a quarter |
| JSON backup | everything, restorable — history, settings, projects, rules, goals |

CSV times are written in your local calendar rather than UTC, because an export
that renders as UTC is an export that gets mis-added. Fields beginning `=`, `+`,
`-` or `@` are prefixed with an apostrophe: window titles are attacker-influenced
(any web page picks its own) and spreadsheets execute those on open.

**Restore** validates the file, tells you how much history it holds, and asks
before replacing anything. Backups taken from the v0 store still restore.

**Retention** is optional and off by default. When on, days past the window are
deleted from disk rather than hidden — a retention setting that only hides data is
a lie about what is on disk. It is off by default because silently destroying
someone's history to satisfy a default is not something a local-first app gets to
do.

---

## Google Calendar

OpenTime ships **no API credentials**. You create a free OAuth client in your own
Google Cloud project and paste it into Settings; it is stored only in your local
settings file and sent nowhere but Google.

Setup:

1. Google Cloud Console → new project → enable the **Google Calendar API**.
2. Credentials → **OAuth client ID** → application type **Desktop app**.
3. Add `http://127.0.0.1:47813/oauth/callback` as an authorised redirect URI.
4. Paste the client ID and secret into OpenTime → Settings → Google Calendar,
   then press **Connect**.

Scope defaults to `calendar.readonly`, which is all the overlay needs and is the
lighter path through Google's verification review. Read-write is selectable for
future write-back features.

Two implementation details, both carried over from a previous implementation
that had already hit them:

- **The auth window presents a Chrome user agent.** Google rejects OAuth in a
  window advertising Electron's default UA. The flow runs in a dedicated
  `BrowserWindow` presenting a normal Chrome UA while sharing the default
  session, so an existing Google login carries over.
- **Tokens refresh five minutes before expiry**, and an `invalid_grant` (the
  user revoked access) flips the account to disconnected instead of retrying a
  grant that will never succeed again.

Plain `fetch`, no `googleapis` SDK — one HTTP call does not justify several
megabytes in a process we want to stay small.

Without credentials you can still add events manually (`addManualEvent`), and
the demo history includes plausible meetings so the overlay is visible.

---

## Privacy

- **No screenshots, ever.** OpenTime records metadata, not pixels.
- **URLs are reduced to the host.** `https://mail.example.com/inbox/thread?token=…`
  is stored as `mail.example.com`. Paths, query strings and fragments are
  discarded before anything is persisted, so a session token or a document title
  cannot end up in the store. A test asserts this.
- **URL reading happens for browsers only** — it forces the accessibility tree
  on, so it is not done for other applications.
- **Private apps.** Anything on the ignore list is never recorded, and any open
  session closes the moment it takes focus.
- **Private subjects.** A client name, a matter number, a health portal — any
  window whose title or host contains one of your keywords is never recorded, in
  *any* application. Applications are the wrong unit for confidentiality; the
  subject is the right one.
- **No telemetry, no analytics, no network calls** other than to Google's own
  OAuth and Calendar endpoints, and only after you connect an account.
- **OpenTime never tracks itself.**

![Projects and rules](docs/screenshots/projects.png)

---

## Packaging for Windows and macOS

`electron-builder` is configured in `package.json`. Targets: NSIS on Windows
(per-user install, changeable directory), dmg on macOS.

```bash
npm run package:win
npm run package:mac
```

Notes for a real release:

- **Windows** is the priority target. The build is per-user, so it needs no
  administrator rights. Set an AppUserModelID before shipping notifications so
  they attribute correctly in the Action Center.
- **macOS** builds must be produced on macOS. Shipping outside the App Store
  requires an Apple Developer ID, codesigning and notarisation; unsigned builds
  are quarantined by Gatekeeper. macOS also gates window-title access behind
  **Accessibility** permission — the app must request it and degrade gracefully
  until it is granted.
- **The native capture module is per-platform.** `@miniben90/x-win` ships
  prebuilt binaries; build each installer on (or cross-build for) its target and
  verify the `.node` binary is present in the packaged app.
- **Building the NSIS installer on Linux needs Wine.** `npm run package:win`
  produces a real `release/win-unpacked/OpenTime.exe` on any host, but wrapping
  it into `OpenTime-<version>-setup.exe` invokes `nsis-resources`, which
  electron-builder can only run through Wine when the host OS is not Windows.
  Without Wine (no `sudo` in a sandboxed environment, say), `signAndEditExecutable:
  false` in `package.json`'s `build.win` still lets the unpacked app build to
  completion — icon/version-resource stamping is skipped, everything else is
  identical — but the NSIS step itself fails with `wine is required`. Build the
  installer on Windows, on a Linux host with Wine installed, or in CI. `win-unpacked`
  was verified end to end this way: launched directly under WSL2 (the packaged
  `.exe`, not `electron .`, with `--user-data-dir` pointed outside the real
  profile), it booted, detected capture was unavailable, seeded gated demo data,
  and wrote real sharded day files through the same storage path dev mode uses.
- **Auto-update is not wired up.** For an open project the natural choice is
  `electron-updater` against public GitHub Releases; v0 deliberately ships
  without it rather than with a feed only the author can publish to.

---

## Testing

```bash
npm test
```

344 tests, node environment, no Electron and no display required:

| Suite | Covers |
|---|---|
| `day.test.ts` | day-key bucketing, boundary rollover, local-vs-UTC correctness, ranges |
| `categorize.test.ts` | rule precedence, URL host reduction, productivity classification, private apps and subjects |
| `sessions.test.ts` | session batching, gap splitting, day-boundary splitting, noise rejection, live rule changes |
| `aggregate.test.ts` | daily/weekly rollups, focus runs, focus-score properties, timeline geometry |
| `format.test.ts` | duration/clock/percent presentation, the 60th-minute carry, hex-to-wash fills |
| `storage.test.ts` | sharding, journal crash recovery, idempotent replay, corrupt-file containment, cache eviction, v0 migration, retention, restore |
| `tracker.test.ts` | the full active/idle state machine with an injected clock and fake capture, timed pause, adapter swap, drain-before-quit |
| `edits.test.ts` | split/merge/retime/manual/claim arithmetic and every rejection case |
| `main-edits.test.ts` | corrections and exports end to end against a real store |
| `export.test.ts` | CSV escaping and formula-injection defence, backup round-trip, hostile and v1 backups |
| `goals.test.ts` | floors, ceilings, pacing, weekly windows, sanitisation |
| `insights.test.ts` | hourly attribution, peak window, and the conditions under which each insight fires |
| `settings.test.ts` | validation of every settings value that could wedge the engine |
| `calendar.test.ts` | OAuth URL construction, refresh margin, event mapping, revoked grants, network and malformed-response failures |
| `demo.test.ts` | the demo generator produces real, non-overlapping, deterministic days |
| `focus.test.ts` | sealing a focus session: boundary splits, no time lost or duplicated, gap filling, idempotent re-seal |
| `music.test.ts` | timer construction, track validation, progress/countdown/overrun arithmetic, open-ended timers |
| `range.test.ts` | calendar month/quarter/year arithmetic, custom-range clamping, DST-safe enumeration, the month grid |
| `entries.test.ts` | folding adjacent sessions into calendar entries, lane assignment, focus-session grouping |
| `palette.test.ts` | category-to-colour mapping, contrast-safe labels, edge-bar colour, light/dark RGB conversion |
| `styles.test.ts` | design-token integrity: no self-referencing `light-dark()` tokens, no undefined token reads, no invalid `auto-fit` grids |

Those cover the engine. The *product* is covered by a second suite:

```bash
npm run test:e2e
```

`scripts/e2e.mjs` boots the real main process against a throwaway user-data
directory and drives the renderer over the Chrome DevTools Protocol the way a
person would — clicking tabs, clicking timeline blocks, ctrl-clicking to merge,
typing into the inspector, flipping the theme — asserting through the same IPC
surface the UI uses. 56 checks, and it writes a screenshot of each view beside
`results.json` so a run can be looked at as well as read.

The tracker tests drive the engine at its real polling cadence rather than in
one jump — ticking in a single leap would look like a sampling gap and split the
session, which is correct behaviour but not what those tests are checking.
Storage writes are asynchronous and durable, so those tests await `tracker.drain()`
before asserting: the same ordering the app uses on quit.

---

## What is not built yet

Honest list of what a production release still needs. The full account, including
what was left out on purpose and what should be reworked, is in
[`docs/feature-inventory.md`](docs/feature-inventory.md).

- **Auto-update.** No update feed. The natural choice is `electron-updater`
  against public GitHub Releases; shipping a feed only the author can publish to
  would be worse than shipping none.
- **Codesigning and notarisation.** Required before macOS distribution.
- **Calendar write-back.** Read-only today; the scope is already selectable.
- **SQLite backend.** No longer needed for durability or memory — the sharded,
  journalled store fixed both. It would buy indexed cross-day queries, worth doing
  when a reporting view needs them.
- **Accessibility audit.** Keyboard navigation and focus order are reasonable but
  unaudited.
- **Long-run soak test.** The engine is designed for a fixed memory ceiling and
  the store now has a bounded footprint, but neither has been run for days on real
  hardware.

![Settings](docs/screenshots/settings.png)

---

## Relationship to the older Norte tracker

OpenTime is a fresh codebase, not a port. What was reused is *design knowledge*
from a previous Electron tracker by the same author, adapted and re-implemented
in TypeScript, with attribution in comments at each site:

- the two-mode active/idle polling state machine, and resuming promptly on
  `powerMonitor` `resume`/`unlock-screen` rather than waiting out the heartbeat;
- batching sessions in memory and flushing on category change or gap;
- reducing URLs to the host, and only reading them for browsers;
- splitting sessions at the tracking-day boundary, and doing day-key maths in
  local time — the predecessor shipped a UTC-based key and had to write a
  migration to repair it, which is why `day.ts` has tests for exactly that case;
- the rule-precedence categoriser;
- the Google OAuth user-agent workaround and token-refresh behaviour.

What was deliberately left behind: the webcam presence pipeline, the voice
assistant, the agent framework, the bundled automation browsers, the video
sub-application, the hosted Postgres dependency, and the multi-app monorepo.
Those were the weight, and none of them belong in a time tracker.

No part of any commercial tracker's branding, copy, visual design or internals
was used. The product category — automatic tracking with a calendar overlay and
a focus score — is not itself anyone's property; the identity, wording, visual
language, scoring model and implementation here are original.

---

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Every
bundled dependency is MIT; the one non-original asset (a public-domain NOAA
recording used by the Music timer) is documented separately in
[`docs/audio-licenses.md`](docs/audio-licenses.md).
