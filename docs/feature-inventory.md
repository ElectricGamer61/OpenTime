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
- No telemetry, no analytics, no network calls except to Google's own endpoints
  after the user connects an account.
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

Three facts on first run — what is recorded, whether capture actually works on
this machine, and where the data lives — with a live capture check and a link to
the data folder. Deliberately not a feature tour: there is nothing to tour, which
is the point of the product.

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
| Where | `src/core/focus.ts`, `src/renderer/components/Focus.tsx`, `src/renderer/lib/ambient.ts` |

Everything else in OpenTime observes. This is the one place the user *declares*:
name the work, choose a length, optionally choose an ambient bed, and get a dock
with a countdown, an extend button and a stop button.

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

**Not modelled:** distraction blocking. Blocking sites or apps means either a
system-level network hook or an accessibility-driven window killer, both of which
are a much larger promise about what this app is allowed to do to your machine
than "it reads which window has focus". Post-session self-rating is also absent —
it exists in this product class to train a focus-detection model, and OpenTime
sends nothing anywhere to train anything.

## 19. Tray and timed pause

| | |
|---|---|
| Status | **Shipped** |
| Where | `src/main/main.ts`, `src/main/tracker.ts` |

Pause for 15/30/60 minutes or until resumed, from the tray. A timed pause exists
because the alternative people actually reach for is quitting the app — and then
forgetting to start it again and losing the afternoon.

---

## Deferred, with reasons

| Item | Why it is not built |
|---|---|
| **SQLite backend** | The sharded store fixed the durability and memory problems SQLite was wanted for. It would now buy indexed cross-day queries — worth doing when a reporting view needs them, not before. |
| **Auto-update** | Natural choice is `electron-updater` against public GitHub Releases. Shipping an update feed only the author can publish to is worse than shipping none. |
| **Codesigning and notarisation** | Required before macOS distribution; needs an Apple Developer ID. |
| **Calendar write-back** | Scope is already selectable. Needs a clear model for what OpenTime is allowed to put on someone's calendar. |
| **Accessibility audit** | Keyboard order is reasonable but unaudited. |
| **Update check** | Still none, and deliberately so — see Auto-update above. A checker that only points at GitHub Releases would also be the app's first unsolicited network call, which §12 rules out. |
| **Long-run soak test** | The engine is designed for a fixed memory ceiling and the store now has a bounded footprint, but neither has been run for days on real hardware. |

## Not built on purpose

| Item | Why not |
|---|---|
| **Screenshots / periodic screen capture** | Common in this category and incompatible with the product's premise. Metadata is enough to answer "where did the day go" and cannot leak the contents of a document. |
| **Keystroke or mouse-movement scoring** | Measures typing, not thinking. Rewards the wrong behaviour and punishes reading, design and conversation. |
| **Team dashboards / manager visibility** | Turns the tool from something you use into something used on you, and every design decision after that point follows the manager rather than the user. |
| **Accounts, cloud sync, subscription** | The data is on your machine and stays there. Sync is a legitimate feature request, but it should arrive as "point it at your own folder", not as an account. |
| **Streaks and badges** | See §10. Gamification survives about two weeks and then costs credibility permanently. |
| **AI-generated day summaries** | Would mean sending activity metadata to a model provider, which contradicts §12 outright. |
| **Distraction blocking during a focus session** | See §18. Blocking sites or apps needs either a system-level network hook or an accessibility-driven window killer — a far larger promise about what this app may do to your machine than "it reads which window has focus". |
| **Post-session focus self-rating** | Exists in this product class to train a focus-detection model. OpenTime sends nothing anywhere, so the rating would train nothing and would only be a question asked at the end of every session. |

## Candidates for removal or rework

| Item | Assessment |
|---|---|
| **Focus checkpoint notification** | Weakest shipped feature. A fixed-interval nudge does not know whether you are mid-thought. Keep the mechanism, but it should key off an actual break in the pattern rather than a timer, or come out. |
| **Demo capture adapter** | Right for reviewability and for machines where capture cannot run; wrong if it ever becomes the path of least resistance for a real user. Now gated hard (§17) — watch that the gate stays. |
| **`Uncategorized` as a category** | Honest, but a dashboard whose largest slice is "Uncategorized" is a dashboard nobody acts on. Wants a prompt that turns it into rules, not a bigger keyword table. |
| **Seven-day-only dashboard** | Reports now cover any range (§9), but the dashboard and the summary column are still fixed to today and the trailing week. That is a reasonable default focus, not a limit worth keeping by accident. |
