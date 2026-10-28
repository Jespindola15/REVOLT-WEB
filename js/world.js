// Colisión de la pista: la parte fija (un solo BVH) más los objetos que se mueven,
// como la ruleta del casino, que gira. Tiene las mismas funciones que usa la física
// (raycastFirst y closestPointToPoint), así que el resto del juego no nota la diferencia.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _r = new THREE.Ray();

export class Spinner {
  // tris: triángulos en coordenadas del objeto; axis: eje de giro (mundo); speed: rad/s
  constructor(group, tris, axis, speed) {
    this.group = group;
    this.axis = axis.clone().normalize();
    this.speed = speed;
    this.angle = 0;
    this.base = group.quaternion.clone();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    this.bvh = new MeshBVH(g);
    this.inv = new THREE.Quaternion();
  }
  update(dt) {
    this.angle = (this.angle + this.speed * dt) % (Math.PI * 2);
    this.group.quaternion.setFromAxisAngle(this.axis, this.angle).multiply(this.base);
    this.inv.copy(this.group.quaternion).invert();
  }
  // velocidad del piso en un punto del mundo (para que arrastre a los autos)
  pointVel(p) {
    return new THREE.Vector3().crossVectors(this.axis, _p.copy(p).sub(this.group.position)).multiplyScalar(this.speed);
  }
}

export class TrackCollider {
  constructor(bvh) { this.bvh = bvh; this.spinners = []; }
  update(dt) { for (const s of this.spinners) s.update(dt); }

  raycastFirst(ray, side, near = 0, far = Infinity) {
    let best = this.bvh.raycastFirst(ray, side, near, far);
    for (const s of this.spinners) {
      _r.origin.copy(ray.origin).sub(s.group.position).applyQuaternion(s.inv);
      _r.direction.copy(ray.direction).applyQuaternion(s.inv);
      const h = s.bvh.raycastFirst(_r, side, near, far);
      if (!h || (best && best.distance <= h.distance)) continue;
      const q = s.group.quaternion;
      const point = h.point.clone().applyQuaternion(q).add(s.group.position);
      best = { distance: h.distance, point, face: { normal: h.face.normal.clone().applyQuaternion(q) }, vel: s.pointVel(point) };
    }
    return best;
  }

  closestPointToPoint(p, target = {}, minT = 0, maxT = Infinity) {
    let res = this.bvh.closestPointToPoint(p, target, minT, maxT);
    let bestD = res ? res.distance : Infinity, bestPoint = res ? res.point.clone() : null;
    for (const s of this.spinners) {
      const lp = _p.copy(p).sub(s.group.position).applyQuaternion(s.inv);
      const t2 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
      const h = s.bvh.closestPointToPoint(lp, t2, minT, Math.min(maxT, bestD));
      if (!h || h.distance >= bestD) continue;
      bestD = h.distance;
      bestPoint = h.point.applyQuaternion(s.group.quaternion).add(s.group.position);
    }
    if (!bestPoint) return null;
    target.point = target.point || new THREE.Vector3();
    target.point.copy(bestPoint); target.distance = bestD;
    return target;
  }
}
