// Física de manejo inspirada en Re-Volt, usando los valores de parameters.txt de cada auto.
// No es la física original (no es pública): es un modelo de suspensión por rueda con
// fricción de neumático, calibrado para que cada auto conserve su carácter.
import * as THREE from 'three';

export const GRAVITY = 2200;      // unidades Re-Volt por s² (el valor de parameters.txt)
export const MPH_PER_UNIT = 1 / 85.4; // TopEnd 2860 ~ 33.5 mph

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ray = new THREE.Ray();
const _m3 = new THREE.Matrix3();
const UP = new THREE.Vector3(0, 1, 0);

// 3 esferas a lo largo del auto (adelante, centro, atrás), del ancho de la carrocería
export function carSpheresFromBox(box) {
  const sz = box.getSize(new THREE.Vector3()), ce = box.getCenter(new THREE.Vector3());
  const r = Math.max(8, sz.x * 0.5 * 0.9);
  const hz = Math.max(0, sz.z * 0.5 - r);
  return [-hz, 0, hz].map(z => ({ c: new THREE.Vector3(ce.x, ce.y, ce.z + z), r }));
}

export class CarPhysics {
  constructor(params, bodyBox, world) {
    this.p = params;
    this.world = world; // { bvh }
    this.mass = params.mass || 1.2;
    const I = params.inertia;
    this.invILocal = new THREE.Vector3(1 / Math.max(I[0], 50), 1 / Math.max(I[1], 50), 1 / Math.max(I[2], 50));
    this.top = params.topEnd > 100 ? params.topEnd : params.topSpeed * 85.4;
    // "Acc" en parameters.txt es una nota para las barras del menú original. Algunos autos
    // (como el Panga) traen un valor fuera de escala; en ese caso se deriva de la velocidad máxima.
    const accRaw = params.acc;
    this.accel = Math.min(1900, Math.max(600, accRaw > 0 && accRaw < 15 ? accRaw * 175 : this.top / 2.4));
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();
    this.steer = 0;
    this.input = { throttle: 0, steer: 0, handbrake: false };
    // Sensibilidad de dirección elegida por el jugador (1 = normal)
    this.steerGain = 1;
    const nPow = params.wheels.filter(w => w.present && w.powered).length || 2;
    this.wheels = params.wheels.map((w, i) => {
      const o = w.offset1;
      return {
        ...w,
        anchor: new THREE.Vector3(o[0], -o[1], -o[2]),
        travel: Math.max(3, w.maxPos),
        k: 0, c: 0,
        comp: 0, contact: false, spin: 0, spinVel: 0, suspOffset: 0,
        normal: new THREE.Vector3(0, 1, 0), point: new THREE.Vector3(),
        nPow, spring: params.springs[i],
      };
    }).filter(w => w.present);
    const nW = this.wheels.length;
    if (nW === 4) this.wheels.forEach((w, i) => { w.partner = this.wheels[i ^ 1]; });
    for (const w of this.wheels) {
      // Resorte calibrado para que en reposo la rueda quede cerca del centro de su recorrido
      const stiffMul = Math.sqrt((w.spring?.stiffness || 300) / 300);
      w.k = this.mass * GRAVITY / (nW * w.travel * 1.05) * stiffMul;
      const crit = 2 * Math.sqrt(w.k * this.mass / nW);
      w.c = crit * 0.85 * Math.sqrt((w.spring?.damping || 7) / 7);
    }
    // Esferas de colisión de la carrocería
    const b = bodyBox; // THREE.Box3 en coords locales three
    const sz = b.getSize(new THREE.Vector3()), ce = b.getCenter(new THREE.Vector3());
    const r = Math.max(5, Math.min(sz.y * 0.5, sz.x * 0.35));
    this.sphereR = r;
    this.spheres = [];
    const hx = Math.max(0, sz.x / 2 - r), hz = Math.max(0, sz.z / 2 - r);
    for (const z of [-hz, 0, hz]) for (const x of [-hx, hx]) this.spheres.push(new THREE.Vector3(ce.x + x, ce.y, ce.z + z));
    this.radius = Math.max(sz.x, sz.z) * 0.5;
    this.carSpheres = carSpheresFromBox(b); // para choques entre autos
    this.grounded = 0;
    this.lastSafe = null; this.safeTimer = 0; this.flipTimer = 0;
    this.speed = 0; this.fwdSpeed = 0;
    // para el sonido: cuánto derrapa (0..1) y qué tan fuerte fue el último golpe contra la pista
    this.skid = 0; this.impact = 0; this._skidAcc = 0; this._impactAcc = 0;
    // efectos de armas y bonus (segundos que les quedan): turbo, aceite (sin agarre), electrocutado (sin motor)
    this.fx = { turbo: 0, oil: 0, zap: 0 };
  }

