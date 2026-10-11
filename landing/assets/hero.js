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
 * Dev-only progress hook: add ?heroP=0.42 to the URL to freeze p. Inert in
 * normal production browsing; this site has no build step, so a runtime gate
 * is the only way to keep the hook out of page behaviour (documented
 * deviation from spec section 5).
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

  // Dev-only freeze hook (documented deviation): ?heroP=0.42 pins progress.
  var devP = null;
  (function () {
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
  var dotXY = null;
  var startXY = null;
  var ctrlXY = null;
  var stag = null;
  var cityXY = null, cityRank = null;
  var EDGES = [];
  var packets = [];

  // Map data is committed and seeded upstream by scripts/generate-world-map.mjs;
  // the runtime only consumes it. Failure keeps the static SVG fallback.
  fetch('/assets/world-dots.json', { credentials: 'omit' })
    .then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    })
    .then(function (data) {
      prepare(data);
      ready = true;
      resize();
    })
    .catch(function () { /* static SVG fallback stays visible */ });

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
    dotXY = new Float32Array(N * 2);
    startXY = new Float32Array(N * 2);
    ctrlXY = new Float32Array(N * 2);
    stag = new Float32Array(N);
    for (i = 0; i < N; i += 1) {
      dotXY[i * 2] = dots[order[i]][0];
      dotXY[i * 2 + 1] = dots[order[i]][1];
      var ang = rnd() * Math.PI * 2;
      var rad = 0.92 + (rnd() - 0.5) * 0.32;
      startXY[i * 2] = Math.cos(ang) * rad;
      startXY[i * 2 + 1] = Math.sin(ang) * rad * 0.86;
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
    showN = W < 720 ? Math.floor(N * 0.4) : N;
    var rect = wrapper.getBoundingClientRect();
    wrapTop = rect.top + window.scrollY;
    dirty = true;
    pump();
  }

  // ── ICON phase: chat bubble + breathing glow + two shockwave rings ────────
  function drawIcon(p) {
    var u = seg(p, PHASES.icon[0], PHASES.icon[1]);
    var cx = W * 0.5;
    var cy = H * 0.44;
    var r = Math.min(W, H) * 0.11;
    var breathe = 1 + 0.05 * Math.sin(p * Math.PI * 6);
    r *= breathe;
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
    var g = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.1);
    g.addColorStop(0, rgba(COL.green, 0.16));
    g.addColorStop(1, rgba(COL.green, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - r * 2.2, cy - r * 2.2, r * 4.4, r * 4.4);
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

  // ── BURST: particles leave the bubble silhouette in organic flow ──────────
  function drawBurst(p) {
    var u = seg(p, PHASES.burst[0], PHASES.burst[1]);
    var cx = W * 0.5, cy = H * 0.44;
    var r = Math.min(W, H) * 0.11;
    var fade = 1 - seg(u, 0, 0.25);
    if (fade > 0) {
      ctx.save();
      ctx.globalAlpha = fade;
      drawBubble(cx, cy, r);
      ctx.restore();
    }
    var ghost = clamp(1 - (u - 0.15) / 0.5, 0, 1);
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
      var sx = cx + startXY[i * 2] * r;
      var sy = cy + startXY[i * 2 + 1] * r;
      var tx = map.x + dotXY[i * 2] * map.w;
      var ty = map.y + dotXY[i * 2 + 1] * map.h;
      var mxp = W * 0.5 + ctrlXY[i * 2] * W * 0.5;
      var myp = H * 0.5 + ctrlXY[i * 2 + 1] * H * 0.5;
      var a = 1 - ti, b = ti;
      var ix = a * a * sx + 2 * a * b * mxp + b * b * tx;
      var iy = a * a * sy + 2 * a * b * myp + b * b * ty;
      var ti2 = Math.max(0, ti - 0.02);
      var a2 = 1 - ti2, b2 = ti2;
      var jx = a2 * a2 * sx + 2 * a2 * b2 * mxp + b2 * b2 * tx;
      var jy = a2 * a2 * sy + 2 * a2 * b2 * myp + b2 * b2 * ty;
      ctx.strokeStyle = rgba(COL.deep, 0.5);
      ctx.beginPath();
      ctx.moveTo(jx, jy);
      ctx.lineTo(ix, iy);
      ctx.stroke();
      ctx.fillStyle = rgba(COL.deep, 0.85);
      ctx.fillRect(ix - 1.2, iy - 1.2, 2.4, 2.4);
    }
  }

  // ── MAP phase: morph completes; faint grid + remaining dots settle in ─────
  function drawGrid(alpha, offX, offY) {
    if (alpha <= 0) return;
    ctx.strokeStyle = rgba(COL.hair, alpha);
    ctx.lineWidth = 1;
    var cols = 12, rows = 7;
    var c, r2, x, y;
    for (c = 1; c < cols; c += 1) {
      x = map.x + (c / cols) * map.w + offX;
      ctx.beginPath();
      ctx.moveTo(x, map.y + offY);
      ctx.lineTo(x, map.y + map.h + offY);
      ctx.stroke();
    }
    for (r2 = 1; r2 < rows; r2 += 1) {
      y = map.y + (r2 / rows) * map.h + offY;
      ctx.beginPath();
      ctx.moveTo(map.x + offX, y);
      ctx.lineTo(map.x + map.w + offX, y);
      ctx.stroke();
    }
  }
  function drawStaticMap(alpha, offX, offY) {
    ctx.fillStyle = rgba(COL.deep, alpha);
    for (var i = 0; i < N; i += 1) {
      var x = map.x + dotXY[i * 2] * map.w + offX;
      var y = map.y + dotXY[i * 2 + 1] * map.h + offY;
      ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
    }
  }
  function drawMap(p) {
    var u = seg(p, PHASES.map[0], PHASES.map[1]);
    var off = layerOff(u);
    drawGrid(0.6 * smooth(Math.min(1, u * 2)), off.bg, 0);
    var cx = W * 0.5, cy = H * 0.44;
    var r = Math.min(W, H) * 0.11;
    var n = Math.min(showN, N);
    for (var i = 0; i < n; i += 1) {
      var ti = easeInOutCubic(clamp((u * 1.35 - stag[i] * 0.35) / 0.85, 0, 1));
      var tx = map.x + dotXY[i * 2] * map.w + off.map;
      var ty = map.y + dotXY[i * 2 + 1] * map.h;
      if (ti >= 1) {
        ctx.fillStyle = rgba(COL.deep, 0.55);
        ctx.fillRect(tx - 1.2, ty - 1.2, 2.4, 2.4);
        continue;
      }
      var sx = cx + startXY[i * 2] * r;
      var sy = cy + startXY[i * 2 + 1] * r;
      var mxp = W * 0.5 + ctrlXY[i * 2] * W * 0.5 + off.fg;
      var myp = H * 0.5 + ctrlXY[i * 2 + 1] * H * 0.5;
      var a = 1 - ti, b = ti;
      var ix = a * a * sx + 2 * a * b * mxp + b * b * tx;
      var iy = a * a * sy + 2 * a * b * myp + b * b * ty;
      ctx.fillStyle = rgba(COL.deep, 0.85);
      ctx.fillRect(ix - 1.2, iy - 1.2, 2.4, 2.4);
    }
    var extra = clamp((u - 0.55) / 0.45, 0, 1);
    if (extra > 0 && showN < N) {
      ctx.fillStyle = rgba(COL.deep, 0.4);
      for (i = showN; i < N; i += 1) {
        if ((i % 7) / 7 > extra) continue;
        var ex = map.x + dotXY[i * 2] * map.w + off.map;
        var ey = map.y + dotXY[i * 2 + 1] * map.h;
        ctx.fillRect(ex - 1.2, ey - 1.2, 2.4, 2.4);
      }
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
  function drawArcs(f, alpha, offX, pulse) {
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
        var o = 1 - f, s = f;
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
  function drawCities(ap, offX) {
    if (ap <= 0 || !cityRank) return;
    for (var k = 0; k < cityRank.length; k += 1) {
      var a = seg(ap, cityRank[k], cityRank[k] + 0.25);
      if (a <= 0) continue;
      var x = map.x + cityXY[k * 2] * map.w + offX;
      var y = map.y + cityXY[k * 2 + 1] * map.h + offX;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = rgba(COL.deep, 0.9 * a);
      ctx.fill();
    }
  }

  // ── Message packets: restrained rectangles travelling the fixed arcs ──────
  function drawPackets(p, pulse, offX) {
    ctx.fillStyle = rgba(COL.green, Math.min(1, 0.95 + pulse * 0.05));
    for (var i = 0; i < packets.length; i += 1) {
      var pk = packets[i];
      var t = (pk.phase + p * pk.speed * (1 + pulse * 2.5)) % 1;
      var a = EDGES[pk.edge][0], b = EDGES[pk.edge][1];
      var x1 = map.x + cityXY[a * 2] * map.w + offX;
      var y1 = map.y + cityXY[a * 2 + 1] * map.h + offX;
      var x2 = map.x + cityXY[b * 2] * map.w + offX;
      var y2 = map.y + cityXY[b * 2 + 1] * map.h + offX;
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
  function drawNetwork(p) {
    var u = seg(p, PHASES.network[0], PHASES.network[1]);
    var off = layerOff(0.5 + u * 0.4);
    drawGrid(0.5, off.bg, 0);
    drawStaticMap(0.5, off.map, 0);
    drawArcs(seg(u, 0.15, 0.8), 0.45, off.map, 0);
    drawCities(seg(u, 0, 0.7), off.map);
    drawPackets(p, 0, off.map);
  }
  function drawFinale(p) {
    var pulse = gauss(p, 0.95, 0.03);
    drawGrid(0.5, 0, 0);
    drawStaticMap(0.5, 0, 0);
    drawArcs(1, 0.45, 0, pulse);
    drawCities(1, 0);
    drawPackets(p, pulse, 0);
  }

  // ── Render dispatch: one draw per scroll update, zero idle work ───────────
  function render() {
    var p = reduced ? 1 : currentP();
    ctx.clearRect(0, 0, W, H);
    if (p < PHASES.burst[1]) {
      if (p < PHASES.icon[1]) drawIcon(p);
      else drawBurst(p);
    } else if (p < PHASES.network[0]) drawMap(p);
    else if (p < PHASES.finale[0]) drawNetwork(p);
    else drawFinale(p);
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
