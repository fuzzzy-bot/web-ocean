// Fuzzzy Effects: an island cove modelled on Cala Goloritzé (Baunei, Sardinia).
// White pebble beach in a crescent cove, limestone cliffs, scrub on top and the needle
// (the Aguglia) at the right-hand end of the beach. Shown when F.windP[1].x (beach) > 0.5.
// The island sits behind the start view (+z); the sun sets towards -z, so it lights the cliffs.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';

export const TERRAIN_GRID = 1024;               // vertices per side
export const TERRAIN_MIN = [-1000, 200];        // world x, z of the grid corner (m)
export const TERRAIN_SIZE = 2000;               // grid side (m), about 2 m between vertices

// Height of the island in metres (sea level 0). terrainBase has no fine noise (cheap, used by
// the water and the camera); terrainH adds erosion detail for the land itself.
export const TERRAIN_FN = /* wgsl */ `
const NEEDLE_C: vec2f = vec2f(-78.0, 627.0);
const NEEDLE_H: f32 = 143.0;
fn beachOn() -> bool { return F.windP[1].x > 0.5; }
fn coastZ(x: f32) -> f32 { let xc = clamp(x, -330.0, 330.0); return 640.0 - 0.0035 * xc * xc; }
fn beachW(x: f32) -> f32 { return 55.0 * exp(-(x / 125.0) * (x / 125.0)); }
fn islandMask(p: vec2f) -> f32 {
  return (1.0 - smoothstep(650.0, 980.0, abs(p.x))) * (1.0 - smoothstep(1500.0, 2150.0, p.y));
}
// x = distance inland from the waterline (negative at sea), y = how much beach there is (0..1)
fn shoreInfo(p: vec2f) -> vec2f {
  let bwn = beachW(p.x) / 55.0;
  let wob = 10.0 * gnoise(p * 0.011 + 3.7) * (1.0 - bwn);
  return vec2f(p.y - coastZ(p.x) + wob, bwn);
}
fn needleH(p: vec2f, detail: bool) -> f32 {
  let d = p - NEEDLE_C;
  let r = length(d);
  if (r > 40.0) { return -100.0; }
  var rr = r;
  if (detail && r > 0.01) {
    let dir = d / r;
    rr = r * (1.0 + 0.32 * gnoise(dir * 1.7 + 7.0) + 0.18 * gnoise(dir * 4.1 + 2.0) + 0.08 * gnoise(d * 0.6));
  }
  // slender, craggy spire with stepped shoulders
  let prof = 1.0 - smoothstep(2.0, 15.0, rr);
  var spire = NEEDLE_H * pow(prof, 0.42);
  spire -= 9.0 * smoothstep(0.35, 0.75, fract(spire / 26.0)) * (1.0 - prof);
  let rubble = 16.0 * (1.0 - smoothstep(9.0, 30.0, r));
  return max(spire, rubble);
}
fn terrainCore(p: vec2f, detail: bool) -> f32 {
  let si = shoreInfo(p);
  let u = si.x;
  let bwn = si.y;
  let bw = bwn * 55.0;
  var h: f32;
  if (u < 0.0) {
    // seabed: gentle under the beach, a steep drop under the cliffs
    h = max(u * mix(1.3, 0.075, bwn), -55.0);
  } else {
    let v = max(u - bw, 0.0);
    // cliffs about 110-170 m at the shore, rising inland; a gorge (the codula) opens behind
    // the beach, as at Goloritzé
    var cliffH = 140.0 + 45.0 * gnoise(p * 0.004 + 1.3);
    let gorgeW = 45.0 + 0.22 * v;
    cliffH *= 1.0 - 0.8 * exp(-(p.x / gorgeW) * (p.x / gorgeW)) * smoothstep(-20.0, 30.0, v);
    let vs = v * v / (v + 6.0);   // rounded foot (talus) where the beach meets the cliff
    var c = cliffH * (1.0 - exp(-vs / 20.0));
    // limestone benches: flat ledges between steep bands
    let band = c / 14.0;
    c = mix(c, (floor(band) + smoothstep(0.25, 0.95, fract(band))) * 14.0, 0.55);
    h = min(u, bw) * 0.13 + c + v * 0.09;
    if (detail) {
      // eroded cliff faces, ledges and gullies
      let e = gnoise(p * 0.035) * 0.6 + gnoise(p * 0.09 + 5.1) * 0.3 + gnoise(p * 0.25 + 9.3) * 0.1;
      h += e * 9.0 * smoothstep(18.0, 50.0, v);
    }
  }
  h = mix(-55.0, h, islandMask(p));
  return max(h, needleH(p, detail));
}
fn terrainBase(p: vec2f) -> f32 { return terrainCore(p, false); }
fn terrainH(p: vec2f) -> f32 { return terrainCore(p, true); }
`;

