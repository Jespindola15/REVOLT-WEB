import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { parsePRM, parseW, parseFIN, parseTAZ, parseINF, parseCarParams, parsePAN, parseFAN, parseNCP, zoneContains, rv2three } from './rvformats.js';
import { loadTexture, makeMaterials, buildMeshes } from './build.js';
import { CarPhysics, MPH_PER_UNIT, carSpheresFromBox } from './physics.js';
import { Net } from './net.js';
import { GameAudio } from './audio.js';
import { TrackCollider, Spinner } from './world.js';
import { BotDriver, AiPath, DIFFICULTY, TUNE } from './ai.js';
import { Minimap } from './minimap.js';
import { CarEffects } from './effects.js';
import { Records, LapRecorder, ghostAt } from './ghost.js';
import { Weapons, WEAPONS } from './weapons.js';

THREE.ColorManagement.enabled = false;

const $ = id => document.getElementById(id);
// Los archivos del juego pueden estar en assets/ o directamente en la raíz del sitio
let BASE = 'assets/';
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

// ---------- Render ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 4, 32000);
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

// ---------- Carga ----------
async function fetchBuf(url) { const r = await fetch(url); if (!r.ok) throw new Error('No se encontró ' + url); return r.arrayBuffer(); }
async function fetchText(url) { const r = await fetch(url); if (!r.ok) throw new Error('No se encontró ' + url); return r.text(); }

let manifest, track = null, world = null;
const carDefs = new Map();    // id -> { def, params, body?, wheels?, box?, loading? }
const trackCache = new Map(); // id -> Promise<pista armada>

function trackDef(id) { return manifest.tracks.find(t => t.id === id) || manifest.tracks[0]; }
function carDef(id) { return manifest.cars.find(c => c.id === id); }

// Compatibilidad con el manifest viejo (una sola pista, texturas tex0.png...)
function normalizeManifest(m) {
  if (!m.tracks && m.track) m.tracks = [m.track];
  for (const t of m.tracks) {
    if (Array.isArray(t.pages)) { const o = {}; for (const p of t.pages) o[p] = 'tex' + p + '.png'; t.pages = o; }
  }
  for (const c of m.cars) { c.tex ??= 'car.png'; c.group ??= 'Autos'; }
  return m;
}

async function buildTrack(T) {
  const dir = BASE + 'tracks/' + T.id + '/';
  const [wBuf, finBuf, tazBuf, infTxt] = await Promise.all([
    fetchBuf(dir + T.id + '.w'), fetchBuf(dir + T.id + '.fin').catch(() => null),
    fetchBuf(dir + T.id + '.taz'), fetchText(dir + T.id + '.inf'),
  ]);
  const textures = [];
  await Promise.all(Object.entries(T.pages).map(async ([p, file]) => { textures[+p] = await loadTexture(dir + file); }));
  const getMat = makeMaterials(textures);
  const inf = parseINF(infTxt);
  const meshes = parseW(wBuf);
  // Instancias (.fin): casas, árboles, postes, rampas...
  const fins = finBuf ? parseFIN(finBuf) : [];
  const prmCache = new Map(), ncpCache = new Map();
  const extraColl = []; // choques de los objetos con su malla .ncp original
  const keys = Object.keys(T.instances || {});
  for (const f of fins) {
    const key = keys.find(k => k === f.name) || keys.find(k => f.name.startsWith(k) || k.startsWith(f.name));
    if (!key) continue;
    const def = T.instances[key];
    if (!prmCache.has(def.prm)) prmCache.set(def.prm, parsePRM(await fetchBuf(dir + def.prm)));
    const prm = prmCache.get(def.prm);
    const M = f.mat, P = f.pos;
    const xform = (x, y, z) => rv2three(
      P[0] + x * M[0] + y * M[3] + z * M[6],
      P[1] + x * M[1] + y * M[4] + z * M[7],
      P[2] + x * M[2] + y * M[5] + z * M[8]);
    let ncp = null;
    if (def.ncp) {
      if (!ncpCache.has(def.ncp)) ncpCache.set(def.ncp, await fetchBuf(dir + def.ncp).then(parseNCP).catch(() => null));
      ncp = ncpCache.get(def.ncp);
    }
    if (ncp && ncp.length) {
      for (let i = 0; i < ncp.length; i += 3) extraColl.push(...xform(ncp[i], ncp[i + 1], ncp[i + 2]));
      meshes.push({ polys: prm.polys, verts: prm.verts, solid: false, xform });
    } else meshes.push({ polys: prm.polys, verts: prm.verts, solid: def.solid, xform });
  }
  const built = buildMeshes(meshes, getMat, { brightness: 1.0 });
  const cg = new THREE.BufferGeometry();
  const allColl = new Float32Array(built.collision.length + extraColl.length);
  allColl.set(built.collision); allColl.set(extraColl, built.collision.length);
  cg.setAttribute('position', new THREE.BufferAttribute(allColl, 3));
  const bvh = new TrackCollider(new MeshBVH(cg));
  // objetos del .fob: bonus de armas (tipo 30) y objetos que giran (tipo 0, "barril": la ruleta del casino)
  const fob = [];
  try {
    const dv = new DataView(await fetchBuf(dir + T.id + '.fob'));
    const n = dv.getInt32(0, true);
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 56, f = k => dv.getFloat32(o + 20 + k * 4, true);
      fob.push({ id: dv.getInt32(o, true), flags: [1, 2, 3, 4].map(k => dv.getInt32(o + k * 4, true)),
        pos: [f(0), f(1), f(2)], up: [f(3), f(4), f(5)], look: [f(6), f(7), f(8)] });
    }
  } catch (e) {}
  const pickups = fob.filter(o => o.id === 30).map(o => new THREE.Vector3(...rv2three(...o.pos)));
  if (T.barrel) {
    const prm = parsePRM(await fetchBuf(dir + T.barrel));
    for (const o of fob.filter(o => o.id === 0)) {
      const U = o.up, L = o.look;
      const R = [U[1] * L[2] - U[2] * L[1], U[2] * L[0] - U[0] * L[2], U[0] * L[1] - U[1] * L[0]];
      const xf = (x, y, z) => rv2three(x * R[0] + y * U[0] + z * L[0], x * R[1] + y * U[1] + z * L[1], x * R[2] + y * U[2] + z * L[2]);
      const b = buildMeshes([{ polys: prm.polys, verts: prm.verts, xform: xf }], getMat, { brightness: 1.0 });
      b.group.position.set(...rv2three(...o.pos));
      built.group.add(b.group);
      // gira sobre su eje (el eje X del modelo); la velocidad sale del primer parámetro del objeto
      const sp = new Spinner(b.group, b.collision, new THREE.Vector3(...rv2three(...R)), (o.flags[0] || 10) * 0.012);
      sp.update(0);
      bvh.spinners.push(sp);
    }
  }
  const fc = inf.fogColor.map(v => v / 255);
  const bg = new THREE.Color(fc[0], fc[1], fc[2]);
  const far = Math.max(20000, inf.farClip + 2000);
  const fog = new THREE.Fog(bg, Math.min(inf.fogStart, inf.farClip * 0.55), far);
  const zones = parseTAZ(tazBuf);
  const nZones = Math.max(...zones.map(z => z.id)) + 1;
  const skyGroup = await buildSky(dir, T.sky || {});
  let path = null;
  try { path = parsePAN(await fetchBuf(dir + T.id + '.pan')); } catch (e) {}
  // línea de carrera de los rivales de la PC (nodos de IA del juego original)
  let ai = null;
  try { const fan = parseFAN(await fetchBuf(dir + T.id + '.fan')); if (fan.length > 2) ai = new AiPath(fan); } catch (e) {}
  return { id: T.id, name: T.name, inf, zones, nZones, path, ai, pickups, group: built.group, sky: skyGroup, bvh, bg, fog, far };
}

function loadTrackCached(id) {
  if (!trackCache.has(id)) {
    trackCache.set(id, buildTrack(trackDef(id)).catch(e => { trackCache.delete(id); throw e; }));
  }
  return trackCache.get(id);
}

// Cambia la pista que se ve y contra la que choca el auto
async function setTrack(id) {
  const def = trackDef(id);
  const needLoad = !trackCache.has(def.id);
  if (needLoad) busy('Cargando ' + def.name + '…');
  try {
    const T = await loadTrackCached(def.id);
    if (track !== T) {
      if (track) { scene.remove(track.group); scene.remove(track.sky); }
      scene.add(T.group); if (T.sky.children.length) scene.add(T.sky);
      scene.background = T.bg; scene.fog = T.fog;
      camera.far = Math.max(32000, T.far + 4000); camera.updateProjectionMatrix();
      track = T; world = { bvh: T.bvh };
      G.pathHint = { from: null };
      audio.setMusic(def.music ? 'tracks/' + def.id + '/' + def.music : null);
      weapons.setTrack(T);
      buildMinimap(T);
      carFx.clear();
    }
    G.trackId = def.id;
    return T;
  } finally { if (needLoad) busy(null); }
}

// Cielo: caja de 6 caras con las texturas sky_* de la pista, que acompaña a la cámara
async function buildSky(dir, files) {
  const sky = new THREE.Group();
  const S = 20000, h = S / 2;
  const faces = {
    ft: { p: [0, 0, -h], r: [0, 0, 0] },
    bk: { p: [0, 0, h], r: [0, Math.PI, 0] },
    lt: { p: [-h, 0, 0], r: [0, Math.PI / 2, 0] },
    rt: { p: [h, 0, 0], r: [0, -Math.PI / 2, 0] },
    tp: { p: [0, h, 0], r: [Math.PI / 2, 0, 0] },
    bt: { p: [0, -h, 0], r: [-Math.PI / 2, 0, 0] },
  };
  for (const [side, f] of Object.entries(faces)) {
    if (!files[side]) continue;
    const tex = await loadTexture(dir + files[side]);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(S * 1.002, S * 1.002),
      new THREE.MeshBasicMaterial({ map: tex, fog: false, depthWrite: false, depthTest: false }));
    m.position.set(...f.p); m.rotation.set(...f.r); m.renderOrder = -10;
    sky.add(m);
  }
  sky.frustumCulled = false;
  return sky;
}

// Parámetros de todos los autos al arrancar (livianos); los modelos 3D se bajan cuando hacen falta
async function loadCarParams(def) {
  const txt = await fetchText(BASE + 'cars/' + def.id + '/parameters.txt');
  carDefs.set(def.id, { def, params: parseCarParams(txt) });
}

function ensureCar(id) {
  const cd = carDefs.get(id);
  if (!cd) return Promise.reject(new Error('Auto desconocido: ' + id));
  if (cd.body) return Promise.resolve(cd);
  cd.loading ??= (async () => {
    const def = cd.def, dir = BASE + 'cars/' + def.id + '/';
    const tex = def.tex ? await loadTexture(dir + def.tex) : null;
    // En los autos cualquier página de textura >= 0 es la textura del auto (TPAGE)
    const carMats = makeMaterials([tex]);
    const getMat = (page, tr) => carMats(page >= 0 && tex ? 0 : -1, tr);
    const prms = {};
    await Promise.all(Object.entries(def.models).map(async ([i, fn]) => { prms[i] = parsePRM(await fetchBuf(dir + fn)); }));
    cd.body = buildMeshes([{ polys: prms[0].polys, verts: prms[0].verts }], getMat).group;
    cd.box = new THREE.Box3().setFromObject(cd.body);
    cd.spheres = carSpheresFromBox(cd.box);
    const built = {};
    cd.wheels = cd.params.wheels.map((w, i) => {
      const k = w.modelNum >= 0 ? w.modelNum : -1;
      if (!prms[k]) return null;
      built[k] ??= buildMeshes([{ polys: prms[k].polys, verts: prms[k].verts }], getMat).group;
      return built[k];
    });
    return cd;
  })().catch(e => { cd.loading = null; throw e; });
  return cd.loading;
}

