import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const V = THREE.Vector3;
const isTouch = matchMedia('(pointer: coarse)').matches;
const MAX_BUTTERFLIES = 600;
const GLOW_SECONDS = 20; // 나비를 눌렀을 때 빛나는 시간
const RAIN_SECONDS = 20; // 새 글이 들어왔을 때 비 내리는 시간
// 나비 모습: 'lines' = 빛나는 선으로 그린 나비, 'photo' = 이전의 실사 느낌 나비
const BUTTERFLY_STYLE = 'lines';

// ---------------------------------------------------------------- 난수 · 노이즈

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261004);
const rr = (a, b) => a + (b - a) * rand();
const smooth = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const x00 = l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u);
  const x10 = l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u);
  const x01 = l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u);
  const x11 = l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u);
  return l(l(x00, x10, v), l(x01, x11, v), w) * 2 - 1;
}

// ---------------------------------------------------------------- 무대

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000);
document.getElementById('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.03);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
const CENTER = new V(0, 0.2, 0);
function framingDistance() {
  return THREE.MathUtils.clamp(10.5 / (Math.tan(THREE.MathUtils.degToRad(22.5)) * camera.aspect), 15, 26);
}
camera.position.set(0, 4.6, framingDistance());

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CENTER);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 40;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.22;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.45, 0.72);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- 죽은 나무껍질 (속이 빈, 흰 실로 엮인 껍질)

const UP = new V(0, 1, 0);
const FLAT = 0.78; // 단면을 위아래로 눌러 약간 납작하게
const INNER = 0.8; // 안쪽 면: 속은 비어 있다
const OPEN = 0.5; // 이 값보다 크면 썩어 떨어져 나간 자리
const _a = new V(), _s = new V(), _u = new V();

class Log {
  constructor(points, r0, r1, holes, samples = 240) {
    this.curve = new THREE.CatmullRomCurve3(points);
    this.n = samples;
    this.pts = this.curve.getSpacedPoints(samples);
    this.side = [];
    this.up = [];
    for (let i = 0; i <= samples; i++) {
      const T = this.curve.getTangentAt(i / samples);
      const S = new V().crossVectors(T, UP).normalize(); // th = 0 → 앞(카메라 쪽)
      this.side.push(S);
      this.up.push(new V().crossVectors(S, T).normalize()); // th = π/2 → 위
    }
    this.r0 = r0;
    this.r1 = r1;
    this.length = this.curve.getLength();
    this.holes = holes.map((h) => ({ ...h, along: h.t * this.length }));
    // surface()가 마지막으로 계산한 껍질 정보
    this.crack = 0;
    this.hole = 0;
  }
  radius(t) {
    return THREE.MathUtils.lerp(this.r0, this.r1, Math.pow(t, 1.3)) * (1 + 0.12 * noise3(t * 4, 1.3, 3.1) + 0.07 * noise3(t * 13, 4.2, 0.7));
  }
  // 찢겨 나간 양 끝: 각도마다 끝나는 지점이 다르다
  tStart(th) {
    const n = 0.5 + 0.5 * noise3(Math.cos(th) * 2.5, Math.sin(th) * 2.5, 7);
    const shard = 0.5 + 0.5 * noise3(Math.cos(th) * 9, Math.sin(th) * 9, 3);
    return 0.008 + 0.05 * n + 0.04 * shard ** 4;
  }
  tEnd(th) {
    const n = 0.5 + 0.5 * noise3(Math.cos(th) * 3, Math.sin(th) * 3, 11);
    const shard = 0.5 + 0.5 * noise3(Math.cos(th) * 10, Math.sin(th) * 10, 5);
    return 1 - 0.015 - 0.1 * n * n - 0.06 * shard ** 4;
  }
  // 앞쪽 면이 거의 전체 길이에 걸쳐 통째로 떨어져 나갔다
  sideEdge(along) {
    return {
      center: 0.1 + 0.15 * noise3(along * 0.2, 8, 1),
      half: 0.95 + 0.22 * noise3(along * 0.35, 1.7, 9) + 0.12 * noise3(along * 2.2, 4.4, 2),
    };
  }
  holeAt(along, th) {
    const e = this.sideEdge(along);
    let v = 1 - smooth(0.88, 1, Math.abs(angDiff(th, e.center)) / e.half);
    for (const h of this.holes) {
      const dx = (along - h.along) / h.w;
      const da = angDiff(th, h.th) / h.a;
      const d = Math.hypot(dx, da) * (1 + 0.22 * noise3(dx * 2 + h.t * 9, da * 2, 0.5));
      v = Math.max(v, 1 - smooth(0.7, 1, d));
    }
    return v;
  }
  // t: 통나무를 따라 0~1, th: 둘레 각도, k: 반지름 배율
  surface(t, th, k = 1, out = new V(), dirOut) {
    const fi = THREE.MathUtils.clamp(t, 0, 1) * this.n;
    const i = Math.min(this.n - 1, Math.floor(fi));
    const f = fi - i;
    const p = _a.copy(this.pts[i]).lerp(this.pts[i + 1], f);
    const S = _s.copy(this.side[i]).lerp(this.side[i + 1], f);
    const U = _u.copy(this.up[i]).lerp(this.up[i + 1], f);
    const c = Math.cos(th), s = Math.sin(th);
    const along = t * this.length;

    const lobe = 1 + 0.16 * noise3(c * 1.6, s * 1.6, along * 0.18 + 3);
    // 껍질의 깊은 세로 홈
    const cn = noise3(c * 4.5, s * 4.5, along * 0.12) + 0.45 * noise3(c * 9 + 5, s * 9, along * 0.35);
    this.crack = Math.exp(-((cn / 0.1) ** 2));
    const plate = noise3(c * 6, s * 6, along * 0.5);
    const fine = noise3(c * 14, s * 14, along * 1.5);
    this.hole = this.holeAt(along, th);

    const r = this.radius(t) * lobe * (1 + 0.06 * plate + 0.025 * fine - 0.2 * this.crack) * (1 - 0.06 * this.hole) * k;
    out.copy(p).addScaledVector(S, c * r).addScaledVector(U, s * r * FLAT);
    if (dirOut) dirOut.copy(S).multiplyScalar(c * FLAT).addScaledVector(U, s).normalize();
    return out;
  }
  // 가로로 갈라진 껍질 조각의 경계 (섬유가 여기서 끊긴다)
  plateBreak(t, th) {
    const n = noise3(Math.cos(th) * 4, Math.sin(th) * 4, t * this.length * 1.1);
    return Math.exp(-((n / 0.045) ** 2));
  }
}

const log = new Log([
  new V(-8.6, -0.35, 0.2),
  new V(-5.0, 0.0, 0.0),
  new V(-1.5, 0.15, -0.1),
  new V(2.0, 0.05, 0.1),
  new V(5.2, -0.25, 0.3),
  new V(8.4, -0.6, 0.5),
], 1.45, 0.55, [
  { t: 0.4, th: 2.4, w: 1.3, a: 0.4 },
  { t: 0.66, th: 1.85, w: 0.7, a: 0.28 },
  { t: 0.12, th: 3.7, w: 0.9, a: 0.45 },
  { t: 0.88, th: 4.6, w: 0.8, a: 0.5 },
]);

