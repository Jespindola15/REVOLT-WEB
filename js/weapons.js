// Armas y bonus de Re-Volt: los bonus están en los mismos lugares que en el juego original
// (objetos "pickup" del archivo .fob de cada pista) y usan los modelos, íconos y efectos originales.
//
// Online: cada compu simula todos los proyectiles (los disparos se avisan por la red) y solo
// aplica los golpes a su propio auto. Así nadie necesita ser "el que manda" y no hay demoras.
import * as THREE from 'three';
import { parsePRM } from './rvformats.js';
import { makeMaterials, buildMeshes } from './build.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _ray = new THREE.Ray();

// bits de efectos que cada jugador manda en su estado (para dibujarlos en los demás)
export const FX_PULSE = 1, FX_ZAP = 2, FX_BOMB = 4, FX_TURBO = 8;

// icon: celda de 32x32 en fxpage2 (íconos originales del juego)
export const WEAPONS = {
  shockwave: { name: 'ONDA EXPANSIVA', icon: [0, 224], shots: 1 },
  firework: { name: 'COHETE', icon: [64, 224], shots: 1 },
  fireworks: { name: '3 COHETES', icon: [96, 224], shots: 3 },
  water: { name: '3 BOMBITAS DE AGUA', icon: [128, 224], shots: 3 },
  putty: { name: 'BOMBA', icon: [32, 224], shots: 1 },
  electro: { name: 'PULSO ELÉCTRICO', icon: [160, 224], shots: 1 },
  oil: { name: 'ACEITE', icon: [192, 224], shots: 1 },
  ball: { name: 'BOLA DE ACERO', icon: [0, 192], shots: 1 },
  turbo: { name: 'TURBO', icon: [32, 192], shots: 1 },
  star: { name: 'PULSO GLOBAL', icon: [96, 192], shots: 1 },
};

// Probabilidad de cada arma según la posición: el que va primero recibe más armas para defenderse,
// el que va último más armas para atacar y recuperar (como en Re-Volt). La estrella, solo atrás.
function pickWeapon(place, total) {
  const back = total > 1 ? (place - 1) / (total - 1) : 0.5; // 0 = primero, 1 = último
  const w = {
    shockwave: 6 + 4 * back, firework: 8 + 4 * back, fireworks: 3 + 6 * back, water: 9,
    putty: 6, electro: 4 + 5 * back, oil: 12 - 6 * back, ball: 7 - 2 * back, turbo: 7 + 6 * back,
    star: total >= 3 && place === total ? 3 : 0,
  };
  let sum = 0; for (const k in w) sum += w[k];
  let r = Math.random() * sum;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return 'turbo';
}

// celdas de las texturas de efectos: [página, x, y, ancho, alto] en píxeles de 256x256
const CELL = {
  smoke: [1, 0, 0, 64, 64], fire: [1, 64, 0, 64, 64], flare: [1, 128, 0, 64, 64],
  ebal: [1, 0, 64, 64, 64], bolt: [1, 64, 64, 64, 64], puff: [1, 128, 64, 64, 64], starf: [1, 192, 64, 64, 64],
  ring: [1, 0, 128, 64, 64], bolt2: [1, 64, 128, 64, 64], disc: [1, 192, 128, 64, 64],
  reticle: [1, 32, 224, 32, 32], spark: [1, 192, 32, 16, 16],
  bomb: [2, 32, 224, 32, 32], bigring: [3, 0, 128, 128, 128],
};
// explosión animada: 16 cuadros de 32x32 en fxpage3
const BOOM = Array.from({ length: 16 }, (_, i) => [3, (i % 8) * 32, 32 + Math.floor(i / 8) * 32, 32, 32]);

const PICKUP_RESPAWN = 5;     // segundos hasta que vuelve a aparecer un bonus
const PICK_RADIUS = 85;

export class Weapons {
  // host: funciones del juego que necesita el sistema de armas (ver main.js)
  constructor(scene, audio, host) {
    this.scene = scene; this.audio = audio; this.host = host;
    this.root = new THREE.Group(); scene.add(this.root);
    this.ready = false;
    this.pickups = []; this.proj = []; this.parts = []; this.auras = new Map();
    this.states = new Map(); this.seq = 0;
    this.maps = new Map(); this.pages = [];
    this.trailT = 0;
  }

