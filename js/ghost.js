// Récords por pista y fantasma de la mejor vuelta (se guardan en este navegador).
// El fantasma es una grabación de la posición del auto 20 veces por segundo durante la vuelta.
const REC_HZ = 20;

export class Records {
  constructor(store) { this.store = store; this.cache = new Map(); }
  key(track) { return 'rv.rec.' + track; }
  get(track) {
    if (this.cache.has(track)) return this.cache.get(track);
    let r = null;
    try { r = JSON.parse(this.store.get(this.key(track), 'null')); } catch (e) {}
    this.cache.set(track, r);
    return r;
  }
  // devuelve true si es récord nuevo. ghost: muestras de la vuelta (opcional)
  submit(track, lap, info, ghost) {
    const cur = this.get(track);
    if (cur && cur.lap <= lap) return false;
    const r = { lap: Math.round(lap), car: info.car, name: info.name, date: Date.now() };
    this.cache.set(track, r);
    this.store.set(this.key(track), JSON.stringify(r));
    if (ghost) this.store.set(this.key(track) + '.ghost', JSON.stringify({ car: info.car, lap: r.lap, s: ghost }));
    return true;
  }
  ghost(track) {
    try { const g = JSON.parse(this.store.get(this.key(track) + '.ghost', 'null')); return g && Array.isArray(g.s) && g.s.length > 4 ? g : null; } catch (e) { return null; }
  }
}

// Graba la vuelta en curso
export class LapRecorder {
  constructor() { this.s = []; this.start = 0; this.next = 0; }
  begin(t0) { this.s = []; this.start = t0; this.next = 0; }
  sample(now, pos, quat) {
    const t = (now - this.start) / 1000;
    if (t < this.next) return;
    this.next = t + 1 / REC_HZ;
    const r = v => Math.round(v * 10) / 10, q = v => Math.round(v * 1000) / 1000;
    this.s.push([Math.round(t * 1000) / 1000, r(pos.x), r(pos.y), r(pos.z), q(quat.x), q(quat.y), q(quat.z), q(quat.w)]);
    if (this.s.length > REC_HZ * 600) this.s.length = 0; // más de 10 minutos: no sirve como fantasma
  }
}

// Busca la posición del fantasma en el tiempo t (segundos desde que empezó la vuelta)
export function ghostAt(s, t, outPos, outQuat, tmpQuat) {
  if (!s.length || t > s[s.length - 1][0]) return false;
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m][0] <= t) lo = m; else hi = m; }
  const a = s[lo], b = s[hi];
  const k = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
  outPos.set(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
  outQuat.set(a[4], a[5], a[6], a[7]); tmpQuat.set(b[4], b[5], b[6], b[7]);
  outQuat.slerp(tmpQuat, k);
  return true;
}
