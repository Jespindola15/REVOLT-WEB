// Rivales de la computadora: siguen el recorrido de la pista (los nodos .pan del juego original),
// frenan antes de las curvas según lo cerradas que sean, se destraban marcha atrás y usan armas.
import * as THREE from 'three';

const _f = new THREE.Vector3(), _t = new THREE.Vector3();

export const DIFFICULTY = {
  facil: { name: 'Fácil', skill: 0.8, spread: 0.06 },
  normal: { name: 'Normal', skill: 0.89, spread: 0.06 },
  dificil: { name: 'Difícil', skill: 0.97, spread: 0.04 },
};

const TUNE_R = 350; // distancia para medir el radio de las curvas

// Recorrido de IA (nodos .fan): línea de carrera con los bordes de la pista y bifurcaciones
export class AiPath {
  constructor(fan) {
    const V = p => new THREE.Vector3(p[0], -p[1], -p[2]);
    this.nodes = fan.map(n => {
      const a = V(n.a), b = V(n.b), w = a.distanceTo(b);
      // la línea de carrera original va pegada a los cordones: se la separa un poco del borde
      const m = Math.min(0.45, 95 / Math.max(1, w));
      const line = Math.min(1 - m, Math.max(m, n.line));
      return { a, b, p: a.clone().lerp(b, line), w, lineOff: (line - 0.5) * w, next: n.next, prev: n.prev, dist: n.dist, prio: n.priority };
    });
    this.total = Math.max(1, ...this.nodes.map(n => n.dist));
    // "memoria" de la pista: cuánto hay que aflojar en cada nodo (1 = nada). Se aprende con los choques.
    this.slow = new Float32Array(this.nodes.length).fill(1);
    this.learned = 0;
    // radio de la curva en cada nodo (con el anterior y el siguiente), para saber a qué velocidad se puede pasar
    const N = this.nodes;
    // puntos a ~350 unidades para atrás y para adelante (con nodos muy juntos los vecinos inmediatos dan curvas falsas)
    const walk = (i, dir, dist) => {
      let j = i, d = 0;
      for (let g = 0; g < 30 && d < dist; g++) {
        const nx = dir > 0 ? N[j].next[0] : N[j].prev[0];
        if (nx == null) break;
        d += N[j].p.distanceTo(N[nx].p); j = nx;
      }
      return j;
    };
    const raw = N.map((n, i) => {
      if (!n.prev.length || !n.next.length) return 1e5;
      const a = N[walk(i, -1, TUNE_R)].p, b = n.p, c = N[walk(i, 1, TUNE_R)].p;
      const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
      const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      return area2 < 1e-3 ? 1e5 : Math.min(1e5, (ab * bc * ca) / (2 * area2));
    });
    // suavizado: los nodos no están parejos, así que se usa el promedio con los vecinos (sin pasar del propio)
    N.forEach((n, i) => {
      const nb = [...n.prev.slice(0, 1), ...n.next.slice(0, 1)].map(j => raw[j]);
      const avg = nb.length ? (raw[i] + nb.reduce((x, y) => x + y, 0)) / (nb.length + 1) : raw[i];
      n.R = Math.min(raw[i] * 1.6, avg);
    });
  }
  // un rival chocó en este tramo: la próxima vez se entra más despacio (la memoria la comparten todos)
  learnCrash(st, strength = 1) {
    if (st.from == null) return;
    const N = this.nodes, mark = new Set([st.from, st.to]);
    let f = [st.from]; for (let k = 0; k < 2; k++) { const nf = []; for (const i of f) for (const j of N[i].prev) { mark.add(j); nf.push(j); } f = nf; }
    f = [st.to]; for (let k = 0; k < 2; k++) { const nf = []; for (const i of f) for (const j of N[i].next) { mark.add(j); nf.push(j); } f = nf; }
    for (const j of mark) this.slow[j] = Math.max(0.5, this.slow[j] * (1 - 0.08 * strength));
    this.learned++;
  }
  // memoria guardada (array de números por nodo)
  loadMemory(arr) {
    if (!Array.isArray(arr) || arr.length !== this.slow.length) return false;
    arr.forEach((v, i) => { this.slow[i] = Math.max(0.5, Math.min(1, +v || 1)); });
    return true;
  }
  // con cada vuelta sin problemas se va recuperando un poquito la confianza (para no quedar lentos para siempre)
  relax(k = 0.004) { for (let i = 0; i < this.slow.length; i++) this.slow[i] = Math.min(1, this.slow[i] + k); }
  memory() { return Array.from(this.slow, v => Math.round(v * 1000) / 1000); }
  halfWidth(st) { return st.from == null ? 300 : this.nodes[st.from].w / 2; }
  // cuánto se puede correr el auto a cada lado de la línea sin salirse de la pista (margen = medio auto + un poco)
  room(st, margin) {
    if (st.from == null) return [-150, 150];
    const n = this.nodes[st.from], m = this.nodes[st.to] || n;
    const half = Math.min(n.w, m.w) / 2 - margin, lo = (n.lineOff + m.lineOff) / 2;
    if (half <= 0) return [0, 0];
    return [-half - lo, half - lo].map(v => Math.max(-half * 2, Math.min(half * 2, v))).sort((x, y) => x - y);
  }
  // radio de la curva más cerrada en los próximos "dist" (para mirar más cerca en las horquillas)
  minRadius(st, dist) {
    const N = this.nodes;
    if (st.from == null) return 1e5;
    let a = st.from, b = st.to, d = 0, r = 1e5;
    for (let guard = 0; guard < 20 && d < dist; guard++) {
      r = Math.min(r, N[b].R);
      d += N[a].p.distanceTo(N[b].p); a = b; b = this.nextOf(b, st); if (b == null) break;
    }
    return r;
  }
  // velocidad máxima para llegar bien a las próximas curvas: v² = v_curva² + 2·frenada·distancia
  speedLimit(st, alat, decel, maxLook) {
    const N = this.nodes;
    if (st.from == null) return Infinity;
    let a = st.from, b = st.to;
    let d = N[a].p.distanceTo(N[b].p) * (1 - st.t);
    let lim = Infinity;
    for (let guard = 0; guard < 40 && d < maxLook; guard++) {
      const vn = Math.sqrt(alat * N[b].R) * this.slow[b];
      lim = Math.min(lim, Math.sqrt(vn * vn + 2 * decel * d));
      a = b; b = this.nextOf(b, st); if (b == null) break;
      d += N[a].p.distanceTo(N[b].p);
    }
    return lim;
  }
  seg(i, j, pos) {
    const A = this.nodes[i].p, B = this.nodes[j].p;
    const abx = B.x - A.x, abz = B.z - A.z, aby = B.y - A.y;
    const l2 = Math.max(1, abx * abx + aby * aby + abz * abz);
    const t = Math.max(0, Math.min(1, ((pos.x - A.x) * abx + (pos.y - A.y) * aby + (pos.z - A.z) * abz) / l2));
    const d2 = (A.x + abx * t - pos.x) ** 2 + ((A.y + aby * t - pos.y) * 0.5) ** 2 + (A.z + abz * t - pos.z) ** 2;
    return { from: i, to: j, t, d2 };
  }
  // st: { from, to, t, pick } recuerda dónde estaba el auto, así no salta a otro tramo que pase cerca
  locate(pos, st) {
    const N = this.nodes;
    let best = null;
    if (st.from != null) {
      const cand = new Set([st.from]);
      let front = [st.from];
      for (let k = 0; k < 5; k++) { const nf = []; for (const i of front) for (const j of N[i].next) if (!cand.has(j)) { cand.add(j); nf.push(j); } front = nf; }
      front = [st.from];
      for (let k = 0; k < 2; k++) { const nf = []; for (const i of front) for (const j of N[i].prev) if (!cand.has(j)) { cand.add(j); nf.push(j); } front = nf; }
      for (const i of cand) for (const j of N[i].next) { const s = this.seg(i, j, pos); if (!best || s.d2 < best.d2) best = s; }
      if (best && best.d2 > 1600 * 1600) best = null;
    }
    if (!best) {
      // búsqueda en toda la pista: si se sabe por dónde iba, se prefiere un tramo con una distancia
      // a la meta parecida (así no salta a otra parte de la pista que pasa cerca)
      const fd = st.from != null ? N[st.from].dist : null;
      let bs = Infinity;
      N.forEach((n, i) => {
        for (const j of n.next) {
          const s = this.seg(i, j, pos);
          let score = Math.sqrt(s.d2);
          if (fd != null) { let dd = Math.abs(n.dist - fd); dd = Math.min(dd, this.total - dd); score += dd * 0.35; }
          if (score < bs) { bs = score; best = s; }
        }
      });
    }
    if (best) { st.from = best.from; st.to = best.to; st.t = best.t; st.d2 = best.d2; }
    return best;
  }
  nextOf(i, st) {
    const nx = this.nodes[i].next;
    if (nx.length < 2) return nx[0];
    // en las bifurcaciones cada rival elige un camino (y lo mantiene hasta pasarla)
    st.picks ??= {};
    if (st.picks[i] == null) st.picks[i] = Math.random() < 0.5 ? 0 : 1;
    return nx[st.picks[i]] ?? nx[0];
  }
  // punto de la línea de carrera "dist" unidades más adelante
  ahead(st, dist) {
    const N = this.nodes;
    if (st.from == null) return null;
    let a = st.from, b = st.to;
    const cur = N[a].p.clone().lerp(N[b].p, st.t);
    let left = dist;
    for (let guard = 0; guard < 40; guard++) {
      const end = N[b].p, seg = cur.distanceTo(end);
      if (seg >= left) return cur.lerp(end, left / Math.max(1, seg));
      left -= seg; cur.copy(end); a = b; b = this.nextOf(b, st); if (b == null) return cur;
    }
    return cur;
  }
  finishDist(st) {
    if (st.from == null) return null;
    const a = this.nodes[st.from], b = this.nodes[st.to];
    let db = b.dist; if (db > a.dist + this.total / 2) db -= this.total; // tramo que cruza la meta
    return a.dist + (db - a.dist) * st.t;
  }
  dirAt(st, dist) {
    const p = this.ahead(st, dist), q = this.ahead(st, dist + 200);
    if (!p || !q) return null;
    const d = q.sub(p); d.y = 0;
    return d.lengthSq() > 1 ? d.normalize() : null;
  }
  // un punto seguro sobre la línea para reaparecer: posición y hacia dónde mirar
  spawnPoint(st, fwd = 0) {
    const p = this.ahead(st, fwd), d = this.dirAt(st, fwd);
    return p && d ? { pos: p, dir: d } : null;
  }
}

