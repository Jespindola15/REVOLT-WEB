// Sonido del juego: motores (propio y de los rivales en 3D), efectos originales de Re-Volt y música por pista.
// Todo con Web Audio. El navegador solo deja sonar después de un clic, por eso hay unlock().

export class GameAudio {
  constructor(store) {
    this.store = store;
    this.ctx = null;
    this.base = '';
    this.buffers = new Map();     // url -> Promise<AudioBuffer>
    this.sfxVol = +store.get('rv.sfxvol', '80') / 100;
    this.musicVol = +store.get('rv.musvol', '50') / 100;
    this.muted = store.get('rv.mute', '0') === '1';
    this.own = null;              // motor propio { src, gain, url }
    this.skid = null;             // derrape propio
    this.remotes = new Map();     // id -> { src, gain, panner, url }
    this.music = new Audio(); this.music.loop = true; this.music.preload = 'auto';
    this.musicUrl = null;
    this.lastHit = 0;
  }

  setBase(base) { this.base = base; }

  unlock() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
      const c = this.ctx;
      this.master = c.createGain(); this.master.connect(c.destination);
      this.sfxBus = c.createGain(); this.sfxBus.connect(this.master);
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.musicUrl && this.music.paused && !this.muted && this.musicVol > 0) this.music.play().catch(() => {});
  }

  applyVolumes() {
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
    if (this.sfxBus) this.sfxBus.gain.value = this.sfxVol;
    this.music.volume = this.muted ? 0 : this.musicVol;
    if (this.muted || this.musicVol === 0) this.music.pause();
    else if (this.musicUrl && this.ctx && this.music.paused) this.music.play().catch(() => {});
  }
  setSfxVolume(v) { this.sfxVol = v; this.store.set('rv.sfxvol', String(Math.round(v * 100))); this.applyVolumes(); }
  setMusicVolume(v) { this.musicVol = v; this.store.set('rv.musvol', String(Math.round(v * 100))); this.applyVolumes(); }
  toggleMute() { this.muted = !this.muted; this.store.set('rv.mute', this.muted ? '1' : '0'); this.applyVolumes(); return this.muted; }

  load(url) {
    if (!this.ctx) return Promise.reject(new Error('audio bloqueado'));
    if (!this.buffers.has(url)) {
      this.buffers.set(url, fetch(this.base + url).then(r => { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
        .then(b => this.ctx.decodeAudioData(b)).catch(e => { this.buffers.delete(url); throw e; }));
    }
    return this.buffers.get(url);
  }

  // Efecto suelto (no en bucle)
  async play(name, { vol = 1, rate = 1 } = {}) {
    if (!this.ctx || this.muted) return;
    try {
      const buf = await this.load('sfx/' + name + '.wav');
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
      const g = this.ctx.createGain(); g.gain.value = vol;
      src.connect(g); g.connect(this.sfxBus); src.start();
    } catch (e) {}
  }

  // Efecto que suena desde un punto del mundo (explosiones, disparos de los rivales)
  async playAt(name, pos, { vol = 1, rate = 1 } = {}) {
    if (!this.ctx || this.muted) return;
    try {
      const buf = await this.load('sfx/' + name + '.wav');
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
      const g = this.ctx.createGain(); g.gain.value = vol;
      const p = this.ctx.createPanner();
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = 300; p.rolloffFactor = 1.2; p.maxDistance = 15000;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
      src.connect(g); g.connect(p); p.connect(this.sfxBus); src.start();
    } catch (e) {}
  }

  // Golpe (contra la pista o contra otro auto); no más de uno cada 120 ms
  hit(strength) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (t - this.lastHit < 0.12) return;
    this.lastHit = t;
    this.play(strength > 0.6 ? 'hit2' : 'hit1', { vol: 0.35 + strength * 0.65, rate: 0.9 + Math.random() * 0.2 });
  }

  async loopSource(url) {
    const buf = await this.load(url);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    src.connect(gain);
    return { src, gain, url };
  }

  // ---- motor propio ----
  async setOwnEngine(url) {
    if (!this.ctx) return;
    if (this.own?.url === url) return;
    this.stopOwnEngine();
    const want = url; this.ownWant = url;
    try {
      const e = await this.loopSource(url);
      if (this.ownWant !== want) return;
      e.gain.connect(this.sfxBus); e.src.start(); this.own = e;
      if (!this.skid) {
        const s = await this.loopSource('sfx/skid_normal.wav');
        s.gain.connect(this.sfxBus); s.src.start(); this.skid = s;
      }
    } catch (err) {}
  }
  stopOwnEngine() {
    if (this.own) { try { this.own.src.stop(); } catch (e) {} this.own.gain.disconnect(); this.own = null; }
  }
  // frac: velocidad / velocidad máxima (0..1). Como en Re-Volt, el tono del motor sube con la velocidad.
  updateOwn(frac, throttle, skid, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.own) {
      this.own.src.playbackRate.setTargetAtTime(0.55 + Math.min(1.1, frac) * 1.45 + Math.abs(throttle) * 0.12, t, 0.05);
      this.own.gain.gain.setTargetAtTime(active ? 0.28 + Math.abs(throttle) * 0.32 : 0.12, t, 0.08);
    }
    if (this.skid) this.skid.gain.gain.setTargetAtTime(active ? Math.min(0.6, skid * 0.6) : 0, t, 0.05);
  }

  // ---- motores de los rivales, en 3D ----
  async addRemote(id, url) {
    if (!this.ctx) return;
    const cur = this.remotes.get(id);
    if (cur && (cur.url === url || cur.pending === url)) return;
    this.removeRemote(id);
    this.remotes.set(id, { pending: url });
    try {
      const e = await this.loopSource(url);
      if (this.remotes.get(id)?.pending !== url) return;
      const p = this.ctx.createPanner();
      p.panningModel = 'equalpower'; p.distanceModel = 'inverse';
      p.refDistance = 180; p.rolloffFactor = 1.3; p.maxDistance = 12000;
      e.gain.connect(p); p.connect(this.sfxBus); e.src.start();
      this.remotes.set(id, { ...e, panner: p });
    } catch (err) { this.remotes.delete(id); }
  }
  removeRemote(id) {
    const r = this.remotes.get(id);
    if (r?.src) { try { r.src.stop(); } catch (e) {} r.panner.disconnect(); }
    this.remotes.delete(id);
  }
  clearRemotes() { for (const id of [...this.remotes.keys()]) this.removeRemote(id); }
  updateRemote(id, pos, frac, visible) {
    const r = this.remotes.get(id); if (!r?.src) return;
    const t = this.ctx.currentTime;
    setPos(r.panner, pos.x, pos.y, pos.z, t);
    r.src.playbackRate.setTargetAtTime(0.55 + Math.min(1.1, frac) * 1.45, t, 0.08);
    r.gain.gain.setTargetAtTime(visible ? 0.45 : 0, t, 0.1);
  }

  // El oyente es la cámara: posición, hacia dónde mira y hacia dónde es "arriba"
  updateListener(p, fw, up) {
    if (!this.ctx) return;
    const L = this.ctx.listener, t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(fw.x, t, 0.02); L.forwardY.setTargetAtTime(fw.y, t, 0.02); L.forwardZ.setTargetAtTime(fw.z, t, 0.02);
      L.upX.setTargetAtTime(up.x, t, 0.02); L.upY.setTargetAtTime(up.y, t, 0.02); L.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      L.setPosition(p.x, p.y, p.z); L.setOrientation(fw.x, fw.y, fw.z, up.x, up.y, up.z);
    }
  }

  // ---- música ----
  setMusic(url) {
    if (url === this.musicUrl) return;
    this.musicUrl = url;
    this.music.pause();
    if (!url) return;
    this.music.src = this.base + url;
    if (this.ctx && !this.muted && this.musicVol > 0) this.music.play().catch(() => {});
  }
}

function setPos(panner, x, y, z, t) {
  if (panner.positionX) { panner.positionX.setTargetAtTime(x, t, 0.03); panner.positionY.setTargetAtTime(y, t, 0.03); panner.positionZ.setTargetAtTime(z, t, 0.03); }
  else panner.setPosition(x, y, z);
}