const linePos = [];
const lineCol = [];
function seg(a, b, ca, cb) {
  linePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  lineCol.push(ca, ca, ca, cb, cb, cb);
}
const LIGHT = new V(0.2, 0.8, 0.75).normalize();
const lightOf = (dir) => 0.12 + 0.88 * Math.max(0, dir.dot(LIGHT)) ** 1.6;

// 껍질 결을 따라 흐르는 섬유 (바깥 면, 그리고 속이 빈 안쪽 면)
function addFibers(count, inner = false) {
  const p = new V(), q = new V(), d = new V();
  for (let s = 0; s < count; s++) {
    let th = rand() * TAU;
    const t0 = log.tStart(th);
    const edge = rand() < 0.12; // 찢긴 끝에서 시작하는 섬유가 껍질 테두리를 만든다
    let t = edge ? t0 : rr(t0, log.tEnd(th));
    const worldLen = 0.5 + rand() ** 2 * 6;
    const steps = Math.max(3, Math.round(worldLen / 0.07));
    const dt = worldLen / log.length / steps;
    const k = inner ? INNER + rr(-0.015, 0.01) : 1 + rr(-0.015, 0.03);
    const g = inner ? rr(0.06, 0.22) : rand() < 0.08 ? rr(0.4, 0.8) : rr(0.05, 0.22);
    const shade = (dir) => (inner ? 0.2 + 0.8 * lightOf(dir.negate()) : lightOf(dir));
    log.surface(t, th, k, p, d);
    let cp = edge ? g * shade(d) : 0;
    for (let j = 1; j <= steps; j++) {
      t += dt;
      if (t > log.tEnd(th)) break;
      th += noise3(t * log.length * 0.8, s * 0.13, 2) * 0.035;
      log.surface(t, th, k, q, d);
      const open = log.hole, crack = log.crack;
      const env = (edge ? 1 : Math.min(1, j / 3)) * Math.min(1, (steps - j) / 3);
      const c = g * shade(d) * (1 - 0.95 * crack) * env;
      if (open < OPEN && log.plateBreak(t, th) < 0.6) seg(p, q, cp, c);
      p.copy(q);
      cp = c;
    }
  }
}

// 썩어 떨어져 나간 자리: 바깥·안쪽 테두리와 그 사이의 껍질 두께
function addOpenings() {
  const p = new V(), q = new V(), d = new V();
  const rim = (h, phi, w) => ({
    t: (h.along + Math.cos(phi) * w * h.w) / log.length,
    th: h.th + Math.sin(phi) * w * h.a,
  });
  for (const h of log.holes) {
    const steps = Math.round(60 + 40 * h.w);
    for (const [k, loops, gain] of [[1, 6, [0.25, 0.6]], [INNER, 4, [0.15, 0.32]]]) {
      for (let loop = 0; loop < loops; loop++) {
        const rd = rr(0.84, 0.9);
        const g = rr(gain[0], gain[1]);
        let prev = 0;
        for (let j = 0; j <= steps; j++) {
          const phi = (j / steps) * TAU;
          const w = rd * (1 + 0.1 * noise3(Math.cos(phi) * 2 + loop, Math.sin(phi) * 2, h.t * 10));
          const r = rim(h, phi, w);
          log.surface(r.t, r.th, k, q, d);
          const c = g * (0.4 + 0.6 * lightOf(d));
          if (j > 0) seg(p, q, prev, c);
          p.copy(q);
          prev = c;
        }
      }
    }
    // 껍질의 두께를 가로지르는 결
    for (let i = 0; i < steps * 1.5; i++) {
      const phi = rand() * TAU;
      const r = rim(h, phi, rr(0.84, 0.9));
      log.surface(r.t, r.th, INNER, p);
      log.surface(r.t, r.th, 1, q, d);
      seg(p, q, 0.05, rr(0.15, 0.4) * lightOf(d));
    }
  }
}

// 떨어져 나간 앞면의 가장자리: 바깥·안쪽 결과 껍질 두께
function addSideEdges() {
  const p = new V(), q = new V(), d = new V();
  const steps = Math.round(log.length / 0.05);
  const edgeTh = (t, sign, w) => {
    const e = log.sideEdge(t * log.length);
    return e.center + sign * e.half * w;
  };
  for (const sign of [-1, 1]) {
    for (const [k, loops, gain] of [[1, 5, [0.25, 0.6]], [INNER, 3, [0.12, 0.3]]]) {
      for (let loop = 0; loop < loops; loop++) {
        const w = rr(0.9, 0.95);
        const g = rr(gain[0], gain[1]);
        let prev = -1;
        for (let j = 0; j <= steps; j++) {
          const t = j / steps;
          const th = edgeTh(t, sign, w + 0.02 * noise3(t * 40, loop, sign));
          if (t < log.tStart(th) || t > log.tEnd(th)) { prev = -1; continue; }
          log.surface(t, th, k, q, d);
          const c = g * (0.35 + 0.65 * lightOf(d));
          if (prev >= 0) seg(p, q, prev, c);
          p.copy(q);
          prev = c;
        }
      }
    }
    for (let i = 0; i < steps * 2; i++) {
      const t = rr(0, 1);
      const th = edgeTh(t, sign, rr(0.9, 0.95));
      if (t < log.tStart(th) || t > log.tEnd(th)) continue;
      log.surface(t, th, INNER, p);
      log.surface(t, th, 1, q, d);
      seg(p, q, 0.06, rr(0.15, 0.45) * lightOf(d));
    }
  }
}

// 찢긴 양 끝: 속이 빈 껍질의 단면 (고리 모양의 두께)
function addEnds() {
  const p = new V(), q = new V(), d = new V();
  for (const end of ['start', 'end']) {
    const at = (th) => (end === 'start' ? log.tStart(th) : log.tEnd(th));
    for (let i = 0; i < 700; i++) {
      const th = rand() * TAU;
      log.surface(at(th), th, INNER, p);
      if (log.hole > OPEN) continue;
      log.surface(at(th) + rr(-0.002, 0.002), th + rr(-0.03, 0.03), 1, q, d);
      seg(p, q, rr(0.04, 0.12), rr(0.15, 0.5) * lightOf(d));
    }
    for (const k of [INNER, (INNER + 1) / 2, 1]) {
      const g = k === 1 ? 0.4 : 0.26;
      for (let j = 0; j < 160; j++) {
        const th0 = (j / 160) * TAU, th1 = ((j + 1) / 160) * TAU;
        log.surface(at(th0), th0, k, p, d);
        if (log.hole > OPEN) continue;
        log.surface(at(th1), th1, k, q);
        if (log.hole > OPEN) continue;
        const c = g * (0.4 + 0.6 * lightOf(d));
        seg(p, q, c, c);
      }
    }
  }
}