// ajustes de manejo (se pueden tocar desde la consola para probar)
export const TUNE = { lat: 0.8, brake: 1700, cross: 0.4, look: 0.32, steer: 1.0, damp: 1.0, tight: 0.9, planStep: 70, crossAt: 0.8, wall: 1.4, pass: 0.45 };

export class BotDriver {
  // nav: { ahead(pos, dist, hint) -> Vector3|null, dirAt(pos, dist, hint) -> Vector3|null, locate(pos, hint) }
  constructor(phys, nav, skill) {
    this.p = phys; this.nav = nav;
    this.skill = skill;          // fracción de la velocidad máxima que usa en las rectas
    this.band = 1;               // ajuste según cómo va contra el jugador (lo pone main.js)
    this.hint = { from: null }; // tramo del recorrido de posiciones (.pan), para vueltas y posiciones
    this.st = { from: null };   // tramo de la línea de IA (.fan)
    this.offset = (Math.random() - 0.5) * 70; // cada uno toma una línea un poco distinta
    this.offT = 0;
    this.stuckT = 0; this.revT = 0; this.lostT = 0; this.revSteer = 0;
    this.straight = true;
    this.passOff = 0; this.passT = 0; this.planOff = 0; this.learnT = 0;
    const ws = phys.p.wheels.filter(w => w.present);
    this.grip = ws.reduce((a, w) => a + (w.staticFriction || 1.5), 0) / Math.max(1, ws.length);
    this.halfCar = Math.max(25, ...ws.map(w => Math.abs(w.offset1[0]) + w.radius * 0.5));
    const zs = ws.map(w => w.offset1[2]);
    this.wheelbase = Math.max(40, Math.max(...zs) - Math.min(...zs));
    this.ratio = Math.min(0.6, Math.max(0.35, Math.max(...ws.map(w => Math.abs(w.steerRatio || 0)), 0.35)));
    this.steerMod = Math.min(0.5, Math.max(0.25, phys.p.steerMod || 0.4));
  }

