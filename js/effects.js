// Efectos de los autos: sombra en el piso y marcas de derrape.
// (Las chispas de los choques usan el sistema de partículas de las armas.)
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _ray = new THREE.Ray(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const MAX_SKID = 2400; // tramos de marca de derrape guardados (los más viejos se van borrando)

function shadowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  // rectángulo con bordes muy suaves (como la sombra de un auto chato)
  g.filter = 'blur(10px)';
  g.fillStyle = 'rgba(0,0,0,1)';
  g.beginPath(); g.roundRect(26, 18, 76, 92, 22); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class CarEffects {
  constructor(scene) {
    this.scene = scene;
    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, fog: true });
    this.shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadows = new Map(); // id -> mesh
    // marcas de derrape: una sola malla con un buffer circular de cuadrados
    const g = new THREE.BufferGeometry();
    this.skPos = new Float32Array(MAX_SKID * 6 * 3);
    this.skCol = new Float32Array(MAX_SKID * 6 * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.skPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.skCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.skMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, fog: true }));
    this.skMesh.frustumCulled = false; this.skMesh.renderOrder = 1;
    scene.add(this.skMesh);
    this.skN = 0; this.skDirty = false;
    this.trails = new Map(); // id -> [último punto por rueda]
  }

  clear() {
    this.skPos.fill(0); this.skCol.fill(0); this.skN = 0; this.skDirty = true;
    this.trails.clear();
    for (const m of this.shadows.values()) this.scene.remove(m);
    this.shadows.clear();
  }

  // cars: [{id, pos, quat, size:{x,z}, wheels:[{pos, r}] (mundo), skid 0..1, visible}]
  update(cars, bvh) {
    if (!bvh) return;
    const seen = new Set();
    for (const c of cars) {
      seen.add(c.id);
      this.shadow(c, bvh);
      this.skid(c, bvh);
    }
    for (const [id, m] of this.shadows) if (!seen.has(id)) { this.scene.remove(m); this.shadows.delete(id); this.trails.delete(id); }
    if (this.skDirty) {
      this.skMesh.geometry.attributes.position.needsUpdate = true;
      this.skMesh.geometry.attributes.color.needsUpdate = true;
      this.skDirty = false;
    }
  }

  shadow(c, bvh) {
    let m = this.shadows.get(c.id);
    if (!m) { m = new THREE.Mesh(this.shadowGeo, this.shadowMat.clone()); m.renderOrder = 1; this.scene.add(m); this.shadows.set(c.id, m); }
    if (!c.visible) { m.visible = false; return; }
    _ray.origin.copy(c.pos).addScaledVector(UP, 20); _ray.direction.set(0, -1, 0);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 700);
    if (!hit) { m.visible = false; return; }
    const h = hit.distance - 20;
    m.visible = true;
    const n = _v.copy(hit.face.normal); if (n.y < 0) n.negate();
    // orientada como el piso y girada como el auto
    const fwd = _w.set(0, 0, -1).applyQuaternion(c.quat); fwd.addScaledVector(n, -fwd.dot(n)).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, n).normalize();
    _m.makeBasis(right, n, fwd.negate());
    m.quaternion.setFromRotationMatrix(_m);
    m.position.copy(hit.point).addScaledVector(n, 1);
    const grow = 1 + Math.max(0, h) / 400;
    m.scale.set(c.size.x * 1.25 * grow, 1, c.size.z * 1.15 * grow);
    m.material.opacity = 0.55 * Math.max(0, 1 - Math.max(0, h) / 600);
  }

  skid(c, bvh) {
    let tr = this.trails.get(c.id);
    if (!tr) { tr = c.wheels.map(() => null); this.trails.set(c.id, tr); }
    const on = c.visible && c.skid > 0.3;
    c.wheels.forEach((w, i) => {
      if (!on) { tr[i] = null; return; }
      // punto de contacto de la rueda con el piso
      let p = w.contact;
      if (!p) {
        _ray.origin.copy(w.pos).addScaledVector(UP, 10); _ray.direction.set(0, -1, 0);
        const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, w.r + 40);
        if (!hit) { tr[i] = null; return; }
        p = hit.point;
      }
      const last = tr[i];
      if (!last) { tr[i] = { p: p.clone() }; return; }
      const d = last.p.distanceTo(p);
      if (d < 10) return;
      if (d > 160) { tr[i] = { p: p.clone() }; return; }
      const dir = _v.copy(p).sub(last.p).normalize();
      const side = _w.crossVectors(dir, UP).normalize().multiplyScalar(Math.max(5, w.r * 0.45));
      const alpha = Math.min(0.55, 0.25 + c.skid * 0.35);
      this.quad(last.p, p, side, alpha);
      last.p.copy(p);
    });
  }

  quad(a, b, side, alpha) {
    const k = this.skN % MAX_SKID; this.skN++;
    const P = this.skPos, C = this.skCol, o = k * 18, oc = k * 24;
    const lift = 1.2;
    const v = [
      [a.x - side.x, a.y + lift, a.z - side.z], [a.x + side.x, a.y + lift, a.z + side.z], [b.x + side.x, b.y + lift, b.z + side.z],
      [a.x - side.x, a.y + lift, a.z - side.z], [b.x + side.x, b.y + lift, b.z + side.z], [b.x - side.x, b.y + lift, b.z - side.z],
    ];
    for (let i = 0; i < 6; i++) {
      P[o + i * 3] = v[i][0]; P[o + i * 3 + 1] = v[i][1]; P[o + i * 3 + 2] = v[i][2];
      C[oc + i * 4] = 0.06; C[oc + i * 4 + 1] = 0.06; C[oc + i * 4 + 2] = 0.07; C[oc + i * 4 + 3] = alpha;
    }
    this.skDirty = true;
  }
}
