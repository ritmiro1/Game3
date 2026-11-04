/* Тест ИИ: node js/test_ai.js */
const E = require('../js/engine.js');
const AI = require('../js/ai.js');

function playGame(opts) {
  const t = E.genChaosTerrain(7, E.mulberry32(opts.seed || 1), 0.15);
  const s = E.createGame({ seed: opts.seed || 1, terrain: t });
  let nodes = 0;
  const t0 = Date.now();
  while (s.winner === null && nodes++ < 300) {
    const o = opts[s.turn];
    const a = AI.think(s, o);
    if (!a) break;
    E.applyAction(s, a, false);
  }
  return { winner: s.winner, round: s.round, ms: Date.now() - t0 };
}

/* 1. Сильный vs слабый — сильный должен побеждать чаще */
let wins = 0, draws = 0, games = 10;
const STRONG = { time: 550, noise: 0 };
const WEAK = { time: 160, noise: 0.7 };
for (let g = 0; g < games; g++) {
  const r = playGame({
    seed: g * 7 + 1,
    0: Object.assign({}, STRONG),
    1: Object.assign({}, WEAK)
  });
  if (r.winner === 0) wins++;
  if (r.winner === 'draw') draws++;
}
console.log(`Сильный(0) vs Слабый(1): ${wins}/${games} побед, ничьих ${draws}`);
if (wins < games * 0.7) { console.log('FAIL: сильный слишком слаб'); process.exit(1); }

/* 2. Сильный vs средний — сильный должен иметь перевес */
let w2 = 0, g2 = 8;
for (let g = 0; g < g2; g++) {
  const r = playGame({ seed: 100 + g * 13, 0: Object.assign({}, STRONG), 1: { time: 160, noise: 0.45 } });
  if (r.winner === 0) w2++;
}
console.log(`Сильный vs Средний: ${w2}/${g2}`);
if (w2 < g2 * 0.55) { console.log('FAIL: разрыв слишком мал'); process.exit(1); }

/* 3. Время на ход */
{
  const t = E.genChaosTerrain(7, E.mulberry32(5), 0.15);
  const s = E.createGame({ seed: 5, terrain: t });
  for (let i = 0; i < 4; i++) {
    const a = AI.think(s, { time: 900, noise: 0 });
    const t0 = Date.now();
    AI.think(s, { time: 900, noise: 0 });
    const dt = Date.now() - t0;
    console.log(`  ход ${i + 1}: ${dt}ms`);
    if (dt > 1800) { console.log('FAIL: превышен лимит времени'); process.exit(1); }
    E.applyAction(s, a, false);
    if (s.winner !== null) break;
  }
}

/* 4. Тактика: мат в1 находится */
{
  // вражеское ядро у стены, наш юнит напротив — толчок = победа
  const size = 7;
  const t = new Uint8Array(size * size).fill(0);
  for (let i = 0; i < size; i++) { t[i] = 1; t[(size - 1) * size + i] = 1; t[i * size] = 1; t[i * size + size - 1] = 1; }
  const s = E.createGame({
    size, terrain: t, seed: 3,
    spawns: [
      [{ type: 'core', cell: E.idx(3, 5, size) }, { type: 'node', cell: E.idx(4, 3, size) }],
      [{ type: 'core', cell: E.idx(5, 3, size) }, { type: 'node', cell: E.idx(1, 1, size) }]
    ]
  });
  // ядро1 в (5,3), стена в (6,3). наш узел в (4,3) — толчок вправо → ядро в стену → победа
  const a = AI.think(s, { time: 300, noise: 0 });
  const g = a && a.k === 's' && a.d === 0;
  console.log('  мат-в-1 ход:', JSON.stringify(a));
  if (!g) { console.log('FAIL: не найден мат в1'); process.exit(1); }
  E.applyAction(s, a, true);
  if (s.winner !== 0) { console.log('FAIL: победа не наступила'); process.exit(1); }
}

console.log('\nИИ-тесты пройдены');
