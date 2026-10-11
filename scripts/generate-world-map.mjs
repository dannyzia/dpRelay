#!/usr/bin/env node
/**
 * One-off generator for the homepage scroll hero (.kilo/plans/parallax.md §8).
 *
 * Reads Natural Earth 110m land polygons (world-atlas, public domain) and emits
 * two committed assets from the SAME data + SAME seeded graph, so the canvas
 * scene and the no-JS fallback always agree:
 *   landing/assets/world-dots.json — { dots, cities, edges } for hero.js
 *   landing/assets/hero-fallback.svg — static SVG of the assembled map+network
 *
 * Run (deps are generation-time only, never shipped):
 *   npm i --prefix /tmp/mapgen-deps world-atlas@2 topojson-client@3 d3-geo@3
 *   NODE_PATH=/tmp/mapgen-deps/node_modules node scripts/generate-world-map.mjs
 *
 * Determinism contract: hero.js loads the stored edges; it never re-rolls the
 * graph. Do not re-run casually; if you do, re-inspect the hero visually.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { feature } = require("topojson-client");
const { geoContains } = require("d3-geo");
const land110m = require("world-atlas/land-110m.json");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "landing", "assets");

// ── Tuning constants ────────────────────────────────────────────────────────
const SEED = 0xd9e1a7; // arc graph seed; edges are stored, never re-rolled
const LAT_MIN = -60;   // crop empty far-south ocean; coasts stay (no favouritism)
const LAT_MAX = 85;
const GRID_STEPS = [2.5, 2.4, 2.3]; // coarse -> fine until >= 2500 land dots
const EDGE_TARGET = 70; // parallax.md: 60-80 deterministic arcs

// ── Equirectangular normalization shared by every asset ─────────────────────
const normX = (lon) => (lon + 180) / 360;                    // [0,1]
const normY = (lat) => (LAT_MAX - lat) / (LAT_MAX - LAT_MIN); // [0,1]

// ── Seeded PRNG (mulberry32) — same algorithm as hero.js ────────────────────
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The 40 route cities (parallax.md §3 NETWORK) — geometry only ────────────
const CITY_TABLE = [
  ["New York", 40.71, -74.01], ["Los Angeles", 34.05, -118.24],
  ["Toronto", 43.65, -79.38], ["Mexico City", 19.43, -99.13],
  ["Bogota", 4.71, -74.07], ["Lima", -12.05, -77.04],
  ["Santiago", -33.45, -70.67], ["Sao Paulo", -23.55, -46.63],
  ["Buenos Aires", -34.6, -58.38], ["London", 51.51, -0.13],
  ["Paris", 48.86, 2.35], ["Berlin", 52.52, 13.4],
  ["Madrid", 40.42, -3.7], ["Rome", 41.9, 12.5],
  ["Amsterdam", 52.37, 4.9], ["Stockholm", 59.33, 18.07],
  ["Istanbul", 41.01, 28.98], ["Moscow", 55.76, 37.62],
  ["Cairo", 30.04, 31.24], ["Lagos", 6.52, 3.38],
  ["Nairobi", -1.29, 36.82], ["Johannesburg", -26.2, 28.05],
  ["Dubai", 25.2, 55.27], ["Riyadh", 24.71, 46.68],
  ["Doha", 25.29, 51.53], ["Kuwait City", 29.38, 47.99],
  ["Karachi", 24.86, 67.01], ["Mumbai", 19.08, 72.88],
  ["Delhi", 28.61, 77.21], ["Dhaka", 23.81, 90.41],
  ["Bangkok", 13.76, 100.5], ["Kuala Lumpur", 3.14, 101.69],
  ["Singapore", 1.35, 103.82], ["Jakarta", -6.21, 106.85],
  ["Manila", 14.6, 120.98], ["Hong Kong", 22.32, 114.17],
  ["Seoul", 37.57, 126.98], ["Tokyo", 35.68, 139.69],
  ["Sydney", -33.87, 151.21], ["Auckland", -36.85, 174.76],
];

// ── Land dot grid: sample on a lat/lon lattice, keep cells inside land ──────
const land = feature(land110m, land110m.objects.land).features[0];
let dots = [];
let usedStep = 0;
for (const step of GRID_STEPS) {
  dots = [];
  const rows = Math.round((LAT_MAX - LAT_MIN) / step);
  const cols = Math.round(360 / step);
  for (let j = 0; j < rows; j += 1) {
    const lat = LAT_MIN + (j + 0.5) * step;
    for (let i = 0; i < cols; i += 1) {
      const lon = -180 + (i + 0.5) * step;
      if (geoContains(land, [lon, lat])) {
        dots.push([Number(normX(lon).toFixed(3)), Number(normY(lat).toFixed(3))]);
      }
    }
  }
  usedStep = step;
  if (dots.length >= 2500) break;
}

// ── City + edge graph: spanning tree by random attachment + extra links ─────
const cities = CITY_TABLE.map(([, lat, lon]) => [normX(lon), normY(lat)]);
const rand = mulberry32(SEED);
const order = cities.map((_, i) => i);
for (let i = order.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const edges = [];
const seen = new Set();
function addEdge(a, b) {
  if (a === b) return;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(a < b ? [a, b] : [b, a]);
}
for (let i = 1; i < order.length; i += 1) {
  addEdge(order[i], order[Math.floor(rand() * i)]);
}
let guard = 0;
while (edges.length < EDGE_TARGET && guard < 5000) {
  guard += 1;
  addEdge(Math.floor(rand() * 40), Math.floor(rand() * 40));
}

// ── Fallback SVG (no-JS / canvas-failure state = assembled map + network) ───
const VBW = 1200;
const VBH = 675;
const MX = 60;
const MY = 150;
const MW = 1080;
const MH = 480;
function px(x) {
  return (MX + x * MW).toFixed(1);
}
function py(y) {
  return (MY + y * MH).toFixed(1);
}
function arcPath(a, b) {
  const x1 = MX + a[0] * MW;
  const y1 = MY + a[1] * MH;
  const x2 = MX + b[0] * MW;
  const y2 = MY + b[1] * MH;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const lift = Math.min(90, len * 0.22);
  return `M ${px(a[0])} ${py(a[1])} Q ${mx - (dy / len) * lift} ${my + (dx / len) * lift} ${px(b[0])} ${py(b[1])}`;
}

// ── Emit both assets ────────────────────────────────────────────────────────
const dotPath = dots
  .map((d) => `M${px(d[0])} ${py(d[1])}h2.4v2.4h-2.4z`)
  .join("");
const cityNodes = cities
  .map((c) => `<circle cx="${px(c[0])}" cy="${py(c[1])}" r="2.6"/>`)
  .join("");
const arcEls = edges
  .map(([a, b]) => `<path d="${arcPath(cities[a], cities[b])}" class="a"/>`)
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VBW} ${VBH}" role="img" aria-label="Static preview of the dP Relay network map">
<g fill="rgba(22,32,44,0.38)"><path d="${dotPath}"/></g>
<g fill="none" stroke="#047857" stroke-opacity="0.4" stroke-width="1">
${arcEls}
</g>
<g fill="#047857">${cityNodes}</g>
</svg>
`;

mkdirSync(OUT, { recursive: true });
const json = JSON.stringify({
  dots,
  cities: cities.map((c) => [Number(c[0].toFixed(4)), Number(c[1].toFixed(4))]),
  edges,
});
writeFileSync(join(OUT, "world-dots.json"), json);
writeFileSync(join(OUT, "hero-fallback.svg"), svg);
console.log(`dots=${dots.length} step=${usedStep}deg cities=${cities.length} edges=${edges.length}`);
console.log(`json=${(json.length / 1024).toFixed(1)}KB svg=${(svg.length / 1024).toFixed(1)}KB`);
