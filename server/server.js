/* ============================================================
   РЕЗОНАНС — сервер: статика + WebSocket + комнаты + рейтинг
   Без внешних зависимостей (собственный WebSocket на http).
   Запуск: node server/server.js [порт]   (по умолчанию 8787)
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../js/engine.js');

/* ---------- режим одиночного exe (Node SEA) ---------- */
let SEA = null;
try { SEA = require('node:sea'); } catch (e) { SEA = null; }
let IS_SEA = false;
try { IS_SEA = !!(SEA && typeof SEA.isSea === 'function' && SEA.isSea()); } catch (e) { IS_SEA = false; }
const argvPort = process.argv.slice(2).find(a => /^\d+$/.test(a));
const PORT = parseInt(argvPort || process.env.PORT || '8787', 10);
const ROOT = IS_SEA ? path.dirname(process.execPath) : path.join(__dirname, '..');
const DATA_FILE = IS_SEA ? path.join(ROOT, 'data.json') : path.join(__dirname, 'data.json');
const TURN_TIME = 60000; // секунда на ход в онлайне

/* ---------- статика ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  // 1) встроенные ассеты (одиночный exe)
  if (IS_SEA) {
    const key = p.replace(/^\/+/, '');
    try {
      const a = SEA.getAsset(key); // по умолчанию: string (наши ассеты — текст) | ArrayBuffer
      if (a != null) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(Buffer.isBuffer(a) ? a : (typeof a === 'string' ? Buffer.from(a, 'utf8') : Buffer.from(a)));
        return;
      }
    } catch (e) {
      if (!globalThis.__assetWarn) { globalThis.__assetWarn = 1; console.error('[asset miss]', key, '| keys:', (() => { try { return SEA.getAssetKeys().join(', '); } catch (x) { return 'err:' + x.message; } })(), '|', e.message); }
    }
  }
  // 2) файлы на диске (режим разработки / папка рядом с exe)
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------- данные (рейтинг) ---------- */
let data = { players: {}, games: 0 };
function loadData() {
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { data = { players: {}, games: 0 }; }
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch (e) { }
}
loadData();

function elo(a, b, k) { return Math.round(k * (1 / (1 + Math.pow(10, (b - a) / 400)))); }

function getPlayer(name) {
  const key = String(name || '').trim().toLowerCase().slice(0, 20);
  if (!key) return null;
  if (!data.players[key]) {
    data.players[key] = {
      name: String(name).trim().slice(0, 20), rating: 1200, wins: 0, losses: 0, draws: 0,
      best: 1200, streak: 0, games: 0, created: Date.now()
    };
  }
  return data.players[key];
}

function topPlayers(n) {
  return Object.values(data.players)
    .filter(p => p.games > 0)
    .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
    .slice(0, n)
    .map(p => ({ name: p.name, rating: p.rating, wins: p.wins, losses: p.losses, draws: p.draws, games: p.games, best: p.best }));
}

/* ---------- WebSocket (RFC6455, минимальная реализация) ---------- */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

class Socket {
  constructor(ws) {
    this.ws = ws;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    ws.on('data', d => this.onData(d));
    ws.on('close', () => { this.alive = false; if (this.onClose) this.onClose(); });
    ws.on('error', () => { this.alive = false; });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1e6) { this.ws.destroy(); return; }
      const mlen = masked ? 4 : 0;
      if (this.buf.length < off + mlen + len) return;
      let payload = this.buf.slice(off + mlen, off + mlen + len);
      if (masked) {
        const mask = this.buf.slice(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = this.buf.slice(off + mlen + len);
      if (opcode === 0x8) { try { this.ws.end(); } catch (e) { } this.alive = false; return; }
      if (opcode === 0x9) { this.sendRaw(payload, 0xA); continue; }
      if (opcode === 0x1 && this.onMessage) {
        try { this.onMessage(payload.toString('utf8')); } catch (e) { console.error('msg error', e); }
      }
    }
  }
  sendRaw(payload, opcode) {
    if (!this.alive || this.ws.destroyed) return;
    let header;
    const len = payload.length;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.ws.write(Buffer.concat([header, payload])); } catch (e) { }
  }
  send(obj) {
    this.sendRaw(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1);
  }
}

/* ---------- комнаты и матчи ---------- */
const clients = new Map();  // id -> {sock, name, rating, room, token}
const rooms = new Map();    // code -> room
let nextClientId = 1;

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[(Math.random() * chars.length) | 0];
  return rooms.has(c) ? roomCode() : c;
}

