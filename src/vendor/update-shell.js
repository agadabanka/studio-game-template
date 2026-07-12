// ── UPDATE SHELL · the in-game "live dev" layer ──────────────────────────────
// Drop-in, framework-free script every game ships (synced from
// engine/sdk/update-shell.js by scripts/sync-sdk.mjs — edit THAT copy).
//
// ONE ui element: the status bar, top-right.
//   · idle            → a small ⚙️ button (green dot when Live mode is watching)
//   · agent working   → "⚙️ Fixing: <note>" with a spinning gear — tap for the
//                       details panel, or tap the › to collapse it back to the
//                       small button (preference remembered)
//   · new build ready → "🚀 Update ready — tap to reload" (reloads ONLY on tap;
//                       we never yank the player mid-game)
// Tapping the bar (except the update state, which reloads) opens the
// GAME ENGINE · Live Dev panel: the LIVE switch (on → the hub starts on open
// notes right away and keeps watching this game), the current run as a step
// progress bar (pick up → fix → test → ship → live), every playtest note with
// its live state, and recently shipped fixes.
//
// Plumbing: the game's own /api/version (deploy detection) + the hub's
// /api/online/status?game=, /api/online/<id>/queue and POST /api/online/<id>/live.
//
// Contracts:
//   · NEVER auto-reload, NEVER throw, NEVER log errors (games gate on
//     0-console-errors) — every failure path is swallowed.
//   · Gated to humans: under any automated harness the file is a no-op
//     (navigator.webdriver covers headless evals that load plain "/?level=N"
//     URLs, plus the explicit ?auto flag). Tests opt back in with
//     UPDATE_SHELL.force.
//   · Zero config in engine games: game id from window.UPDATE_SHELL →
//     ANALYTICS.game → /api/meta; hub from UPDATE_SHELL.hub → ANALYTICS
//     trackUrl origin → the production hub. UPDATE_SHELL.panel === false
//     hides the whole thing.
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof fetch === 'undefined' || typeof document === 'undefined') return;
  var CFG = window.UPDATE_SHELL || {};
  if (!CFG.force && (navigator.webdriver || /[?&]auto([=&]|$)/.test(window.location.search) || window.__AUTOPILOT)) return;
  if (CFG.panel === false) return;

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
  // note titles arrive as issue titles ("📝 🎙️ 0:11 — …") — show just the words.
  // Escapes, not literal emoji: a host page without <meta charset> must not be
  // able to mojibake this pattern.
  var cleanTitle = function (s) { return String(s == null ? '' : s).replace(/^(?:\s|📝|🎙️?|️|•|·)+/g, '').trim(); };
  var ago = function (t) {
    if (!t) return '';
    var s = (Date.now() - new Date(t).getTime()) / 1000;
    if (!(s >= 0)) return '';
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  var store = {
    get: function (k) { try { return window.localStorage.getItem('ushell:' + k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem('ushell:' + k, v); } catch (e) {} },
  };

  var styled = false;
  function ensureStyle() {
    if (styled) return; styled = true;
    try {
      var st = document.createElement('style');
      st.textContent =
        '@keyframes ushellpulse{0%,100%{opacity:1}50%{opacity:.3}}' +
        '@keyframes ushellspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
        '#ushell-panel *{box-sizing:border-box}' +
        '#ushell-panel ::-webkit-scrollbar{width:6px}#ushell-panel ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px}';
      document.head.appendChild(st);
    } catch (e) {}
  }

  // ── 1 · update-available (own /api/version) ──
  var baseVersion = null, updateShown = false;
  function pollVersion() {
    if (document.hidden || updateShown) return;
    fetch('/api/version', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.version) return;
      if (baseVersion === null) baseVersion = j.version;
      else if (j.version !== baseVersion) { updateShown = true; paintBar(); paintPanel(); }
    }).catch(function () {});
  }

  // ── shared hub state ──
  var gameId = CFG.game || (window.ANALYTICS && window.ANALYTICS.game) || null;
  var metaTried = false;
  var HUB = { live: false, job: null, recent: [], open: [], enabled: null };
  function resolveGameId(cb) {
    if (gameId || metaTried) return cb();
    metaTried = true;
    fetch('/api/meta', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      if (m) gameId = m.slug || m.id || (m.name ? String(m.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null);
      cb();
    }).catch(function () { cb(); });
  }
  function working() { return !!(HUB.job && (HUB.job.status === 'running' || HUB.job.status === 'merging' || HUB.job.status === 'queued')); }
  function fixingTitle() {
    if (!HUB.job) return '';
    var f = (HUB.job.issues || []).filter(function (i) { return i.state === 'fixing'; })[0] || (HUB.job.issues || [])[0] || {};
    return cleanTitle(f.title || '');
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
          HUB.job = (j.active && j.active.game === gameId) ? j.active : (j.queue || []).filter(function (x) { return x.game === gameId; })[0] || null;
          HUB.recent = (j.jobs || []).filter(function (x) { return x.game === gameId; });
          paintBar(); paintPanel();
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

  // ── 2 · THE status bar (the only ambient element) ──
  var bar = null, panel = null, panelOpen = false, busyToggle = false, toggleErr = '';
  var compact = store.get('compact') === '1';
  function paintBar() {
    ensureStyle();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ushell-pill';
      bar.style.cssText = 'position:fixed;top:64px;right:12px;z-index:2147483001;height:42px;border-radius:99px;background:rgba(16,18,30,.9);border:1px solid rgba(255,255,255,.18);box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;gap:8px;padding:0 12px;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;cursor:pointer;user-select:none;backdrop-filter:blur(6px);transition:transform .15s,border-color .3s;max-width:min(72vw,320px);white-space:nowrap;overflow:hidden;';
      bar.title = 'Game Engine · Live Dev';
      bar.onmouseenter = function () { bar.style.transform = 'scale(1.05)'; };
      bar.onmouseleave = function () { bar.style.transform = 'scale(1)'; };
      bar.onclick = function () {
        if (updateShown && !panelOpen) { try { window.location.reload(); } catch (e) {} return; }
        panelOpen ? closePanel() : openPanel();
      };
      (document.body || document.documentElement).appendChild(bar);
    }
    var gear = function (spin) { return '<span style="display:inline-block;' + (spin ? 'animation:ushellspin 2.4s linear infinite;' : '') + '">⚙️</span>'; };
    var collapseBtn = '<span id="ushell-min" title="collapse" style="margin-left:2px;padding:2px 4px;color:rgba(255,255,255,.55);font-size:15px;line-height:1">›</span>';
    var inner, border;
    if (updateShown && !compact) {
      inner = '🚀 <span>Update ready — tap to reload</span>' + collapseBtn;
      border = 'rgba(122,220,255,.85)';
    } else if (updateShown && compact) {
      inner = '🚀';
      border = 'rgba(122,220,255,.85)';
    } else if (working() && !compact) {
      var t = fixingTitle();
      inner = gear(true) + ' <span>Fixing:</span><span style="opacity:.75;font-weight:400;overflow:hidden;text-overflow:ellipsis">' + esc(t ? t.slice(0, 42) : 'your notes…') + '</span>' + collapseBtn;
      border = 'rgba(255,177,77,.85)';
    } else if (working() && compact) {
      inner = gear(true) + '<span style="width:9px;height:9px;border-radius:50%;background:#ffb14d;animation:ushellpulse 1.2s ease-in-out infinite"></span>';
      border = 'rgba(255,177,77,.7)';
    } else if (HUB.live) {
      inner = gear(false) + '<span style="width:9px;height:9px;border-radius:50%;background:#5fd66e;box-shadow:0 0 8px rgba(95,214,110,.9)"></span>';
      border = 'rgba(95,214,110,.5)';
    } else {
      inner = gear(false);
      border = 'rgba(255,255,255,.18)';
    }
    bar.innerHTML = inner;
    bar.style.borderColor = border;
    var min = document.getElementById('ushell-min');
    if (min) min.onclick = function (e) { e.stopPropagation(); compact = true; store.set('compact', '1'); paintBar(); };
  }

  // ── 3 · the GAME ENGINE · Live Dev panel ──
  var STEPS = ['pick up', 'fix', 'test', 'ship', 'live'];
  var PHASE_STEP = { queued: 0, clone: 0, agent: 1, gate: 2, merge: 3, push: 3, close: 3, done: 4, failed: -1 };
  function stepBar(job) {
    var idx = job.status === 'deployed' || job.status === 'done' ? 4 : (PHASE_STEP[job.phase] != null ? PHASE_STEP[job.phase] : 1);
    var failed = job.status === 'failed';
    var cells = STEPS.map(function (name, i) {
      var done = !failed && i < idx, cur = !failed && i === idx && idx < 4, reached = !failed && i <= idx;
      var col = failed ? 'rgba(255,130,130,.5)' : done || (reached && idx === 4) ? '#5fd66e' : cur ? '#ffb14d' : 'rgba(255,255,255,.16)';
      return '<div style="flex:1;text-align:center">'
        + '<div style="height:5px;border-radius:3px;background:' + col + ';' + (cur ? 'animation:ushellpulse 1.2s ease-in-out infinite;' : '') + '"></div>'
        + '<div style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;margin-top:4px;color:' + (reached && !failed ? '#cfe0ff' : 'rgba(255,255,255,.35)') + ';font-weight:700">' + name + '</div></div>';
    }).join('<div style="width:6px"></div>');
    return '<div style="display:flex;align-items:flex-start;margin:8px 0 2px">' + cells + '</div>';
  }
  function sect(title, extra) {
    return '<div style="font-size:10.5px;color:#8fa3c8;text-transform:uppercase;letter-spacing:.1em;font-weight:800;margin:14px 0 4px">' + title + (extra || '') + '</div>';
  }
  function noteRow(icon, title, label, color) {
    return '<div style="display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-top:1px solid rgba(255,255,255,.07)">'
      + '<span style="flex:none">' + icon + '</span>'
      + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc(cleanTitle(title).slice(0, 120)) + '</span>'
      + '<span style="flex:none;font-size:10px;color:' + color + ';font-weight:800;letter-spacing:.05em;padding-top:3px">' + label + '</span></div>';
  }
  function panelNotes() {
    var rows = [], seen = {};
    ((HUB.job ? HUB.job.issues : []) || []).forEach(function (i) {
      seen[i.n] = 1;
      if (i.state === 'fixing') rows.push(noteRow('🔧', i.title, 'FIXING NOW', '#ffb14d'));
      else if (i.state === 'queued') rows.push(noteRow('⏳', i.title, 'IN THIS RUN', '#cfe0ff'));
      else if (i.state === 'fixed' || i.state === 'fixed-unclosed') rows.push(noteRow('✅', i.title, 'FIXED', '#5fd66e'));
      else if (i.state === 'skipped') rows.push(noteRow('⏭', i.title, 'SKIPPED', '#8fa3c8'));
    });
    (HUB.open || []).forEach(function (n) {
      if (seen[n.number]) return; seen[n.number] = 1;
      rows.push(noteRow('📝', n.title, HUB.live ? 'WAITING' : 'NOT ADDRESSED', HUB.live ? '#cfe0ff' : '#8fa3c8'));
    });
    return rows.length ? rows.join('')
      : '<div style="color:#8fa3c8;padding:8px 0 2px;font-size:12.5px">No open notes. Pause the game → 📝 to drop one; with Live on it gets picked up automatically.</div>';
  }
  function panelShipped() {
    var rows = [], count = 0;
    (HUB.recent || []).forEach(function (j) {
      if (j.status !== 'deployed' && j.status !== 'done') return;
      (j.issues || []).forEach(function (i) {
        if (count >= 6) return;
        if (i.state === 'fixed' || i.state === 'fixed-unclosed') {
          count++;
          rows.push(noteRow('✅', i.title, esc((j.mergeSha ? j.mergeSha + ' · ' : '') + (ago(j.finishedAt) || 'shipped')), '#5fd66e'));
        }
      });
    });
    return rows.length ? sect('Recently shipped') + rows.join('') : '';
  }
  function paintPanel() {
    if (!panelOpen || !panel) return;
    var head =
      '<div style="margin:-16px -18px 0;padding:14px 18px 12px;background:linear-gradient(135deg,rgba(64,94,255,.22),rgba(255,122,209,.10));border-bottom:1px solid rgba(255,255,255,.1);border-radius:18px 18px 0 0">'
      + '<div style="display:flex;align-items:center;gap:8px">'
      +   '<span style="font-size:10px;letter-spacing:.22em;color:#9fb3e0;font-weight:800">⚙️ GAME ENGINE</span><span style="flex:1"></span>'
      +   '<span id="ushell-close" style="cursor:pointer;padding:2px 6px;color:#8fa3c8;font-size:16px;line-height:1">✕</span></div>'
      + '<div style="display:flex;align-items:baseline;gap:8px;margin-top:3px"><b style="font-size:17px">Live Dev</b>'
      +   '<span style="color:#8fa3c8;font-size:12px">' + esc(gameId || '') + '</span></div></div>';

    var liveRow =
      '<div style="display:flex;align-items:center;gap:12px;padding:13px 0 4px">'
      + '<div style="flex:1"><b>Live mode</b><div style="font-size:11.5px;color:#8fa3c8;margin-top:2px;line-height:1.4">When on, the engine\'s agent picks up your playtest notes right away, fixes them in the cloud, and ships the update into this game.</div>'
      + (toggleErr ? '<div style="font-size:11.5px;color:#ff8a8a;margin-top:2px">' + esc(toggleErr) + '</div>' : '') + '</div>'
      + '<div id="ushell-toggle" style="cursor:pointer;flex:none;width:48px;height:27px;border-radius:99px;position:relative;transition:background .2s;background:' + (HUB.live ? 'rgba(95,214,110,.45)' : 'rgba(255,255,255,.14)') + ';opacity:' + (busyToggle ? '.5' : '1') + '">'
      +   '<span style="position:absolute;top:3px;left:' + (HUB.live ? '24px' : '3px') + ';width:21px;height:21px;border-radius:50%;background:' + (HUB.live ? '#5fd66e' : '#8fa3c8') + ';transition:left .2s"></span></div></div>';

    var now = '';
    if (updateShown) {
      now = sect('Now') + '<div style="font-size:12.5px;color:#7adcff;margin-bottom:8px">🚀 a new build with fresh fixes is ready.</div>'
        + '<div id="ushell-reload" style="cursor:pointer;text-align:center;padding:9px;border-radius:10px;background:linear-gradient(135deg,#1d6fa8,#164a86);border:1px solid rgba(122,220,255,.6);font-weight:700">Reload &amp; play the update</div>';
    } else if (HUB.enabled === false) {
      now = sect('Now') + '<div style="color:#8fa3c8;font-size:12.5px">Online mode is off on the engine hub.</div>';
    } else if (HUB.job) {
      var j = HUB.job;
      var t = fixingTitle();
      var line = j.status === 'failed' ? '<span style="color:#ff8a8a">this run hit a snag — your notes stay queued for the next one</span>'
        : j.status === 'deployed' || j.status === 'done' ? '<span style="color:#5fd66e">shipped! the new build is deploying — this bar will flip to 🚀 when it\'s here</span>'
        : (t ? '🔧 <i>' + esc(t.slice(0, 90)) + '</i>' : 'the agent is on it…');
      now = sect('Now', '<span style="float:right;color:#5b6b86;font-weight:600;text-transform:none;letter-spacing:0">' + esc(ago(j.updatedAt || j.createdAt)) + '</span>')
        + stepBar(j)
        + '<div style="font-size:12.5px;margin-top:6px">' + line + '</div>';
    } else {
      now = sect('Now') + '<div style="font-size:12.5px;color:#8fa3c8">' + (HUB.live ? '<span style="color:#5fd66e">●</span> watching — new notes get picked up within minutes.' : 'idle. Flip Live on and the agent starts on your open notes immediately.') + '</div>';
    }

    var foot = '<div style="margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:12px;align-items:center;font-size:11.5px;color:#8fa3c8;flex-wrap:wrap">'
      + '<a href="' + esc(hubBase()) + '" target="_blank" rel="noopener" style="color:#9fb3e0;text-decoration:none">⚙️ mission control ↗</a>'
      + '<a href="/diary.html" target="_blank" rel="noopener" style="color:#9fb3e0;text-decoration:none">📔 build diary ↗</a>'
      + '<span style="flex:1"></span>'
      + '<span id="ushell-compact" style="cursor:pointer;color:#9fb3e0">' + (compact ? '⤢ expand the status bar' : '⤡ compact status bar') + '</span></div>';

    panel.innerHTML = head + liveRow + now
      + sect('Your playtest notes') + '<div style="max-height:30vh;overflow-y:auto;font-size:13px">' + panelNotes() + '</div>'
      + panelShipped() + foot;
    var t2 = document.getElementById('ushell-toggle');
    if (t2) t2.onclick = toggleLive;
    var c = document.getElementById('ushell-close');
    if (c) c.onclick = closePanel;
    var r = document.getElementById('ushell-reload');
    if (r) r.onclick = function () { try { window.location.reload(); } catch (e) {} };
    var cm = document.getElementById('ushell-compact');
    if (cm) cm.onclick = function () { compact = !compact; store.set('compact', compact ? '1' : '0'); paintBar(); paintPanel(); };
  }
  function openPanel() {
    ensureStyle();
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ushell-panel';
      panel.style.cssText = 'position:fixed;top:114px;right:12px;z-index:2147483002;width:min(94vw,352px);padding:16px 18px;border-radius:18px;background:rgba(13,15,26,.97);color:#fff;border:1px solid rgba(255,255,255,.16);box-shadow:0 16px 48px rgba(0,0,0,.6);backdrop-filter:blur(12px);font:13.5px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;max-height:76vh;overflow-y:auto;';
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
      paintPanel(); paintBar();
      pollStatus(); pollQueue();
    }).catch(function () { busyToggle = false; HUB.live = !want; toggleErr = 'could not reach the engine — try again'; paintPanel(); paintBar(); });
  }

  // ── timers ──
  setTimeout(pollVersion, 4000);
  setInterval(pollVersion, VERSION_MS);
  setTimeout(function () { pollStatus(); paintBar(); }, 5000);
  setInterval(function () { pollStatus(); if (panelOpen) pollQueue(); }, STATUS_MS);
  setInterval(function () { if (panelOpen) { pollStatus(); pollQueue(); } }, PANEL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { pollVersion(); pollStatus(); } });

  window.UPDATE_SHELL_API = { pollVersion: pollVersion, pollStatus: pollStatus, openPanel: openPanel, closePanel: closePanel };
})();