// 죽은 나무에 핀 균사 같은 실
function walk(p, dir, steps, g, depth, stepMin, stepMax, jitter, sag) {
  const q = new V();
  for (let j = 0; j < steps; j++) {
    dir.x += rr(-jitter, jitter);
    dir.y += rr(-jitter, jitter) - sag;
    dir.z += rr(-jitter, jitter);
    dir.normalize();
    q.copy(p).addScaledVector(dir, rr(stepMin, stepMax));
    seg(p, q, g * (1 - j / steps), g * (1 - (j + 1) / steps));
    p.copy(q);
    if (depth < 2 && rand() < 0.07) {
      walk(p.clone(), dir.clone(), Math.round(steps * 0.5), g * 0.7, depth + 1, stepMin, stepMax, jitter, sag);
    }
  }
}
function addWeb(count) {
  const p = new V(), d = new V();
  for (let i = 0; i < count; i++) {
    const th = rand() * TAU;
    log.surface(rr(log.tStart(th), log.tEnd(th)), th, 1, p, d);
    if (log.hole > 0.3) continue;
    d.add(new V(rr(-0.6, 0.6), rr(-0.6, 0.6), rr(-0.6, 0.6))).normalize();
    walk(p.clone(), d.clone(), Math.round(rr(6, 30)), rr(0.04, 0.14) * lightOf(d) * 1.6, 0, 0.04, 0.1, 0.35, 0.04);
  }
}

function addThreads(count) {
  const p = new V(), q = new V(), d = new V();
  for (let i = 0; i < count; i++) {
    log.surface(rr(0.1, 0.9), rand() * TAU, 1, p, d);
    if (d.y > -0.3 || log.hole > OPEN) continue;
    const len = rr(0.6, 3.5);
    const steps = Math.round(len / 0.12);
    const g = rr(0.03, 0.1);
    for (let j = 0; j < steps; j++) {
      q.copy(p);
      q.y -= len / steps;
      q.x += Math.sin(j * 0.3 + i) * 0.01;
      seg(p, q, g * (1 - j / steps), g * (1 - (j + 1) / steps));
      p.copy(q);
    }
  }
}

// 빛을 막는 검은 껍질 (바깥 결과 안쪽 결 사이). 썩어 나간 자리는 뚫려 있어 속이 보인다.
function shellMesh() {
  const R = 72, N = 260;
  const pos = [], idx = [];
  const p = new V();
  const open = [];
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= R; j++) {
      const th = (j / R) * TAU;
      const t = THREE.MathUtils.lerp(log.tStart(th) + 0.003, log.tEnd(th) - 0.003, i / N);
      log.surface(t, th, (INNER + 1) / 2, p);
      pos.push(p.x, p.y, p.z);
      open.push(log.hole > OPEN);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < R; j++) {
      const a = i * (R + 1) + j, b = a + R + 1;
      if (open[a] || open[b] || open[a + 1] || open[b + 1]) continue;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }));
}

addFibers(4600);
addFibers(3400, true);
addOpenings();
addSideEdges();
addEnds();
addWeb(220);
addThreads(25);

{
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(lineCol, 3));
  scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })));

  const dustPos = [], dustCol = [];
  const p = new V(), d = new V();
  for (let i = 0; i < 9000; i++) {
    const th = rand() * TAU;
    log.surface(rr(log.tStart(th), log.tEnd(th)), th, 1 + rr(0, 0.03), p, d);
    if (log.hole > OPEN) continue;
    const c = rr(0.08, 0.5) * lightOf(d) * (1 - 0.8 * log.crack);
    dustPos.push(p.x, p.y, p.z);
    dustCol.push(c, c, c);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('color', new THREE.Float32BufferAttribute(dustCol, 3));
  scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 0.025, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })));

  scene.add(shellMesh());
}

// 공기 중에 떠다니는 먼지
const motes = (() => {
  const pos = [];
  for (let i = 0; i < 700; i++) pos.push(rr(-16, 16), rr(-8, 9), rr(-12, 10));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.035, color: 0x777777, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  scene.add(pts);
  return pts;
})();

// 껍질 윗면 위의 한 점을 고른다 (나비가 앉을 자리)
function topSpot(out, dirOut, k = 1, tMin = 0.08, tMax = 0.9) {
  for (let tries = 0; tries < 30; tries++) {
    const t = rr(tMin, tMax);
    const th = Math.PI / 2 + rr(-0.75, 0.75);
    log.surface(t, th, k, out, dirOut);
    if (log.hole < 0.02 && log.crack < 0.4 && dirOut.y > 0.4) return out;
  }
  return out;
}

// ---------------------------------------------------------------- 텍스처

function wingPaths() {
  // 캔버스 왼쪽 = 몸통(경첩), 위쪽 = 머리 방향
  const fore = new Path2D();
  fore.moveTo(4, 128);
  fore.bezierCurveTo(30, 40, 120, 8, 236, 22);
  fore.bezierCurveTo(252, 60, 212, 110, 150, 128);
  fore.bezierCurveTo(100, 140, 40, 138, 4, 134);
  fore.closePath();
  const hind = new Path2D();
  hind.moveTo(4, 132);
  hind.bezierCurveTo(70, 130, 172, 140, 178, 178);
  hind.bezierCurveTo(184, 224, 120, 252, 70, 244);
  hind.bezierCurveTo(30, 238, 8, 200, 4, 150);
  hind.closePath();
  const both = new Path2D();
  both.addPath(fore);
  both.addPath(hind);
  return { fore, hind, both };
}

