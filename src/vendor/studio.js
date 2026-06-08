/*
 * Studio SDK — an opinionated layer on top of Phaser 4 (phaser-private) that
 * makes the AI-game-studio conventions native, so every scaffolded game inherits:
 *
 *   Studio.harness   deterministic stepper + semantic observability (the eval backbone)
 *   Studio.Autopilot generic platformer driver (the 0-death gate)
 *   Studio.Level     data-driven level DSL  ->  built world
 *   Studio.Textures  procedural texture bakery (no external art needed)
 *   Studio.Juice     tweens / particles / Phaser-4 GPU filters (the "feel" surface)
 *   Studio.Audio     procedural WebAudio SFX + music hook
 *   Studio.Cam       follow camera w/ deadzone + bounds
 *   Studio.Materials look + footing + grounding (AI-safe surfaces)
 *
 * Load order in a game:  <script src="phaser.min.js"></script>
 *                        <script src="studio.js"></script>
 */
(function (root) {
  'use strict';
  var Studio = { version: '0.1.0' };

  // ---------------------------------------------------------------- Materials
  // Each surface declares its look + footing + machine-readable grounding,
  // so levels are AI-completable by construction.
  Studio.Materials = {
    table: {
      solid: { color: 0x3a5a40, top: 0x588157, friction: 1, deadly: false, ground: true },
      stone: { color: 0x6b705c, top: 0x8a8d7a, friction: 1, deadly: false, ground: true },
      ice: { color: 0x9fd3e0, top: 0xd6f1f7, friction: 0.05, deadly: false, ground: true },
      lava: { color: 0xd00000, top: 0xff5400, friction: 1, deadly: true, ground: false },
      mud: { color: 0x6f4518, top: 0x8a5a2b, friction: 2.2, deadly: false, ground: true }
    },
    get: function (name) { return this.table[name] || this.table.solid; }
  };

  // ---------- color helpers (hex int math) for the texture bakery ----------
  Studio._mix = function (a, b, t) {
    var ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255, br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return ((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t));
  };
  Studio._lighten = function (c, t) { return Studio._mix(c, 0xffffff, t); };
  Studio._darken = function (c, t) { return Studio._mix(c, 0x000000, t); };

  // ----------------------------------------------------------- TextureFactory
  // Procedural art: shaded, outlined sprites + gradient ground (no AI required).
  Studio.Textures = {
    bake: function (scene, key, w, h, draw) {
      if (scene.textures.exists(key)) scene.textures.remove(key);
      var g = scene.add.graphics(); draw(g, w, h); g.generateTexture(key, w, h); g.destroy(); return key;
    },
    // vertical gradient as horizontal bands — cross-renderer safe; stretches cleanly across a slab
    gradStrip: function (scene, key, top, bottom, h) {
      h = h || 64;
      this.bake(scene, key, 16, h, function (g) {
        var bands = 24, bh = Math.ceil(h / bands) + 1;
        for (var i = 0; i < bands; i++) { var t = i / (bands - 1); g.fillStyle(Studio._mix(top, bottom, t), 1).fillRect(0, Math.round(t * (h - bh)), 16, bh); }
      });
    },
    kit: function (scene, opt) {
      opt = opt || {}; var T = opt.tile || 40, M = Studio.Materials, self = this;
      Object.keys(M.table).forEach(function (name) {
        var m = M.get(name);
        self.gradStrip(scene, 'grad_' + name, Studio._lighten(m.top, 0.12), Studio._darken(m.color, 0.34));
      });
      var hero = opt.hero || 0xffd166, enemy = opt.enemy || 0xef476f, goal = opt.goal || 0x06d6a0;
      this.bake(scene, 'hero', 30, 38, function (g) {
        g.fillStyle(0x141414, 1).fillRoundedRect(0, 0, 30, 38, 8);
        g.fillStyle(hero, 1).fillRoundedRect(2, 2, 26, 34, 6);
        g.fillStyle(Studio._lighten(hero, 0.32), 1).fillRoundedRect(2, 2, 26, 13, 6);
        g.fillStyle(Studio._darken(hero, 0.22), 1).fillRect(2, 29, 26, 7);
        g.fillStyle(0xffffff, 1).fillCircle(11, 18, 4).fillCircle(20, 18, 4);
        g.fillStyle(0x141414, 1).fillCircle(12, 18, 2).fillCircle(21, 18, 2);
      });
      this.bake(scene, 'enemy', 32, 28, function (g) {
        g.fillStyle(0x141414, 1).fillRoundedRect(0, 0, 32, 26, 9);
        g.fillStyle(enemy, 1).fillRoundedRect(2, 2, 28, 22, 7);
        g.fillStyle(Studio._darken(enemy, 0.28), 1).fillRect(2, 15, 28, 9);
        g.fillStyle(0xffffff, 1).fillCircle(11, 12, 4).fillCircle(21, 12, 4);
        g.fillStyle(0x141414, 1).fillCircle(12, 13, 2).fillCircle(22, 13, 2);
        g.fillStyle(0x141414, 1).fillRect(7, 24, 6, 4).fillRect(19, 24, 6, 4);
      });
      this.bake(scene, 'coin', 20, 20, function (g) {
        g.fillStyle(0x9a6a00, 1).fillCircle(10, 10, 10);
        g.fillStyle(0xffd700, 1).fillCircle(10, 10, 8);
        g.fillStyle(0xfff3b0, 1).fillCircle(7, 7, 3);
      });
      this.bake(scene, 'goal', 18, 90, function (g) {
        g.fillStyle(Studio._darken(goal, 0.25), 1).fillRoundedRect(0, 0, 18, 90, 5);
        g.fillStyle(goal, 1).fillRoundedRect(2, 2, 14, 86, 4);
        g.fillStyle(Studio._lighten(goal, 0.35), 1).fillRect(3, 3, 4, 84);
      });
      this.bake(scene, 'dot', 8, 8, function (g) { g.fillStyle(0xffffff, 1).fillCircle(4, 4, 4); });
      this.bake(scene, 'block', T, T, function (g) { g.fillStyle(0xffffff, 1).fillRect(0, 0, T, T); });
    }
  };

  // ----------------------------------------------------------------- Backdrop
  // Gradient sky (pinned to camera) + parallax silhouette layers — instant depth.
  Studio.Backdrop = function (scene, opt) {
    opt = opt || {};
    var W = scene.scale.width, H = scene.scale.height;
    Studio.Textures.gradStrip(scene, '_sky', opt.top != null ? opt.top : 0x24304f, opt.bottom != null ? opt.bottom : 0x0b1021, 160);
    scene.add.image(W / 2, H / 2, '_sky').setDisplaySize(W, H).setScrollFactor(0).setDepth(-100);
    var span = opt.worldWidth || (W * 2);
    (opt.layers || []).forEach(function (L, li) {
      var g = scene.add.graphics().setScrollFactor(L.scroll != null ? L.scroll : 0.3, 1).setDepth(-90 + li);
      g.fillStyle(L.color, L.alpha != null ? L.alpha : 1);
      var base = L.y != null ? L.y : H * 0.74, step = L.step || 150, amp = L.amp || 70, ph = li * 9 + 1;
      g.beginPath(); g.moveTo(-60, H + 30);
      for (var x = -60; x <= span + 60; x += step) { var y = base - (Math.sin(x * 0.011 + ph) * 0.5 + 0.5) * amp; g.lineTo(x, y); }
      g.lineTo(span + 60, H + 30); g.closePath(); g.fillPath();
    });
  };

  // --------------------------------------------------------------- Level DSL
  // A level is data. build() returns { platforms, hazards, coins, enemies, spawn, goalX }.
  Studio.Level = {
    build: function (scene, spec) {
      var T = spec.tile || 40, H = spec.height || 540;
      var platforms = scene.physics.add.staticGroup();
      var hazards = scene.physics.add.staticGroup();
      // ONE wide static body per slab — the player slides smoothly with no seams
      // to catch on (which would spoof blocked.right and break the autopilot).
      function slab(group, cx, cy, w, h, mat) {
        // one wide static body, textured with the material's vertical gradient
        // (bright lit top -> dark depth); no separate decor objects to leak on rebuild.
        var img = group.create(cx, cy, 'grad_' + (mat || 'solid')); img.setDisplaySize(w, h).refreshBody();
        return img;
      }
      (spec.ground || []).forEach(function (seg) {
        var mat = seg[2] || 'solid', w = seg[1] - seg[0], h = H - spec.groundY;
        slab(Studio.Materials.get(mat).deadly ? hazards : platforms, seg[0] + w / 2, spec.groundY + h / 2, w, h, mat);
      });
      (spec.walls || []).forEach(function (w) {
        var ht = (w.tiles || 1) * T; slab(platforms, w.x + T / 2, spec.groundY - ht / 2, T, ht, w.mat || 'stone');
      });
      (spec.platforms || []).forEach(function (p) { slab(platforms, p.x + p.w / 2, p.y + T / 2, p.w, T, p.mat || 'solid'); });
      var coins = scene.physics.add.staticGroup();
      (spec.coins || []).forEach(function (c) { coins.create(c.x, c.y, 'coin'); });
      var enemies = scene.physics.add.group({ allowGravity: false, immovable: true });
      (spec.enemies || []).forEach(function (e) {
        var s = enemies.create(e.x, spec.groundY - 14, 'enemy'); s.patrol = e.patrol || 60; s.homeX = e.x; s.dir = 1;
      });
      return {
        platforms: platforms, hazards: hazards, coins: coins, enemies: enemies,
        spawn: spec.spawn || { x: 60, y: spec.groundY - 80 }, goalX: spec.goal != null ? spec.goal : (spec.width - 60)
      };
    }
  };

  // --------------------------------------------------------------- Autopilot
  // Generic platformer policy. Feed it a "sense" object each frame; it returns input.
  // sense = { onGround, groundAhead, blockedRight, enemyAhead, x, goalX }
  Studio.Autopilot = {
    platformer: function (sense) {
      var out = { left: false, right: true, jump: false };
      if (sense.onGround && (!sense.groundAhead || sense.blockedRight || sense.enemyAhead)) out.jump = true;
      return out;
    },
    // convenience: probe a static group for ground under a point
    groundAt: function (group, px, py, tile) {
      var kids = group.getChildren();
      for (var i = 0; i < kids.length; i++) {
        var b = kids[i] && kids[i].body; if (!b) continue;
        if (px >= b.left - 2 && px <= b.right + 2 && b.top >= py - 6 && b.top <= py + (tile || 40)) return true;
      }
      return false;
    }
  };

  // -------------------------------------------------------------------- Juice
  // The "feel" surface. GPU filters are WebGL-only -> every call is guarded.
  Studio.Juice = {
    shake: function (scene, dur, amt) { try { scene.cameras.main.shake(dur || 120, amt || 0.008); } catch (e) {} },
    flash: function (scene, dur, r, g, b) { try { scene.cameras.main.flash(dur || 120, r || 255, g || 255, b || 255); } catch (e) {} },
    hitStop: function (scene, ms) { try { var t = scene.time; scene.physics.world.pause(); t.delayedCall(ms || 60, function () { scene.physics.world.resume(); }); } catch (e) {} },
    squash: function (scene, obj, sx, sy, dur) {
      try { scene.tweens.add({ targets: obj, scaleX: sx || 1.25, scaleY: sy || 0.8, yoyo: true, duration: dur || 90, ease: 'Quad.out' }); } catch (e) {}
    },
    burst: function (scene, x, y, opt) {
      opt = opt || {};
      try {
        var em = scene.add.particles(x, y, opt.texture || 'dot', {
          speed: { min: opt.spMin || 60, max: opt.spMax || 180 }, angle: { min: 0, max: 360 },
          lifespan: opt.life || 500, scale: { start: opt.scale || 0.9, end: 0 }, quantity: opt.n || 12,
          blendMode: 'ADD', emitting: false, tint: opt.tint
        });
        em.explode(opt.n || 12); scene.time.delayedCall(opt.life || 500, function () { em.destroy(); });
        return em;
      } catch (e) {}
    },
    ambient: function (scene, w, opt) {
      opt = opt || {};
      try {
        return scene.add.particles(0, opt.y != null ? opt.y : -8, opt.texture || 'dot', {
          x: { min: 0, max: w }, lifespan: 5000, speedY: { min: 16, max: 50 },
          scale: { start: opt.scale || 0.7, end: 0 }, alpha: { start: 0.4, end: 0 }, quantity: 1, frequency: 120, blendMode: 'ADD'
        });
      } catch (e) {}
    },
    // GPU filters (WebGL only) — no-op on canvas
    glow: function (obj, color, outer) { try { if (!obj.enableFilters) return; obj.enableFilters(); obj.filters.internal.addGlow(color != null ? color : 0xffffff, outer || 4); } catch (e) {} },
    vignette: function (scene, strength) { try { var c = scene.cameras.main; if (!c.enableFilters) return; c.enableFilters(); c.filters.internal.addVignette(0.5, 0.5, 0.6, strength || 0.5); } catch (e) {} },
    grade: function (scene, fn) { try { var c = scene.cameras.main; if (!c.enableFilters) return; c.enableFilters(); var cm = c.filters.internal.addColorMatrix(); if (fn) fn(cm); return cm; } catch (e) {} }
  };

  // -------------------------------------------------------------------- Audio
  Studio.Audio = (function () {
    var ctx = null;
    function ac() { if (!ctx) { try { ctx = new (root.AudioContext || root.webkitAudioContext)(); } catch (e) {} } return ctx; }
    function tone(freq, dur, type, vol) {
      var a = ac(); if (!a) return;
      var o = a.createOscillator(), g = a.createGain();
      o.type = type || 'square'; o.frequency.value = freq; g.gain.value = vol || 0.08;
      o.connect(g); g.connect(a.destination);
      var t = a.currentTime; o.start(t); g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12)); o.stop(t + (dur || 0.12));
    }
    var SFX = {
      jump: function () { tone(420, 0.12, 'square'); }, coin: function () { tone(880, 0.08, 'triangle'); tone(1320, 0.08, 'triangle'); },
      stomp: function () { tone(160, 0.12, 'sawtooth'); }, hurt: function () { tone(120, 0.25, 'sawtooth', 0.12); },
      win: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { tone(f, 0.16, 'triangle'); }, i * 110); }); }
    };
    return { sfx: function (n) { try { (SFX[n] || function () {})(); } catch (e) {} }, music: function (url, vol) { try { var au = new Audio(url); au.loop = true; au.volume = vol || 0.4; au.play(); return au; } catch (e) {} } };
  })();

  // ---------------------------------------------------------------------- Cam
  Studio.Cam = {
    follow: function (scene, target, opt) {
      opt = opt || {}; var c = scene.cameras.main;
      if (opt.bounds) c.setBounds(opt.bounds[0], opt.bounds[1], opt.bounds[2], opt.bounds[3]);
      c.startFollow(target, true, opt.lerp || 0.12, opt.lerp || 0.12);
      if (opt.deadzone) c.setDeadzone(opt.deadzone[0], opt.deadzone[1]);
      return c;
    }
  };

  // ------------------------------------------------------------------ harness
  // Wires window.__rec (deterministic stepper) + window.__game (observability)
  // + window.__run / window.__gate, given game + hooks. This is the eval contract.
  Studio.harness = {
    install: function (game, hooks) {
      root.__rec = {
        on: false, t: 0, dt: 1000 / 60,
        begin: function () { if (this.on) return; game.loop.sleep(); this.on = true; this.t = 1000; },
        step: function (n) { n = n || 1; for (var i = 0; i < n; i++) { this.t += this.dt; game.step(this.t, this.dt); } },
        end: function () { if (!this.on) return; this.on = false; game.loop.wake(); }
      };
      root.__game = {
        ready: function () { return !!root.__ready; },
        snapshot: hooks.snapshot,
        setInput: hooks.setInput || function () {},
        autopilot: hooks.autopilot || function () {},
        reset: hooks.reset || function () {}
      };
      root.__run = function (n) { root.__game.reset(); root.__game.autopilot(true); root.__rec.begin(); root.__rec.step(n); return root.__game.snapshot(); };
      root.__gate = function (maxF) {
        root.__game.reset(); root.__game.autopilot(true); root.__rec.begin();
        var s = root.__game.snapshot();
        while (!s.won && !s.dead && s.frame < maxF) { root.__rec.step(1); s = root.__game.snapshot(); }
        return s;
      };
      root.__ready = true;
      return root.__game;
    }
  };

  root.Studio = Studio;
  if (typeof module !== 'undefined' && module.exports) module.exports = Studio;
})(typeof window !== 'undefined' ? window : globalThis);
