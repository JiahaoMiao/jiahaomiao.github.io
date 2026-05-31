/* ============================================================================
 * Hero animation — "collider event display"
 *
 * A continuous ATLAS/CMS-style transverse (r-phi) event display. Collisions
 * fire from an interaction point; charged tracks radiate outward through three
 * faint detector rings (tracker -> EM calorimeter -> hadron calorimeter),
 * bending in a single uniform magnetic field.
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
 *     tiny curling secondaries (pair production / bremsstrahlung), plus a glowing
 *     ECAL energy deposit, then they stop.
 *   - Charged hadrons punch through to the HCAL, drop a warm energy deposit, stop.
 *   - Muons are minimum-ionizing: they spear straight through every layer and
 *     escape the frame. Rare and hard, so they read as crisp radial spears.
 *   - Calorimeter deposits are bright arc "cells" on the rings; a jet's collimated
 *     tracks land together -> a hot cluster, the signature event-display look.
 *
 * Interaction:
 *   - Click / tap creates a collision (a displaced "secondary vertex") at that
 *     point; moving / dragging keeps spawning them as the pointer travels. Tracks
 *     still bend in the same global field and are still absorbed at the rings
 *     (which stay centred on the detector), so it stays physically coherent.
 *   - Listeners are passive, so a touch-drag still scrolls the page on mobile.
 *
 * Resource budget (the whole point):
 *   - The rAF loop STOPS when the hero is off-screen (IntersectionObserver) or
 *     the tab is hidden (visibilitychange) -> ~0 CPU/GPU when not visible.
 *   - prefers-reduced-motion -> a single static, baked event, no animation.
 *   - No shadowBlur and no per-frame gradient/string allocation (both expensive);
 *     glow sprites are built once, colours are constant strings, fade uses
 *     globalAlpha.
 *   - Fixed object pools (tracks + shower clouds + calo deposits) -> zero
 *     allocation inside the loop. Showers reuse short-lived pooled track slots;
 *     total active tracks are hard-capped (MAX).
 *   - Cyclotron rotation per track is precomputed once (cos/sin) -> no trig in
 *     the hot path.
 *   - Canvas is DPR-aware but capped at 2x to bound fill cost.
 *   - One passive pointer-move + one passive pointer-down listener.
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
    var heroContent = document.querySelector(".hero-content");
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    // ---- configuration ----------------------------------------------------
    var PI2       = Math.PI * 2;

    // Two render palettes (applied live by applyTheme). Geometry + physics are
    // identical across themes; only the colours and the glow compositing differ:
    //   - DARK : bright tracks + additive ("lighter") glow on a slate field.
    //   - LIGHT: dark "ink" tracks + saturated deposits drawn normally on a light
    //            field. Additive glow is invisible on light, so the glow layer
    //            falls back to source-over (a soft colour haze, not white glow).
    // The hero background is deliberately NOT hard-coded: applyTheme() reads it
    // from the themed .hero-container so the canvas always matches the container
    // (one source of truth). track[] is indexed by ci (see *_CIS below).
    var PAL_DARK = {
      track: ["#ffb347", "#ff8c2a", "#ffd23a", "#4ab3ff", "#28e0ff", "#cfe8ff", "#ffffff"],
      ring: "150, 170, 200", ringA: [0.05, 0.075, 0.06],
      depEcal: "#bfe6ff", depHcal: "#ff7a3c",
      glowOp: "lighter", flash: "#ffffff", cloud: "#aee0ff",
      flashA: 1.0, cloudA: 0.60, depBloomA: 0.22, depCoreA: 0.45
    };
    var PAL_LIGHT = {
      track: ["#c2410c", "#9a3412", "#b45309", "#1d4ed8", "#0e7490", "#64748b", "#0b1220"],
      ring: "40, 52, 74", ringA: [0.10, 0.13, 0.11],
      depEcal: "#1d4ed8", depHcal: "#ea580c",
      glowOp: "source-over", flash: "#9fb4d6", cloud: "#5b8fc9",
      flashA: 0.45, cloudA: 0.40, depBloomA: 0.16, depCoreA: 0.55
    };
    var HADRON_CIS = [0, 1, 2];
    var EM_CIS     = [3, 4];
    var SHOWER_CI  = 5;
    var MUON_CI    = 6;

    // Live render colours / compositing, assigned by applyTheme().
    var BG, BG_FADE, COLORS, RING_T, RING_E, RING_H, DEP_ECAL, DEP_HCAL;
    var GLOW_OP, FLASH_A, CLOUD_A, DEP_BLOOM_A, DEP_CORE_A;

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
    var PTR_DIST   = 64;    // cursor travel (px) needed to fire a collision
    var FLASH_R    = 44;    // vertex-flash glow sprite radius, CSS px
    var CLOUD_R    = 26;    // shower-cloud glow sprite radius, CSS px

    // Kinematics. FIELD is the one global magnetic field: turn-per-frame = FIELD/p
    // so curvature is strictly ∝ 1/p. SPEED (transverse speed at theta=90 deg) is
    // set in resize() so the whole event scales with the detector.
    var FIELD      = 0.036; // cyclotron turn/frame at unit momentum
    var SPEED      = 2.8;   // transverse px/frame at sin(theta)=1 (set in resize)
    var EN_REF     = 9;     // momentum giving a full-brightness calo deposit

    // ---- state ------------------------------------------------------------
    var dpr = 1, w = 0, h = 0;
    var cx = 0, cy = 0;
    var R_TRACKER = 0, R_ECAL = 0, R_ECAL2 = 0, R_HCAL = 0, R_HCAL2 = 0;
    var rafId = 0, running = false, visible = false, started = false;
    var ambientTimer = 0, flash = 0, flashX = 0, flashY = 0;
    var lastPX = -1e9, lastPY = -1e9;

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
    var deps = new Array(DEPS);
    for (i = 0; i < DEPS; i++) {
      deps[i] = { on: false, ang: 0, r: 0, age: 0, life: 1, mag: 0, col: DEP_ECAL };
    }

    // ---- glow sprites (hotspots only, built once) -------------------------
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
    var flashSprite, cloudSprite; // (re)built per theme by applyTheme()

    // Apply the active colour scheme. Reads the themed hero background straight
    // from CSS, swaps the track/ring/deposit palette + glow compositing, and
    // rebuilds the glow sprites. Called at start-up and whenever the palette
    // toggle flips <body data-md-color-scheme> ("default" = light, else dark).
    function readBgRGB() {
      var src = canvas.parentElement || canvas;
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
      RING_T = "rgba(" + P.ring + ", " + P.ringA[0] + ")";
      RING_E = "rgba(" + P.ring + ", " + P.ringA[1] + ")";
      RING_H = "rgba(" + P.ring + ", " + P.ringA[2] + ")";
      DEP_ECAL = P.depEcal; DEP_HCAL = P.depHcal;
      GLOW_OP = P.glowOp;
      FLASH_A = P.flashA; CLOUD_A = P.cloudA;
      DEP_BLOOM_A = P.depBloomA; DEP_CORE_A = P.depCoreA;
      flashSprite = glowSprite(P.flash, FLASH_R);
      cloudSprite = glowSprite(P.cloud, CLOUD_R);
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
    // A glowing calorimeter cell where a track lands on its ring. mag (0..1)
    // scales brightness + angular width with the deposited energy.
    function addDeposit(ang, r, col, en) {
      var mag = en / EN_REF; if (mag > 1) mag = 1; mag = 0.3 + 0.7 * mag;
      for (var d = 0; d < DEPS; d++) {
        var dp = deps[d];
        if (!dp.on) {
          dp.on = true; dp.ang = ang; dp.r = r; dp.age = 0;
          dp.life = 26 + ((Math.random() * 30) | 0);
          dp.mag = mag; dp.col = col;
          return;
        }
      }
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
      // not erase it). Three arcs -> negligible cost.
      ctx.lineWidth = 1;
      ctx.strokeStyle = RING_T;
      ctx.beginPath(); ctx.arc(cx, cy, R_TRACKER, 0, PI2); ctx.stroke();
      ctx.strokeStyle = RING_E;
      ctx.beginPath(); ctx.arc(cx, cy, R_ECAL, 0, PI2); ctx.stroke();
      ctx.strokeStyle = RING_H;
      ctx.beginPath(); ctx.arc(cx, cy, R_HCAL, 0, PI2); ctx.stroke();

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
            if (r2 >= R_ECAL2) { // shower + glowing ECAL deposit, then stop
              p.showered = true;
              shower(p.x, p.y, 0, Math.atan2(p.vy, p.vx));
              addDeposit(Math.atan2(ddy, ddx), R_ECAL, DEP_ECAL, p.en);
              p.on = false;
            }
          } else if (p.kind === KIND_HADRON || p.kind === KIND_LOOP) {
            if (r2 >= R_HCAL2) { // warm HCAL deposit, then stop
              addDeposit(Math.atan2(ddy, ddx), R_HCAL, DEP_HCAL, p.en);
              p.on = false;
            }
          } else if (p.kind === KIND_SHOWER && p.em) {
            if (p.age >= 6) { // a branched fragment cascades again
              p.showered = true;
              shower(p.x, p.y, p.depth, Math.atan2(p.vy, p.vx));
            }
          }
          // KIND_MUON: minimum-ionizing -> never absorbed, escapes the frame.
        }
      }

      // Glow layer: calorimeter deposits, vertex flash, shower clouds. Additive
      // ("lighter") in dark mode; soft source-over colour haze in light mode.
      ctx.globalCompositeOperation = GLOW_OP;
      ctx.lineCap = "round";
      for (var d = 0; d < DEPS; d++) {
        var dp = deps[d];
        if (!dp.on) continue;
        dp.age++;
        if (dp.age >= dp.life) { dp.on = false; continue; }
        var df = 1 - dp.age / dp.life;
        var dw = 0.04 + 0.12 * dp.mag;     // angular half-width grows with energy
        ctx.strokeStyle = dp.col;
        // Soft outer bloom, then a brighter core.
        ctx.globalAlpha = df * DEP_BLOOM_A * dp.mag;
        ctx.lineWidth = 10 + 18 * dp.mag;
        ctx.beginPath(); ctx.arc(cx, cy, dp.r, dp.ang - dw, dp.ang + dw); ctx.stroke();
        ctx.globalAlpha = df * (DEP_CORE_A + 0.4 * dp.mag);
        ctx.lineWidth = 4 + 8 * dp.mag;
        ctx.beginPath(); ctx.arc(cx, cy, dp.r, dp.ang - dw, dp.ang + dw); ctx.stroke();
      }

      if (flash > 0.02) {
        var fr = FLASH_R * (0.6 + flash * 0.8);
        ctx.globalAlpha = flash * FLASH_A;
        ctx.drawImage(flashSprite, flashX - fr, flashY - fr, fr * 2, fr * 2);
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
      for (var n = 0; n < 110; n++) frame(); // develop tracks/showers, then freeze
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
      R_TRACKER = baseR * 0.20;
      R_ECAL = baseR * 0.33;  R_ECAL2 = R_ECAL * R_ECAL;
      R_HCAL = baseR * 0.46;  R_HCAL2 = R_HCAL * R_HCAL;
      SPEED  = baseR * 0.0036;                // transverse speed scales with size
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
    function onPointerDown(e) {
      var x = e.offsetX, y = e.offsetY;
      fireEvent(x, y, null);
      lastPX = x; lastPY = y;
    }
    // Move / drag -> keep firing collisions as the pointer travels.
    function onPointerMove(e) {
      var x = e.offsetX, y = e.offsetY;
      var dx = x - lastPX, dy = y - lastPY;
      if (dx * dx + dy * dy >= PTR_DIST * PTR_DIST) {
        fireEvent(x, y, null);
        lastPX = x; lastPY = y;
      }
    }

    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onReducedChange);
    canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });

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
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
    };
  });
})();
