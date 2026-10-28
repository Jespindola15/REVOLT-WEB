// Lectores de los formatos de Re-Volt / RVGL (.prm, .w, .fin, .taz, .inf, parameters.txt)
// Re-Volt usa Y hacia abajo. Convertimos a coordenadas de Three.js rotando 180° en X:
// (x, y, z) -> (x, -y, -z). Es una rotación propia, así que no espeja nada.

export const FLAG_QUAD = 0x001;
export const FLAG_DOUBLE = 0x002;
export const FLAG_TRANSLUCENT = 0x004;

export function rv2three(x, y, z) { return [x, -y, -z]; }

// Lee polígonos + vértices a partir de un offset. Devuelve {polys, verts, offset}
function readMeshBody(dv, o) {
  const pc = dv.getInt16(o, true), vc = dv.getInt16(o + 2, true); o += 4;
  const polys = new Array(pc);
  for (let i = 0; i < pc; i++) {
    const type = dv.getInt16(o, true), tex = dv.getInt16(o + 2, true);
    const idx = [dv.getInt16(o + 4, true), dv.getInt16(o + 6, true), dv.getInt16(o + 8, true), dv.getInt16(o + 10, true)];
    const col = [];
    for (let k = 0; k < 4; k++) {
      const b = o + 12 + k * 4;
      col.push([dv.getUint8(b + 2), dv.getUint8(b + 1), dv.getUint8(b), dv.getUint8(b + 3)]); // r g b a
    }
    const uv = [];
    for (let k = 0; k < 4; k++) uv.push([dv.getFloat32(o + 28 + k * 8, true), dv.getFloat32(o + 32 + k * 8, true)]);
    polys[i] = { type, tex, idx, col, uv };
    o += 60;
  }
  const verts = new Float32Array(vc * 3);
  for (let i = 0; i < vc; i++) {
    verts[i * 3] = dv.getFloat32(o, true);
    verts[i * 3 + 1] = dv.getFloat32(o + 4, true);
    verts[i * 3 + 2] = dv.getFloat32(o + 8, true);
    o += 24;
  }
  return { polys, verts, offset: o };
}

export function parsePRM(buf) {
  const dv = new DataView(buf);
  const m = readMeshBody(dv, 0);
  return { polys: m.polys, verts: m.verts };
}

export function parseW(buf) {
  const dv = new DataView(buf);
  let o = 0;
  const n = dv.getInt32(o, true); o += 4;
  const meshes = [];
  for (let i = 0; i < n; i++) {
    o += 16 + 24; // bounding sphere + bbox
    const m = readMeshBody(dv, o);
    o = m.offset;
    meshes.push({ polys: m.polys, verts: m.verts });
  }
  return meshes;
}

// .fin: instancias de objetos (casas, árboles, postes...)
export function parseFIN(buf) {
  const dv = new DataView(buf);
  const n = dv.getInt32(0, true);
  const out = [];
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 72;
    let name = '';
    for (let k = 0; k < 9 && u8[o + k]; k++) name += String.fromCharCode(u8[o + k]);
    const pos = [dv.getFloat32(o + 24, true), dv.getFloat32(o + 28, true), dv.getFloat32(o + 32, true)];
    const mat = [];
    for (let k = 0; k < 9; k++) mat.push(dv.getFloat32(o + 36 + k * 4, true));
    out.push({ name: name.toLowerCase(), pos, mat });
  }
  return out;
}

// .taz: zonas de la pista, en orden, para contar vueltas
export function parseTAZ(buf) {
  const dv = new DataView(buf);
  const n = dv.getInt32(0, true);
  const zones = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 64;
    const id = dv.getInt32(o, true);
    const c = [dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)];
    const m = []; for (let k = 0; k < 9; k++) m.push(dv.getFloat32(o + 16 + k * 4, true));
    const s = [dv.getFloat32(o + 52, true), dv.getFloat32(o + 56, true), dv.getFloat32(o + 60, true)];
    zones.push({ id, c, m, s });
  }
  return zones;
}

