import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { parsePRM, parseW, parseFIN, parseTAZ, parseINF, parseCarParams, parsePAN, zoneContains, rv2three } from './rvformats.js';
import { loadTexture, makeMaterials, buildMeshes } from './build.js';
import { CarPhysics, MPH_PER_UNIT } from './physics.js';
import { Net } from './net.js';

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
  const prmCache = new Map();
  const keys = Object.keys(T.instances || {});
  for (const f of fins) {
    const key = keys.find(k => k === f.name) || keys.find(k => f.name.startsWith(k) || k.startsWith(f.name));
    if (!key) continue;
    const def = T.instances[key];
    if (!prmCache.has(def.prm)) prmCache.set(def.prm, parsePRM(await fetchBuf(dir + def.prm)));
    const prm = prmCache.get(def.prm);
    const M = f.mat, P = f.pos;
    meshes.push({
      polys: prm.polys, verts: prm.verts, solid: def.solid,
      xform: (x, y, z) => rv2three(
        P[0] + x * M[0] + y * M[3] + z * M[6],
        P[1] + x * M[1] + y * M[4] + z * M[7],
        P[2] + x * M[2] + y * M[5] + z * M[8]),
    });
  }
  const built = buildMeshes(meshes, getMat, { brightness: 1.0 });
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(built.collision, 3));
  const bvh = new MeshBVH(cg);
  const fc = inf.fogColor.map(v => v / 255);
  const bg = new THREE.Color(fc[0], fc[1], fc[2]);
  const far = Math.max(20000, inf.farClip + 2000);
  const fog = new THREE.Fog(bg, Math.min(inf.fogStart, inf.farClip * 0.55), far);
  const zones = parseTAZ(tazBuf);
  const nZones = Math.max(...zones.map(z => z.id)) + 1;
  const skyGroup = await buildSky(dir, T.sky || {});
  let path = null;
  try { path = parsePAN(await fetchBuf(dir + T.id + '.pan')); } catch (e) {}
  return { id: T.id, name: T.name, inf, zones, nZones, path, group: built.group, sky: skyGroup, bvh, bg, fog, far };
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
    cd.wheels = [1, 2, 3, 4].map(i => prms[i] ? buildMeshes([{ polys: prms[i].polys, verts: prms[i].verts }], getMat).group : null);
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
  constructor(carId) {
    const cd = carDefs.get(carId);
    this.carId = carId;
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
    scene.add(this.root);
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
  dispose() { scene.remove(this.root); }
}

// ---------- Estado del juego ----------
const G = {
  mode: 'loading', // menu | lobby | race | practice | results
  carId: store.get('rv.car', 'rc'),
  trackId: store.get('rv.track', 'nhood1'),
  name: store.get('rv.name', ''),
  phys: null, vis: null,
  laps: 3, raceStart: 0, goTime: 0, locked: true,
  lap: { cur: 0, started: false, done: 0, lapStart: 0, best: null, finished: false, finishTime: 0 },
  remotes: new Map(), // id -> {vis, carId, name, pos, quat, vel, tpos, tquat, prog, fin}
  results: [], camMode: 0, online: false,
  prevPos: null, prevQuat: null, renderPos: new THREE.Vector3(), renderQuat: new THREE.Quaternion(),
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
  G.vis = new CarVisual(G.carId);
  G.prevPos = null;
  const s = gridSlot(slot);
  G.phys.place(s.pos, s.yaw);
}

function resetLaps() {
  G.lap = { cur: track.nZones - 1, started: false, done: 0, lapStart: 0, best: null, finished: false, finishTime: 0, lastZoneT: 0 };
}

// Punto más cercano del recorrido (nodos .pan) a una posición: tramo, avance en el tramo y distancia a la meta
function pathLocate(pos) {
  const path = track.path; if (!path) return null;
  const rv = [pos.x, -pos.y, -pos.z];
  let best = null, bestD = Infinity;
  path.nodes.forEach((n, i) => {
    for (const ni of n.next) {
      const nx = path.nodes[ni]; if (!nx) continue;
      const ab = [nx.pos[0] - n.pos[0], nx.pos[1] - n.pos[1], nx.pos[2] - n.pos[2]];
      const ap = [rv[0] - n.pos[0], rv[1] - n.pos[1], rv[2] - n.pos[2]];
      const len2 = Math.max(1, ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2);
      const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / len2));
      const d2 = (ap[0] - ab[0] * t) ** 2 + (ap[1] - ab[1] * t) ** 2 + (ap[2] - ab[2] * t) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        // en el tramo que cruza la meta la distancia "da la vuelta": el nodo de la línea vale la vuelta entera
        const a = nx.dist > n.dist ? path.total : n.dist;
        best = { from: i, to: ni, t, dist: a + (nx.dist - a) * t };
      }
    }
  });
  return best;
}

