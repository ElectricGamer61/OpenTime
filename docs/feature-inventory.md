# Feature inventory

What a modern automatic time tracker is expected to do, what OpenTime does about
each, and where OpenTime deliberately diverges.

The categories below are the standard shape of this product class — automatic
capture, categorisation, a timeline, a focus score, calendar context, reports.
Nothing here is copied from any specific product: no branding, no interface copy,
no visual design, no scoring formula. Where OpenTime behaves differently from the
convention, the reason is stated, because those differences are the argument for
the product existing.

Status legend: **Shipped** · **Partial** · **Deferred** · **Won't build**

## Who this is for

OpenTime is built for one person tracking their own time, not a team, and not
an organisation buying seats. That is a scope decision, not a resource
constraint, and it is why several conventional category features are in the
"Not built on purpose" table below rather than the roadmap: team dashboards,
manager visibility, accounts, and cloud sync all exist to serve someone other
than the person doing the work. Calendar integration is Google Calendar only,
for the same reason a second capture backend or a second calendar provider
would be: it is surface area that serves an audience broader than the one
person this product is for, at the cost of the local-first, no-account, no-
network-by-default architecture that is the actual point. A feature request
that would compromise any of those properties to serve a team or an
organisation is out of scope for this product, not merely deferred.

---

## 1. Automatic app and window capture

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/capture/`, `src/main/tracker.ts`, `src/core/sessions.ts` |

Samples the OS focused window every few seconds and groups consecutive samples
into sessions. Nothing to start or stop.

Three things worth naming:

- **The native module is probed in a child process.** `@miniben90/x-win` is a
  Rust addon that *panics* rather than throwing on a session it cannot read, and
  a panic through napi aborts the host process. Probing in-process would kill the
  app at boot on exactly the machines that need the fallback.
- **Capture health is a first-class, visible state.** Settings and onboarding
  both show whether capture is live, limited or unavailable, and why. `Check
  again` rebuilds the adapter without a restart — which matters because the fix
  (granting macOS Accessibility) happens while the app is already running.
- **macOS degradation is detected, not guessed.** Without Accessibility, `x-win`
  still loads and still returns an app name while every window title comes back
  empty — the app looks like it is working and records nothing useful.
  `systemPreferences.isTrustedAccessibilityClient` is checked so that state is
  named instead of silently tolerated.

## 2. Idle detection

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/tracker.ts` |

On OS-reported idle, the open session closes **at its last observed sample**, not
at "now" — the minutes spent walking away are not credited as work. Tracking then
drops to a 30-second heartbeat that touches neither the capture module nor the
disk. Return is detected promptly on `powerMonitor` resume/unlock rather than by
waiting out the heartbeat.

Away time is recorded as an explicit block, and (see §7) can be claimed back as
work after the fact.

## 3. Day calendar

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/renderer/components/DayGrid.tsx`, `src/renderer/lib/entries.ts` |

An hour grid with a column per kind of work, a rounded block per entry, and a
detail card behind a click. Geometry is a multiply from the hour scale — no
layout measurement, no resize observers. Sessions, away blocks *and* calendar
events are all drawn as entries, and sessions and away blocks are both
selectable, because both are correctable.

Two things are worth naming:

- **Entries are folded, numbers are not.** Adjacent sessions in the same group
  fold into one block so a morning of real work is a handful of readable blocks
  rather than fifty slivers. Only *adjacent* sessions fold — an intervening
  category ends the run, because merging across it would claim the minutes in
  between — and an entry's duration is the sum of its sessions, never
  end-minus-start. The block spans the sub-gaps; the number does not.
- **Columns are labels, not collisions.** Sessions never overlap in time, so
  collision packing would produce a single column and lose the thing a grid is
  for. Columns are the groups the day is made of, ordered by time spent, with
  the smallest sharing the last column — safe precisely because they cannot
  overlap. The grouping (category / project / app) is a tab above the grid and
  drives the summary column's donut at the same time.

**Not modelled:** a per-entry billable amount. There are no rates and no clients
in the data model (§5 — projects are the closest concept), so the slot a
commercial tracker puts money in is simply absent rather than filled with a
plausible number.

## 4. Categorisation and rules

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/categorize.ts` |

