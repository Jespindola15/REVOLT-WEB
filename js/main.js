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

let manifest, track, world, carDefs = new Map();

async function loadTrack() {
  const T = manifest.track, dir = BASE + 'tracks/' + T.id + '/';
  $('loadmsg').textContent = 'Pista: ' + T.name;
  const [wBuf, finBuf, tazBuf, infTxt] = await Promise.all([
    fetchBuf(dir + T.id + '.w'), fetchBuf(dir + T.id + '.fin'), fetchBuf(dir + T.id + '.taz'), fetchText(dir + T.id + '.inf'),
  ]);
  const textures = [];
  await Promise.all(T.pages.map(async p => { textures[p] = await loadTexture(dir + 'tex' + p + '.png'); }));
  const getMat = makeMaterials(textures);
  const inf = parseINF(infTxt);
  const meshes = parseW(wBuf);
  // Instancias (.fin): casas, árboles, postes, rampas...
  const fins = parseFIN(finBuf);
  const prmCache = new Map();
  for (const f of fins) {
    const key = Object.keys(T.instances).find(k => k === f.name) || Object.keys(T.instances).find(k => f.name.startsWith(k) || k.startsWith(f.name));
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
  scene.add(built.group);
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(built.collision, 3));
  const bvh = new MeshBVH(cg);
  world = { bvh };
  const fc = inf.fogColor.map(v => v / 255);
  scene.background = new THREE.Color(fc[0], fc[1], fc[2]);
  scene.fog = new THREE.Fog(scene.background, 9000, Math.max(20000, inf.farClip + 2000));
  const zones = parseTAZ(tazBuf);
  const nZones = Math.max(...zones.map(z => z.id)) + 1;
  await buildSky(dir, T.sky || {});
  let path = null;
  try { path = parsePAN(await fetchBuf(dir + T.id + '.pan')); } catch (e) {}
  track = { inf, zones, nZones, name: T.name, path };
}

// Cielo: caja de 6 caras con las texturas sky_*.bmp de la pista, que acompaña a la cámara
const sky = new THREE.Group();
async function buildSky(dir, files) {
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
  if (sky.children.length) { sky.frustumCulled = false; scene.add(sky); }
}