// Distancia recorrida dentro de la vuelta (0..1)
function pathFraction(pos = G.phys.pos) {
  const loc = pathLocate(pos); if (!loc) return 0;
  return Math.max(0, Math.min(0.999, 1 - loc.dist / track.path.total));
}

// Punto del recorrido unos metros más adelante (para la flecha de dirección), en coords three
function pathAhead(pos, ahead) {
  const loc = pathLocate(pos); if (!loc) return null;
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

function updateLaps(now) {
  if (G.lap.finished || G.locked) return;
  const p = G.phys.pos; const rv = [p.x, -p.y, -p.z];
  const N = track.nZones, L = G.lap;
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
        toast('Vuelta ' + L.done + ': ' + fmt(lt) + (L.best === lt ? ' · ¡mejor!' : ''));
        if (G.mode === 'race' && L.done >= G.laps) finishRace(now);
      }
    }
    break;
  }
}

function finishRace(now) {
  const L = G.lap; L.finished = true; L.finishTime = now - G.goTime;
  const me = { id: net?.myId || 'me', name: G.name || 'Piloto', time: L.finishTime };
  addResult(me);
  net?.send({ t: 'finish', name: me.name, time: me.time });
  center('¡LLEGASTE!', 2000);
  setTimeout(() => { if (G.mode === 'race') { G.mode = 'results'; show('scr-results'); } }, 2200);
}

