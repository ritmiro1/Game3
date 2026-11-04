/* Юнит-тесты движка РЕЗОНАНС (node js/test_engine.js) */
const E = require('../js/engine.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.log('FAIL: ' + msg); }
}
function mk(size, terrainRows, spawns) {
  const t = new Uint8Array(size * size);
  terrainRows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      let v = E.EMPTY;
      if (ch === '#') v = E.WALL;
      else if (ch === 'A') v = E.ANCHOR;
      else if (ch === '>') v = E.A_RIGHT;
      else if (ch === '<') v = E.A_LEFT;
      else if (ch === '^') v = E.A_UP;
      else if (ch === 'v') v = E.A_DOWN;
      t[E.idx(x, y, size)] = v;
    }
  });
  return E.createGame({ size: size, terrain: t, spawns, seed: 42 });
}
const P = (x, y, s) => E.idx(x, y, s);

/* 1. Базовый шаг */
{
  const s = mk(5, ['#####', '#...#', '#...#', '#...#', '#####'],
    [[{ type: 'core', cell: P(1, 3, 5) }, { type: 'node', cell: P(2, 3, 5) }],
     [{ type: 'core', cell: P(3, 1, 5) }, { type: 'node', cell: P(2, 1, 5) }]]);
  const acts = E.legalActions(s);
  ok(acts.length > 0, 'есть легальные действия');
  const mv = acts.find(a => a.k === 'm' && a.id === 2);
  ok(!!mv, 'юнит2 может шагнуть');
  E.applyAction(s, mv, true);
  ok(E.getUnit(s, 2).cell === mv.to, 'шаг применён');
  ok(s.turn === 1, 'ход перешёл к1');
}

/* 2. Толчок в стену = шлифовка + заряд */
{
  const s = mk(5, ['#####', '#...#', '#...#', '#...#', '#####'],
    [[{ type: 'core', cell: P(1, 1, 5) }, { type: 'node', cell: P(2, 2, 5) }],
     [{ type: 'core', cell: P(3, 1, 5) }, { type: 'node', cell: P(3, 2, 5) }]]);
  const shove = E.legalActions(s).find(a => a.k === 's' && a.id === 2 && a.d === 0);
  ok(!!shove, 'толчок вправо легален');
  const ev = E.applyAction(s, shove, true);
  ok(!E.getUnit(s, 4), 'вражеский узел разбит об стену');
  ok(s.charge[0] === 1, 'заряд +1 за шлифовку, got ' + s.charge[0]);
  ok(ev && ev.some(e => e.t === 'kill' && e.cause === 'grind'), 'событие kill(grind)');
}

/* 3. Цепной толчок: ядро в конце цепи → победа */
{
  const s = mk(7, ['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######'],
    [[{ type: 'core', cell: P(1, 3, 7) }, { type: 'node', cell: P(3, 3, 7) }],
     [{ type: 'core', cell: P(5, 3, 7) }, { type: 'node', cell: P(4, 3, 7) }]]);
  const shove = E.legalActions(s).find(a => a.k === 's' && a.id === 2 && a.d === 0 && !a.imp);
  ok(!!shove, 'цепной толчок легален');
  E.applyAction(s, shove, true);
  ok(!E.getUnit(s, 3), 'ядро (последнее в цепи) разбито об стену');
  ok(!!E.getUnit(s, 4), 'вражеский узел выжил (сдвинулся)');
  ok(s.winner === 0, 'победа игрока0 после уничтожения ядра');
}

/* 4. Тяжёлый блокирует обычный толчок, Импульс проходит */
{
  const s = mk(7, ['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######'],
    [[{ type: 'core', cell: P(1, 3, 7) }, { type: 'node', cell: P(3, 3, 7) }, { type: 'heavy', cell: P(4, 3, 7) }],
     [{ type: 'core', cell: P(5, 3, 7) }, { type: 'node', cell: P(4, 2, 7) }]]);
  const acts = E.legalActions(s);
  const normal = acts.find(a => a.k === 's' && a.id === 2 && a.d === 0 && !a.imp);
  ok(!normal, 'обычный толчок через тяжёлого нелегален');
  ok(!acts.find(a => a.k === 's' && a.id === 2 && a.d === 0 && a.imp), 'без заряда импульс нелегален');
  s.charge[0] = 1;
  const imp2 = E.legalActions(s).find(a => a.k === 's' && a.id === 2 && a.d === 0 && a.imp);
  ok(!!imp2, 'с зарядом импульс легален');
  E.applyAction(s, imp2, true);
  // заряд потрачен, но возвращён за шлифовку убитого в цепи →1
  ok(s.charge[0] === 1, 'заряд: минус импульс плюс убийство =1, got ' + s.charge[0]);
  ok(E.getUnit(s, 3).cell === P(5, 3, 7), 'тяжёлый сдвинут вправо, cell=' + E.getUnit(s, 3).cell);
}