  // Golpe de un arma: empuje (vector en unidades/s) y un giro al azar
  blast(push, spin = 0) {
    this.vel.add(push);
    if (spin) this.angVel.add(new THREE.Vector3((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin));
  }

  place(posThree, yaw) {
    this.pos.copy(posThree);
    this.quat.setFromAxisAngle(UP, yaw);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    this.steer = 0;
    this.lastSafe = { p: this.pos.clone(), q: this.quat.clone() };
  }

  respawn() {
    if (!this.lastSafe) return;
    this.pos.copy(this.lastSafe.p).addScaledVector(UP, 30);
    // mantener sólo la orientación horizontal
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.lastSafe.q); f.y = 0;
    const yaw = Math.atan2(-f.x, -f.z);
    this.quat.setFromAxisAngle(UP, yaw);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
  }

  invIWorld(vec, out) { // out = I^-1_world * vec
    _q.copy(this.quat).invert();
    out.copy(vec).applyQuaternion(_q).multiply(this.invILocal).applyQuaternion(this.quat);
    return out;
  }

  applyImpulse(point, imp) {
    this.vel.addScaledVector(imp, 1 / this.mass);
    const r = _v3.copy(point).sub(this.pos);
    const t = new THREE.Vector3().crossVectors(r, imp);
    this.angVel.add(this.invIWorld(t, t));
  }

  step(dt) {
    const sub = 4, h = dt / sub;
    this._skidAcc = 0; this._impactAcc = 0;
    for (let i = 0; i < sub; i++) this.substep(h);
    this.skid = this._skidAcc; this.impact = this._impactAcc;
    for (const k in this.fx) if (this.fx[k] > 0) this.fx[k] = Math.max(0, this.fx[k] - dt);
    this.speed = this.vel.length();
    const fwd = _v1.set(0, 0, -1).applyQuaternion(this.quat);
    this.fwdSpeed = this.vel.dot(fwd);
    // posición segura para reaparecer
    const up = _v2.set(0, 1, 0).applyQuaternion(this.quat);
    this.safeTimer += dt;
    if (this.grounded >= 3 && up.y > 0.8 && this.safeTimer > 0.5) {
      this.safeTimer = 0;
      this.lastSafe = { p: this.pos.clone(), q: this.quat.clone() };
    }
    if (up.y < 0.45 && this.speed < 250) { this.flipTimer += dt; if (this.flipTimer > 1.4) { this.flipTimer = 0; this.respawn(); } }
    else this.flipTimer = 0;
    if (this.pos.y < -20000) this.respawn();
  }

