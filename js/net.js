// Multijugador por WebRTC con PeerJS. Topología estrella: el anfitrión reenvía a todos.
//
// Sala robusta:
// - Si el anfitrión se va, el siguiente jugador de la lista toma su lugar con el MISMO código
//   y los demás se reconectan solos. La carrera sigue.
// - Si a alguien se le corta la conexión un momento, vuelve a entrar solo.
const PREFIX = 'rvweb-hood-';
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Relay público gratuito (puede no estar disponible siempre); ayuda con redes estrictas
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};
const RECOVER_FOR = 35000;   // cuánto tiempo se intenta recuperar la sala
const HOST_SILENCE = 4500;   // sin noticias del anfitrión por este tiempo = se cortó

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Net {
  constructor(h) {
    this.h = h; // { onRoster, onState, onEvent, onStatus }
    this.isHost = false; this.peer = null; this.conns = new Map(); this.hostConn = null;
    this.players = new Map(); // id -> {id,name,car}, en el orden en que entraron
    this.myId = null; this.code = null; this.active = false;
    this.name = ''; this.car = '';
    this.recovering = false; this.closed = false;
    this.lastHost = 0;
    this.watch = setInterval(() => this._watchdog(), 1000);
  }

  _peer(id) {
    if (!window.Peer) throw new Error('No se pudo cargar PeerJS (¿sin internet?)');
    const p = id ? new window.Peer(id, { config: ICE, debug: 1 }) : new window.Peer({ config: ICE, debug: 1 });
    // si se cae la conexión con el servidor de PeerJS, volver a engancharse (los datos siguen por WebRTC)
    p.on('disconnected', () => { if (!this.closed && !p.destroyed) setTimeout(() => { try { p.reconnect(); } catch (e) {} }, 1000); });
    return p;
  }

  // ---------- Anfitrión ----------
  host(name, car) {
    this.name = name; this.car = car;
    return this._openHost(makeCode()).then(code => code);
  }

  // abre la sala con ese código (también la usa el jugador que reemplaza al anfitrión)
  _openHost(code, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const peer = this._peer(PREFIX + code);
      const timer = setTimeout(() => { try { peer.destroy(); } catch (e) {} reject(new Error('timeout')); }, timeout);
      peer.on('open', () => {
        clearTimeout(timer);
        if (this.peer && this.peer !== peer) { try { this.peer.destroy(); } catch (e) {} }
        this.peer = peer; this.isHost = true; this.hostConn = null;
        this.code = code; this.myId = 'host'; this.active = true;
        this.conns = new Map();
        this.players = new Map([['host', { id: 'host', name: this.name, car: this.car }]]);
        this._roster();
        resolve(code);
      });
      peer.on('error', e => {
        clearTimeout(timer);
        if (!this.active || this.peer !== peer) { try { peer.destroy(); } catch (x) {} reject(e); return; }
        this.h.onStatus?.('Error de conexión: ' + (e.type || e.message));
      });
      peer.on('connection', conn => {
        conn.on('data', d => this._hostData(conn, d));
        conn.on('close', () => this._drop(conn.peer, conn));
        conn.on('error', () => this._drop(conn.peer, conn));
      });
    });
  }

  // ---------- Invitado ----------
  join(code, name, car) {
    this.name = name; this.car = car;
    this.code = code.toUpperCase().trim();
    return new Promise((resolve, reject) => {
      this.isHost = false;
      const peer = this.peer = this._peer();
      const timer = setTimeout(() => reject(new Error('No se encontró la sala ' + this.code + ' (revisá el código)')), 15000);
      peer.on('error', e => {
        if (!this.active) { clearTimeout(timer); this.h.onStatus?.('Error: ' + (e.type || e.message)); reject(e); }
      });
      peer.on('open', id => {
        this.myId = id;
        this._connectHost(10000).then(() => { clearTimeout(timer); resolve(id); }).catch(() => {});
      });
    });
  }

  // conecta (o reconecta) con el anfitrión de la sala
  _connectHost(timeout) {
    return new Promise((resolve, reject) => {
      if (!this.peer || this.peer.destroyed) { reject(new Error('sin peer')); return; }
      if (this.peer.disconnected) { try { this.peer.reconnect(); } catch (e) {} }
      const conn = this.peer.connect(PREFIX + this.code, { serialization: 'json', reliable: true });
      let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; try { conn.close(); } catch (e) {} reject(new Error('timeout')); }, timeout);
      conn.on('open', () => {
        if (done) return; done = true; clearTimeout(timer);
        if (this.hostConn && this.hostConn !== conn) { try { this.hostConn.close(); } catch (e) {} }
        this.hostConn = conn; this.active = true; this.isHost = false; this.lastHost = performance.now();
        conn.send({ t: 'hello', name: this.name, car: this.car });
        resolve();
      });
      conn.on('data', d => { if (conn === this.hostConn) { this.lastHost = performance.now(); this._clientData(d); } });
      conn.on('close', () => { if (conn === this.hostConn) this._lostHost(); });
      conn.on('error', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('error')); } else if (conn === this.hostConn) this._lostHost(); });
    });
  }

  _watchdog() {
    if (this.closed || !this.active || this.isHost || this.recovering) return;
    if (this.hostConn && performance.now() - this.lastHost > HOST_SILENCE) this._lostHost();
  }

  // se cortó la conexión con el anfitrión: reconectar, o tomar su lugar si soy el que sigue
  async _lostHost() {
    if (this.closed || this.isHost || this.recovering) return;
    this.recovering = true;
    const old = this.hostConn; this.hostConn = null;
    try { old?.close(); } catch (e) {}
    this.h.onEvent?.({ t: 'reconnecting' });
    // orden para reemplazar al anfitrión: el orden en que entraron los demás
    const order = [...this.players.keys()].filter(id => id !== 'host');
    let turn = Math.max(0, order.indexOf(this.myId));
    const t0 = performance.now();
    let tried = false;
    await sleep(1200);
    while (!this.closed && performance.now() - t0 < RECOVER_FOR) {
      const el = performance.now() - t0;
      // mi turno de abrir la sala con el mismo código (cada uno espera un poco más que el anterior)
      if (!tried && el > 1500 + turn * 4500) {
        tried = true;
        try {
          await this._openHost(this.code, 6000);
          this.recovering = false;
          this.h.onEvent?.({ t: 'becamehost' });
          return;
        } catch (e) { /* el código sigue ocupado: el anfitrión sigue ahí o ya lo tomó otro */ }
      }
      try {
        await this._connectHost(4000);
        this.recovering = false;
        this.h.onEvent?.({ t: 'reconnected' });
        return;
      } catch (e) {}
      if (tried) turn = 99; // ya probé abrirla; ahora solo intento entrar
      await sleep(1500);
    }
    this.recovering = false; this.active = false;
    if (!this.closed) this.h.onEvent?.({ t: 'hostgone' });
  }

  _drop(id, conn) {
    const cur = this.conns.get(id);
    if (!cur || (conn && cur !== conn)) return;
    this.conns.delete(id); this.players.delete(id);
    this._roster();
    this._broadcast({ t: 'gone', id });
    this.h.onEvent?.({ t: 'gone', id });
  }

  _roster() {
    const list = [...this.players.values()];
    this._broadcast({ t: 'roster', players: list });
    this.h.onRoster?.(list);
  }

  _broadcast(msg, exceptId) {
    for (const [id, c] of this.conns) if (id !== exceptId && c.open) { try { c.send(msg); } catch (e) {} }
  }

  _hostData(conn, d) {
    if (!d || !d.t) return;
    if (d.t === 'hello') {
      const known = this.players.has(conn.peer);
      if (!known && this.players.size >= 8) { conn.send({ t: 'full' }); return; }
      const prev = this.conns.get(conn.peer);
      if (prev && prev !== conn) { try { prev.close(); } catch (e) {} }
      this.conns.set(conn.peer, conn);
      this.players.set(conn.peer, { id: conn.peer, name: String(d.name || 'Jugador').slice(0, 16), car: d.car });
      this._roster();
      this.h.onEvent?.({ t: 'joined', id: conn.peer });
      return;
    }
    if (this.conns.get(conn.peer) !== conn) return;
    if (d.t === 'car') { const p = this.players.get(conn.peer); if (p) { p.car = d.car; this._roster(); } return; }
    d.id = conn.peer;
    if (d.t === 'state') { this._broadcast(d, conn.peer); this.h.onState?.(d); return; }
    this._broadcast(d, conn.peer);
    this.h.onEvent?.(d);
  }

  _clientData(d) {
    if (!d || !d.t) return;
    if (d.t === 'roster') { this.players = new Map(d.players.map(p => [p.id, p])); this.h.onRoster?.(d.players); return; }
    if (d.t === 'state') { this.h.onState?.(d); return; }
    this.h.onEvent?.(d);
  }

  send(msg) {
    if (!this.active) return;
    if (this.isHost) {
      msg.id = 'host';
      this._broadcast(msg);
    } else if (this.hostConn?.open) {
      try { this.hostConn.send(msg); } catch (e) {}
    }
  }

  setCar(car) { this.car = car; }

  close() {
    this.closed = true; clearInterval(this.watch);
    try { this.peer?.destroy(); } catch (e) {}
    this.active = false; this.conns.clear(); this.players.clear();
  }
}
