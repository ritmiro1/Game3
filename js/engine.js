/* ============================================================
   РЕЗОНАНС — движок правил (общий для клиента и сервера)
   Террейн: 0 пусто, 1 стена, 2 якорь, 3 →, 4 ←, 5 ↑, 6 ↓
   Действия: {k:'m', id, to} — шаг
             {k:'s', id, tgt, d, imp} — толчок (imp — Импульс, стоит 1 заряда)
   После КАЖДОГО действия: +1 actCount → фаза ПОТОКА (1 клетка) → сжатие по
   графику действий. После действия игрока1: раунд++, смена хода, хаос-стрелки.
   ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMPTY = 0, WALL = 1, ANCHOR = 2, A_RIGHT = 3, A_LEFT = 4, A_UP = 5, A_DOWN = 6;
  const DIRS = [1, -1, 0, 0];      // dx-like (col) для 0..3 → используем delta по индексу
  const DELTA = [1, -1, 0, 0];     // заполняется ниже с учётом size — используем функцию

  function delta(d, size) {
    if (d === 0) return 1;          // вправо
    if (d === 1) return -1;         // влево
    if (d === 2) return -size;      // вверх
    return size;                    // вниз
  }
  function isArrow(t) { return t >= A_RIGHT; }
  function arrowDir(t) { return t - A_RIGHT; } // 0..3

  /* ---------- утилиты ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function cloneState(s) {
    return {
      size: s.size,
      terrain: s.terrain.slice(),
      units: s.units.map(u => ({ id: u.id, owner: u.owner, type: u.type, cell: u.cell })),
      charge: [s.charge[0], s.charge[1]],
      turn: s.turn,
      round: s.round,
      acted: s.acted,
      actCount: s.actCount,
      winner: s.winner,
      overReason: s.overReason || null,
      cfg: s.cfg,
      seed: s.seed,
      rngState: s.rngState,
      nextId: s.nextId
    };
  }

  function idx(x, y, size) { return y * size + x; }
  function coord(cell, size) { return { x: cell % size, y: (cell / size) | 0 }; }

  function unitAt(s, cell) {
    for (let i = 0; i < s.units.length; i++) if (s.units[i].cell === cell) return s.units[i];
    return null;
  }
  function getUnit(s, id) {
    for (let i = 0; i < s.units.length; i++) if (s.units[i].id === id) return s.units[i];
    return null;
  }

  /* ---------- создание партии ---------- */
  // cfg: {size, terrain:Uint8Array|null, spawns:[[{type,cell}...],[...]], charge:[a,b],
  //       startShrink, shrinkEvery, maxRound, arrowChaos:0|n, mode}
  function createGame(cfg) {
    cfg = Object.assign({
      size: 7, terrain: null, spawns: null, charge: [0, 0],
      startShrink: 36, shrinkEvery: 8, maxRound: 100, arrowChaos: 0, mode: 'standard'
    }, cfg || {});
    const size = cfg.size;
    const terrain = cfg.terrain ? Uint8Array.from(cfg.terrain) : defaultTerrain(size);
    const s = {
      size, terrain,
      units: [], charge: [cfg.charge[0] | 0, cfg.charge[1] | 0],
      turn: 0, round: 1, acted: 0, actCount: 0,
      winner: null, overReason: null,
      cfg, seed: cfg.seed || (Math.random() * 1e9) | 0, rngState: cfg.seed || (Math.random() * 1e9) | 0,
      nextId: 1
    };
    const spawns = cfg.spawns || defaultSpawns(size);
    for (let o = 0; o < 2; o++) {
      const list = spawns[o] || [];
      for (const sp of list) {
        s.units.push({ id: s.nextId++, owner: o, type: sp.type || 'node', cell: sp.cell });
      }
    }
    return s;
  }

  function defaultTerrain(size) {
    const t = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const edge = (x === 0 || y === 0 || x === size - 1 || y === size - 1);
      t[idx(x, y, size)] = edge ? WALL : EMPTY;
    }
    return t;
  }

  function defaultSpawns(size) {
    const c = size >> 1;
    const mid = (size - 1) / 2;
    // Симметрия180°: игрок0 слева-снизу, игрок1 справа-сверху (для поля с учётом стен)
    const y0 = size - 2, y1 = 1;
    const mk = (x, y, type) => ({ type, cell: idx(x, y, size) });
    const u0 = [mk(1, y0, 'core'), mk(2, y0, 'node'), mk(1, y0 - 1, 'node'), mk(2, y0 - 1, 'node'), mk(3, y0 - 1, 'node')];
    const u1 = [
      { type: 'core', cell: idx(size - 2, 1, size) },
      { type: 'node', cell: idx(size - 3, 1, size) },
      { type: 'node', cell: idx(size - 2, 2, size) },
      { type: 'node', cell: idx(size - 3, 2, size) },
      { type: 'node', cell: idx(size - 4, 2, size) }
    ];
    // зеркально: позиции1-й игрока — поворот180° позиций0-го
    const rot = (cell) => idx(size - 1 - (cell % size), size - 1 - ((cell / size) | 0), size);
    const u1m = u0.map(u => ({ type: u.type, cell: rot(u.cell) }));
    return [u0, u1m];
  }

  /* ---------- легальность и генерация действий ---------- */
  function canAct(s, unit) {
    return unit && s.units.indexOf(unit) >= 0 && unit.owner === s.turn && s.winner === null;
  }

  function legalActions(s) {
    const out = [];
    const size = s.size, terr = s.terrain;
    for (const u of s.units) {
      if (u.owner !== s.turn) continue;
      for (let d = 0; d < 4; d++) {
        const to = u.cell + delta(d, size);
        if (to < 0 || to >= size * size) continue;
        const tx = to % size, ty = (to / size) | 0;
        const ux = u.cell % size, uy = (u.cell / size) | 0;
        if (Math.abs(tx - ux) + Math.abs(ty - uy) !== 1) continue; // безопасно против вылета за строку
        const t = unitAt(s, to);
        if (!t) {
          if (terr[to] !== WALL) out.push({ k: 'm', id: u.id, to });
        } else {
          // толчок по любому юниту (своему или чужому)
          const heavyInChain = chainHasHeavy(s, u.cell, d);
          if (!heavyInChain) out.push({ k: 's', id: u.id, tgt: t.id, d, imp: 0 });
          if (s.charge[u.owner] > 0) out.push({ k: 's', id: u.id, tgt: t.id, d, imp: 1 });
        }
      }
    }
    return out;
  }

  function chainCells(s, fromCell, d) {
    // собирает цепочку юнитов от fromCell в направлении d
    const size = s.size;
    const cells = [];
    let c = fromCell;
    for (;;) {
      const u = unitAt(s, c);
      if (!u) break;
      cells.push(c);
      const nx = c + delta(d, size);
      const cx = c % size, cy = (c / size) | 0;
      const nx2 = nx % size, ny2 = (nx / size) | 0;
      if (nx < 0 || nx >= size * size || Math.abs(nx2 - cx) + Math.abs(ny2 - cy) !== 1) break;
      c = nx;
    }
    return cells;
  }

  function chainHasHeavy(s, pusherCell, d) {
    // целевая клетка — pusher+d
    const size = s.size;
    let c = pusherCell + delta(d, size);
    const cx = pusherCell % size, cy = (pusherCell / size) | 0;
    const tx = c % size, ty = (c / size) | 0;
    if (c < 0 || c >= size * size || Math.abs(tx - cx) + Math.abs(ty - cy) !== 1) return false;
    const chain = chainCells(s, c, d);
    for (const cc of chain) {
      const u = unitAt(s, cc);
      if (u && u.type === 'heavy') return true;
    }
    return false;
  }

  /* ---------- применение действия ---------- */
  // withEvents=false — быстрый режим для поиска ИИ
  function applyAction(s, a, withEvents) {
    const ev = withEvents ? [] : null;
    if (s.winner !== null) return ev;
    const ok = validate(s, a);
    if (!ok) return ev;
    const size = s.size;

    if (a.k === 'm') {
      const u = getUnit(s, a.id);
      const from = u.cell;
      u.cell = a.to;
      if (withEvents) ev.push({ t: 'move', id: u.id, from, to: a.to, owner: u.owner });
    } else {
      const pusher = getUnit(s, a.id);
      const d = a.d;
      const steps = a.imp ? 2 : 1;
      if (a.imp) {
        s.charge[pusher.owner] = Math.max(0, s.charge[pusher.owner] - 1);
        if (withEvents) ev.push({ t: 'impetus', id: pusher.id, owner: pusher.owner });
      }
      let targetCell = pusher.cell + delta(d, size);
      const chain = chainCells(s, targetCell, d);
      if (withEvents) ev.push({ t: 'shove', id: pusher.id, owner: pusher.owner, d, imp: !!a.imp });

      let chainUnits = chain.map(c => unitAt(s, c)).filter(Boolean);
      for (let step = 0; step < steps && chainUnits.length; step++) {
        const front = chainUnits[chainUnits.length - 1];
        const next = front.cell + delta(d, size);
        const fx = front.cell % size, fy = (front.cell / size) | 0;
        const nx = next % size, ny = (next / size) | 0;
        const off = next < 0 || next >= size * size || Math.abs(nx - fx) + Math.abs(ny - fy) !== 1;
        if (off || s.terrain[next] === WALL) {
          // шлифовка: передний юнит разрушается, остальные сдвигаются на1
          // (+1 заряд резонанса тому, кто толкал)
          destroyUnit(s, front, 'grind', withEvents && ev, pusher.owner);
          chainUnits.pop();
          for (const u of chainUnits) {
            const f = u.cell; u.cell = u.cell + delta(d, size);
            if (withEvents) ev.push({ t: 'move', id: u.id, from: f, to: u.cell, owner: u.owner, shoved: 1 });
          }
          break;
        }
        if (unitAt(s, next)) break; // не должно случиться
        for (const u of chainUnits) {
          const f = u.cell; u.cell = u.cell + delta(d, size);
          if (withEvents) ev.push({ t: 'move', id: u.id, from: f, to: u.cell, owner: u.owner, shoved: 1 });
        }
      }
    }

    checkWin(s, withEvents && ev);
    if (s.winner !== null) { finish(s, withEvents && ev); return ev; }

    /* ФАЗА ОКРУЖЕНИЯ — после КАЖДОГО хода (поток + сжатие).
       Это критически важно для честности: если окружение срабатывает
       только после второго игрока, его поиск всегда видит последствия
       на полхода раньше — и второй игрок выигрывает почти всегда. */
    s.actCount = (s.actCount || 0) + 1;
    applyFlow(s, withEvents && ev, 1);
    checkWin(s, withEvents && ev);
    if (s.winner !== null) { finish(s, withEvents && ev); return ev; }
    applyShrinkIfNeeded(s, withEvents && ev);
    checkWin(s, withEvents && ev);
    if (s.winner !== null) { finish(s, withEvents && ev); return ev; }

    // конец раунда: смена хода, новый раунд, хаос-стрелки
    if (s.turn === 1) {
      s.round++;
      s.turn = 0;
      if (s.cfg.arrowChaos) shuffleArrows(s, withEvents && ev);
      if (s.round > s.cfg.maxRound) { s.winner = 'draw'; s.overReason = 'limit'; finish(s, withEvents && ev); return ev; }
    } else {
      s.turn = 1;
    }
    return ev;
  }

  function validate(s, a) {
    if (!a) return false;
    if (a.k === 'm') {
      const u = getUnit(s, a.id);
      if (!u || u.owner !== s.turn) return false;
      if (s.terrain[a.to] === WALL) return false;
      const dx = Math.abs((a.to % s.size) - (u.cell % s.size));
      const dy = Math.abs(((a.to / s.size) | 0) - ((u.cell / s.size) | 0));
      if (dx + dy !== 1) return false;
      if (unitAt(s, a.to)) return false;
      return true;
    }
    if (a.k === 's') {
      const pusher = getUnit(s, a.id), tgt = getUnit(s, a.tgt);
      if (!pusher || !tgt) return false;
      if (pusher.owner !== s.turn) return false;
      const expect = pusher.cell + delta(a.d, s.size);
      if (tgt.cell !== expect) return false;
      if (a.imp) {
        if (s.charge[pusher.owner] <= 0) return false;
      } else {
        if (chainHasHeavy(s, pusher.cell, a.d)) return false;
      }
      return true;
    }
    return false;
  }

  function destroyUnit(s, u, cause, ev, creditTo) {
    const i = s.units.indexOf(u);
    if (i < 0) return;
    const cell = u.cell;
    s.units.splice(i, 1);
    if (ev) ev.push({ t: 'kill', id: u.id, owner: u.owner, type: u.type, cell, cause });
    // заряд резонанса за толчок-шлифовку
    if ((cause === 'grind' || cause === 'spark') && creditTo !== null && creditTo !== undefined && s.charge[creditTo] < 3) {
      s.charge[creditTo] = Math.min(3, s.charge[creditTo] + 1);
      if (ev) ev.push({ t: 'charge', owner: creditTo, n: s.charge[creditTo], reason: cause });
    }
    // Искра: взрывается при гибели, уничтожая соседей (дружественный огонь тоже)
    if (u.type === 'spark') {
      if (ev) ev.push({ t: 'boom', cell, owner: u.owner });
      const size = s.size;
      const neighbors = [];
      for (let d = 0; d < 4; d++) {
        const nx = cell + delta(d, size);
        const cx = cell % size, cy = (cell / size) | 0;
        const px = nx % size, py = (nx / size) | 0;
        if (nx < 0 || nx >= size * size || Math.abs(px - cx) + Math.abs(py - cy) !== 1) continue;
        const nu = unitAt(s, nx);
        if (nu) neighbors.push(nu);
      }
      for (const nu of neighbors) destroyUnit(s, nu, 'spark', ev, creditTo);
    }
  }

  /* ---------- фаза потока ---------- */
  function applyFlow(s, ev, maxSteps) {
    if (ev) ev.push({ t: 'flowStart' });
    const size = s.size;
    const steps = maxSteps || 1;
    const riders = s.units.filter(u => isArrow(s.terrain[u.cell]));
    // стабильный порядок по id
    riders.sort((a, b) => a.id - b.id);
    for (const u of riders) {
      if (s.units.indexOf(u) < 0) continue; // мог быть уничтожен
      for (let step = 0; step < steps; step++) {
        if (s.units.indexOf(u) < 0) break;
        const t = s.terrain[u.cell];
        if (!isArrow(t)) break;
        const d = arrowDir(t);
        const next = u.cell + delta(d, size);
        const ux = u.cell % size, uy = (u.cell / size) | 0;
        const nx = next % size, ny = (next / size) | 0;
        const off = next < 0 || next >= size * size || Math.abs(nx - ux) + Math.abs(ny - uy) !== 1;
        if (off || s.terrain[next] === WALL) {
          destroyUnit(s, u, 'flow', ev);
          break;
        }
        if (unitAt(s, next)) break;
        const from = u.cell;
        u.cell = next;
        if (ev) ev.push({ t: 'move', id: u.id, from, to: next, owner: u.owner, flow: 1 });
        if (s.terrain[u.cell] === ANCHOR) break; // якорь останавливает
      }
    }
    if (ev) ev.push({ t: 'flowEnd' });
  }

  // Гибель от среды (поток/сжатие) не начисляет заряда — зародится только за толчки.

  /* ---------- сжатие периметра ---------- */
  function applyShrinkIfNeeded(s, ev) {
    const cfg = s.cfg;
    if (!cfg.startShrink) return;
    // Считаем в ДЕЙСТВИЯХ, а не в раундах, и с нечётным интервалом:
    // события сжатия попадают в разные паритеты (то после игрока0, то после
    // игрока1), поэтому оба игрока в среднем видят их одинаково рано в поиске.
    const startA = cfg.startShrink * 2 - 1;   // нечётное → паритет игрока0
    const everyA = cfg.shrinkEvery * 2 - 1;   // нечётное → паритет чередуется
    const ac = s.actCount || 0;
    if (ac < startA) return;
    if ((ac - startA) % everyA !== 0) return;
    const ring = 1 + Math.floor((ac - startA) / everyA);
    const size = s.size;
    const changed = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (r !== ring) continue;
      const c = idx(x, y, size);
      if (s.terrain[c] !== WALL) { s.terrain[c] = WALL; changed.push(c); }
    }
    // юниты на кольце уничтожаются
    const victims = s.units.filter(u => s.terrain[u.cell] === WALL);
    if (ev) ev.push({ t: 'shrink', ring, walls: changed });
    for (const u of victims) {
      destroyUnit(s, u, 'shrink', ev);
    }
    if (ev && victims.length) ev.push({ t: 'shrinkKills', n: victims.length });
  }

  function shuffleArrows(s, ev) {
    const rng = mulberry32((s.rngState = (s.rngState * 1664525 + 1013904223) >>> 0));
    const size = s.size;
    const arrows = [];
    for (let i = 0; i < s.terrain.length; i++) if (isArrow(s.terrain[i])) arrows.push(i);
    if (ev) ev.push({ t: 'chaos' });
    for (const c of arrows) {
      if (rng() < 0.4) s.terrain[c] = A_RIGHT + ((rng() * 4) | 0);
    }
  }

  /* ---------- победа ---------- */
  function checkWin(s, ev) {
    if (s.winner !== null) return;
    const cores = [null, null];
    for (const u of s.units) if (u.type === 'core') cores[u.owner] = u;
    if (!cores[0] && !cores[1]) { s.winner = 'draw'; s.overReason = 'double'; if (ev) ev.push({ t: 'over', winner: 'draw', reason: 'double' }); }
    else if (!cores[0]) { s.winner = 1; s.overReason = 'core'; if (ev) ev.push({ t: 'over', winner: 1, reason: 'core' }); }
    else if (!cores[1]) { s.winner = 0; s.overReason = 'core'; if (ev) ev.push({ t: 'over', winner: 0, reason: 'core' }); }
  }

  function finish(s, ev) {
    if (ev) ev.push({ t: 'finish', winner: s.winner, reason: s.overReason });
  }

  /* ---------- вспомогательное ---------- */
  function countUnits(s, owner, type) {
    let n = 0;
    for (const u of s.units) if (u.owner === owner && (!type || u.type === type)) n++;
    return n;
  }

  function coreOf(s, owner) {
    for (const u of s.units) if (u.owner === owner && u.type === 'core') return u;
    return null;
  }

  // симметрия180° (стрелки при повороте разворачиваются: v↔^, >↔<)
  function flipArrowCode(v) {
    if (v === A_RIGHT) return A_LEFT;
    if (v === A_LEFT) return A_RIGHT;
    if (v === A_UP) return A_DOWN;
    if (v === A_DOWN) return A_UP;
    return v;
  }

  function rotateTerrain180(t, size) {
    const out = new Uint8Array(t.length);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      out[idx(size - 1 - x, size - 1 - y, size)] = flipArrowCode(t[idx(x, y, size)]);
    }
    return out;
  }

  function isSymmetric180(t, size) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = t[idx(x, y, size)];
      const m = t[idx(size - 1 - x, size - 1 - y, size)];
      if (v !== flipArrowCode(m)) return false;
    }
    return true;
  }

  // генерация строго симметричного случайного поля (180°, стрелки разворачиваются)
  function genChaosTerrain(size, rng, density) {
    density = density || 0.16;
    const t = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const edge = (x === 0 || y === 0 || x === size - 1 || y === size - 1);
      if (edge) t[idx(x, y, size)] = WALL;
    }
    const mir = (i) => idx(size - 1 - (i % size), size - 1 - ((i / size) | 0), size);
    for (let i = 0; i < t.length; i++) {
      const x = i % size, y = (i / size) | 0;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) continue;
      const m = mir(i);
      if (m <= i && m !== i) continue;          // зеркало уже обработано
      const r = rng();
      let v = EMPTY;
      if (r < density * 0.45) v = WALL;
      else if (r < density * 0.6) v = ANCHOR;
      else if (r < density) v = A_RIGHT + ((rng() * 4) | 0);
      t[i] = v;
      t[m] = m === i ? v : flipArrowCode(v);
    }
    // гарантированно чистый центр и стартовые зоны (иначе ядро может родиться на потоке-убийце)
    const c = size >> 1;
    for (let o = -1; o <= 1; o++) for (let p = -1; p <= 1; p++) {
      const x = c + o, y = c + p;
      if (x > 0 && y > 0 && x < size - 1 && y < size - 1) t[idx(x, y, size)] = EMPTY;
    }
    const spawns = defaultSpawns(size);
    for (const side of spawns) for (const sp of side) t[sp.cell] = EMPTY;
    return t;
  }

  /* сериализация для сети */
  function serialize(s) {
    return {
      size: s.size,
      terrain: Array.from(s.terrain),
      units: s.units.map(u => ({ id: u.id, owner: u.owner, type: u.type, cell: u.cell })),
      charge: s.charge.slice(),
      turn: s.turn, round: s.round, acted: s.acted, actCount: s.actCount || 0,
      winner: s.winner, overReason: s.overReason,
      cfg: s.cfg, seed: s.seed, rngState: s.rngState, nextId: s.nextId
    };
  }
  function deserialize(o) {
    return {
      size: o.size,
      terrain: Uint8Array.from(o.terrain),
      units: o.units.map(u => ({ id: u.id, owner: u.owner, type: u.type, cell: u.cell })),
      charge: o.charge.slice(),
      turn: o.turn, round: o.round, acted: o.acted, actCount: o.actCount || 0,
      winner: o.winner, overReason: o.overReason,
      cfg: o.cfg, seed: o.seed, rngState: o.rngState, nextId: o.nextId
    };
  }

  return {
    EMPTY, WALL, ANCHOR, A_RIGHT, A_LEFT, A_UP, A_DOWN,
    delta, isArrow, arrowDir, idx, coord, unitAt, getUnit,
    createGame, cloneState, legalActions, applyAction, validate,
    countUnits, coreOf, rotateTerrain180, isSymmetric180, genChaosTerrain,
    mulberry32, serialize, deserialize, defaultTerrain, defaultSpawns,
    chainCells
  };
});
