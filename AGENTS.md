# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

Start with `README.md` — it documents the stack, architecture, performance rationale, the storage layout, packaging, and what is not built yet. `docs/feature-inventory.md` is the category-by-category account of what is shipped, deferred, deliberately not built, and due for rework; read it before proposing a feature. The notes below are only the things that repeatedly bite and are not obvious from reading the code.

## Sharp edges

- **`@miniben90/x-win` panics rather than throwing** on sessions that cannot expose the focused window (Wayland, WSL, containers, most remote desktops). A Rust panic through napi aborts the process and is not catchable by `try/catch`, so `src/main/capture/index.ts` probes it in a child process before ever loading it in-process. Do not "simplify" that back to an inline `require` + try/catch — it turns an ungraceful degradation into a boot crash.
- **On macOS, working capture and useless capture look identical.** Without Accessibility, `x-win` still loads and still returns an app name while every window title is empty. `createCapture` takes the `systemPreferences.isTrustedAccessibilityClient` result so that state is reported rather than silently tolerated.
- **Day keys are local-time only.** `src/core/day.ts` must never format via `toISOString()`; that buckets by the UTC day and misfiles late-night sessions. The predecessor shipped that bug and needed a data migration. `tests/day.test.ts` pins the behaviour.
- **Sessions end at their last observed sample, not at "now."** `Tracker` calls `builder.flush()` with no argument when closing on idle/pause/stop, so the unobserved gap is not credited as work.
- **Anything driving the engine must tick at the poll cadence.** A single large clock jump looks like a sampling gap and correctly splits the session into zero-length pieces. This applies to tests (`run()` helper in `tests/tracker.test.ts`) and to the demo generator (which opens a stretch then calls `flush(end)` explicitly).
- **Rules outrank projects**, so a project alone cannot decide productivity. `DEFAULT_RULES` in `src/core/defaults.ts` exists because "Breaks" is a category the user wants to see, but naming it must not make the time count as focus.
- **Storage day reads are async; config reads are sync.** That split is deliberate (`src/main/storage/Storage.ts`): configuration is tiny and read on every tick, day records can span years and are read on demand. Do not make day reads synchronous for convenience — it re-introduces the whole-store-in-memory design the sharded store replaced.
- **Writes are durable but asynchronous, so ordering matters at quit.** `Tracker.stop()` starts the final write; `Tracker.drain()` awaits it. `before-quit` must drain *then* flush storage, and tests must `await tracker.drain()` before asserting on stored data.
- **Journal replay is idempotent only because of `seq`.** Each record carries a monotonic sequence and each day file records the highest one folded into it. Any new journal op must carry `seq` and be skipped on replay when `seq <= lastSeq`, or a crash will double-count sessions.
- **`broadcast()` can be called while the renderer is being torn down.** A disposed render frame makes `webContents.send` throw even when the window is not destroyed, and the final flush on quit runs through that path. Keep its guards and its `try`.
- **Demo data is gated on purpose.** Seeding only happens when capture is genuinely unavailable, every synthetic row carries `source: 'demo'`, and seeded day keys are recorded in `meta.json` so they can be removed exactly. Do not widen that gate — putting generated history into a working install is fiction in a user's records.

## Testing and running without a display

- `npm test` — 241 tests, node environment, no Electron needed.
- `npm run typecheck` — covers `src/` **and** `tests/`.
- To exercise the **main process** end to end, run `npx electron . --user-data-dir=<tmp> --disable-gpu`. Always pass `--user-data-dir`: without it the app reads and migrates the real `~/.config/OpenTime` store. WSL needs `--disable-gpu` or Electron may abort on GPU init.
- The browser fallback client in `src/renderer/state/client.ts` implements the *whole* `OpenTimeApi`. Adding an IPC method means adding it there too, or the screenshot/preview path breaks.

`npx electron scripts/screenshot.cjs <outDir>` boots the real Electron shell and writes a PNG per tab. It intentionally loads the renderer *without* the preload bridge, so the renderer falls back to its self-contained demo client in `src/renderer/state/client.ts` — full UI, no tracking engine required. Run `npx electron scripts/screenshot.cjs docs/screenshots` after visual changes; the filenames it writes are the ones README links to.

**Offscreen capture lies unless you make it repaint.** `capturePage()` on a `show: false` window returns whatever the offscreen compositor last rastered, which is not necessarily the current DOM. The script therefore waits for finite animations to finish, calls `webContents.invalidate()`, and asserts the expected tab is actually `.active` before capturing — without all three it silently produced four screenshots of the wrong tab, or a correct main pane beside a stale sidebar. If a screenshot ever disagrees with the code, suspect this before suspecting the UI. It also cannot be scrolled reliably; to see below the fold, open a taller `BrowserWindow` instead of setting `scrollTop`.

## UI conventions

`src/renderer/styles.css` holds the whole design system as tokens (colour, the `--gap-*` spacing scale, radii, `--fast`/`--med`/`--slow` durations). Use the tokens rather than literals so a light theme stays a token swap, and keep saturated colour to small areas — the productivity tokens are tuned for 8px swatches and overwhelm the page when they fill a bar or a timeline block, so large fills use the washes in `Charts.tsx` / `blockFill()`. Icons are inline SVG in `components/Icons.tsx` (24×24, 1.7px round strokes, no binary assets — the renderer's CSP allows no external sources). Every "nothing here" surface goes through `components/Empty.tsx`. All motion must survive `prefers-reduced-motion`, which the stylesheet disables globally at the bottom.

Avoid `backdrop-filter` on opaque surfaces: it buys nothing visually and its extra composited layer renders a frame behind the rest of the shell during a view transition.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