  substep(dt) {
    const P = this.p, m = this.mass, inp = this.input;
    const F = new THREE.Vector3(0, -m * GRAVITY, 0);
    const T = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    const fwdBody = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    const vFwd = this.vel.dot(fwdBody);
    const speed = this.vel.length();
    const fx = this.fx;
    // con turbo el auto anda más rápido y acelera más
    const top = this.top * (fx.turbo > 0 ? 1.4 : 1), accel = this.accel * (fx.turbo > 0 ? 1.7 : 1);

    // Dirección: se acerca al valor pedido según SteerRate, y se reduce con la velocidad
    const speedFrac = Math.min(1.2, Math.abs(vFwd) / this.top);
    // a más velocidad, menos ángulo de dirección (según SteerMod). Algunos autos de la comunidad
    // traen valores fuera de escala (por ejemplo 4.85) que dejarían la dirección casi anulada,
    // así que se limitan a un rango razonable.
    const steerMod = Math.min(0.5, Math.max(0.25, P.steerMod || 0.4));
    const steerLimit = 1 / (1 + speedFrac * steerMod * 6);
    const target = inp.steer * steerLimit;
    const steerRate = Math.min(3.5, Math.max(2, P.steerRate || 3)) * 1.3 * Math.sqrt(this.steerGain);
    this.steer += (target - this.steer) * Math.min(1, steerRate * dt);

    // Motor / freno
    let drive = 0, brake = 0;
    const t = fx.zap > 0 ? 0 : inp.throttle; // electrocutado: el motor no responde
    if (t > 0.05) {
      if (vFwd < -60) brake = t;
      else drive = t * (1 - Math.min(1, Math.max(0, vFwd) / top) ** 3);
    } else if (t < -0.05) {
      if (vFwd > 60) brake = -t;
      else {
        const rt = this.top * 0.45;
        drive = t * (1 - Math.min(1, Math.max(0, -vFwd) / rt) ** 2);
      }
    }

    let grounded = 0;
    const nW = this.wheels.length;
    for (const w of this.wheels) {
      const anchorW = _v1.copy(w.anchor).applyQuaternion(this.quat).add(this.pos);
      // El rayo arranca un poco más arriba para "ver" cordones y escalones bajos y subirlos
      const extra = w.radius * 0.7;
      const origin = anchorW.clone().addScaledVector(up, w.travel + extra);
      const L = w.travel * 2 + w.radius;
      _ray.origin.copy(origin); _ray.direction.copy(up).negate();
      const hit = this.world.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, L + extra);
      if (!hit) {
        w.contact = false; w.comp = 0;
        w.suspOffset += (-w.travel - w.suspOffset) * Math.min(1, 12 * dt);
        w.spinVel *= 0.995;
        if (w.powered) w.spinVel += drive * 400 * dt / w.radius * 10;
        w.spin += w.spinVel * dt;
        continue;
      }
      grounded++;
      w.contact = true;
      const d = hit.distance - extra;
      w.comp = L - d;
      w.suspOffset = Math.min(w.travel * 1.3, w.travel - (d - w.radius));
      const n = w.normal.copy(hit.face.normal);
      // normal en mundo (la geometría de colisión ya está en coords del mundo)
      if (n.dot(up) < 0) n.negate();
      w.point.copy(hit.point);

      const r = _v2.copy(hit.point).sub(this.pos);
      const vc = new THREE.Vector3().crossVectors(this.angVel, r).add(this.vel);
      const vUp = vc.dot(up);
      let N = w.k * w.comp - w.c * vUp;
      // barra estabilizadora: compensa la diferencia de compresión con la rueda del otro lado del mismo eje
      if (w.partner && w.partner.contact) N += w.k * 1.3 * (w.comp - w.partner.comp);
      if (w.comp > w.travel * 2) N += (w.comp - w.travel * 2) * w.k * 6; // tope de suspensión
      N = Math.max(0, N);
      // Carga aerodinámica (DownForceMod)
      const down = (P.downForceMod || 1) * 0.11 * speed * m / nW;
      const Nt = N + down;

      // Ejes de la rueda
      // input.steer > 0 = izquierda. Ruedas con SteerRatio negativo (delanteras) giran hacia el mismo lado.
      // ángulo máximo de la rueda: SteerRatio del auto (acotado) por la sensibilidad del jugador
      const ratio = Math.min(0.6, Math.max(0.35, Math.abs(w.steerRatio || 0.5)));
      const sa = w.turnable ? Math.max(-0.8, Math.min(0.8, this.steer * 0.75 * ratio * this.steerGain)) * (w.steerRatio > 0 ? -1 : 1) : 0;
      w.steerAngle = sa;
      const fLocal = new THREE.Vector3(-Math.sin(sa), 0, -Math.cos(sa));
      const f = fLocal.applyQuaternion(this.quat);
      f.addScaledVector(n, -f.dot(n)).normalize();
      const s = new THREE.Vector3().crossVectors(f, n).normalize();
      const vF = vc.dot(f), vS = vc.dot(s);
      this._skidAcc = Math.max(this._skidAcc, Math.min(1, Math.max(0, (Math.abs(vS) - 180) / 700)) + (inp.handbrake && !w.turnable && Math.abs(vF) > 300 ? 0.5 : 0));

      // Longitudinal
      let Fl = 0;
      if (w.powered && drive !== 0) Fl += drive * accel * m / w.nPow;
      if (brake > 0) Fl -= Math.sign(vF) * Math.min(brake * 2600 * m / nW, Math.abs(vF) * m / nW / dt * 0.5);
      if (inp.handbrake && !w.turnable) Fl -= Math.sign(vF) * Math.min(1800 * m / nW, Math.abs(vF) * m / nW / dt * 0.5);
      Fl -= vF * m / nW * (0.05 + (w.axleFriction || 0.02) * 2);

      // Lateral: modelo de ángulo de deriva
      const slip = Math.atan2(vS, Math.abs(vF) + 40);
      let mu = (w.staticFriction || 1.5) * 1.15;
      if (inp.handbrake && !w.turnable) mu = (w.kineticFriction || 1.4) * 0.45;
      if (fx.oil > 0) mu *= 0.22; // mancha de aceite
      const peak = 0.2;
      let Fs = -mu * Nt * Math.max(-1, Math.min(1, slip / peak));
      // estabilizador a baja velocidad: evita que el auto se deslice parado en pendientes
      if (Math.abs(vF) < 80) Fs = Math.max(-mu * Nt, Math.min(mu * Nt, -vS * m / nW / dt * 0.4));

      // círculo de fricción
      const maxF = mu * Nt * 1.05;
      const tot = Math.hypot(Fl, Fs);
      if (tot > maxF && tot > 0) { const k = maxF / tot; Fl *= k; Fs *= k; }

      const force = new THREE.Vector3().addScaledVector(up, N).addScaledVector(f, Fl).addScaledVector(s, Fs);
      // aplicar las fuerzas del neumático un poco por encima del piso para reducir el vuelco
      const app = hit.point.clone().addScaledVector(up, Math.max(0, up.dot(_v3.copy(this.pos).sub(hit.point))) * 0.95);
      F.add(force);
      T.add(new THREE.Vector3().crossVectors(app.sub(this.pos), force));

      w.spinVel = vF / w.radius;
      w.spin += w.spinVel * dt;
    }
    this.grounded = grounded;