Fixed precedence, most specific user intent first: per-app rule → learned keyword
rule → project keyword → `Uncategorized`. Correcting a block on the timeline and
choosing "Whole app" or "Matching text" turns the correction into a permanent
rule.

**Divergence:** OpenTime ships a deliberately tiny built-in keyword table. A large
shipped table is someone else's opinion about your work, is wrong for most
specialist tools, and trains people to distrust the numbers. The review panel is
the mechanism; the defaults are a starting point.

## 5. Projects

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/defaults.ts`, `src/renderer/views/ProjectsView.tsx` |

User-defined bodies of work with colours and keywords; matching sessions are
attributed automatically. Rules outrank projects, which is why `DEFAULT_RULES`
exists — "Breaks" must be a visible category without that making the time count
as focus.

## 6. Focus and productivity scoring

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/aggregate.ts` |

Score is the productive share of tracked time, scaled by a fragmentation factor
and partially redeemed by the longest unbroken block. The same four productive
hours score lower when chopped into forty pieces.

**Divergence:** the score is capped by the share of time that was actually
productive — a "quality" bonus can win back the fragmentation penalty but can
never push the score above the real productive share. A score that can exceed
what happened is a score that flatters, and a flattering metric is a useless one.

## 7. Manual corrections

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/edits.ts`, `src/main/edits/applyEdit.ts` |

Automatic capture is right about the shape of a day and regularly wrong about the
details, so each kind of wrongness has a fix:

| Wrongness | Fix |
|---|---|
| Wrong label | Retag, optionally as a permanent rule |
| One block was really two | **Split** at a time |
| Two blocks were really one | **Merge** |
| A block should not exist | **Delete** |
| Wrong boundaries | **Retime** |
| Work the machine could not see | **Manual entry** |
| Time away was actually work | **Claim** the away block |

All seven are reachable from the review panel: retag, split and delete from a
selected block, **retime** from the same panel, **merge** by ctrl-clicking a
second block on the timeline, manual entry with nothing selected, and claim from
an away block. Merge and retime existed in `core/edits.ts` with tests but had no
UI at all until this pass, which made two rows of this table untrue.

Three invariants hold across all of them: duration is always recomputed from
timestamps rather than trusted; claiming an away block removes the block, so the
same minutes are never counted twice; and a correction may not be written into a
day its own timestamps do not belong to — `applyEdit` checks the span against the
tracking day and refuses rather than misfiling it. Manual entries that would
overlap tracked time are refused with an explanation rather than silently
double-counted.

## 8. Calendar context

| | |
|---|---|
| Status | **Shipped** (read-only) |
| Where | `src/main/calendar/google.ts` |

Google Calendar events overlaid beside the timeline, plus manual events. OpenTime
ships **no API credentials** — the user creates a free OAuth client in their own
Google Cloud project. Plain `fetch`, no SDK.

Two behaviours carried over from a previous implementation that had already hit
them: the auth window presents a Chrome user agent (Google rejects Electron's
default), and tokens refresh five minutes before expiry with a revoked grant
flipping to disconnected rather than retrying forever. A sync now preserves
manual events instead of replacing the whole day.

Write-back (blocking focus time on the calendar) is **deferred**; the scope is
already selectable in Settings for it.

## 9. Reports

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/range.ts`, `src/renderer/views/ReportsView.tsx` |

Day, week, month, quarter, year, and any two dates you pick. The range
arithmetic is pure and separate from the view (`src/core/range.ts`), which is
what makes it testable: a month is a *calendar* month including a leap February,
stepping back from March lands on February rather than thirty days ago, and a
custom range slides by its own length so "previous" means something.

Three decisions worth naming:

- **A week stays the trailing seven days**, not Monday-to-Sunday, because that
  is what the rest of the app already means by "this week". Two different weeks
  in one product is a bug people report as bad data.
- **The chart changes with the range rather than being stretched.** Up to about
  six weeks gets a column per day; a month also gets a real calendar grid,
  because that is how people hold a month in their head; a year gets a cell per
  day in week columns. A 365-column bar chart can be neither read nor clicked.