// Aviso de carga sobre el juego (para cambios de pista o de auto)
let busyCount = 0;
function busy(msg) {
  busyCount += msg ? 1 : -1;
  const el = $('busy');
  if (msg) el.textContent = msg;
  el.hidden = busyCount <= 0;
}

// Los costados de las ruedas de Re-Volt son conos que terminan en punta sobre el eje.
// Los aplanamos al ancho de la banda de rodamiento para que se vean como neumáticos.
function flattenWheel(V) {
  let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < V.length; i += 3) { y0 = Math.min(y0, V[i + 1]); y1 = Math.max(y1, V[i + 1]); z0 = Math.min(z0, V[i + 2]); z1 = Math.max(z1, V[i + 2]); }
  const cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const rad = i => Math.hypot(V[i + 1] - cy, V[i + 2] - cz);
  let maxR = 0;
  for (let i = 0; i < V.length; i += 3) maxR = Math.max(maxR, rad(i));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < V.length; i += 3) if (rad(i) > maxR * 0.6) { lo = Math.min(lo, V[i]); hi = Math.max(hi, V[i]); }
  if (!isFinite(lo)) return V;
  const out = new Float32Array(V);
  // solo las puntas sobre el eje (radio casi 0) que sobresalen mucho del ancho de la banda
  for (let i = 0; i < out.length; i += 3) {
    if (rad(i) < maxR * 0.25) out[i] = Math.max(lo - 2, Math.min(hi + 2, out[i]));
  }
  return out;
}

// ---------- Visual de un auto ----------
class CarVisual {
  constructor(carId, parent = scene) {
    const cd = carDefs.get(carId);
    this.carId = carId; this.parent = parent;
    this.root = new THREE.Group();
    this.root.add(cd.body.clone());
    this.wheelObjs = [];
    cd.params.wheels.forEach((w, i) => {
      if (!w.present || !cd.wheels[i]) { this.wheelObjs.push(null); return; }
      const pivot = new THREE.Group();
      const o = w.offset1; pivot.position.set(o[0], -o[1], -o[2]);
      const steerG = new THREE.Group(); const spinG = new THREE.Group();
      spinG.add(cd.wheels[i].clone()); steerG.add(spinG); pivot.add(steerG); this.root.add(pivot);
      this.wheelObjs.push({ pivot, steerG, spinG, base: pivot.position.clone() });
    });
    this.nameTag = null;
    parent.add(this.root);
  }
  setWheels(susp, steer, spin) {
    let k = 0;
    this.wheelObjs.forEach((w, i) => {
      if (!w) return;
      w.pivot.position.copy(w.base); w.pivot.position.y += susp[k] || 0;
      w.steerG.rotation.y = steer[k] || 0;
      w.spinG.rotation.x = -(spin[k] || 0);
      k++;
    });
  }
  setName(text) {
    if (this.nameTag) this.root.remove(this.nameTag);
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 34px "Chakra Petch", sans-serif'; g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = '#12162b'; g.strokeText(text, 128, 44);
    g.fillStyle = '#ffd23f'; g.fillText(text, 128, 44);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, fog: false }));
    sp.scale.set(80, 20, 1); sp.position.set(0, 50, 0); sp.renderOrder = 10;
    this.nameTag = sp; this.root.add(sp);
  }
  dispose() { this.parent.remove(this.root); }
}

// ---------- Estado del juego ----------
const G = {
  mode: 'loading', // menu | lobby | race | practice | results
  carId: store.get('rv.car', 'rc'),
  trackId: store.get('rv.track', 'nhood1'),
  steerSens: Math.min(200, Math.max(50, +store.get('rv.steer', '100') || 100)), // sensibilidad de dirección en %
  name: store.get('rv.name', ''),
  phys: null, vis: null,
  laps: 3, raceStart: 0, goTime: 0, locked: true,
  lap: { cur: 0, started: false, done: 0, lapStart: 0, best: null, finished: false, finishTime: 0 },
  remotes: new Map(), // id -> {vis, carId, name, pos, quat, vel, tpos, tquat, prog, fin}
  results: [], camMode: 0, online: false,
  prevPos: null, prevQuat: null, renderPos: new THREE.Vector3(), renderQuat: new THREE.Quaternion(),
  pathHint: { from: null }, // último tramo del recorrido donde estaba el auto
  bots: [], // rivales de la computadora
  botCount: Math.min(7, Math.max(1, +store.get('rv.bots', '3') || 3)),
  botLaps: +store.get('rv.botlaps', '3') || 3,
  botDiff: DIFFICULTY[store.get('rv.botdiff', 'normal')] ? store.get('rv.botdiff', 'normal') : 'normal',
};
let net = null;

function show(id) {
  for (const s of ['scr-menu', 'scr-lobby', 'scr-results']) $(s).hidden = s !== id;
  $('hud').hidden = !(G.mode === 'race' || G.mode === 'practice');
  $('touch').hidden = !(isTouch && (G.mode === 'race' || G.mode === 'practice'));
}
const isTouch = matchMedia('(pointer: coarse)').matches;

function gridSlot(i) {
  const S = new THREE.Vector3(...rv2three(...track.inf.startPos));
  const a = track.inf.startRot * Math.PI * 2;
  const fRv = [Math.sin(a), 0, Math.cos(a)];
  const f = new THREE.Vector3(...rv2three(...fRv)).normalize();
  const right = new THREE.Vector3(-f.z, 0, f.x);
  const row = Math.floor(i / 2), col = i % 2;
  const p = S.clone().addScaledVector(f, -row * 140).addScaledVector(right, (col ? 1 : -1) * 48);
  // apoyar sobre el piso
  const ray = new THREE.Ray(p.clone().add(new THREE.Vector3(0, 300, 0)), new THREE.Vector3(0, -1, 0));
  const hit = world.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 2000);
  if (hit) p.y = hit.point.y + 22;
  return { pos: p, yaw: Math.atan2(-f.x, -f.z) };
}

let spawnSeq = 0;
async function spawnMyCar(slot = 0) {
  const seq = ++spawnSeq;
  let cd;
  if (!carDefs.get(G.carId)?.body) { busy('Cargando auto…'); try { cd = await ensureCar(G.carId); } finally { busy(null); } }
  else cd = carDefs.get(G.carId);
  if (seq !== spawnSeq) return; // llegó otro pedido mientras cargaba
  if (G.vis) G.vis.dispose();
  G.phys = new CarPhysics(cd.params, cd.box, world);
  G.phys.steerGain = G.steerSens / 100;
  G.vis = new CarVisual(G.carId);
  audio.setOwnEngine(engineUrl(G.carId));
  G.prevPos = null;
  G.pathHint = { from: null };
  const s = gridSlot(slot);
  G.phys.place(s.pos, s.yaw);
}

function resetLaps() { G.lap = newLap(); for (const b of G.bots) b.lap = newLap(); }

// Punto más cercano del recorrido (nodos .pan) a una posición: tramo, avance en el tramo y distancia a la meta.
// "hint" recuerda el último tramo: así el auto sigue el recorrido en orden y no "salta" a otra parte
// de la pista que pase cerca (por ejemplo, una calle paralela que se recorre en sentido contrario).
function segmentAt(path, i, ni, rv) {
  const n = path.nodes[i], nx = path.nodes[ni];
  const ab = [nx.pos[0] - n.pos[0], nx.pos[1] - n.pos[1], nx.pos[2] - n.pos[2]];
  const ap = [rv[0] - n.pos[0], rv[1] - n.pos[1], rv[2] - n.pos[2]];
  const len2 = Math.max(1, ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2);
  const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / len2));
  const d2 = (ap[0] - ab[0] * t) ** 2 + (ap[1] - ab[1] * t) ** 2 + (ap[2] - ab[2] * t) ** 2;
  // en el tramo que cruza la meta la distancia "da la vuelta": el nodo de la línea vale la vuelta entera
  const a = nx.dist > n.dist ? path.total : n.dist;
  return { from: i, to: ni, t, d2, dist: a + (nx.dist - a) * t };
}
function pathLocate(pos, hint) {
  const path = track.path; if (!path) return null;
  const rv = [pos.x, -pos.y, -pos.z];
  const N = path.nodes;
  let best = null;
  if (hint && hint.from != null && N[hint.from]) {
    // tramos vecinos al último conocido: hasta 2 nodos para atrás y 3 para adelante
    const cand = new Set([hint.from]);
    let front = [hint.from];
    for (let k = 0; k < 3; k++) { const nf = []; for (const i of front) for (const j of N[i].next) if (!cand.has(j)) { cand.add(j); nf.push(j); } front = nf; }
    front = [hint.from];
    for (let k = 0; k < 2; k++) { const nf = []; for (const i of front) for (const j of N[i].prev) if (!cand.has(j)) { cand.add(j); nf.push(j); } front = nf; }
    for (const i of cand) for (const ni of N[i].next) { const s = segmentAt(path, i, ni, rv); if (!best || s.d2 < best.d2) best = s; }
    if (best && best.d2 > 1500 * 1500) best = null; // muy lejos (reapareció o se cortó camino): buscar en toda la pista
  }
  if (!best) {
    N.forEach((n, i) => { for (const ni of n.next) { const s = segmentAt(path, i, ni, rv); if (!best || s.d2 < best.d2) best = s; } });
  }
  if (hint && best) hint.from = best.from;
  return best;
}

// Distancia recorrida dentro de la vuelta (0..1)
function pathFraction(pos = G.phys.pos, hint = G.pathHint) {
  const loc = pathLocate(pos, hint); if (!loc) return 0;
  return Math.max(0, Math.min(0.999, 1 - loc.dist / track.path.total));
}

// Punto del recorrido unos metros más adelante (para la flecha de dirección), en coords three
function pathAhead(pos, ahead, hint = G.pathHint) {
  const loc = pathLocate(pos, hint); if (!loc) return null;
  const N = track.path.nodes;
  const P3 = n => new THREE.Vector3(n.pos[0], -n.pos[1], -n.pos[2]);
  let a = N[loc.from], b = N[loc.to];
  let cur = P3(a).lerp(P3(b), loc.t), left = ahead, guard = 0;
  while (guard++ < 20) {
    const end = P3(b), seg = cur.distanceTo(end);
    if (seg >= left) return cur.lerp(end, left / Math.max(1, seg));
    left -= seg; cur = end; a = b; b = N[b.next[0]]; if (!b) return cur;
  }
  return cur;
}

function remoteProgress(r, now) {
  const pr = r.prog || 0;
  if (pr >= 1e5 || !track.path) return pr;
  const age = Math.min(0.3, (now - r.seen) / 1000);
  return pr + r.vel.length() * age * 0.5 / track.path.total;
}

function progressValue() {
  const L = G.lap;
  if (L.finished) return 1e6 - L.finishTime / 1000;
  return L.done * 100 + (L.started ? L.cur + 1 : 0) + pathFraction() * 0.5;
}