/* 5. Поток: езда по стрелке и гибель в шлифовке */
{
  // узел1 на '>' у стены → погибает в первой же фазе потока
  const s = mk(5, ['#####', '#..>#', '#...#', '#...#', '#####'],
    [[{ type: 'core', cell: P(1, 3, 5) }],
     [{ type: 'core', cell: P(3, 3, 5) }, { type: 'node', cell: P(3, 1, 5) }]]);
  E.applyAction(s, E.legalActions(s).find(a => a.k === 'm' && a.id === 1), true);
  E.applyAction(s, E.legalActions(s).find(a => a.k === 'm' && a.id === 2), true);
  ok(!E.getUnit(s, 3), 'узел на потоке сбит в стену');
  ok(s.round === 2, 'раунд прошёл, round=' + s.round);
}

/* 6. Якорь останавливает поток */
{
  const s = mk(5, ['#####', '#>>A#', '#...#', '#...#', '#####'],
    [[{ type: 'core', cell: P(1, 3, 5) }],
     [{ type: 'core', cell: P(3, 3, 5) }, { type: 'node', cell: P(1, 1, 5) }]]);
  E.applyAction(s, E.legalActions(s).find(a => a.k === 'm' && a.id === 1), true);
  E.applyAction(s, E.legalActions(s).find(a => a.k === 'm' && a.id === 2), true);
  const u = E.getUnit(s, 3);
  ok(u && u.cell === P(3, 1, 5), 'узел доехал до якоря и остановился, cell=' + (u && u.cell));
}

/* 7. Сжатие периметра (кольцо1 на36-м раунде) */
{
  const s = mk(7, ['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######'],
    [[{ type: 'core', cell: P(3, 3, 7) }],
     [{ type: 'core', cell: P(1, 1, 7) }]]);
  s.round = 35;
  s.actCount = 70; // следующее действие станет71-м → кольцо1
  E.applyAction(s, E.legalActions(s).find(a => a.id === 1), true); // ход0 → сжатие кольца1
  E.applyAction(s, E.legalActions(s).find(a => a.id === 2), true); // ход1 (игрок уже мог погибнуть)
  ok(s.terrain[E.idx(1, 1, 7)] === E.WALL, 'кольцо1 стало стеной');
  ok(!E.getUnit(s, 2), 'вражеское ядро на кольце уничтожено');
  ok(s.winner === 0, 'победа из-за сжатия, winner=' + s.winner);
}

/* 8. Симметрия генерируемого поля */
{
  const t = E.genChaosTerrain(7, E.mulberry32(7), 0.2);
  ok(E.isSymmetric180(t, 7), 'поле симметрично180°');
}

/* 9. Искра взрывается */
{
  const s = mk(5, ['#####', '#...#', '#...#', '#...#', '#####'],
    [[{ type: 'core', cell: P(1, 1, 5) }, { type: 'node', cell: P(2, 2, 5) }],
     [{ type: 'core', cell: P(3, 1, 5) }, { type: 'spark', cell: P(3, 2, 5) }]]);
  const shove = E.legalActions(s).find(a => a.k === 's' && a.id === 2 && a.d === 0 && !a.imp);
  ok(!!shove, 'толчок искры легален');
  E.applyAction(s, shove, true);
  ok(!E.getUnit(s, 4), 'искра погибла в шлифовке');
  ok(!E.getUnit(s, 2), 'взрыв искры уничтожил соседний узел');
  ok(!!E.getUnit(s, 1), 'ядро0 выжило');
  ok(s.winner === 0, 'ядро1 взорвано цепью? winner=' + s.winner);
}

/* 10. Сериализация */
{
  const s = E.createGame({ seed: 1 });
  const s2 = E.deserialize(E.serialize(s));
  ok(s2.size === s.size && s2.units.length === s.units.length, 'сериализация ок');
}

/* 11. Быстрые случайные партии не зависают */
{
  const rng = E.mulberry32(123);
  let finished = 0;
  for (let g = 0; g < 30; g++) {
    const t = E.genChaosTerrain(7, E.mulberry32(g + 1), 0.15);
    const s = E.createGame({ seed: g, terrain: t });
    let guard = 0;
    while (s.winner === null && guard++ < 500) {
      const acts = E.legalActions(s);
      if (!acts.length) break;
      E.applyAction(s, acts[(rng() * acts.length) | 0], false);
    }
    if (s.winner !== null) finished++;
    else ok(guard >= 500, 'партия в лимите');
  }
  ok(finished >= 15, 'большинство партий завершились, finished=' + finished);
}

console.log(`\nИтого: passed=${passed}, failed=${failed}`);
process.exit(failed ? 1 : 0);
