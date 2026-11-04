/* ═══════════════════════════════════════════════════════════════
   РЕЗОНАНС — E2E smoke-тест интерфейса в jsdom против живого сервера.
   Прогон: загрузка → все экраны → настройки → онлайн-комната →
   полная партия в кампании (случайные ходы против бота) → результат.
   Запуск: node js/test_ui.js   (сервер должен быть запущен)
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createCanvas } = require('@napi-rs/canvas');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SHOTS = path.join(__dirname, '..', 'media');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || extra == null ? '' : '   ← ' + extra));
  if (!cond) fails++;
}

async function main() {
  const pageErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => pageErrors.push('jsdomError: ' + (e.stack || e.message).split('\n')[0]));
  vc.on('error', (...a) => pageErrors.push('console.error: ' + a.map(String).join(' ')));

  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // — layout-имитация: элементы «на всю страницу» (иначе canvas 240px)
      const protoE = window.Element.prototype;
      Object.defineProperty(protoE, 'clientWidth', { configurable: true, get() { return window.innerWidth; } });
      Object.defineProperty(protoE, 'clientHeight', { configurable: true, get() { return window.innerHeight; } });
      // — canvas → @napi-rs/canvas
      const proto = window.HTMLCanvasElement.prototype;
      Object.defineProperty(proto, 'width', { configurable: true, get() { return this._w || 300; }, set(v) { this._w = +v; if (this.__c) this.__c.width = Math.max(1, +v | 0); } });
      Object.defineProperty(proto, 'height', { configurable: true, get() { return this._h || 150; }, set(v) { this._h = +v; if (this.__c) this.__c.height = Math.max(1, +v | 0); } });
      proto.getContext = function () {
        if (!this.__c) this.__c = createCanvas(1, 1);
        if (this.__c.width !== this.width) this.__c.width = Math.max(1, this.width | 0);
        if (this.__c.height !== this.height) this.__c.height = Math.max(1, this.height | 0);
        if (!this.__ctx || this.__ctxSrc !== this.__c) {
          this.__ctxSrc = this.__c;
          const self = this;
          this.__ctx = new Proxy({}, {
            get(t, prop) {
              const c = self.__c.getContext('2d');
              const v = c[prop];
              return typeof v === 'function' ? v.bind(c) : v;
            },
            set(t, prop, val) { self.__c.getContext('2d')[prop] = val; return true; }
          });
        }
        return this.__ctx;
      };
      window.__cap = sel => {
        const el = window.document.querySelector(sel);
        return el && el.__c ? el.__c : null;
      };
      window.addEventListener('error', e => pageErrors.push('onerror: ' + e.message));
      const oe = window.console.error;
      window.console.error = (...a) => { pageErrors.push('console.error: ' + a.map(x => (x && x.message) || String(x)).join(' ')); oe.apply(window.console, a); };
    }
  });

  const { window } = dom;
  const { document } = window;
  await new Promise(r => window.addEventListener('load', r, { once: true }));
  await sleep(400);

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const active = () => { const a = document.querySelector('.screen.active'); return a ? a.id : null; };
  const clickEl = el => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const shot = (name, sel) => {
    try {
      const nc = window.__cap(sel);
      if (!nc) { check('shot ' + name, false, 'canvas not found'); return; }
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, name + '.png'), nc.toBuffer('image/png'));
      console.log('  [shot] media/' + name + '.png');
    } catch (e) { check('shot ' + name, false, e.message); }
  };

  /* ── 1. загрузка ── */
  check('загрузка: нет ошибок', pageErrors.length === 0, pageErrors[0]);
  check('экран меню активен', active() === 'scr-menu', active());
  check('canvas отрисован (есть пиксели)', (() => {
    const nc = window.__cap('#menu-bg');
    if (!nc) return false;
    const d = nc.getContext('2d').getImageData(0, 0, nc.width, nc.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4000) if (d[i]) n++;
    return n > 5;
  })());
  shot('01-menu', '#menu-bg');

  /* ── 2. навигация по экранам ── */
  const nav = [
    ['campaign', 'scr-campaign'], ['duel', 'scr-duel'], ['arcade', 'scr-arcade'],
    ['online', 'scr-online'], ['codex', 'scr-codex'], ['achieve', 'scr-achieve'],
    ['settings', 'scr-settings'], ['menu', 'scr-menu']
  ];
  for (const [go, scr] of nav) {
    clickEl(document.querySelector(`[data-go="${go}"]`));
    await sleep(80);
    check('навигация → ' + scr, active() === scr, active());
  }
  shot('02-campaign', '#menu-bg');

  // вкладки кодекса и онлайна
  clickEl(document.querySelector('[data-go="codex"]')); await sleep(60);
  for (const t of ['units', 'lore', 'controls', 'rules']) {
    clickEl(document.querySelector(`[data-ctab="${t}"]`)); await sleep(40);
    const page = $(`#ctab-${t}`);
    check('кодекс вкладка ' + t, page && page.classList.contains('active'));
  }
  clickEl(document.querySelector('[data-go="menu"]')); await sleep(60);

  /* ── 3. настройки ── */
  clickEl(document.querySelector('[data-go="settings"]')); await sleep(60);
  const cbShake = $('#set-shake');
  const before = cbShake.checked;
  clickEl(cbShake.closest('label') || cbShake); await sleep(40);
  check('настройка «тряска» переключается', cbShake.checked !== before);
  clickEl((cbShake.closest('label') || cbShake)); await sleep(30); // вернуть
  clickEl(document.querySelector('[data-go="menu"]')); await sleep(60);

  /* ── 4. онлайн: подключение + комната ── */
  clickEl(document.querySelector('[data-go="online"]')); await sleep(80);
  let netOk = false;
  for (let i = 0; i < 40 && !netOk; i++) {
    netOk = $('#net-status').textContent.includes('в сети');
    if (!netOk) await sleep(100);
  }
  check('WebSocket подключился', netOk, $('#net-status').textContent);
  clickEl($('#btn-create')); await sleep(300);
  check('комната создана', $('#room-list').textContent.includes('ВАША КОМНАТА'), $('#room-list').textContent.slice(0, 80));
  const leaveBtn = $$('#room-list button').find(b => b.textContent.includes('ЫТИ') || b.textContent.includes('ВЫЙТИ'));
  clickEl(leaveBtn); await sleep(200);
  check('выход из комнаты', !$('#room-list').textContent.includes('ВАША КОМНАТА'));
  // вкладки онлайна
  for (const t of ['rooms', 'top', 'play']) {
    clickEl(document.querySelector(`[data-otab="${t}"]`)); await sleep(120);
    const page = $(`#otab-${t}`);
    check('онлайн вкладка ' + t, page && page.classList.contains('active'));
  }
  const topRows = $$('#top-table > *');
  check('рейтинги отрисованы', topRows.length > 0, 'rows=' + topRows.length);
  clickEl(document.querySelector('[data-go="menu"]')); await sleep(60);

  /* ── 5. полная партия в кампании ── */
  clickEl(document.querySelector('[data-go="campaign"]')); await sleep(80);
  const m1 = $('#camp-grid .mcard:not(.locked)');
  check('миccия 01 доступна', !!m1);
  clickEl(m1); await sleep(80);
  check('бриф миссии открыт', $('#brief-modal') && !$('#brief-modal').hidden);
  clickEl($('#brief-start')); await sleep(600);
  check('экран партии активен', active() === 'scr-game', active());

  const E = window.Engine;
  const UI = window.UI;
  const canvas = $('#game-canvas');
  const pointOf = cell => {
    const n = UI.game.state.size;
    const W = canvas.width, H = canvas.height;
    const boardPx = Math.min(W, H);
    const cellPx = boardPx / n;
    const ox = (W - boardPx) / 2, oy = (H - boardPx) / 2;
    return { x: ox + ((cell % n) + 0.5) * cellPx, y: oy + (((cell / n) | 0) + 0.5) * cellPx };
  };
  const tap = cell => {
    const p = pointOf(cell);
    canvas.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));
  };

  let midShot = false;
  const deadline = Date.now() + 150000;
  let plies = 0;
  while (Date.now() < deadline) {
    const g = UI.game;
    if (!g || g.over) break;
    if (g.over) break;
    if (g.animating || g.state.turn !== g.mySeat) { await sleep(60); continue; }
    const acts = E.legalActions(g.state);
    if (!acts.length) { await sleep(60); continue; }
    const a = acts[(Math.random() * acts.length) | 0];
    const unit = E.getUnit(g.state, a.id);
    if (!unit) { await sleep(60); continue; }
    tap(unit.cell);
    await sleep(40);
    const tgtCell = a.k === 'm' ? a.to : (E.getUnit(g.state, a.tgt) || {}).cell;
    if (tgtCell == null) { await sleep(60); continue; }
    tap(tgtCell);
    plies++;
    await sleep(120);
    if (!midShot && plies >= 6) { midShot = true; await sleep(450); shot('03-game', '#game-canvas'); }
    // изредка жмём подсказку и эмоции — не должны ломать игру
    if (plies === 10) { clickEl($('#btn-hint')); await sleep(200); }
    if (plies === 14) { clickEl($('#btn-emote')); await sleep(80); clickEl($('#btn-emote')); }
    if (plies === 18) { clickEl($('#imp-toggle')); await sleep(60); }
  }
  const gFinal = UI.game;
  check('партия сыграна до конца', !!(gFinal && gFinal.over), 'plies=' + plies + ' winner=' + (gFinal && gFinal.state.winner));
  await sleep(900); // finishGame с задержкой
  check('модалка результата показана', $('#result-modal') && !$('#result-modal').hidden,
    $('#result-modal') ? 'hidden=' + $('#result-modal').hidden : 'нет модалки');
  const rtext = ($('#result-text') || {}).textContent || ($('#result-modal') || {}).textContent || '';
  check('итог в модалке непустой', rtext.trim().length > 0, rtext.slice(0, 60));
  shot('04-result', '#game-canvas');
  check('прогресс: статистика партий сохранилась', (UI.progress.stats.games || 0) >= 1, 'games=' + UI.progress.stats.games);

  /* ── итог ── */
  const uniq = [...new Set(pageErrors)];
  check('нет ошибок консоли за весь прогон', uniq.length === 0, uniq.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? '❌ FAIL: ' + fails : '✅ ALL PASS'));
  try { dom.window.close(); } catch (e) { }
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
