/**
 * dP Relay scroll hero - deterministic, scroll-driven SMS-burst scene.
 * Spec: .kilo/plans/parallax.md. Contract: every visual value is a pure
 * function of normalized scroll progress p and fixed seeded data - no
 * frame-to-frame accumulation, no time-based state, no smooth-scroll libs,
 * no Three.js. Rendering is on-demand (dirty flag + rAF), so the page uses
 * zero CPU when nothing scrolls. Colors come from the CSS tokens at boot.
 *
 * Phase map (p in [0,1]) - boundaries live here, tune them freely:
 *   icon 0.00-0.20    bubble + breathing glow + two shockwave rings
 *   burst 0.20-0.45   particles leave a bubble silhouette, organic flow out
 *   map 0.45-0.75     particles morph onto the dot-matrix world map
 *   network 0.75-0.90 city nodes, deterministic arcs, message packets
 *   finale 0.90-1.00  one synchronized arc pulse, packets speed up, CTA glows
 *
 * Phase-boundary contract (spec section 5, "Phase-boundary continuity"):
 * bubbleTarget -> burstTarget -> mapTarget are three fixed seeded arrays; the
 * BURST phase interpolates bubble->burst and the MAP phase burst->map, so
 * p=0.45 joins exactly and no particle ever reassembles twice. From MAP
 * through FINALE every geographic element (dots, cities, arcs, packets,
 * pulses) draws inside ONE shared ctx.translate(mapOffset) whose input is a
 * single continuous progress sub = seg(p, 0.45, 1) - no per-function ad hoc
 * offsets, x never leaks into y, and the finale changes pulse/packet speed
 * only. Continuity is verified by rendered-pixel boundary sweeps, not just
 * code inspection.
 *
 * Dev-only progress hook: add ?heroP=0.42 on localhost to freeze p. The hook
 * is hostname-gated and inert on any public hostname (spec section 5).
 *
 * Low-power: viewports under 720 CSS px and low hardwareConcurrency devices
 * morph a 40% subset; the remaining map dots fade in deterministically during
 * the MAP phase (spec section 9), so the complete map still assembles.
 */