export function zoneContains(z, p) { // p en coords Re-Volt
  const d = [p[0] - z.c[0], p[1] - z.c[1], p[2] - z.c[2]];
  for (let r = 0; r < 3; r++) {
    const v = d[0] * z.m[r * 3] + d[1] * z.m[r * 3 + 1] + d[2] * z.m[r * 3 + 2];
    if (Math.abs(v) > z.s[r]) return false;
  }
  return true;
}

export function parseINF(text) {
  const inf = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\s+(.*)$/);
    if (!m) continue;
    inf[m[1].toUpperCase()] = m[2].trim();
  }
  const nums = s => (s || '').split(/[\s,]+/).filter(Boolean).map(parseFloat);
  return {
    name: (inf.NAME || '').replace(/'/g, ''),
    startPos: nums(inf.STARTPOS),
    startRot: parseFloat(inf.STARTROT || '0'),
    fogColor: nums(inf.FOGCOLOR || '80 144 192'),
    farClip: parseFloat(inf.FARCLIP || '24000'),
    fogStart: parseFloat(inf.FOGSTART || '9000'),
  };
}

// parameters.txt de un auto: tomamos lo que usa la física
export function parseCarParams(text) {
  const clean = text.replace(/;[^\n]*/g, '');
  const num = (src, key, def) => {
    const m = src.match(new RegExp('^\\s*' + key + '\\s+([-\\d.eE]+)', 'mi'));
    return m ? parseFloat(m[1]) : def;
  };
  const vec = (src, key) => {
    const m = src.match(new RegExp('^\\s*' + key + '\\s+([-\\d.eE]+)[\\s,]+([-\\d.eE]+)[\\s,]+([-\\d.eE]+)', 'mi'));
    return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : [0, 0, 0];
  };
  const bool = (src, key) => /TRUE/i.test((src.match(new RegExp('^\\s*' + key + '\\s+(\\w+)', 'mi')) || [])[1] || '');
  const block = (re) => { const m = clean.match(re); return m ? m[1] : ''; };
  const body = block(/BODY\s*\{([\s\S]*?)\}/i);
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = block(new RegExp('WHEEL\\s+' + i + '\\s*\\{([\\s\\S]*?)\\}', 'i'));
    wheels.push({
      offset1: vec(w, 'Offset1'), offset2: vec(w, 'Offset2'),
      present: bool(w, 'IsPresent'), powered: bool(w, 'IsPowered'), turnable: bool(w, 'IsTurnable'),
      steerRatio: num(w, 'SteerRatio', 0), radius: num(w, 'Radius', 10), maxPos: num(w, 'MaxPos', 8),
      grip: num(w, 'Grip', 0.015), staticFriction: num(w, 'StaticFriction', 1.5), kineticFriction: num(w, 'KineticFriction', 1.4),
      axleFriction: num(w, 'AxleFriction', 0.02),
      modelNum: num(w, 'ModelNum', i + 1), // qué modelo usa la rueda (algunos autos usan el mismo para las dos de cada lado)
    });
  }
  const springs = [];
  for (let i = 0; i < 4; i++) {
    const s = block(new RegExp('SPRING\\s+' + i + '\\s*\\{([\\s\\S]*?)\\}', 'i'));
    springs.push({ stiffness: num(s, 'Stiffness', 300), damping: num(s, 'Damping', 7) });
  }
  const top = clean.match(/^([\s\S]*?)BODY\s*\{/i);
  const head = top ? top[1] : clean;
  return {
    name: (text.match(/^\s*Name\s+"([^"]*)"/mi) || [])[1] || '?',
    topEnd: num(head, 'TopEnd', 0), topSpeed: num(head, 'TopSpeed', 30), acc: num(head, 'Acc', 6),
    cls: num(head, 'Class', 0), rating: num(head, 'Rating', -1),
    steerRate: num(head, 'SteerRate', 3), steerMod: num(head, 'SteerMod', 0.4), engineRate: num(head, 'EngineRate', 4),
    downForceMod: num(head, 'DownForceMod', 2), com: vec(head, 'CoM'),
    mass: num(body, 'Mass', 1.2), inertia: (() => {
      const m = body.match(/Inertia\s+([-\d.eE\s,]+)/i);
      const n = m ? m[1].split(/[\s,]+/).filter(Boolean).map(parseFloat) : [];
      return n.length >= 9 ? [n[0], n[4], n[8]] : [1000, 1200, 300];
    })(),
    bodyStatic: num(body, 'StaticFriction', 0.8), bodyKinetic: num(body, 'KineticFriction', 0.4),
    wheels, springs,
  };
}