function makeRoom(host, settings) {
  const code = roomCode();
  const room = {
    code, host: host.id, guest: null, state: 'wait', settings: settings || { size: 7, mode: 'standard' },
    game: null, turnDeadline: 0, timer: null, chat: [], rematch: [false, false], created: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function roomBrief(r) {
  const h = clients.get(r.host);
  const g = r.guest ? clients.get(r.guest) : null;
  return {
    code: r.code, mode: r.settings.mode, size: r.settings.size,
    host: h ? h.name : '?', hostRating: h ? h.rating : 0,
    guest: g ? g.name : null, guestRating: g ? g.rating : 0,
    state: r.state
  };
}

function broadcast(room, obj, exceptId) {
  for (const id of [room.host, room.guest]) {
    if (id == null || id === exceptId) continue;
    const c = clients.get(id);
    if (c) c.sock.send(obj);
  }
}

function buildGame(room) {
  const size = room.settings.size || 7;
  let cfg;
  if (room.settings.mode === 'chaos') {
    const seed = (Math.random() * 1e9) | 0;
    cfg = { size, terrain: E.genChaosTerrain(size, E.mulberry32(seed), 0.16), seed, mode: 'chaos', startShrink: 30, shrinkEvery: 8 };
  } else if (room.settings.mode === 'rush') {
    cfg = { size: Math.min(size, 5), mode: 'rush', startShrink: 16, shrinkEvery: 6, seed: (Math.random() * 1e9) | 0 };
  } else {
    cfg = { size, mode: 'standard', startShrink: 36, shrinkEvery: 8, seed: (Math.random() * 1e9) | 0 };
  }
  room.game = E.createGame(cfg);
  room.turnDeadline = Date.now() + TURN_TIME;
}

function startGame(room) {
  buildGame(room);
  room.state = 'play';
  room.rematch = [false, false];
  const h = clients.get(room.host), g = clients.get(room.guest);
  if (h) h.sock.send({
    t: 'gameStart', state: E.serialize(room.game), you: 0,
    opp: { name: g.name, rating: g.rating }, mode: room.settings.mode,
    deadline: room.turnDeadline, room: room.code
  });
  if (g) g.sock.send({
    t: 'gameStart', state: E.serialize(room.game), you: 1,
    opp: { name: h.name, rating: h.rating }, mode: room.settings.mode,
    deadline: room.turnDeadline, room: room.code
  });
  scheduleTurnTimer(room);
}

function scheduleTurnTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  if (room.state !== 'play') return;
  room.turnDeadline = Date.now() + TURN_TIME;
  broadcast(room, { t: 'deadline', deadline: room.turnDeadline });
  room.timer = setTimeout(() => {
    if (room.state !== 'play' || !room.game || room.game.winner !== null) return;
    // таймаут: случайный легальный ход (3 подряд таймаута = поражение)
    const g = room.game;
    room.timeoutStreak = room.timeoutStreak || [0, 0];
    room.timeoutStreak[g.turn]++;
    if (room.timeoutStreak[g.turn] >= 3) {
      g.winner = 1 - g.turn;
      g.overReason = 'timeout';
      endGame(room, { forfeit: true });
      return;
    }
    const acts = E.legalActions(g);
    if (!acts.length) { g.winner = 1 - g.turn; endGame(room, { forfeit: true }); return; }
    const a = acts[(Math.random() * acts.length) | 0];
    doAction(room, g.turn, a, true);
  }, TURN_TIME);
}

function doAction(room, who, action, auto) {
  const g = room.game;
  if (!g || g.winner !== null || g.turn !== who) return false;
  if (!E.validate(g, action)) return false;
  const ev = E.applyAction(g, action, true) || [];
  broadcast(room, { t: 'state', state: E.serialize(g), by: who, action, events: ev, auto: !!auto });
  if (g.winner !== null) { endGame(room, {}); return true; }
  scheduleTurnTimer(room);
  return true;
}

function rateGame(room, winner) {
  const h = clients.get(room.host), g = clients.get(room.guest);
  if (!h || !g) return null;
  const hp = getPlayer(h.name), gp = getPlayer(g.name);
  const before = { h: hp.rating, g: gp.rating };
  let dh = 0, dg = 0;
  if (winner === 'draw') {
    // ничья: рейтинги слегка сходятся к равному
    const shift = Math.round((gp.rating - hp.rating) * 0.04);
    dh = -shift; dg = shift;
  } else {
    const winIsHost = winner === 0; // host играет за0
    const K = 32;
    const eh = 1 / (1 + Math.pow(10, (gp.rating - hp.rating) / 400));
    if (winIsHost) { dh = Math.round(K * (1 - eh)); dg = Math.round(K * (0 - (1 - eh))); }
    else { dh = Math.round(K * (0 - eh)); dg = Math.round(K * (1 - eh)); }
    if (winIsHost) { hp.wins++; gp.losses++; hp.streak = Math.max(0, hp.streak) + 1; gp.streak = Math.min(0, gp.streak) - 1; }
    else { gp.wins++; hp.losses++; gp.streak = Math.max(0, gp.streak) + 1; hp.streak = Math.min(0, hp.streak) - 1; }
  }
  if (winner === 'draw') { hp.draws++; gp.draws++; }
  hp.rating = Math.max(800, hp.rating + dh);
  gp.rating = Math.max(800, gp.rating + dg);
  hp.best = Math.max(hp.best || hp.rating, hp.rating);
  gp.best = Math.max(gp.best || gp.rating, gp.rating);
  hp.games++; gp.games++;
  data.games++;
  saveData();
  h.rating = hp.rating; g.rating = gp.rating;
  return {
    host: { name: hp.name, rating: hp.rating, delta: dh },
    guest: { name: gp.name, rating: gp.rating, delta: dg },
    before
  };
}

function endGame(room, opts) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const g = room.game;
  const result = rateGame(room, g.winner);
  room.state = 'over';
  broadcast(room, { t: 'over', winner: g.winner, reason: g.overReason, result, top: topPlayers(50) });
}

