// Audiobooks client — takes over the series page of an `audiobook`-type series
// (core's registerSeriesView) and renders a full in-browser audio player around
// a streaming <audio> element. Audio bytes range-stream from
// /api/audiobooks/issue/:id/stream (the server proxies the source), so playback
// starts immediately and seeks anywhere without downloading the ~1GB file.
//
// Features: play/pause, ±15s, scrubber, playback speed, chapter list, sleep
// timer, bookmarks, and per-user resume (position saved server-side).
(function () {
  if (!window.BackIssue || typeof window.BackIssue.registerClient !== 'function') return;

  const SVG = {
    play: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    back15: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9l5 4"/><path d="M6 9h7a6 6 0 1 1-6 6"/></svg>',
    fwd15: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m13 5 5 4-5 4"/><path d="M18 9h-7a6 6 0 1 0 6 6"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    mark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    speed: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>',
  };
  const SPEEDS = [0.8, 1, 1.15, 1.25, 1.5, 1.75, 2];
  const SLEEP_MINS = [5, 15, 30, 45, 60];

  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  window.BackIssue.registerClient((api) => {
    if (api.registerSeriesView) api.registerSeriesView({ type: 'audiobook', render });

    // ---------- home rails ----------
    // Two audiobook rails, rendered into the core library's #home-plugin-rail
    // slot (the reader plugin renders its reading shelves there too — each side
    // owns a display:contents wrapper so they coexist). Per-user visibility is
    // saved server-side (/api/audiobooks/home-prefs), so it syncs with the apps.
    const AB_SHELVES = [
      { key: 'ab-continue', pref: 'showContinue', title: 'Continue listening', facet: '{"status":"reading"}' },
      { key: 'ab-new',      pref: 'showNew',      title: 'New audiobooks',      facet: null },
    ];
    let abLibId;         // undefined = unresolved, null = none
    let abPrefs = null;
    const abShelfOn = (s) => (abPrefs && s.pref in abPrefs) ? abPrefs[s.pref] !== false : true;

    async function audiobookLibId() {
      if (abLibId !== undefined) return abLibId;
      try { const st = await api.get('/api/status'); abLibId = (st.libraries || []).find((l) => l.type === 'audiobook')?.id ?? null; }
      catch { abLibId = null; }
      return abLibId;
    }

    async function renderAudiobookRails() {
      const slot = api.slot('home-plugin-rail');
      if (!slot) return;
      const libId = await audiobookLibId();
      if (!libId) return;
      try { abPrefs = await api.get('/api/audiobooks/home-prefs'); } catch { /* keep last/defaults */ }
      syncAudiobookPrefs();
      const shown = AB_SHELVES.filter(abShelfOn);
      const results = await Promise.all(shown.map((s) => {
        const q = `/api/collection?library=${libId}&limit=15&offset=0&sort=added`
          + (s.facet ? `&facet=${encodeURIComponent(s.facet)}` : '');
        return api.get(q)
          .then((r) => ({ s, items: Array.isArray(r) ? r : (r.rows || r.items || []) }))
          .catch(() => ({ s, items: [] }));
      }));
      const desired = [];
      for (const { s, items } of results) if (items.length) desired.push(buildAbRail(s, items));
      // Own a display:contents wrapper so the reader's rails aren't clobbered and
      // the slot's inter-rail gap still applies to our sections.
      let wrap = slot.querySelector('#audiobooks-home-rails');
      if (!desired.length) { if (wrap) wrap.remove(); return; }
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'audiobooks-home-rails';
        wrap.style.display = 'contents';
        slot.appendChild(wrap); // after the reader's reading rails
      }
      const existing = new Map([...wrap.children].map((el) => [el.dataset.shelf, el]));
      const finalNodes = desired.map((next) => {
        const old = existing.get(next.dataset.shelf);
        return old && old.innerHTML === next.innerHTML ? old : next;
      });
      const unchanged = finalNodes.length === wrap.children.length && finalNodes.every((n, i) => n === wrap.children[i]);
      if (!unchanged) wrap.replaceChildren(...finalNodes);
    }

    function buildAbRail(shelf, items) {
      const sec = document.createElement('section');
      sec.className = 'ab-rail';
      sec.dataset.shelf = shelf.key;
      const head = document.createElement('div');
      head.className = 'ab-rail__head';
      const h = document.createElement('span');
      h.className = 'ab-rail__title';
      h.textContent = shelf.title;
      const hide = document.createElement('button');
      hide.className = 'ab-rail__hide';
      hide.title = 'Hide this rail — turn it back on from your Profile';
      hide.setAttribute('aria-label', 'Hide ' + shelf.title);
      hide.innerHTML = (api.icon && api.icon('close', { size: 16 })) || '×';
      hide.onclick = () => hideAbShelf(shelf);
      head.append(h, hide);
      const track = document.createElement('div');
      track.className = 'ab-rail__track';
      for (const it of items) track.appendChild(abCard(it));
      sec.append(head, track);
      return sec;
    }

    function abCard(it) {
      const el = document.createElement('button');
      el.className = 'ab-rail__card';
      el.title = it.title || '';
      el.innerHTML = `
        <span class="ab-rail__cover"><img src="${esc(it.cover_url || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"></span>
        <span class="ab-rail__label"><b>${esc(it.title || 'Untitled')}</b></span>
        ${it.publisher ? `<small class="ab-rail__sub">${esc(it.publisher)}</small>` : ''}`;
      el.onclick = () => { if (api.openSeries) api.openSeries(it.id); };
      return el;
    }

    async function hideAbShelf(shelf) {
      try { abPrefs = await api.post('/api/audiobooks/home-prefs', { [shelf.pref]: false }); } catch { /* retry next render */ }
      renderAudiobookRails();
    }

    // Per-user rail toggles on the Profile page (mirrors the reader's shelf prefs).
    function syncAudiobookPrefs() {
      const slot = api.slot('profile-plugin-slot');
      if (!slot) return;
      let card = slot.querySelector('#audiobooks-rails-prefs');
      if (!card) {
        card = document.createElement('section');
        card.className = 'settings-section';
        card.id = 'audiobooks-rails-prefs';
        card.innerHTML = '<p class="modal__subhead">Audiobook rails</p>'
          + '<p class="modal__note">Which audiobook rails appear on your home screen.</p>'
          + '<div class="ab-rails-prefs">'
          + AB_SHELVES.map((s) => `<label class="ab-rails-row"><input type="checkbox" data-pref="${s.pref}"> ${esc(s.title)}</label>`).join('')
          + '</div>';
        slot.appendChild(card);
        card.querySelectorAll('input[data-pref]').forEach((cb) => {
          cb.onchange = async () => {
            try { abPrefs = await api.post('/api/audiobooks/home-prefs', { [cb.dataset.pref]: cb.checked }); } catch { /* keep UI */ }
            renderAudiobookRails();
          };
        });
      }
      for (const cb of card.querySelectorAll('input[data-pref]')) {
        cb.checked = abPrefs ? abPrefs[cb.dataset.pref] !== false : true;
      }
    }

    renderAudiobookRails();

    async function render(container, ctx) {
      const issue = (ctx.issues || [])[0];
      const series = ctx.series || {};
      if (!issue || issue.id == null) {
        container.innerHTML = '<div class="ab-player ab-empty">This audiobook has no playable file yet.</div>';
        return;
      }
      const id = issue.id;
      const streamUrl = `/api/audiobooks/issue/${id}/stream`;
      const coverUrl = `/api/audiobooks/issue/${id}/cover`;
      const by = series.publisher || '';

      container.innerHTML = `
        <div class="ab-player" data-id="${id}">
          <div class="ab-hero">
            <div class="ab-cover"><img alt="" src="${coverUrl}" onerror="this.style.display='none';this.parentNode.classList.add('ab-cover--none')"><span class="ab-cover__ph">${esc((series.title || '?').slice(0, 1).toUpperCase())}</span></div>
            <div class="ab-meta">
              <h2 class="ab-title">${esc(series.title || 'Audiobook')}</h2>
              ${by ? `<div class="ab-author">${esc(by)}</div>` : ''}
              <div class="ab-narr"></div>
              <div class="ab-dur"></div>
            </div>
          </div>

          <input class="ab-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
          <div class="ab-times"><span class="ab-cur">0:00</span><span class="ab-rem">-0:00</span></div>

          <div class="ab-controls">
            <button class="ab-btn ab-back" title="Back 15s">${SVG.back15}</button>
            <button class="ab-btn ab-btn--main ab-toggle" title="Play">${SVG.play}</button>
            <button class="ab-btn ab-fwd" title="Forward 15s">${SVG.fwd15}</button>
          </div>

          <div class="ab-bar">
            <button class="ab-chip ab-speed">${SVG.speed}<span class="ab-speed__v">1×</span></button>
            <button class="ab-chip ab-chapbtn">${SVG.list} Chapters</button>
            <button class="ab-chip ab-sleepbtn">${SVG.clock}<span class="ab-sleep__v"> Sleep</span></button>
            <button class="ab-chip ab-markbtn">${SVG.mark} Bookmark</button>
          </div>

          <div class="ab-panel ab-chapters" hidden></div>
          <div class="ab-panel ab-bookmarks" hidden></div>

          <audio class="ab-audio" preload="metadata" src="${streamUrl}"></audio>
        </div>`;

      const $ = (s) => container.querySelector(s);
      const audio = $('.ab-audio');
      const seek = $('.ab-seek');
      const toggle = $('.ab-toggle');
      const curEl = $('.ab-cur'), remEl = $('.ab-rem'), durEl = $('.ab-dur'), narrEl = $('.ab-narr');
      let duration = 0, seeking = false, saveTimer = null, sleepTimer = null, chapters = null;

      // Narrators + duration from the info map.
      try {
        const info = (await ctx.get(`/api/audiobooks/info?issues=${id}`)).info || {};
        const meta = info[id] || {};
        if (meta.narrators) narrEl.textContent = 'Read by ' + meta.narrators;
        if (meta.duration) { duration = meta.duration; durEl.textContent = fmt(meta.duration) + ' • audiobook'; }
      } catch { /* non-fatal */ }

      // Resume position.
      let startAt = 0;
      try { const p = await ctx.get(`/api/audiobooks/issue/${id}/progress`); startAt = Number(p.position) || 0; } catch { /* none */ }

      const paintTime = () => {
        const cur = audio.currentTime || 0;
        const dur = duration || audio.duration || 0;
        curEl.textContent = fmt(cur);
        remEl.textContent = '-' + fmt(Math.max(0, dur - cur));
        if (!seeking && dur) seek.value = String(Math.round((cur / dur) * 1000));
        highlightChapter(cur);
      };
      const saveProgress = () => {
        if (!audio.currentTime) return;
        ctx.post(`/api/audiobooks/issue/${id}/progress`, { position: audio.currentTime, duration: duration || audio.duration || 0 }).catch(() => {});
      };

      audio.addEventListener('loadedmetadata', () => {
        if (!duration && audio.duration && Number.isFinite(audio.duration)) { duration = audio.duration; durEl.textContent = fmt(duration) + ' • audiobook'; }
        if (startAt > 0 && startAt < (duration || audio.duration || Infinity) - 5) { try { audio.currentTime = startAt; } catch { /* not seekable yet */ } }
        paintTime();
      });
      audio.addEventListener('timeupdate', paintTime);
      audio.addEventListener('play', () => { toggle.innerHTML = SVG.pause; toggle.title = 'Pause'; saveTimer = setInterval(saveProgress, 10000); });
      audio.addEventListener('pause', () => { toggle.innerHTML = SVG.play; toggle.title = 'Play'; clearInterval(saveTimer); saveProgress(); renderAudiobookRails(); });
      audio.addEventListener('ended', () => { clearInterval(saveTimer); saveProgress(); });

      toggle.onclick = () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); };
      $('.ab-back').onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 15); paintTime(); };
      $('.ab-fwd').onclick = () => { audio.currentTime = Math.min((duration || audio.duration || 0), audio.currentTime + 15); paintTime(); };
      seek.addEventListener('input', () => { seeking = true; const dur = duration || audio.duration || 0; curEl.textContent = fmt((seek.value / 1000) * dur); });
      seek.addEventListener('change', () => { const dur = duration || audio.duration || 0; audio.currentTime = (seek.value / 1000) * dur; seeking = false; saveProgress(); });

      // Speed cycles through SPEEDS.
      const speedV = $('.ab-speed__v');
      let speedIdx = SPEEDS.indexOf(Number(localStorage.getItem('abSpeed')) || 1); if (speedIdx < 0) speedIdx = 1;
      const applySpeed = () => { audio.playbackRate = SPEEDS[speedIdx]; speedV.textContent = SPEEDS[speedIdx] + '×'; localStorage.setItem('abSpeed', String(SPEEDS[speedIdx])); };
      $('.ab-speed').onclick = () => { speedIdx = (speedIdx + 1) % SPEEDS.length; applySpeed(); };
      applySpeed();

      // Chapters panel (lazy).
      const chapPanel = $('.ab-chapters');
      const highlightChapter = (cur) => {
        if (!chapters || !chapters.length) return;
        let idx = 0;
        for (let i = 0; i < chapters.length; i++) if (cur >= chapters[i].start) idx = i;
        chapPanel.querySelectorAll('.ab-chap').forEach((el, i) => el.classList.toggle('is-current', i === idx));
      };
      $('.ab-chapbtn').onclick = async () => {
        $('.ab-bookmarks').hidden = true;
        if (!chapPanel.hidden) { chapPanel.hidden = true; return; }
        if (chapters == null) {
          chapPanel.innerHTML = '<div class="ab-panel__load">Loading chapters…</div>';
          chapPanel.hidden = false;
          try { chapters = (await ctx.get(`/api/audiobooks/issue/${id}/chapters`)).chapters || []; } catch { chapters = []; }
          chapPanel.innerHTML = chapters.length
            ? chapters.map((c, i) => `<button class="ab-chap" data-t="${c.start}"><span class="ab-chap__n">${i + 1}.</span> <span class="ab-chap__t">${esc(c.title || ('Chapter ' + (i + 1)))}</span><span class="ab-chap__time">${fmt(c.start)}</span></button>`).join('')
            : '<div class="ab-panel__empty">No chapter marks for this audiobook.</div>';
          chapPanel.querySelectorAll('.ab-chap').forEach((el) => { el.onclick = () => { audio.currentTime = Number(el.dataset.t) || 0; audio.play().catch(() => {}); paintTime(); }; });
        } else chapPanel.hidden = false;
        highlightChapter(audio.currentTime || 0);
      };

      // Sleep timer.
      const sleepV = $('.ab-sleep__v');
      $('.ab-sleepbtn').onclick = () => {
        if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; sleepV.textContent = ' Sleep'; return; }
        const mins = SLEEP_MINS[(SLEEP_MINS.indexOf(currentSleep) + 1) % SLEEP_MINS.length];
        currentSleep = mins;
        clearTimeout(sleepTimer);
        sleepTimer = setTimeout(() => { audio.pause(); sleepTimer = null; sleepV.textContent = ' Sleep'; }, mins * 60000);
        sleepV.textContent = ` ${mins}m`;
      };
      let currentSleep = 0;

      // Bookmarks.
      const bmPanel = $('.ab-bookmarks');
      const loadBookmarks = async () => {
        let list = [];
        try { list = (await ctx.get(`/api/audiobooks/issue/${id}/bookmarks`)).bookmarks || []; } catch { /* none */ }
        bmPanel.innerHTML = list.length
          ? list.map((b) => `<div class="ab-bm" data-id="${b.id}" data-t="${b.position}"><button class="ab-bm__go">${fmt(b.position)}</button><span class="ab-bm__note">${esc(b.note || 'Bookmark')}</span><button class="ab-bm__del" title="Delete">×</button></div>`).join('')
          : '<div class="ab-panel__empty">No bookmarks yet — tap Bookmark to save your spot.</div>';
        bmPanel.querySelectorAll('.ab-bm').forEach((el) => {
          el.querySelector('.ab-bm__go').onclick = () => { audio.currentTime = Number(el.dataset.t) || 0; audio.play().catch(() => {}); paintTime(); };
          el.querySelector('.ab-bm__del').onclick = async () => { try { await fetch(`/api/audiobooks/bookmarks/${el.dataset.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } }); } catch { /* keep list */ } loadBookmarks(); };
        });
      };
      $('.ab-markbtn').onclick = async () => {
        try { await ctx.post(`/api/audiobooks/issue/${id}/bookmarks`, { position: audio.currentTime || 0, note: chapterTitleAt(audio.currentTime || 0) }); api.toast && api.toast('Bookmark saved.', 'ok'); } catch { api.toast && api.toast('Could not save bookmark.', 'error'); }
        $('.ab-chapters').hidden = true; bmPanel.hidden = false; loadBookmarks();
      };
      const chapterTitleAt = (t) => {
        if (!chapters || !chapters.length) return null;
        let title = null; for (const c of chapters) if (t >= c.start) title = c.title;
        return title || null;
      };

      // Save on navigate away / tab close.
      const onHide = () => saveProgress();
      window.addEventListener('pagehide', onHide);
      document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
    }
  });
})();