// Avanza las zonas de vuelta (.taz) de un auto. Devuelve el tiempo de la vuelta cuando completa una.
function lapTick(L, p, now, hint) {
  if (L.finished || G.locked) return null;
  const rv = [p.x, -p.y, -p.z];
  const N = track.nZones;
  // pistas con pocas zonas (algunas de la comunidad traen solo la de largada): la vuelta cuenta
  // al ENTRAR a la zona de largada y solo si antes se recorrió más de la mitad de la pista
  if (N < 4 && track.path) {
    // la vuelta se cuenta al cruzar el nodo de largada del recorrido (como hace RVGL), habiendo pasado por la mitad
    const f = pathFraction(p, hint);
    if (f > 0.4 && f < 0.7) L.half = true;
    const last = L.lastF; L.lastF = f;
    if (last == null) { if (f < 0.4) { L.started = true; L.lapStart = now; L.cur = 0; } return null; }
    const crossed = last > 0.8 && f < 0.2;
    if (!crossed) return null;
    if (!L.started) { L.started = true; L.lapStart = now; L.half = false; L.cur = 0; return null; }
    if (!L.half) return null;
    L.half = false;
    const lt = now - L.lapStart; L.lapStart = now; L.done++;
    if (L.best == null || lt < L.best) L.best = lt;
    return lt;
  }
  for (const z of track.zones) {
    if (!zoneContains(z, rv)) continue;
    const want1 = (L.cur + 1) % N, want2 = (L.cur + 2) % N;
    if (z.id !== want1 && z.id !== want2) continue;
    const prev = L.cur; L.cur = z.id;
    if (z.id === 0 || (z.id === 1 && prev === N - 1)) {
      if (!L.started) { L.started = true; L.lapStart = now; }
      else {
        const lt = now - L.lapStart; L.lapStart = now; L.done++;
        if (L.best == null || lt < L.best) L.best = lt;
        return lt;
      }
    }
    break;
  }
  return null;
}
function newLap() { return { cur: track.nZones - 1, started: false, done: 0, lapStart: 0, best: null, finished: false, finishTime: 0, lastZoneT: 0 }; }
function updateLaps(now) {
  const L = G.lap;
  const lt = lapTick(L, G.phys.pos, now, G.pathHint);
  if (lt == null) return;
  // récord de la pista (en este navegador), con el fantasma de esa vuelta
  const isRec = records.submit(G.trackId, lt, { car: G.carId, name: G.name || 'Piloto' }, lapRec.s.length > 4 ? lapRec.s : null);
  if (isRec) {
    toast('¡NUEVO RÉCORD! ' + fmt(lt));
    audio.play('pickgen', { vol: 0.9 });
    updateRecordLabels();
    if (G.mode === 'practice') loadGhost();
  } else toast('Vuelta ' + L.done + ': ' + fmt(lt) + (L.best === lt ? ' · ¡mejor!' : ''));
  audio.play('pickup', { vol: 0.8 });
  if (G.mode === 'race' && L.done >= G.laps) finishRace(now);
}
// progreso de un rival de la PC (misma escala que progressValue)
function botProgress(b) {
  const L = b.lap;
  if (L.finished) return 1e6 - L.finishTime / 1000;
  return L.done * 100 + (L.started ? L.cur + 1 : 0) + pathFraction(b.phys.pos, b.driver.hint) * 0.5;
}

function finishRace(now) {
  const L = G.lap; L.finished = true; L.finishTime = now - G.goTime;
  const me = { id: net?.myId || 'me', name: G.name || 'Piloto', time: L.finishTime };
  addResult(me);
  net?.send({ t: 'finish', name: me.name, time: me.time });
  center('¡LLEGASTE!', 2000);
  audio.play('pickgen', { vol: 0.9 });
  setTimeout(() => {
    if (G.mode !== 'race') return;
    G.mode = 'results'; $('btn-res-back').textContent = G.online && net?.active ? 'Volver a la sala' : 'Volver al menú';
    show('scr-results'); renderCup();
  }, 2200);
}

