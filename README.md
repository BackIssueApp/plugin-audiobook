# Audiobooks plugin for BackIssue

Adds an **Audiobooks** library type with an on-demand catalog and an in-browser
player. Audiobooks are large (~1 GB `.m4b`), so entries are catalogued **file-
less** (metadata + cover only) and **streamed on play** via an HTTP range proxy
— nothing is downloaded up front, and the source's credentials never reach the
browser.

Audiobooks are self-described `audiobook`-type catalog rows, so the Library
grid, series pages, permissions, and the per-user mature filter all ride core
with no parallel UI.

## What it provides

- A `audiobook` library type (`registerLibraryType`, self-described).
- On-demand catalog **sync** from any registered remote audiobook source
  (core's `registerRemoteMediaSource` with `mediaType: 'audiobook'`), resumable
  and cancellable.
- A **streaming range proxy** (`/api/audiobooks/issue/:id/stream`) — the
  `<audio>` element's `Range` requests are forwarded to the source and the `206`
  piped straight through, so nothing buffers a whole file in memory.
- An in-browser **player** (takes over the audiobook series page): play/pause,
  ±15 s, scrubber, playback speed, chapter list, sleep timer, bookmarks, and
  per-user resume.
- Per-user progress, bookmarks, and listening stats.

## Requirements

- BackIssue core with the `registerRemoteMediaSource` hook.
- At least one plugin registering an audiobook source (e.g. Book Warehouse).

## Permissions

- `audiobooks.use` (viewer tier) — browse and play.
- `library.manage` — run the on-demand catalog sync.

## Install

Drop this repo's release bundle into the BackIssue plugins directory (or install
it from the plugin catalog), create an **Audiobooks** library, and sync a source
into it.

## License

GPL-3.0-or-later.
