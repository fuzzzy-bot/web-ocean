// Fuzzzy Effects: the arch at Cala Goloritzé (Baunei, Sardinia), matched to a reference photo
// taken from the water at midday. The headland and the arch are a signed-distance model drawn by
// ray marching (a height map cannot make an arch). Shown when F.windP[1].x (beach) > 0.5.
// Camera for the reference view: (0, 2.5, 0), looking along -z, pitched down about 10 degrees.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';

// Shared by the rock pass and the sea (reflections, shallows).
export const ROCK_FN = /* wgsl */ `
fn beachOn() -> bool { return F.windP[1].x > 0.5; }

fn h3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(h3(i), h3(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(h3(i + vec3f(0.0, 1.0, 0.0)), h3(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y);
  let b = mix(mix(h3(i + vec3f(0.0, 0.0, 1.0)), h3(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(h3(i + vec3f(0.0, 1.0, 1.0)), h3(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z) * 2.0 - 1.0;
}
fn fbm3(p: vec3f, oct: i32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < oct; i++) { s += a * vnoise(q); q = q * 2.03 + vec3f(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// headland face: runs from the arch (HA) towards the camera's right; HN points out of the rock
const HA: vec3f = vec3f(-1.0, 0.0, -97.0);
const HD: vec3f = vec3f(0.681, 0.0, 0.732);
const HN: vec3f = vec3f(-0.732, 0.0, 0.681);

fn ridgeAt(p: vec3f) -> f32 {
  let s = dot(p - HA, HD);
  let sp = max(s, 0.0);
  return 18.0 + 1.35 * sp - 0.003 * sp * sp + 6.0 * vnoise(vec3f(s * 0.05, 4.1, 2.0));
}
fn headland(p: vec3f) -> f32 {
  let r = p - HA;
  let s = dot(r, HD);
  // face leans back as it rises, with big bulges and buttresses
  let face = (dot(r, HN) + max(p.y, 0.0) * 0.12 + 4.0 * vnoise(vec3f(s * 0.06, p.y * 0.05, 1.3))) * 0.94;
  // ridge climbs from the arch towards the right, then levels into the hillside
  let sp = max(s, 0.0);
  let ridge = 18.0 + 1.35 * sp - 0.003 * sp * sp + 6.0 * vnoise(vec3f(s * 0.05, 4.1, 2.0));
  let top = (p.y - min(ridge, 170.0)) * 0.45;
  let endc = -s - 2.0 + 0.12 * p.y;                 // seaward end, leaning slightly
  return max(max(face, top), endc);
}

// the arch: a leaning outer leg standing in the sea and a thick lintel back to the headland
fn archLeg(p: vec3f) -> f32 {
  var q = p - vec3f(-20.0, 0.0, -96.0);
  let t = clamp(q.y / 15.0, 0.0, 1.0);
  q.x -= q.y * 0.95;                                  // leans hard towards the headland, like a ramp
  let w = mix(10.5, 3.2, pow(t, 0.7));
  let dxz = length(max(abs(q.xz) - vec2f(w, 5.5), vec2f(0.0))) + min(max(abs(q.x) - w, abs(q.z) - 5.5), 0.0);
  let dy = max(-q.y - 6.0, q.y - 17.5);
  return max(dxz, dy) - 1.0;
}
fn archLintel(p: vec3f) -> f32 {
  let a = vec3f(-12.5, 17.0, -96.5);
  let b = vec3f(1.5, 15.8, -97.0);
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  var d = pa - ba * h;
  d.y *= 0.82;                                         // a little taller than deep
  return length(d) - 3.7;
}

// coarse shape (no fine detail): used by the sea and for shadows
fn rockShape(p: vec3f) -> f32 {
  return smin(headland(p), smin(archLeg(p), archLintel(p), 2.5), 3.0);
}
// full detail for the rock surface itself
// scrub: rounded clumps standing proud of the rock along the ridge, over the top and on the arch
fn scrubSDF(p: vec3f, base: f32) -> f32 {
  let top = smoothstep(14.0, 2.0, ridgeAt(p) - p.y) * smoothstep(-2.0, 6.0, dot(p - HA, HD));
  let archTop = smoothstep(19.0, 22.0, p.y) * smoothstep(-6.0, 0.0, p.x) * smoothstep(6.0, 0.0, archLintel(p));
  let zone = max(top, archTop) * smoothstep(12.0, 18.0, p.y);
  if (zone <= 0.0) { return 1e3; }
  let clump = smoothstep(0.0, 0.3, fbm3(p * 0.32 + 2.0, 3)) * zone;
  if (clump <= 0.0) { return 1e3; }
  return base - 2.2 * clump + 0.5 * fbm3(p * 1.3, 2) + 0.5;
}
fn rockSDF(p: vec3f) -> f32 {
  var d = rockShape(p);
  if (d < 8.0) {
    // blocky limestone: ridged noise gives sharp-edged facets and creases at three scales,
    // tilted bedding planes give ledges, and fine noise roughens every face
    let r1 = 1.0 - abs(vnoise(p * 0.045));
    let r2 = 1.0 - abs(vnoise(p * 0.13 + 3.1));
    let r3 = 1.0 - abs(vnoise(p * vec3f(0.45, 0.2, 0.45) + 7.7));
    d -= 4.5 * r1 * r1 + 1.6 * r2 * r2 + 0.45 * r3 * r3 - 4.0;
    let bed = dot(p, normalize(vec3f(0.15, 1.0, 0.25)));
    d += 0.25 * smoothstep(0.6, 0.9, fract(bed * 0.16 + 1.2 * vnoise(p * 0.05))) * smoothstep(-0.2, 0.3, vnoise(p * 0.08 + 4.0));
    d += 0.18 * fbm3(p * 1.4, 2);
  }
  return d;
}
// rock or scrub, whichever is nearer: x = distance, y = 1 for scrub
fn sceneSDF(p: vec3f) -> vec2f {
  let base = rockShape(p);
  let r = rockSDF(p);
  if (base > 10.0) { return vec2f(r, 0.0); }
  let b = scrubSDF(p, base);
  return select(vec2f(r, 0.0), vec2f(b, 1.0), b < r);
}

// seabed depth of the cove: shallow towards the beach (behind the camera), deeper out to sea
// and to the left; a little shallower right under the rocks
fn coveDepth(p: vec2f) -> f32 {
  var d = 1.6 + max(60.0 - p.y, 0.0) * 0.072 + max(-p.x - 25.0, 0.0) * 0.06;
  d += 2.0 * gnoise(p * 0.02);
  let nearRock = rockShape(vec3f(p.x, -4.0, p.y));
  d = mix(min(d, 3.0 + max(nearRock, 0.0) * 0.4), d, smoothstep(0.0, 25.0, nearRock));
  return clamp(d, 1.2, 60.0);
}
`;