function addResult(r) {
  if (G.results.find(x => x.id === r.id)) return;
  G.results.push(r); G.results.sort((a, b) => a.time - b.time);
  $('res-body').innerHTML = G.results.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td>${fmt(x.time)}</td></tr>`).join('');
  renderCup();
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmt(ms) {
  if (ms == null) return '--';
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}
let toastT = 0;
function toast(msg) { const t = $('h-toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
let centerT = 0;
function center(msg, ms) { const c = $('h-center'); c.textContent = msg; c.hidden = false; clearTimeout(centerT); if (ms) centerT = setTimeout(() => c.hidden = true, ms); }

function startCountdown(now) {
  G.locked = true; G.goTime = now + 3000; resetLaps(); G.results = []; $('res-body').innerHTML = '';
}

async function startPractice() {
  audio.unlock(); clearBots(); G.cup = null;
  await setTrack(G.trackId);
  await spawnMyCar(0);
  G.mode = 'practice'; G.online = false; G.laps = Infinity;
  G.myPlace = 1; G.nPlace = 1;
  loadGhost();
  weapons.clearAll();
  show(null); startCountdown(performance.now());
}

async function startRace(laps, grid, trackId, cup) {
  G.cup = cup && Array.isArray(cup.tracks) ? cup : null;
  audio.unlock(); clearBots(); clearGhost();
  if (trackId) await setTrack(trackId);
  const idx = Math.max(0, grid.indexOf(net.myId));
  await spawnMyCar(idx);
  G.mode = 'race'; G.laps = laps;
  weapons.clearAll();
  show(null); startCountdown(performance.now());
}

// ---------- Carrera contra la computadora ----------
// los rivales siguen los nodos de IA (.fan); si la pista no los tiene, el recorrido de posiciones (.pan)
const botNav = {
  locate: (pos, st) => { if (track.ai) return track.ai.locate(pos, st); st.pos = pos; return pathLocate(pos, st); },
  ahead: (st, d) => track.ai ? track.ai.ahead(st, d) : pathAhead(st.pos, d, st),
  dirAt: (st, d) => track.ai ? track.ai.dirAt(st, d) : pathDirAt(st.pos, d, st),
  finishDist: st => track.ai ? track.ai.finishDist(st) : null,
  speedLimit: (st, alat, decel, look) => track.ai ? track.ai.speedLimit(st, alat, decel, look) : Infinity,
  halfWidth: st => track.ai ? track.ai.halfWidth(st) : 300,
  room: (st, margin) => track.ai ? track.ai.room(st, margin) : [-150, 150],
  minRadius: (st, d) => track.ai ? track.ai.minRadius(st, d) : 1e5,
  cars: () => G.carList || [],
  get total() { return track.ai?.total || 1; },
  // distancia a una pared (no piso ni rampa) en una dirección horizontal, o null
  wall: (pos, dir, len) => {
    const ray = new THREE.Ray(new THREE.Vector3(pos.x, pos.y + 30, pos.z), dir);
    const h = world.bvh.raycastFirst(ray, THREE.DoubleSide, 0, len);
    return h && Math.abs(h.face.normal.y) < 0.6 ? h.distance : null;
  },
};
function clearBots() {
  for (const b of G.bots) { b.vis?.dispose(); audio.removeRemote(b.id); }
  G.bots = [];
}
async function startBotRace() {
  audio.unlock(); clearGhost(); G.cup = null;
  await setTrack(G.trackId);
  clearBots();
  if (!track.path) { $('menu-status').textContent = 'Esta pista no tiene recorrido para los rivales.'; return; }
  // rivales con autos distintos al tuyo (al azar)
  const pool = manifest.cars.map(c => c.id).filter(id => id !== G.carId && carDefs.has(id));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const ids = Array.from({ length: G.botCount }, (_, i) => pool[i % pool.length]);
  busy('Cargando rivales…');
  try { await Promise.all(ids.map(id => ensureCar(id))); } catch (e) { busy(null); $('menu-status').textContent = 'No se pudieron cargar los rivales: ' + e.message; return; }
  busy(null);
  const D = DIFFICULTY[G.botDiff];
  G.bots = ids.map((carId, i) => {
    const cd = carDefs.get(carId);
    const phys = new CarPhysics(cd.params, cd.box, world);
    const s = gridSlot(i);
    phys.place(s.pos, s.yaw);
    const vis = new CarVisual(carId); vis.setName(cd.params.name);
    const skill = D.skill + (Math.random() - 0.5) * 2 * D.spread;
    return { id: 'bot' + i, carId, name: cd.params.name, phys, vis, driver: new BotDriver(phys, botNav, skill), lap: newLap(), prevPos: null, prevQuat: null, rpos: phys.pos.clone(), rquat: phys.quat.clone() };
  });
  // vos arrancás último, como en Re-Volt
  await spawnMyCar(G.bots.length);
  G.mode = 'race'; G.online = false; G.laps = G.botLaps;
  G.myPlace = G.bots.length + 1; G.nPlace = G.bots.length + 1;
  weapons.clearAll();
  show(null); startCountdown(performance.now());
}
// si un rival se perdió o quedó trabado mucho rato, vuelve al recorrido
function resetBotToPath(b) {
  if (track.ai) {
    track.ai.locate(b.phys.pos, b.driver.st);
    const sp = track.ai.spawnPoint(b.driver.st, 250); // un poco más adelante, pasando lo que lo trababa
    if (sp) {
      const p = sp.pos.clone();
      const hit = world.bvh.raycastFirst(new THREE.Ray(p.clone().add(new THREE.Vector3(0, 300, 0)), new THREE.Vector3(0, -1, 0)), THREE.DoubleSide, 0, 2000);
      if (hit) p.y = hit.point.y + 30;
      b.phys.place(p, Math.atan2(-sp.dir.x, -sp.dir.z));
      b.prevPos = null; b.driver.lostT = 0; b.driver.stuckT = 0; b.driver.revT = 0;
      return;
    }
  }
  const loc = pathLocate(b.phys.pos, b.driver.hint); if (!loc) { b.phys.respawn(); return; }
  const N = track.path.nodes, P3 = n => new THREE.Vector3(n.pos[0], -n.pos[1], -n.pos[2]);
  const a = P3(N[loc.from]), c = P3(N[loc.to]);
  const p = a.clone().lerp(c, loc.t), d = c.clone().sub(a);
  const ray = new THREE.Ray(p.clone().add(new THREE.Vector3(0, 300, 0)), new THREE.Vector3(0, -1, 0));
  const hit = world.bvh.raycastFirst(ray, THREE.DoubleSide, 0, 2000);
  if (hit) p.y = hit.point.y + 30;
  b.phys.place(p, Math.atan2(-d.x, -d.z));
  b.prevPos = null; b.driver.lostT = 0; b.driver.stuckT = 0; b.driver.revT = 0;
}
function updateBots(now, dt) {
  const racing = G.mode === 'race' && !G.locked;
  // todos los autos, para que los rivales vean a quién tienen adelante
  G.carList = [];
  if (G.phys) G.carList.push({ pos: G.phys.pos, vel: G.phys.vel });
  for (const b of G.bots) G.carList.push({ pos: b.phys.pos, vel: b.phys.vel });
  for (const r of G.remotes.values()) if (r.vis && r.tpos) G.carList.push({ pos: r.pos, vel: r.vel });
  const myLaps = G.lap.done + (G.lap.started ? pathFraction() : 0);
  for (const b of G.bots) {
    const L = b.lap, D = b.driver;
    if (!racing || L.finished) {
      // quieto en la grilla o ya llegó: frena despacio
      b.phys.input = L.finished ? { throttle: 0.15, steer: D.think(dt).steer, handbrake: false } : { throttle: 0, steer: 0, handbrake: true };
      continue;
    }
    // un poco de "goma": si te sacan mucha ventaja aflojan, si quedaron muy atrás aprietan
    const botLaps = L.done + (L.started ? pathFraction(b.phys.pos, D.hint) : 0);
    const diff = botLaps - myLaps;
    D.band = diff > 0.15 ? Math.max(0.9, 1 - (diff - 0.15) * 0.25) : diff < -0.15 ? Math.min(1.08, 1 + (-diff - 0.15) * 0.25) : 1;
    b.phys.input = D.think(dt);
    if (D.lostT > 3) resetBotToPath(b);
    const lt = lapTick(L, b.phys.pos, now, D.hint);
    if (lt != null && L.done >= G.laps) {
      L.finished = true; L.finishTime = now - G.goTime;
      addResult({ id: b.id, name: b.name, time: L.finishTime });
      if (!G.lap.finished) toast(b.name + ' llegó: ' + fmt(L.finishTime));
    }
  }
}
// en las físicas: auto contra auto (vos y los rivales de la PC)
function botCollisions() {
  const cars = [{ id: net?.active ? net.myId : 'me', phys: G.phys }, ...G.bots];
  const asOther = c => ({ pos: c.phys.pos, quat: c.phys.quat, vel: c.phys.vel, spheres: c.phys.carSpheres, mass: c.phys.mass });
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (a.phys.pos.distanceToSquared(b.phys.pos) > 400 * 400) continue;
    const oa = asOther(a), ob = asOther(b);
    const h1 = a.phys.collideWithCar(ob), h2 = b.phys.collideWithCar(oa);
    const hit = Math.max(h1 || 0, h2 || 0);
    if (hit > 450) weapons.sparks(a.phys.hitPt, Math.min(1, hit / 1800));
    if (hit > 300 && i === 0) audio.hit(Math.min(1, hit / 2000));
    else if (hit > 300) audio.playAt('hit1', a.phys.pos, { vol: Math.min(1, hit / 2000) });
    if (hit) { weapons.onCarContact(a.id, b.id); weapons.onCarContact(b.id, a.id); }
  }
}

// ---------- Sombras, marcas de derrape y chispas ----------
const carFx = new CarEffects(scene);
const _wp = new THREE.Vector3();
function localFxCar(id, phys, vis, carId, rpos, rquat) {
  const cd = carDefs.get(carId);
  const sz = cd?.box ? cd.box.getSize(new THREE.Vector3()) : new THREE.Vector3(60, 30, 100);
  return { id, pos: rpos, quat: rquat, size: { x: sz.x, z: sz.z }, skid: phys.skid || 0, visible: !!vis?.root.visible,
    wheels: phys.wheels.map(w => ({ contact: w.contact ? w.point : null, pos: w.point, r: w.radius })) };
}
function updateCarFx() {
  const list = [];
  if (G.phys && G.vis) list.push(localFxCar('me', G.phys, G.vis, G.vis.carId, G.renderPos, G.renderQuat));
  for (const b of G.bots) list.push(localFxCar(b.id, b.phys, b.vis, b.carId, b.rpos, b.rquat));
  for (const [id, r] of G.remotes) {
    if (!r.vis || !r.tpos) continue;
    const cd = carDefs.get(r.carId); if (!cd?.box) continue;
    const sz = cd.box.getSize(new THREE.Vector3());
    const wheels = cd.params.wheels.filter(w => w.present).map(w => {
      const o = w.offset1;
      return { contact: null, pos: new THREE.Vector3(o[0], -o[1], -o[2]).applyQuaternion(r.quat).add(r.pos), r: w.radius };
    });
    list.push({ id, pos: r.pos, quat: r.quat, size: { x: sz.x, z: sz.z }, skid: r.sk || 0, visible: r.vis.root.visible, wheels });
  }
  carFx.update(list, world?.bvh);
}
let sparkT = 0;
function sparkAt(pos, hit, now) {
  if (now - sparkT < 70) return;
  sparkT = now;
  weapons.sparks(pos, Math.min(1, hit / 1800));
}

// ---------- Bocina ----------
let honkT = 0;
function honk() {
  const now = performance.now(); if (now - honkT < 700) return; honkT = now;
  audio.play('honka', { vol: 0.8 });
  net?.send({ t: 'honk' });
}

// ---------- Minimapa ----------
const minimap = new Minimap($('h-map'));
function buildMinimap(T) {
  const segs = [];
  if (T.ai) for (const n of T.ai.nodes) for (const j of n.next) { const m = T.ai.nodes[j]; segs.push({ a: n.p, b: m.p, w: (n.w + m.w) / 2 }); }
  else if (T.path) {
    const P = n => ({ x: n.pos[0], z: -n.pos[2] });
    for (const n of T.path.nodes) for (const j of n.next) segs.push({ a: P(n), b: P(T.path.nodes[j]), w: 450 });
  }
  const S = rv2three(...T.inf.startPos), a = T.inf.startRot * Math.PI * 2;
  const f = rv2three(Math.sin(a), 0, Math.cos(a));
  minimap.setTrack(segs, { x: S[0], z: S[2] }, { x: f[0], z: f[2] });
}
let mapT = 0;
function drawMinimap(now) {
  if (now - mapT < 33) return; mapT = now;
  const cars = [];
  for (const o of G.others || []) if (o.visible) cars.push({ x: o.pos.x, z: o.pos.z, color: '#ff6b5a' });
  for (const b of G.bots) cars.push({ x: b.rpos.x, z: b.rpos.z, color: '#f4f4f4' });
  if (G.ghost?.vis?.root.visible) cars.push({ x: G.ghost.vis.root.position.x, z: G.ghost.vis.root.position.z, color: '#8fd3ff', ghost: true });
  const d = new THREE.Vector3(0, 0, -1).applyQuaternion(G.renderQuat);
  cars.push({ x: G.renderPos.x, z: G.renderPos.z, dir: { x: d.x, z: d.z }, color: '#ffd23f', me: true });
  minimap.draw(cars);
}

// ---------- Récords y fantasma ----------
const records = new Records(store);
const lapRec = new LapRecorder();
function updateRecordLabels() {
  const r = records.get(G.trackId);
  $('h-rec').textContent = r ? fmt(r.lap) : '--';
  const el = $('track-rec');
  el.textContent = r ? `Récord: ${fmt(r.lap)} · ${carDefs.get(r.car)?.params.name || r.car} · ${r.name}` : 'Sin récord todavía en esta pista';
}
function clearGhost() { if (G.ghost?.vis) G.ghost.vis.dispose(); G.ghost = null; }
// el fantasma de la mejor vuelta aparece en la práctica libre
async function loadGhost() {
  clearGhost();
  const g = records.ghost(G.trackId); if (!g || !carDefs.has(g.car)) return;
  const tid = G.trackId;
  try { await ensureCar(g.car); } catch (e) { return; }
  if (G.mode !== 'practice' || G.trackId !== tid) return;
  clearGhost();
  const vis = new CarVisual(g.car);
  vis.root.traverse(o => {
    if (!o.isMesh) return;
    o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.35; o.material.depthWrite = false;
  });
  vis.setName('FANTASMA');
  vis.root.visible = false;
  G.ghost = { data: g, vis, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), tmp: new THREE.Quaternion() };
}
function updateGhost(now) {
  const gh = G.ghost; if (!gh) return;
  const L = G.lap;
  const on = G.mode === 'practice' && L.started && !G.locked;
  const t = (now - L.lapStart) / 1000;
  gh.vis.root.visible = on && ghostAt(gh.data.s, t, gh.pos, gh.quat, gh.tmp);
  if (gh.vis.root.visible) { gh.vis.root.position.copy(gh.pos); gh.vis.root.quaternion.copy(gh.quat); }
}

// ---------- Menú ----------
// ---------- Garage: selección de auto ----------
const MOTOR = ['Eléctrico', 'Nafta', 'A cuerda'];
const RATING = ['Novato', 'Amateur', 'Avanzado', 'Semi-pro', 'Pro', 'Súper pro'];
function carNums(P) {
  const top = P.topEnd > 100 ? P.topEnd : P.topSpeed * 85.4;
  const accRaw = P.acc;
  const acc = Math.min(1900, Math.max(600, accRaw > 0 && accRaw < 15 ? accRaw * 175 : top / 2.4)); // igual que la física
  const ws = P.wheels.filter(w => w.present);
  const grip = ws.reduce((a, w) => a + (w.staticFriction || 1.5), 0) / Math.max(1, ws.length);
  const steer = Math.min(3.5, Math.max(2, P.steerRate || 3)) * Math.min(0.6, Math.max(0.35, Math.max(...ws.map(w => Math.abs(w.steerRatio || 0)), 0.35)));
  return { top, acc, mass: P.mass || 1.2, grip, steer };
}
let statMax = null;
function statsRange() {
  if (statMax) return statMax;
  const all = manifest.cars.map(d => carDefs.get(d.id)).filter(Boolean).map(cd => carNums(cd.params));
  const mm = k => [Math.min(...all.map(n => n[k])), Math.max(...all.map(n => n[k]))];
  return (statMax = { top: mm('top'), acc: mm('acc'), mass: mm('mass'), grip: mm('grip'), steer: mm('steer') });
}
function pct(v, [lo, hi]) { return Math.round(15 + 85 * (hi > lo ? (v - lo) / (hi - lo) : 1)); }
function drivetrain(P) {
  const ws = P.wheels.filter(w => w.present), pw = ws.filter(w => w.powered);
  if (pw.length >= ws.length) return '4x4';
  const front = pw.every(w => w.offset1[2] > 0); // en Re-Volt z positivo es adelante
  return front ? 'Tracción delantera' : 'Tracción trasera';
}
const garageGroups = () => [...new Set(manifest.cars.filter(d => carDefs.has(d.id)).map(d => d.group))];
const carsIn = g => manifest.cars.filter(d => d.group === g && carDefs.has(d.id));

// fotos de los autos: se sacan del modelo 3D con una cámara aparte
const thumbs = new Map();
let thumbR = null, thumbScene = null, thumbCam = null, thumbQueue = Promise.resolve();
function carThumb(id) {
  if (thumbs.has(id)) return thumbs.get(id);
  const job = thumbQueue.then(async () => {
    const cd = await ensureCar(id);
    if (!thumbR) {
      const c = document.createElement('canvas');
      thumbR = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
      thumbR.outputColorSpace = THREE.LinearSRGBColorSpace;
      thumbR.setSize(320, 180, false);
      thumbScene = new THREE.Scene();
      thumbCam = new THREE.PerspectiveCamera(26, 16 / 9, 5, 5000);
    }
    const vis = new CarVisual(id, thumbScene);
    vis.root.rotation.y = Math.PI * 0.8;
    vis.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vis.root), c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    thumbCam.position.copy(c).add(new THREE.Vector3(0.55, 0.42, 1).normalize().multiplyScalar(r / Math.sin(THREE.MathUtils.degToRad(13)) * 0.62));
    thumbCam.lookAt(c.clone().add(new THREE.Vector3(0, -r * 0.08, 0)));
    thumbR.setClearColor(0x000000, 0);
    thumbR.render(thumbScene, thumbCam);
    const url = thumbR.domElement.toDataURL('image/png');
    vis.dispose();
    return url;
  });
  thumbQueue = job.catch(() => {});
  thumbs.set(id, job);
  return job;
}

let garageGroup = null;
function selectCar(id, sound = true) {
  if (!carDefs.has(id)) return;
  G.carId = id; store.set('rv.car', id);
  if (sound) audio.play('menuupdown', { vol: 0.5 });
  garageGroup = carDef(id).group;
  renderCars();
  spawnMyCar(G.mode === 'lobby' ? lobbySlot() : 0);
  if (net) {
    net.setCar(id);
    if (net.active && !net.isHost) net.send({ t: 'car', car: id });
    else if (net.active && net.isHost) { const me = net.players.get('host'); if (me) { me.car = id; net._roster(); } }
  }
}
function stepCar(dir, inGroup = true) {
  const list = inGroup ? carsIn(carDef(G.carId).group) : manifest.cars.filter(d => carDefs.has(d.id));
  const i = list.findIndex(d => d.id === G.carId);
  selectCar(list[(i + dir + list.length) % list.length].id);
}
function renderCars() {
  const def = carDef(G.carId), P = carDefs.get(G.carId).params;
  garageGroup ??= def.group;
  // pestañas de grupos
  const tabs = $('g-tabs');
  tabs.innerHTML = garageGroups().map(g => `<button type="button" role="tab" aria-selected="${g === garageGroup}" data-g="${esc(g)}">${esc(g)}<small>${carsIn(g).length} autos</small></button>`).join('');
  // tarjeta del auto elegido
  const list = carsIn(def.group), idx = list.findIndex(d => d.id === G.carId);
  $('g-name').textContent = P.name;
  $('g-sub').textContent = `${def.group} · ${idx + 1} de ${list.length}`;
  const img = $('g-shot'); img.alt = P.name;
  const want = G.carId;
  carThumb(want).then(u => { if (G.carId === want) img.src = u; }).catch(() => {});
  const n = carNums(P), R = statsRange();
  const kmh = Math.round(n.top * MPH_PER_UNIT * 1.609);
  const row = (label, p, v = '') => `<dt>${label}</dt><dd><span class="bar"><i style="width:${p}%"></i></span></dd><dd class="v">${v}</dd>`;
  $('g-stats').innerHTML =
    row('Velocidad', pct(n.top, R.top), kmh + ' km/h') +
    row('Aceleración', pct(n.acc, R.acc)) +
    row('Agarre', pct(n.grip, R.grip)) +
    row('Dirección', pct(n.steer, R.steer)) +
    row('Peso', pct(n.mass, R.mass), n.mass.toFixed(1) + ' kg') +
    `<div class="tags"><span>${MOTOR[P.cls] || MOTOR[0]}</span><span>${drivetrain(P)}</span>${P.rating >= 0 ? `<span>Nivel ${RATING[Math.min(5, P.rating | 0)]}</span>` : ''}</div>`;
  // tira de fotos del grupo que se está mirando
  const strip = $('g-strip');
  strip.innerHTML = '';
  for (const d of carsIn(garageGroup)) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', d.id === G.carId);
    b.innerHTML = `<img alt=""><span>${esc(carDefs.get(d.id).params.name)}</span>`;
    b.onclick = () => selectCar(d.id);
    strip.appendChild(b);
    carThumb(d.id).then(u => { b.querySelector('img').src = u; }).catch(() => {});
  }
  strip.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('lc-name').textContent = P.name;
}
$('g-tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  garageGroup = b.dataset.g; audio.play('menuupdown', { vol: 0.4 }); renderCars();
});
$('g-prev').onclick = () => stepCar(-1);
$('g-next').onclick = () => stepCar(1);
$('lc-prev').onclick = () => stepCar(-1, false);
$('lc-next').onclick = () => stepCar(1, false);

// ---------- Sensibilidad de dirección ----------
function setSteerSens(v, announce) {
  G.steerSens = Math.min(200, Math.max(50, Math.round(v / 5) * 5));
  store.set('rv.steer', String(G.steerSens));
  if (G.phys) G.phys.steerGain = G.steerSens / 100;
  document.querySelectorAll('input.steer[id^="steer"]').forEach(el => { el.value = G.steerSens; });
  document.querySelectorAll('input.steer[id^="steer"]').forEach(el => { const v = el.parentElement.querySelector('.steer-val'); if (v) v.textContent = G.steerSens + '%'; });
  if (announce) toast('Sensibilidad de dirección: ' + G.steerSens + '%');
}
document.querySelectorAll('input.steer[id^="steer"]').forEach(el => el.addEventListener('input', () => setSteerSens(+el.value)));

// ---------- Volumen ----------
function syncVolumes() {
  $('vol-music').value = Math.round(audio.musicVol * 100); $('vol-music-val').textContent = Math.round(audio.musicVol * 100) + '%';
  $('vol-sfx').value = Math.round(audio.sfxVol * 100); $('vol-sfx-val').textContent = Math.round(audio.sfxVol * 100) + '%';
}
$('vol-music').addEventListener('input', e => { audio.unlock(); audio.setMusicVolume(+e.target.value / 100); syncVolumes(); });
$('vol-sfx').addEventListener('input', e => { audio.unlock(); audio.setSfxVolume(+e.target.value / 100); syncVolumes(); audio.play('menuupdown', { vol: 0.6 }); });

function getName() { const n = $('name').value.trim() || 'Piloto'; G.name = n; store.set('rv.name', n); return n; }

// opciones de la carrera contra la PC
function bindSel(id, cur, key, set) {
  const el = $(id);
  [...el.children].forEach(c => c.setAttribute('aria-pressed', c.dataset.v === String(cur)));
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    [...el.children].forEach(c => c.setAttribute('aria-pressed', c === b));
    set(b.dataset.v); store.set(key, b.dataset.v); audio.play('menuupdown', { vol: 0.5 });
  });
}
bindSel('botsel', G.botCount, 'rv.bots', v => { G.botCount = +v; });
bindSel('botlaps', G.botLaps, 'rv.botlaps', v => { G.botLaps = +v; });
bindSel('botdiff', G.botDiff, 'rv.botdiff', v => { G.botDiff = v; });
$('btn-bots').onclick = () => { getName(); audio.unlock(); audio.play('menunext', { vol: 0.6 }); startBotRace(); };
$('btn-practice').onclick = () => { getName(); audio.unlock(); audio.play('menunext', { vol: 0.6 }); startPractice(); };
$('btn-host').onclick = async () => {
  const name = getName(); audio.unlock();
  $('menu-status').textContent = 'Creando sala…';
  net?.close(); net = new Net(netHandlers);
  try {
    const code = await net.host(name, G.carId);
    G.online = true; enterLobby(code);
    $('menu-status').textContent = '';
  } catch (e) { $('menu-status').textContent = 'No se pudo crear la sala. ' + (e.message || ''); }
};
$('btn-join').onclick = async () => {
  const name = getName(); audio.unlock();
  const code = $('code').value.trim().toUpperCase();
  if (code.length < 5) { $('menu-status').textContent = 'Escribí el código de 5 letras que te pasó tu amigo.'; return; }
  $('menu-status').textContent = 'Conectando…';
  net?.close(); net = new Net(netHandlers);
  try { await net.join(code, name, G.carId); G.online = true; enterLobby(code); $('menu-status').textContent = ''; }
  catch (e) { $('menu-status').textContent = e.message || 'No se pudo conectar.'; }
};
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });

function enterLobby(code) {
  G.mode = 'lobby';
  $('lobby-code').textContent = code;
  refreshLobbyUI();
  spawnMyCar(lobbySlot());
  show('scr-lobby');
}
// botones de la sala según si sos el anfitrión (cambia si el anfitrión se va y quedás vos)
function refreshLobbyUI() {
  $('btn-start').hidden = !net.isHost; $('lap-field').hidden = !net.isHost; $('lobby-wait').hidden = net.isHost;
  $('lobby-track-field').hidden = !net.isHost; $('lobby-track-name').hidden = net.isHost;
  $('cup-field').hidden = !net.isHost; updateLobbyCup();
  renderTrackButtons($('lobby-tracksel'));
  updateLobbyTrack();
  $('lobby-sub').textContent = net.isHost ? 'PASALE ESTE CÓDIGO A TUS AMIGOS' : 'CONECTADO A LA SALA';
}

$('lapsel').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  G.laps = +b.dataset.l;
  [...$('lapsel').children].forEach(c => c.setAttribute('aria-pressed', c === b));
});
$('btn-start').onclick = () => {
  const laps = +($('lapsel').querySelector('[aria-pressed=true]')?.dataset.l || 3);
  const grid = [...net.players.keys()];
  // campeonato: varias pistas seguidas empezando por la elegida
  const n = Math.min(manifest.tracks.length, G.cupN || 0);
  let cup = null;
  if (n > 1) {
    const i0 = manifest.tracks.findIndex(t => t.id === G.trackId);
    const tracks = Array.from({ length: n }, (_, k) => manifest.tracks[(i0 + k) % manifest.tracks.length].id);
    cup = { tracks, round: 0, laps, points: {} };
  }
  net.send({ t: 'start', laps, grid, track: G.trackId, cup });
  startRace(laps, grid, G.trackId, cup);
};
$('btn-leave').onclick = () => { net?.close(); net = null; clearRemotes(); G.online = false; toMenu(); };
$('btn-res-back').onclick = () => { if (G.online && net?.active) { G.mode = 'lobby'; refreshLobbyUI(); spawnMyCar(lobbySlot()); show('scr-lobby'); } else toMenu(); };
$('btn-quit').onclick = () => {
  if (G.online && net?.active) { G.mode = 'lobby'; weapons.clearAll(); clearGhost(); refreshLobbyUI(); spawnMyCar(lobbySlot()); show('scr-lobby'); } else toMenu();
};

// lugar en la grilla según el orden de la sala (así en la sala nadie aparece encima de otro)
function lobbySlot() { return net?.active ? Math.max(0, [...net.players.keys()].indexOf(net.myId)) : 0; }
let lastLobbySlot = -1;

function toMenu() { G.mode = 'menu'; G.locked = true; weapons.clearAll(); clearBots(); clearGhost(); $('btn-res-back').textContent = 'Volver a la sala'; renderTrackButtons($('tracksel')); spawnMyCar(0); show('scr-menu'); }

// ---------- Selección de pista ----------
function renderTrackButtons(el) {
  el.innerHTML = '';
  for (const t of manifest.tracks) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = t.name; b.dataset.id = t.id;
    b.setAttribute('aria-pressed', t.id === G.trackId);
    b.onclick = () => chooseTrack(t.id);
    el.appendChild(b);
  }
}
async function chooseTrack(id) {
  G.trackId = id; store.set('rv.track', id);
  updateRecordLabels();
  for (const el of [$('tracksel'), $('lobby-tracksel')]) [...el.children].forEach(c => c.setAttribute('aria-pressed', c.dataset.id === id));
  if (net?.active && net.isHost) net.send({ t: 'track', track: id });
  updateLobbyTrack();
  try { await setTrack(id); if (G.trackId === id) await spawnMyCar(G.mode === 'lobby' ? lobbySlot() : 0); }
  catch (e) { $('menu-status').textContent = 'No se pudo cargar la pista: ' + e.message; }
}
function updateLobbyTrack() { $('lobby-track-name').textContent = 'Pista: ' + trackDef(G.trackId).name; }

// ---------- Campeonato ----------
const CUP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
G.cupN = 0;
// puntos acumulados + los de la carrera actual (según el orden de llegada)
function cupStandings(cup = G.cup) {
  const pts = {};
  for (const [id, v] of Object.entries(cup.points || {})) pts[id] = { name: v.name, pts: v.pts };
  if (!cup.done) G.results.forEach((r, i) => {
    pts[r.id] ??= { name: r.name, pts: 0 };
    pts[r.id].name = r.name; pts[r.id].pts += CUP_POINTS[i] || 0;
  });
  return Object.entries(pts).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.pts - a.pts || (a.name < b.name ? -1 : 1));
}
function renderCup() {
  const box = $('cup-box');
  box.hidden = !G.cup;
  if (!G.cup) return;
  const cup = G.cup, n = cup.tracks.length, last = cup.round >= n - 1;
  const list = cupStandings();
  $('cup-title').textContent = cup.done ? 'Campeonato terminado' : `Campeonato · pista ${cup.round + 1} de ${n}: ${trackDef(cup.tracks[cup.round]).name}`;
  $('cup-body').innerHTML = list.map((x, i) => `<tr class="${i === 0 ? 'lead' : ''}"><td>${i + 1}</td><td>${esc(x.name)}</td><td>${x.pts}</td></tr>`).join('');
  const host = !!net?.isHost && net.active;
  const nb = $('btn-cup-next');
  nb.hidden = !host || !!cup.done;
  nb.textContent = last ? 'Terminar campeonato' : 'Siguiente pista: ' + trackDef(cup.tracks[cup.round + 1]).name;
  const info = $('cup-info');
  if (cup.done) info.innerHTML = list.length ? `<span class="champ">🏆 ${esc(list[0].name)}</span>` : '';
  else info.textContent = host ? 'Cuando quieras, arrancá la siguiente (los que no llegaron suman 0).' : 'Esperando que el anfitrión arranque la siguiente pista…';
}
$('btn-cup-next').onclick = () => {
  if (!G.cup || !net?.isHost) return;
  const points = {};
  for (const x of cupStandings()) points[x.id] = { name: x.name, pts: x.pts };
  const cup = { ...G.cup, points };
  if (cup.round >= cup.tracks.length - 1) {
    G.cup = { ...cup, done: true };
    net.send({ t: 'cupend', cup: G.cup });
    renderCup();
    audio.play('pickgen', { vol: 0.9 });
    return;
  }
  cup.round++;
  const grid = [...net.players.keys()];
  const track = cup.tracks[cup.round];
  net.send({ t: 'start', laps: cup.laps, grid, track, cup });
  G.trackId = track;
  startRace(cup.laps, grid, track, cup);
};
$('cupsel').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  G.cupN = +b.dataset.v;
  [...$('cupsel').children].forEach(c => c.setAttribute('aria-pressed', c === b));
  if (net?.isHost) net.send({ t: 'cupmode', n: G.cupN });
  updateLobbyCup();
});
function updateLobbyCup() {
  const n = Math.min(manifest.tracks.length, G.cupN || 0);
  const el = $('lobby-cup-name');
  el.hidden = net?.isHost || n < 2;
  el.textContent = n > 1 ? `Modo: campeonato de ${n} pistas` : '';
}

// ---------- Red ----------
function clearRemotes() { for (const r of G.remotes.values()) r.vis?.dispose(); G.remotes.clear(); audio.clearRemotes(); }
function dropRemote(id) { const r = G.remotes.get(id); if (r) { r.vis?.dispose(); G.remotes.delete(id); } audio.removeRemote(id); }
function ensureRemote(id, carId, name) {
  if (!carDefs.has(carId)) carId = 'rc';
  let r = G.remotes.get(id);
  if (!r) {
    r = { vis: null, carId, name, pos: new THREE.Vector3(0, -1e5, 0), quat: new THREE.Quaternion(), vel: new THREE.Vector3(), tpos: null, tquat: new THREE.Quaternion(), prog: 0, susp: [], steer: [], spin: [0, 0, 0, 0], radius: 50, seen: 0 };
    G.remotes.set(id, r);
    attachRemoteVis(id, r);
  } else {
    if (r.carId !== carId) { r.carId = carId; attachRemoteVis(id, r); }
    if (name && r.name !== name) { r.name = name; r.vis?.setName(name); }
  }
  return r;
}
// Carga el modelo del auto de un rival y lo muestra cuando está listo
async function attachRemoteVis(id, r) {
  const want = r.carId;
  try { await ensureCar(want); } catch (e) { return; }
  if (G.remotes.get(id) !== r || r.carId !== want) return;
  r.vis?.dispose();
  r.vis = new CarVisual(want); r.vis.setName(r.name || 'Piloto');
  audio.removeRemote(id); // con el auto nuevo cambia el sonido del motor
  r.radius = carDefs.get(want).box.getSize(new THREE.Vector3()).z * 0.5;
}
const netHandlers = {
  onStatus: msg => { $('lobby-status').textContent = msg; $('menu-status').textContent = msg; },
  onRoster: list => {
    $('lobby-players').innerHTML = list.map(p => `<li><span>${esc(p.name)}${p.id === net.myId ? ' (vos)' : ''}${p.id === 'host' ? ' ★' : ''}</span><span>${esc(carDefs.get(p.car)?.params.name || p.car)}</span></li>`).join('');
    const ids = new Set(list.map(p => p.id));
    for (const p of list) if (p.id !== net.myId) ensureRemote(p.id, p.car, p.name);
    for (const id of [...G.remotes.keys()]) if (!ids.has(id)) dropRemote(id);
    $('btn-start').disabled = false;
    if (G.mode === 'lobby' && lobbySlot() !== lastLobbySlot) { lastLobbySlot = lobbySlot(); spawnMyCar(lastLobbySlot); }
    // el anfitrión le avisa la pista a quien recién entra
    if (net.isHost) { net.send({ t: 'track', track: G.trackId }); net.send({ t: 'cupmode', n: G.cupN }); }
  },
  onState: d => {
    if (d.id === net?.myId) return;
    const pl = net.players.get(d.id);
    const r = ensureRemote(d.id, d.car || pl?.car || 'rc', pl?.name);
    r.tpos = new THREE.Vector3(...d.p); r.tquat.set(...d.q); r.vel.set(...d.v);
    if (r.pos.y < -9e4) { r.pos.copy(r.tpos); r.quat.copy(r.tquat); }
    r.susp = d.su; r.steer = d.st; r.prog = d.pr; r.fx = d.fx | 0; r.sk = +d.sk || 0; r.seen = performance.now();
  },
  onEvent: d => {
    if (d.t === 'start') { startRace(d.laps, d.grid, d.track, d.cup); }
    else if (d.t === 'cupend') { if (d.cup) { G.cup = { ...d.cup, done: true }; if (G.mode !== 'results') { G.mode = 'results'; show('scr-results'); } renderCup(); } }
    else if (d.t === 'cupmode') { G.cupN = +d.n || 0; updateLobbyCup(); }
    else if (['pk', 'wf', 'pb', 'wb', 'gp'].includes(d.t)) weapons.onNet(d);
    else if (d.t === 'honk') { const r = G.remotes.get(d.id); if (r?.vis) audio.playAt('honka', r.pos, { vol: 0.9 }); }
    else if (d.t === 'rank') { if (Array.isArray(d.order)) G.rank = { order: d.order.map(String), at: performance.now() }; }
    else if (d.t === 'track') {
      const tid = d.track;
      if (manifest.tracks.some(t => t.id === tid) && tid !== G.trackId) {
        G.trackId = tid; updateLobbyTrack();
        setTrack(tid).then(() => { if (G.trackId === tid && G.mode === 'lobby') spawnMyCar(lobbySlot()); }).catch(() => {});
      }
    }
    else if (d.t === 'finish') { addResult({ id: d.id, name: d.name, time: d.time }); if (G.mode === 'race') toast(d.name + ' llegó: ' + fmt(d.time)); }
    else if (d.t === 'gone') { dropRemote(d.id); }
    else if (d.t === 'hostgone') { clearRemotes(); G.online = false; toMenu(); $('menu-status').textContent = 'Se cortó la sala y no se pudo recuperar.'; }
    else if (d.t === 'reconnecting') { toast('Se cortó la conexión. Reconectando…'); $('lobby-status').textContent = 'Reconectando…'; }
    else if (d.t === 'reconnected') { toast('¡Reconectado!'); $('lobby-status').textContent = ''; }
    else if (d.t === 'becamehost') {
      // el anfitrión se fue y ahora la sala es tuya (mismo código): sacar su auto viejo
      dropRemote('host');
      toast('El anfitrión se fue: ahora sos vos el anfitrión');
      $('lobby-status').textContent = '';
      if (G.mode === 'lobby') refreshLobbyUI();
      renderCup();
    }
    else if (d.t === 'full') { $('menu-status').textContent = 'La sala está llena (máximo 8).'; }
  },
};

// ---------- Entrada ----------
const keys = new Set();
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyR' && G.phys && (G.mode === 'race' || G.mode === 'practice')) G.phys.respawn();
  if (e.code === 'KeyC') G.camMode = (G.camMode + 1) % 3;
  if (['KeyF', 'KeyE', 'Enter', 'NumpadEnter'].includes(e.code) && !e.repeat && (G.mode === 'race' || G.mode === 'practice')) { e.preventDefault(); weapons.fire(); }
  if (G.mode === 'menu' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !e.repeat) stepCar(e.code === 'ArrowLeft' ? -1 : 1);
  if (e.code === 'KeyH' && (G.mode === 'race' || G.mode === 'practice' || G.mode === 'lobby')) honk();
  if (e.code === 'KeyM') toast(audio.toggleMute() ? 'Sonido apagado' : 'Sonido encendido');
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setSteerSens(G.steerSens + 10, true);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') setSteerSens(G.steerSens - 10, true);
  if (e.code === 'Escape' && (G.mode === 'race' || G.mode === 'practice')) $('btn-quit').click();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const touchState = { left: false, right: false, gas: false, back: false };
document.querySelectorAll('#touch button').forEach(b => {
  const k = b.dataset.k;
  const on = e => { e.preventDefault(); touchState[k] = true; b.classList.add('on'); if (k === 'fire') weapons.fire(); };
  const off = e => { e.preventDefault(); touchState[k] = false; b.classList.remove('on'); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
});
let padRespawnHeld = false, padFireHeld = false;
function readInput() {
  let throttle = 0, steer = 0, hb = false;
  if (keys.has('ArrowUp') || keys.has('KeyW')) throttle += 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) throttle -= 1;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) steer += 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) steer -= 1;
  if (keys.has('Space')) hb = true;
  if (touchState.gas) throttle += 1; if (touchState.back) throttle -= 1;
  if (touchState.left) steer += 1; if (touchState.right) steer -= 1;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > 0.15) steer -= ax;
    const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
    throttle += rt - lt;
    if (gp.buttons[0]?.pressed) throttle += 1;
    if (gp.buttons[2]?.pressed) throttle -= 1;
    if (gp.buttons[1]?.pressed || gp.buttons[5]?.pressed) hb = true;
    if (gp.buttons[4]?.pressed && !padFireHeld) weapons.fire();
    padFireHeld = !!gp.buttons[4]?.pressed;
    const y = gp.buttons[3]?.pressed;
    if (y && !padRespawnHeld && G.phys) G.phys.respawn();
    padRespawnHeld = !!y;
    if (gp.buttons[14]?.pressed) steer += 1; if (gp.buttons[15]?.pressed) steer -= 1;
    break;
  }
  return { throttle: Math.max(-1, Math.min(1, throttle)), steer: Math.max(-1, Math.min(1, steer)), handbrake: hb };
}

// ---------- Sonido ----------
const audio = new GameAudio(store);
function engineUrl(carId) { return carDef(carId)?.engine || 'sfx/moto.wav'; }
function carTop(carId) { const P = carDefs.get(carId)?.params; return P ? (P.topEnd > 100 ? P.topEnd : P.topSpeed * 85.4) : 3000; }
// ---------- Armas ----------
// Lo que el sistema de armas necesita saber del juego
function myCar() {
  return G.phys ? { id: net?.active ? net.myId : 'me', isMe: true, phys: G.phys, pos: G.phys.pos, renderPos: G.renderPos, quat: G.phys.quat,
    active: (G.mode === 'race' || G.mode === 'practice') && !G.locked && !G.lap.finished } : null;
}
const weapons = new Weapons(scene, audio, {
  me: myCar,
  // autos que se simulan en esta compu: vos y los rivales de la PC
  locals: () => {
    const me = myCar(); const list = me ? [me] : [];
    const racing = G.mode === 'race' && !G.locked;
    for (const b of G.bots) list.push({ id: b.id, isMe: false, phys: b.phys, pos: b.phys.pos, renderPos: b.rpos, quat: b.phys.quat, active: racing && !b.lap.finished, straight: b.driver.straight });
    return list;
  },
  others: () => G.others || [],
  send: msg => { if (net?.active) net.send(msg); },
  bvh: () => world?.bvh,
  place: id => {
    if (!id || id === myCar()?.id) return { place: G.myPlace || 1, total: G.nPlace || 1 };
    const b = G.bots.find(x => x.id === id);
    return { place: b?.place || 1, total: G.nPlace || 1 };
  },
  prog: id => { const b = G.bots.find(x => x.id === id); return b ? botProgress(b) : progressValue(); },
  toast: msg => toast(msg),
  shake: a => { G.shake = Math.max(G.shake || 0, a); },
});
let weaponKey = '';
function updateWeaponHud() {
  const el = $('h-weapon');
  const k = weapons.held, key = k ? k + weapons.shots : weapons.bomb ? 'bomb' : '';
  if (key === weaponKey) return;
  weaponKey = key;
  el.hidden = !key;
  if (!key) return;
  const W = k ? WEAPONS[k] : WEAPONS.putty;
  const ic = el.querySelector('i'); ic.style.setProperty('--wx', W.icon[0]); ic.style.setProperty('--wy', W.icon[1]);
  el.querySelector('b').textContent = k ? W.name + (weapons.shots > 1 ? ' ×' + weapons.shots : '') : '¡BOMBA! CHOCÁ A ALGUIEN';
  el.querySelector('small').hidden = !k;
  el.classList.toggle('danger', !k);
}
// el navegador solo deja sonar después de una interacción
window.addEventListener('pointerdown', () => audio.unlock());
window.addEventListener('keydown', () => audio.unlock());

// ---------- Cámara ----------
// autos grandes (como el Panga) llevan la cámara un poco más lejos
function carScale() {
  // el auto que se ve en pantalla (el elegido puede estar todavía bajándose)
  const cd = carDefs.get(G.vis?.carId); if (!cd?.box) return 1;
  let ext = (cd.box.max.z - cd.box.min.z) / 2;
  for (const w of cd.params.wheels) if (w.present) ext = Math.max(ext, Math.abs(w.offset1[2]) + w.radius, Math.abs(w.offset1[0]) + w.radius);
  return Math.max(1, Math.min(2, ext / 55));
}
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const _camFw = new THREE.Vector3(), _camUp = new THREE.Vector3();
const camDir = new THREE.Vector3(0, 0, -1);
let camInit = false, orbit = 0, camY = 0, camDist = 0, camLift = 0;
function updateCamera(dt) {
  if (!G.phys) return;
  // la cámara sigue la posición interpolada (la que se ve), no la de física
  const P = { pos: G.renderPos, quat: G.renderQuat };
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(P.quat); fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.copy(camDir); fwd.normalize();
  if (G.mode === 'menu' || G.mode === 'lobby' || G.mode === 'results') {
    orbit += dt * 0.35;
    const sc = carScale();
    const want = P.pos.clone().add(new THREE.Vector3(Math.sin(orbit) * 230 * sc, 75 * sc, Math.cos(orbit) * 230 * sc));
    const look = P.pos.clone().add(new THREE.Vector3(0, 10, 0));
    const k = 1 - Math.exp(-dt * 7);
    if (!camInit) { camPos.copy(want); camLook.copy(look); camInit = true; }
    camPos.lerp(want, k); camLook.lerp(look, k);
    camDir.copy(fwd); camY = P.pos.y; camDist = 0;
    camera.position.copy(camPos); camera.lookAt(camLook);
    return;
  }
  // Sin retraso de posición: la cámara va siempre a la misma distancia del auto, así el auto
  // no "tiembla" en pantalla cuando un cuadro tarda más que otro. Solo se suavizan el giro y la altura.
  camDir.lerp(fwd, 1 - Math.exp(-dt * (G.camMode === 2 ? 25 : 6))).normalize();
  // altura: sube rápido (rampas, subidas) y baja más suave; nunca muy por debajo del auto
  camY += (P.pos.y - camY) * (1 - Math.exp(-dt * (P.pos.y > camY ? 16 : 7)));
  camY = Math.max(camY, P.pos.y - 25);
  const base = new THREE.Vector3(P.pos.x, camY, P.pos.z);
  let want, look;
  if (G.camMode === 2) {
    want = P.pos.clone().addScaledVector(camDir, 20).add(new THREE.Vector3(0, 22, 0));
    look = P.pos.clone().addScaledVector(camDir, 400).add(new THREE.Vector3(0, 15, 0));
  } else {
    const sc = carScale();
    const dist = (G.camMode === 0 ? 215 : 340) * sc, hgt = (G.camMode === 0 ? 70 : 120) * sc;
    // que la cámara no atraviese paredes (la distancia se acerca rápido y se aleja despacio)
    // el rayo que frena la cámara contra paredes y techos sale desde el auto (no desde la altura atrasada)
    const from = new THREE.Vector3(P.pos.x, Math.max(P.pos.y, camY) + 30, P.pos.z);
    // si algo tapa (una loma, una rampa), primero probar mirar desde más arriba antes de acercarse
    let best = null;
    for (const lift of [0, 0.3, 0.65, 1.1]) {
      const d = camDir.clone().negate().add(new THREE.Vector3(0, (hgt - 30) / dist + lift, 0)).normalize();
      const f = Math.hypot(dist, hgt - 30);
      const h = world.bvh.raycastFirst(new THREE.Ray(from, d), THREE.DoubleSide, 0, f);
      const ok = h ? h.distance - 14 : f;
      if (!best || ok > best.ok + 20) best = { lift, ok, f };
      if (ok >= f * 0.85) break;
    }
    camLift += (best.lift - camLift) * (1 - Math.exp(-dt * (best.lift > camLift ? 8 : 2.5)));
    const dir = camDir.clone().negate().add(new THREE.Vector3(0, (hgt - 30) / dist + camLift, 0)).normalize();
    const full = Math.hypot(dist, hgt - 30);
    const hit = world.bvh.raycastFirst(new THREE.Ray(from, dir), THREE.DoubleSide, 0, full);
    const allowed = hit ? Math.max(30, hit.distance - 14) : full;
    if (!camDist) camDist = allowed;
    camDist = allowed < camDist ? allowed : camDist + (allowed - camDist) * (1 - Math.exp(-dt * 3));
    want = from.addScaledVector(dir, camDist);
    // nunca por debajo del piso (bajadas, rampas, lomas detrás del auto)
    const topY = Math.max(want.y, P.pos.y + 25);
    const g = world.bvh.raycastFirst(new THREE.Ray(new THREE.Vector3(want.x, topY, want.z), new THREE.Vector3(0, -1, 0)), THREE.DoubleSide, 0, topY - want.y + 30);
    if (g && g.point.y + 16 > want.y) want.y = g.point.y + 16;
    look = base.clone().addScaledVector(camDir, 60).add(new THREE.Vector3(0, 22, 0));
  }
  camPos.copy(want); camLook.copy(look); camInit = true;
  camera.position.copy(camPos); camera.lookAt(camLook);
  // sacudón de la cámara con las explosiones
  if (G.shake > 0.01) {
    camera.position.add(new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18).multiplyScalar(G.shake));
    G.shake *= Math.exp(-dt * 5);
  }
}

// Clasificación oficial: la arma el anfitrión con el progreso que le reporta cada jugador
// (todos con el mismo retraso de red) y se la manda a todos.
function broadcastRank() {
  const list = [{ id: 'host', prog: G.lastSentProg || 0 }];
  for (const [id, r] of G.remotes) if (r.tpos && performance.now() - r.seen < 3000) list.push({ id, prog: r.prog || 0 });
  list.sort((a, b) => b.prog - a.prog || (a.id < b.id ? -1 : 1));
  G.rank = { order: list.map(x => x.id), at: performance.now() };
  net.send({ t: 'rank', order: G.rank.order });
}

// ---------- Aviso de curvas y tabla de posiciones ----------
// Dirección de la pista (horizontal) en un punto a cierta distancia por delante, según los nodos del recorrido
function pathDirAt(pos, dist, hint = G.pathHint) {
  const a = pathAhead(pos, dist, hint), b = pathAhead(pos, dist + 200, hint);
  if (!a || !b) return null;
  const d = b.sub(a); d.y = 0;
  return d.lengthSq() > 1 ? d.normalize() : null;
}
let curveT = 0, curveShown = 0, wrongT = 0, standT = 0;
function updateArrow(dt) {
  const el = $('h-arrow');
  if (!track.path || G.lap.finished) { el.hidden = true; $('h-wrong').hidden = true; return; }
  const now = pathDirAt(G.renderPos, 0);
  if (!now) { el.hidden = true; return; }
  // ¿Cuánto gira la pista en los próximos metros? Se busca la curva más fuerte que viene.
  // A más velocidad se mira más lejos, para avisar con tiempo.
  const reach = 1500 + Math.min(3000, Math.abs(G.phys.fwdSpeed) * 0.9);
  let turn = 0;
  for (let d = 300; d <= reach; d += 200) {
    const ahead = pathDirAt(G.renderPos, d); if (!ahead) break;
    const ang = Math.atan2(now.x * ahead.z - now.z * ahead.x, now.x * ahead.x + now.z * ahead.z); // + = derecha
    if (Math.abs(ang) > Math.abs(turn)) turn = ang;
  }
  // 1 a 3 flechas según lo cerrada que sea la curva; nada en las rectas
  const level = Math.abs(turn) < 0.45 ? 0 : Math.abs(turn) < 0.9 ? 1 : Math.abs(turn) < 1.5 ? 2 : 3;
  const side = turn > 0 ? 'right' : 'left';
  // evitar parpadeos: el aviso se mantiene un momento aunque la medición baje
  if (level > 0) { curveT = 0.6; curveShown = level * (side === 'right' ? 1 : -1); }
  else curveT -= dt;
  if (curveT <= 0) { el.hidden = true; }
  else {
    const n = Math.abs(curveShown), right = curveShown > 0;
    const key = (right ? 'r' : 'l') + n;
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.className = 'curve ' + (right ? 'right' : 'left') + ' lvl' + n;
      el.innerHTML = '<span>' + (right ? '›' : '‹').repeat(n) + '</span><em>' + (n >= 3 ? 'CURVA CERRADA' : 'CURVA') + '</em>';
    }
    el.hidden = false;
  }
  // contramano: el auto mira al revés del recorrido y se está moviendo
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(G.renderQuat); f.y = 0; f.normalize();
  const back = f.dot(now) < -0.4;
  if (back && Math.abs(G.phys.fwdSpeed) > 250 && !G.locked) wrongT += dt; else wrongT = Math.max(0, wrongT - dt * 2);
  $('h-wrong').hidden = wrongT < 0.8;
}

function updateStandings(now) {
  const others = [...G.remotes.values()].filter(r => r.tpos && now - r.seen < 3000);
  const list = [{ me: true, id: net?.myId || 'me', name: G.name || 'Vos', prog: progressValue(), fin: G.lap.finished, lap: G.lap.done }];
  for (const [id, r] of G.remotes) {
    if (!others.includes(r)) continue;
    const pr = remoteProgress(r, now);
    list.push({ me: false, id, name: r.name || 'Piloto', prog: pr, fin: pr >= 1e5, lap: Math.floor(pr / 100) });
  }
  for (const b of G.bots) { const pr = botProgress(b); list.push({ me: false, id: b.id, name: b.name, prog: pr, fin: b.lap.finished, lap: b.lap.done, bot: b }); }
  // Online se usa el orden que reparte el anfitrión, así todos ven la misma tabla.
  // Si todavía no llegó (o es viejo), se ordena con lo que se ve en esta compu.
  const rank = G.rank && now - G.rank.at < 1500 ? G.rank.order : null;
  if (rank && list.every(x => rank.includes(x.id))) list.sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id));
  else list.sort((a, b) => Math.abs(a.prog - b.prog) < 4e-4 ? (a.id < b.id ? -1 : 1) : b.prog - a.prog);
  const myPos = list.findIndex(x => x.me) + 1;
  G.myPlace = myPos; G.nPlace = list.length;
  list.forEach((x, i) => { if (x.bot) x.bot.place = i + 1; });
  const any = list.length > 1;
  $('h-pos').textContent = any ? myPos + '°/' + list.length : '';
  const box = $('h-standings');
  box.hidden = !any;
  if (!any || now - standT < 150) return; // la tabla se redibuja ~7 veces por segundo
  standT = now;
  box.innerHTML = list.map((x, i) => {
    const info = x.fin ? 'LLEGÓ' : 'V' + Math.min(G.laps, x.lap + 1);
    return `<li class="${x.me ? 'me' : ''}"><b>${i + 1}°</b><span>${esc(x.name)}</span><em>${info}</em></li>`;
  }).join('');
}

// ---------- Bucle ----------
let last = performance.now(), acc = 0, netT = 0;
const FIXED = 1 / 60;
function frame(now) {
  requestAnimationFrame(frame); if (window.__stop) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!G.phys) return;
  const driving = G.mode === 'race' || G.mode === 'practice';

  // Cuenta regresiva
  if (driving && G.locked) {
    const left = G.goTime - now;
    if (left <= 0) { G.locked = false; center('¡YA!', 700); G.lap.lapStart = now; audio.play('countdown', { vol: 0.9, rate: 1.5 }); G.lastBeep = 0; }
    else {
      const n = Math.ceil(left / 1000);
      center(String(n), 0);
      if (G.lastBeep !== n) { G.lastBeep = n; audio.play('countdown', { vol: 0.7 }); }
    }
  }
  const inp = driving && !G.locked ? (window.__autoInput ? window.__autoInput() : readInput()) : { throttle: 0, steer: 0, handbrake: true };
  G.phys.input = inp;

  if (G.bots.length) updateBots(now, dt);
  acc += dt;
  while (acc >= FIXED) {
    // guardar el estado anterior para interpolar el dibujo entre pasos de física
    G.prevPos = G.phys.pos.clone(); G.prevQuat = G.phys.quat.clone();
    world.bvh.update?.(FIXED); // objetos que giran (la ruleta del casino)
    G.phys.step(FIXED);
    for (const b of G.bots) { b.prevPos = b.phys.pos.clone(); b.prevQuat = b.phys.quat.clone(); b.phys.step(FIXED); }
    if (G.bots.length && G.mode === 'race') botCollisions();
    // choques entre autos solo durante la carrera (en la sala los autos están quietos en la grilla)
    if (G.mode === 'race') for (const [id, r] of G.remotes) {
      if (!r.vis || !r.tpos || now - r.seen > 2000) continue;
      const cd = carDefs.get(r.carId); if (!cd?.spheres) continue;
      const hit = G.phys.collideWithCar({ pos: r.pos, quat: r.quat, vel: r.vel, spheres: cd.spheres, mass: cd.params.mass || 1.2 });
      if (hit > 300) audio.hit(Math.min(1, hit / 2000));
      if (hit > 450) sparkAt(G.phys.hitPt, hit, now);
      if (hit) weapons.onCarContact(net.myId, id);
    }
    acc -= FIXED;
  }

  // Visual propio
  const P = G.phys;
  // Interpolación: la física corre a 60 Hz, pero el monitor puede ir a 75, 120 o 144 Hz.
  // Dibujamos el auto entre el paso anterior y el actual para que no avance a saltos.
  const alpha = Math.min(1, acc / FIXED);
  if (G.prevPos && G.prevPos.distanceToSquared(P.pos) < 500 * 500) {
    G.renderPos.lerpVectors(G.prevPos, P.pos, alpha); G.renderQuat.slerpQuaternions(G.prevQuat, P.quat, alpha);
  } else { G.renderPos.copy(P.pos); G.renderQuat.copy(P.quat); }
  G.vis.root.position.copy(G.renderPos); G.vis.root.quaternion.copy(G.renderQuat);
  G.vis.setWheels(P.wheels.map(w => w.suspOffset), P.wheels.map(w => w.steerAngle || 0), P.wheels.map(w => w.spin));

  // Remotos: interpolación suave
  for (const r of G.remotes.values()) {
    if (!r.vis) continue; // el modelo todavía se está cargando
    if (!r.tpos) { r.vis.root.visible = false; continue; }
    r.vis.root.visible = now - r.seen < 3000;
    const pred = r.tpos.clone().addScaledVector(r.vel, Math.min(0.15, (now - r.seen) / 1000));
    r.pos.lerp(pred, 1 - Math.exp(-dt * 14)); r.quat.slerp(r.tquat, 1 - Math.exp(-dt * 14));
    r.vis.root.position.copy(r.pos); r.vis.root.quaternion.copy(r.quat);
    for (let i = 0; i < 4; i++) r.spin[i] = (r.spin[i] || 0) + r.vel.length() / 10 * dt * Math.sign(r.vel.dot(new THREE.Vector3(0, 0, -1).applyQuaternion(r.quat)) || 1);
    r.vis.setWheels(r.susp || [], r.steer || [], r.spin);
  }

  for (const b of G.bots) {
    if (b.prevPos && b.prevPos.distanceToSquared(b.phys.pos) < 500 * 500) { b.rpos.lerpVectors(b.prevPos, b.phys.pos, alpha); b.rquat.slerpQuaternions(b.prevQuat, b.phys.quat, alpha); }
    else { b.rpos.copy(b.phys.pos); b.rquat.copy(b.phys.quat); }
    b.vis.root.position.copy(b.rpos); b.vis.root.quaternion.copy(b.rquat);
    b.vis.setWheels(b.phys.wheels.map(w => w.suspOffset), b.phys.wheels.map(w => w.steerAngle || 0), b.phys.wheels.map(w => w.spin));
  }
  if (driving) {
    updateLaps(now);
    const L = G.lap;
    if (L.started && !L.finished && !G.locked) {
      if (lapRec.start !== L.lapStart) lapRec.begin(L.lapStart);
      lapRec.sample(now, G.renderPos, G.renderQuat);
    }
    updateGhost(now);
  }
  G.others = [];
  for (const [id, r] of G.remotes) {
    if (!r.vis || !r.tpos) continue;
    G.others.push({ id, pos: r.pos, vel: r.vel, quat: r.quat, fx: r.fx | 0, prog: r.prog || 0, visible: r.vis.root.visible && now - r.seen < 2000 });
  }
  weapons.update(dt, now);
  if (driving) updateWeaponHud();
  updateCamera(dt);
  if (track) track.sky.position.copy(camera.position);

  // Red: enviar estado 20 veces por segundo
  netT += dt;
  if (net?.active && netT > 0.05) {
    netT = 0;
    const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
    net.send({ t: 'state', car: G.carId, p: [r1(P.pos.x), r1(P.pos.y), r1(P.pos.z)], q: [r3(P.quat.x), r3(P.quat.y), r3(P.quat.z), r3(P.quat.w)],
      v: [r1(P.vel.x), r1(P.vel.y), r1(P.vel.z)], su: P.wheels.map(w => r1(w.suspOffset)), st: P.wheels.map(w => r3(w.steerAngle || 0)), pr: (G.lastSentProg = G.mode === 'race' ? progressValue() : 0), fx: weapons.myFxBits(), sk: Math.round((P.skid || 0) * 10) / 10 });
    // el anfitrión arma la clasificación y la reparte (así todos ven el mismo orden)
    if (net.isHost && G.mode === 'race' && now - (G.rankSent || 0) > 250) { G.rankSent = now; broadcastRank(); }
  }

  // HUD
  if (driving) {
    const kmh = Math.abs(P.fwdSpeed) * MPH_PER_UNIT * 1.609;
    $('h-speed').textContent = Math.round(kmh);
    const L = G.lap;
    if (G.mode === 'race') {
      $('h-lap').textContent = 'VUELTA ' + Math.min(G.laps, L.done + 1) + '/' + G.laps;
      $('h-time').textContent = fmt(G.locked ? 0 : (L.finished ? L.finishTime : now - G.goTime));
      updateStandings(now);
    } else {
      $('h-lap').textContent = 'VUELTA ' + (L.done + 1);
      $('h-time').textContent = fmt(G.locked || !L.started ? 0 : now - L.lapStart);
      $('h-pos').textContent = '';
      $('h-standings').hidden = true;
    }
    $('h-best').textContent = fmt(L.best);
    updateArrow(dt);
    drawMinimap(now);
  }
  // sonido: motor propio, golpes contra la pista, rivales y oyente en la cámara
  audio.updateOwn(Math.abs(P.fwdSpeed) / P.top, inp.throttle, P.skid || 0, driving);
  if (driving && P.impact > 350) audio.hit(Math.min(1, P.impact / 1800));
  if (driving && P.impact > 550) sparkAt(P.impactPt, P.impact, now);
  for (const b of G.bots) if (b.phys.impact > 650) weapons.sparks(b.phys.impactPt, Math.min(1, b.phys.impact / 1800));
  updateCarFx();
  if (audio.ctx) {
    for (const [id, r] of G.remotes) {
      if (!r.vis) continue;
      if (!audio.remotes.has(id)) audio.addRemote(id, engineUrl(r.carId));
      audio.updateRemote(id, r.pos, r.vel.length() / carTop(r.carId), r.vis.root.visible);
    }
    for (const b of G.bots) {
      if (!audio.remotes.has(b.id)) audio.addRemote(b.id, engineUrl(b.carId));
      audio.updateRemote(b.id, b.rpos, Math.abs(b.phys.fwdSpeed) / b.phys.top, true);
    }
    const fw = camera.getWorldDirection(_camFw), up = _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    audio.updateListener(camera.position, fw, up);
  }
  renderer.render(scene, camera);
}

// ---------- Arranque ----------
async function boot() {
  try {
    let mr = await fetch(BASE + 'manifest.json');
    if (!mr.ok) { BASE = ''; mr = await fetch('manifest.json'); }
    if (!mr.ok) throw new Error('falta manifest.json (subí la carpeta assets o su contenido)');
    manifest = normalizeManifest(await mr.json());
    audio.setBase(BASE);
    try {
      await weapons.init(BASE, manifest.fx);
      if (manifest.fx?.fxpage2) document.documentElement.style.setProperty('--wicons', `url("${BASE}${manifest.fx.fxpage2}")`);
    } catch (e) { console.warn('Sin armas:', e); }
    $('loadmsg').textContent = 'Autos';
    await Promise.all(manifest.cars.map(loadCarParams));
    if (!carDefs.has(G.carId)) G.carId = manifest.cars[0].id;
    if (!manifest.tracks.some(t => t.id === G.trackId)) G.trackId = manifest.tracks[0].id;
    $('loadmsg').textContent = 'Pista: ' + trackDef(G.trackId).name;
    await setTrack(G.trackId);
    await ensureCar(G.carId);
    $('name').value = G.name;
    setSteerSens(G.steerSens);
    syncVolumes();
    renderCars();
    renderTrackButtons($('tracksel'));
    updateRecordLabels();
    await spawnMyCar(0);
    G.mode = 'menu'; show('scr-menu');
    $('loading').hidden = true;
    // solo para pruebas: simula a los rivales más rápido que el tiempo real, sin dibujar
    window.__simBots = (sec, now, log) => {
      const n = Math.round(sec * 60);
      for (let i = 0; i < n; i++) {
        now += 1000 / 60;
        updateBots(now, FIXED);
        world.bvh.update?.(FIXED);
        for (const b of G.bots) { const v0 = b.phys.fwdSpeed; b.phys.step(FIXED); if (b.phys.impact > 450 && b.phys.impactWall) { b.crashes = (b.crashes || 0) + 1; if (log) (log.crash ??= []).push([b.name.slice(0, 8), Math.round(b.phys.pos.x), Math.round(b.phys.pos.z), Math.round(v0), Math.round(b.phys.impact), b.driver.lastWant | 0]); } }
        botCollisions();
        weapons.update(FIXED, now);
        if (log?.trace && i % 3 === 0) for (const b of G.bots) log.trace.push([b.phys.pos.x, b.phys.pos.y, b.phys.pos.z]);
        if (log && i % 30 === 0) log.push(G.bots.map(b => [Math.round(b.phys.pos.x), Math.round(b.phys.pos.z), Math.round(b.phys.fwdSpeed), b.lap.cur, b.lap.done]));
      }
      return now;
    };
    window.__rv = { G, scene, camera, get world() { return world; }, carDefs, get track() { return track; }, renderer, progressValue, pathFraction, setTrack, ensureCar, pathLocate, audio, weapons, THREE, gridSlot, startBotRace, botProgress, TUNE, records, BotDriver, botNav,
      finishTest: t => { G.locked = false; G.goTime = performance.now() - t; finishRace(performance.now()); },
      netIsHost: () => !!net?.isHost, netDrop: () => { try { net.hostConn?.close(); } catch (e) {} } };
  } catch (e) {
    console.error(e);
    $('loadmsg').textContent = 'No se pudo cargar: ' + e.message + '. Si abriste el archivo con doble clic, tiene que estar subido a una página web (ver LEEME).';
  }
}
requestAnimationFrame(frame);
boot();
