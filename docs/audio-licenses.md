# Third-party audio in the ambient music player

The ambient music player (`src/core/music.ts`, `src/renderer/lib/music.ts`)
offers four tracks. Three are synthesised on the machine at runtime, exactly
like the Focus ambient beds (`src/renderer/lib/ambient.ts`) — no file, no
license to track. One is a real recording, bundled as a local asset and
covered here.

## `src/renderer/assets/audio/whale.wav`

| | |
|---|---|
| Source | NOAA Pacific Marine Environmental Laboratory (PMEL) Acoustics Program |
| Original file | `https://www.pmel.noaa.gov/acoustics/whales/sounds/whalewav/akhumphi1x.wav` |
| Recording | Humpback whale, Alaska, played back at 10x recorded speed (PMEL's standard presentation for these recordings — the calls are otherwise too low and slow for a short clip to carry) |
| Accessed | 2026-08-31 |
| License | U.S. Government work — public domain under 17 U.S.C. §105. NOAA states its materials carry no usage fee and are public domain unless otherwise marked; this page carries no contrary notice. |
| Modification | Trimmed to a 24-second window (source offset 8s–32s, chosen for consistent signal throughout) with a 0.4s fade in/out for a seamless loop. Otherwise unedited — same sample rate (8kHz), same bit depth (16-bit PCM mono) as the source file. |

No attribution is legally required for a public-domain U.S. government work,
but the source is recorded here so the provenance survives past whoever
bundled it.

## The other three tracks

`lofi`, `alpha` and `classical` are generated at runtime from oscillators and
filtered noise — original code, not audio files, licensed the same as the rest
of the repository (Apache License 2.0). See the doc comment at the top of
`src/renderer/lib/music.ts` for why: bundling somebody else's lofi beat or
somebody else's Mozart recording is exactly the licensing problem the existing
ambient beds were built to avoid, and a full orchestral recording is also a
multi-megabyte asset for a four-track player nobody asked to also grow the
installer. `classical` is an original short motif, not a rendition of any
existing composition — it exists to answer the spirit of "Mozart or a clearly
licensed equivalent" without either licensing a recording or overstating what
a few oscillators can honestly claim to be.

## Adding another bundled audio track later

Keep this file as the single ledger: one entry per bundled asset, with the
exact source URL, access date, and license basis. A track that cannot be
sourced under a real public-domain or explicit-permissive license and cannot
be reasonably approximated by synthesis should not be added.