    // Arrastre y amortiguación angular
    F.addScaledVector(this.vel, -m * 0.04);
    const angDamp = grounded ? 1.2 : 0.35;
    const Iw = new THREE.Vector3();
    T.addScaledVector(this.angVel, -angDamp / Math.max(1e-6, (this.invILocal.x + this.invILocal.y + this.invILocal.z) / 3));
    // En el aire: un poco de control para enderezarse (como en Re-Volt)
    if (!grounded) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
      T.addScaledVector(right, inp.throttle * 1800 * m);
      T.addScaledVector(up, inp.steer * 1500 * m);
      const align = new THREE.Vector3().crossVectors(up, UP);
      T.addScaledVector(align, 900 * m);
    }

    // Integración
    this.vel.addScaledVector(F, dt / m);
    this.angVel.add(this.invIWorld(T, Iw).multiplyScalar(dt));
    const wl = this.angVel.length();
    if (wl > 25) this.angVel.multiplyScalar(25 / wl);
    this.pos.addScaledVector(this.vel, dt);
    const wq = new THREE.Quaternion(this.angVel.x * dt * 0.5, this.angVel.y * dt * 0.5, this.angVel.z * dt * 0.5, 0);
    wq.multiply(this.quat);
    this.quat.x += wq.x; this.quat.y += wq.y; this.quat.z += wq.z; this.quat.w += wq.w;
    this.quat.normalize();

    this.collideBody();
  }

  collideBody() {
    const bvh = this.world.bvh, r = this.sphereR;
    const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    // Ruedas como esferas: si chocan con algo bajo (un cordón), el auto se sube en vez de frenar en seco
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    for (const w of this.wheels) {
      const wc = _v1.copy(w.anchor).applyQuaternion(this.quat).add(this.pos).addScaledVector(upW, w.suspOffset || 0);
      const wr = w.radius * 0.95;
      const res = bvh.closestPointToPoint(wc, target, 0, wr);
      if (!res || res.distance >= wr) continue;
      const n = _v2.copy(wc).sub(res.point); const dist = n.length();
      if (dist < 1e-4) continue;
      n.divideScalar(dist);
      if (Math.abs(n.dot(upW)) > 0.35) continue; // piso o bordes inclinados: lo maneja la suspensión
      const pen = wr - dist;
      const low = upW.dot(_v3.copy(res.point).sub(wc)) < -wr * 0.15;
      if (low) {
        // escalón bajo: levantar el auto
        this.pos.addScaledVector(upW, Math.min(pen * 1.2, 4));
        const vu = this.vel.dot(upW); if (vu < 0) this.vel.addScaledVector(upW, -vu);
      } else {
        this.pos.addScaledVector(n, pen * 0.8);
        const vn = this.vel.dot(n); if (vn < 0) this.vel.addScaledVector(n, -vn * 1.1);
      }
    }
    for (const s of this.spheres) {
      const c = _v1.copy(s).applyQuaternion(this.quat).add(this.pos);
      const res = bvh.closestPointToPoint(c, target, 0, r);
      if (!res || res.distance >= r) continue;
      const n = _v2.copy(c).sub(res.point);
      const dist = n.length();
      if (dist < 1e-4) continue;
      n.divideScalar(dist);
      const pen = r - dist;
      this.pos.addScaledVector(n, pen * 0.8);
      const cp = res.point.clone();
      const rr = cp.clone().sub(this.pos);
      const vRel = new THREE.Vector3().crossVectors(this.angVel, rr).add(this.vel);
      const vn = vRel.dot(n);
      if (vn < 0) {
        const rxn = new THREE.Vector3().crossVectors(rr, n);
        const k = 1 / this.mass + n.dot(new THREE.Vector3().crossVectors(this.invIWorld(rxn, new THREE.Vector3()), rr));
        const j = -(1 + 0.15) * vn / k;
        this._impactAcc = Math.max(this._impactAcc, -vn);
        const imp = n.clone().multiplyScalar(j);
        const vt = vRel.clone().addScaledVector(n, -vn);
        const vtl = vt.length();
        if (vtl > 1e-3) {
          // contra paredes el auto resbala (como en Re-Volt); contra el piso frena más
          const wallMu = Math.abs(n.y) < 0.6 ? 0.12 : (this.p.bodyKinetic || 0.4);
          const jt = Math.min(vtl / k * 0.5, wallMu * j);
          imp.addScaledVector(vt, -jt / vtl);
        }
        this.applyImpulse(cp, imp);
      }
    }
  }

  // Choque contra otro auto. Cada auto es una fila de 3 esferas a lo largo de la carrocería.
  // Se separa la mitad de la superposición (la otra mitad la hace el otro jugador en su compu)
  // y se aplica un impulso según la velocidad relativa y el peso de cada auto.
  collideWithCar(o) {
    const e = 0.3; // rebote
    const qa = this.quat, qb = o.quat;
    let hit = false;
    for (const sa of this.carSpheres) {
      const a = _v1.copy(sa.c).applyQuaternion(qa).add(this.pos);
      for (const sb of o.spheres) {
        const b = _v2.copy(sb.c).applyQuaternion(qb).add(o.pos);
        const n = _v3.copy(a).sub(b);
        const dist = n.length(), minD = sa.r + sb.r;
        if (dist >= minD || dist < 1e-3) continue;
        n.divideScalar(dist);
        const pen = minD - dist;
        this.pos.addScaledVector(n, pen * 0.5);
        a.addScaledVector(n, pen * 0.5);
        const contact = b.clone().addScaledVector(n, sb.r);
        const rr = contact.clone().sub(this.pos);
        const vRel = new THREE.Vector3().crossVectors(this.angVel, rr).add(this.vel).sub(o.vel);
        const vn = vRel.dot(n);
        if (vn < 0) {
          const rxn = new THREE.Vector3().crossVectors(rr, n);
          const ang = n.dot(new THREE.Vector3().crossVectors(this.invIWorld(rxn, new THREE.Vector3()), rr));
          const k = 1 / this.mass + 1 / Math.max(0.3, o.mass) + ang;
          const j = -(1 + e) * vn / k;
          const imp = n.clone().multiplyScalar(j);
          // un poco de roce entre carrocerías
          const vt = vRel.clone().addScaledVector(n, -vn); const vtl = vt.length();
          if (vtl > 1e-3) imp.addScaledVector(vt, -Math.min(vtl / k * 0.3, 0.25 * j) / vtl);
          this.applyImpulse(contact, imp);
          hit = Math.max(hit || 0, -vn);
        }
      }
    }
    return hit; // velocidad del impacto (0 si no hubo)
  }

}