  think(dt) {
    const P = this.p, pos = P.pos, nav = this.nav;
    const spd = P.fwdSpeed;
    const inp = { throttle: 0, steer: 0, handbrake: false };
    nav.locate(pos, this.st);
    // aprender de los choques fuertes contra paredes (no de los roces ni de los aterrizajes)
    if ((this.learnT -= dt) <= 0 && P.impact > 500 && P.impactWall && this.revT <= 0) {
      this.learnT = 0.6;
      nav.learnCrash?.(this.st, Math.min(1.5, P.impact / 1200));
    }
    const dirNow = nav.dirAt(this.st, 0);
    if (!dirNow) return inp;
    // vigilante: si en 7 segundos no avanzó por el recorrido (da vueltas en un lugar), se lo devuelve a la pista
    const fd = nav.finishDist?.(this.st);
    if (fd != null) {
      if (this.bestFd == null) { this.bestFd = fd; this.progT = 0; }
      const tot = nav.total || 1;
      let gain = this.bestFd - fd; if (gain < -tot / 2) gain += tot; // cruzó la meta
      if (gain > 350) { this.bestFd = fd; this.progT = 0; }
      else if ((this.progT += dt) > 7 && P.fx.zap <= 0) { this.progT = 0; this.bestFd = null; this.lostT = 99; }
    }
    // de vez en cuando cambia un poco de línea
    if ((this.offT -= dt) <= 0) { this.offT = 2 + Math.random() * 3; this.offset = (Math.random() - 0.5) * 80; }

    // punto al que apunta: más lejos cuanto más rápido va. Si una pared lo tapa, mira más cerca.
    let look = 260 + Math.max(0, spd) * TUNE.look;
    // en curvas cerradas mirar más cerca, así no corta la curva por adentro contra la pared
    if (nav.minRadius) look = Math.min(look, Math.max(170, nav.minRadius(this.st, look) * TUNE.tight));
    const fwd0 = _f.set(0, 0, -1).applyQuaternion(P.quat); fwd0.y = 0; fwd0.normalize();
    // ¿hay un auto adelante más lento? pasarlo por el costado con más lugar
    const half = nav.halfWidth ? nav.halfWidth(this.st) : 300;
    let follow = Infinity;
    if ((this.passT -= dt) <= 0) this.passOff = 0;
    for (const o of nav.cars ? nav.cars() : []) {
      if (o.pos === pos) continue;
      const rx = o.pos.x - pos.x, rz = o.pos.z - pos.z, dist = Math.hypot(rx, rz);
      if (dist > 520 || dist < 1 || Math.abs(o.pos.y - pos.y) > 150) continue;
      const ahead = (rx * fwd0.x + rz * fwd0.z) / dist;
      if (ahead < 0.75) continue;
      const lat = (fwd0.x * rz - fwd0.z * rx); // + = el otro está a la derecha
      const theirSpd = o.vel.x * fwd0.x + o.vel.z * fwd0.z;
      if (theirSpd > spd - 60) continue;
      const side = lat > 0 ? -1 : 1;
      this.passOff = side * Math.max(60, half * TUNE.pass); this.passT = 1.2;
      if (Math.abs(lat) < 70 && dist < 260) follow = Math.min(follow, Math.max(0, theirSpd) + 150); // muy pegado: no chocarlo de atrás
    }
    const [lo, hi] = nav.room ? nav.room(this.st, this.halfCar + 35) : [-half + 70, half - 70];
    const off = Math.max(Math.min(0, lo), Math.min(Math.max(0, hi), this.passT > 0 ? this.passOff : this.offset));
    // planificador corto: se prueban varias líneas a lo ancho de la pista y se elige la más cercana
    // a la ideal que no choque nada (con el ancho del auto) ni caiga a un pozo. Si ninguna está libre,
    // se mira más cerca.
    let tgt = null, blocked = true;
    const cands = [];
    for (const k of [0, -1, 1, -2, 2, -3, 3, -4, 4]) cands.push(Math.max(lo, Math.min(hi, off + k * TUNE.planStep)));
    const uniq = [...new Set(cands.map(c => Math.round(c)))];
    uniq.sort((a, b) => (Math.abs(a - off) + 0.6 * Math.abs(a - this.planOff)) - (Math.abs(b - off) + 0.6 * Math.abs(b - this.planOff)));
    outer:
    for (const k of [1, 0.6, 0.35]) {
      const base = nav.ahead(this.st, look * k);
      if (!base) break;
      const dir = nav.dirAt(this.st, look * k) || dirNow;
      for (const c of (nav.clear ? uniq : [off])) {
        const t = base.clone(); t.x += -dir.z * c; t.z += dir.x * c;
        if (!tgt) tgt = t;
        if (!nav.clear || nav.clear(pos, t, this.halfCar)) { tgt = t; blocked = false; this.planOff += (c - this.planOff) * 0.5; break outer; }
      }
    }
    if (!tgt) return inp;
    const fwd = _f.set(0, 0, -1).applyQuaternion(P.quat); fwd.y = 0; fwd.normalize();
    const to = _t.copy(tgt).sub(pos); to.y = 0; to.normalize();
    const ang = Math.atan2(fwd.x * to.z - fwd.z * to.x, fwd.dot(to)); // + = el punto está a la derecha
    // "persecución pura": ángulo de ruedas para llegar en arco al punto, según la distancia entre ejes.
    // Se pasa a la palanca de dirección con el mismo límite de ángulo que usa la física a esta velocidad.
    const ld = Math.max(120, Math.hypot(tgt.x - pos.x, tgt.z - pos.z));
    const delta = Math.atan2(2 * this.wheelbase * Math.sin(ang), ld);
    const speedFrac = Math.min(1.2, Math.abs(spd) / P.top);
    const maxAng = Math.min(0.8, 0.75 * this.ratio / (1 + speedFrac * this.steerMod * 6));
    let steer = -delta / Math.max(0.05, maxAng) * TUNE.steer;
    // amortiguación con el giro real del auto, para que no zigzaguee
    const wantYaw = -spd * 2 * Math.sin(ang) / ld; // giro que haría falta (+ = izquierda)
    steer -= (P.angVel.y - wantYaw) * TUNE.damp / Math.max(0.05, maxAng) * 0.1;
    // sensores a los costados: si hay una pared cerca adelante a un lado, dobla para el otro
    if (spd > 150) {
      const wl = 180 + spd * 0.22;
      for (const [a, w] of [[0.45, 1], [-0.45, 1], [0.9, 0.6], [-0.9, 0.6]]) {
        const c = Math.cos(a), sn = Math.sin(a);
        const dir = new THREE.Vector3(fwd.x * c - fwd.z * sn, 0, fwd.x * sn + fwd.z * c); // a > 0: hacia la derecha
        const d = nav.wall(pos, dir, wl);
        if (d != null) steer += Math.sign(a) * w * (1 - d / wl) * TUNE.wall; // pared a la derecha: dobla a la izquierda (+)
      }
    }
    inp.steer = Math.max(-1, Math.min(1, steer));

    // velocidad: la que permiten las curvas que vienen (según el radio y el agarre del auto)
    const top = P.top * (P.fx.turbo > 0 ? 1.3 : 1);
    const k = this.skill * this.band;
    const alat = this.grip * 2200 * TUNE.lat * k * k;
    const lim = nav.speedLimit ? nav.speedLimit(this.st, alat, TUNE.brake * k, Math.max(1200, spd * spd / (2 * TUNE.brake) + 600)) : Infinity;
    let want = Math.min(top * k, lim, follow, TUNE.cap || Infinity);
    this.straight = lim > top * 0.95;
    want *= 1 - TUNE.cross * Math.min(1, Math.max(0, Math.abs(ang) - TUNE.crossAt)); // muy cruzado (no en una curva normal): más despacio
    if (blocked) want = Math.min(want, 900); // no ve un camino libre: más despacio
    want = Math.max(want, 450);
    this.lastWant = want; this.dbg = { lim: Math.round(lim), top: Math.round(top * k), blocked, spd: Math.round(spd), ang: +ang.toFixed(2), rev: this.revT > 0 };
    if (spd < want - 40) inp.throttle = 1;
    else if (spd > want * 1.15) inp.throttle = -1;
    else if (spd > want + 60) inp.throttle = -0.4;
    else inp.throttle = 0.35;
    if (Math.abs(ang) > 1.2 && spd > 900) inp.handbrake = true;

    // trabado contra algo: marcha atrás un ratito, doblando al revés
    const facingBack = fwd.dot(dirNow) < -0.2;
    if (this.revT > 0) {
      this.revT -= dt;
      inp.throttle = -1; inp.steer = this.revSteer; inp.handbrake = false;
    } else {
      if (inp.throttle > 0 && spd < 70 && P.fx.zap <= 0) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt * 2);
      if (this.stuckT > 1.1 || (facingBack && spd < 150 && Math.abs(ang) > 2.2)) {
        this.stuckT = 0; this.revT = 0.9 + Math.random() * 0.4; this.revSteer = -Math.sign(inp.steer || 1);
        this.lostT += 1;
        // al volver a arrancar, que tome una línea corrida hacia el lado más libre (ej.: la rueda de un auto estacionado)
        const side = a => { const c = Math.cos(a), sn = Math.sin(a); return nav.wall(pos, new THREE.Vector3(fwd.x * c - fwd.z * sn, 0, fwd.x * sn + fwd.z * c), 400) ?? 400; };
        const right = Math.min(side(0.25), side(0.6)), left = Math.min(side(-0.25), side(-0.6));
        this.offset = (right < left ? -1 : 1) * (120 + Math.random() * 80) * (this.lostT > 2 ? -1 : 1);
        this.offT = 3.5;
        // si se traba varias veces, probar el otro camino en las bifurcaciones
        if (this.lostT >= 2 && this.st.picks) for (const k in this.st.picks) this.st.picks[k] = 1 - this.st.picks[k];
      }
    }
    if (spd > 900) this.lostT = Math.max(0, this.lostT - dt * 0.3);
    return inp;
  }
}
