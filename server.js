'use strict';
/**
 * Gladni mačak — poslužitelj (Node.js + WebSocket)
 * Poslužitelj je "autoritativan": sva fizika, glad, hrana i sudari računaju se ovdje,
 * a klijenti samo šalju tipke i crtaju ono što dobiju.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- postavke (slobodno mijenjaj)
const LEVELS = 80;              // broj katova tornja (prije ih je bilo 14)
const HUNGER_RATE = 0.3;        // koliko % gladi naraste u sekundi (prije 1.3, dakle ~4x sporije)
const REST_EVERY = 20;          // svakih toliko katova je široko "odmorište" s hranom (0 = isključeno)
const SPACING_MIN = 124;        // razmak među katovima pri dnu ...
const SPACING_MAX = 146;        // ... i pri vrhu (maks. visina skoka je ≈168 px, pa je pri vrhu sve zahtjevnije)
const LEFT_LEDGES_UNTIL = 10;   // do ovog kata uvijek ima police uz lijevi rub (lagan bijeg na madrace)

// ---------------------------------------------------------------- svijet
const spacingOf = (L) => SPACING_MIN + (SPACING_MAX - SPACING_MIN) * ((L - 1) / Math.max(1, LEVELS - 1));
let totalHeight = 0;
for (let L = 1; L <= LEVELS; L++) totalHeight += spacingOf(L);
const W = {
  left: -620,
  right: 1000,
  levels: LEVELS,
  towerTop: 300, // krov tornja
  mattress: { x1: -560, x2: -30, h: 36 },
};
W.ground = Math.round(W.towerTop + 200 + totalHeight);
W.levelY = [W.ground]; // y svakog kata; 0. kat je tlo
for (let L = 1; L <= LEVELS; L++) W.levelY[L] = Math.round(W.levelY[L - 1] - spacingOf(L));
const PW = 42; // širina mačka (kutija za sudare)
const PH = 30; // visina mačka
W.ceiling = W.towerTop + 48;

const TICK = 60;
const DT = 1 / TICK;
const GRAVITY = 2000;
const MAX_FALL = 1400;
const SPEED = 270;
const JUMP = 820; // maks. visina skoka ≈ 168 px
const HARD_LANDING = 1150; // brzina pada nakon koje te "zaboli" (osim na madracima)
const CAT_COUNT = 9;
const MAX_PLAYERS = 16;

// Što je hrana viša, to je bolja: koliko gladi skida (r) i koliko bodova daje (p)
const TIERS = [
  { n: 'Suhe granule', r: 10, p: 5 },
  { n: 'Mlijeko', r: 16, p: 12 },
  { n: 'Konzerva tune', r: 22, p: 25 },
  { n: 'Pileći batak', r: 28, p: 40 },
  { n: 'Riblji file', r: 34, p: 60 },
  { n: 'Losos', r: 40, p: 85 },
  { n: 'Pačja prsa', r: 46, p: 115 },
  { n: 'Kraljevski škampi', r: 52, p: 150 },
];
// 8 razina hrane ravnomjerno raspoređenih po katovima (što viši kat, to bolja hrana)
const levelTier = (L) => (L <= 0 ? 0 : Math.min(TIERS.length - 1, Math.floor(((L - 1) * TIERS.length) / LEVELS)));

// Koliko se daleko (vodoravno) može doskočiti na platformu koja je dy px iznad one s koje se skače.
function jumpReach(dy) {
  const disc = JUMP * JUMP - 2 * GRAVITY * dy;
  return disc <= 0 ? 0 : (SPEED * (JUMP + Math.sqrt(disc))) / GRAVITY;
}

const rnd = (a, b) => a + Math.random() * (b - a);
const r1 = (v) => Math.round(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- soba
class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.nextId = 1;
    this.time = 0;
    this.tick = 0;
    this.events = [];
    this.build();
  }

  // Toranj se gradi odozdo prema gore. Uvijek postoji "glavna staza": jedna platforma po katu do koje se
  // sigurno može doskočiti s prethodne. Što je kat viši, to je platformi manje, uže su, a razmaci veći.
  build() {
    const lerp = (a, b, t) => a + (b - a) * t;
    const gap = (a, b) => Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2)); // vodoravni razmak (0 = preklapaju se)
    const X0 = 0;
    const X1 = W.right;
    this.platforms = [
      { x1: W.left, x2: W.right, y: W.ground, kind: 'ground', safe: true },
      { x1: W.mattress.x1, x2: W.mattress.x2, y: W.ground - W.mattress.h, kind: 'mattress' },
    ];
    const levels = [[{ x1: X0, x2: X1 }]]; // levels[L] = platforme na katu L (0 = tlo)
    let main = levels[0][0];
    for (let L = 1; L <= LEVELS; L++) {
      const y = W.levelY[L];
      const dy = W.levelY[L - 1] - y;
      const d = (L - 1) / Math.max(1, LEVELS - 1); // težina: 0 (dolje) … 1 (vrh)
      const limit = jumpReach(dy) * lerp(0.28, 0.76, Math.pow(d, 0.9)); // najveći dopušteni razmak
      const isTop = L === LEVELS;
      const isRest = isTop || (REST_EVERY > 0 && L % REST_EVERY === 0);
      const list = [];
      const add = (x1, x2, kind) => {
        const s = { x1: Math.round(x1), x2: Math.round(x2), y, kind, level: L, safe: kind !== 'shelf' };
        list.push(s);
        this.platforms.push(s);
        return s;
      };
      const reachable = (c) => levels[L - 1].some((b) => gap(b, c) <= limit);

      if (isRest) {
        main = add(X0, X1, isTop ? 'summit' : 'rest');
      } else {
        const w = lerp(380, 120, Math.pow(d, 0.85)) * rnd(0.85, 1.15);
        const g = limit * rnd(0.55, 1);
        const prevW = main.x2 - main.x1;
        const canR = main.x2 + g + w <= X1;
        const canL = main.x1 - g - w >= X0;
        let x1;
        if (prevW > 900 || (!canR && !canL) || Math.random() < Math.max(0, 0.6 - d * 1.2)) {
          // iznad prethodne (preklapaju se) ili bilo gdje ako je ispod cijeli pod
          const lo = prevW > 900 ? X0 : Math.max(X0, main.x1 - w + 50);
          const hi = prevW > 900 ? X1 - w : Math.min(X1 - w, main.x2 - 50);
          x1 = lo <= hi ? rnd(lo, hi) : clamp(main.x1, X0, X1 - w);
        } else if (canR && (!canL || Math.random() < (X1 - main.x2) / (X1 - main.x2 + main.x1))) {
          x1 = main.x2 + g; // desno od prethodne, preko praznine
        } else {
          x1 = main.x1 - g - w; // lijevo od prethodne
        }
        main = add(x1, x1 + w, 'shelf');
      }

      // dodatne platforme: što je kat viši, to ih je manje (pri vrhu samo glavna)
      const expect = isRest ? 1 : lerp(3.0, 1.0, Math.pow(d, 0.75));
      const n = Math.floor(expect) + (Math.random() < expect - Math.floor(expect) ? 1 : 0);
      for (let tries = 0; list.length < n && tries < 25; tries++) {
        const we = lerp(300, 110, d) * rnd(0.8, 1.2);
        const x1 = rnd(X0, X1 - we);
        const c = { x1, x2: x1 + we };
        if (list.some((s) => gap(s, c) < 70)) continue; // ne preblizu drugima
        if (!reachable(c)) continue; // mora se moći doskočiti odozdo
        add(c.x1, c.x2, 'shelf');
      }
      // pri dnu uvijek ima police uz lijevi rub – lagan "bijeg" na madrace
      if (!isRest && L <= LEFT_LEDGES_UNTIL) {
        const first = list.reduce((m, s) => Math.min(m, s.x1), Infinity);
        const wl = Math.min(rnd(200, 360), first - 70);
        if (wl >= 150 && reachable({ x1: 0, x2: wl })) add(0, wl, 'shelf');
      }
      levels[L] = list;
    }

    // hrana: što je kat viši, to je bolja (levelTier)
    this.foods = [];
    let id = 0;
    const addFood = (x, py, tier) => this.foods.push({ id: id++, x: Math.round(x), y: Math.round(py) - 18, tier, active: true, respawn: 0 });
    for (const x of [220, 500, 780]) addFood(x, W.ground, 0);
    for (let L = 1; L <= LEVELS; L++) {
      const list = levels[L];
      const tier = levelTier(L);
      const d = (L - 1) / Math.max(1, LEVELS - 1);
      if (list[0].kind !== 'shelf') {
        for (const x of [200, 500, 800]) addFood(x, list[0].y, tier); // odmorište / vrh: gozba
        continue;
      }
      if (Math.random() >= lerp(0.9, 0.35, d)) continue;
      let r = Math.random() * list.reduce((s, p) => s + (p.x2 - p.x1), 0); // šire platforme imaju veću šansu
      const s = list.find((p) => (r -= p.x2 - p.x1) <= 0) || list[0];
      addFood(rnd(s.x1 + 34, s.x2 - 34), s.y, tier);
    }
  }

  worldInfo() {
    return {
      left: W.left, right: W.right, ground: W.ground, levels: W.levels, towerTop: W.towerTop, pw: PW, ph: PH,
      levelY: W.levelY,
      tierOf: W.levelY.map((_, L) => levelTier(L)),
      platforms: this.platforms.map((p) => [p.x1, p.x2, p.y, p.kind]),
      mattress: { x1: W.mattress.x1, x2: W.mattress.x2, top: W.ground - W.mattress.h },
      foods: this.foods.map((f) => [f.id, r1(f.x), r1(f.y), f.tier]),
      tiers: TIERS,
    };
  }

  spawn(p, plat) {
    p.x = rnd(60, 940);
    p.y = plat ? plat.y : W.ground;
    p.vx = 0;
    p.vy = 0;
    p.og = true;
  }

  add(ws, name, color) {
    const p = {
      id: this.nextId++, ws, name, color,
      x: 0, y: 0, vx: 0, vy: 0, face: 1, og: true,
      hunger: 25, score: 0, stun: 0, knock: 0, starve: 0, bumpCd: 0,
      coyote: 0, buf: 0, prevJ: false, inp: { l: false, r: false, j: false },
    };
    this.spawn(p);
    this.players.set(p.id, p);
    this.send(ws, {
      t: 'init', id: p.id, world: this.worldInfo(),
      players: [...this.players.values()].map((q) => ({ id: q.id, name: q.name, color: q.color })),
    });
    this.broadcast({ t: 'join', p: { id: p.id, name: p.name, color: p.color } }, ws);
    return p;
  }

  remove(p) {
    this.players.delete(p.id);
    this.broadcast({ t: 'leave', id: p.id });
  }

  send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.ws !== except && p.ws && p.ws.readyState === 1) p.ws.send(s);
    }
  }

  // ------------------------------------------------------------ fizika
  stepPlayer(p) {
    // glad
    p.hunger = Math.min(100, p.hunger + HUNGER_RATE * DT);
    const weak = p.hunger >= 100;
    if (weak) {
      p.starve += DT;
      if (p.starve > 12) { this.faint(p); return; }
    } else p.starve = 0;

    if (p.stun > 0) p.stun -= DT;
    if (p.knock > 0) p.knock -= DT;
    p.bumpCd = Math.max(0, p.bumpCd - DT);

    const speed = SPEED * (weak ? 0.6 : 1);
    const jumpV = JUMP * (weak ? 0.92 : 1);
    const free = p.stun <= 0 && p.knock <= 0;

    let dir = 0;
    if (free) dir = (p.inp.r ? 1 : 0) - (p.inp.l ? 1 : 0);
    if (dir) p.face = dir;
    const target = dir * speed;
    const acc = (p.knock > 0 ? 700 : p.og ? 3200 : 1800) * DT;
    if (p.vx < target) p.vx = Math.min(target, p.vx + acc);
    else if (p.vx > target) p.vx = Math.max(target, p.vx - acc);

    // skok (s malo "oprosta": coyote time i buffer)
    const pressed = p.inp.j && !p.prevJ;
    p.prevJ = p.inp.j;
    if (pressed && free) p.buf = 0.12; else p.buf -= DT;
    p.coyote = p.og ? 0.1 : p.coyote - DT;
    if (p.buf > 0 && p.coyote > 0 && free) {
      p.vy = -jumpV; p.og = false; p.coyote = 0; p.buf = 0;
      this.events.push({ k: 'jump', id: p.id, x: r1(p.x), y: r1(p.y) });
    }

    // vodoravno
    p.x += p.vx * DT;
    if (p.x > W.right - PW / 2) { p.x = W.right - PW / 2; if (p.vx > 0) p.vx = 0; }
    if (p.x < W.left + PW / 2) { p.x = W.left + PW / 2; if (p.vx < 0) p.vx = 0; }
    // madrac je čvrst blok sa strane (na njega se mora skočiti odozgo)
    const mTop = W.ground - W.mattress.h;
    if (p.y > mTop + 6 && p.x + PW / 2 > W.mattress.x1 && p.x - PW / 2 < W.mattress.x2) {
      const toLeft = p.x + PW / 2 - W.mattress.x1;
      const toRight = W.mattress.x2 - (p.x - PW / 2);
      p.x = toLeft < toRight ? W.mattress.x1 - PW / 2 : W.mattress.x2 + PW / 2;
      p.vx = 0;
    }

    // okomito
    const prevY = p.y;
    const g = GRAVITY * (p.vy < 0 && !p.inp.j ? 1.9 : 1); // kraći skok kad pustiš tipku
    p.vy = Math.min(MAX_FALL, p.vy + g * DT);
    p.y += p.vy * DT;
    p.og = false;
    if (p.y < W.ceiling) { p.y = W.ceiling; if (p.vy < 0) p.vy = 0; }
    if (p.vy >= 0) {
      let best = null;
      const l = p.x - PW / 2 + 3;
      const r = p.x + PW / 2 - 3;
      for (const pl of this.platforms) {
        if (r > pl.x1 && l < pl.x2 && prevY <= pl.y + 0.5 && p.y >= pl.y) {
          if (!best || pl.y < best.y) best = pl;
        }
      }
      if (best) {
        const impact = p.vy;
        p.y = best.y;
        if (best.kind === 'mattress' && impact > 420) {
          p.vy = -impact * 0.45; // odskok s madraca
          this.events.push({ k: 'bounce', x: r1(p.x), y: r1(p.y) });
          if (p.vy > -140) { p.vy = 0; p.og = true; }
        } else {
          p.vy = 0;
          p.og = true;
          if (impact > HARD_LANDING && best.kind !== 'mattress') {
            p.stun = 1.3; p.vx = 0;
            p.hunger = Math.min(100, p.hunger + 6);
            this.events.push({ k: 'ouch', id: p.id, x: r1(p.x), y: r1(p.y) });
          }
        }
      }
    }
  }

  faint(p) {
    // probudi se na najbližem odmorištu ispod sebe (ili na tlu)
    let best = null;
    for (const pl of this.platforms) {
      if (pl.safe && pl.y >= p.y - 2 && (!best || pl.y < best.y)) best = pl;
    }
    this.spawn(p, best);
    p.hunger = 55;
    p.starve = 0;
    p.stun = 1.2;
    this.events.push({ k: 'faint', id: p.id });
  }

  collide(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y; // y je dno mačka
    const ox = PW - Math.abs(dx);
    const oy = PH - Math.abs(dy);
    if (ox <= 0 || oy <= 0) return;

    if (oy < ox * 0.8) {
      // jedan mačak doskače drugome na glavu — može stajati na njemu
      const up = dy > 0 ? a : b;
      const low = dy > 0 ? b : a;
      if (up.vy >= 0) {
        up.y = low.y - PH;
        up.og = true;
        up.vy = low.vy < 0 ? low.vy : 0;
      }
      return;
    }

    // bočni sudar: razdvoji i odbij
    const s = dx > 0 ? 1 : dx < 0 ? -1 : a.id < b.id ? 1 : -1;
    const push = ox / 2 + 0.01;
    a.x -= s * push;
    b.x += s * push;
    a.x = Math.max(W.left + PW / 2, Math.min(W.right - PW / 2, a.x));
    b.x = Math.max(W.left + PW / 2, Math.min(W.right - PW / 2, b.x));
    const rv = (a.vx - b.vx) * s; // > 0 znači da se približavaju
    if (rv > 0) {
      const victim = Math.abs(a.vx) > Math.abs(b.vx) ? b : a;
      const f = 0.95 * rv * s;
      a.vx -= f;
      b.vx += f;
      a.knock = Math.max(a.knock, 0.18);
      b.knock = Math.max(b.knock, 0.18);
      if (rv > 230) { victim.vy = Math.min(victim.vy, -260); victim.og = false; }
      if (rv > 90 && a.bumpCd <= 0 && b.bumpCd <= 0) {
        a.bumpCd = b.bumpCd = 0.3;
        this.events.push({ k: 'bump', x: r1((a.x + b.x) / 2), y: r1(Math.min(a.y, b.y) - PH / 2) });
      }
    }
  }

  step() {
    this.time += DT;
    const ps = [...this.players.values()];
    for (const p of ps) this.stepPlayer(p);
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) this.collide(ps[i], ps[j]);
    }
    // jedenje
    for (const p of ps) {
      for (const f of this.foods) {
        if (!f.active) continue;
        if (Math.abs(p.x - f.x) < PW / 2 + 16 && Math.abs(p.y - PH / 2 - f.y) < PH / 2 + 16) {
          const T = TIERS[f.tier];
          f.active = false;
          f.respawn = this.time + 12 + f.tier * 4;
          p.hunger = Math.max(0, p.hunger - T.r);
          p.score += T.p;
          if (p.hunger < 100) p.starve = 0;
          this.events.push({ k: 'eat', id: p.id, fid: f.id, tier: f.tier, pts: T.p, x: r1(p.x), y: r1(p.y) });
        }
      }
    }
    for (const f of this.foods) if (!f.active && this.time >= f.respawn) f.active = true;

    this.tick++;
    if (this.tick % 2 === 0) this.sendState();
  }

  sendState() {
    const arr = [];
    for (const p of this.players.values()) {
      arr.push([
        p.id, +p.x.toFixed(1), +p.y.toFixed(1), r1(p.vx), r1(p.vy),
        p.face, p.og ? 1 : 0, r1(p.hunger), p.score, p.stun > 0 ? 1 : 0,
      ]);
    }
    const msg = JSON.stringify({
      t: 's', p: arr, f: this.foods.map((f) => (f.active ? '1' : '0')).join(''), e: this.events,
    });
    this.events = [];
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
    }
  }
}

// ---------------------------------------------------------------- HTTP (poslužuje igru)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, url));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Nije pronađeno'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------- WebSocket
const rooms = new Map();
const wss = new WebSocketServer({ server, maxPayload: 512 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join' && !player) {
      const name = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Mačak';
      const color = Number.isInteger(m.color) && m.color >= 0 && m.color < CAT_COUNT ? m.color : 0;
      const code = String(m.room || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12) || 'glavna';
      let rm = rooms.get(code);
      if (!rm) { rm = new Room(code); rooms.set(code, rm); }
      if (rm.players.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: 'err', msg: 'Soba je puna (najviše ' + MAX_PLAYERS + ' mačaka). Probaj drugu šifru sobe.' }));
        return;
      }
      room = rm;
      player = room.add(ws, name, color);
    } else if (m.t === 'i' && player) {
      player.inp.l = !!m.l;
      player.inp.r = !!m.r;
      player.inp.j = !!m.j;
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.remove(player);
      if (room.players.size === 0) rooms.delete(room.code);
    }
  });
  ws.on('error', () => {});
});

// glavna petlja: fiksnih 60 koraka u sekundi
let last = Date.now();
let acc = 0;
function loop() {
  const now = Date.now();
  acc += Math.min(250, now - last);
  last = now;
  let n = 0;
  while (acc >= 1000 / TICK && n < 8) {
    for (const r of rooms.values()) r.step();
    acc -= 1000 / TICK;
    n++;
  }
}

if (require.main === module) {
  setInterval(loop, 8);
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    }
  }, 30000);

  server.listen(PORT, () => console.log('Gladni mačak radi na http://localhost:' + PORT));
}

module.exports = { Room, W, TIERS, PW, PH, DT, levelTier, jumpReach, spacingOf, LEVELS, server, loop };