  async init(base, fx) {
    if (!fx?.fxpage1 || !fx?.pickup) return; // assets viejos sin armas
    const loader = new THREE.TextureLoader();
    const tex = url => new Promise((res, rej) => loader.load(base + url, t => { t.colorSpace = THREE.NoColorSpace; res(t); }, undefined, rej));
    const [p1, p2, p3] = await Promise.all([tex(fx.fxpage1), tex(fx.fxpage2), tex(fx.fxpage3)]);
    this.pages = [null, p1, p2, p3];
    const model = async name => {
      if (!fx[name]) return null;
      const buf = await (await fetch(base + fx[name])).arrayBuffer();
      const prm = parsePRM(buf);
      return buildMeshes([{ polys: prm.polys, verts: prm.verts }], makeMaterials([])).group;
    };
    [this.mPickup, this.mRocket, this.mWater, this.mStar] = await Promise.all(['pickup', 'firework', 'wbomb', 'star'].map(model));
    // bola de acero: esfera cromada (en el juego original es un reflejo del entorno)
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(44, 40, 4, 64, 64, 64);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.25, '#d8dde6'); grd.addColorStop(0.6, '#6c7380'); grd.addColorStop(0.85, '#2a2e36'); grd.addColorStop(1, '#9aa3b0');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    this.chrome = new THREE.MeshMatcapMaterial({ matcap: new THREE.CanvasTexture(c) });
    this.oilMat = new THREE.MeshBasicMaterial({ color: 0x15110a, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, fog: true });
    this.ready = true;
  }

  map(cell) {
    const key = cell.join(',');
    if (!this.maps.has(key)) {
      const [pg, x, y, w, h] = cell;
      const t = this.pages[pg].clone();
      t.offset.set(x / 256, 1 - (y + h) / 256); t.repeat.set(w / 256, h / 256);
      t.needsUpdate = true;
      this.maps.set(key, t);
    }
    return this.maps.get(key);
  }
  sprite(cell, { size = 100, color = 0xffffff, opacity = 1, additive = true } = {}) {
    const m = new THREE.SpriteMaterial({ map: this.map(cell), color, opacity, transparent: true, depthWrite: false, fog: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    const s = new THREE.Sprite(m); s.scale.set(size, size, 1); s.renderOrder = 5;
    return s;
  }

  // ---------- Estado de armas de cada auto que se simula en esta compu (vos y los rivales de la PC) ----------
  st(id) {
    let s = this.states.get(id);
    if (!s) { s = { held: null, shots: 0, bomb: null, bombCD: 0, pulse: 0, zapCD: 0, fuseT: 0, aiT: 0 }; this.states.set(id, s); }
    return s;
  }
  mine() { const me = this.host.me(); return this.st(me ? me.id : 'me'); }
  get held() { return this.mine().held; }
  get shots() { return this.mine().shots; }
  get bomb() { return this.mine().bomb; }
  get pulse() { return this.mine().pulse; }
  local(id) { return this.host.locals().find(c => c.id === id); }

  // ---------- Bonus en la pista ----------
  setTrack(T) {
    this.clearAll();
    for (const p of this.pickups) this.root.remove(p.obj);
    this.pickups = [];
    if (!this.ready || !T?.pickups) return;
    T.pickups.forEach((pos, i) => {
      const obj = new THREE.Group();
      const m = this.mPickup.clone(); m.scale.setScalar(0.8); obj.add(m);
      const glow = this.sprite(CELL.flare, { size: 150, color: 0xffd060, opacity: 0.8 }); obj.add(glow);
      obj.position.copy(pos);
      this.root.add(obj);
      this.pickups.push({ i, pos: pos.clone(), obj, glow, wait: 0, ph: i * 0.7 });
    });
  }

  // car: auto local que lo agarró (null si lo agarró alguien en otra compu)
  takePickup(i, car) {
    const p = this.pickups[i]; if (!p || p.wait > 0) return;
    p.wait = PICKUP_RESPAWN; p.obj.visible = false;
    for (let k = 0; k < 6; k++) this.part(CELL.spark, p.pos, { vel: new THREE.Vector3((Math.random() - 0.5) * 500, 200 + Math.random() * 400, (Math.random() - 0.5) * 500), life: 0.5, size: 30, size1: 5, color: 0xffd060 });
    if (!car) return;
    const s = this.st(car.id);
    const { place, total } = this.host.place(car.id);
    s.held = pickWeapon(place, total); s.shots = WEAPONS[s.held].shots;
    s.aiT = 0.6 + Math.random() * 1.6; // los rivales de la PC esperan un poquito antes de usarla
    if (car.isMe) this.audio.play('pickup', { vol: 0.8 });
    else this.audio.playAt('pickup', p.pos, { vol: 0.6 });
    this.host.send({ t: 'pk', i });
  }

  // limpia todo lo que está en juego (al empezar una carrera o volver al menú)
  clearAll() {
    for (const p of this.proj) this.disposeObj(p.obj);
    for (const p of this.parts) { this.root.remove(p.s); if (p.frames) p.s.material.map.dispose(); p.s.material.dispose(); }
    for (const a of this.auras.values()) this.root.remove(a.grp);
    this.proj = []; this.parts = []; this.auras.clear(); this.states.clear();
    for (const p of this.pickups) { p.wait = 0; p.obj.visible = true; }
    if (this.reticle) this.reticle.visible = false;
  }
  disposeObj(o) { if (o) this.root.remove(o); }

  // ---------- Partículas ----------
  part(cell, pos, { vel = null, life = 0.6, size = 60, size1 = null, color = 0xffffff, opacity = 1, additive = true, frames = null, grav = 0 } = {}) {
    if (this.parts.length > 350) return;
    const s = this.sprite(frames ? frames[0] : cell, { size, color, opacity, additive });
    if (frames) { s.material.map = this.map(frames[0]).clone(); s.material.map.needsUpdate = true; }
    s.position.copy(pos); s.material.rotation = Math.random() * Math.PI * 2;
    this.root.add(s);
    this.parts.push({ s, vel: vel ? vel.clone() : null, t: 0, life, size, size1: size1 ?? size, op: opacity, frames, grav });
  }
  updateParts(dt) {
    for (const p of this.parts) {
      p.t += dt;
      const k = Math.min(1, p.t / p.life);
      if (p.vel) { if (p.grav) p.vel.y -= p.grav * dt; p.s.position.addScaledVector(p.vel, dt); }
      const sz = p.size + (p.size1 - p.size) * k; p.s.scale.set(sz, sz, 1);
      if (p.frames) {
        const f = p.frames[Math.min(p.frames.length - 1, Math.floor(k * p.frames.length))];
        p.s.material.map.offset.set(f[1] / 256, 1 - (f[2] + f[4]) / 256);
      } else p.s.material.opacity = p.op * (1 - k * k);
    }
    const keep = [];
    for (const p of this.parts) {
      if (p.t < p.life) { keep.push(p); continue; }
      this.root.remove(p.s); if (p.frames) p.s.material.map.dispose(); p.s.material.dispose();
    }
    this.parts = keep;
  }
  // chispas de un choque (contra la pista o contra otro auto)
  sparks(pos, strength = 1) {
    if (!this.ready) return;
    const n = Math.round(3 + strength * 9);
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 900, 150 + Math.random() * 600, (Math.random() - 0.5) * 900).multiplyScalar(0.5 + strength * 0.6);
      this.part(CELL.spark, pos, { vel: v, grav: 2600, life: 0.25 + Math.random() * 0.3, size: 14 + strength * 10, size1: 3, color: k % 3 ? 0xffc060 : 0xfff0c0 });
    }
  }
  explosion(pos, size = 1) {
    this.part(null, pos, { frames: BOOM, life: 0.7, size: 200 * size, size1: 330 * size, additive: true });
    this.part(CELL.flare, pos, { life: 0.25, size: 420 * size, size1: 200 * size, color: 0xffe0a0 });
    for (let k = 0; k < 5; k++) this.part(CELL.smoke, pos, { vel: new THREE.Vector3((Math.random() - 0.5) * 300, 150 + Math.random() * 200, (Math.random() - 0.5) * 300), life: 1.2, size: 90 * size, size1: 260 * size, color: 0x707070, opacity: 0.6 });
  }

  // todos los autos de la carrera (locales y de otras compus), para choques y blancos
  allCars() {
    const list = this.host.others().filter(o => o.visible).map(o => ({ id: o.id, pos: o.pos, vel: o.vel, quat: o.quat, fx: o.fx | 0, remote: true }));
    for (const c of this.host.locals()) list.push({ id: c.id, pos: c.pos, vel: c.phys.vel, quat: c.quat, local: c, fx: this.fxBits(c) });
    return list;
  }

  // ---------- Disparar ----------
  // auto del frente más cercano para los cohetes (dentro de un cono hacia adelante)
  findTarget(car, maxDist = 7000, minCos = 0.55) {
    const fwd = _v.set(0, 0, -1).applyQuaternion(car.quat); fwd.y = 0; fwd.normalize();
    let best = null, bs = Infinity;
    for (const o of this.allCars()) {
      if (o.id === car.id) continue;
      const d = _w.copy(o.pos).sub(car.pos); const dist = d.length();
      if (dist < 60 || dist > maxDist) continue;
      d.y = 0; const cos = d.normalize().dot(fwd);
      if (cos < minCos) continue;
      const score = dist * (2 - cos);
      if (score < bs) { bs = score; best = o.id; }
    }
    return best;
  }
  // ¿hay un auto atrás, cerca? (para el aceite y la bola)
  someoneBehind(car, maxDist) {
    const fwd = _v.set(0, 0, -1).applyQuaternion(car.quat); fwd.y = 0; fwd.normalize();
    return this.allCars().some(o => {
      if (o.id === car.id) return false;
      const d = _w.copy(o.pos).sub(car.pos); const dist = d.length(); if (dist > maxDist || dist < 1) return false;
      d.y = 0; return d.normalize().dot(fwd) < -0.6;
    });
  }
  nearest(car) {
    let best = Infinity;
    for (const o of this.allCars()) if (o.id !== car.id) best = Math.min(best, o.pos.distanceTo(car.pos));
    return best;
  }

  fire(car = this.host.me()) {
    if (!this.ready || !car?.active) return;
    const s = this.st(car.id);
    const k = s.held; if (!k) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(car.quat);
    const flat = fwd.clone(); flat.y = 0; flat.normalize();
    const front = car.pos.clone().addScaledVector(fwd, 70).addScaledVector(UP, 25);
    const sid = car.id + ':' + (++this.seq);
    const snd = (name, vol) => car.isMe ? this.audio.play(name, { vol }) : this.audio.playAt(name, car.pos, { vol });
    const shoot = (kind, p, v, tg = null) => {
      this.spawn(kind, car.id, sid, p, v, tg);
      this.host.send({ t: 'wf', k: kind, sid, p: arr(p), v: arr(v), tg });
    };
    if (k === 'firework' || k === 'fireworks') {
      shoot('rocket', front, flat.clone().multiplyScalar(3800), this.findTarget(car));
      snd('firefire', 0.9);
    } else if (k === 'shockwave') {
      shoot('shock', car.pos.clone().addScaledVector(flat, 80), flat.clone().multiplyScalar(3000));
      snd('shockfire', 0.9);
    } else if (k === 'water') {
      const v = car.phys.vel.clone().add(flat.clone().multiplyScalar(1700)).addScaledVector(UP, 650);
      shoot('water', front, v);
      snd('wbombfire', 0.8);
    } else if (k === 'oil') {
      shoot('oil', car.pos.clone().addScaledVector(flat, -90), new THREE.Vector3());
      snd('oildrop', 0.9);
    } else if (k === 'ball') {
      shoot('ball', front, car.phys.vel.clone().add(flat.clone().multiplyScalar(700)));
      snd('balldrop', 0.9);
    } else if (k === 'turbo') {
      car.phys.fx.turbo = 4; snd('turbo', 0.9);
    } else if (k === 'electro') {
      s.pulse = 6; snd('electro', 0.8);
    } else if (k === 'putty') {
      s.bomb = { left: 5 }; s.bombCD = 0.8; s.fuseT = 0; snd('fuse', 0.8);
    } else if (k === 'star') {
      const pr = this.host.prog(car.id);
      this.host.send({ t: 'gp', pr });
      this.globalPulse(car.id, pr);
      this.part(CELL.bigring, car.pos, { life: 0.9, size: 200, size1: 4000, color: 0xffe080 });
      snd('starfire', 1);
    }
    if (--s.shots <= 0) { s.held = null; s.shots = 0; }
  }

  // pulso global: electrocuta a los autos locales que van adelante del que lo usó
  globalPulse(fromId, pr) {
    for (const c of this.host.locals()) {
      if (c.id === fromId || !c.active) continue;
      if (this.host.prog(c.id) > pr) { this.zap(c, 3.2); if (c.isMe) this.host.toast('¡PULSO GLOBAL!'); }
    }
  }

  spawn(kind, owner, sid, p, v, tg) {
    if (!this.ready) return;
    const pr = { kind, owner, sid, pos: p.clone(), vel: v.clone(), tg, t: 0, obj: null, dead: false };
    if (kind === 'rocket') {
      pr.obj = this.mRocket.clone(); this.root.add(pr.obj);
      pr.glow = this.sprite(CELL.flare, { size: 90, color: 0xffa040 }); pr.obj.add(pr.glow);
    } else if (kind === 'shock') {
      pr.obj = new THREE.Group();
      pr.ball = this.sprite(CELL.ebal, { size: 170, color: 0x80c0ff }); pr.obj.add(pr.ball);
      pr.obj.add(this.sprite(CELL.flare, { size: 220, color: 0x5080ff, opacity: 0.8 }));
      this.root.add(pr.obj);
    } else if (kind === 'water') {
      pr.obj = this.mWater.clone(); pr.obj.scale.setScalar(0.55); this.root.add(pr.obj);
    } else if (kind === 'oil') {
      // la mancha queda pegada al piso
      _ray.origin.copy(p).addScaledVector(UP, 120); _ray.direction.set(0, -1, 0);
      const hit = this.host.bvh().raycastFirst(_ray, THREE.DoubleSide, 0, 600);
      const n = hit ? hit.face.normal.clone() : UP.clone(); if (n.y < 0) n.negate();
      if (hit) pr.pos.copy(hit.point);
      pr.obj = new THREE.Mesh(new THREE.CircleGeometry(100, 28), this.oilMat);
      pr.obj.position.copy(pr.pos).addScaledVector(n, 1.5);
      pr.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      pr.obj.renderOrder = 1;
      this.root.add(pr.obj);
    } else if (kind === 'ball') {
      pr.R = 48;
      pr.obj = new THREE.Mesh(new THREE.SphereGeometry(pr.R, 24, 16), this.chrome); this.root.add(pr.obj);
    }
    if (pr.obj) pr.obj.position.copy(pr.pos);
    this.proj.push(pr);
  }

  // ---------- Golpes a los autos locales ----------
  hitCar(c, kind, from, dir) {
    if (!c?.active) return;
    const P = c.phys;
    if (kind === 'boom') {
      const d = c.pos.distanceTo(from); if (d > 300) return;
      const f = 1 - d / 300;
      const out = c.pos.clone().sub(from); out.y = 0; if (out.lengthSq() < 1) out.set(1, 0, 0); out.normalize();
      P.blast(out.multiplyScalar(650 * f).addScaledVector(UP, 1500 * f), 7 * f);
      if (c.isMe) this.host.shake?.(0.5 * f);
    } else if (kind === 'shock') {
      P.blast(dir.clone().multiplyScalar(2100).addScaledVector(UP, 1050), 9);
      if (c.isMe) this.host.shake?.(0.6);
    } else if (kind === 'splash') {
      const d = c.pos.distanceTo(from); if (d > 210) return;
      const f = 1 - d / 210;
      P.vel.x *= 1 - 0.65 * f; P.vel.z *= 1 - 0.65 * f;
      P.blast(new THREE.Vector3(0, 650 * f, 0), 4 * f);
    }
  }
  hitLocals(kind, from, dir) { for (const c of this.host.locals()) this.hitCar(c, kind, from, dir); }

  updateProj(dt) {
    const bvh = this.host.bvh(); if (!bvh) return;
    const cars = this.allCars();
    const locals = this.host.locals();
    const canHit = (pr, c) => !(c.id === pr.owner && pr.t < 0.35);
    for (const pr of this.proj) {
      if (pr.dead) continue;
      pr.t += dt;
      if (pr.kind === 'rocket') {
        const speed = pr.vel.length() || 3800;
        const dir = pr.vel.clone().divideScalar(speed);
        const tgt = pr.tg != null ? cars.find(c => c.id === pr.tg) : null;
        if (tgt) {
          const want = tgt.pos.clone().addScaledVector(UP, 12).sub(pr.pos).normalize();
          if (want.dot(dir) > -0.2) dir.lerp(want, Math.min(1, 4.5 * dt)).normalize();
        }
        pr.vel.copy(dir).multiplyScalar(speed);
        const step = speed * dt;
        _ray.origin.copy(pr.pos); _ray.direction.copy(dir);
        const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, step + 10);
        if (hit) { this.boom(pr, hit.point); continue; }
        const from = pr.pos.clone();
        pr.pos.addScaledVector(dir, step);
        const c = cars.find(c => canHit(pr, c) && segDist(from, pr.pos, c.pos) < 80);
        if (c) { this.boom(pr, c.pos.clone().add(from.sub(c.pos).setLength(40))); continue; }
        if (pr.t > 4) { this.boom(pr, pr.pos); continue; }
        pr.obj.position.copy(pr.pos);
        pr.obj.quaternion.setFromUnitVectors(UP, dir.clone().negate());
        if ((pr.trail = (pr.trail || 0) + dt) > 0.025) {
          pr.trail = 0;
          this.part(CELL.smoke, pr.pos, { life: 0.6, size: 30, size1: 90, color: 0x9a9a9a, opacity: 0.5 });
        }
      } else if (pr.kind === 'shock') {
        const dir = _v.copy(pr.vel); dir.y = 0; const sp = dir.length() || 1; dir.divideScalar(sp);
        const step = sp * dt;
        _ray.origin.copy(pr.pos); _ray.direction.copy(dir);
        const wall = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, step + 50);
        if (wall && Math.abs(wall.face.normal.y) < 0.6) { this.fizzle(pr, wall.point); continue; }
        const from = pr.pos.clone();
        pr.pos.addScaledVector(dir, step);
        // va pegada al piso
        _ray.origin.copy(pr.pos).addScaledVector(UP, 160); _ray.direction.set(0, -1, 0);
        const g = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 500);
        if (g) pr.pos.y += (g.point.y + 45 - pr.pos.y) * Math.min(1, 12 * dt); else pr.pos.y -= 900 * dt;
        pr.obj.position.copy(pr.pos);
        pr.ball.material.rotation += dt * 8;
        const c = cars.find(c => canHit(pr, c) && segDist(from, pr.pos, c.pos) < 125);
        if (c) {
          if (c.local) this.hitCar(c.local, 'shock', pr.pos, dir.clone());
          this.audio.playAt('shock', pr.pos, { vol: 1 });
          this.part(CELL.ring, pr.pos, { life: 0.4, size: 120, size1: 500, color: 0x80c0ff });
          this.kill(pr); continue;
        }
        if (pr.t > 2.6) { this.fizzle(pr, pr.pos); continue; }
      } else if (pr.kind === 'water') {
        pr.vel.y -= 2200 * dt;
        const sp = pr.vel.length(), dir = _v.copy(pr.vel).divideScalar(sp || 1);
        _ray.origin.copy(pr.pos); _ray.direction.copy(dir);
        const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, sp * dt + 15);
        if (hit) { this.splash(pr, hit.point); continue; }
        const from = pr.pos.clone();
        pr.pos.addScaledVector(pr.vel, dt);
        const c = cars.find(c => canHit(pr, c) && segDist(from, pr.pos, c.pos) < 85);
        if (c || pr.t > 5) { this.splash(pr, pr.pos); continue; }
        pr.obj.position.copy(pr.pos); pr.obj.rotation.x += dt * 6; pr.obj.rotation.z += dt * 4;
      } else if (pr.kind === 'oil') {
        for (const c of locals) {
          if (!c.active) continue;
          const dx = c.pos.x - pr.pos.x, dz = c.pos.z - pr.pos.z;
          if (dx * dx + dz * dz < 105 * 105 && Math.abs(c.pos.y - pr.pos.y) < 90) {
            if (c.phys.fx.oil <= 0 && c.isMe) this.audio.play('skid_rough', { vol: 0.7 });
            c.phys.fx.oil = 0.9;
          }
        }
        if (pr.t > 25) this.kill(pr);
        else if (pr.t > 23) pr.obj.material = this.oilFade || (this.oilFade = this.oilMat.clone(), this.oilFade.opacity = 0.4, this.oilFade);
      } else if (pr.kind === 'ball') {
        this.updateBall(pr, dt, bvh, cars);
        if (pr.t > 20) { this.fizzle(pr, pr.pos); continue; }
      }
    }
    if (this.proj.some(p => p.dead)) this.proj = this.proj.filter(p => !p.dead);
  }

  updateBall(pr, dt, bvh, cars) {
    const R = pr.R, target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    const sub = 3, h = dt / sub;
    for (let i = 0; i < sub; i++) {
      pr.vel.y -= 2200 * h;
      pr.pos.addScaledVector(pr.vel, h);
      const res = bvh.closestPointToPoint(pr.pos, target, 0, R);
      if (res && res.distance < R) {
        const n = _v.copy(pr.pos).sub(res.point); const d = n.length();
        if (d > 1e-3) {
          n.divideScalar(d); pr.pos.addScaledVector(n, R - d);
          const vn = pr.vel.dot(n); if (vn < 0) pr.vel.addScaledVector(n, -vn * 1.3);
          pr.vel.multiplyScalar(1 - 0.25 * h);
        }
      }
    }
    for (const c of cars) {
      const n = _w.copy(pr.pos).sub(c.pos); const d = n.length(), minD = R + 45;
      if (d >= minD || d < 1e-3) continue;
      n.divideScalar(d);
      pr.pos.addScaledVector(n, (minD - d) * 0.5);
      const vr = _v.copy(pr.vel).sub(c.vel).dot(n);
      if (vr < 0) pr.vel.addScaledVector(n, -vr * 1.5);
      if (c.local?.active) {
        const hit = c.local.phys.collideWithCar({ pos: pr.pos, quat: new THREE.Quaternion(), vel: pr.vel, spheres: [{ c: new THREE.Vector3(), r: R }], mass: 3 });
        if (hit > 300 && c.local.isMe) this.audio.hit(Math.min(1, hit / 1500));
      }
    }
    pr.obj.position.copy(pr.pos);
    const sp = Math.hypot(pr.vel.x, pr.vel.z);
    if (sp > 1) pr.obj.rotateOnWorldAxis(_v.set(pr.vel.z, 0, -pr.vel.x).normalize(), sp * dt / R);
  }

  kill(pr) { pr.dead = true; this.disposeObj(pr.obj); }
  boom(pr, at) {
    const p = at.clone(); this.kill(pr);
    this.explosion(p, 1);
    this.audio.playAt('firebang', p, { vol: 1 });
    this.hitLocals('boom', p);
  }
  splash(pr, at) {
    const p = at.clone(); this.kill(pr);
    for (let k = 0; k < 8; k++) this.part(CELL.puff, p, { vel: new THREE.Vector3((Math.random() - 0.5) * 600, 300 + Math.random() * 400, (Math.random() - 0.5) * 600), grav: 1800, life: 0.7, size: 50, size1: 110, color: 0x7fb4ff, opacity: 0.8 });
    this.audio.playAt('wbombhit', p, { vol: 1 });
    this.hitLocals('splash', p);
  }
  fizzle(pr, at) {
    const p = at.clone(); this.kill(pr);
    this.part(CELL.puff, p, { life: 0.5, size: 80, size1: 200, color: 0xa0c0ff, opacity: 0.7 });
  }

  // ---------- Efectos ----------
  fxBits(c) {
    if (!c) return 0;
    const s = this.st(c.id);
    return (s.pulse > 0 ? FX_PULSE : 0) | (c.phys.fx.zap > 0 ? FX_ZAP : 0) | (s.bomb ? FX_BOMB : 0) | (c.phys.fx.turbo > 0 ? FX_TURBO : 0);
  }
  myFxBits() { return this.fxBits(this.host.me()); }

  // dos autos se tocaron (lo llama main.js): si el local tiene la bomba, se la pasa al otro
  onCarContact(fromId, otherId) {
    const s = this.st(fromId);
    if (!s.bomb || s.bombCD > 0) return;
    const other = this.local(otherId);
    if (other) {
      const so = this.st(otherId);
      if (so.bomb) return;
      so.bomb = { left: Math.max(1.5, s.bomb.left) }; so.bombCD = 0.8;
      if (other.isMe) this.host.toast('¡Te pasaron la bomba! Chocá a alguien');
    } else this.host.send({ t: 'pb', to: otherId, left: s.bomb.left });
    s.bomb = null;
    if (this.local(fromId)?.isMe) this.host.toast('¡Le pasaste la bomba!');
  }

  zap(c, sec) {
    if (!c?.active) return;
    if (c.phys.fx.zap <= 0) c.isMe ? this.audio.play('electrozap', { vol: 0.9 }) : this.audio.playAt('electrozap', c.pos, { vol: 0.7 });
    c.phys.fx.zap = Math.max(c.phys.fx.zap, sec);
  }

  updateLocal(c, dt, cars) {
    const s = this.st(c.id);
    if (s.bombCD > 0) s.bombCD -= dt;
    if (s.zapCD > 0) s.zapCD -= dt;
    if (s.pulse > 0) s.pulse = Math.max(0, s.pulse - dt);
    if (!c.active) return;
    if (s.bomb) {
      s.bomb.left -= dt;
      if ((s.fuseT -= dt) <= 0) { s.fuseT = 1; c.isMe ? this.audio.play('fuse', { vol: 0.5 }) : this.audio.playAt('fuse', c.pos, { vol: 0.4 }); }
      if (s.bomb.left <= 0) {
        s.bomb = null;
        const p = c.pos.clone().addScaledVector(UP, 20);
        this.explosion(p, 1.4);
        this.audio.playAt('puttbang', p, { vol: 1 });
        this.host.send({ t: 'wb', p: arr(p) });
        c.phys.blast(new THREE.Vector3((Math.random() - 0.5) * 500, 1900, (Math.random() - 0.5) * 500), 10);
        if (c.isMe) this.host.shake?.(0.8);
      }
    }
    // pulso eléctrico de otro auto cerca: se apaga el motor
    for (const o of cars) {
      if (o.id === c.id || !(o.fx & FX_PULSE)) continue;
      if (o.pos.distanceTo(c.pos) < 430 && s.zapCD <= 0) { this.zap(c, 2.2); s.zapCD = 2.6; }
    }
    // rivales de la PC: deciden cuándo usar el arma
    if (!c.isMe && s.held) {
      if ((s.aiT -= dt) > 0) return;
      const k = s.held;
      let go = false;
      if (k === 'firework' || k === 'fireworks') go = !!this.findTarget(c, 5000);
      else if (k === 'shockwave') go = !!this.findTarget(c, 1800, 0.85);
      else if (k === 'water') go = !!this.findTarget(c, 1100, 0.8);
      else if (k === 'oil' || k === 'ball') go = this.someoneBehind(c, 1300);
      else if (k === 'electro') go = this.nearest(c) < 700;
      else if (k === 'turbo') go = c.straight !== false;
      else go = true; // bomba y estrella
      if (!go && s.aiT < -12) go = true; // no guardarla para siempre
      if (go) { this.fire(c); s.aiT = 0.5 + Math.random(); }
    }
  }

  // ---------- Red ----------
  onNet(d) {
    if (!this.ready) return;
    const me = this.host.me();
    if (d.t === 'pk') this.takePickup(d.i, null);
    else if (d.t === 'wf') {
      if (!WEAPON_KINDS.has(d.k) || this.local(d.id)) return;
      this.spawn(d.k, d.id, d.sid, vec(d.p), vec(d.v), d.tg ?? null);
      const p = vec(d.p);
      this.audio.playAt({ rocket: 'firefire', shock: 'shockfire', water: 'wbombfire', oil: 'oildrop', ball: 'balldrop' }[d.k], p, { vol: 0.9 });
    } else if (d.t === 'pb') {
      const c = this.local(d.to);
      if (c && !this.st(c.id).bomb) {
        const s = this.st(c.id); s.bomb = { left: Math.max(1.5, +d.left || 3) }; s.bombCD = 0.8;
        if (c.isMe) this.host.toast('¡Te pasaron la bomba! Chocá a alguien');
      }
    } else if (d.t === 'wb') {
      // explotó la bomba de otro jugador: solo el efecto (el golpe ya se lo dio él mismo)
      const p = vec(d.p); this.explosion(p, 1.4); this.audio.playAt('puttbang', p, { vol: 1 });
    } else if (d.t === 'gp') {
      this.globalPulse(d.id, +d.pr || 0);
      this.audio.play('starfire', { vol: 0.6 });
    }
    void me;
  }

  // ---------- Dibujo de efectos en los autos ----------
  updateAuras(dt, now) {
    const list = this.host.others().map(o => ({ id: o.id, pos: o.pos, bits: o.visible ? o.fx | 0 : 0 }));
    for (const c of this.host.locals()) list.push({ id: c.id, pos: c.renderPos || c.pos, bits: this.fxBits(c) });
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      let a = this.auras.get(c.id);
      if (!c.bits && !a) continue;
      if (!a) {
        a = { grp: new THREE.Group() };
        a.pulse = this.sprite(CELL.ebal, { size: 260, color: 0x6090ff, opacity: 0.6 });
        a.zap = this.sprite(CELL.bolt, { size: 140, color: 0xb0d0ff });
        a.bomb = this.sprite(CELL.bomb, { size: 40, additive: false });
        a.fuse = this.sprite(CELL.flare, { size: 50, color: 0xffa040 });
        a.turbo = this.sprite(CELL.fire, { size: 90, color: 0x80b0ff, opacity: 0.8 });
        a.grp.add(a.pulse, a.zap, a.bomb, a.fuse, a.turbo);
        this.root.add(a.grp); this.auras.set(c.id, a);
      }
      a.grp.position.copy(c.pos);
      a.pulse.visible = !!(c.bits & FX_PULSE); a.pulse.material.rotation += dt * 3;
      a.zap.visible = !!(c.bits & FX_ZAP) && Math.random() < 0.7;
      if (a.zap.visible) { a.zap.material.rotation = Math.random() * 6.28; a.zap.position.set((Math.random() - 0.5) * 40, 20 + Math.random() * 20, (Math.random() - 0.5) * 40); }
      a.bomb.visible = a.fuse.visible = !!(c.bits & FX_BOMB);
      a.bomb.position.set(0, 62 + Math.sin(now / 150) * 4, 0); a.fuse.position.set(9, 78, 0); a.fuse.material.opacity = 0.5 + Math.random() * 0.5;
      a.turbo.visible = !!(c.bits & FX_TURBO); a.turbo.position.set(0, 18, 0); a.turbo.material.opacity = 0.5 + Math.random() * 0.4;
    }
    for (const [id, a] of this.auras) if (!seen.has(id)) { this.root.remove(a.grp); this.auras.delete(id); }
  }

  update(dt, now) {
    if (!this.ready) return;
    const locals = this.host.locals();
    // bonus: giran, flotan y reaparecen
    for (const p of this.pickups) {
      if (p.wait > 0) { p.wait -= dt; if (p.wait <= 0) { p.obj.visible = true; } continue; }
      p.obj.rotation.y += dt * 2.2;
      p.obj.position.y = p.pos.y + Math.sin(now / 400 + p.ph) * 6;
      p.glow.material.opacity = 0.55 + Math.sin(now / 180 + p.ph) * 0.25;
      for (const c of locals) {
        const s = this.st(c.id);
        if (c.active && !s.held && !s.bomb && c.pos.distanceTo(p.pos) < PICK_RADIUS) { this.takePickup(p.i, c); break; }
      }
    }
    const cars = this.allCars();
    for (const c of locals) this.updateLocal(c, dt, cars);
    this.updateProj(dt);
    this.updateParts(dt);
    this.updateAuras(dt, now);
    // mira sobre el auto que van a perseguir los cohetes
    if (!this.reticle) { this.reticle = this.sprite(CELL.reticle, { size: 110, color: 0xff4040, additive: false }); this.reticle.visible = false; this.root.add(this.reticle); }
    const me = this.host.me();
    const aiming = me?.active && (this.held === 'firework' || this.held === 'fireworks');
    const tid = aiming ? this.findTarget(me) : null;
    const t = tid != null ? cars.find(o => o.id === tid) : null;
    this.reticle.visible = !!t;
    if (t) { this.reticle.position.copy(t.pos).addScaledVector(UP, 25); this.reticle.material.rotation += dt * 2; }
  }
}

// distancia de un punto al tramo a-b (para no "atravesar" autos cuando un cuadro tarda mucho)
function segDist(a, b, p) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + abx * t - p.x, a.y + aby * t - p.y, a.z + abz * t - p.z);
}
const WEAPON_KINDS = new Set(['rocket', 'shock', 'water', 'oil', 'ball']);
const r1 = v => Math.round(v * 10) / 10;
function arr(v) { return [r1(v.x), r1(v.y), r1(v.z)]; }
function vec(a) { return Array.isArray(a) ? new THREE.Vector3(+a[0] || 0, +a[1] || 0, +a[2] || 0) : new THREE.Vector3(); }