async function loadCar(def) {
  const dir = BASE + 'cars/' + def.id + '/';
  const [txt, tex] = await Promise.all([fetchText(dir + 'parameters.txt'), loadTexture(dir + 'car.png')]);
  const params = parseCarParams(txt);
  // En los autos cualquier página de textura >= 0 es la textura del auto (TPAGE)
  const carMats = makeMaterials([tex]);
  const getMat = (page, tr) => carMats(page >= 0 ? 0 : -1, tr);
  const prms = {};
  for (const [i, fn] of Object.entries(def.models)) prms[i] = parsePRM(await fetchBuf(dir + fn));
  const body = buildMeshes([{ polys: prms[0].polys, verts: prms[0].verts }], getMat).group;
  const box = new THREE.Box3().setFromObject(body);
  const wheels = [1, 2, 3, 4].map(i => prms[i] ? buildMeshes([{ polys: prms[i].polys, verts: prms[i].verts }], getMat).group : null);
  carDefs.set(def.id, { def, params, body, wheels, box });
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

function spawnMyCar(slot = 0) {
  if (G.vis) G.vis.dispose();
  const cd = carDefs.get(G.carId);
  G.phys = new CarPhysics(cd.params, cd.box, world);
  G.vis = new CarVisual(G.carId);
  const s = gridSlot(slot);
  G.phys.place(s.pos, s.yaw);
}

function resetLaps() {
  G.lap = { cur: track.nZones - 1, started: false, done: 0, lapStart: 0, best: null, finished: false, finishTime: 0, lastZoneT: 0 };
}

// Distancia recorrida dentro de la vuelta (0..1) usando los nodos de recorrido de la pista
function pathFraction() {
  const path = track.path; if (!path) return 0;
  const p = G.phys.pos; const rv = [p.x, -p.y, -p.z];
  // el punto más cercano sobre cualquier tramo nodo -> siguiente
  let bestD = Infinity, dist = 0;
  for (const n of path.nodes) for (const ni of n.next) {
    const nx = path.nodes[ni]; if (!nx) continue;
    const ab = [nx.pos[0] - n.pos[0], nx.pos[1] - n.pos[1], nx.pos[2] - n.pos[2]];
    const ap = [rv[0] - n.pos[0], rv[1] - n.pos[1], rv[2] - n.pos[2]];
    const len2 = Math.max(1, ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2);
    const t = Math.max(0, Math.min(1, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / len2));
    const d2 = (ap[0] - ab[0] * t) ** 2 + (ap[1] - ab[1] * t) ** 2 + (ap[2] - ab[2] * t) ** 2;
    // en el tramo que cruza la meta la distancia "da la vuelta": el nodo de la línea vale la vuelta entera
    if (d2 < bestD) { bestD = d2; const a = nx.dist > n.dist ? path.total : n.dist; dist = a + (nx.dist - a) * t; }
  }
  return Math.max(0, Math.min(0.999, 1 - dist / path.total));
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

function startPractice() {
  G.mode = 'practice'; G.online = false; G.laps = Infinity;
  spawnMyCar(0); show(null); startCountdown(performance.now());
  audio.start();
}

function startRace(laps, grid) {
  G.mode = 'race'; G.laps = laps;
  const idx = Math.max(0, grid.indexOf(net.myId));
  spawnMyCar(idx); show(null); startCountdown(performance.now());
  audio.start();
}

// ---------- Menú ----------
function stat(v, max) { return Math.round(Math.max(6, Math.min(100, v / max * 100))); }
function renderCars() {
  const el = $('cars'); el.innerHTML = '';
  for (const def of manifest.cars) {
    const cd = carDefs.get(def.id); const P = cd.params;
    const top = P.topEnd > 100 ? P.topEnd : P.topSpeed * 85.4;
    const b = document.createElement('button');
    b.className = 'car'; b.type = 'button'; b.setAttribute('aria-pressed', def.id === G.carId);
    b.innerHTML = `<b>${esc(P.name)}</b><span class="bars">
      <span>VEL</span><span class="bar"><i style="width:${stat(top, 3600)}%"></i></span>
      <span>ACC</span><span class="bar"><i style="width:${stat(P.acc, 9)}%"></i></span>
      <span>PESO</span><span class="bar"><i style="width:${stat(P.mass, 2.2)}%"></i></span></span>`;
    b.onclick = () => {
      G.carId = def.id; store.set('rv.car', def.id);
      [...el.children].forEach(c => c.setAttribute('aria-pressed', c === b));
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
  net.send({ t: 'start', laps, grid });
  startRace(laps, grid);
};
$('btn-leave').onclick = () => { net?.close(); net = null; clearRemotes(); G.online = false; toMenu(); };
$('btn-res-back').onclick = () => { if (G.online && net?.active) { G.mode = 'lobby'; show('scr-lobby'); } else toMenu(); };
$('btn-quit').onclick = () => {
  if (G.online && net?.active) { G.mode = 'lobby'; show('scr-lobby'); } else toMenu();
};

function toMenu() { G.mode = 'menu'; G.locked = true; spawnMyCar(0); show('scr-menu'); }

// ---------- Red ----------
function clearRemotes() { for (const r of G.remotes.values()) r.vis.dispose(); G.remotes.clear(); }
function ensureRemote(id, carId, name) {
  let r = G.remotes.get(id);
  if (r && r.carId !== carId && carDefs.has(carId)) { r.vis.dispose(); G.remotes.delete(id); r = null; }
  if (!r) {
    if (!carDefs.has(carId)) carId = 'rc';
    const vis = new CarVisual(carId); vis.setName(name || 'Piloto');
    r = { vis, carId, name, pos: new THREE.Vector3(0, -1e5, 0), quat: new THREE.Quaternion(), vel: new THREE.Vector3(), tpos: null, tquat: new THREE.Quaternion(), prog: 0, susp: [], steer: [], spin: [0, 0, 0, 0], radius: carDefs.get(carId).box.getSize(new THREE.Vector3()).z * 0.5, seen: 0 };
    G.remotes.set(id, r);
  } else if (name && r.name !== name) { r.name = name; r.vis.setName(name); }
  return r;
}
const netHandlers = {
  onStatus: msg => { $('lobby-status').textContent = msg; $('menu-status').textContent = msg; },
  onRoster: list => {
    $('lobby-players').innerHTML = list.map(p => `<li><span>${esc(p.name)}${p.id === net.myId ? ' (vos)' : ''}${p.id === 'host' ? ' ★' : ''}</span><span>${esc(carDefs.get(p.car)?.params.name || p.car)}</span></li>`).join('');
    const ids = new Set(list.map(p => p.id));
    for (const p of list) if (p.id !== net.myId) ensureRemote(p.id, p.car, p.name);
    for (const [id, r] of G.remotes) if (!ids.has(id)) { r.vis.dispose(); G.remotes.delete(id); }
    $('btn-start').disabled = false;
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
    if (d.t === 'start') { startRace(d.laps, d.grid); }
    else if (d.t === 'finish') { addResult({ id: d.id, name: d.name, time: d.time }); if (G.mode === 'race') toast(d.name + ' llegó: ' + fmt(d.time)); }
    else if (d.t === 'gone') { const r = G.remotes.get(d.id); if (r) { r.vis.dispose(); G.remotes.delete(d.id); } }
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
  const cd = carDefs.get(G.carId); if (!cd) return 1;
  let ext = (cd.box.max.z - cd.box.min.z) / 2;
  for (const w of cd.params.wheels) if (w.present) ext = Math.max(ext, Math.abs(w.offset1[2]) + w.radius, Math.abs(w.offset1[0]) + w.radius);
  return Math.max(1, Math.min(2, ext / 55));
}
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camInit = false, orbit = 0;
function updateCamera(dt) {
  if (!G.phys) return;
  // la cámara sigue la posición interpolada (la que se ve), no la de física
  const P = { pos: G.renderPos, quat: G.renderQuat };
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(P.quat); fwd.y *= 0.3; fwd.normalize();
  let want, look;
  if (G.mode === 'menu' || G.mode === 'lobby' || G.mode === 'results') {
    orbit += dt * 0.35;
    const sc = carScale();
    want = P.pos.clone().add(new THREE.Vector3(Math.sin(orbit) * 230 * sc, 75 * sc, Math.cos(orbit) * 230 * sc));
    look = P.pos.clone().add(new THREE.Vector3(0, 10, 0));
  } else if (G.camMode === 2) {
    want = P.pos.clone().addScaledVector(fwd, 20).add(new THREE.Vector3(0, 22, 0));
    look = P.pos.clone().addScaledVector(fwd, 400).add(new THREE.Vector3(0, 15, 0));
  } else {
    const sc = carScale();
    const dist = (G.camMode === 0 ? 215 : 340) * sc, hgt = (G.camMode === 0 ? 70 : 120) * sc;
    want = P.pos.clone().addScaledVector(fwd, -dist).add(new THREE.Vector3(0, hgt, 0));
    look = P.pos.clone().addScaledVector(fwd, 60).add(new THREE.Vector3(0, 22, 0));
  }
  // que la cámara no atraviese paredes
  const from = P.pos.clone().add(new THREE.Vector3(0, 30, 0));
  const dir = want.clone().sub(from); const len = dir.length(); dir.normalize();
  const hit = world.bvh.raycastFirst(new THREE.Ray(from, dir), THREE.DoubleSide, 0, len);
  if (hit && G.camMode !== 2) want = from.addScaledVector(dir, Math.max(30, hit.distance - 12));
  const k = 1 - Math.exp(-dt * (G.camMode === 2 ? 30 : 7));
  if (!camInit) { camPos.copy(want); camLook.copy(look); camInit = true; }
  camPos.lerp(want, k); camLook.lerp(look, 1 - Math.exp(-dt * 12));
  camera.position.copy(camPos); camera.lookAt(camLook);
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
  sky.position.copy(camera.position);

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
      const others = [...G.remotes.values()].filter(r => r.tpos);
      const mine = progressValue();
      const pos = 1 + others.filter(r => (r.prog || 0) > mine).length;
      $('h-pos').textContent = others.length ? pos + '°/' + (others.length + 1) : '';
    } else {
      $('h-lap').textContent = 'VUELTA ' + (L.done + 1);
      $('h-time').textContent = fmt(G.locked || !L.started ? 0 : now - L.lapStart);
      $('h-pos').textContent = '';
    }
    $('h-best').textContent = fmt(L.best);
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
    manifest = await mr.json();
    await loadTrack();
    $('loadmsg').textContent = 'Autos';
    await Promise.all(manifest.cars.map(loadCar));
    if (!carDefs.has(G.carId)) G.carId = manifest.cars[0].id;
    $('name').value = G.name;
    renderCars();
    spawnMyCar(0);
    G.mode = 'menu'; show('scr-menu');
    $('loading').hidden = true;
    window.__rv = { G, scene, camera, world, carDefs, track, renderer, progressValue, pathFraction };
  } catch (e) {
    console.error(e);
    $('loadmsg').textContent = 'No se pudo cargar: ' + e.message + '. Si abriste el archivo con doble clic, tiene que estar subido a una página web (ver LEEME).';
  }
}
requestAnimationFrame(frame);
boot();