export const TERRAIN = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
` + SKY_RENDER_FUNCS + TERRAIN_FN + /* wgsl */ `
const GRID: u32 = ${TERRAIN_GRID}u;
const T_MIN: vec2f = vec2f(${TERRAIN_MIN[0]}.0, ${TERRAIN_MIN[1]}.0);
const T_SIZE: f32 = ${TERRAIN_SIZE}.0;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) xz: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  var o: VO;
  if (!beachOn()) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); return o; }
  let q = vi / 6u;
  let k = vi % 6u;
  let cx = q % (GRID - 1u);
  let cz = q / (GRID - 1u);
  let ox = select(0u, 1u, k == 1u || k == 2u || k == 4u);
  let oz = select(0u, 1u, k == 2u || k == 4u || k == 5u);
  let xz = T_MIN + vec2f(f32(cx + ox), f32(cz + oz)) * (T_SIZE / f32(GRID - 1u));
  let h = terrainH(xz);
  // seabed far below the surface is never visible; fold it away so it costs no fragments
  let world = vec3f(xz.x, max(h, -8.0), xz.y);
  o.rel = world - F.camPos.xyz;
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  o.xz = xz;
  return o;
}

fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

// pebbles: a cell pattern of rounded stones with small brightness variation
fn pebbles(p: vec2f) -> vec2f {
  let g = p * 3.2;
  let c = floor(g);
  var best = 9.0;
  var id = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = c + vec2f(f32(i), f32(j));
      let o = vec2f(hash2(cc), hash2(cc + 17.0)) * 0.8 + 0.1;
      let d = length(g - cc - o);
      if (d < best) { best = d; id = hash2(cc + 3.1); }
    }
  }
  return vec2f(best, id);
}

fn rockAt(hc: f32, y: f32, p: vec2f) -> vec4f {
  let streak = gnoise(vec2f(hc * 0.06, y * 0.012)) * 0.5 + 0.5;
  let stain = gnoise(vec2f(hc * 0.02, y * 0.03) + 4.0) * 0.5 + 0.5;
  let blotch = gnoise(vec2f(hc * 0.012, y * 0.01) + 11.0) * 0.5 + 0.5;
  var rock = mix(vec3f(0.80, 0.79, 0.75), vec3f(0.74, 0.55, 0.38), smoothstep(0.5, 0.85, stain));
  rock = mix(rock, vec3f(0.36, 0.36, 0.35), smoothstep(0.5, 0.92, streak) * 0.75);
  rock = mix(rock, vec3f(0.58, 0.56, 0.52), smoothstep(0.55, 0.8, blotch) * 0.6);
  rock *= 0.8 + 0.35 * (gnoise(vec2f(hc * 0.6, y * 0.6)) * 0.5 + 0.5);
  return vec4f(rock, 1.0);
}
fn rockBump(hc: f32, y: f32) -> vec3f {
  return vec3f(gnoise(vec2f(hc * 0.21, y * 0.13) + 1.0) + 0.5 * gnoise(vec2f(hc * 0.9, y * 0.7) + 5.0),
               0.4 * gnoise(vec2f(hc * 0.3, y * 0.3) + 9.0),
               gnoise(vec2f(hc * 0.21, y * 0.13) + 3.0) + 0.5 * gnoise(vec2f(hc * 0.9, y * 0.7) + 7.0));
}