function canvasTexture(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const wingTex = canvasTexture((g) => {
  const { fore, hind, both } = wingPaths();
  const grad = g.createRadialGradient(10, 130, 0, 10, 130, 250);
  grad.addColorStop(0, '#ffe3a0');
  grad.addColorStop(0.4, '#ffa23a');
  grad.addColorStop(0.8, '#f0600f');
  grad.addColorStop(1, '#8a2a00');
  g.fillStyle = grad;
  g.fill(both);
  g.save();
  g.clip(both);
  g.strokeStyle = 'rgba(25, 8, 0, 0.85)';
  g.lineWidth = 4;
  for (const [x, y] of [[230, 24], [200, 70], [160, 112], [120, 128], [176, 170], [140, 232], [80, 240], [30, 220]]) {
    g.beginPath();
    g.moveTo(6, 132);
    g.quadraticCurveTo((x + 6) / 2, (y + 132) / 2 + (y < 132 ? 14 : -10), x, y);
    g.stroke();
  }
  g.lineWidth = 16;
  g.strokeStyle = '#120600';
  g.stroke(fore);
  g.stroke(hind);
  g.fillStyle = 'rgba(255, 248, 230, 0.95)';
  for (const [x, y, r] of [[222, 32, 4], [234, 50, 3.5], [206, 22, 3.5], [188, 18, 3], [226, 72, 3], [212, 94, 3],
    [160, 222, 3.5], [132, 238, 3.5], [104, 242, 3], [170, 196, 3]]) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  g.restore();
});

// 빛으로 변한 날개
// 선으로 그린 날개: 윤곽, 날개맥, 데이터 격자 같은 점
const lineWingTex = canvasTexture((g) => {
  const { fore, hind, both } = wingPaths();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fill(both);

  g.save();
  g.clip(both);
  g.fillStyle = 'rgba(255,255,255,0.6)';
  for (let y = 5; y < 256; y += 8) {
    for (let x = 5; x < 256; x += 8) {
      if (g.isPointInPath(both, x, y) && hash3(x, y, 5) < 0.45) g.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
    }
  }
  // 몸통에서 퍼지는 날개맥
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 1.6;
  for (const [x, y] of [[230, 24], [200, 70], [160, 112], [120, 128], [176, 170], [140, 232], [80, 240], [30, 220]]) {
    g.beginPath();
    g.moveTo(6, 132);
    g.quadraticCurveTo((x + 6) / 2, (y + 132) / 2 + (y < 132 ? 14 : -10), x, y);
    g.stroke();
  }
  // 날개맥을 가로지르는 가는 선
  g.strokeStyle = 'rgba(255,255,255,0.3)';
  g.lineWidth = 1;
  for (const r of [55, 100, 150, 200]) {
    g.beginPath();
    g.arc(6, 132, r, -Math.PI / 2, Math.PI / 2);
    g.stroke();
  }
  g.restore();

  // 빛나는 윤곽
  g.shadowColor = '#fff';
  g.shadowBlur = 6;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 2.4;
  g.stroke(fore);
  g.stroke(hind);
  g.shadowBlur = 0;
  g.fillStyle = '#fff';
  for (const [x, y, r] of [[222, 32, 3], [234, 50, 2.5], [206, 22, 2.5], [226, 72, 2.5], [160, 222, 2.5], [132, 238, 2.5], [170, 196, 2.5]]) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
});

const lightWingTex = canvasTexture((g) => {
  const { both } = wingPaths();
  g.shadowColor = '#fff';
  g.shadowBlur = 18;
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fill(both);
  g.shadowBlur = 0;
  g.save();
  g.clip(both);
  const grad = g.createRadialGradient(10, 130, 0, 10, 130, 240);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0.5)');
  g.fillStyle = grad;
  g.fill(both);
  g.restore();
});

const glowTex = canvasTexture((g, n) => {
  const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.12, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.06)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
}, 128);

// ---------------------------------------------------------------- 꽃 (글이 하나 올 때마다 껍질 위에 한 송이씩 피어난다)

const petalTex = canvasTexture((g, n) => {
  // 아래쪽 가운데가 꽃잎이 붙는 곳
  const path = new Path2D();
  path.moveTo(n / 2, n);
  path.bezierCurveTo(n * 0.05, n * 0.7, n * 0.12, n * 0.1, n / 2, n * 0.04);
  path.bezierCurveTo(n * 0.88, n * 0.1, n * 0.95, n * 0.7, n / 2, n);
  const grad = g.createLinearGradient(0, n, 0, 0);
  grad.addColorStop(0, 'rgba(120,120,120,1)');
  grad.addColorStop(0.5, 'rgba(225,225,225,1)');
  grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad;
  g.fill(path);
  g.save();
  g.clip(path);
  g.strokeStyle = 'rgba(90,90,90,0.5)';
  g.lineWidth = 1.5;
  for (let i = -3; i <= 3; i++) {
    g.beginPath();
    g.moveTo(n / 2, n);
    g.quadraticCurveTo(n / 2 + i * 10, n * 0.5, n / 2 + i * 16, n * 0.08);
    g.stroke();
  }
  g.restore();
}, 128);

const petalGeo = new THREE.PlaneGeometry(0.5, 1);
petalGeo.translate(0, 0.5, 0);
const petalMat = new THREE.MeshBasicMaterial({
  map: petalTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.02,
});

const MAX_FLOWERS = 1200;
const flowers = new Map(); // 글 번호 → 꽃

class Flower {
  constructor(id, grown) {
    // 글 번호로 자리를 정해 새로고침해도 같은 곳에 핀다
    const r = mulberry32(id * 7919 + 13);
    const R = (a, b) => a + (b - a) * r();
    const pos = new V(), dir = new V();
    for (let tries = 0; tries < 50; tries++) {
      log.surface(R(0.06, 0.94), Math.PI / 2 + R(-1.1, 1.3), 1, pos, dir);
      if (log.hole < 0.02 && log.crack < 0.5 && dir.y > 0.25) break;
    }
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    this.group.quaternion.setFromUnitVectors(UP, dir);
    this.inner = new THREE.Group();
    this.inner.rotation.y = R(0, TAU);
    this.group.add(this.inner);
    this.anchor = pos.clone().addScaledVector(dir, 0.1); // 나비와 이어지는 점

    this.size = R(0.17, 0.27);
    this.petals = [];
    const count = r() < 0.5 ? 5 : 6;
    for (let i = 0; i < count; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.y = (i / count) * TAU;
      const tilt = new THREE.Group();
      tilt.add(new THREE.Mesh(petalGeo, petalMat));
      pivot.add(tilt);
      this.inner.add(pivot);
      this.petals.push(tilt);
    }
    this.heart = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.heart.position.y = 0.15;
    this.inner.add(this.heart);

    this.age = grown ? 60 : 0;
    this.openAt = R(0.9, 1.35); // 꽃잎이 벌어지는 정도
    this.seed = R(0, 100);
    this.glow = 0;
    this.glowWant = 0;
    scene.add(this.group);
  }
  update(dt, time) {
    this.age += dt;
    const grow = smooth(0, 6, this.age);
    const open = smooth(1.5, 6, this.age);
    this.glow += (this.glowWant - this.glow) * (1 - Math.exp(-dt * 4));
    this.glowWant = 0;
    this.group.scale.setScalar(this.size * (0.05 + 0.95 * grow));
    const sway = Math.sin(time * 0.8 + this.seed) * 0.05;
    for (const p of this.petals) p.rotation.x = 0.12 + open * this.openAt + sway;
    this.heart.material.opacity = Math.min(1, 0.45 * open + 0.8 * this.glow);
    this.heart.scale.setScalar(0.9 + 0.1 * Math.sin(time * 1.5 + this.seed) + 2.5 * this.glow);
  }
}

function flowerFor(id, grown) {
  if (!flowers.has(id) && flowers.size < MAX_FLOWERS) flowers.set(id, new Flower(id, grown));
  return flowers.get(id) || null;
}

function updateFlowers(dt, time) {
  for (const f of flowers.values()) f.update(dt, time);
}

// ---------------------------------------------------------------- 나비와 꽃을 잇는 빛의 선

const LINK_SEGS = 20;
const linkPos = new Float32Array(MAX_BUTTERFLIES * LINK_SEGS * 6);
const linkCol = new Float32Array(MAX_BUTTERFLIES * LINK_SEGS * 6);
const linkGeo = new THREE.BufferGeometry();
linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3).setUsage(THREE.DynamicDrawUsage));
linkGeo.setAttribute('color', new THREE.BufferAttribute(linkCol, 3).setUsage(THREE.DynamicDrawUsage));
const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
links.frustumCulled = false;
scene.add(links);