export const ROCKS = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
` + SKY_RENDER_FUNCS + ROCK_FN + /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.5, 1.0);
  o.ndc = p;
  return o;
}
struct FO { @location(0) col: vec4f, @builtin(frag_depth) depth: f32 };

const BMIN: vec3f = vec3f(-45.0, -6.0, -135.0);
const BMAX: vec3f = vec3f(170.0, 175.0, 90.0);

fn rockNormal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * sceneSDF(p + k.xyy * e).x + k.yyx * sceneSDF(p + k.yyx * e).x +
                   k.yxy * sceneSDF(p + k.yxy * e).x + k.xxx * sceneSDF(p + k.xxx * e).x);
}
fn rockShadow(p: vec3f, L: vec3f) -> f32 {
  if (L.y <= 0.0) { return 0.0; }
  var s = 1.0;
  var t = 0.6;
  for (var i = 0; i < 28; i++) {
    let d = select(rockShape(p + L * t), sceneSDF(p + L * t).x, t < 30.0);
    s = min(s, clamp(8.0 * d / t, 0.0, 1.0));
    if (s < 0.01 || t > 160.0) { break; }
    t += clamp(d, 0.4, 12.0);
  }
  return s;
}
fn rockAO(p: vec3f, n: vec3f) -> f32 {
  var o = 0.0;
  var w = 1.0;
  for (var i = 1; i <= 6; i++) {
    let h = 0.15 + f32(i * i) * 0.25;
    o += w * (h - sceneSDF(p + n * h).x);
    w *= 0.7;
  }
  return clamp(1.0 - o * 0.35, 0.05, 1.0);
}

@fragment fn fs(in: VO) -> FO {
  var o: FO;
  if (!beachOn()) { discard; }
  let ro = F.camPos.xyz;
  let rd = normalize(F.camFwd.xyz + in.ndc.x * F.camRight.xyz + in.ndc.y * F.camUp.xyz);
  // clip the march to the rocks' box
  let inv = 1.0 / rd;
  let t0 = (BMIN - ro) * inv;
  let t1 = (BMAX - ro) * inv;
  let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
  let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  if (tf < max(tn, 0.0)) { discard; }
  var t = max(tn, 0.0);
  var hit = false;
  for (var i = 0; i < 160; i++) {
    let p = ro + rd * t;
    let d = sceneSDF(p).x;
    if (d < 0.0012 * t + 0.008) { hit = true; break; }
    t += d * 0.75;
    if (t > tf) { break; }
  }
  if (!hit) { discard; }
  let p = ro + rd * t;
  if (p.y < -0.5) { discard; }                      // under water: the sea draws it
  let mat = sceneSDF(p).y;
  var n = rockNormal(p, 0.004 * t + 0.02);
  let fl = vec3f(vnoise(vec3f(p.x * 1.1, p.y * 0.08, p.z * 1.1)), 0.0, vnoise(vec3f(p.x * 1.1 + 7.0, p.y * 0.08, p.z * 1.1)));
  n = normalize(n + fl * 0.35 * (1.0 - abs(n.y)));

  // ---- limestone, as in the photo: bright white-grey, grey streaks, rust under the arch ----
  let streak = fbm3(vec3f(p.x * 0.4, p.y * 0.035, p.z * 0.4), 4);
  let blot = fbm3(p * 0.07 + 3.0, 3);
  var alb = vec3f(0.5, 0.5, 0.48);
  alb = mix(alb, vec3f(0.22, 0.24, 0.25), smoothstep(-0.15, 0.25, streak) * 0.9);
  alb = mix(alb, vec3f(0.46, 0.47, 0.48), smoothstep(-0.1, 0.3, blot) * 0.5);
  let under = smoothstep(0.1, -0.5, n.y);
  alb = mix(alb, vec3f(0.45, 0.30, 0.20), under * smoothstep(-0.2, 0.4, fbm3(p * 0.15, 2)) * 0.8);
  alb *= 0.85 + 0.25 * fbm3(p * 0.9, 2);
  // dark weathered cracks and pits
  let crack = smoothstep(0.965, 0.998, 1.0 - abs(vnoise(p * vec3f(1.3, 0.22, 1.3) + 2.0)));
  alb *= 1.0 - 0.4 * crack;
  // patches of grey-black lichen and water stains
  alb = mix(alb, vec3f(0.16, 0.17, 0.17), smoothstep(0.2, 0.5, fbm3(vec3f(p.x * 0.9, p.y * 0.12, p.z * 0.9) + 5.0, 3)) * 0.35);
  // dark band where the sea wets the rock
  alb = mix(alb * vec3f(0.55, 0.56, 0.55), alb, smoothstep(0.2, 1.4, p.y + 0.4 * vnoise(p * 0.5)));
  // scrub and pines on the slopes up top
  let vegN = fbm3(p * 0.12 + 7.0, 3);
  let veg = max(smoothstep(-0.15, 0.3, n.y) * smoothstep(24.0, 34.0, p.y), smoothstep(0.35, 0.7, n.y) * smoothstep(12.0, 18.0, p.y)) * smoothstep(-0.25, 0.05, vegN);
  let green = mix(vec3f(0.06, 0.11, 0.04), vec3f(0.16, 0.24, 0.08), smoothstep(-0.2, 0.5, fbm3(p * 0.5, 2)));
  alb = mix(alb, green, veg * 0.6);
  if (mat > 0.5) {
    // scrub: dark glossy evergreen leaves, lighter tips catching the sun
    alb = mix(vec3f(0.035, 0.07, 0.025), vec3f(0.17, 0.27, 0.07), smoothstep(-0.1, 0.45, fbm3(p * 1.7, 3)));
  }

  // ---- light ----
  let L = F.sunDir.xyz;
  let sunE = sunIlluminance();
  let sh = rockShadow(p + n * 0.3, L);
  let ao = rockAO(p, n);
  let skyUp = skyAtmo(vec3f(0.0, 1.0, 0.0));
  let skyN = skyAtmo(normalize(vec3f(n.x, max(n.y, 0.0) + 0.2, n.z)));
  // light bounced up from the bright turquoise water
  let bounce = vec3f(0.05, 0.22, 0.24) * sunE * max(L.y, 0.0) * 0.12 * smoothstep(0.3, -0.6, n.y);
  var col = alb * (sunE * max(dot(n, L), 0.0) * sh * 0.318 + (skyUp * 0.55 + skyN * 0.55) * ao + bounce);

  let dist = t;
  let T = exp(-max(F.fogExt.rgb, vec3f(F.fogExt.w)) * dist);
  let hz = normalize(vec3f(rd.x, 0.002, rd.z));
  col = col * T + skyAtmo(hz) * (1.0 - T);

  let clip = F.viewProj * vec4f(p - F.camPos.xyz, 1.0);
  o.col = vec4f(col, 1.0);
  o.depth = clip.z / clip.w;
  return o;
}
`;