fn softShadow(p: vec3f, L: vec3f) -> f32 {
  if (L.y <= 0.0) { return 0.0; }
  var s = 1.0;
  var t = 2.0;
  for (var i = 0; i < 20; i++) {
    let q = p + L * t;
    if (q.y > 330.0) { break; }
    let dh = q.y - terrainBase(q.xz);
    s = min(s, clamp(dh / (t * 0.08) + 0.5, 0.0, 1.0));
    if (s <= 0.0) { break; }
    t *= 1.32;
  }
  return s;
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let p = in.xz;
  let e = 0.6;
  let h = terrainH(p);
  let hx = terrainH(p + vec2f(e, 0.0)) - terrainH(p - vec2f(e, 0.0));
  let hz = terrainH(p + vec2f(0.0, e)) - terrainH(p - vec2f(0.0, e));
  var n = normalize(vec3f(-hx, 2.0 * e, -hz));
  let world = in.rel + F.camPos.xyz;
  let dist = length(in.rel);
  let si = shoreInfo(p);
  let u = si.x;
  let bw = si.y * 55.0;

  // ---- materials ----
  // limestone: pale cream with orange-grey run-off stains in vertical streaks
  // rock is textured along the cliff face from two directions, blended by the face direction,
  // so no face shows stretched streaks
  let wx = abs(n.z) / (abs(n.x) + abs(n.z) + 1e-4);
  let ra = rockAt(p.x, world.y, p);
  let rb = rockAt(p.y + 500.0, world.y, p);
  var rock = mix(rb.rgb, ra.rgb, wx);
  let rjA = rockBump(p.x, world.y);
  let rjB = rockBump(p.y + 500.0, world.y);
  let rk = mix(rjB, rjA, wx);
  n = normalize(n + rk * 0.55 * (1.0 - smoothstep(0.75, 0.95, n.y)));
  // scrub (macchia) on gentle slopes high up
  let veg = smoothstep(0.5, 0.72, n.y) * smoothstep(8.0, 20.0, world.y) * smoothstep(-0.35, 0.15, gnoise(p * 0.06) + 0.25 * gnoise(p * 0.5));
  let scrub = mix(vec3f(0.10, 0.14, 0.06), vec3f(0.22, 0.24, 0.12), smoothstep(-0.3, 0.5, gnoise(p * 0.3)));
  var alb = mix(rock, scrub, veg);
  // pebble beach
  let onBeach = smoothstep(bw + 6.0, bw - 2.0, u) * step(-30.0, u) * (1.0 - smoothstep(8.0, 16.0, world.y));
  if (onBeach > 0.0) {
    let pb = pebbles(p);
    let stone = vec3f(0.95, 0.94, 0.90) * (0.85 + 0.2 * pb.y) * mix(vec3f(1.0), vec3f(1.0, 0.92, 0.86), step(0.8, pb.y));
    let gap = smoothstep(0.25, 0.55, pb.x);
    let peb = mix(stone, stone * 0.55, gap * 0.6);
    // wet band along the waterline
    let wet = 1.0 - smoothstep(0.3, 1.4, world.y);
    alb = mix(alb, peb * mix(1.0, 0.55, wet), onBeach);
    n = normalize(n + vec3f(gnoise(p * 9.0), 0.0, gnoise(p * 9.0 + 2.0)) * 0.12 * onBeach);
  }

  // ---- light ----
  let L = F.sunDir.xyz;
  // rock keeps more of its own colour: only part of the surreal red cast reaches it
  let sunE = mix(sampleTrans(camR(), F.sunDir.y) * F.sunDir.w, sunIlluminance(), 0.45);
  let shadow = softShadow(world + n * 0.5, L);
  let ndl = max(dot(n, L), 0.0);
  let skyUp = skyAtmo(vec3f(0.0, 1.0, 0.0));
  let skyN = skyAtmo(normalize(vec3f(n.x, max(n.y, 0.0) + 0.25, n.z)));
  let ao = 0.55 + 0.45 * n.y;
  var col = alb * (sunE * ndl * shadow * 0.318 + (skyUp * 0.6 + skyN * 0.6) * ao * (1.0 + 0.5 * onBeach));

  // ---- aerial perspective (same as the sea) ----
  let V = -in.rel / dist;
  let T = exp(-max(F.fogExt.rgb, vec3f(F.fogExt.w)) * dist);
  let hzv = normalize(vec3f(-V.x, 0.002, -V.z));
  col = col * T + skyAtmo(hzv) * (1.0 - T);
  return vec4f(col, 1.0);
}
`;