const _ctrl = new V();
function linkPoint(a, ctrl, b, u, out) {
  const v = 1 - u;
  return out.set(
    v * v * a.x + 2 * v * u * ctrl.x + u * u * b.x,
    v * v * a.y + 2 * v * u * ctrl.y + u * u * b.y,
    v * v * a.z + 2 * v * u * ctrl.z + u * u * b.z,
  );
}

function updateLinks(time) {
  const p0 = new V(), p1 = new V();
  let o = 0;
  for (const b of butterflies) {
    if (!b.flower || b.linkGrow <= 0) continue;
    const a = b.flower.anchor;
    const dist = a.distanceTo(b.pos);
    _ctrl.copy(a).add(b.pos).multiplyScalar(0.5);
    _ctrl.y += 0.25 * dist + 0.2;
    const lit = b.light();
    const base = 0.06 + 0.45 * lit;
    // 꽃에서 나비 쪽으로 흘러가는 빛 한 점
    const pulse = ((time * 0.22 + b.seed) % 1.6) - 0.1;
    const draw = b.linkGrow;
    const bright = (u) => (base + (0.5 + lit) * Math.exp(-(((u - pulse) / 0.05) ** 2))) * Math.min(1, u * 8);
    for (let s = 0; s < LINK_SEGS; s++) {
      const u0 = (s / LINK_SEGS) * draw, u1 = ((s + 1) / LINK_SEGS) * draw;
      linkPoint(a, _ctrl, b.pos, u0, p0);
      linkPoint(a, _ctrl, b.pos, u1, p1);
      linkPos[o] = p0.x; linkPos[o + 1] = p0.y; linkPos[o + 2] = p0.z;
      linkPos[o + 3] = p1.x; linkPos[o + 4] = p1.y; linkPos[o + 5] = p1.z;
      const c0 = bright(u0), c1 = bright(u1);
      linkCol[o] = c0 * 0.9; linkCol[o + 1] = c0; linkCol[o + 2] = c0 * 0.92;
      linkCol[o + 3] = c1 * 0.9; linkCol[o + 4] = c1; linkCol[o + 5] = c1 * 0.92;
      o += 6;
    }
  }
  linkGeo.setDrawRange(0, o / 3);
  linkGeo.attributes.position.needsUpdate = true;
  linkGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- 비 (선으로 그린 데이터 비)

const rain = (() => {
  const COUNT = 1400;
  const SPLASHES = 260;
  const RAYS = 7;
  const area = { x: 14, z: 9, top: 11, bottom: -7 };
  const wind = new V(-0.9, 0, 0.25);

  const drops = [];
  for (let i = 0; i < COUNT; i++) drops.push({ p: new V(), speed: 0, len: 0, g: 0, on: false });

  // 빗줄기: 머리는 밝고 꼬리는 어둠으로 사라지는 선
  const dropPos = new Float32Array(COUNT * 6);
  const dropCol = new Float32Array(COUNT * 6);
  const dropGeo = new THREE.BufferGeometry();
  dropGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3));
  dropGeo.setAttribute('color', new THREE.BufferAttribute(dropCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lines = new THREE.LineSegments(dropGeo, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  // 부딪힌 자리에서 실처럼 튀는 물방울
  const splashes = [];
  for (let i = 0; i < SPLASHES; i++) splashes.push({ p: new V(), age: 9, dirs: [], g: 0 });
  const spPos = new Float32Array(SPLASHES * RAYS * 6);
  const spCol = new Float32Array(SPLASHES * RAYS * 6);
  const spGeo = new THREE.BufferGeometry();
  spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3));
  spGeo.setAttribute('color', new THREE.BufferAttribute(spCol, 3));
  const spLines = new THREE.LineSegments(spGeo, lineMat);
  spLines.frustumCulled = false;
  scene.add(spLines);
  let nextSplash = 0;
  const SPLASH_LIFE = 0.45;

  function splash(at, onLog) {
    const s = splashes[nextSplash];
    nextSplash = (nextSplash + 1) % SPLASHES;
    s.p.copy(at);
    s.age = 0;
    s.g = onLog ? rr(0.3, 0.65) : rr(0.1, 0.3);
    s.dirs = [];
    for (let i = 0; i < RAYS; i++) {
      const d = new V(rr(-1, 1), rr(0.4, 1.4), rr(-1, 1));
      s.dirs.push(d.normalize().multiplyScalar(rr(0.15, 0.45)));
    }
  }

  // 통나무 윗면 높이를 x마다 미리 재어 둔다 (빗방울이 부딪히는 곳)
  const hits = [];
  {
    const p = new V(), q = new V();
    for (let i = 0; i <= 240; i++) {
      const t = i / 240;
      const c = log.curve.getPointAt(t);
      log.surface(t, Math.PI / 2, 1, p);
      log.surface(t, 0, 1, q);
      hits.push({ x: c.x, z: c.z, y: c.y, top: p.y, half: Math.max(0.1, q.distanceTo(c)) });
    }
  }
  function logTop(x, z) {
    if (x < hits[0].x || x > hits[hits.length - 1].x) return null;
    let lo = 0, hi = hits.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hits[mid].x < x) lo = mid; else hi = mid;
    }
    const h = hits[lo];
    const dz = (z - h.z) / h.half;
    if (Math.abs(dz) > 1) return null;
    return h.y + (h.top - h.y) * Math.sqrt(1 - dz * dz);
  }

  function respawn(d) {
    d.p.set(rr(-area.x, area.x), rr(area.top, area.top + 10), rr(-area.z, area.z));
    d.speed = rr(10, 16);
    d.len = rr(0.4, 1.3);
    d.g = rand() < 0.08 ? rr(0.45, 0.8) : rr(0.08, 0.3);
  }

  let left = 0;
  let level = 0;

  return {
    level: () => level,
    start(seconds = RAIN_SECONDS) {
      left = Math.max(left, seconds);
    },
    update(dt) {
      left = Math.max(0, left - dt);
      // 천천히 굵어지고, 끝나기 4초 전부터 잦아든다
      const want = left > 0 ? Math.min(1, left / 4) : 0;
      level += (want - level) * (1 - Math.exp(-dt * (want > level ? 0.8 : 1.5)));
      const active = Math.round(COUNT * level);

      for (let i = 0; i < COUNT; i++) {
        const d = drops[i];
        const o = i * 6;
        if (!d.on && i < active) { d.on = true; respawn(d); }
        if (!d.on) { dropCol.fill(0, o, o + 6); continue; }

        d.p.x += wind.x * dt;
        d.p.z += wind.z * dt;
        d.p.y -= d.speed * dt;
        const top = logTop(d.p.x, d.p.z);
        const hitLog = top !== null && d.p.y < top && d.p.y > top - 0.8;
        if (hitLog || d.p.y < area.bottom) {
          if (hitLog || rand() < 0.15) splash(d.p, hitLog);
          if (i < active) respawn(d);
          else { d.on = false; dropCol.fill(0, o, o + 6); continue; }
        }
        dropPos[o] = d.p.x; dropPos[o + 1] = d.p.y; dropPos[o + 2] = d.p.z;
        dropPos[o + 3] = d.p.x - (wind.x / d.speed) * d.len;
        dropPos[o + 4] = d.p.y + d.len;
        dropPos[o + 5] = d.p.z - (wind.z / d.speed) * d.len;
        const g = d.g * Math.min(1, level * 1.5);
        dropCol[o] = dropCol[o + 1] = dropCol[o + 2] = g;
        dropCol[o + 3] = dropCol[o + 4] = dropCol[o + 5] = 0;
      }
      dropGeo.attributes.position.needsUpdate = true;
      dropGeo.attributes.color.needsUpdate = true;

      let anySplash = false;
      for (let i = 0; i < SPLASHES; i++) {
        const s = splashes[i];
        s.age += dt;
        for (let r = 0; r < RAYS; r++) {
          const o = (i * RAYS + r) * 6;
          if (s.age > SPLASH_LIFE) { spCol.fill(0, o, o + 6); continue; }
          anySplash = true;
          const k = s.age / SPLASH_LIFE;
          const d = s.dirs[r];
          const reach = Math.sqrt(k);
          const sag = 0.6 * k * k;
          spPos[o] = s.p.x + d.x * reach * 0.55;
          spPos[o + 1] = s.p.y + d.y * reach * 0.55 - sag * 0.5;
          spPos[o + 2] = s.p.z + d.z * reach * 0.55;
          spPos[o + 3] = s.p.x + d.x * reach;
          spPos[o + 4] = s.p.y + d.y * reach - sag;
          spPos[o + 5] = s.p.z + d.z * reach;
          const g = s.g * (1 - k);
          spCol[o] = spCol[o + 1] = spCol[o + 2] = g * 0.3;
          spCol[o + 3] = spCol[o + 4] = spCol[o + 5] = g;
        }
      }
      spGeo.attributes.position.needsUpdate = true;
      spGeo.attributes.color.needsUpdate = true;
      lines.visible = active > 0 || drops.some((d) => d.on);
      spLines.visible = anySplash;
    },
  };
})();