- **The daily average is over *active* days.** A month whose average is dragged
  down by twelve untracked weekend days is telling you about the calendar rather
  than about the work.

The custom range is clamped to two years, so a slipped keystroke in a year field
cannot ask the store for four thousand day files.

## 10. Goals

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/goals.ts`, `src/renderer/components/GoalsCard.tsx` |

Floors and ceilings on a slice of time, daily or weekly: "at least 4h of focus",
"at most 30m of distraction", "at least 10h on Client X this week". Progress is
paced against how much of the window has actually elapsed, so a weekly goal is not
reported as "behind" every Monday morning by construction.

**Divergence — and this is deliberate:** no streaks, no badges, no goal you can
permanently fail, and both starter goals ship **switched off**. Goals that arrive
pre-enabled are goals somebody else set for you, and the first thing anyone does
with those is stop believing the number.

## 11. Insights

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/insights.ts` |

Peak focus window, fragmentation, meeting load, the named top distraction, and a
comparison against the user's *own* recent baseline rather than an invented ideal.

**Divergence:** the panel renders nothing at all when there is nothing worth
saying, rather than filling with restatements of numbers already on screen. A
panel that always has five cards teaches people to ignore it, and then the one
day it matters they miss it too.

## 12. Privacy and local-only data

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/categorize.ts`, `src/main/storage/FileStorage.ts` |

- No screenshots, ever. Metadata, not pixels.
- URLs reduced to the **host** before anything is persisted, so a session token
  or a document name cannot reach the store. URL reading happens for browsers
  only, because it forces the accessibility tree on.
- **Private apps** — never recorded, and the open session closes the moment one
  takes focus.
- **Private subjects** (new) — a client name, matter number or health portal is
  never recorded *in any application*, matched against window title and host.
  Apps are the wrong unit for confidentiality; subjects are the right one.
- No telemetry, no analytics. The only network calls are to Google's own
  endpoints after the user connects an account, and a GitHub update check if
  they said yes to one (§22), which sends nothing about them.
- OpenTime never tracks itself.

## 13. Durable local storage

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/storage/FileStorage.ts` |

One file per tracking day, a small always-resident config file, and an
append-only journal. Every mutation is journalled and **awaited before the call
returns**; day files are checkpointed on a debounce; `init()` replays anything the
day files do not yet have. Each journal record carries a monotonic sequence and
each day file records the highest sequence folded into it, which is what makes
replay idempotent rather than a way to double-count sessions.

This replaced a single JSON blob whose write cost grew with the length of your
history and which could lose the last seconds of work to a crash. Days are loaded
on demand and evicted, so a year of history costs the same memory as a week.

Migration from the v0 store runs once at boot; the original file is renamed, never
deleted.

SQLite remains **deferred** and is now much less urgent — it would buy indexed
cross-day queries, not durability or a bounded footprint.

## 14. Export and backup

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/export.ts`, `src/main/export/buildExport.ts` |

Sessions CSV, daily-summary CSV, and a full JSON backup that restores everything
including settings, projects, rules and goals. Restore validates the file, states
what it holds, and asks before replacing anything.

Two details that matter more than they look: CSV fields beginning `=`, `+`, `-` or
`@` are prefixed with an apostrophe, because window titles are attacker-influenced
(any web page picks its own) and spreadsheets execute those on open; and times are
written in the user's local calendar, because an export that renders as UTC is an
export that gets mis-added.

## 15. Retention

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/main.ts`, `FileStorage.prune` |

Optional, **off by default**. When on, days past the window are deleted from disk
rather than hidden — a retention setting that only hides data is a lie about what
is on disk. Defaulting it on would mean silently destroying history because a
default said so.

