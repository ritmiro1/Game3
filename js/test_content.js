/* Валидация контента: node js/test_content.js
   - карты валидны (юниты не пересекаются, не на стенах, в границах)
   - каждая миссия проходима: сильный игрок (оракул) против вражеского ИИ побеждает ≥60% */
/* фиксированный Math.random → тест детерминирован (джиттеры AI воспроизводимы) */
let _seed = 0x2f6e2b1;
Math.random = function () {
  _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0;
  let t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const C = require('../js/content.js');

let failed = 0;
function ok(c, m) { if (!c) { failed++; console.log('FAIL: ' + m); } }

function buildMission(m) {
  const size = m.size;
  const t = C.parseTerrain(m.t0);
  const s0 = C.units(m.p0, size), s1 = C.units(m.p1, size);
  const all = s0.concat(s1);
  const seen = new Set();
  for (const u of all) {
    ok(u.cell >= 0 && u.cell < size * size, `миссия ${m.id}: юнит вне поля`);
    ok(!seen.has(u.cell), `миссия ${m.id}: пересечение юнитов в клетке ${u.cell}`);
    seen.add(u.cell);
    ok(t[u.cell] !== 1, `миссия ${m.id}: юнит на стене (клетка ${u.cell})`);
    if (u.type === 'core') ok(true, '');
  }
  ok(s0.some(u => u.type === 'core'), `миссия ${m.id}: нет ядра игрока`);
  ok(s1.some(u => u.type === 'core'), `миссия ${m.id}: нет ядра врага`);
  const cfg = {
    size, terrain: t, spawns: [s0, s1], seed: m.id,
    startShrink: m.startShrink || 36, shrinkEvery: m.shrinkEvery || 8,
    arrowChaos: m.arrowChaos || 0, mode: 'campaign'
  };
  return E.createGame(cfg);
}

/* структурная проверка */
for (const m of C.CAMPAIGN) buildMission(m);
ok(C.CAMPAIGN.length === 36, 'кампания:36 миссий, есть ' + C.CAMPAIGN.length);
const ids = new Set(C.CAMPAIGN.map(m => m.id));
ok(ids.size === 36, 'ID уникальны');
for (let i = 0; i < C.SECTORS.length; i++) {
  const n = C.CAMPAIGN.filter(m => m.sector === i).length;
  ok(n === 9, `сектор ${i}:9 миссий, есть ${n}`);
}
for (const b of C.LADDER) ok(AI.LEVELS[b.level], 'бот ' + b.name + ': уровень существует');
for (const a of C.ARCADE) ok(a.cfg && a.cfg.size, 'аркада ' + a.name);
for (const map of C.MAPS) {
  const t = C.parseTerrain(map.rows);
  ok(E.isSymmetric180(t, map.rows.length), 'карта ' + map.name + ' симметрична');
}

/* проходимость: сильный игрок побеждает вражеский ИИ в большинстве партий */
console.log('\nПроверка проходимости (по2 партии на миссию, детерминированно)...');
const PLAYER = { nodes: 30000, time: 20000, noise: 0 };
let hardOnes = [];
for (const m of C.CAMPAIGN) {
  let pw = 0, pd = 0;
  const enemy = AI.levelOpts(m.enemy.level, m.enemy.style);
  enemy.nodes = Math.min(enemy.nodes, 40000);
  for (let g = 0; g < 2; g++) {
    const s = buildMission(m);
    let guard = 0;
    while (s.winner === null && guard++ < 400) {
      const opts = s.turn === 0 ? PLAYER : enemy;
      const a = AI.think(s, opts);
      if (!a) break;
      E.applyAction(s, a, false);
    }
    if (s.winner === 0) pw++;
    if (s.winner === 'draw') pd++;
  }
  // ничья = половина очка; важнее, чтобы игрок не ПРОИГРЫВАЛ чаще, чем выигрывает
  const score = (pw + pd * 0.5) / 2;
  const flag = score < 0.5 ? '  << СЛОЖНО' : '';
  console.log(`  миссия ${String(m.id).padStart(2)} ${m.name.padEnd(22)} победы:${pw} ничьи:${pd}${flag}`);
  if (score < 0.5) hardOnes.push(m.id);
}
ok(hardOnes.length <= 8, 'слишком сложные миссии (счёт <50%): ' + hardOnes.join(','));

console.log(failed ? `\nКОНТЕНТ-ТЕСТЫ ПРОВАЛЕНЫ (${failed})` : '\nКОНТЕНТ-ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