(function () {
  'use strict';

  var PHASES = {
    icon: [0.00, 0.20],
    burst: [0.20, 0.45],
    map: [0.45, 0.75],
    network: [0.75, 0.90],
    finale: [0.90, 1.00],
  };
  var CAPTIONS = [
    { from: 0.03, to: 0.28, el: null },
    { from: 0.33, to: 0.60, el: null },
    { from: 0.66, to: 0.93, el: null },
  ];

  // ── Math helpers (pure functions of p; no time, no frame state) ───────────
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function seg(p, a, b) { return clamp((p - a) / (b - a), 0, 1); }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function gauss(v, center, width) {
    var d = (v - center) / width;
    return Math.exp(-0.5 * d * d);
  }
  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(rgb, a) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' +
      clamp(a, 0, 1).toFixed(3) + ')';
  }

  // ── DOM, tokens, canvas ───────────────────────────────────────────────────
  var wrapper = document.querySelector('.hero-pin');
  var scene = document.querySelector('.hero-scene');
  var canvas = document.querySelector('.hero-canvas');
  var fallback = document.querySelector('.hero-fallback');
  var ctaRow = document.querySelector('.hero-ctas');
  if (!wrapper || !scene || !canvas || !fallback) return;

  var captionEls = [];
  (function () {
    var nodes = scene.querySelectorAll('.hero-caption');
    for (var i = 0; i < nodes.length && i < CAPTIONS.length; i += 1) {
      captionEls.push(nodes[i]);
    }
  })();

  var tokenStyle = getComputedStyle(document.documentElement);
  function token(name, fallbackHex) {
    var v = tokenStyle.getPropertyValue(name).trim();
    return v !== '' ? v : fallbackHex;
  }
  var COL = {
    ink: hexToRgb(token('--ink', '#16202c')),
    green: hexToRgb(token('--green', '#00d992')),
    deep: hexToRgb(token('--green-deep', '#047857')),
    mute: hexToRgb(token('--mute', '#667085')),
    hair: hexToRgb(token('--hairline', '#e2e6e4'))
  };

  var ctx = canvas.getContext('2d');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Dev-only freeze hook, hostname-gated: ?heroP=0.42 works on localhost only
  // and is inert on any public hostname (spec section 5).
  var devP = null;
  (function () {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) return;
    var m = window.location.search.match(/[?&]heroP=([0-9]*\.?[0-9]+)/);
    if (m) devP = clamp(parseFloat(m[1], 10), 0, 1);
  })();

  // ── Scene state (all arrays preallocated once data arrives) ───────────────
  var W = 0, H = 0, dpr = 1;
  var map = { x: 0, y: 0, w: 0, h: 0 };
  var wrapTop = 0;
  var ready = false;
  var dirty = true;
  var rafId = 0;
  var live = false;
  var inView = true;
  var N = 0, showN = 0;
  var bubbleXY = null;   // bubbleTarget — speech-bubble rim positions
  var burstXY = null;    // burstTarget — dispersed scatter at end of BURST
  var mapXY = null;      // mapTarget — assigned land-dot positions
  var ctrlXY = null;
  var stag = null;
  var cityXY = null, cityRank = null;
  var EDGES = [];
  var packets = [];

  // Map data is committed and seeded upstream by scripts/generate-world-map.mjs
  // and shipped as the static world-dots.js (window.WORLD_DOTS) — no runtime
  // fetch (spec section 8). Missing data keeps the static SVG fallback.
  function boot() {
    if (!window.WORLD_DOTS) return; // static SVG fallback stays visible
    prepare(window.WORLD_DOTS);
    ready = true;
    resize();
  }
  if (window.requestIdleCallback) {
    window.requestIdleCallback(boot, { timeout: 500 });
  } else {
    window.setTimeout(boot, 1);
  }

  // ── Data prep: seeded particle assignment, frozen after this one pass ─────
  function prepare(data) {
    var rnd = mulberry32(0x11a4e5);
    var dots = data.dots;
    var order = dots.map(function (_, i) { return i; });
    var i = 0;
    for (i = order.length - 1; i > 0; i -= 1) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    N = dots.length;
    bubbleXY = new Float32Array(N * 2);
    burstXY = new Float32Array(N * 2);
    mapXY = new Float32Array(N * 2);
    ctrlXY = new Float32Array(N * 2);
    stag = new Float32Array(N);
    for (i = 0; i < N; i += 1) {
      mapXY[i * 2] = dots[order[i]][0];
      mapXY[i * 2 + 1] = dots[order[i]][1];
      // bubbleTarget: deterministic positions derived from the bubble shape
      var ang = rnd() * Math.PI * 2;
      var rad = 0.92 + (rnd() - 0.5) * 0.32;
      bubbleXY[i * 2] = Math.cos(ang) * rad;
      bubbleXY[i * 2 + 1] = Math.sin(ang) * rad * 0.86;
      // burstTarget: dispersed organic scatter, light directional drift
      var bang = rnd() * Math.PI * 2;
      var bdist = 0.10 + Math.pow(rnd(), 0.65) * 0.40;
      burstXY[i * 2] = clamp(0.5 + Math.cos(bang) * bdist * 1.4 + 0.10, 0.02, 0.98);
      burstXY[i * 2 + 1] = clamp(0.44 + Math.sin(bang) * bdist * 0.62 - 0.05, 0.05, 0.95);
      ctrlXY[i * 2] = rnd() * 1.6 - 0.8;
      ctrlXY[i * 2 + 1] = rnd() * 1.1 - 0.55;
      stag[i] = rnd();
    }
    var cities = data.cities;
    var M = cities.length;
    cityXY = new Float32Array(M * 2);
    var i = 0;
    for (i = 0; i < M; i += 1) {
      cityXY[i * 2] = cities[i][0];
      cityXY[i * 2 + 1] = cities[i][1];
    }
    cityRank = new Float32Array(M);
    var rank = cities.map(function (_, k) { return k; });
    for (i = M - 1; i > 0; i -= 1) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = rank[i]; rank[i] = rank[j]; rank[j] = tmp;
    }
    for (i = 0; i < M; i += 1) cityRank[rank[i]] = i / M;
    EDGES = data.edges;
    var count = Math.min(18, EDGES.length);
    for (i = 0; i < count; i += 1) {
      packets.push({
        edge: Math.floor(rnd() * EDGES.length),
        phase: rnd(),
        speed: 0.5 + rnd() * 0.8
      });
    }
    showN = N;
  }

  // ── Progress + parallax + captions ────────────────────────────────────────
  function currentP() {
    if (devP !== null) return devP;
    var span = wrapper.offsetHeight - window.innerHeight;
    if (span <= 0) return 1;
    return clamp((window.scrollY - wrapTop) / span, 0, 1);
  }
  // Parallax layer amplitudes: bg 8px / map 16px / fg 30px max on desktop,
  // scaled down on narrow viewports (spec section 6).
  function layerOff(sub) {
    var s = clamp(W / 1440, 0.6, 1);
    return {
      bg: (sub - 0.5) * 16 * s,
      map: (sub - 0.5) * 32 * s,
      fg: (sub - 0.5) * 60 * s
    };
  }
  function captionAlpha(p, c) {
    var inA = seg(p, c.from, c.from + 0.05);
    var outA = 1 - seg(p, c.to - 0.05, c.to);
    return clamp(Math.min(inA, outA), 0, 1);
  }
  function updateCaptions(p) {
    for (var i = 0; i < CAPTIONS.length; i += 1) {
      var el = captionEls[i];
      if (!el) continue;
      var a = captionAlpha(p, CAPTIONS[i]);
      el.style.opacity = String(a.toFixed(3));
      el.style.visibility = a > 0.01 ? 'visible' : 'hidden';
      el.style.transform = 'translateY(' + ((1 - a) * 8).toFixed(1) + 'px)';
    }
  }

  // ── Layout: canvas sizing, map rect, scroll span ──────────────────────────
  function resize() {
    W = scene.clientWidth;
    H = scene.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var mw = Math.min(W * 0.94, 1160);
    var mh = mw * (480 / 1080);
    var maxH = H * 0.6;
    if (mh > maxH) {
      mh = maxH;
      mw = mh * (1080 / 480);
    }
    map.w = mw;
    map.h = mh;
    map.x = (W - mw) / 2;
    map.y = Math.round(H * 0.54 - mh / 2);
    showN = (W < 720 || (navigator.hardwareConcurrency || 8) <= 4)
      ? Math.floor(N * 0.4) : N;
    var rect = wrapper.getBoundingClientRect();
    wrapTop = rect.top + window.scrollY;
    dirty = true;
    pump();
  }

  // ── ICON phase: chat bubble + breathing glow + two shockwave rings ────────
  // drawGlow is shared with BURST and bubbleR(p) keeps the breathing radius
  // continuous across the p=0.20 boundary (spec section 5 invariant).
  function drawGlow(cx, cy, r, alpha) {
    var g = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.1);
    g.addColorStop(0, rgba(COL.green, 0.16 * alpha));
    g.addColorStop(1, rgba(COL.green, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - r * 2.2, cy - r * 2.2, r * 4.4, r * 4.4);
  }
  function bubbleR(p) {
    return Math.min(W, H) * 0.11 * (1 + 0.05 * Math.sin(p * Math.PI * 6));
  }
  function drawIcon(p) {
    var u = seg(p, PHASES.icon[0], PHASES.icon[1]);
    var cx = W * 0.5;
    var cy = H * 0.44;
    var r = bubbleR(p);
    for (var k = 0; k < 2; k += 1) {
      var ru = seg(u, 0.15 + k * 0.3, 0.75 + k * 0.3);
      if (ru > 0 && ru < 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1.1 + ru * 1.4), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(COL.green, 0.35 * (1 - ru));
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    drawGlow(cx, cy, r, 1);
    drawBubble(cx, cy, r);
  }
  function drawBubble(cx, cy, r) {
    var w = r * 1.9, h = r * 1.5;
    var x = cx - w / 2, y = cy - h / 2;
    var rad = r * 0.38;
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.lineTo(x + w * 0.36, y + h);
    ctx.lineTo(x + w * 0.28, y + h + r * 0.34);
    ctx.lineTo(x + w * 0.52, y + h);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = rgba(COL.deep, 0.9);
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgba(COL.deep, 0.95);
    for (var d = -1; d <= 1; d += 1) {
      ctx.beginPath();
      ctx.arc(cx + d * r * 0.42, cy, r * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── BURST: particles leave the bubble toward a dispersed scatter field ────
  // bubbleTarget -> burstTarget only (spec section 5). Targets are scene
  // coordinates; the map is never aimed at from here, so the p=0.45 join
  // hands over exactly where this phase stops.
  function drawBurst(p) {
    var u = seg(p, PHASES.burst[0], PHASES.burst[1]);
    var cx = W * 0.5, cy = H * 0.44;
    var r = bubbleR(p);
    var fade = 1 - seg(u, 0, 0.25);
    // Comet-tail alpha and length scale to zero over u∈[0.95,1] so the last
    // BURST frame carries no streak pixels — only positions cross into MAP.
    var streak = 1 - seg(u, 0.95, 1);
    if (fade > 0) {
      ctx.save();
      ctx.globalAlpha = fade;
      drawGlow(cx, cy, r, 1);
      drawBubble(cx, cy, r);
      ctx.restore();
    }
    var ghost = clamp(1 - (u - 0.15) / 0.5, 0, 1) * seg(u, 0, 0.1);
    if (ghost > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(COL.deep, 0.4 * ghost);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    var n = Math.min(showN, N);
    for (var i = 0; i < n; i += 1) {
      var ti = easeOutCubic(clamp((u - stag[i] * 0.35) / 0.65, 0, 1));
      if (ti <= 0) continue;
      var sx = cx + bubbleXY[i * 2] * r;
      var sy = cy + bubbleXY[i * 2 + 1] * r;
      var tx = burstXY[i * 2] * W;
      var ty = burstXY[i * 2 + 1] * H;
      var mxp = W * 0.5 + ctrlXY[i * 2] * W * 0.5;
      var myp = H * 0.5 + ctrlXY[i * 2 + 1] * H * 0.5;
      var a = 1 - ti, b = ti;
      var ix = a * a * sx + 2 * a * b * mxp + b * b * tx;
      var iy = a * a * sy + 2 * a * b * myp + b * b * ty;
      if (streak > 0) {
        var ti2 = Math.max(0, ti - 0.02 * streak);
        var a2 = 1 - ti2, b2 = ti2;
        var jx = a2 * a2 * sx + 2 * a2 * b2 * mxp + b2 * b2 * tx;
        var jy = a2 * a2 * sy + 2 * a2 * b2 * myp + b2 * b2 * ty;
        ctx.strokeStyle = rgba(COL.deep, 0.5 * streak);
        ctx.beginPath();
        ctx.moveTo(jx, jy);
        ctx.lineTo(ix, iy);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(COL.deep, 0.85);
      ctx.fillRect(ix - 1.2, iy - 1.2, 2.4, 2.4);
    }
  }

  // ── MAP phase: burst->map morph; assembled elements share ONE translate ───
  // The grid keeps background depth (off.bg); settled dots, the low-power
  // extras and every morph target use the single shared map offset passed
  // down from render() — no per-function offsets (spec section 5).
  function morphT(u, s) {
    return easeInOutCubic(clamp((u * 1.35 - s * 0.35) / 0.85, 0, 1));
  }
  function drawGrid(alpha, offX) {
    if (alpha <= 0) return;
    ctx.strokeStyle = rgba(COL.hair, alpha);
    ctx.lineWidth = 1;
    var cols = 12, rows = 7;
    var c, r2, x, y;
    for (c = 1; c < cols; c += 1) {
      x = map.x + (c / cols) * map.w + offX;
      ctx.beginPath();
      ctx.moveTo(x, map.y);
      ctx.lineTo(x, map.y + map.h);
      ctx.stroke();
    }
    for (r2 = 1; r2 < rows; r2 += 1) {
      y = map.y + (r2 / rows) * map.h;
      ctx.beginPath();
      ctx.moveTo(map.x + offX, y);
      ctx.lineTo(map.x + map.w + offX, y);
      ctx.stroke();
    }
  }
  function drawStaticMap(aMain, aExtra) {
    if (aMain > 0) {
      ctx.fillStyle = rgba(COL.deep, aMain);
      for (var i = 0; i < showN; i += 1) {
        ctx.fillRect(map.x + mapXY[i * 2] * map.w - 1.2,
          map.y + mapXY[i * 2 + 1] * map.h - 1.2, 2.4, 2.4);
      }
    }
    if (aExtra > 0 && showN < N) {
      ctx.fillStyle = rgba(COL.deep, aExtra);
      for (i = showN; i < N; i += 1) {
        ctx.fillRect(map.x + mapXY[i * 2] * map.w - 1.2,
          map.y + mapXY[i * 2 + 1] * map.h - 1.2, 2.4, 2.4);
      }
    }
  }
  function drawMap(p, off) {
    var u = seg(p, PHASES.map[0], PHASES.map[1]);
    drawGrid(0.6 * smooth(Math.min(1, u * 2)), off.bg);
    var n = Math.min(showN, N);
    // Settled dots and the fading-in extras draw inside the ONE shared
    // translate — their geometry stays fixed relative to the map rect.
    ctx.save();
    ctx.translate(off.map, 0);
    ctx.fillStyle = rgba(COL.deep, 0.55);
    for (var i = 0; i < n; i += 1) {
      if (morphT(u, stag[i]) < 1) continue;
      ctx.fillRect(map.x + mapXY[i * 2] * map.w - 1.2,
        map.y + mapXY[i * 2 + 1] * map.h - 1.2, 2.4, 2.4);
    }
    var extra = clamp((u - 0.55) / 0.45, 0, 1);
    if (extra > 0 && showN < N) {
      ctx.fillStyle = rgba(COL.deep, 0.4);
      for (i = showN; i < N; i += 1) {
        if ((i % 7) / 7 > extra) continue;
        ctx.fillRect(map.x + mapXY[i * 2] * map.w - 1.2,
          map.y + mapXY[i * 2 + 1] * map.h - 1.2, 2.4, 2.4);
      }
    }
    ctx.restore();
    // Morphing particles fly in scene space: they leave the unshifted burst
    // scatter and land on the transformed dot position, so the p=0.45 join
    // is exact at ti=0 and the p=0.75 landing is exact at ti=1.
    ctx.fillStyle = rgba(COL.deep, 0.85);
    for (i = 0; i < n; i += 1) {
      var ti = morphT(u, stag[i]);
      if (ti <= 0) {
        ctx.fillRect(burstXY[i * 2] * W - 1.2,
          burstXY[i * 2 + 1] * H - 1.2, 2.4, 2.4);
        continue;
      }
      if (ti >= 1) continue;
      var sx = burstXY[i * 2] * W;
      var sy = burstXY[i * 2 + 1] * H;
      var tx = map.x + mapXY[i * 2] * map.w + off.map;
      var ty = map.y + mapXY[i * 2 + 1] * map.h;
      var mxp = W * 0.5 + ctrlXY[i * 2] * W * 0.5 + (off.fg - off.map) * (1 - ti);
      var myp = H * 0.5 + ctrlXY[i * 2 + 1] * H * 0.5;
      var a = 1 - ti, b = ti;
      var ix = a * a * sx + 2 * a * b * mxp + b * b * tx;
      var iy = a * a * sy + 2 * a * b * myp + b * b * ty;
      ctx.fillRect(ix - 1.2, iy - 1.2, 2.4, 2.4);
    }
  }

  // ── Arc geometry: quad bezier with perpendicular lift, partial draw-on ────
  function arcCtrl(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.hypot(dx, dy) || 1;
    var lift = Math.min(map.w * 0.08, len * 0.22);
    return [x1 + dx / 2 - (dy / len) * lift, y1 + dy / 2 + (dx / len) * lift];
  }
  function quadPoint(x1, y1, cx2, cy2, x2, y2, t) {
    var o = 1 - t, s = t;
    return [
      o * o * x1 + 2 * o * s * cx2 + s * s * x2,
      o * o * y1 + 2 * o * s * cy2 + s * s * y2
    ];
  }
  function drawArcs(f, alpha, pulse) {
    if (f <= 0 || EDGES.length === 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(map.x - 2, map.y - 2, map.w + 4, map.h + 4);
    ctx.clip();
    ctx.strokeStyle = rgba(COL.deep, Math.min(1, alpha + pulse * 0.3));
    ctx.lineWidth = 1;
    for (var e = 0; e < EDGES.length; e += 1) {
      var a = EDGES[e][0], b = EDGES[e][1];
      var x1 = map.x + cityXY[a * 2] * map.w;
      var y1 = map.y + cityXY[a * 2 + 1] * map.h;
      var x2 = map.x + cityXY[b * 2] * map.w;
      var y2 = map.y + cityXY[b * 2 + 1] * map.h;
      var d = cityXY[b * 2] - cityXY[a * 2];
      var copies = [[0]];
      if (d > 0.5) copies = [[0, -map.w], [-map.w, -map.w]];
      else if (d < -0.5) copies = [[0, map.w], [map.w, map.w]];
      for (var ci = 0; ci < copies.length; ci += 1) {
        var sx = x1 + copies[ci][0];
        var ex = x2 + copies[ci][1];
        var c = arcCtrl(sx, y1, ex, y2);
        var cx2 = sx + (c[0] - sx) * f;
        var cy2 = y1 + (c[1] - y1) * f;
        var pt = quadPoint(sx, y1, c[0], c[1], ex, y2, f);
        ctx.beginPath();
        ctx.moveTo(sx, y1);
        ctx.quadraticCurveTo(cx2, cy2, pt[0], pt[1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Cities and arcs draw in map-local coordinates; the ONE shared translate
  // from the caller supplies the single parallax offset — offsets are never
  // added inside these functions (spec section 5, shared-transform rules).
  function drawCities(ap) {
    if (ap <= 0 || !cityRank) return;
    for (var k = 0; k < cityRank.length; k += 1) {
      var a = seg(ap, cityRank[k], cityRank[k] + 0.25);
      if (a <= 0) continue;
      var x = map.x + cityXY[k * 2] * map.w;
      var y = map.y + cityXY[k * 2 + 1] * map.h;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = rgba(COL.deep, 0.9 * a);
      ctx.fill();
    }
  }

  // ── Message packets: restrained rectangles travelling the fixed arcs ──────
  function drawPackets(p, pulse, pkAlpha) {
    if (pkAlpha <= 0) return;
    ctx.fillStyle = rgba(COL.green, Math.min(1, (0.95 + pulse * 0.05) * pkAlpha));
    for (var i = 0; i < packets.length; i += 1) {
      var pk = packets[i];
      var t = (pk.phase + p * pk.speed * (1 + pulse * 2.5)) % 1;
      var a = EDGES[pk.edge][0], b = EDGES[pk.edge][1];
      var x1 = map.x + cityXY[a * 2] * map.w;
      var y1 = map.y + cityXY[a * 2 + 1] * map.h;
      var x2 = map.x + cityXY[b * 2] * map.w;
      var y2 = map.y + cityXY[b * 2 + 1] * map.h;
      var d = cityXY[b * 2] - cityXY[a * 2];
      if (d > 0.5) x2 -= map.w;
      else if (d < -0.5) x2 += map.w;
      var c = arcCtrl(x1, y1, x2, y2);
      var pt = quadPoint(x1, y1, c[0], c[1], x2, y2, t);
      if (pt[0] < map.x - 6 || pt[0] > map.x + map.w + 6) continue;
      ctx.fillRect(pt[0] - 1.6, pt[1] - 1.1, 3.2, 2.2);
    }
  }

  // ── NETWORK + FINALE phases ────────────────────────────────────────────────
  // Both draw the same assembled scene inside the ONE shared translate; the
  // finale only adds arc pulse, packet brightness and packet speed. The
  // pulse is gated to zero at the p=0.90 boundary so the join stays exact.
  function drawNetworkScene(p, u, off) {
    drawGrid(0.6, off.bg);
    ctx.save();
    ctx.translate(off.map, 0);
    drawStaticMap(0.55, 0.4);
    drawArcs(seg(u, 0.15, 0.8), 0.45, 0);
    drawCities(seg(u, 0, 0.7));
    drawPackets(p, 0, seg(u, 0.2, 0.6));
    ctx.restore();
  }
  function drawFinaleScene(p, off) {
    var pulse = gauss(p, 0.95, 0.03) *
      seg(p, PHASES.finale[0], PHASES.finale[0] + 0.03);
    drawGrid(0.6, off.bg);
    ctx.save();
    ctx.translate(off.map, 0);
    drawStaticMap(0.55, 0.4);
    drawArcs(1, 0.45, pulse);
    drawCities(1);
    drawPackets(p, pulse, 1);
    ctx.restore();
  }

  // ── Render dispatch: one draw per scroll update, zero idle work ───────────
  function render() {
    var p = reduced ? 1 : currentP();
    ctx.clearRect(0, 0, W, H);
    if (p < PHASES.burst[1]) {
      if (p < PHASES.icon[1]) drawIcon(p);
      else drawBurst(p);
    } else {
      // ONE continuous progress + ONE offset triple from MAP through FINALE
      var sub = seg(p, PHASES.map[0], 1);
      var off = layerOff(sub);
      if (p < PHASES.network[0]) drawMap(p, off);
      else if (p < PHASES.finale[0]) {
        drawNetworkScene(p, seg(p, PHASES.network[0], PHASES.network[1]), off);
      } else drawFinaleScene(p, off);
    }
    if (!live) {
      scene.classList.add('hero-live');
      live = true;
    }
    if (ctaRow) ctaRow.classList.toggle('hero-cta-lit', p >= PHASES.finale[0]);
    updateCaptions(p);
  }
  function pump() {
    if (!ready || rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      if (!dirty || !inView || document.hidden) return;
      dirty = false;
      render();
    });
  }
  function onScroll() {
    dirty = true;
    pump();
  }

  // ── Lifecycle: listeners attach only when motion is allowed ───────────────
  if (!reduced) {
    window.addEventListener('scroll', onScroll, { passive: true });
  }
  window.addEventListener('resize', resize);
  if ('IntersectionObserver' in window && !reduced && devP === null) {
    var io = new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      if (inView) {
        dirty = true;
        pump();
      }
    });
    io.observe(scene);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        dirty = true;
        pump();
      }
    });
  }
})();
