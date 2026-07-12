// ── UPDATE SHELL · the "online mode" notification layer ─────────────────────
// Drop-in, framework-free script every game ships (synced from
// engine/sdk/update-shell.js by scripts/sync-sdk.mjs — edit THAT copy).
//
// Two loops, both silent until there's news:
//   1. VERSION  — polls the game's own /api/version. When Railway finishes a
//      deploy the served version changes; instead of yanking the page out from
//      under the player we show a "🚀 Update ready" pill and reload ONLY when
//      they tap it (mid-jump reloads are how you lose players).
//   2. LIVE-DEV — polls the hub's /api/online/status?game=<id> so the player
//      can see the engine's agent working on their notes in real time
//      ("🤖 fixing: …", "✅ fixes shipped").
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

  function hubBase() {
    if (CFG.hub) return String(CFG.hub).replace(/\/+$/, '');
    try { if (window.ANALYTICS && window.ANALYTICS.trackUrl) return new URL(window.ANALYTICS.trackUrl).origin; } catch (e) {}
    return DEFAULT_HUB;
  }

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
  var baseVersion = null, updateShown = false, versionMisses = 0;
  function showUpdate() {
    if (updateShown) return;
    updateShown = true;
    makeToast('update', '🚀 <b>Update ready!</b>&nbsp; New fixes just shipped — tap to reload', {
      accent: 'rgba(122,220,255,.65)',
      onClick: function () { try { window.location.reload(); } catch (e) {} },
    });
  }
  function pollVersion() {
    if (document.hidden || updateShown) return;
    fetch('/api/version', { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) { versionMisses = 99; return null; }   // old server build — stop asking
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!j || !j.version) return;
      if (baseVersion === null) baseVersion = j.version;
      else if (j.version !== baseVersion) showUpdate();
    }).catch(function () {});
  }

  // ── 2 · live-dev status (hub /api/online/status) ──
  var gameId = CFG.game || (window.ANALYTICS && window.ANALYTICS.game) || null;
  var metaTried = false, lastJobKey = '';
  function resolveGameId(cb) {
    if (gameId || metaTried) return cb();
    metaTried = true;
    fetch('/api/meta', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      if (m) gameId = m.slug || m.id || (m.name ? String(m.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null);
      cb();
    }).catch(function () { cb(); });
  }
  function renderJob(job) {
    // one toast that tracks the active job; key on job id + phase so we only
    // repaint when something actually changed.
    var key = job.id + '·' + job.phase + '·' + (job.issues || []).map(function (i) { return i.state; }).join('');
    if (key === lastJobKey) return;
    lastJobKey = key;
    var fixing = (job.issues || []).filter(function (i) { return i.state === 'fixing' || i.state === 'queued'; });
    var title = fixing.length ? fixing[0].title : ((job.issues || [])[0] || {}).title || '';
    title = String(title || '').replace(/[<>&]/g, ' ').slice(0, 80);
    if (job.status === 'running' || job.status === 'merging') {
      var label = job.status === 'merging' ? 'shipping fixes…' : ('working on your notes' + (title ? ': <i>' + title + '</i>' : '…'));
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
          var job = j.active && j.active.game === gameId ? j.active : (j.jobs || []).filter(function (x) { return x.game === gameId; })[0];
          if (job) renderJob(job);
        }).catch(function () {});
    });
  }

  setTimeout(pollVersion, 4000);
  setInterval(pollVersion, VERSION_MS);
  setTimeout(pollStatus, 7000);
  setInterval(pollStatus, STATUS_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { pollVersion(); pollStatus(); } });

  window.UPDATE_SHELL_API = { pollVersion: pollVersion, pollStatus: pollStatus, _toast: makeToast };
})();
