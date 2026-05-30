/* ============================================================================
 * Hero animation — "collider tracks"
 *
 * Charged particles stream out from collision vertices, curving in a magnetic
 * field and spiralling inward as they lose momentum (like detector tracks),
 * then fade and decay. Trails come from a translucent per-frame background
 * fill; glow is a pre-rendered sprite drawn additively.
 *
 * Resource budget (the whole point):
 *   - The rAF loop STOPS when the hero is off-screen (IntersectionObserver) or
 *     the tab is hidden (visibilitychange) -> ~0 CPU/GPU when not visible.
 *   - prefers-reduced-motion -> a single static frame, no animation.
 *   - No shadowBlur and no per-frame gradient allocation (both are expensive);
 *     glow sprites are built once.
 *   - Fixed object pool -> zero allocation inside the loop (stable memory).
 *   - Canvas is DPR-aware but capped at 2x to bound fill cost.
 *   - One passive pointer listener; no second animation loop.
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
    var BG        = "#1e2129";              // slate (matches .hero-container)
    var BG_FADE   = "rgba(30, 33, 41, 0.12)"; // per-frame fade -> trail length
    var COLORS    = ["#ff0040", "#00ff6a", "#0080ff", "#ffd23a", "#ffffff"];
    var MAX       = 64;    // hard cap on simultaneous tracks (pool size)
    var SPRITE_R  = 22;    // glow sprite radius, CSS px
    var DRAG      = 0.992; // momentum loss per frame -> inward spiral
    var TURN_MIN  = 0.018, TURN_MAX = 0.060; // cyclotron turn/frame (radians)
    var SPD_MIN   = 1.3,  SPD_MAX  = 3.6;    // launch speed, px/frame
    var LIFE_MIN  = 150,  LIFE_MAX = 320;    // track lifetime, frames
    var AMBIENT   = 130;   // frames between ambient collisions (~2s @60fps)
    var BURST_MIN = 2, BURST_MAX = 5;        // tracks per collision
    var PTR_DIST  = 64;    // cursor travel (px) needed to trigger a collision

    // ---- state ------------------------------------------------------------
    var dpr = 1, w = 0, h = 0;
    var rafId = 0, running = false, visible = false, started = false;
    var ambientTimer = 0;
    var lastPX = -1e9, lastPY = -1e9;

    // ---- object pool (allocated once) -------------------------------------
    var pool = new Array(MAX);
    for (var i = 0; i < MAX; i++) {
      pool[i] = { on: false, x: 0, y: 0, vx: 0, vy: 0, cs: 1, sn: 0,
                  age: 0, life: 1, ci: 0 };
    }

    // ---- glow sprites (one per colour, built once) ------------------------
    function rgba(hex, a) {
      var n = parseInt(hex.slice(1), 16);
      return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," +
             (n & 255) + "," + a + ")";
    }
    var sprites = COLORS.map(function (col) {
      var d = SPRITE_R * 2;
      var s = document.createElement("canvas");
      s.width = d; s.height = d;
      var g = s.getContext("2d").createRadialGradient(
        SPRITE_R, SPRITE_R, 0, SPRITE_R, SPRITE_R, SPRITE_R);
      g.addColorStop(0.0, col);
      g.addColorStop(0.3, rgba(col, 0.55));
      g.addColorStop(1.0, rgba(col, 0));
      var c = s.getContext("2d");
      c.fillStyle = g;
      c.fillRect(0, 0, d, d);
      return s;
    });

    // ---- spawning ---------------------------------------------------------
    function burst(x, y, n) {
      for (var k = 0, made = 0; k < MAX && made < n; k++) {
        var p = pool[k];
        if (p.on) continue;
        var a = Math.random() * Math.PI * 2;
        var spd = SPD_MIN + Math.random() * (SPD_MAX - SPD_MIN);
        var turn = (Math.random() < 0.5 ? 1 : -1) *
                   (TURN_MIN + Math.random() * (TURN_MAX - TURN_MIN));
        p.x = x; p.y = y;
        p.vx = Math.cos(a) * spd;
        p.vy = Math.sin(a) * spd;
        p.cs = Math.cos(turn); p.sn = Math.sin(turn); // precomputed rotation
        p.age = 0;
        p.life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
        p.ci = (Math.random() * COLORS.length) | 0;
        p.on = true;
        made++;
      }
    }

    // ---- one simulation + draw frame (no scheduling) ----------------------
    function frame() {
      // Fade the previous frame -> motion trails.
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = BG_FADE;
      ctx.fillRect(0, 0, w, h);

      // Additive glow for the tracks.
      ctx.globalCompositeOperation = "lighter";
      for (var k = 0; k < MAX; k++) {
        var p = pool[k];
        if (!p.on) continue;

        // Rotate velocity by the (constant) cyclotron angle, then lose a little
        // momentum -> radius shrinks -> the track spirals inward.
        var vx = p.vx * p.cs - p.vy * p.sn;
        var vy = p.vx * p.sn + p.vy * p.cs;
        p.vx = vx * DRAG; p.vy = vy * DRAG;
        p.x += p.vx; p.y += p.vy;
        p.age++;

        if (p.age >= p.life ||
            p.x < -60 || p.x > w + 60 || p.y < -60 || p.y > h + 60) {
          p.on = false;
          continue;
        }

        var f = 1 - p.age / p.life;          // 1 -> 0 over the lifetime
        var r = SPRITE_R * (0.45 + f * 0.85); // shrink as it fades
        ctx.globalAlpha = f < 0.6 ? f * 1.6 : 1; // fade out near the end
        ctx.drawImage(sprites[p.ci], p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    function loop() {
      if (--ambientTimer <= 0) {
        burst(Math.random() * w, Math.random() * h,
              BURST_MIN + ((Math.random() * (BURST_MAX - BURST_MIN + 1)) | 0));
        ambientTimer = AMBIENT;
      }
      frame();
      if (running) rafId = requestAnimationFrame(loop);
    }

    // ---- start / stop -----------------------------------------------------
    function start() {
      if (running || reduced.matches || w === 0) return;
      running = true;
      if (!started) { started = true; ambientTimer = 1; burst(w / 2, h / 2, 4); }
      rafId = requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    // ---- static frame for reduced-motion ----------------------------------
    function drawStatic() {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      burst(w * 0.5, h * 0.45, 6);
      burst(w * 0.32, h * 0.6, 3);
      for (var n = 0; n < 90; n++) frame(); // bake the tracks, then freeze
    }

    // ---- sizing -----------------------------------------------------------
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px
      ctx.globalCompositeOperation = "source-over";
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
    function onPointerMove(e) {
      var x = e.offsetX, y = e.offsetY;
      var dx = x - lastPX, dy = y - lastPY;
      if (dx * dx + dy * dy >= PTR_DIST * PTR_DIST) {
        burst(x, y, BURST_MIN + ((Math.random() * 2) | 0));
        lastPX = x; lastPY = y;
      }
    }

    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onReducedChange);
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });

    var io = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && !document.hidden) start();
      else stop();
    }, { threshold: 0 });
    io.observe(canvas);

    resize(); // also paints the reduced-motion static frame if applicable

    teardown = function () {
      stop();
      io.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onReducedChange);
      canvas.removeEventListener("pointermove", onPointerMove);
    };
  });
})();
