# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

## [0.1.0]

### Added

- **Audiobooks library type + on-demand catalog.** A self-described `audiobook`
  library that syncs a remote source's whole catalog as file-less entries
  (metadata + cover only) and streams each title on play — no up-front
  downloads.
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