// .pan: nodos de posición (el recorrido de la pista). Cada nodo: pos, distancia, prev[4], next[4]
export function parsePAN(buf) {
  const dv = new DataView(buf);
  const n = dv.getInt32(0, true), start = dv.getInt32(4, true), total = dv.getFloat32(8, true);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 48;
    const pos = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
    const dist = dv.getFloat32(o + 12, true);
    const prev = [], next = [];
    for (let k = 0; k < 4; k++) { prev.push(dv.getInt32(o + 16 + k * 4, true)); next.push(dv.getInt32(o + 32 + k * 4, true)); }
    nodes.push({ pos, dist, prev: prev.filter(x => x >= 0), next: next.filter(x => x >= 0) });
  }
  return { nodes, start, total };
}

// .fan: nodos de IA (por donde manejan los rivales de la computadora). Cada nodo tiene los dos
// bordes de la pista (Node[0] y Node[1]), la línea de carrera entre ellos (0..1) y hasta 2 caminos.
export function parseFAN(buf) {
  const dv = new DataView(buf);
  const n = dv.getInt16(0, true);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 76;
    if (o + 76 > buf.byteLength) break;
    const p = k => [dv.getFloat32(o + 48 + k * 16, true), dv.getFloat32(o + 52 + k * 16, true), dv.getFloat32(o + 56 + k * 16, true)];
    nodes.push({
      priority: dv.getInt8(o), start: dv.getInt8(o + 1),
      line: dv.getFloat32(o + 4, true), dist: dv.getFloat32(o + 8, true),
      prev: [dv.getInt32(o + 28, true), dv.getInt32(o + 32, true)].filter(x => x >= 0 && x < n),
      next: [dv.getInt32(o + 36, true), dv.getInt32(o + 40, true)].filter(x => x >= 0 && x < n),
      a: p(0), b: p(1),
    });
  }
  return nodes;
}

// .ncp de un objeto: polígonos de choque guardados como planos (la cara + 3 o 4 bordes).
// Se reconstruyen los vértices cortando el plano de la cara con cada par de bordes seguidos.
// Devuelve triángulos en coordenadas Re-Volt [x,y,z, x,y,z, ...]
export function parseNCP(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 2) return new Float32Array(0);
  const n = dv.getInt16(0, true);
  const out = [];
  const pl = (o, k) => [dv.getFloat32(o + 8 + k * 16, true), dv.getFloat32(o + 12 + k * 16, true), dv.getFloat32(o + 16 + k * 16, true), dv.getFloat32(o + 20 + k * 16, true)];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let i = 0; i < n; i++) {
    const o = 2 + i * 112;
    if (o + 112 > buf.byteLength) break;
    const type = dv.getInt32(o, true);
    const m = type & 1 ? 4 : 3;
    const P = [0, 1, 2, 3, 4].map(k => pl(o, k));
    const bb = [0, 1, 2, 3, 4, 5].map(k => dv.getFloat32(o + 88 + k * 4, true));
    const vs = [];
    for (let k = 0; k < m; k++) {
      const a = P[0], b = P[1 + k], c = P[1 + (k + 1) % m];
      const bc = cross(b, c), ca = cross(c, a), ab = cross(a, b);
      const det = dot(a, bc);
      if (Math.abs(det) < 1e-6) { vs.length = 0; break; }
      const v = [0, 1, 2].map(j => -(a[3] * bc[j] + b[3] * ca[j] + c[3] * ab[j]) / det);
      // por seguridad, dentro de la caja del polígono
      v[0] = Math.min(bb[1], Math.max(bb[0], v[0])); v[1] = Math.min(bb[3], Math.max(bb[2], v[1])); v[2] = Math.min(bb[5], Math.max(bb[4], v[2]));
      vs.push(v);
    }
    for (let k = 1; k + 1 < vs.length; k++) out.push(...vs[0], ...vs[k], ...vs[k + 1]);
  }
  return new Float32Array(out);
}
