# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [0.3.12] — 2026-09-06

### Changed

- **Recording switcher, per the design handoff.** On a shelf with more than
  one recording the hero carries a switcher naming the loaded one (narrator,
  length, format, how many there are); it opens a list of every recording
  with its own progress, a Full cast / Longest / Unavailable flag, and the
  reason a dead one cannot play. A series shelf leads each row with the
  book title, editions of one title with the narrator. The player is now a
  card: 88px cover, filled 42px skip buttons, a 58px main control with a
  glow. A failure notice offers "Play <the next recording that works>".
  Repeated failure toasts from the page's re-renders are collapsed to one.

## [0.3.11] — 2026-09-06

### Fixed

- A recording the source cannot serve explained itself once per event — the
  element's error and the play rejection each raised a toast, and every retry
  another. One notice per failure now, cleared when playback succeeds.

## [0.3.10] — 2026-09-06

### Added

- **Pick the recording on a shelf.** When a shelf holds more than one
  recording — editions of the same title with different narrators, lengths or
  formats, or a series without per-book pages — the web player lists them
  above the controls with narrator, length and format, marks the one that is
  loaded and any the source cannot serve, and remembers your pick per shelf.
  The player used to load the first and hide the rest.

## [0.3.9] — 2026-09-06

### Added

- **The remote catalog syncs on a schedule.** A "Sync remote audiobook
  catalog" job runs every six hours by default (editable on the Jobs page):
  new titles at the source arrive on their own, and entries a play attempt
  proved dead are swept once a working twin exists — no more pressing Sync
  by hand.

## [0.3.8] — 2026-09-06

### Fixed

- **Dead duplicates are pruned across shelves.** An older record that sat on
  its own shelf (no series information at the time) was not recognised as the
  twin of the re-imported copy inside the series, so the dead one stayed and
  was the one people tapped. Twins are now matched by title within the
  library, an emptied shelf is removed with its last book, and each sync also
  sweeps entries a play attempt already proved dead whose twin still streams.

## [0.3.7] — 2026-09-06

### Fixed

- **A sync that found nothing no longer shrinks the catch-up window.** With a
  source that has no incremental support, a run whose cursor was already past
  the end recorded itself as "synced now", so a later catch-up (once the
  source gained incremental support) only looked back a day. Such a run now
  leaves the bookkeeping alone.

## [0.3.6] — 2026-09-06

### Fixed

- **Catalog sync sees new titles again.** A remote source that lists newest
  first put everything added after the first full walk on page 1, behind the
  page cursor, so nothing new ever reached the shelf. Once a full walk has
  completed, a source that supports it is now asked only for what changed
  since the last run (`listPage(page, { updatedAfter })`, declared with
  `incremental: true`), and one click on Sync catches the catalog up — a
  pre-existing catalog gets a ninety-day overlap on its first run so nothing
  in between is missed. Sources without that support keep the cursor walk.
- **The player says why it cannot play.** A failed stream used to leave the
  play button silent. The player now asks the server what went wrong and
  shows it under the controls, with a busy state while a slow source
  connects. A title the source can no longer serve (its file is gone) is
  remembered as unavailable and says so before the next tap; it clears the
  moment a stream succeeds again.
- **Dead duplicates are pruned.** When a re-imported copy of a book arrives
  next to an older record the source can no longer serve, the sync removes
  the dead one, so the shelf does not show the same book twice.

## [0.3.5] — 2026-08-01

### Fixed

- **Interrupted audiobook downloads resume instead of restarting.** The
  stream proxy stripped upstream validators and remote sources often send
  none — and download clients (the iOS app, browsers, curl -C) only resume
  an interrupted transfer when the response carries an ETag/Last-Modified.
  A 1GB book that dropped at 90% restarted from zero. The proxy now
  forwards upstream validators and synthesizes a stable per-file ETag when
  the source has none.

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
