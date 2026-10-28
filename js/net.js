// Multijugador por WebRTC con PeerJS. Topología estrella: el anfitrión reenvía a todos.
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

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

export class Net {
  constructor(h) {
    this.h = h; // { onRoster, onState, onEvent, onStatus }
    this.isHost = false; this.peer = null; this.conns = new Map(); this.hostConn = null;
    this.players = new Map(); // id -> {id,name,car}
    this.myId = null; this.code = null; this.active = false;
  }

  _peer(id) {
    if (!window.Peer) throw new Error('No se pudo cargar PeerJS (¿sin internet?)');
    return id ? new window.Peer(id, { config: ICE, debug: 1 }) : new window.Peer({ config: ICE, debug: 1 });
  }

  host(name, car) {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      const code = makeCode();
      const peer = this.peer = this._peer(PREFIX + code);
      peer.on('open', () => {
        this.code = code; this.myId = 'host'; this.active = true;
        this.players.set('host', { id: 'host', name, car });
        this._roster();
        resolve(code);
      });
      peer.on('error', e => { this.h.onStatus?.('Error de conexión: ' + (e.type || e.message)); reject(e); });
      peer.on('connection', conn => {
        conn.on('data', d => this._hostData(conn, d));
        conn.on('close', () => this._drop(conn.peer));
        conn.on('error', () => this._drop(conn.peer));
      });
    });
  }

  join(code, name, car) {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      const peer = this.peer = this._peer();
      const timer = setTimeout(() => reject(new Error('No se encontró la sala ' + code + ' (revisá el código)')), 15000);
      peer.on('error', e => { clearTimeout(timer); this.h.onStatus?.('Error: ' + (e.type || e.message)); reject(e); });
      peer.on('open', id => {
        this.myId = id;
        const conn = this.hostConn = peer.connect(PREFIX + code.toUpperCase().trim(), { serialization: 'json', reliable: true });
        conn.on('open', () => {
          clearTimeout(timer);
          this.code = code; this.active = true;
          conn.send({ t: 'hello', name, car });
          resolve(id);
        });
        conn.on('data', d => this._clientData(d));
        conn.on('close', () => { this.active = false; this.h.onStatus?.('Se cortó la conexión con el anfitrión'); this.h.onEvent?.({ t: 'hostgone' }); });
      });
    });
  }

  _drop(id) {
    if (!this.conns.has(id)) return;
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
      if (this.players.size >= 8) { conn.send({ t: 'full' }); return; }
      this.conns.set(conn.peer, conn);
      this.players.set(conn.peer, { id: conn.peer, name: String(d.name || 'Jugador').slice(0, 16), car: d.car });
      this._roster();
      return;
    }
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

  close() {
    try { this.peer?.destroy(); } catch (e) {}
    this.active = false; this.conns.clear(); this.players.clear();
  }
}
