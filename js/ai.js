/* ============================================================
   РЕЗОНАНС — ИИ (поиск минимакс/альфа-бета)
   - итеративное углубление с лимитом времени
   - таблица транспозиций (FNV-хэш состояния)
   - порядок ходов: выигрышные > толчки с шлифовкой > ядра
   - тихий поиск (quiescence) по толчкам: не пропускает маты в1-2
   - оценка: материал, безопасность ядра, давление, потоки,
     заряды, подвижность, контроль периметра
   ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./engine.js'));
  else root.AI = factory(root.Engine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const MATE = 1000000;

  const BASE_W = {
    materialNode: 100, materialHeavy: 175,
    mobility: 2, charge: 26,
    wallDist: 7, mate: 650, pressure: 9, guard: 8,
    beltKill: 150, ring: 6, anchorCore: 34, proximity: 5,
    threatWin: 900
  };

  /* ---------- вспомогательное ---------- */
  function val(type, w) {
    if (type === 'heavy') return w.materialHeavy;
    if (type === 'core') return 0; // ядро считается отдельно (наличие = терминал)
    if (type === 'spark') return w.materialNode * 0.85;
    return w.materialNode;
  }

  function hashState(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const t = s.terrain;
    for (let i = 0; i < t.length; i++) { h1 = Math.imul(h1 ^ t[i], 16777619); }
    for (const u of s.units) {
      h1 = Math.imul(h1 ^ u.cell, 16777619);
      h2 = Math.imul(h2 ^ (u.owner * 8 + u.type.charCodeAt(0)), 2246822519);
    }
    h1 = Math.imul(h1 ^ (s.turn * 131 + s.charge[0] * 17 + s.charge[1] * 7 + s.round), 16777619);
    h2 = Math.imul(h2 ^ s.units.length, 2246822519);
    return (h1 >>> 0) + '_' + (h2 >>> 0);
  }

  function distToWall(s, cell) {
    const size = s.size;
    const x = cell % size, y = (cell / size) | 0;
    let best = 99;
    for (let i = 0; i < s.terrain.length; i++) {
      if (s.terrain[i] !== E.WALL) continue;
      const wx = i % size, wy = (i / size) | 0;
      const d = Math.abs(wx - x) + Math.abs(wy - y);
      if (d < best) best = d;
    }
    return best === 99 ? 0 : best;
  }

  function manhattan(a, b, size) {
    const ax = a % size, ay = (a / size) | 0;
    const bx = b % size, by = (b / size) | 0;
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  function adjUnits(s, cell) {
    const out = [];
    const size = s.size;
    for (let d = 0; d < 4; d++) {
      const n = cell + E.delta(d, size);
      const cx = cell % size, cy = (cell / size) | 0;
      const nx = n % size, ny = (n / size) | 0;
      if (n < 0 || n >= size * size || Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
      const u = E.unitAt(s, n);
      if (u) out.push({ u, d, cell: n });
    }
    return out;
  }

  /* угроза «мат в1»: ядро у стены, соперник стоит напротив */
  function mateThreats(s, core, attacker) {
    const size = s.size;
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const wall = core.cell + E.delta(d, size);
      const cx = core.cell % size, cy = (core.cell / size) | 0;
      const wx = wall % size, wy = (wall / size) | 0;
      if (wall < 0 || wall >= size * size || Math.abs(wx - cx) + Math.abs(wy - cy) !== 1) continue;
      if (s.terrain[wall] !== E.WALL) continue;
      const pusher = core.cell - E.delta(d, size);
      const px = pusher % size, py = (pusher / size) | 0;
      if (pusher < 0 || pusher >= size * size || Math.abs(px - cx) + Math.abs(py - cy) !== 1) continue;
      const u = E.unitAt(s, pusher);
      if (u && u.owner === attacker && u.type !== 'heavy') n++;
    }
    return n;
  }

  /* симуляция фазы потока: кто погиб бы (без изменения состояния) */
  function flowDeaths(s) {
    const size = s.size;
    const pos = new Map(); // cell -> unit
    for (const u of s.units) pos.set(u.cell, u);
    const riders = s.units.filter(u => E.isArrow(s.terrain[u.cell])).slice().sort((a, b) => a.id - b.id);
    const deaths = [];
    for (const u of riders) {
      // юнит мог выехать/погибнуть — ищем его текущую клетку
      let cell = null;
      for (const [c, uu] of pos) if (uu === u) { cell = c; break; }
      if (cell === null) continue;
      for (let step = 0; step < 1; step++) {
        const t = s.terrain[cell];
        if (!E.isArrow(t)) break;
        const d = E.arrowDir(t);
        const next = cell + E.delta(d, size);
        const cx = cell % size, cy = (cell / size) | 0;
        const nx = next % size, ny = (next / size) | 0;
        const off = next < 0 || next >= size * size || Math.abs(nx - cx) + Math.abs(ny - cy) !== 1;
        if (off || s.terrain[next] === E.WALL) { deaths.push(u); pos.delete(cell); break; }
        if (pos.has(next)) break;
        pos.delete(cell); pos.set(next, u); cell = next;
        if (s.terrain[cell] === E.ANCHOR) break;
      }
    }
    return deaths;
  }

  /* ---------- оценка ---------- */
  function evaluate(s, forOwner, w) {
    w = w || BASE_W;
    if (s.winner !== null) {
      if (s.winner === 'draw') return 0;
      return s.winner === forOwner ? MATE : -MATE;
    }
    const size = s.size;
    const my = forOwner, foe = 1 - forOwner;
    let sc = 0;

    for (const u of s.units) {
      const v = val(u.type, w);
      sc += u.owner === my ? v : -v;
    }

    // заряды
    sc += (s.charge[my] - s.charge[foe]) * w.charge;

    // подвижность (для того, кто ходит)
    const mob = E.legalActions(s).length;
    sc += (s.turn === my ? mob : -mob) * w.mobility;

    // ядра
    const myCore = E.coreOf(s, my), foeCore = E.coreOf(s, foe);
    if (myCore) sc += coreSafety(s, myCore, foe, w);
    if (foeCore) sc -= coreSafety(s, foeCore, my, w);

    // ближе к ядру соперника — чуть лучше
    if (foeCore) {
      for (const u of s.units) {
        if (u.owner !== my || u.type === 'core') continue;
        sc += (size * 2 - manhattan(u.cell, foeCore.cell, size)) * w.proximity;
      }
    }
    if (myCore) {
      for (const u of s.units) {
        if (u.owner !== foe || u.type === 'core') continue;
        sc -= (size * 2 - manhattan(u.cell, myCore.cell, size)) * w.proximity;
      }
    }

    // контроль периметра (чем ближе сжатие — тем важнее центр)
    const shrinkSoon = s.cfg && s.cfg.startShrink ? Math.max(0, (s.cfg.startShrink + 8 - s.round)) : 999;
    if (shrinkSoon < 24) {
      const k = (24 - shrinkSoon) / 24;
      for (const u of s.units) {
        const x = u.cell % size, y = (u.cell / size) | 0;
        const ring = Math.min(x, y, size - 1 - x, size - 1 - y);
        sc += (u.owner === my ? 1 : -1) * ring * w.ring * k;
      }
    }

    // гибель от потока
    const deaths = flowDeaths(s);
    for (const u of deaths) {
      const v = val(u.type, w) + (u.type === 'core' ? 5000 : 0);
      sc += u.owner === my ? -v : v;
    }

    // угроза «мат в1» по статике
    if (myCore) sc -= mateThreats(s, myCore, foe) * w.mate;
    if (foeCore) sc += mateThreats(s, foeCore, my) * w.mate;

    return sc;
  }

  /* насколько безопасно ядро */
  function coreSafety(s, core, attacker, w) {
    let sc = 0;
    sc += distToWall(s, core.cell) * w.wallDist;
    if (s.terrain[core.cell] === E.ANCHOR) sc += w.anchorCore;
    const adjs = adjUnits(s, core.cell);
    for (const a of adjs) {
      if (a.u.owner === attacker) sc -= w.pressure * (a.u.type === 'heavy' ? 1.4 : 1);
      else sc += w.guard;
    }
    // ядро с «шифом» союзника за спиной к стене — устойчивее
    return sc;
  }

  /* ---------- тихий поиск ---------- */
  function meaningfulShove(s, m) {
    if (m.k !== 's') return false;
    const tgt = E.getUnit(s, m.tgt);
    if (!tgt) return false;
    if (m.imp) return true;
    if (tgt.owner === s.turn) return false;          // по своим — тихо
    if (tgt.type === 'core') return true;
    // шлифовка впереди?
    const size = s.size;
    const chain = E.chainCells(s, tgt.cell, m.d);
    if (!chain.length) return false;
    const front = chain[chain.length - 1];
    const next = front + E.delta(m.d, size);
    const fx = front % size, fy = (front / size) | 0;
    const nx = next % size, ny = (next / size) | 0;
    const off = next < 0 || next >= size * size || Math.abs(nx - fx) + Math.abs(ny - fy) !== 1;
    return off || s.terrain[next] === E.WALL;
  }

  function qsearch(s, alpha, beta, opts, ply, deadline, side) {
    if (s.winner !== null) return terminal(s, ply, side);
    if (ply > 32 || Date.now() > deadline) return evaluate(s, side, opts.w);
    if (opts.budget && --opts.budget.nodes <= 0) { opts.budget.out = true; return evaluate(s, side, opts.w); }
    const stand = evaluate(s, side, opts.w);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    const shoves = E.legalActions(s).filter(m => meaningfulShove(s, m));
    if (!shoves.length) return alpha;
    shoves.sort((a, b) => shoveOrder(s, b) - shoveOrder(s, a));
    if (shoves.length > 8) shoves.length = 8; // ограничение ширины — честность по времени

    let best = alpha;
    for (const m of shoves) {
      if (Date.now() > deadline || (opts.budget && opts.budget.out)) break;
      const ns = E.cloneState(s);
      E.applyAction(ns, m, false);
      const sc = -qsearch(ns, -beta, -best, opts, ply + 1, deadline, 1 - side);
      if (sc > best) {
        best = sc;
        if (best >= beta) return beta;
      }
    }
    return best;
  }

  function terminal(s, ply, side) {
    // side — игрок, из чьей перспективы считается ветка (через явную передачу,
    // потому что s.turn в терминальных состояниях может не отражать чередование)
    if (s.winner === 'draw') return 0;
    return s.winner === side ? MATE - ply : -MATE + ply;
  }

  /* ---------- порядок ходов ---------- */
  function grindInfo(s, m) {
    if (m.k !== 's') return null;
    const tgt = E.getUnit(s, m.tgt);
    if (!tgt) return null;
    const size = s.size;
    const chain = E.chainCells(s, tgt.cell, m.d);
    const front = chain[chain.length - 1];
    const next = front + E.delta(m.d, size);
    const fx = front % size, fy = (front / size) | 0;
    const nx = next % size, ny = (next / size) | 0;
    const off = next < 0 || next >= size * size || Math.abs(nx - fx) + Math.abs(ny - fy) !== 1;
    const wall = off || s.terrain[next] === E.WALL;
    return { frontUnit: E.getUnit(s, front), wall, chainLen: chain.length };
  }

  function shoveOrder(s, m) {
    let sc = 0;
    const g = grindInfo(s, m);
    if (g) {
      if (g.wall && g.frontUnit && g.frontUnit.type === 'core' && g.frontUnit.owner !== s.turn) sc += 100000;
      if (g.wall && g.frontUnit && g.frontUnit.type === 'core' && g.frontUnit.owner === s.turn) sc -= 100000; // самоубийство
      if (g.wall && g.frontUnit && g.frontUnit.owner !== s.turn) sc += 120 + val(g.frontUnit.type, BASE_W);
      if (g.chainLen > 1) sc += 30 * g.chainLen;
      if (g.frontUnit && g.frontUnit.type === 'heavy' && !m.imp) sc -= 500;
    }
    if (m.imp) sc += 60;
    const tgt = E.getUnit(s, m.tgt);
    if (tgt && tgt.owner !== s.turn) sc += 45;
    return sc;
  }

  function moveOrder(s, m) {
    if (m.k === 's') return shoveOrder(s, m);
    const foeCore = E.coreOf(s, 1 - s.turn);
    let sc = 0;
    if (foeCore) {
      const before = manhattan(m.id ? (E.getUnit(s, m.id) || { cell: m.to }).cell : m.to, foeCore.cell, s.size);
      const u = E.getUnit(s, m.id);
      const after = u ? manhattan(m.to, foeCore.cell, s.size) : before;
      sc = (before - after) * 12;
    }
    // вставать на якорь полезно; на поток — рискованно
    if (s.terrain[m.to] === E.ANCHOR) sc += 6;
    if (E.isArrow(s.terrain[m.to])) sc -= 4;
    return sc;
  }

  function orderMoves(s, hist) {
    const moves = E.legalActions(s);
    const scored = moves.map(m => ({ m, sc: moveOrder(s, m) + (hist ? (hist[m.k + ':' + (m.tgt || 0) + ':' + (m.d || 0)] || 0) : 0) }));
    scored.sort((a, b) => b.sc - a.sc);
    return scored.map(x => x.m);
  }

  /* ---------- негамакс ---------- */
  function negamax(s, depth, alpha, beta, opts, ply, deadline, hist, side) {
    if (s.winner !== null) return terminal(s, ply, side);
    if (depth <= 0) return qsearch(s, alpha, beta, opts, ply, deadline, side);
    if (Date.now() > deadline) return evaluate(s, side, opts.w);
    if (opts.budget && --opts.budget.nodes <= 0) { opts.budget.out = true; return evaluate(s, side, opts.w); }

    const key = opts.tt ? hashState(s) : null;
    if (key && opts.tt.has(key)) {
      const e = opts.tt.get(key);
      if (e.depth >= depth) {
        if (e.flag === 0) return e.score;
        if (e.flag === 1 && e.score >= beta) return e.score;
        if (e.flag === -1 && e.score <= alpha) return e.score;
      }
    }

    const moves = orderMoves(s, hist);
    if (!moves.length) return -MATE + ply;

    let best = -Infinity, flag = -1;
    for (let i = 0; i < moves.length; i++) {
      if ((Date.now() > deadline || (opts.budget && opts.budget.out)) && ply > 0) { best = evaluate(s, side, opts.w); flag = 0; break; }
      const m = moves[i];
      const ns = E.cloneState(s);
      E.applyAction(ns, m, false);
      const sc = -negamax(ns, depth - 1, -beta, -alpha, opts, ply + 1, deadline, hist, 1 - side);
      if (sc > best) {
        best = sc;
        if (best > alpha) { alpha = best; flag = 1; }
      }
      if (alpha >= beta) { flag = -1; break; }
    }
    if (key && opts.tt) opts.tt.set(key, { depth, flag, score: best });
    return best;
  }

  /* ---------- корень ---------- */
  function searchRoot(s, opts) {
    const deadline = Date.now() + (opts.time || 60000);
    if (!opts.budget || opts.budgetReset) opts.budget = { nodes: opts.nodes || Infinity, out: false };
    const hist = {};
    let results = [];
    let completed = 0;
    for (let depth = 1; depth <= (opts.maxDepth || 14); depth++) {
      const moves = orderMoves(s, hist);
      if (!moves.length) break;
      let alpha = -Infinity;
      const beta = Infinity;
      const round = [];
      let aborted = false;
      for (const m of moves) {
        if ((Date.now() > deadline || (opts.budget && opts.budget.out)) && depth > 1) { aborted = true; break; }
        const ns = E.cloneState(s);
        E.applyAction(ns, m, false);
        const sc = -negamax(ns, depth - 1, -beta, -alpha, opts, 1, deadline, hist, 1 - s.turn);
        round.push({ m, sc });
        if (sc > alpha) alpha = sc;
      }
      if (aborted || !round.length) break;
      if (opts.budget) opts.budget.out = false; // следующая глубина — с новым бюджетом остатка
      round.sort((a, b) => b.sc - a.sc);
      results = round;
      completed = depth;
      const key = 'm:' + JSON.stringify(round[0].m);
      hist[key] = (hist[key] || 0) + depth;
      if (Math.abs(round[0].sc) >= MATE - 100) break;
      if (Date.now() >= deadline) break;
    }
    return { results, depth: completed };
  }

  /* ---------- выбор действия ---------- */
  // opts: {time, maxDepth, noise, weights, style}
  function think(state, opts) {
    opts = Object.assign({ time: 900, maxDepth: 14, noise: 0, weights: BASE_W, root: state.turn }, opts || {});
    opts.w = opts.weights;
    opts.root = state.turn;
    opts.tt = new Map();
    opts.budget = { nodes: opts.nodes || Infinity, out: false };

    if (state.winner !== null) return null;
    const legal = E.legalActions(state);
    if (!legal.length) return null;

    // очень лёгкий уровень: тактических шансов не ищем, играем с шумом
    if (opts.time < 150) {
      const scored = legal.map(m => ({ m, sc: moveOrder(state, m) + (Math.random() * 160 - 80) }));
      scored.sort((a, b) => b.sc - a.sc);
      return scored[0].m;
    }

    const { results, depth } = searchRoot(state, opts);
    if (!results.length) return legal[(Math.random() * legal.length) | 0];

    // шум «человечности»: иногда берём2-3-й лучший ход
    if (opts.noise > 0 && Math.random() < opts.noise) {
      const pool = results.slice(0, Math.min(3, results.length));
      const weights = pool.map((r, i) => Math.exp(-(results[0].sc - r.sc) / Math.max(30, opts.noise * 220)));
      let sum = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * sum;
      for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i].m; }
      return pool[0].m;
    }
    return results[0].m;
  }

  /* подсказка для игрока — быстрый поиск */
  function hint(state) {
    const r = searchRoot(state, { time: 2500, nodes: 30000, maxDepth: 12, noise: 0, weights: BASE_W, root: state.turn, tt: new Map(), w: BASE_W });
    return r.results.length ? r.results[0].m : null;
  }

  /* ---------- стили ботов ---------- */
  const STYLES = {
    balanced: {},
    aggressor: { pressure: 16, guard: 4, proximity: 8, mate: 750 },
    turtle: { guard: 16, pressure: 4, wallDist: 11, anchorCore: 55, mobility: 1 },
    belmaster: { beltKill: 260, wallDist: 5, pressure: 7 },
    hoarder: { charge: 60, materialNode: 92, materialHeavy: 165 },
    berserk: { materialNode: 84, materialHeavy: 150, pressure: 18, beltKill: 120, mobility: 3 }
  };

  function weightsFor(style) {
    const o = Object.assign({}, BASE_W, STYLES[style] || {});
    return o;
  }

  /* Уровни: nodes — основной лимит (честный для обеих сторон),
     time — лишь страховка от зависаний. */
  const LEVELS = {
    novice:   { nodes: 600,    time: 800,   noise: 0.60, style: 'balanced' },
    pilot:    { nodes: 4000,   time: 1500,  noise: 0.28, style: 'balanced' },
    operator: { nodes: 14000,  time: 4000,  noise: 0.10, style: 'balanced' },
    strategist:{ nodes: 45000, time: 9000,  noise: 0.03, style: 'balanced' },
    oracle:   { nodes: 90000,  time: 15000, noise: 0,    style: 'balanced' }
  };

  function levelOpts(level, style) {
    const L = LEVELS[level] || LEVELS.operator;
    return { nodes: L.nodes, time: L.time, noise: L.noise, weights: weightsFor(style || L.style) };
  }

  return { think, hint, evaluate, levelOpts, weightsFor, LEVELS, STYLES, BASE_W, searchRoot };
});
