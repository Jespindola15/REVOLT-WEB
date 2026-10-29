// Datos de las pistas para el menú (Fase 2): datos reales de los archivos de la pista.
// No carga la pista entera: solo los archivos chicos (.inf, .fan, .pan, .fob).
// (La foto de cada pista es tracks/<id>/preview.jpg, la imagen de carga del juego.)
import { parseFAN, parsePAN, rv2three } from './rvformats.js';
import { AiPath } from './ai.js';

// Escala del juego: la misma que usa el velocímetro (TopEnd 2860 ≈ 33.5 mph) → metros por unidad
export const METERS_PER_UNIT = (1 / 85.4) * 1609.344 / 3600;
export const DIFF_NAMES = ['', 'Fácil', 'Media', 'Difícil', 'Extrema'];

// Tramos de la pista para el minimapa: nodos de IA (con su ancho) o, si no hay, el recorrido de posiciones
export function minimapSegs(ai, path) {
  const segs = [];
  if (ai) for (const n of ai.nodes) for (const j of n.next) { const m = ai.nodes[j]; segs.push({ a: n.p, b: m.p, w: (n.w + m.w) / 2 }); }
  else if (path) {
    const P = n => ({ x: n.pos[0], z: -n.pos[2] });
    for (const n of path.nodes) for (const j of n.next) segs.push({ a: P(n), b: P(path.nodes[j]), w: 450 });
  }
  return segs;
}
// Largada (punto y dirección) en coordenadas three, desde el .inf
export function startOf(inf) {
  const S = rv2three(...inf.startPos), a = inf.startRot * Math.PI * 2;
  const f = rv2three(Math.sin(a), 0, Math.cos(a));
  return { start: { x: S[0], z: S[2] }, dir: { x: f[0], z: f[2] } };
}

const cache = new Map();
async function get(url, text) {
  try { const r = await fetch(url); if (!r.ok) return null; return text ? r.text() : r.arrayBuffer(); } catch (e) { return null; }
}

// def: entrada del manifest. Devuelve { lengthM, difficulty (1..4 o null), bonus, music, forks }
export function trackInfo(base, def) {
  if (cache.has(def.id)) return cache.get(def.id);
  const dir = base + 'tracks/' + def.id + '/';
  const job = (async () => {
    const [infTxt, fanBuf, panBuf, fobBuf] = await Promise.all([
      get(dir + def.id + '.inf', true), get(dir + def.id + '.fan'), get(dir + def.id + '.pan'), get(dir + def.id + '.fob'),
    ]);
    let ai = null, path = null;
    try { if (fanBuf) { const f = parseFAN(fanBuf); if (f.length > 2) ai = new AiPath(f); } } catch (e) {}
    try { if (panBuf) path = parsePAN(panBuf); } catch (e) {}
    const dm = infTxt && infTxt.match(/^\s*DIFFICULTY\s+(\d+)/mi);
    const difficulty = dm ? Math.max(1, Math.min(4, +dm[1])) || null : null;
    let bonus = 0;
    if (fobBuf) { const dv = new DataView(fobBuf), n = dv.getInt32(0, true); for (let i = 0; i < n; i++) if (4 + i * 56 + 4 <= fobBuf.byteLength && dv.getInt32(4 + i * 56, true) === 30) bonus++; }
    const total = path?.total || ai?.total || 0;
    const forks = ai ? ai.nodes.filter(n => n.next.length > 1).length : 0;
    return { id: def.id, lengthM: total ? Math.round(total * METERS_PER_UNIT) : null, difficulty, bonus, music: !!def.music, forks };
  })();
  cache.set(def.id, job);
  return job;
}