## 16. Onboarding and permissions

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/renderer/components/Onboarding.tsx` |

Four short screens, about thirty seconds, on a fresh install only:

1. What OpenTime is (automatic, private, free) and whether tracking works on
   this machine, with **Check again** when it does not.
2. Where everything is: one line each for Dashboard, Calendar, Start focus,
   Reports and Goals, plus the tray and its two shortcuts.
3. The choices worth making up front: light, dark or match system (previewed
   live), start at sign-in, break reminders, distraction blocking, update checks.
4. Done: it is already tracking, and where feedback goes.

The choices and the "done" marker are saved in **one write**
(`completeOnboarding`), so it cannot half-finish, and the marker lives in the
data folder rather than the program, so it shows **once ever**: not again after
an update, and not again after a reinstall that keeps the data. Skipping is
completing with the suggested choices, every one of which was visible, with a
switch, before anything was saved. The store starts empty: nothing is seeded
into a working install (§17).

## 17. Honest demo data

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/main.ts`, `src/core/demo.ts` |

**This is a behaviour change from v0, and the most important one in this pass.**
v0 seeded a fortnight of synthetic history into *every* empty store, including on
machines where capture worked. That is fiction in a real user's records.

Now: seeding runs only when capture is genuinely unavailable; it can be switched
off for an honest empty dashboard instead; every synthetic row carries
`source: 'demo'` and says so in the UI and in exports; and "Remove demo data"
deletes exactly the seeded days plus any demo-adapter rows sitting in real days.

## 18. Focus sessions

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/focus.ts`, `src/core/pomodoro.ts`, `src/renderer/components/Focus.tsx`, `src/renderer/lib/usePomodoro.ts`, `src/renderer/lib/ambient.ts` |

Everything else in OpenTime observes. This is the one place the user *declares*:
name the work, choose a length, optionally choose an ambient bed, and get a dock
with a countdown, an extend button and a stop button. One primary "Start focus"
entry point on the rail, not several competing timer buttons — the setup sheet
has a Timer/Pomodoro toggle for which shape the session takes, not two separate
actions.

**Pomodoro mode is not a second tracker.** A work phase *is* an ordinary focus
session, started and sealed through the exact same `startFocus`/`endFocus`
primitives a plain timed session uses; a break phase has no session at all.
Pausing seals whatever work has run so far and resuming opens a fresh session
for the remainder — reusing "pause = seal, resume = reopen" instead of
inventing a pause concept inside `ActiveFocus` is what guarantees no minute is
ever double-counted or silently dropped, and it means `src/core/focus.ts` did
not need to change at all to support Pomodoro. `src/core/pomodoro.ts` is pure
phase/preset arithmetic (25/5, 50/10, or a validated custom split);
`usePomodoro` in the renderer is the state machine that drives it through
`OpenTimeState`. Skip and Stop each seal the current work phase first if one is
running, the same way ending a plain session does.

The design decision that matters is that **a focus session is not a second kind
of record.** Capture keeps sampling throughout, unchanged. Ending the session
seals it over the day it ran in: rows already recorded inside the window are
stamped with the session's id and goal, rows straddling an edge are split at the
edge so the minutes before you started are not claimed, and only the minutes
nothing was observed for are filled in. The consequences are the point — the
session draws as one block on the timeline, the block still opens to show which
apps it really went in, and no minute is counted twice.

Three details:

- **Splitting is skipped when it would leave a piece too short to be a session.**
  Those rows go whole to whichever side holds most of them: a two-second boundary
  error is better than a two-second orphan row in someone's history.
- **The running session lives in the main process, not the renderer.** The
  renderer only ever displays `status.focus`, so reloading the window cannot lose
  a session or drift its timer. It is deliberately *not* persisted to disk — a
  crash loses the label and none of the time, whereas persisting it would mean
  deciding at the next boot how long a session nobody ended is supposed to have
  run.
- **Starting a session resumes a paused tracker.** A focus session against a
  paused engine would record nothing and hand back an empty block forty-five
  minutes later.

**Ambient sound is synthesised, never bundled or streamed.** Five beds built at
runtime from filtered noise through the Web Audio API. No audio files (the
renderer's CSP allows no external sources), no licensing question, and no
network. Filtered noise is also the honest version of what these are for:
something with no detail for attention to land on.

Distraction blocking is its own section (§21). **Not modelled:** post-session
self-rating. It exists in this product class to train a focus-detection model,
and OpenTime sends nothing anywhere to train anything.

## 19. Ambient music player

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/core/music.ts`, `src/renderer/lib/useMusicPlayer.ts`, `src/renderer/components/MusicPlayer.tsx`, `src/renderer/lib/music.ts` |

