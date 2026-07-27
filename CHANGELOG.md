# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [0.3.4]

### Fixed

- **iOS playback of some streamed books.** Certain upstream sources declare
  `application/octet-stream` for audio files; AVPlayer refuses to play an
  extensionless URL with a generic MIME (ExoPlayer sniffs and doesn't care).
  The stream proxy now substitutes the catalog's audio type when the
  upstream's is missing or generic — specific upstream types still win.

## [0.3.3]

### Fixed

- **Home rails render sooner at page load.** The rails no longer fetch
  `/api/status` themselves to find the audiobook library — they reuse the
  library list the app has already loaded (falling back to fetching on older
  cores), so at refresh the rails appear as soon as the app itself is ready
  instead of waiting on a duplicate status round-trip.

## [0.3.2]

### Fixed

- **Cacheable cover redirects.** The per-issue cover route's redirect now carries
  a day of `Cache-Control`, so browsers stop re-resolving every cover's redirect
  hop on each library view — covers appear noticeably faster on revisits.

## [0.3.1]

### Fixed

- **Faster home rails.** Rail requests now skip the server's filter-chip count
  pass (`counts=0`) — the counts were never shown, and at large library sizes
  that pass was most of each rail's load time.

## [0.3.0]

### Added

- **Home rails on the web app.** Two audiobook rails — Continue listening and
  New audiobooks — now appear on the web home screen, matching the mobile apps.
  Each rail can be hidden from its × or toggled per user on the Profile page,
  saved server-side so visibility syncs across web and mobile. Tapping a cover
  opens the audiobook. The rails sit alongside the reading rails (they no longer
  replace one another).

## [0.2.0]

### Added

- **Per-user home rail toggles.** The audiobook home rails (Continue listening,
  New audiobooks) can each be shown or hidden per user, saved server-side so the
  choice syncs across every device. New endpoint
  `GET`/`POST /api/audiobooks/home-prefs`.
- **Series grouping.** Audiobooks that belong to a series now share one shelf
  (like books do) instead of each being a standalone entry: the metadata match
  groups a title into its series by the Audnexus series/position, a remote source
  can supply the series directly, and the grouping sticks across rescans. Applies
  to newly scanned / re-synced / re-matched audiobooks.

## [0.1.0]

### Added

- **Audiobooks library type + on-demand catalog.** A self-described `audiobook`
  library that syncs a remote source's whole catalog as file-less entries
  (metadata + cover only) and streams each title on play — no up-front
  downloads.
- **Local library scanning + hosted metadata.** Point an Audiobooks library at
  a folder of `.m4b`/`.m4a`/`.mp3` files and the scan catalogs each one
  (title/author derived from the `<Author>/<Title>` folder layout), then the
  hosted metadata service fills in covers, narrators, series, publisher, and
  durations. Incremental (unchanged files are skipped) and self-pruning — the
  same scan lifecycle as comic and book libraries. Works with no remote source
  configured; matching is best-effort, so files play even before they match.
- **Streaming range proxy.** `/api/audiobooks/issue/:id/stream` forwards the
  player's `Range` requests to the source and pipes the `206` through, so a ~1 GB
  file never buffers in memory. The source's credentials stay server-side.
- **In-browser player.** Play/pause, ±15 s, scrubber, playback speed, chapter
  list (lazily fetched), sleep timer, bookmarks, and per-user resume — takes
  over the audiobook series page.
- **Per-user progress, bookmarks, and listening stats.**
- **Mature filter.** A source's explicit flag marks the series `restricted`, so
  it rides core's per-user "hide mature content" preference.
- Consumes core's generic `registerRemoteMediaSource` hook
  (`mediaType: 'audiobook'`), so any source plugin can supply the catalog.
