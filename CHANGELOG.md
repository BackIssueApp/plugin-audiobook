# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [0.5.0] — 2026-10-18

### Added

- **Books in several files play as one.** A book folder's files
  (`Author/Title/Part 1.mp3`, `Part 2.mp3`, …) are now one book with parts
  in filename order ("Part 2" before "Part 10"), not a pile of alternate
  recordings. The player moves on to the next file by itself, and seeking,
  the time left, bookmarks and your saved place count across the whole
  book. Where you were in a part, and its bookmarks, carry over on the next
  scan.
- **Chapters for your own files.** The chapter marks inside M4B and MP3
  files show in the player's Chapters list, and each file's length is read
  from the file. A part with no marks of its own is listed as one chapter,
  Part n.
- **Wanted audiobooks have a screen.** The Wanted page gets an Audiobooks tab
  listing every audiobook you asked for that hasn't arrived, with when its last
  search ran and what it found. **Search now** tries the sources again without
  waiting for Fill wanted audiobooks, and **Cancel** drops it. Needs BackIssue 0.9.2 or
  newer; older versions keep the list API only.
- **Remove from Continue listening.** Right-click a cover on the Continue
  listening rail, or long-press it, to drop a book you've abandoned. It goes
  back to not started.
- **Mark finished** in the player finishes a book wherever you are.

### Changed

- **Audiobook folders are rescanned twice a day.** New files dropped into a
  library folder used to wait for a library edit or a manual scan. Change or
  turn off the schedule under Jobs.
- **Books count as finished near the end.** A book is finished in its last two
  minutes, or its last 1% for a long book. It used to take the last 30
  seconds, so stopping at 99% of a long book left it on Continue listening for
  good. Progress saved under the old rule is caught up automatically.

### Fixed

- **A scanned book's details load in the mobile apps.** A book's length went
  out with a fraction of a second, which the Android and iOS apps couldn't
  read, so a series holding such a book showed no lengths, narrators or
  formats there. Lengths are now sent in whole seconds.
- **Viewing bookmarks no longer adds one.** The Bookmarks button in the player
  opens and closes your list. Adding a bookmark is the button at the top of
  that list. Before, every tap saved a new bookmark.
- **Catalogs from sources without "what's new" support keep updating.** After
  a full sync, later runs found nothing. They now walk the catalog again from
  the first page. Titles the source lists but can no longer serve are not
  brought back.
- **Continue listening shows only audiobooks in progress.** The home page rail
  no longer needs the Shelves plugin to tell started audiobooks from the rest.
  Without it, the rail listed the whole Audiobooks library.

## [0.4.0] — 2026-10-17

### Added

- **Translated UI.** The player, the recording switcher and the home rails
  follow the language picked under Profile → Language on BackIssue 0.9.1 and
  newer, and stay English on older ones. Translations ship for French, German,
  Spanish, Italian, Portuguese (Portugal and Brazil), Dutch, Polish, Japanese
  and Simplified Chinese in `locales/`. Also covers the permission, job and
  library-type labels, the plugin description and the notification titles
  shown in BackIssue’s own screens.

## [0.3.15] — 2026-09-12

### Added

- **Add an audiobook.** The app's Add button gains an Audiobooks tab where an
  Audiobooks library exists: search the catalog, see what is already on the
  shelf, and add one — it goes on a wanted list and the download sources are
  asked for it at once. What no source has yet is tried again by the new
  **Fill wanted audiobooks** job, or leaves the list when a scan brings it
  in. `GET /api/audiobooks/wanted` lists them; `DELETE /api/audiobooks/wanted/<id>`
  drops one.
- **Downloads are filed.** An audiobook the app's download sources fetched (an
  approved request, for instance) is moved into the library as
  Author/Title.ext (or Author/Title/parts) and catalogued like a scanned one, named from the
  request's title and author. Needs app 0.8.4 or later; older apps simply
  never hand anything over.
- **Removing an on-demand source's entries.** `DELETE /api/audiobooks/remote/<source>`
  (library manage) drops every entry that source put on the shelf, with their
  issues and the series left empty, and forgets its sync cursor — for a
  source plugin you have removed, or a shelf you want reset.

## [0.3.14] — 2026-09-08

### Fixed

- **A remote catalog sync could freeze the whole server.** The lookup that
  spots a re-imported book next to its dead old record compared titles
  across the entire remote catalog for every new book; with a few hundred
  thousand titles one lookup blocked the server for minutes, and a sync that
  found three new books took it down for the morning. Titles are now indexed
  on the row, so the lookup is instant at any catalog size.

## [0.3.13] — 2026-09-07

### Changed

- **Card covers ask for a card-sized image.** The cover redirect now asks a
  local source proxy for a 400 px copy by default (`?w=0` for the original),
  so Home rails and the library grid stop downloading full-size art.

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
