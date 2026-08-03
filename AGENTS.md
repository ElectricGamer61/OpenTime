# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

Start with `README.md` — it documents the stack, architecture, performance rationale, storage migration path, packaging, and the explicit list of what v0 does not do yet. The notes below are only the things that repeatedly bite and are not obvious from reading the code.

## Sharp edges

- **`@miniben90/x-win` panics rather than throwing** on sessions that cannot expose the focused window (Wayland, WSL, containers, most remote desktops). A Rust panic through napi aborts the process and is not catchable by `try/catch`, so `src/main/capture/index.ts` probes it in a child process before ever loading it in-process. Do not "simplify" that back to an inline `require` + try/catch — it turns an ungraceful degradation into a boot crash.
- **Day keys are local-time only.** `src/core/day.ts` must never format via `toISOString()`; that buckets by the UTC day and misfiles late-night sessions. The predecessor shipped that bug and needed a data migration. `tests/day.test.ts` pins the behaviour.
- **Sessions end at their last observed sample, not at "now."** `Tracker` calls `builder.flush()` with no argument when closing on idle/pause/stop, so the unobserved gap is not credited as work.
- **Anything driving the engine must tick at the poll cadence.** A single large clock jump looks like a sampling gap and correctly splits the session into zero-length pieces. This applies to tests (`run()` helper in `tests/tracker.test.ts`) and to the demo generator (which opens a stretch then calls `flush(end)` explicitly).
- **Rules outrank projects**, so a project alone cannot decide productivity. `DEFAULT_RULES` in `src/core/defaults.ts` exists because "Breaks" is a category the user wants to see, but naming it must not make the time count as focus.

## Working on the UI without a display

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