// ---------------------------------------------------------------- 빗소리

const soundEl = document.getElementById('sound');
const rainSound = (() => {
  const audio = new Audio('rain.mp3');
  audio.loop = true;
  audio.preload = 'auto';
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  ctx.createMediaElementSource(audio).connect(gain).connect(ctx.destination);

  // 브라우저는 화면을 한 번 눌러야 소리를 낼 수 있다 (전시용 키오스크 설정이면 바로 켜진다)
  const show = () => {
    const on = ctx.state === 'running';
    soundEl.classList.toggle('on', on);
    soundEl.textContent = on ? '빗소리 켜짐' : '화면을 눌러 빗소리 켜기';
  };
  const unlock = () => ctx.resume().then(show).catch(() => {});
  ctx.onstatechange = show;
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);
  show();

  return {
    update(level) {
      if (ctx.state !== 'running') return;
      gain.gain.setTargetAtTime(Math.min(1, level * 1.1), ctx.currentTime, 0.25);
      if (level > 0.005 && audio.paused) audio.play().catch(() => {});
      else if (level <= 0.002 && !audio.paused) audio.pause();
    },
  };
})();

// ---------------------------------------------------------------- 나비

const wingMat = BUTTERFLY_STYLE === 'lines'
  ? new THREE.MeshBasicMaterial({
    map: lineWingTex, color: new THREE.Color(1.9, 1.05, 0.5), transparent: true,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  : new THREE.MeshBasicMaterial({
    map: wingTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.05,
  });
const lightWingMat = new THREE.MeshBasicMaterial({
  map: lightWingTex, color: new THREE.Color(2.4, 2.3, 2.1), transparent: true, opacity: 0,
  side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
});
const wingGeo = new THREE.PlaneGeometry(1, 1);
wingGeo.translate(0.5, 0, 0);
wingGeo.rotateX(Math.PI / 2); // 날개는 xz 평면, +z가 머리
const bodyGeo = new THREE.CapsuleGeometry(BUTTERFLY_STYLE === 'lines' ? 0.014 : 0.035, 0.5, 4, 8);
bodyGeo.rotateX(Math.PI / 2);
const bodyMat = new THREE.MeshBasicMaterial({ color: BUTTERFLY_STYLE === 'lines' ? 0x9a6a44 : 0x1a1008 });
const hitGeo = new THREE.SphereGeometry(isTouch ? 2.6 : 1.8, 8, 6);
const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

const butterflies = [];
const byId = new Map();
const hitMeshes = [];
let hovered = null;

const WORLD_UP = new V(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new V(), _w = new V(), _d = new V();

function randomOffset(min, max) {
  const v = new V(rr(-1, 1), rr(-1, 1), rr(-1, 1));
  if (v.lengthSq() < 1e-4) v.set(0, 1, 0);
  return v.normalize().multiplyScalar(rr(min, max));
}

function makeWing(mat, mirror) {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(wingGeo, mat);
  if (mirror) mesh.scale.x = -1;
  pivot.add(mesh);
  return { pivot, mesh };
}

class Butterfly {
  constructor(entry) {
    this.entry = entry;
    this.group = new THREE.Group();
    this.size = rr(0.32, 0.46);
    this.group.scale.setScalar(this.size);

    this.right = makeWing(wingMat, false).pivot;
    this.left = makeWing(wingMat, true).pivot;
    this.group.add(this.right, this.left, new THREE.Mesh(bodyGeo, bodyMat));
    this.lightMat = null; // 빛이 될 때 처음 만든다

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.glow.scale.setScalar(4);
    this.group.add(this.glow);

    this.hit = new THREE.Mesh(hitGeo, hitMat);
    this.hit.userData.butterfly = this;
    this.group.add(this.hit);

    this.pos = this.group.position;
    this.vel = new V();
    this.target = new V();
    this.restQ = new THREE.Quaternion();
    this.phase = rand() * TAU;
    this.seed = rand() * 100;
    this.speed = rr(0.9, 1.5);
    this.flapRate = rr(6, 9);
    this.state = 'fly';
    this.landing = false;
    this.timer = 0;
    this.highlight = 0;
    this.grow = 1;
    this.litAge = 0;
    this.litLeft = 0;
    this.flower = null; // 이 나비와 함께 핀 꽃
    this.linkGrow = 1; // 꽃에서 나비까지 빛의 선이 그려진 정도

    scene.add(this.group);
    hitMeshes.push(this.hit);
  }

  dispose() {
    scene.remove(this.group);
    this.glow.material.dispose();
    if (this.lightMat) this.lightMat.dispose();
    hitMeshes.splice(hitMeshes.indexOf(this.hit), 1);
  }

  // 나비 자체가 빛으로 변한다
  lightUp(seconds, hold) {
    if (!this.lightMat) {
      this.lightMat = lightWingMat.clone();
      this.right.add(makeWing(this.lightMat, false).mesh);
      this.left.add(makeWing(this.lightMat, true).mesh);
    }
    this.litAge = this.litLeft > 0 ? Math.min(this.litAge, 1.2) : (hold ? 0 : 1.2);
    this.litLeft = seconds;
    if (hold) {
      this.state = 'held';
      this.vel.multiplyScalar(0.3);
    }
  }
  light() {
    if (this.litLeft <= 0) return 0;
    return Math.min(1, this.litAge / 1.2) * Math.min(1, this.litLeft / 2.5);
  }

  pickTarget(allowLanding = true) {
    if (allowLanding && rand() < 0.35) {
      // 통나무 윗면에 내려앉을 자리
      topSpot(this.target, _d, 1.04);
      this.landing = true;
      const up = _d.clone();
      const fwd = new V(rr(-1, 1), 0, rr(-1, 1)).normalize();
      fwd.addScaledVector(up, -fwd.dot(up)).normalize();
      _m.lookAt(_w.copy(this.target).add(fwd), this.target, up);
      this.restQ.setFromRotationMatrix(_m);
    } else {
      log.curve.getPointAt(rand(), this.target);
      this.target.add(randomOffset(1.9, 4));
      this.target.y += 0.9;
      this.landing = false;
    }
  }

  // 처음 불러올 때: 통나무에 앉아 있거나 근처를 날고 있게
  scatter() {
    if (rand() < 0.55) this.pickTarget(true);
    if (this.landing) {
      this.pos.copy(this.target);
      this.group.quaternion.copy(this.restQ);
      this.state = 'rest';
      this.timer = rr(0, 16);
    } else {
      log.curve.getPointAt(rand(), this.pos);
      this.pos.add(randomOffset(1.9, 4));
      this.vel.copy(randomOffset(0.5, 1));
      this.pickTarget(false);
    }
  }

  // 빛 속에서 막 태어났을 때
  hatch(at) {
    this.pos.copy(at);
    this.vel.set(rr(-0.3, 0.3), 0.5, rr(-0.3, 0.3));
    this.state = 'fly';
    this.pickTarget(false);
    this.grow = 0;
    this.linkGrow = 0;
    this.lightUp(4, false);
  }

  release() {
    this.state = 'fly';
    this.vel.set(rr(-0.4, 0.4), 1, rr(-0.4, 0.4));
    this.pickTarget(false);
  }

  update(dt, time) {
    let flap;
    let wantQ = null;

    if (this.litLeft > 0) {
      this.litAge += dt;
      this.litLeft -= dt;
      if (this.litLeft <= 0 && this.state === 'held') this.release();
    }

    if (this.state === 'held') {
      // 빛나는 동안 제자리에서 천천히 떠 있는다
      this.vel.multiplyScalar(Math.exp(-dt * 3));
      this.pos.addScaledVector(this.vel, dt);
      this.pos.y += Math.sin(time * 1.6 + this.seed) * 0.003;
      flap = 0.35 + 0.55 * Math.sin(time * 3 + this.seed);
    } else if (this.state === 'rest') {
      this.timer -= dt;
      flap = 0.12 + 0.5 * (0.5 + 0.5 * Math.sin(time * 1.3 + this.seed)) ** 3;
      wantQ = this.restQ;
      if (this.timer <= 0) this.release();
    } else {
      const to = _v.copy(this.target).sub(this.pos);
      const dist = to.length();
      const near = this.landing ? Math.min(1, dist / 1.5) : 1;
      const desired = to.normalize().multiplyScalar(this.speed * near + 0.12);
      const wander = 0.9 * near;
      desired.x += noise3(time * 0.6, this.seed, 0) * wander;
      desired.y += noise3(this.seed, time * 0.6, 5) * wander;
      desired.z += noise3(7, this.seed, time * 0.6) * wander;
      this.vel.lerp(desired, 1 - Math.exp(-dt * 2.2));
      this.pos.addScaledVector(this.vel, dt);
      this.phase += dt * TAU * this.flapRate;
      flap = 0.35 + 0.95 * Math.sin(this.phase);

      if (this.vel.lengthSq() > 1e-4) {
        _m.lookAt(_w.copy(this.pos).add(this.vel), this.pos, WORLD_UP);
        wantQ = _q.setFromRotationMatrix(_m);
      }
      if (this.landing && dist < 0.08) {
        this.pos.copy(this.target);
        this.state = 'rest';
        this.timer = rr(5, 18);
      } else if (!this.landing && dist < 0.6) {
        this.pickTarget(true);
      } else if (this.pos.lengthSq() > 900) {
        this.pickTarget(false);
      }
    }

    if (wantQ) this.group.quaternion.slerp(wantQ, 1 - Math.exp(-dt * 6));
    // 막 태어난 나비는 접힌 날개를 펼치며 자란다
    this.grow = Math.min(1, this.grow + dt / 1.4);
    const unfold = 1 - (1 - this.grow) ** 3;
    this.right.rotation.z = THREE.MathUtils.lerp(1.45, flap, unfold);
    this.left.rotation.z = -this.right.rotation.z;

    const lit = this.light();
    const want = this === hovered ? 1 : 0;
    this.highlight += (want - this.highlight) * (1 - Math.exp(-dt * 5));
    if (this.lightMat) this.lightMat.opacity = lit;
    this.linkGrow = Math.min(1, this.linkGrow + dt / 1.8);
    if (this.flower) this.flower.glowWant = Math.max(this.flower.glowWant, lit);
    this.glow.material.opacity = Math.max(this.highlight * 0.4, lit * 0.95);
    this.glow.scale.setScalar(4 + lit * (2.5 + 0.6 * Math.sin(time * 2.4 + this.seed)));
    this.group.scale.setScalar(this.size * (0.05 + 0.95 * unfold) * (1 + 0.25 * this.highlight + 0.15 * lit));
  }
}

function addEntry(entry, born) {
  if (byId.has(entry.id)) return;
  totalCount = Math.max(totalCount, entry.id);
  updateCount();
  if (born) {
    births.push(new Birth(entry));
    rain.start();
  } else {
    const b = spawnButterfly(entry);
    b.flower = flowerFor(entry.id, true);
    b.scatter();
  }
}

function spawnButterfly(entry) {
  const b = new Butterfly(entry);
  butterflies.push(b);
  byId.set(entry.id, b);
  while (butterflies.length > MAX_BUTTERFLIES) {
    const old = butterflies.find((x) => x !== cardFor && x.litLeft <= 0);
    if (!old) break;
    butterflies.splice(butterflies.indexOf(old), 1);
    old.dispose();
  }
  return b;
}

// ---------------------------------------------------------------- 빛 → 나비 (새 글이 들어왔을 때)

const births = [];
const BIRTH_GATHER = 2.6; // 빛이 모이는 시간

class Birth {
  constructor(entry) {
    this.entry = entry;
    byId.set(entry.id, null); // 같은 글이 두 번 태어나지 않도록 자리만 잡아 둔다
    this.age = 0;
    this.hatched = false;
    this.flashAge = 0;
    this.pos = log.curve.getPointAt(rr(0.2, 0.8)).add(new V(rr(-1.5, 1.5), rr(1.6, 2.8), rr(1, 2.4)));

    this.core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.core.position.copy(this.pos);
    scene.add(this.core);

    // 사방에서 빛 알갱이가 소용돌이치며 모여든다
    this.n = 70;
    this.from = [];
    for (let i = 0; i < this.n; i++) this.from.push(randomOffset(1.5, 4.5));
    this.positions = new Float32Array(this.n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.sparks = new THREE.Points(geo, new THREE.PointsMaterial({
      map: glowTex, size: 0.18, color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.sparks.frustumCulled = false;
    scene.add(this.sparks);
  }
  update(dt) {
    this.age += dt;
    const k = Math.min(1, this.age / BIRTH_GATHER);
    const r = (1 - k) ** 1.6;
    for (let i = 0; i < this.n; i++) {
      const f = this.from[i];
      const spin = ((1 - k) * 2.5 + i) * 0.6;
      const c = Math.cos(spin), s = Math.sin(spin);
      this.positions[i * 3] = this.pos.x + (f.x * c - f.z * s) * r;
      this.positions[i * 3 + 1] = this.pos.y + f.y * r;
      this.positions[i * 3 + 2] = this.pos.z + (f.x * s + f.z * c) * r;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;

    if (!this.hatched) {
      this.sparks.material.opacity = smooth(0, 0.6, this.age);
      this.core.material.opacity = k;
      this.core.scale.setScalar(0.4 + 3.2 * k * k);
      if (k >= 1) {
        this.hatched = true;
        const b = spawnButterfly(this.entry);
        b.flower = flowerFor(this.entry.id, false); // 나비와 함께 껍질 위에 꽃이 핀다
        b.hatch(this.pos);
        whisper(b);
      }
      return true;
    }
    // 빛이 터지며 나비가 나온다
    this.flashAge += dt;
    const f = this.flashAge / 1.1;
    this.core.scale.setScalar(3.6 + 5 * Math.sqrt(f));
    this.core.material.opacity = Math.max(0, 1 - f);
    this.sparks.material.opacity = Math.max(0, 1 - f * 2);
    return f < 1;
  }
  dispose() {
    scene.remove(this.core, this.sparks);
    this.core.material.dispose();
    this.sparks.material.dispose();
    this.sparks.geometry.dispose();
  }
}

// ---------------------------------------------------------------- 글 표시

const countEl = document.getElementById('count');
const liveEl = document.getElementById('live');
const hintEl = document.getElementById('hint');
const card = document.getElementById('card');
const cardText = card.querySelector('.text');
const cardMeta = card.querySelector('.meta');
const labels = document.getElementById('labels');
let totalCount = 0;
let cardFor = null;

function updateCount() {
  countEl.textContent = `${totalCount}마리의 나비`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function illuminate(b) {
  b.lightUp(GLOW_SECONDS, true);
  cardFor = b;
  cardText.textContent = b.entry.text;
  cardMeta.textContent = [`No. ${b.entry.id}`, formatDate(b.entry.createdAt)].filter(Boolean).join(' · ');
  card.classList.add('show');
  controls.autoRotate = false;
  hintEl.classList.add('gone');
}

function closeCard() {
  cardFor = null;
  card.classList.remove('show');
  controls.autoRotate = true;
}

const whispers = [];
function whisper(b) {
  const el = document.createElement('div');
  el.className = 'whisper';
  el.textContent = b.entry.text;
  labels.appendChild(el);
  whispers.push({ el, b });
  setTimeout(() => {
    el.remove();
    whispers.splice(whispers.findIndex((w) => w.el === el), 1);
  }, 7000);
}

function toScreen(pos) {
  _v.copy(pos).project(camera);
  return { x: (_v.x * 0.5 + 0.5) * innerWidth, y: (-_v.y * 0.5 + 0.5) * innerHeight, visible: _v.z < 1 };
}

function placeLabels() {
  if (cardFor && cardFor.litLeft <= 0) closeCard();
  if (cardFor) {
    const s = toScreen(cardFor.pos);
    const w = card.offsetWidth, h = card.offsetHeight;
    const x = THREE.MathUtils.clamp(s.x, w / 2 + 12, innerWidth - w / 2 - 12);
    const above = s.y - h - 34 > 12;
    const y = above ? s.y - h - 34 : s.y + 34;
    card.style.transform = `translate(${x - w / 2}px, ${y}px)`;
    card.style.visibility = s.visible ? 'visible' : 'hidden';
  }
  for (const { el, b } of whispers) {
    const s = toScreen(b.pos);
    el.style.transform = `translate(${s.x}px, ${s.y - 30}px) translate(-50%, -100%)`;
    el.style.visibility = s.visible ? 'visible' : 'hidden';
  }
}

// ---------------------------------------------------------------- 포인터

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(hitMeshes, false)[0];
  return hit ? hit.object.userData.butterfly : null;
}

let down = null;
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 8) return;
  const b = pick(e.clientX, e.clientY);
  if (b) illuminate(b);
  else closeCard();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || down) return;
  hovered = pick(e.clientX, e.clientY);
  canvas.style.cursor = hovered ? 'pointer' : '';
});
document.getElementById('close').addEventListener('click', closeCard);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });

// ---------------------------------------------------------------- 실시간 연동

let lastId = 0;
let loaded = false;
async function poll() {
  try {
    const res = await fetch(`/api/words?since=${lastId}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const { live, words } = await res.json();
    for (const entry of words) {
      addEntry(entry, loaded);
      lastId = Math.max(lastId, entry.id);
    }
    loaded = true;
    liveEl.classList.toggle('on', live);
    liveEl.textContent = live ? '실시간 연결됨' : '원래 사이트 연결 대기 중';
  } catch (err) {
    liveEl.classList.remove('on');
    liveEl.textContent = '서버 연결 대기 중';
  } finally {
    setTimeout(poll, 2000);
  }
}
poll();

// ---------------------------------------------------------------- 루프

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

setTimeout(() => hintEl.classList.add('gone'), 12000);

const clock = new THREE.Clock();
const focus = new V();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  for (const b of butterflies) b.update(dt, time);
  for (let i = births.length - 1; i >= 0; i--) {
    if (!births[i].update(dt)) {
      births[i].dispose();
      births.splice(i, 1);
    }
  }
  updateFlowers(dt, time);
  rainSound.update(rain.level());
  updateLinks(time);
  rain.update(dt);

  focus.copy(CENTER);
  if (cardFor) focus.lerp(cardFor.pos, 0.4);
  controls.target.lerp(focus, 1 - Math.exp(-dt * 1.5));
  controls.update();

  motes.rotation.y = time * 0.01;
  motes.position.y = Math.sin(time * 0.1) * 0.3;

  composer.render();
  placeLabels();
  requestAnimationFrame(frame);
}
frame();