function leaveRoom(c) {
  const room = c.room && rooms.get(c.room);
  c.room = null;
  if (!room) return;
  if (room.state === 'play' && (room.host === c.id || room.guest === c.id)) {
    // соперник побеждает досрочно
    const loserIsHost = room.host === c.id;
    room.game.winner = loserIsHost ? 1 : 0;
    room.game.overReason = 'leave';
    endGame(room, {});
  } else {
    if (room.timer) clearTimeout(room.timer);
    if (room.host === c.id || room.guest === c.id) rooms.delete(room.code);
    else return;
  }
  broadcast(room, { t: 'roomClosed', code: room.code });
  // оставшимся — обновить список
  broadcastLobby();
}

function broadcastLobby() {
  const list = [...rooms.values()].filter(r => r.state === 'wait').map(roomBrief);
  for (const c of clients.values()) if (!c.room) c.sock.send({ t: 'rooms', rooms: list });
}

/* ---------- обработка сообщений ---------- */
function onMessage(c, msg) {
  let m;
  try { m = JSON.parse(msg); } catch (e) { return; }
  switch (m.t) {
    case 'hello': {
      c.name = String(m.name || 'Оператор').trim().slice(0, 20) || 'Оператор';
      const p = getPlayer(c.name);
      c.rating = p.rating;
      c.sock.send({
        t: 'welcome', id: c.id, name: c.name, rating: p.rating,
        stats: { wins: p.wins, losses: p.losses, draws: p.draws, games: p.games, best: p.best },
        top: topPlayers(50), rooms: [...rooms.values()].filter(r => r.state === 'wait').map(roomBrief),
        online: clients.size, games: data.games
      });
      broadcastLobby();
      break;
    }
    case 'rename': {
      c.name = String(m.name || c.name).trim().slice(0, 20) || c.name;
      const p = getPlayer(c.name);
      c.rating = p.rating;
      c.sock.send({ t: 'welcome', id: c.id, name: c.name, rating: p.rating, stats: { wins: p.wins, losses: p.losses, draws: p.draws, games: p.games, best: p.best }, top: topPlayers(50), rooms: [...rooms.values()].filter(r => r.state === 'wait').map(roomBrief), online: clients.size });
      break;
    }
    case 'list': {
      c.sock.send({ t: 'rooms', rooms: [...rooms.values()].filter(r => r.state === 'wait').map(roomBrief) });
      break;
    }
    case 'top': {
      c.sock.send({ t: 'top', top: topPlayers(100), you: c.name ? getPlayer(c.name) : null });
      break;
    }
    case 'create': {
      if (c.room) leaveRoom(c);
      const room = makeRoom(c, m.settings || {});
      c.room = room.code;
      c.sock.send({ t: 'room', room: roomBrief(room), you: 0 });
      broadcastLobby();
      break;
    }
    case 'join': {
      if (c.room) leaveRoom(c);
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) { c.sock.send({ t: 'err', msg: 'Комната не найдена' }); break; }
      if (room.state !== 'wait' || room.guest) { c.sock.send({ t: 'err', msg: 'Комната занята' }); break; }
      room.guest = c.id;
      c.room = room.code;
      const h = clients.get(room.host);
      c.sock.send({ t: 'room', room: roomBrief(room), you: 1, opp: { name: h.name, rating: h.rating } });
      const hc = clients.get(room.host);
      if (hc) hc.sock.send({ t: 'room', room: roomBrief(room), you: 0, opp: { name: c.name, rating: c.rating } });
      broadcastLobby();
      break;
    }
    case 'start': {
      const room = c.room && rooms.get(c.room);
      if (!room || room.host !== c.id || !room.guest || room.state !== 'wait') break;
      startGame(room);
      break;
    }
    case 'quick': {
      // подбор соперника по рейтингу
      let best = null, bestDiff = 1e9;
      for (const r of rooms.values()) {
        if (r.state !== 'wait' || r.guest || r.host === c.id) continue;
        const h = clients.get(r.host);
        if (!h) continue;
        const diff = Math.abs(h.rating - c.rating);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
      }
      if (best && bestDiff <= 400) {
        const h = clients.get(best.host);
        best.guest = c.id;
        c.room = best.code;
        c.sock.send({ t: 'room', room: roomBrief(best), you: 1, opp: { name: h.name, rating: h.rating } });
        if (h) h.sock.send({ t: 'room', room: roomBrief(best), you: 0, opp: { name: c.name, rating: c.rating } });
        broadcastLobby();
        startGame(best);
      } else {
        // создаём комнату и ждём
        const room = makeRoom(c, m.settings || {});
        c.room = room.code;
        c.sock.send({ t: 'room', room: roomBrief(room), you: 0, searching: true });
        broadcastLobby();
      }
      break;
    }
    case 'cancelSearch': {
      leaveRoom(c);
      c.sock.send({ t: 'searchCanceled' });
      break;
    }
    case 'action': {
      const room = c.room && rooms.get(c.room);
      if (!room || room.state !== 'play') break;
      const who = room.host === c.id ? 0 : room.guest === c.id ? 1 : -1;
      if (who < 0) break;
      if (!doAction(room, who, m.action, false)) c.sock.send({ t: 'err', msg: 'Недопустимый ход' });
      break;
    }
    case 'rematch': {
      const room = c.room && rooms.get(c.room);
      if (!room || room.state !== 'over') break;
      const who = room.host === c.id ? 0 : room.guest === c.id ? 1 : -1;
      if (who < 0) break;
      room.rematch[who] = true;
      broadcast(room, { t: 'rematchVote', who, votes: room.rematch.slice() });
      if (room.rematch[0] && room.rematch[1]) {
        // меняются стороны
        const tmp = room.host; room.host = room.guest; room.guest = tmp;
        startGame(room);
      }
      break;
    }
    case 'leave': leaveRoom(c); break;
    case 'chat': {
      const room = c.room && rooms.get(c.room);
      if (!room) break;
      const text = String(m.text || '').slice(0, 120);
      if (!text) break;
      broadcast(room, { t: 'chat', from: c.name, text });
      break;
    }
    case 'emote': {
      const room = c.room && rooms.get(c.room);
      if (!room) break;
      const who = room.host === c.id ? 0 : room.guest === c.id ? 1 : -1;
      if (who < 0) break;
      broadcast(room, { t: 'emote', who, id: String(m.id || '').slice(0, 20) });
      break;
    }
    case 'ping': c.sock.send({ t: 'pong', ts: m.ts }); break;
  }
}

