/* ============================================================================
 * Hero animation — "collider event display"
 *
 * A continuous ATLAS/CMS-style transverse (r-phi) event display. Collisions
 * fire from an interaction point; charged tracks radiate outward through a
 * layered detector — beam pipe, four silicon tracker layers, a segmented EM
 * calorimeter ring, a segmented hadron calorimeter ring, and an outer ring of
 * muon chambers — bending in a single uniform magnetic field.
 *
 * Physics (one global field, momentum-driven curvature):
 *   - Each track samples a momentum p (steeply-falling spectrum) and a polar
 *     angle theta. Its transverse speed is v_T = SPEED*sin(theta) and its
 *     cyclotron turn-per-frame is FIELD/p, so the bend radius R = v_T/turn is
 *     strictly proportional to pT under ONE field constant (R = pT / (0.3 B)).
 *     pT = p*sin(theta) therefore emerges naturally.
 *   - The Lorentz force does no work, so tracks follow CONSTANT-radius circular
 *     arcs (not energy-loss spirals): high-pT tracks pierce out nearly straight,
 *     low-pT tracks close into multi-turn "curlers". A whisper of dE/dx (DRAG
 *     just below 1) lets only long-lived curlers gently inspiral, as real ones do.
 *   - Charge sign sets the bend direction (+/- curve opposite ways).
 *
 * Detector response (tracks are absorbed where they belong):
 *   - Electrons / photons (EM) shower at the ECAL: a forward-collimated cloud of
 *     tiny curling secondaries (pair production / bremsstrahlung), then stop.
 *   - Charged hadrons punch through to the HCAL and stop.
 *   - Muons are minimum-ionizing: they spear straight through every layer,
 *     leave a bright hit in the muon chambers, and escape the frame.
 *   - Energy deposits are CELL-QUANTIZED TOWERS: a hit snaps to the nearest
 *     calorimeter cell and fills it with a radial energy bar that grows outward
 *     with deposited energy — the classic event-display look. Two tracks landing
 *     in the same live cell SUM their energy (real calorimetry), re-pulsing the
 *     tower; a jet's collimated tracks pile up into one hot cluster.
 *
 * Interaction:
 *   - Click / tap creates a collision (a displaced "secondary vertex") at that
 *     point — anywhere on the hero, including over the title text, because the
 *     listener sits on the hero container, not the canvas (the text layer sits
 *     above the canvas and used to swallow the events). Clicks on the buttons
 *     are left alone so they still navigate. Each vertex emits a brief
 *     expanding shockwave ring. The listener is passive, so a tap still lets
 *     the page scroll on mobile.
 *
 * Resource budget (the whole point):
 *   - The rAF loop STOPS when the hero is off-screen (IntersectionObserver) or
 *     the tab is hidden (visibilitychange) -> ~0 CPU/GPU when not visible.
 *   - prefers-reduced-motion -> a single static, baked event, no animation.
 *   - Detector geometry is built ONCE per resize as Path2D objects -> four
 *     stroke calls per frame, no per-frame path building, no extra canvas.
 *   - No shadowBlur and no per-frame gradient/string allocation (both expensive);
 *     glow/head sprites are built once per theme, colours are constant strings,
 *     fade uses globalAlpha.
 *   - Fixed object pools (tracks + shower clouds + calo deposits) -> zero
 *     allocation inside the loop. Showers reuse short-lived pooled track slots;
 *     total active tracks are hard-capped (MAX).
 *   - Cyclotron rotation per track is precomputed once (cos/sin) -> no trig in
 *     the hot path.
 *   - Canvas is DPR-aware but capped at 2x to bound fill cost.
 *   - One passive pointer-down listener.
 *   - Listeners/observer are torn down on instant navigation (no leaks).
 * ========================================================================== */
