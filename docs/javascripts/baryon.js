document$.subscribe(function() {
    var canvas = document.getElementById("attractor-canvas");
    var heroContent = document.querySelector(".hero-content");
    
    if (!canvas) return;

    var ctx = canvas.getContext("2d");
    var width, height, cx, cy;

    // --- CONFIGURATION ---
    var particleCount = 3;
    var particles = [];
    var COLORS = ["#FF0040", "#00FF40", "#0080FF"]; // Neon Red, Green, Blue
    
    // Visual Settings (For the Flux Tubes)
    var TUBE_SEGS   = 40;  // How many segments in the string
    var TUBE_JITTER = 12;  // How much the string vibrates

    function initParticles() {
        particles = [];
        for (var i = 0; i < particleCount; i++) {
            particles.push({
                // Wide distribution to fill the screen
                x: (Math.random() - 0.5) * 400,
                y: (Math.random() - 0.5) * 400,
                vx: (Math.random() - 0.5) * 12,
                vy: (Math.random() - 0.5) * 12,
                color: COLORS[i % 3],
                history: []
            });
        }
    }

    // --- RESIZE HANDLER ---
    function resize() {
        width = window.innerWidth;
        height = window.innerHeight;
        cx = width / 2;
        cy = height / 2;
        canvas.width = width;
        canvas.height = height;
    }
    window.addEventListener("resize", resize);
    resize();
    initParticles();

    // --- SCROLL FADE ---
    var lastScrollY = window.scrollY;
    var ticking = false;

    function updateParallax() {
        if (!heroContent) return;
        
        var scrollPos = lastScrollY;
        var windowHeight = window.innerHeight;
        var opacity = 1 - Math.max(0, (scrollPos - (windowHeight * 0.1)) / (windowHeight * 0.8));
        var translate = scrollPos * 0.4; // Parallax speed
        
        if (opacity >= 0) {
            heroContent.style.opacity = opacity;
            // Use translate3d to force hardware acceleration (GPU)
            heroContent.style.transform = `translate3d(0, ${translate}px, 0)`;
        }
        
        ticking = false;
    }

    window.addEventListener("scroll", function() {
        lastScrollY = window.scrollY;
        if (!ticking) {
            window.requestAnimationFrame(updateParallax);
            ticking = true;
        }
    }, { passive: true }); // 'passive: true' tells browser we won't preventDefault()

    // --- HELPER: Hex to RGBA ---
    function hexAlpha(hex, alpha) {
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
    }

    // --- PHYSICS ENGINE (Harmonic Oscillator) ---
    function updatePhysics() {
        // Very loose spring constant to allow wide orbits
        var k = 0.0003; 

        particles.forEach(p => {
            var fx = -k * p.x;
            var fy = -k * p.y;

            p.vx += fx;
            p.vy += fy;
            p.x += p.vx;
            p.y += p.vy;

            p.history.push({x: p.x, y: p.y});
            if (p.history.length > 40) p.history.shift();
        });
    }

    // --- DRAWING FUNCTIONS (Reused) ---

    // 1. Draw Flux Tube
    function drawFluxTube(a, b) {
        var dx  = b.x - a.x, dy = b.y - a.y;
        var len = Math.sqrt(dx*dx + dy*dy) + 0.001;
        var px  = -dy / len, py = dx / len;
        var t   = performance.now() * 0.002; // Jitter speed

        var pts = [];
        for (var k = 0; k <= TUBE_SEGS; k++) {
            var s   = k / TUBE_SEGS;
            // Sine envelope: 0 at ends, 1 in middle
            var env = Math.sin(s * Math.PI); 
            // Jitter calculation
            var jit = TUBE_JITTER * env * Math.sin(k * 0.9 + t * 2.8);
            
            pts.push({
                x: cx + a.x + dx*s + px*jit,
                y: cy + a.y + dy*s + py*jit
            });
        }

        // Gradient from Color A to Color B
        var grad = ctx.createLinearGradient(cx+a.x, cy+a.y, cx+b.x, cy+b.y);
        grad.addColorStop(0,   hexAlpha(a.color, 0.70));
        grad.addColorStop(0.5, "rgba(255,255,255,0.50)"); // White center
        grad.addColorStop(1,   hexAlpha(b.color, 0.70));

        // Glow pass
        ctx.globalCompositeOperation = "lighter";
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
        ctx.strokeStyle = grad;
        ctx.lineWidth   = 8; // Outer glow width
        ctx.globalAlpha = 0.3;
        ctx.stroke();

        // Core pass (Sharp line)
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
        ctx.lineWidth   = 2;
        ctx.globalAlpha = 1.0;
        ctx.stroke();

        ctx.globalCompositeOperation = "source-over";
    }

    // 2. Draw Quark
    function drawQuark(p) {
        var x = cx + p.x, y = cy + p.y;

        ctx.globalCompositeOperation = "lighter";
        var halo = ctx.createRadialGradient(x, y, 0, x, y, 30);
        halo.addColorStop(0,   hexAlpha(p.color, 0.50));
        halo.addColorStop(1,   hexAlpha(p.color, 0));
        
        ctx.beginPath();
        ctx.arc(x, y, 30, 0, Math.PI * 2);
        ctx.fillStyle = halo;
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";

        // White core
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle   = "#ffffff";
        ctx.shadowBlur  = 16;
        ctx.shadowColor = p.color;
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    // 3. Draw Trail
    function drawTrail(p) {
        if (p.history.length < 2) return;
        ctx.globalCompositeOperation = "lighter";
        
        ctx.beginPath();
        ctx.moveTo(cx + p.history[0].x, cy + p.history[0].y);
        
        for (var i = 1; i < p.history.length; i++) {
            ctx.lineTo(cx + p.history[i].x, cy + p.history[i].y);
        }
        
        ctx.strokeStyle = hexAlpha(p.color, 0.4);
        ctx.lineWidth   = 2;
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
    }

    // --- MAIN LOOP ---
    function draw() {
        // Fade Background
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(30, 33, 41, 0.1)"; 
        ctx.fillRect(0, 0, width, height);

        updatePhysics();

        // Draw Flux Tubes (Behind particles)
        // Connect 0->1, 1->2, 2->0 to form the triangle
        drawFluxTube(particles[0], particles[1]);
        drawFluxTube(particles[1], particles[2]);
        drawFluxTube(particles[2], particles[0]);

        // Draw Trails
        particles.forEach(drawTrail);

        // Draw Quarks
        particles.forEach(drawQuark);

        requestAnimationFrame(draw);
    }

    draw();
});