/* ---------- HTTP + WS сервер ---------- */
const server = http.createServer(serveStatic);
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
  const sock = new Socket(socket);
  const c = { id: nextClientId++, sock, name: 'Гость' + nextClientId, rating: 1200, room: null };
  clients.set(c.id, c);
  sock.onClose = () => {
    clients.delete(c.id);
    leaveRoom(c);
    broadcastLobby();
  };
  sock.onMessage = (msg) => onMessage(c, msg);
  sock.send({ t: 'hi', ver: 1 });
});

function lanIP() {
  try {
    const os = require('os');
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) for (const i of ifs[k] || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) return i.address;
    }
  } catch (e) { }
  return null;
}
function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  try {
    const cp = require('child_process');
    let ch;
    if (process.platform === 'win32') ch = cp.spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    else if (process.platform === 'darwin') ch = cp.spawn('open', [url], { detached: true, stdio: 'ignore' });
    else ch = cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    ch.on('error', () => { });
    ch.unref();
  } catch (e) { }
}
function listen(port, left) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && left > 0) { console.log(`порт ${port} занят → пробую ${port + 1}…`); listen(port + 1, left - 1); }
    else { console.error('Не удалось запустить сервер:', e.message); process.exit(1); }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`РЕЗОНАНС-сервер: http://0.0.0.0:${port}  (ws на том же порту)`);
    const ip = lanIP();
    console.log(`  Локально:  http://127.0.0.1:${port}`);
    if (ip) console.log(`  По сети:   http://${ip}:${port}   (дуэли в локальной сети)`);
    console.log(`  Режим: ${IS_SEA ? 'одиночный exe' : 'папка разработки'}`);
    openBrowser(`http://127.0.0.1:${port}`);
  });
}
listen(PORT, 12);

process.on('SIGTERM', () => { saveData(); process.exit(0); });
process.on('SIGINT', () => { saveData(); process.exit(0); });