A small, always-available background player — not a timer, and not a second
"start something" button competing with Focus. Pick a track, play or pause it,
set a volume; there is no length, no countdown, no dock. `useMusicPlayer` owns
one shared engine instance for the whole app; `MusicPlayerControl` is just the
trigger-and-popover UI around it, mounted twice on purpose (a small
unobtrusive control on the rail, and again inside the Focus setup sheet and
running docks) so starting a track from one place and adjusting it from the
other is the same player, not two. Four tracks — lo-fi, whale song, alpha
waves, classical — chosen to answer a specific ask for "concentration audio"
without reversing the reason Focus's ambient beds are synthesised (see §18):
see [`docs/audio-licenses.md`](../docs/audio-licenses.md) for exactly what
each track is and, for the one real recording, where it came from and under
what license.

**Deliberately not a variant of a focus session.** A focus session is a claim
over tracked time and has to survive the window reloading, so it lives in the
main process. The music player has no consequence for the timeline at all —
it never seals anything, never touches a day's sessions, carries no category —
so it lives entirely in the renderer, driven by a plain hook rather than IPC.
Closing the window or reloading just stops the sound; there is nothing to
lose because nothing was ever recorded. It can run alongside a Focus session
(plain or Pomodoro) with no interaction between the two.

Three of the four tracks are pre-rendered once through an `OfflineAudioContext`
into a short `AudioBuffer` that then loops exactly like the Focus ambient
beds — chosen over a live scheduler so a background window cannot desync or
drop a beat while throttled. The alpha track is genuinely live (a beat
frequency cannot be pre-rendered into a short seamless loop), and the one real
recording is fetched and decoded once, from a bundled local asset — same
origin, no CSP change.

## 20. Tray and timed pause

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/main.ts`, `src/main/tracker.ts` |

Pause for 15/30/60 minutes or until resumed, from the tray. A timed pause exists
because the alternative people actually reach for is quitting the app — and then
forgetting to start it again and losing the afternoon.

Two global shortcuts back the same two actions from the keyboard, registered in
`registerGlobalShortcuts()`: `Ctrl/Cmd+Alt+O` toggles the window, `Ctrl/Cmd+Alt+P`
toggles pause. Both are the kind of action that needs no window in front of you
to make sense of — anything that needed input (starting a Focus session with a
goal, for instance) stays a window action. Registration is best-effort: another
app already holding the combination, or a desktop session with no global-hotkey
support, degrades to "no shortcut" rather than failing to boot, the same
treatment the tray itself gets.

## 21. Distraction blocking

| | |
|---|---|
| Status | **Shipped** (opt-in, off by default) |
| Where | `src/core/blocking.ts`, `src/main/blocker.ts`, `src/shield/` |

During a focus session only, anything on the user's list that comes to the
front is covered by a shield: a calm full-screen card naming the distraction,
the session and the time left, with **Allow 5 minutes** and **End focus
session**. Sites match by host and cover subdomains (`youtube.com` covers
`m.youtube.com`, and `x.com` does not cover `dropbox.com`); apps match by name.
A browser that hides its URL falls back to the site's name as a whole word in
the title, only for names long enough not to collide with ordinary words.

This used to be on the "not built on purpose" list, because the usual ways to
block (a system network hook, or killing windows) are a far larger promise
about what the app may do to your machine than reading which window has focus.
The shield keeps that promise small:

- **It never closes, kills or edits anything**, so it cannot lose work, and it
  needs no admin rights and no system settings.
- **It never takes keyboard focus.** The blocked window stays in front beneath
  it, so Ctrl+W or switching apps still works, and the shield lifts on the next
  one-second tick once something unblocked is in front. The taskbar stays
  uncovered, so there is always a way out.
- **It covers the display the distraction is on**, not the one the pointer is
  on, and follows it if it is dragged to another monitor.
- **It never covers OpenTime itself**, so opening the app to end the session
  always works. A minimised OpenTime does not count as "in front", even when
  Windows still reports it focused.
- **Nothing runs unless it is used.** Outside a focus session, or with blocking
  off, there is no timer at all.

## 22. Updates and feedback

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/updater.ts`, `src/shared/project.ts`, `.github/workflows/windows-package.yml`, `.github/ISSUE_TEMPLATE/` |