function addResult(r) {
  if (G.results.find(x => x.id === r.id)) return;
  G.results.push(r); G.results.sort((a, b) => a.time - b.time);
  $('res-body').innerHTML = G.results.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td>${fmt(x.time)}</td></tr>`).join('');
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
  audio.start();
  await setTrack(G.trackId);
  await spawnMyCar(0);
  G.mode = 'practice'; G.online = false; G.laps = Infinity;
  show(null); startCountdown(performance.now());
}

async function startRace(laps, grid, trackId) {
  audio.start();
  if (trackId) await setTrack(trackId);
  const idx = Math.max(0, grid.indexOf(net.myId));
  await spawnMyCar(idx);
  G.mode = 'race'; G.laps = laps;
  show(null); startCountdown(performance.now());
}

// ---------- Menú ----------
function stat(v, max) { return Math.round(Math.max(6, Math.min(100, v / max * 100))); }
function renderCars() {
  const el = $('cars'); el.innerHTML = '';
  let group = null;
  for (const def of manifest.cars) {
    const cd = carDefs.get(def.id); if (!cd) continue; const P = cd.params;
    if (def.group !== group) {
      group = def.group;
      const h = document.createElement('div'); h.className = 'car-group'; h.textContent = group; el.appendChild(h);
    }
    const top = P.topEnd > 100 ? P.topEnd : P.topSpeed * 85.4;
    const b = document.createElement('button');
    b.className = 'car'; b.type = 'button'; b.setAttribute('aria-pressed', def.id === G.carId);
    const acc = P.acc > 0 && P.acc < 15 ? P.acc : top / 2.4 / 175;
    b.innerHTML = `<b>${esc(P.name)}</b><span class="bars">
      <span>VEL</span><span class="bar"><i style="width:${stat(top, 4500)}%"></i></span>
      <span>ACC</span><span class="bar"><i style="width:${stat(acc, 9)}%"></i></span>
      <span>PESO</span><span class="bar"><i style="width:${stat(P.mass, 2.2)}%"></i></span></span>`;
    b.onclick = () => {
      G.carId = def.id; store.set('rv.car', def.id);
      [...el.querySelectorAll('.car')].forEach(c => c.setAttribute('aria-pressed', c === b));
      spawnMyCar(0);
      if (net?.active && !net.isHost) net.send({ t: 'car', car: def.id });
    };
    el.appendChild(b);
  }
}

function getName() { const n = $('name').value.trim() || 'Piloto'; G.name = n; store.set('rv.name', n); return n; }

$('btn-practice').onclick = () => { getName(); startPractice(); };
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
  $('btn-start').hidden = !net.isHost; $('lap-field').hidden = !net.isHost; $('lobby-wait').hidden = net.isHost;
  $('lobby-track-field').hidden = !net.isHost; $('lobby-track-name').hidden = net.isHost;
  renderTrackButtons($('lobby-tracksel'));
  updateLobbyTrack();
  $('lobby-sub').textContent = net.isHost ? 'PASALE ESTE CÓDIGO A TUS AMIGOS' : 'CONECTADO A LA SALA';
  spawnMyCar(0);
  show('scr-lobby');
}

$('lapsel').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  G.laps = +b.dataset.l;
  [...$('lapsel').children].forEach(c => c.setAttribute('aria-pressed', c === b));
});
$('btn-start').onclick = () => {
  const laps = +($('lapsel').querySelector('[aria-pressed=true]')?.dataset.l || 3);
  const grid = [...net.players.keys()];
  net.send({ t: 'start', laps, grid, track: G.trackId });
  startRace(laps, grid, G.trackId);
};
$('btn-leave').onclick = () => { net?.close(); net = null; clearRemotes(); G.online = false; toMenu(); };
$('btn-res-back').onclick = () => { if (G.online && net?.active) { G.mode = 'lobby'; show('scr-lobby'); } else toMenu(); };
$('btn-quit').onclick = () => {
  if (G.online && net?.active) { G.mode = 'lobby'; show('scr-lobby'); } else toMenu();
};

function toMenu() { G.mode = 'menu'; G.locked = true; renderTrackButtons($('tracksel')); spawnMyCar(0); show('scr-menu'); }

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
  for (const el of [$('tracksel'), $('lobby-tracksel')]) [...el.children].forEach(c => c.setAttribute('aria-pressed', c.dataset.id === id));
  if (net?.active && net.isHost) net.send({ t: 'track', track: id });
  updateLobbyTrack();
  try { await setTrack(id); if (G.trackId === id) await spawnMyCar(0); }
  catch (e) { $('menu-status').textContent = 'No se pudo cargar la pista: ' + e.message; }
}
function updateLobbyTrack() { $('lobby-track-name').textContent = 'Pista: ' + trackDef(G.trackId).name; }

// ---------- Red ----------
function clearRemotes() { for (const r of G.remotes.values()) r.vis?.dispose(); G.remotes.clear(); }
function dropRemote(id) { const r = G.remotes.get(id); if (r) { r.vis?.dispose(); G.remotes.delete(id); } }
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
    // el anfitrión le avisa la pista a quien recién entra
    if (net.isHost) net.send({ t: 'track', track: G.trackId });
  },
  onState: d => {
    if (d.id === net?.myId) return;
    const pl = net.players.get(d.id);
    const r = ensureRemote(d.id, d.car || pl?.car || 'rc', pl?.name);
    r.tpos = new THREE.Vector3(...d.p); r.tquat.set(...d.q); r.vel.set(...d.v);
    if (r.pos.y < -9e4) { r.pos.copy(r.tpos); r.quat.copy(r.tquat); }
    r.susp = d.su; r.steer = d.st; r.prog = d.pr; r.seen = performance.now();
  },
  onEvent: d => {
    if (d.t === 'start') { startRace(d.laps, d.grid, d.track); }
    else if (d.t === 'track') {
      const tid = d.track;
      if (manifest.tracks.some(t => t.id === tid) && tid !== G.trackId) {
        G.trackId = tid; updateLobbyTrack();
        setTrack(tid).then(() => { if (G.trackId === tid && G.mode === 'lobby') spawnMyCar(0); }).catch(() => {});
      }
    }
    else if (d.t === 'finish') { addResult({ id: d.id, name: d.name, time: d.time }); if (G.mode === 'race') toast(d.name + ' llegó: ' + fmt(d.time)); }
    else if (d.t === 'gone') { dropRemote(d.id); }
    else if (d.t === 'hostgone') { clearRemotes(); G.online = false; toMenu(); $('menu-status').textContent = 'El anfitrión cerró la sala.'; }
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
  if (e.code === 'KeyM') audio.toggle();
  if (e.code === 'Escape' && (G.mode === 'race' || G.mode === 'practice')) $('btn-quit').click();
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const touchState = { left: false, right: false, gas: false, back: false };
document.querySelectorAll('#touch button').forEach(b => {
  const k = b.dataset.k;
  const on = e => { e.preventDefault(); touchState[k] = true; b.classList.add('on'); };
  const off = e => { e.preventDefault(); touchState[k] = false; b.classList.remove('on'); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
});
let padRespawnHeld = false;
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
    const y = gp.buttons[3]?.pressed;
    if (y && !padRespawnHeld && G.phys) G.phys.respawn();
    padRespawnHeld = !!y;
    if (gp.buttons[14]?.pressed) steer += 1; if (gp.buttons[15]?.pressed) steer -= 1;
    break;
  }
  return { throttle: Math.max(-1, Math.min(1, throttle)), steer: Math.max(-1, Math.min(1, steer)), handbrake: hb };
}

// ---------- Sonido de motor (sintetizado) ----------
const audio = {
  ctx: null, osc: null, osc2: null, gain: null, muted: store.get('rv.mute', '0') === '1',
  unlock() { if (!this.ctx) { try { this.ctx = new AudioContext(); } catch (e) { return; } } if (this.ctx.state === 'suspended') this.ctx.resume(); },
  start() {
    this.unlock(); if (!this.ctx || this.osc) return;
    const c = this.ctx;
    this.osc = c.createOscillator(); this.osc.type = 'sawtooth';
    this.osc2 = c.createOscillator(); this.osc2.type = 'square';
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    this.gain = c.createGain(); this.gain.gain.value = 0;
    const g2 = c.createGain(); g2.gain.value = 0.3;
    this.osc.connect(lp); this.osc2.connect(g2); g2.connect(lp); lp.connect(this.gain); this.gain.connect(c.destination);
    this.osc.start(); this.osc2.start();
  },
  update(frac, throttle, active) {
    if (!this.osc) return;
    const t = this.ctx.currentTime;
    const f = 70 + frac * 330 + Math.abs(throttle) * 25;
    this.osc.frequency.setTargetAtTime(f, t, 0.05); this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.gain.gain.setTargetAtTime(this.muted || !active ? 0 : 0.05 + Math.abs(throttle) * 0.04, t, 0.08);
  },
  toggle() { this.muted = !this.muted; store.set('rv.mute', this.muted ? '1' : '0'); toast(this.muted ? 'Sonido apagado' : 'Sonido encendido'); },
};

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
const camDir = new THREE.Vector3(0, 0, -1);
let camInit = false, orbit = 0, camY = 0, camDist = 0;
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
  camY += (P.pos.y - camY) * (1 - Math.exp(-dt * 8));
  const base = new THREE.Vector3(P.pos.x, camY, P.pos.z);
  let want, look;
  if (G.camMode === 2) {
    want = P.pos.clone().addScaledVector(camDir, 20).add(new THREE.Vector3(0, 22, 0));
    look = P.pos.clone().addScaledVector(camDir, 400).add(new THREE.Vector3(0, 15, 0));
  } else {
    const sc = carScale();
    const dist = (G.camMode === 0 ? 215 : 340) * sc, hgt = (G.camMode === 0 ? 70 : 120) * sc;
    // que la cámara no atraviese paredes (la distancia se acerca rápido y se aleja despacio)
    const from = base.clone().add(new THREE.Vector3(0, 30, 0));
    const dir = camDir.clone().negate().add(new THREE.Vector3(0, (hgt - 30) / dist, 0)).normalize();
    const full = Math.hypot(dist, hgt - 30);
    const hit = world.bvh.raycastFirst(new THREE.Ray(from, dir), THREE.DoubleSide, 0, full);
    const allowed = hit ? Math.max(30, hit.distance - 12) : full;
    if (!camDist) camDist = allowed;
    camDist = allowed < camDist ? allowed : camDist + (allowed - camDist) * (1 - Math.exp(-dt * 3));
    want = from.addScaledVector(dir, camDist);
    look = base.clone().addScaledVector(camDir, 60).add(new THREE.Vector3(0, 22, 0));
  }
  camPos.copy(want); camLook.copy(look); camInit = true;
  camera.position.copy(camPos); camera.lookAt(camLook);
}

// ---------- Aviso de curvas y tabla de posiciones ----------
// Dirección de la pista (horizontal) en un punto a cierta distancia por delante, según los nodos del recorrido
function pathDirAt(pos, dist) {
  const a = pathAhead(pos, dist), b = pathAhead(pos, dist + 200);
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
  // Si van prácticamente a la par (menos de un auto de diferencia), desempata el id:
  // así todos los navegadores muestran el mismo orden en vez de que cada uno se crea segundo.
  list.sort((a, b) => Math.abs(a.prog - b.prog) < 4e-4 ? (a.id < b.id ? -1 : 1) : b.prog - a.prog);
  const myPos = list.findIndex(x => x.me) + 1;
  $('h-pos').textContent = others.length ? myPos + '°/' + list.length : '';
  const box = $('h-standings');
  box.hidden = !others.length;
  if (!others.length || now - standT < 150) return; // la tabla se redibuja ~7 veces por segundo
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
    if (left <= 0) { G.locked = false; center('¡YA!', 700); G.lap.lapStart = now; }
    else center(String(Math.ceil(left / 1000)), 0);
  }
  const inp = driving && !G.locked ? (window.__autoInput ? window.__autoInput() : readInput()) : { throttle: 0, steer: 0, handbrake: true };
  G.phys.input = inp;

  acc += dt;
  while (acc >= FIXED) {
    // guardar el estado anterior para interpolar el dibujo entre pasos de física
    G.prevPos = G.phys.pos.clone(); G.prevQuat = G.phys.quat.clone();
    G.phys.step(FIXED);
    for (const r of G.remotes.values()) if (r.tpos && now - r.seen < 2000) G.phys.collideCar(r.pos, r.vel, r.radius);
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

  if (driving) updateLaps(now);
  updateCamera(dt);
  if (track) track.sky.position.copy(camera.position);

  // Red: enviar estado 20 veces por segundo
  netT += dt;
  if (net?.active && netT > 0.05) {
    netT = 0;
    const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
    net.send({ t: 'state', car: G.carId, p: [r1(P.pos.x), r1(P.pos.y), r1(P.pos.z)], q: [r3(P.quat.x), r3(P.quat.y), r3(P.quat.z), r3(P.quat.w)],
      v: [r1(P.vel.x), r1(P.vel.y), r1(P.vel.z)], su: P.wheels.map(w => r1(w.suspOffset)), st: P.wheels.map(w => r3(w.steerAngle || 0)), pr: G.mode === 'race' ? progressValue() : 0 });
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
  }
  audio.update(Math.min(1, Math.abs(P.fwdSpeed) / P.top), inp.throttle, driving);
  renderer.render(scene, camera);
}

// ---------- Arranque ----------
async function boot() {
  try {
    let mr = await fetch(BASE + 'manifest.json');
    if (!mr.ok) { BASE = ''; mr = await fetch('manifest.json'); }
    if (!mr.ok) throw new Error('falta manifest.json (subí la carpeta assets o su contenido)');
    manifest = normalizeManifest(await mr.json());
    $('loadmsg').textContent = 'Autos';
    await Promise.all(manifest.cars.map(loadCarParams));
    if (!carDefs.has(G.carId)) G.carId = manifest.cars[0].id;
    if (!manifest.tracks.some(t => t.id === G.trackId)) G.trackId = manifest.tracks[0].id;
    $('loadmsg').textContent = 'Pista: ' + trackDef(G.trackId).name;
    await setTrack(G.trackId);
    await ensureCar(G.carId);
    $('name').value = G.name;
    renderCars();
    renderTrackButtons($('tracksel'));
    await spawnMyCar(0);
    G.mode = 'menu'; show('scr-menu');
    $('loading').hidden = true;
    window.__rv = { G, scene, camera, get world() { return world; }, carDefs, get track() { return track; }, renderer, progressValue, pathFraction, setTrack, ensureCar };
  } catch (e) {
    console.error(e);
    $('loadmsg').textContent = 'No se pudo cargar: ' + e.message + '. Si abriste el archivo con doble clic, tiene que estar subido a una página web (ver LEEME).';
  }
}
requestAnimationFrame(frame);
boot();
