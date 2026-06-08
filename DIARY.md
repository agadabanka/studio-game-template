# Studio Phaser 4 Template — Diary

### Born on Phaser 4
Scaffolded from `agadabanka/phaser-private` (Phaser **4.1.0**) on the Studio SDK —
the first base in the family to run Phaser 4 instead of vendored Phaser 3.

### What it ships
- **Studio SDK**: deterministic stepper, observability bridge, generic autopilot,
  Level DSL, procedural texture bakery, JuiceKit (tweens / particles / GPU filters),
  procedural WebAudio SFX, follow camera with deadzone + bounds.
- One level (**Green Run**) that passes the **0-death autopilot gate** on both
  WebGL and Canvas, collecting coins and stomping a patroller along the way.
- **AI eval harness** (`npm run eval`): determinism + 0-death gate + non-black
  headless readback. Notably, headless **WebGL** readback works in Phaser 4
  (Phaser 3 forced the Canvas renderer here).

### Shipped
Live on Railway: https://studio-phaser4-demo-production.up.railway.app
Deployed straight from this directory (`railway up`); `/health` + `/api/meta` verified,
and the deployed build was confirmed to render headless.

### Next (the vertical agents)
story · game concept · art theme · characters · level design · feel · animation/FX ·
texturing · sound → ship to Railway.
