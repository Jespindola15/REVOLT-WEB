// Rivales de la computadora: siguen el recorrido de la pista (los nodos .pan del juego original),
// frenan antes de las curvas según lo cerradas que sean, se destraban marcha atrás y usan armas.
import * as THREE from 'three';

const _f = new THREE.Vector3(), _t = new THREE.Vector3();

export const DIFFICULTY = {
  facil: { name: 'Fácil', skill: 0.8, spread: 0.06 },
  normal: { name: 'Normal', skill: 0.89, spread: 0.06 },
  dificil: { name: 'Difícil', skill: 0.97, spread: 0.04 },
};

// Recorrido de IA (nodos .fan): línea de carrera con los bordes de la pista y bifurcaciones
export class AiPath {
  constructor(fan) {
    const V = p => new THREE.Vector3(p[0], -p[1], -p[2]);
    this.nodes = fan.map(n => {
      const a = V(n.a), b = V(n.b);
      return { a, b, p: a.clone().lerp(b, Math.min(0.95, Math.max(0.05, n.line))), w: a.distanceTo(b), next: n.next, prev: n.prev, dist: n.dist, prio: n.priority };
    });
    this.total = Math.max(1, ...this.nodes.map(n => n.dist));
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
export const TUNE = { curve: 0.55, curveRange: 1.3, cross: 0.4, look: 0.32, reach: 0.85, steer: 2.6, wall: 1.4 };

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
  }

  think(dt) {
    const P = this.p, pos = P.pos, nav = this.nav;
    const spd = P.fwdSpeed;
    const inp = { throttle: 0, steer: 0, handbrake: false };
    nav.locate(pos, this.st);
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
    const look = 260 + Math.max(0, spd) * TUNE.look;
    let tgt = null;
    for (const k of [1, 0.6, 0.35, 0.2]) {
      const t = nav.ahead(this.st, look * k);
      if (!t) break;
      t.x += -dirNow.z * this.offset * k; t.z += dirNow.x * this.offset * k;
      tgt = t;
      const d = _t.copy(t).sub(pos); d.y = 0; const len = d.length();
      if (len < 1 || !nav.wall(pos, d.divideScalar(len), len)) break;
    }
    if (!tgt) return inp;
    const fwd = _f.set(0, 0, -1).applyQuaternion(P.quat); fwd.y = 0; fwd.normalize();
    const to = _t.copy(tgt).sub(pos); to.y = 0; to.normalize();
    const ang = Math.atan2(fwd.x * to.z - fwd.z * to.x, fwd.dot(to)); // + = el punto está a la derecha
    let steer = -ang * TUNE.steer;
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

    // ¿cuánto dobla la pista más adelante? (para frenar antes)
    const reach = 500 + Math.max(0, spd) * TUNE.reach;
    let curve = 0;
    for (let d = 250; d <= reach; d += 250) {
      const a = nav.dirAt(this.st, d); if (!a) break;
      const c = Math.abs(Math.atan2(dirNow.x * a.z - dirNow.z * a.x, dirNow.dot(a)));
      // una curva cerca pesa más que una lejos
      curve = Math.max(curve, c * (1 - 0.35 * d / reach));
    }
    this.straight = curve < 0.25;
    const top = P.top * (P.fx.turbo > 0 ? 1.3 : 1);
    let want = top * this.skill * this.band * (1 - TUNE.curve * Math.min(1, curve / TUNE.curveRange));
    want *= 1 - TUNE.cross * Math.min(1, Math.max(0, Math.abs(ang) - 0.35)); // muy cruzado: más despacio
    want = Math.max(want, 500);
    if (spd < want) inp.throttle = 1;
    else if (spd > want * 1.12) inp.throttle = -0.8;
    else inp.throttle = 0.2;
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
