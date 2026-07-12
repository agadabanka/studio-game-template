// ── UPDATE SHELL · the in-game "live dev" layer ──────────────────────────────
// Drop-in, framework-free script every game ships (synced from
// engine/sdk/update-shell.js by scripts/sync-sdk.mjs — edit THAT copy).
//
// Three pieces, all silent until there's news:
//   1. VERSION  — polls the game's own /api/version. When Railway finishes a
//      deploy the served version changes; instead of yanking the page out from
//      under the player we show a "🚀 Update ready" pill and reload ONLY when
//      they tap it (mid-jump reloads are how you lose players).
//   2. LIVE-DEV toasts — polls the hub's /api/online/status?game=<id> so the
//      player sees the engine's agent working on their notes in real time
//      ("🤖 fixing: …", "✅ fixes shipped").
//   3. LIVE-DEV panel — a small 🤖 pill (top-right) that opens the in-game
//      cockpit: the LIVE switch (on → the hub starts on open notes right away
//      and keeps watching this game), every playtest note with its live state
//      (waiting · 🤖 fixing · ✅ fixed live · ⏭ skipped), and run progress.
//      The switch calls the hub's POST /api/online/<id>/live.
//
// Contracts:
//   · NEVER auto-reload, NEVER throw, NEVER log errors (games gate on
//     0-console-errors) — every failure path is swallowed.
//   · Gated to humans: under any automated harness the file is a no-op, so the
//     deterministic gate never sees network jitter or toasts. Detection is
//     navigator.webdriver (set by Playwright/Puppeteer — covers every game's
//     eval, which may load plain "/?level=N" URLs without ?auto) plus the
//     explicit ?auto flag. Tests can opt back in with UPDATE_SHELL.force.
//   · Zero config in engine games: game id comes from window.UPDATE_SHELL,
//     window.ANALYTICS.game, or /api/meta; hub base from UPDATE_SHELL.hub,
//     ANALYTICS.trackUrl's origin, or the production hub default.
//     UPDATE_SHELL.panel === false hides the pill (toasts stay).
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof fetch === 'undefined' || typeof document === 'undefined') return;
  var CFG = window.UPDATE_SHELL || {};
  // human-only nicety: a no-op under any automated harness (navigator.webdriver
  // covers headless evals that load plain "/?level=N" URLs) unless a test forces it on.
  if (!CFG.force && (navigator.webdriver || /[?&]auto([=&]|$)/.test(window.location.search) || window.__AUTOPILOT)) return;

  var DEFAULT_HUB = 'https://hub-production-6d28.up.railway.app';
  var VERSION_MS = Number(CFG.versionMs) || 25000;
  var STATUS_MS = Number(CFG.statusMs) || 40000;
  var PANEL_MS = Number(CFG.panelMs) || 12000;    // faster refresh while the panel is open

  function hubBase() {
    if (CFG.hub) return String(CFG.hub).replace(/\/+$/, '');
    try { if (window.ANALYTICS && window.ANALYTICS.trackUrl) return new URL(window.ANALYTICS.trackUrl).origin; } catch (e) {}
    return DEFAULT_HUB;
  }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ── tiny toast layer (self-contained, no CSS file) ──
  var wrap = null;
  function ensureWrap() {
    if (wrap && document.body.contains(wrap)) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'update-shell';
    wrap.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;font-family:system-ui,-apple-system,Segoe UI,sans-serif;';
    (document.body || document.documentElement).appendChild(wrap);
    return wrap;
  }
  function makeToast(id, html, opts) {
    opts = opts || {};
    var w = ensureWrap();
    var el = document.getElementById('ushell-' + id);
    if (!el) {
      el = document.createElement('div');
      el.id = 'ushell-' + id;
      el.style.cssText = 'pointer-events:auto;max-width:min(92vw,460px);padding:10px 16px;border-radius:999px;background:rgba(18,18,28,.92);color:#fff;font-size:14px;line-height:1.35;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(6px);display:flex;gap:8px;align-items:center;cursor:' + (opts.onClick ? 'pointer' : 'default') + ';transition:opacity .3s,transform .3s;opacity:0;transform:translateY(8px);text-align:center;';
      w.appendChild(el);
      requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    }
    el.innerHTML = html;
    el.onclick = opts.onClick || null;
    if (opts.accent) el.style.borderColor = opts.accent;
    if (el._t) { clearTimeout(el._t); el._t = null; }
    if (opts.ttl) el._t = setTimeout(function () { dropToast(id); }, opts.ttl);
    return el;
  }
  function dropToast(id) {
    var el = document.getElementById('ushell-' + id);
    if (!el) return;
    el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
    setTimeout(function () { try { el.remove(); } catch (e) {} }, 350);
  }

  // ── 1 · update-available (own /api/version) ──
  var baseVersion = null, updateShown = false;
  function showUpdate() {
    if (updateShown) return;
    updateShown = true;
    makeToast('update', '🚀 <b>Update ready!</b>&nbsp; New fixes just shipped — tap to reload', {
      accent: 'rgba(122,220,255,.65)',
      onClick: function () { try { window.location.reload(); } catch (e) {} },
    });
    paintPill();
  }
  function pollVersion() {
    if (document.hidden || updateShown) return;
    fetch('/api/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.version) return;
      if (baseVersion === null) baseVersion = j.version;
      else if (j.version !== baseVersion) showUpdate();
    }).catch(function () {});
  }

  // ── shared hub state ──
  var gameId = CFG.game || (window.ANALYTICS && window.ANALYTICS.game) || null;
  var metaTried = false;
  var HUB = { live: false, job: null, recent: [], open: [], enabled: null };  // latest hub view of this game
  function resolveGameId(cb) {
    if (gameId || metaTried) return cb();
    metaTried = true;
    fetch('/api/meta', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      if (m) gameId = m.slug || m.id || (m.name ? String(m.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null);
      cb();
    }).catch(function () { cb(); });
  }

  // ── 2 · live-dev toasts ──
  var lastJobKey = '';
  function renderJobToast(job) {
    var key = job.id + '·' + job.phase + '·' + (job.issues || []).map(function (i) { return i.state; }).join('');
    if (key === lastJobKey) return;
    lastJobKey = key;
    var fixing = (job.issues || []).filter(function (i) { return i.state === 'fixing' || i.state === 'queued'; });
    var title = fixing.length ? fixing[0].title : ((job.issues || [])[0] || {}).title || '';
    title = String(title || '').replace(/[<>&]/g, ' ').slice(0, 80);
    if (job.status === 'running' || job.status === 'merging') {
      var label = job.status === 'merging' ? 'shipping fixes…' : ('working on your notes' + (title ? ': <i>' + esc(title) + '</i>' : '…'));
      makeToast('live', '🤖 <b>Live dev</b>&nbsp; ' + label, { accent: 'rgba(255,180,120,.6)' });
    } else if (job.status === 'deployed' || job.status === 'done') {
      makeToast('live', '✅ <b>Live dev</b>&nbsp; ' + (job.issues || []).filter(function (i) { return i.state === 'fixed'; }).length + ' note(s) fixed — new build on its way', { accent: 'rgba(140,255,170,.6)', ttl: 20000 });
    } else if (job.status === 'failed') {
      makeToast('live', '🛠️ <b>Live dev</b>&nbsp; this round hit a snag — the notes stay queued', { accent: 'rgba(255,130,130,.6)', ttl: 15000 });
    }
  }
  function pollStatus() {
    if (document.hidden) return;
    resolveGameId(function () {
      if (!gameId) return;
      fetch(hubBase() + '/api/online/status?game=' + encodeURIComponent(gameId), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          HUB.enabled = !!j.enabled;
          HUB.live = !!j.live;
          HUB.job = j.active && j.active.game === gameId ? j.active : null;
          HUB.recent = (j.jobs || []).filter(function (x) { return x.game === gameId; });
          var toastJob = HUB.job || HUB.recent[0];
          if (toastJob) renderJobToast(toastJob);
          paintPill(); paintPanel();
        }).catch(function () {});
    });
  }
  function pollQueue() {
    if (!gameId || !panelOpen) return;
    fetch(hubBase() + '/api/online/' + encodeURIComponent(gameId) + '/queue', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { HUB.open = j.notes || []; HUB.live = !!j.live; paintPanel(); } })
      .catch(function () {});
  }

  // ── 3 · the in-game cockpit (🤖 pill + panel) ──
  var pill = null, panel = null, panelOpen = false, busyToggle = false, toggleErr = '';
  function paintPill() {
    if (CFG.panel === false) return;
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'ushell-pill';
      pill.style.cssText = 'position:fixed;top:64px;right:12px;z-index:2147483001;width:42px;height:42px;border-radius:50%;background:rgba(18,18,28,.88);border:1px solid rgba(255,255,255,.18);box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font:20px system-ui;cursor:pointer;user-select:none;backdrop-filter:blur(6px);transition:transform .15s;';
      pill.title = 'Live dev — playtest notes, live fixes, updates';
      pill.onmouseenter = function () { pill.style.transform = 'scale(1.08)'; };
      pill.onmouseleave = function () { pill.style.transform = 'scale(1)'; };
      pill.onclick = function () { panelOpen ? closePanel() : openPanel(); };
      (document.body || document.documentElement).appendChild(pill);
    }
    var working = HUB.job && (HUB.job.status === 'running' || HUB.job.status === 'merging');
    var dot = updateShown ? '#7adcff' : working ? '#ffb14d' : HUB.live ? '#5fd66e' : null;
    pill.innerHTML = '🤖' + (dot ? '<span style="position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;background:' + dot + ';border:2px solid rgba(18,18,28,.9);' + (working ? 'animation:ushellpulse 1.2s ease-in-out infinite;' : '') + '"></span>' : '');
    ensureKeyframes();
  }
  var kfDone = false;
  function ensureKeyframes() {
    if (kfDone) return; kfDone = true;
    try {
      var st = document.createElement('style');
      st.textContent = '@keyframes ushellpulse{0%,100%{opacity:1}50%{opacity:.3}}';
      document.head.appendChild(st);
    } catch (e) {}
  }
  var PHASE_LABEL = { queued: 'queued', clone: 'getting the code', agent: '🤖 fixing', gate: 'testing', merge: 'shipping', push: 'shipping', close: 'wrapping up', done: 'done', failed: 'stopped' };
  function noteRow(icon, title, label, color) {
    return '<div style="display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-top:1px solid rgba(255,255,255,.07)">'
      + '<span style="flex:none">' + icon + '</span>'
      + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc(String(title || '').slice(0, 120)) + '</span>'
      + '<span style="flex:none;font-size:11px;color:' + color + ';font-weight:700;letter-spacing:.03em;padding-top:2px">' + label + '</span></div>';
  }
  function panelNotes() {
    var rows = [], seen = {};
    var jobIssues = (HUB.job ? HUB.job.issues : []) || [];
    jobIssues.forEach(function (i) {
      seen[i.n] = 1;
      if (i.state === 'fixing') rows.push(noteRow('🤖', i.title, 'FIXING NOW', '#ffb14d'));
      else if (i.state === 'queued') rows.push(noteRow('⏳', i.title, 'IN THIS RUN', '#cfe0ff'));
      else if (i.state === 'fixed' || i.state === 'fixed-unclosed') rows.push(noteRow('✅', i.title, 'FIXED', '#5fd66e'));
      else if (i.state === 'skipped') rows.push(noteRow('⏭', i.title, 'SKIPPED', '#8fa3c8'));
    });
    (HUB.open || []).forEach(function (n) {
      if (seen[n.number]) return; seen[n.number] = 1;
      rows.push(noteRow('📝', n.title, HUB.live ? 'WAITING' : 'NOT ADDRESSED', HUB.live ? '#cfe0ff' : '#8fa3c8'));
    });
    var recentShown = 0;
    (HUB.recent || []).forEach(function (j) {
      (j.issues || []).forEach(function (i) {
        if (seen[i.n] || recentShown >= 6) return; seen[i.n] = 1;
        if (i.state === 'fixed' || i.state === 'fixed-unclosed') { recentShown++; rows.push(noteRow('✅', i.title, 'FIXED LIVE', '#5fd66e')); }
      });
    });
    return rows.length ? rows.join('')
      : '<div style="color:#8fa3c8;padding:8px 0 2px">No playtest notes yet — pause the game and drop a 📝 note, then flip Live on and watch it get fixed.</div>';
  }
  function paintPanel() {
    if (!panelOpen || !panel) return;
    var working = HUB.job && (HUB.job.status === 'running' || HUB.job.status === 'merging');
    var statusLine = HUB.enabled === false
      ? '<span style="color:#8fa3c8">online mode is off on the hub (missing key)</span>'
      : working ? '<span style="color:#ffb14d">● ' + (PHASE_LABEL[HUB.job.phase] || HUB.job.phase) + '…</span>'
      : updateShown ? '<span style="color:#7adcff">🚀 update ready — tap the banner below to reload</span>'
      : HUB.live ? '<span style="color:#5fd66e">● watching — new notes get picked up automatically</span>'
      : '<span style="color:#8fa3c8">○ live is off — notes wait for you to flip it on</span>';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">'
      + '<b style="font-size:15px">🤖 Live dev</b><span style="flex:1"></span>'
      + '<span id="ushell-close" style="cursor:pointer;padding:2px 8px;color:#8fa3c8;font-size:16px">✕</span></div>'
      + '<div style="display:flex;align-items:center;gap:10px;padding:10px 0 8px">'
      +   '<div style="flex:1"><b>Live mode</b><div style="font-size:11.5px;color:#8fa3c8;margin-top:1px">agent fixes your notes as they arrive, updates ship right into the game</div>'
      +   (toggleErr ? '<div style="font-size:11.5px;color:#ff8a8a;margin-top:2px">' + esc(toggleErr) + '</div>' : '') + '</div>'
      +   '<div id="ushell-toggle" style="cursor:pointer;flex:none;width:46px;height:26px;border-radius:99px;position:relative;transition:background .2s;background:' + (HUB.live ? 'rgba(95,214,110,.45)' : 'rgba(255,255,255,.14)') + ';opacity:' + (busyToggle ? '.5' : '1') + '">'
      +     '<span style="position:absolute;top:3px;left:' + (HUB.live ? '23px' : '3px') + ';width:20px;height:20px;border-radius:50%;background:' + (HUB.live ? '#5fd66e' : '#8fa3c8') + ';transition:left .2s"></span></div></div>'
      + '<div style="font-size:12.5px;padding:2px 0 8px">' + statusLine + '</div>'
      + '<div style="font-size:11px;color:#8fa3c8;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-top:2px">Your playtest notes</div>'
      + '<div style="max-height:38vh;overflow-y:auto;font-size:13px">' + panelNotes() + '</div>';
    var t = document.getElementById('ushell-toggle');
    if (t) t.onclick = toggleLive;
    var c = document.getElementById('ushell-close');
    if (c) c.onclick = closePanel;
  }
  function openPanel() {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ushell-panel';
      panel.style.cssText = 'position:fixed;top:114px;right:12px;z-index:2147483001;width:min(92vw,340px);padding:14px 16px;border-radius:16px;background:rgba(14,16,26,.96);color:#fff;border:1px solid rgba(255,255,255,.16);box-shadow:0 12px 40px rgba(0,0,0,.55);backdrop-filter:blur(10px);font:13.5px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;';
      (document.body || document.documentElement).appendChild(panel);
    }
    panelOpen = true;
    panel.style.display = 'block';
    paintPanel();
    pollStatus(); pollQueue();
  }
  function closePanel() { panelOpen = false; if (panel) panel.style.display = 'none'; }
  function toggleLive() {
    if (busyToggle || !gameId) return;
    busyToggle = true; toggleErr = '';
    var want = !HUB.live;
    HUB.live = want; paintPanel();   // optimistic
    fetch(hubBase() + '/api/online/' + encodeURIComponent(gameId) + '/live', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: want }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      busyToggle = false;
      if (!j || j.ok !== true) { HUB.live = !want; toggleErr = 'could not reach the engine — try again'; }
      else {
        HUB.live = !!j.live;
        if (want && j.queued) HUB.job = j.queued;
      }
      paintPanel(); paintPill();
      pollStatus(); pollQueue();
    }).catch(function () { busyToggle = false; HUB.live = !want; toggleErr = 'could not reach the engine — try again'; paintPanel(); paintPill(); });
  }

  // ── timers ──
  setTimeout(pollVersion, 4000);
  setInterval(pollVersion, VERSION_MS);
  setTimeout(function () { pollStatus(); paintPill(); }, 5000);
  setInterval(function () { pollStatus(); if (panelOpen) pollQueue(); }, STATUS_MS);
  setInterval(function () { if (panelOpen) { pollStatus(); pollQueue(); } }, PANEL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { pollVersion(); pollStatus(); } });

  window.UPDATE_SHELL_API = { pollVersion: pollVersion, pollStatus: pollStatus, openPanel: openPanel, closePanel: closePanel, _toast: makeToast };
})();