Updates come from GitHub Releases through `electron-updater`. Checking is the
only network call OpenTime makes on its own, so it happens only with the user's
yes (asked in onboarding, off for anyone who never answered); **Check now** is
always there, because a click is consent. Nothing downloads until **Update
now**; the download is verified against the release's sha512; every pending
write is flushed before the installer runs silently and relaunches the app. The
data folder is never part of an install, update or uninstall. Releases are cut
by pushing a `v*` tag, which the workflow checks against `package.json`.

Feedback goes to GitHub issue forms (bug, idea, question), one click from the
title bar or Settings. The bug form arrives with the version and OS filled in;
nothing about the person or their tracked time is included, and nothing is sent
until they submit it in their browser.

---

## Deferred, with reasons

| Item | Why it is not built |
|---|---|
| **SQLite backend** | The sharded store fixed the durability and memory problems SQLite was wanted for. It would now buy indexed cross-day queries — worth doing when a reporting view needs them, not before. |
| **Codesigning and notarisation** | Unsigned Windows installers show a SmartScreen prompt on first run; macOS distribution and macOS self-updates need an Apple Developer ID. |
| **Calendar write-back** | Scope is already selectable. Needs a clear model for what OpenTime is allowed to put on someone's calendar. A prototype exists on `fm/opentime-full-rize-parity` (see AGENTS.md), but its UI half predates the calendar rebuild and is not directly portable. |
| **Accessibility audit** | Keyboard order is reasonable but unaudited. |
| **Long-run soak test** | The engine is designed for a fixed memory ceiling and the store now has a bounded footprint, but neither has been run for days on real hardware. A `scripts/soak.mjs` + `tests/soak.test.ts` harness exists on `fm/opentime-full-rize-parity` (see AGENTS.md) against an older `Tracker` shape; would need rechecking against the current one, not a straight port. |

## Not built on purpose

| Item | Why not |
|---|---|
| **Screenshots / periodic screen capture** | Common in this category and incompatible with the product's premise. Metadata is enough to answer "where did the day go" and cannot leak the contents of a document. |
| **Keystroke or mouse-movement scoring** | Measures typing, not thinking. Rewards the wrong behaviour and punishes reading, design and conversation. |
| **Team dashboards / manager visibility** | Turns the tool from something you use into something used on you, and every design decision after that point follows the manager rather than the user. |
| **Accounts, cloud sync, subscription** | The data is on your machine and stays there. Sync is a legitimate feature request, but it should arrive as "point it at your own folder", not as an account. |
| **Streaks and badges** | See §10. Gamification survives about two weeks and then costs credibility permanently. |
| **AI-generated day summaries** | Would mean sending activity metadata to a model provider, which contradicts §12 outright. |
| **Post-session focus self-rating** | Exists in this product class to train a focus-detection model. OpenTime sends nothing anywhere, so the rating would train nothing and would only be a question asked at the end of every session. |

## Candidates for removal or rework

| Item | Assessment |
|---|---|
| **Focus checkpoint notification** | Weakest shipped feature. A fixed-interval nudge does not know whether you are mid-thought. Keep the mechanism, but it should key off an actual break in the pattern rather than a timer, or come out. |
| **Demo capture adapter** | Right for reviewability and for machines where capture cannot run; wrong if it ever becomes the path of least resistance for a real user. Now gated hard (§17) — watch that the gate stays. |
| **`Uncategorized` as a category** | Honest, but a dashboard whose largest slice is "Uncategorized" is a dashboard nobody acts on. Wants a prompt that turns it into rules, not a bigger keyword table. |
| **Seven-day-only dashboard** | Reports now cover any range (§9), but the dashboard and the summary column are still fixed to today and the trailing week. That is a reasonable default focus, not a limit worth keeping by accident. |
