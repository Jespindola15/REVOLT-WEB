// Convierte mallas de Re-Volt en geometría de Three.js
import * as THREE from 'three';
import { FLAG_QUAD, FLAG_TRANSLUCENT } from './rvformats.js';

const texLoader = new THREE.TextureLoader();

export function loadTexture(url) {
  return new Promise((res, rej) => texLoader.load(url, t => {
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = false; // Re-Volt mide la coordenada V desde arriba de la imagen
    t.anisotropy = 4;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    res(t);
  }, undefined, rej));
}

export function makeMaterials(textures, fog = true) {
  // textures: array indexado por página. Devuelve fn(page, translucent) -> material
  const cache = new Map();
  return (page, translucent) => {
    const key = page + (translucent ? 't' : 'o');
    if (cache.has(key)) return cache.get(key);
    const map = page >= 0 ? textures[page] || null : null;
    const mat = new THREE.MeshBasicMaterial({
      map, vertexColors: true, side: THREE.DoubleSide, fog,
      transparent: translucent, depthWrite: !translucent,
      alphaTest: translucent ? 0.02 : 0.5,
    });
    cache.set(key, mat);
    return mat;
  };
}

// meshes: [{polys, verts, xform?: (x,y,z)->[x,y,z] en coords three}]
// opts.brightness: multiplicador de color de vértice
// Devuelve { group, collision: Float32Array de triángulos sólidos }
export function buildMeshes(meshes, getMat, opts = {}) {
  const bright = opts.brightness ?? 1;
  const buckets = new Map(); // key -> {pos:[], uv:[], col:[], page, translucent}
  const coll = [];
  for (const m of meshes) {
    const V = m.verts;
    const xf = m.xform || ((x, y, z) => [x, -y, -z]);
    const tv = new Array(V.length / 3);
    for (let i = 0; i < tv.length; i++) tv[i] = xf(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]);
    for (const p of m.polys) {
      const quad = (p.type & FLAG_QUAD) !== 0;
      const trans = (p.type & FLAG_TRANSLUCENT) !== 0;
      const page = p.tex;
      const key = page + (trans ? 't' : 'o');
      let b = buckets.get(key);
      if (!b) { b = { pos: [], uv: [], col: [], page, trans }; buckets.set(key, b); }
      const tris = quad ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
      for (const t of tris) {
        for (const k of t) {
          const v = tv[p.idx[k]];
          if (!v) continue;
          b.pos.push(v[0], v[1], v[2]);
          b.uv.push(p.uv[k][0], p.uv[k][1]);
          const c = p.col[k];
          b.col.push(Math.min(1, c[0] / 255 * bright), Math.min(1, c[1] / 255 * bright), Math.min(1, c[2] / 255 * bright), trans ? c[3] / 255 : 1);
        }
        if (m.solid !== false && !trans) {
          for (const k of t) { const v = tv[p.idx[k]]; coll.push(v[0], v[1], v[2]); }
        }
      }
    }
  }
  const group = new THREE.Group();
  for (const b of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 4));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, getMat(b.page, b.trans));
    if (b.trans) mesh.renderOrder = 2;
    group.add(mesh);
  }
  return { group, collision: new Float32Array(coll) };
}