(function () {
  "use strict";

  // Holds the cleanup function for the currently-mounted instance so we can
  // tear it down before re-mounting on the next instant navigation.
  var teardown = null;

  document$.subscribe(function () {
    if (teardown) { teardown(); teardown = null; }

    var canvas = document.getElementById("hero-canvas");
    if (!canvas) return; // not the home page
    var ctx = canvas.getContext("2d", { alpha: false });
    var hero = canvas.parentElement; // .hero-container (owns pointer events)
    var heroContent = document.querySelector(".hero-content");
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    // ---- configuration ----------------------------------------------------
    var PI2 = Math.PI * 2;

    // Two render palettes (applied live by applyTheme). Geometry + physics are
    // identical across themes; only the colours and the glow compositing differ:
    //   - DARK : bright tracks + additive ("lighter") glow on a slate field.
    //   - LIGHT: dark "ink" tracks + saturated towers drawn normally on a light
    //            field. Additive glow is invisible on light, so the glow layer
    //            falls back to source-over (a soft colour haze, not white glow).
    // The hero background is deliberately NOT hard-coded: applyTheme() reads it
    // from the themed .hero-container so the canvas always matches the container
    // (one source of truth). track[] is indexed by ci (see *_CIS below).
    // Track hues mirror their destination: warm hadrons -> warm HCAL towers,
    // azure EM -> blue ECAL towers, crimson muons -> crimson chamber hits.
    var PAL_DARK = {
      track: ["#ffc14f", "#ff8e3c", "#ff6757", "#46c8ff", "#7aa2ff", "#b9e7ff", "#ff4d6d"],
      ring: "150, 170, 200", ringA: [0.05, 0.085, 0.028, 0.07],
      dep: ["#5fd4ff", "#ffa14f", "#ff6b8f"],
      glowOp: "lighter", flash: "#ffffff", cloud: "#aee0ff",
      // Additive accents must stay tiny: against the 0.14 trail-fade they pile
      // up to roughly 7x their per-frame alpha, so anything sustained above
      // ~0.1 saturates to white.
      flashA: 1.0, cloudA: 0.60, depBloomA: 0.06, depCoreA: 0.40,
      depCapA: 0.30, headA: 0.50
    };
    var PAL_LIGHT = {
      track: ["#c2410c", "#9a3412", "#b91c1c", "#1d4ed8", "#0e7490", "#64748b", "#be123c"],
      ring: "40, 52, 74", ringA: [0.10, 0.15, 0.06, 0.12],
      dep: ["#2563eb", "#ea580c", "#be123c"],
      glowOp: "source-over", flash: "#9fb4d6", cloud: "#5b8fc9",
      flashA: 0.45, cloudA: 0.40, depBloomA: 0.14, depCoreA: 0.50,
      depCapA: 0.70, headA: 0.50
    };
    var HADRON_CIS = [0, 1, 2];
    var EM_CIS     = [3, 4];
    var SHOWER_CI  = 5;
    var MUON_CI    = 6;

    // Live render colours / compositing, assigned by applyTheme().
    var BG, BG_FADE, COLORS, GEO_TRK, GEO_BAND, GEO_CELL, GEO_MU;
    var DEP_COLS, FLASH_COL, GLOW_OP;
    var FLASH_A, CLOUD_A, DEP_BLOOM_A, DEP_CORE_A, DEP_CAP_A, HEAD_A;

    // Particle kinds and their alpha dimming.
    var KIND_HADRON = 0, KIND_EM = 1, KIND_LOOP = 2, KIND_SHOWER = 3, KIND_MUON = 4;
    var DIM = [1.0, 1.0, 0.9, 0.55, 1.0];

    var MAX        = 170;   // hard cap on simultaneous tracks (pool size)
    var CLOUDS     = 24;    // hard cap on simultaneous shower-glow clouds
    var DEPS       = 48;    // hard cap on simultaneous calorimeter deposits
    var DRAG       = 0.999; // ~constant radius; only long curlers gently inspiral
    var JET_SPREAD = 0.13;  // angular half-width of a jet cone (radians)
    var SHO_CONE   = 0.45;  // shower secondary half-cone around parent dir (rad)
    var MAXDEPTH   = 2;     // EM shower cascade depth
    var AMBIENT    = 150;   // frames between ambient collisions (~2.5s @60fps)
    var FLASH_R    = 44;    // vertex-flash glow sprite radius, CSS px
    var CLOUD_R    = 26;    // shower-cloud glow sprite radius, CSS px
    var N_ECAL     = 60;    // ECAL cells around the ring
    var N_HCAL     = 36;    // HCAL cells around the ring (coarser, as in reality)
    var CW         = [PI2 / N_ECAL, PI2 / N_HCAL]; // cell angular widths

    // Kinematics. FIELD is the one global magnetic field: turn-per-frame = FIELD/p
    // so curvature is strictly ∝ 1/p. SPEED (transverse speed at theta=90 deg) is
    // set in resize() so the whole event scales with the detector.
    var FIELD      = 0.036; // cyclotron turn/frame at unit momentum
    var SPEED      = 2.8;   // transverse px/frame at sin(theta)=1 (set in resize)
    var EN_REF     = 9;     // summed cell energy giving a full-height tower

    // ---- state ------------------------------------------------------------
    var dpr = 1, w = 0, h = 0;
    var cx = 0, cy = 0;
    // Layer radii (set in resize). *_IN = absorption / tower-base radius.
    var R_ECAL_IN = 0, R_ECAL_IN2 = 0, R_HCAL_IN = 0, R_HCAL_IN2 = 0;
    var R_MUON = 0, R_MUON2 = 0, R_MU_T0 = 0, R_MU_T1 = 0;
    var DEP_RIN = [0, 0], DEP_H = [0, 0]; // tower base radius / max bar height
    var geoTrk, geoBands, geoCells, geoMuon; // Path2D detector geometry
    var rafId = 0, running = false, visible = false, started = false;
    var ambientTimer = 0, flash = 0, flashX = 0, flashY = 0;

    // ---- object pools (allocated once) ------------------------------------
    var pool = new Array(MAX);
    for (var i = 0; i < MAX; i++) {
      pool[i] = { on: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
                  cs: 1, sn: 0, age: 0, life: 1, ci: 0, lw: 1,
                  kind: 0, em: false, showered: false, depth: 0, en: 1 };
    }
    var clouds = new Array(CLOUDS);
    for (i = 0; i < CLOUDS; i++) {
      clouds[i] = { on: false, x: 0, y: 0, age: 0, life: 1 };
    }
    // ring: 0 = ECAL tower, 1 = HCAL tower, 2 = muon-chamber hit. For towers,
    // `cell` is the integer cell index; for muon hits it stores the raw angle.
    // a0/a1/rOut/da cache this frame's geometry between the two render passes.
    var deps = new Array(DEPS);
    for (i = 0; i < DEPS; i++) {
      deps[i] = { on: false, ring: 0, cell: 0, age: 0, life: 1, en: 0,
                  a0: 0, a1: 0, rOut: 0, da: 0 };
    }

    // ---- glow / head sprites (hotspots only, built once per theme) ---------
    function rgba(hex, a) {
      var n = parseInt(hex.slice(1), 16);
      return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," +
             (n & 255) + "," + a + ")";
    }
    function glowSprite(col, R) {
      var d = R * 2;
      var s = document.createElement("canvas");
      s.width = d; s.height = d;
      var c = s.getContext("2d");
      var g = c.createRadialGradient(R, R, 0, R, R, R);
      g.addColorStop(0.0, col);
      g.addColorStop(0.35, rgba(col, 0.5));
      g.addColorStop(1.0, rgba(col, 0));
      c.fillStyle = g;
      c.fillRect(0, 0, d, d);
      return s;
    }
    var flashSprite, cloudSprite;     // (re)built per theme by applyTheme()
    var headSprites = new Array(7);   // tiny glow dot per track colour

    // Apply the active colour scheme. Reads the themed hero background straight
    // from CSS, swaps the track/geometry/tower palette + glow compositing, and
    // rebuilds the sprites. Called at start-up and whenever the palette toggle
    // flips <body data-md-color-scheme> ("default" = light, else dark).
    function readBgRGB() {
      var src = hero || canvas;
      var m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(
                getComputedStyle(src).backgroundColor || "");
      return m ? (m[1] + ", " + m[2] + ", " + m[3]) : "30, 33, 41";
    }
    function applyTheme() {
      var light = document.body.getAttribute("data-md-color-scheme") === "default";
      var P = light ? PAL_LIGHT : PAL_DARK;
      var rgb = readBgRGB();
      BG = "rgb(" + rgb + ")";
      BG_FADE = "rgba(" + rgb + ", 0.14)";
      COLORS = P.track;
      GEO_TRK  = "rgba(" + P.ring + ", " + P.ringA[0] + ")"; // beam pipe + tracker
      GEO_BAND = "rgba(" + P.ring + ", " + P.ringA[1] + ")"; // calo band edges
      GEO_CELL = "rgba(" + P.ring + ", " + P.ringA[2] + ")"; // cell divider grid
      GEO_MU   = "rgba(" + P.ring + ", " + P.ringA[3] + ")"; // muon chambers
      DEP_COLS = P.dep;
      FLASH_COL = P.flash;
      GLOW_OP = P.glowOp;
      FLASH_A = P.flashA; CLOUD_A = P.cloudA;
      DEP_BLOOM_A = P.depBloomA; DEP_CORE_A = P.depCoreA;
      DEP_CAP_A = P.depCapA; HEAD_A = P.headA;
      flashSprite = glowSprite(P.flash, FLASH_R);
      cloudSprite = glowSprite(P.cloud, CLOUD_R);
      for (var s = 0; s < 7; s++) headSprites[s] = glowSprite(P.track[s], 8);
    }

    // ---- spawning ---------------------------------------------------------
    function acquire() { // first free pool slot, or -1 if at the cap
      for (var k = 0; k < MAX; k++) { if (!pool[k].on) return k; }
      return -1;
    }
    // Low-level: spd and turnMag are explicit so showers can pass their own.
    function spawnTrack(x, y, ang, spd, turnMag, sign, life, ci, lw, kind, em, depth, en) {
      var k = acquire();
      if (k < 0) return; // pool full -> event/shower spawns fewer, gracefully
      var p = pool[k];
      p.x = x; p.y = y; p.px = x; p.py = y;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      var turn = sign * turnMag;
      p.cs = Math.cos(turn); p.sn = Math.sin(turn); // precomputed rotation
      p.age = 0; p.life = life; p.ci = ci; p.lw = lw;
      p.kind = kind; p.em = em; p.showered = false; p.depth = depth; p.en = en;
      p.on = true;
    }
    function addCloud(x, y) {
      for (var c = 0; c < CLOUDS; c++) {
        var cl = clouds[c];
        if (!cl.on) {
          cl.on = true; cl.x = x; cl.y = y; cl.age = 0;
          cl.life = 18 + ((Math.random() * 14) | 0);
          return;
        }
      }
    }
    // Deposit energy where a track lands. Towers (ring 0/1) snap to the cell
    // grid; a hit on an already-glowing cell SUMS into it and re-pulses it
    // (age reset) instead of stacking a duplicate — jets build hot clusters.
    function addDeposit(ring, ang, en) {
      if (ang < 0) ang += PI2;
      var cell = ring < 2 ? ((ang / CW[ring]) | 0) : ang;
      var free = -1;
      for (var d = 0; d < DEPS; d++) {
        var dp = deps[d];
        if (dp.on) {
          if (ring < 2 && dp.ring === ring && dp.cell === cell) {
            dp.en += en; dp.age = 0;
            return;
          }
        } else if (free < 0) { free = d; }
      }
      if (free < 0) return;
      var nd = deps[free];
      nd.on = true; nd.ring = ring; nd.cell = cell; nd.age = 0; nd.en = en;
      nd.life = ring === 2 ? 24 + ((Math.random() * 14) | 0)
                           : 70 + ((Math.random() * 40) | 0);
    }

    // An EM cascade: a forward-collimated cloud of tiny, faint, tightly-curling
    // secondaries (e+e- / bremsstrahlung), emitted in a cone around the parent
    // direction `dir` rather than isotropically.
    function shower(x, y, depth, dir) {
      addCloud(x, y);
      var n = depth === 0 ? (8 + ((Math.random() * 5) | 0))
                          : (4 + ((Math.random() * 3) | 0));
      for (var i = 0; i < n; i++) {
        var ang  = dir + (Math.random() - 0.5) * 2 * SHO_CONE; // forward cone
        var spd  = 0.5 + Math.random() * 0.9;   // very low pT
        var tm   = 0.10 + Math.random() * 0.12; // -> tight curls
        var sign = Math.random() < 0.5 ? 1 : -1;
        var life = 16 + Math.random() * 22;     // fade out rapidly
        var branch = depth < MAXDEPTH && Math.random() < 0.22;
        spawnTrack(x, y, ang, spd, tm, sign, life, SHOWER_CI, 0.5,
                   KIND_SHOWER, branch, depth + 1, 0.5);
      }
    }

    // One jet: a few tightly-collimated tracks boosted along a common axis,
    // drawn from a falling momentum spectrum (a hard core + softer fragments).
    // A rare track is a muon that pierces straight through every layer.
    function spawnJet(x, y, axis) {
      var nt = 2 + ((Math.random() * 3) | 0); // 2-4 tracks in the cone
      for (var i = 0; i < nt; i++) {
        var ang   = axis + (Math.random() - 0.5) * JET_SPREAD;
        var sign  = Math.random() < 0.5 ? 1 : -1;
        var theta = 1.2 + (Math.random() - 0.5) * 1.4; // central-biased polar ang
        var st    = Math.sin(theta);
        var roll  = Math.random();
        if (roll < 0.10) {                 // muon: hard, straight, punches through
          var pm = 8 + Math.random() * 16;
          spawnTrack(x, y, ang, SPEED * st, FIELD / pm, sign,
                     420, MUON_CI, 0.8, KIND_MUON, false, 0, pm);
        } else if (roll < 0.5) {           // electron/photon: showers at the ECAL
          var pe = 1.2 + Math.random() * 7;
          spawnTrack(x, y, ang, SPEED * st, FIELD / pe, sign,
                     260, EM_CIS[(Math.random() * EM_CIS.length) | 0],
                     1.0, KIND_EM, true, 0, pe);
        } else {                           // charged hadron: deposits at the HCAL
          var ph = 1.5 + Math.random() * 11;
          spawnTrack(x, y, ang, SPEED * st, FIELD / ph, sign,
                     300, HADRON_CIS[(Math.random() * HADRON_CIS.length) | 0],
                     1.2, KIND_HADRON, false, 0, ph);
        }
      }
    }

    // A soft underlying-event track: low momentum -> a tight curler near the
    // vertex that usually never reaches the calorimeters.
    function spawnLooper(x, y) {
      var p     = 0.3 + Math.random() * 1.1;
      var theta = 1.0 + (Math.random() - 0.5) * 1.6;
      spawnTrack(x, y, Math.random() * PI2, SPEED * Math.sin(theta), FIELD / p,
                 Math.random() < 0.5 ? 1 : -1, 120 + Math.random() * 80,
                 HADRON_CIS[(Math.random() * HADRON_CIS.length) | 0],
                 0.6, KIND_LOOP, false, 0, p);
    }

    // A hard-scattering event: back-to-back jets (+ an occasional third) plus a
    // handful of soft loopers, with a bright vertex flash at (x, y). An optional
    // bias angle aims the primary jet axis (else random).
    function fireEvent(x, y, bias) {
      flash = 1; flashX = x; flashY = y;
      var base = (bias == null) ? Math.random() * PI2 : bias;
      spawnJet(x, y, base);
      spawnJet(x, y, base + Math.PI);
      if (Math.random() < 0.5) {
        spawnJet(x, y, base + Math.PI * 0.5 + (Math.random() - 0.5) * 0.6);
      }
      var nl = 2 + ((Math.random() * 3) | 0);
      for (var i = 0; i < nl; i++) spawnLooper(x, y);
    }

    // ---- one simulation + draw frame (no scheduling) ----------------------
    function frame() {
      // Fade the previous frame -> motion trails.
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG_FADE;
      ctx.fillRect(0, 0, w, h);

      // Faint detector geometry (re-stroked each frame so the trail-fade does
      // not erase it). Prebuilt Path2D objects -> four cheap stroke calls.
      ctx.lineWidth = 1;
      ctx.strokeStyle = GEO_CELL; ctx.stroke(geoCells);
      ctx.strokeStyle = GEO_TRK;  ctx.stroke(geoTrk);
      ctx.strokeStyle = GEO_BAND; ctx.stroke(geoBands);
      ctx.strokeStyle = GEO_MU;   ctx.stroke(geoMuon);

      // Tracks: integrate, draw a crisp segment old -> new, then test absorption.
      ctx.lineCap = "round";
      for (var k = 0; k < MAX; k++) {
        var p = pool[k];
        if (!p.on) continue;

        // Rotate velocity by the (constant) cyclotron angle, then shed a sliver
        // of momentum (dE/dx). With DRAG~1 the radius is essentially constant ->
        // a circular arc; only long-lived curlers visibly inspiral.
        p.px = p.x; p.py = p.y;
        var vx = p.vx * p.cs - p.vy * p.sn;
        var vy = p.vx * p.sn + p.vy * p.cs;
        p.vx = vx * DRAG; p.vy = vy * DRAG;
        p.x += p.vx; p.y += p.vy;
        p.age++;

        var ddx = p.x - cx, ddy = p.y - cy;
        var r2 = ddx * ddx + ddy * ddy;

        if (p.age >= p.life ||
            p.x < -40 || p.x > w + 40 || p.y < -40 || p.y > h + 40) {
          p.on = false;
          continue;
        }

        // Draw this frame's segment (so an absorbed track still reaches its ring).
        var f = 1 - p.age / p.life;        // 1 -> 0 over the lifetime
        var a = f * 1.5; if (a > 1) a = 1; // hold bright, fade near the end
        ctx.globalAlpha = a * DIM[p.kind];
        ctx.strokeStyle = COLORS[p.ci];
        ctx.lineWidth = p.lw;
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();

        // Detector response: absorb the track in the appropriate calorimeter.
        if (!p.showered) {
          if (p.kind === KIND_EM) {
            if (r2 >= R_ECAL_IN2) { // shower + ECAL tower, then stop
              p.showered = true;
              shower(p.x, p.y, 0, Math.atan2(p.vy, p.vx));
              addDeposit(0, Math.atan2(ddy, ddx), p.en);
              p.on = false;
            }
          } else if (p.kind === KIND_HADRON || p.kind === KIND_LOOP) {
            if (r2 >= R_HCAL_IN2) { // HCAL tower, then stop
              addDeposit(1, Math.atan2(ddy, ddx), p.en);
              p.on = false;
            }
          } else if (p.kind === KIND_SHOWER && p.em) {
            if (p.age >= 6) { // a branched fragment cascades again
              p.showered = true;
              shower(p.x, p.y, p.depth, Math.atan2(p.vy, p.vx));
            }
          } else if (p.kind === KIND_MUON) {
            if (r2 >= R_MUON2) { // chamber hit; minimum-ionizing -> flies on
              p.showered = true;
              addDeposit(2, Math.atan2(ddy, ddx), 1);
            }
          }
        }
      }

      // Deposits, pass 1 (still source-over): age, then draw the SOLID parts —
      // tower core fills and muon-chamber dashes. Source-over repainting
      // converges to the true colour at a stable opacity, so towers stay
      // saturated blue/orange instead of piling up to white under "lighter".
      ctx.lineCap = "butt";
      for (var d = 0; d < DEPS; d++) {
        var dp = deps[d];
        if (!dp.on) continue;
        dp.age++;
        if (dp.age >= dp.life) { dp.on = false; continue; }
        var df = 1 - dp.age / dp.life;
        var da = df * 1.6; if (da > 1) da = 1;     // hold, then fade out
        dp.da = da;
        var col = DEP_COLS[dp.ring];
        if (dp.ring === 2) {
          // Muon-chamber hit: a crisp radial dash across the chamber band.
          ctx.strokeStyle = col;
          ctx.globalAlpha = da * 0.85;
          ctx.lineWidth = 2;
          var mc = Math.cos(dp.cell), ms = Math.sin(dp.cell);
          ctx.beginPath();
          ctx.moveTo(cx + mc * R_MU_T0, cy + ms * R_MU_T0);
          ctx.lineTo(cx + mc * R_MU_T1, cy + ms * R_MU_T1);
          ctx.stroke();
          continue;
        }
        // Calorimeter tower: a cell-wide energy bar growing radially outward,
        // popping in on each (re-)hit and sinking back as it fades.
        var mag = dp.en / EN_REF; if (mag > 1) mag = 1; mag = 0.3 + 0.7 * mag;
        var g = dp.age < 5 ? dp.age / 5 : 1;       // pop-in / re-pulse
        var hf = df < 0.45 ? df / 0.45 : 1;        // sink back near the end
        var rIn = DEP_RIN[dp.ring];
        var cw = CW[dp.ring], gap = cw * 0.09;
        dp.rOut = rIn + DEP_H[dp.ring] * mag * g * hf;
        dp.a0 = dp.cell * cw + gap;
        dp.a1 = dp.a0 + cw - 2 * gap;
        ctx.fillStyle = col;
        ctx.globalAlpha = da * (DEP_CORE_A + 0.3 * mag);
        ctx.beginPath();
        ctx.arc(cx, cy, rIn, dp.a0, dp.a1);
        ctx.arc(cx, cy, dp.rOut, dp.a1, dp.a0, true);
        ctx.closePath();
        ctx.fill();
      }

      // Glow layer: tower bloom + caps, track heads, vertex flash + shockwave,
      // shower clouds. Additive ("lighter") in dark mode; a soft source-over
      // colour haze in light mode.
      ctx.globalCompositeOperation = GLOW_OP;

      // Deposits, pass 2: a soft halo around each tower and a bright cap line
      // along its outer edge (geometry cached by pass 1).
      for (d = 0; d < DEPS; d++) {
        var dq = deps[d];
        if (!dq.on || dq.ring === 2) continue;
        var qIn = DEP_RIN[dq.ring];
        ctx.strokeStyle = DEP_COLS[dq.ring];
        ctx.globalAlpha = dq.da * DEP_BLOOM_A;
        ctx.lineWidth = (dq.rOut - qIn) + 12;
        ctx.beginPath();
        ctx.arc(cx, cy, (qIn + dq.rOut) * 0.5, dq.a0, dq.a1);
        ctx.stroke();
        ctx.globalAlpha = dq.da * DEP_CAP_A;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, dq.rOut, dq.a0, dq.a1);
        ctx.stroke();
      }

      // Glowing comet heads at each live track tip (tiny prebuilt sprites).
      for (k = 0; k < MAX; k++) {
        var q = pool[k];
        if (!q.on) continue;
        var qf = 1 - q.age / q.life;
        var qa = qf * 1.5; if (qa > 1) qa = 1;
        var qr = 1.8 + q.lw * 1.8;
        ctx.globalAlpha = qa * DIM[q.kind] * HEAD_A;
        ctx.drawImage(headSprites[q.ci], q.x - qr, q.y - qr, qr * 2, qr * 2);
      }

      if (flash > 0.02) {
        var fr = FLASH_R * (0.6 + flash * 0.8);
        ctx.globalAlpha = flash * FLASH_A;
        ctx.drawImage(flashSprite, flashX - fr, flashY - fr, fr * 2, fr * 2);
        // Expanding shockwave ring, born at the vertex, fading as it grows.
        ctx.strokeStyle = FLASH_COL;
        ctx.globalAlpha = flash * 0.5 * FLASH_A;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(flashX, flashY, 10 + (1 - flash) * 110, 0, PI2);
        ctx.stroke();
        flash *= 0.88;
      } else {
        flash = 0;
      }
      for (var c = 0; c < CLOUDS; c++) {
        var cl = clouds[c];
        if (!cl.on) continue;
        cl.age++;
        if (cl.age >= cl.life) { cl.on = false; continue; }
        var cf = 1 - cl.age / cl.life;
        var cr = CLOUD_R * (0.5 + cf * 0.7);
        ctx.globalAlpha = cf * CLOUD_A;
        ctx.drawImage(cloudSprite, cl.x - cr, cl.y - cr, cr * 2, cr * 2);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    function loop() {
      if (--ambientTimer <= 0) { fireEvent(cx, cy, null); ambientTimer = AMBIENT; }
      frame();
      if (running) rafId = requestAnimationFrame(loop);
    }

    // ---- start / stop -----------------------------------------------------
    function start() {
      if (running || reduced.matches || w === 0) return;
      running = true;
      if (!started) { started = true; ambientTimer = 1; } // fire on first loop
      rafId = requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    // ---- static frame for reduced-motion ----------------------------------
    function drawStatic() {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      fireEvent(cx, cy, 0);              // a baked event...
      fireEvent(cx, cy, Math.PI * 0.5);  // ...plus a second jet axis for richness
      for (var n = 0; n < 130; n++) frame(); // develop tracks/towers, then freeze
    }

    // ---- detector geometry (Path2D, rebuilt only on resize) ----------------
    // Transverse slice of a general-purpose detector: beam pipe, four silicon
    // tracker layers, segmented ECAL + HCAL annuli (radial cell dividers), and
    // eight outer muon chambers (annular boxes with gaps between them).
    function buildGeometry(baseR) {
      var rEcalOut = baseR * 0.305, rHcalOut = baseR * 0.44;
      var rMuIn = baseR * 0.465, rMuOut = baseR * 0.495;
      var i, a, ca, sa;

      geoTrk = new Path2D();
      geoTrk.arc(cx, cy, Math.max(3, baseR * 0.012), 0, PI2); // beam pipe
      var trkR = [0.055, 0.095, 0.14, 0.185];
      for (i = 0; i < 4; i++) {
        geoTrk.moveTo(cx + baseR * trkR[i], cy);
        geoTrk.arc(cx, cy, baseR * trkR[i], 0, PI2);
      }

      geoBands = new Path2D(); // calorimeter band edges
      var bandR = [R_ECAL_IN, rEcalOut, R_HCAL_IN, rHcalOut];
      for (i = 0; i < 4; i++) {
        geoBands.moveTo(cx + bandR[i], cy);
        geoBands.arc(cx, cy, bandR[i], 0, PI2);
      }

      geoCells = new Path2D(); // radial cell dividers in both calo bands
      for (i = 0; i < N_ECAL; i++) {
        a = i * CW[0]; ca = Math.cos(a); sa = Math.sin(a);
        geoCells.moveTo(cx + ca * R_ECAL_IN, cy + sa * R_ECAL_IN);
        geoCells.lineTo(cx + ca * rEcalOut, cy + sa * rEcalOut);
      }
      for (i = 0; i < N_HCAL; i++) {
        a = i * CW[1]; ca = Math.cos(a); sa = Math.sin(a);
        geoCells.moveTo(cx + ca * R_HCAL_IN, cy + sa * R_HCAL_IN);
        geoCells.lineTo(cx + ca * rHcalOut, cy + sa * rHcalOut);
      }

      geoMuon = new Path2D(); // eight outer chambers, offset off the x-axis
      var seg = PI2 / 8, pad = 0.07;
      for (i = 0; i < 8; i++) {
        var a0 = i * seg + seg * 0.5 + pad, a1 = (i + 1) * seg + seg * 0.5 - pad;
        geoMuon.moveTo(cx + Math.cos(a0) * rMuIn, cy + Math.sin(a0) * rMuIn);
        geoMuon.arc(cx, cy, rMuIn, a0, a1);
        geoMuon.lineTo(cx + Math.cos(a1) * rMuOut, cy + Math.sin(a1) * rMuOut);
        geoMuon.arc(cx, cy, rMuOut, a1, a0, true);
        geoMuon.closePath();
      }
    }

    // ---- sizing -----------------------------------------------------------
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
      cx = w * 0.5; cy = h * 0.5;             // interaction point (detector centre)
      var baseR = Math.min(w, h);
      R_ECAL_IN = baseR * 0.235; R_ECAL_IN2 = R_ECAL_IN * R_ECAL_IN;
      R_HCAL_IN = baseR * 0.345; R_HCAL_IN2 = R_HCAL_IN * R_HCAL_IN;
      R_MUON    = baseR * 0.48;  R_MUON2    = R_MUON * R_MUON;
      R_MU_T0   = baseR * 0.46;  R_MU_T1    = baseR * 0.50; // muon-hit dash span
      DEP_RIN[0] = R_ECAL_IN; DEP_H[0] = baseR * 0.105; // ECAL towers
      DEP_RIN[1] = R_HCAL_IN; DEP_H[1] = baseR * 0.115; // HCAL towers
      buildGeometry(baseR);
      SPEED = baseR * 0.0036;                 // transverse speed scales with size
      flashX = cx; flashY = cy;
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      if (reduced.matches) drawStatic();
    }

    // ---- scroll: fade + parallax of the hero text (rAF-throttled) ----------
    var scrollY = window.scrollY, scrollTick = false;
    function applyScroll() {
      if (heroContent) {
        var vh = window.innerHeight;
        var op = 1 - Math.max(0, (scrollY - vh * 0.1) / (vh * 0.8));
        heroContent.style.opacity = Math.max(0, op);
        heroContent.style.transform = reduced.matches
          ? "" : "translate3d(0," + scrollY * 0.4 + "px,0)";
      }
      scrollTick = false;
    }

    // ---- listeners --------------------------------------------------------
    function onResize() { resize(); }
    function onScroll() {
      scrollY = window.scrollY;
      if (!scrollTick) { scrollTick = true; requestAnimationFrame(applyScroll); }
    }
    function onVisibility() {
      if (document.hidden) stop();
      else if (visible) start();
    }
    function onReducedChange() {
      if (reduced.matches) { stop(); resize(); }
      else if (visible && !document.hidden) start();
    }
    // Click / tap -> a collision at the pointer (a displaced secondary vertex).
    // Listens on the hero CONTAINER so it works over the title text too (the
    // text layer covers the canvas and would swallow canvas-bound events).
    // Clicks on links (the CV / Publications buttons) are left to navigate.
    function onPointerDown(e) {
      if (e.target.closest && e.target.closest("a")) return;
      var r = canvas.getBoundingClientRect();
      fireEvent(e.clientX - r.left, e.clientY - r.top, null);
    }

    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onReducedChange);
    hero.addEventListener("pointerdown", onPointerDown, { passive: true });

    var io = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && !document.hidden) start();
      else stop();
    }, { threshold: 0 });
    io.observe(canvas);

    applyTheme(); // set palette + background from CSS before the first paint
    resize();     // also paints the reduced-motion static frame if applicable

    // React to the palette toggle (light <-> dark) live, without a reload.
    var schemeObs = new MutationObserver(function () {
      applyTheme();
      // Reset the trail buffer to the new background so old-theme streaks do not
      // linger; re-bake the static frame if we are in reduced-motion mode.
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      if (reduced.matches) drawStatic();
    });
    schemeObs.observe(document.body, {
      attributes: true, attributeFilter: ["data-md-color-scheme"]
    });

    teardown = function () {
      stop();
      io.disconnect();
      schemeObs.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onReducedChange);
      hero.removeEventListener("pointerdown", onPointerDown);
    };
  });
})();
