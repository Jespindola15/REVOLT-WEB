// Minimapa: la pista vista desde arriba (dibujada con los nodos de IA o el recorrido) y un punto por auto.
// Arriba del mapa es hacia donde arranca la carrera, para que sea fácil de leer.
export class Minimap {
  constructor(canvas) {
    this.cv = canvas; this.g = canvas.getContext('2d');
    this.bg = document.createElement('canvas');
    this.track = null;
  }

  // segs: [{a:{x,z}, b:{x,z}, w}] tramos de la pista; start: {x,z}; startDir: {x,z} dirección de largada
  setTrack(segs, start, startDir) {
    this.track = null;
    if (!segs.length) return;
    // girar para que la largada apunte hacia arriba
    const ang = Math.atan2(startDir.x, -startDir.z);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    this.rot = (x, z) => [x * c - z * s, x * s + z * c];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, wMax = 0;
    for (const sg of segs) for (const p of [sg.a, sg.b]) {
      const [x, z] = this.rot(p.x, p.z);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      wMax = Math.max(wMax, sg.w);
    }
    const pad = wMax * 0.6 + 200;
    x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
    const S = 512, span = Math.max(x1 - x0, z1 - z0);
    this.k = S / span; this.ox = (x0 + x1) / 2; this.oz = (z0 + z1) / 2;
    this.toPx = (x, z) => { const [rx, rz] = this.rot(x, z); return [S / 2 + (rx - this.ox) * this.k, S / 2 + (rz - this.oz) * this.k]; };
    const bg = this.bg; bg.width = bg.height = S;
    const g = bg.getContext('2d');
    g.clearRect(0, 0, S, S);
    g.lineCap = g.lineJoin = 'round';
    for (const [color, extra] of [['rgba(10,12,28,0.85)', 10], ['#e8dfc4', 0]]) {
      g.strokeStyle = color;
      for (const sg of segs) {
        g.lineWidth = Math.max(5, sg.w * this.k * 0.55) + extra;
        const [ax, az] = this.toPx(sg.a.x, sg.a.z), [bx, bz] = this.toPx(sg.b.x, sg.b.z);
        g.beginPath(); g.moveTo(ax, az); g.lineTo(bx, bz); g.stroke();
      }
    }
    // línea de largada
    const [sx, sz] = this.toPx(start.x, start.z);
    g.fillStyle = '#12162b'; g.fillRect(sx - 12, sz - 3, 24, 6);
    g.fillStyle = '#ffffff'; for (let i = 0; i < 4; i++) g.fillRect(sx - 12 + i * 6, sz - 3 + (i % 2) * 3, 3, 3);
    this.track = true;
  }

  // cars: [{x, z, dir:{x,z}|null, color, me, label}]
  draw(cars) {
    const cv = this.cv, g = this.g;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.track) return;
    g.drawImage(this.bg, 0, 0, W, H);
    const f = W / 512;
    // primero los demás, después vos (arriba de todo)
    const list = [...cars].sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
    for (const c of list) {
      const [px, pz] = this.toPx(c.x, c.z); const x = px * f, y = pz * f;
      if (c.me && c.dir) {
        const [dx, dz] = this.rot(c.dir.x, c.dir.z); const a = Math.atan2(dz, dx);
        g.save(); g.translate(x, y); g.rotate(a);
        g.beginPath(); g.moveTo(8, 0); g.lineTo(-5, -5.5); g.lineTo(-2, 0); g.lineTo(-5, 5.5); g.closePath();
        g.fillStyle = c.color; g.strokeStyle = '#12162b'; g.lineWidth = 2; g.stroke(); g.fill();
        g.restore();
      } else {
        g.beginPath(); g.arc(x, y, c.ghost ? 3 : 4, 0, Math.PI * 2);
        g.fillStyle = c.color; g.strokeStyle = '#12162b'; g.lineWidth = 1.5;
        if (c.ghost) g.globalAlpha = 0.6;
        g.fill(); g.stroke(); g.globalAlpha = 1;
      }
    }
  }
}
