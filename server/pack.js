/* ═══════════════════════════════════════════════════════════════
   Сборка одиночного exe (Node SEA): server/pack.js
   Использование:
     node server/pack.js <путь-к-node.exe-для-win>   → dist/РЕЗОНАНС.exe (win64)
     node server/pack.js --linux                     → dist/resonance-linux (тест)
   Что делает: склеивает server+engine в main, упаковывает клиентские
   файлы как SEA-ассеты, впрыскивает blob в копию node.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(DIST, 'sea-build');
fs.mkdirSync(BUILD, { recursive: true });

/* ── 1. клиентские файлы (ассеты) ── */
const ASSETS = [
  'index.html',
  'css/style.css',
  'js/engine.js', 'js/ai.js', 'js/content.js', 'js/audio.js',
  'js/render.js', 'js/net.js', 'js/worker.js', 'js/ui.js', 'js/main.js'
];
for (const a of ASSETS) {
  if (!fs.existsSync(path.join(ROOT, a))) { console.error('НЕТ ФАЙЛА:', a); process.exit(1); }
}

/* ── 2. main = engine.js + server.js (без require движка) ── */
const engine = fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8');
let server = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
server = server.replace("const E = require('../js/engine.js');", 'const E = module.exports;');
const main = [
  '/* ══ РЕЗОНАНС: сборка SEA (engine + server) — генерируется server/pack.js ══ */',
  engine,
  '/* ══ сервер ══ */',
  server
].join('\n');
const mainFile = path.join(BUILD, 'main.js');
fs.writeFileSync(mainFile, main);

/* ── 3. sea-config ── */
const assetsMap = {};
for (const a of ASSETS) assetsMap[a] = path.join(ROOT, a); // node24: map имён → строковые пути
const cfg = {
  main: mainFile,
  output: path.join(BUILD, 'blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: assetsMap
};
const cfgFile = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

const BLOB_NODE = process.env.BLOB_NODE || process.execPath; // версия node = версии целевой платформы
console.log('→ генерация blob через', BLOB_NODE);
let r = spawnSync(BLOB_NODE, ['--experimental-sea-config', cfgFile], { stdio: 'inherit' });
if (r.status !== 0) { console.error('sea-config failed'); process.exit(1); }

/* ── 4. база: node.exe (win) или текущий node (linux-тест) ── */
const arg = process.argv[2];
let base, out, plat;
if (arg === '--linux') {
  base = process.execPath; out = path.join(DIST, 'resonance-linux'); plat = 'linux';
} else if (arg && fs.existsSync(arg)) {
  base = arg; out = path.join(DIST, 'РЕЗОНАНС.exe'); plat = 'win32';
} else { console.error('укажи путь к node.exe или --linux'); process.exit(1); }

fs.copyFileSync(base, out);
fs.chmodSync(out, 0o755);
console.log('→ впрыск blob в', path.basename(out));
const postject = path.join(ROOT, 'node_modules', '.bin', 'postject');
r = spawnSync(postject, [
  out, 'NODE_SEA_BLOB', path.join(BUILD, 'blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
], { stdio: 'inherit' });
if (r.status !== 0) { console.error('postject failed'); process.exit(1); }

const size = fs.statSync(out).size;
console.log(`✅ ${out}  (${(size / 1e6).toFixed(1)} МБ)`);
