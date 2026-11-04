/* ============================================================
   РЕЗОНАНС — canvas-рендерер: поле, юниты, эффекты, анимации
   ============================================================ */
(function (root) {
  'use strict';
  const E = root.Engine;

  const COLORS = {
    bg: '#070b14',
    cell: '#0e1730', cellLine: '#18264a',
    wall: '#1b2440', wallHi: '#2b3a66',
    empty: '#0c1428',
    cyan: '#35f0d0', pink: '#ff4d9d', gold: '#fbbf24',
    green: '#4ade80', red: '#ff5d5d', violet: '#a78bfa'
  };
  const OWNER = [COLORS.cyan, COLORS.pink];

  const settings = { speed: 1, shake: true, hints: true };

  let canvas, ctx, W = 0, H = 0, dpr = 1;
  let state = null;            // модель (Engine)
  let myOwner = 0;
  let sel = null;              // выбранный юнит id
  let hoverCell = -1;
  let legal = [];              // легальные действия для подсветки
  let impMode = false;
  let visPos = new Map();      // id -> {x,y} в клеточных координатах
  let particles = [];
  let floats = [];
  let shake = 0;
  let flash = 0, flashColor = '#fff';
  let animating = false;
  let onPick = null;           // callback(cell)
  let raf = 0;
  let lastT = 0;
  let time = 0;
  let cellPx = 40, ox = 0, oy = 0, boardPx = 0;
  let previewShove = null;     // {from,to} для предпросмотра
  let deadMark = new Map();    // id -> время смерти (для вспышки)

  /* ───────── публичное API ───────── */
  function init(cv, opts) {
    canvas = cv;
    ctx = cv.getContext('2d');
    onPick = opts && opts.onPick;
    resize();
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', () => { hoverCell = -1; previewShove = null; });
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function resize() {
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const pad = 24;
    const side = Math.max(240, Math.min(cw - pad, ch - pad));
    canvas.style.width = side + 'px';
    canvas.style.height = side + 'px';
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);
    W = side; H = side;
    layout();
  }

  function layout() {
    if (!state) { cellPx = W / 7; ox = oy = 0; boardPx = W; return; }
    const n = state.size;
    boardPx = Math.min(W, H);
    cellPx = boardPx / n;
    ox = (W - boardPx) / 2;
    oy = (H - boardPx) / 2;
  }

  function setState(s) {
    state = s;
    layout();
    // подцепить новые визуальные позиции
    for (const u of s.units) {
      if (!visPos.has(u.id)) visPos.set(u.id, cellCenter(u.cell));
    }
    // удалить визуал исчезнувших (частицы уже вспыхнут отдельно)
    const alive = new Set(s.units.map(u => u.id));
    for (const id of visPos.keys()) if (!alive.has(id)) visPos.delete(id);
    refreshLegal();
  }

  function setMyOwner(o) { myOwner = o; }
  function setSel(id) { sel = id; refreshLegal(); }
  function getSel() { return sel; }
  function setImp(v) { impMode = v; }
  function getImp() { return impMode; }
  function setLegal(list) { legal = list || []; }

  function refreshLegal() {
    if (!state || state.winner !== null) { legal = []; return; }
    const canAct = state.turn === myOwner && !animating;
    legal = canAct ? E.legalActions(state) : [];
  }

  function setAnimating(v) { animating = v; if (!v) refreshLegal(); }
  function isAnimating() { return animating; }

  /* ───────── геометрия ───────── */
  function cellCenter(cell) {
    const n = state ? state.size : 7;
    const x = cell % n, y = (cell / n) | 0;
    return { x: x + 0.5, y: y + 0.5 };
  }
  function cellRect(cell) {
    const n = state.size;
    const x = cell % n, y = (cell / n) | 0;
    return { x: ox + x * cellPx, y: oy + y * cellPx, w: cellPx, h: cellPx };
  }
  function pointToCell(px, py) {
    if (!state) return -1;
    const lx = px - ox, ly = py - oy;
    if (lx < 0 || ly < 0 || lx >= boardPx || ly >= boardPx) return -1;
    const x = Math.floor(lx / cellPx), y = Math.floor(ly / cellPx);
    if (x < 0 || y < 0 || x >= state.size || y >= state.size) return -1;
    return y * state.size + x;
  }
  function cellXY(cell) { // левый верхний угол клетки в px
    const n = state.size;
    return { x: ox + (cell % n) * cellPx, y: oy + ((cell / n) | 0) * cellPx };
  }

  /* ───────── ввод ───────── */
  function evPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onDown(e) {
    if (animating || !state || state.winner !== null) return;
    const p = evPos(e);
    const c = pointToCell(p.x, p.y);
    if (c >= 0 && onPick) onPick(c);
  }
  function onMove(e) {
    const p = evPos(e);
    hoverCell = pointToCell(p.x, p.y);
    // предпросмотр толчка
    previewShove = null;
    if (sel != null && hoverCell >= 0 && state && legal.length) {
      for (const a of legal) {
        if (a.k === 's' && a.id === sel) {
          const tgt = E.getUnit(state, a.tgt);
          if (tgt && tgt.cell === hoverCell && !a.imp) {
            const pusher = E.getUnit(state, sel);
            const d = a.d;
            const to = hoverCell + E.delta(d, state.size);
            previewShove = { from: hoverCell, to, d };
          }
        }
      }
    }
  }

  /* ───────── эффекты ───────── */
  function burst(cellOrXY, color, n, power) {
    const p = typeof cellOrXY === 'number' ? cellCenter(cellOrXY) : cellOrXY;
    const cx = ox + p.x * cellPx, cy = oy + p.y * cellPx;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (1 + Math.random() * 2.4) * (power || 1) * cellPx * 0.9;
      particles.push({
        x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 1.6 + Math.random() * 1.6,
        color, size: (2 + Math.random() * 4) * (cellPx / 46)
      });
    }
  }
  function addFloat(text, cell, color) {
    const p = cellCenter(cell);
    floats.push({ text, x: ox + p.x * cellPx, y: oy + p.y * cellPx, life: 1, color: color || COLORS.gold });
  }
  function doShake(mag) { if (settings.shake) shake = Math.min(18, shake + mag); }
  function doFlash(color, a) { flash = Math.max(flash, a || 0.25); flashColor = color || '#fff'; }

  function banner(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 1100);
  }

  /* воспроизведение событий движка (позиции и так обновятся из модели) */
  function playEvents(events, done) {
    if (!events || !events.length) { if (done) done(); return; }
    let delay = 0;
    const sounds = root.Snd ? root.Snd.sfx : null;
    const hasFlowActivity = events.some(e => (e.t === 'move' && e.flow) || (e.t === 'kill' && e.cause === 'flow'));
    let moveSoundPlayed = false;
    for (const ev of events) {
      switch (ev.t) {
        case 'move': {
          const dur = ev.shoved ? 90 : ev.flow ? 120 : 80;
          delay = Math.max(delay, dur);
          if (sounds && !ev.flow && !ev.shoved && !moveSoundPlayed) {
            moveSoundPlayed = true;
            setTimeout(() => sounds.move(), delay * 0.3 | 0);
          }
          break;
        }
        case 'shove': if (sounds) setTimeout(() => sounds.shove(), delay * 0.4 | 0); delay += 60; break;
        case 'impetus': if (sounds) setTimeout(() => sounds.impetus(), delay * 0.4 | 0); delay += 80; break;
        case 'kill': {
          const u = OWNER[ev.owner];
          setTimeout(() => {
            burst(ev.cell, u, 26, 1.4);
            burst(ev.cell, '#ffffff', 10, 1.8);
            addFloat(ev.cause === 'grind' ? 'СШИФОВАН' : '×', ev.cell, u);
            doShake(ev.cause === 'grind' ? 9 : 6);
            if (sounds) (ev.cause === 'grind' ? sounds.grind() : sounds.kill());
          }, delay);
          delay += 130;
          break;
        }
        case 'boom': {
          setTimeout(() => {
            burst(ev.cell, COLORS.gold, 34, 2.2);
            burst(ev.cell, '#ff8c42', 20, 1.6);
            addFloat('ВЗРЫВ', ev.cell, COLORS.gold);
            doShake(13); doFlash('#ffbb66', 0.3);
            if (sounds) sounds.boom();
          }, delay);
          delay += 160;
          break;
        }
        case 'charge': {
          setTimeout(() => {
            const core = state ? E.coreOf(state, ev.owner) : null;
            addFloat('+1 ЗАРЯД', core ? core.cell : 0, COLORS.gold);
            if (sounds) sounds.charge();
          }, delay);
          delay += 40;
          break;
        }
        case 'flowStart': {
          if (hasFlowActivity) {
            setTimeout(() => {
              banner('flow-banner');
              doFlash('#35f0d022', 0.12);
              if (sounds) sounds.flow();
            }, delay);
            delay += 110;
          }
          break;
        }
        case 'shrink': {
          setTimeout(() => {
            banner('shrink-banner');
            doShake(14); doFlash('#fbbf2433', 0.3);
            if (sounds) sounds.shrink();
            for (const c of ev.walls.slice(0, 40)) burst(c, '#8899bb', 4, 0.7);
          }, delay);
          delay += 260;
          break;
        }
        case 'over': case 'finish': break;
      }
    }
    // разблокировка после завершения
    setTimeout(() => { if (done) done(); }, delay + 60);
  }

  /* ───────── подсветки ───────── */
  function legalFor(id) {
    return legal.filter(a => a.id === id);
  }

  function drawHighlights() {
    if (!state || state.winner !== null) return;
    const myTurn = state.turn === myOwner;
    if (!myTurn || animating) return;

    if (sel != null) {
      const list = legalFor(sel);
      for (const a of list) {
        if (a.k === 'm') {
          const r = cellRect(a.to);
          const g = settings.hints ? 0.16 : 0.08;
          ctx.fillStyle = `rgba(74,222,128,${g})`;
          roundRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6, 8); ctx.fill();
          ctx.strokeStyle = `rgba(74,222,128,${settings.hints ? 0.75 : 0.4})`;
          ctx.lineWidth = 2;
          roundRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6, 8); ctx.stroke();
          // центральная точка
          ctx.fillStyle = '#4ade80';
          ctx.beginPath();
          ctx.arc(r.x + r.w / 2, r.y + r.h / 2, Math.max(3, cellPx * 0.07), 0, 7);
          ctx.fill();
        } else if (a.k === 's') {
          const tgt = E.getUnit(state, a.tgt);
          if (!tgt) continue;
          const hasNormal = list.some(x => x.k === 's' && !x.imp && E.getUnit(state, x.tgt) && E.getUnit(state, x.tgt).cell === tgt.cell);
          if (a.imp) {
            // в импульс-режиме — всегда; иначе — только для тяжёлых (нет обычного толчка)
            if (!impMode && hasNormal) continue;
            if (!impMode && state.charge[myOwner] <= 0) continue;
          } else {
            if (impMode && state.charge[myOwner] > 0) continue;
          }
          const r = cellRect(tgt.cell);
          const col = a.imp ? COLORS.gold : COLORS.red;
          ctx.strokeStyle = col;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 5]);
          roundRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8, 8); ctx.stroke();
          ctx.setLineDash([]);
          // стрелка направления
          const pusher = E.getUnit(state, a.id);
          if (pusher) drawArrowBetween(pusher.cell, tgt.cell, col, a.imp ? 2 : 1);
        }
      }
    } else if (settings.hints) {
      // лёгкая подсветка своих юнитов
      for (const u of state.units) {
        if (u.owner !== myOwner) continue;
        const p = visPos.get(u.id);
        if (!p) continue;
        ctx.strokeStyle = 'rgba(53,240,208,0.22)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ox + p.x * cellPx, oy + p.y * cellPx, cellPx * 0.36, 0, 7);
        ctx.stroke();
      }
    }
  }

  function drawArrowBetween(c1, c2, color, thick) {
    const a = cellCenter(c1), b = cellCenter(c2);
    const x1 = ox + a.x * cellPx, y1 = oy + a.y * cellPx;
    const x2 = ox + b.x * cellPx, y2 = oy + b.y * cellPx;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.translate(mx, my); ctx.rotate(ang);
    ctx.fillStyle = color;
    const s = cellPx * 0.16;
    ctx.beginPath();
    ctx.moveTo(s, 0); ctx.lineTo(-s * 0.7, -s * 0.9); ctx.lineTo(-s * 0.7, s * 0.9);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ───────── отрисовка поля ───────── */
  function drawBoard() {
    const n = state.size;
    // подложка поля
    ctx.fillStyle = '#0a1120';
    roundRect(ox - 8, oy - 8, boardPx + 16, boardPx + 16, 14); ctx.fill();
    ctx.strokeStyle = '#1e2f52'; ctx.lineWidth = 2;
    roundRect(ox - 8, oy - 8, boardPx + 16, boardPx + 16, 14); ctx.stroke();

    for (let i = 0; i < n * n; i++) {
      const t = state.terrain[i];
      const { x, y } = cellXY(i);
      const pad = 1.5;
      if (t === E.WALL) {
        ctx.fillStyle = COLORS.wall;
        roundRect(x + pad, y + pad, cellPx - pad * 2, cellPx - pad * 2, 6); ctx.fill();
        ctx.fillStyle = COLORS.wallHi;
        roundRect(x + pad, y + pad, cellPx - pad * 2, cellPx * 0.34, 6); ctx.fill();
        // заклёпки
        ctx.fillStyle = '#3a4d80';
        const r = Math.max(1.5, cellPx * 0.035);
        ctx.beginPath(); ctx.arc(x + cellPx * 0.28, y + cellPx * 0.62, r, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(x + cellPx * 0.72, y + cellPx * 0.62, r, 0, 7); ctx.fill();
      } else if (t === E.ANCHOR) {
        ctx.fillStyle = '#101c38';
        roundRect(x + pad, y + pad, cellPx - pad * 2, cellPx - pad * 2, 6); ctx.fill();
        drawAnchor(x + cellPx / 2, y + cellPx / 2);
      } else if (E.isArrow(t)) {
        ctx.fillStyle = '#0d1a36';
        roundRect(x + pad, y + pad, cellPx - pad * 2, cellPx - pad * 2, 6); ctx.fill();
        drawFlowArrow(x, y, E.arrowDir(t));
      } else {
        ctx.fillStyle = i === hoverCell ? '#132044' : COLORS.empty;
        roundRect(x + pad, y + pad, cellPx - pad * 2, cellPx - pad * 2, 5); ctx.fill();
        if (i === hoverCell) {
          ctx.strokeStyle = '#2b4372'; ctx.lineWidth = 1.5;
          roundRect(x + pad, y + pad, cellPx - pad * 2, cellPx - pad * 2, 5); ctx.stroke();
        }
      }
      // рамка клетки (тонкая сетка)
      ctx.strokeStyle = 'rgba(30,47,82,0.5)';
      ctx.lineWidth = 1;
      roundRect(x + 0.5, y + 0.5, cellPx - 1, cellPx - 1, 5); ctx.stroke();
    }

    // зона сжатия: следующее кольцо мерцает золотом
    if (state.cfg && state.cfg.startShrink) {
      const startA = state.cfg.startShrink * 2 - 1;
      const everyA = state.cfg.shrinkEvery * 2 - 1;
      const ac = state.actCount || 0;
      if (ac >= startA - 14) {
        const ringIdx = 1 + Math.max(0, Math.floor((ac - startA) / everyA));
        const near = ac >= startA ? ringIdx : ringIdx; // текущее/следующее
        const alpha = ac >= startA ? 0.4 + 0.25 * Math.sin(time * 8) : 0.14 + 0.08 * Math.sin(time * 4);
        ctx.strokeStyle = `rgba(251,191,36,${alpha})`;
        ctx.lineWidth = ac >= startA ? 3 : 2;
        for (let i = 0; i < n * n; i++) {
          const cx = i % n, cy = (i / n) | 0;
          const r = Math.min(cx, cy, n - 1 - cx, n - 1 - cy);
          if (r !== near) continue;
          if (state.terrain[i] === E.WALL && ac < startA) continue;
          const { x, y } = cellXY(i);
          roundRect(x + 2, y + 2, cellPx - 4, cellPx - 4, 6); ctx.stroke();
        }
      }
    }
  }

  function drawFlowArrow(x, y, d) {
    const cx = x + cellPx / 2, cy = y + cellPx / 2;
    const ang = [0, Math.PI, -Math.PI / 2, Math.PI / 2][d];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    const s = cellPx * 0.5;
    // бегущие шевроны
    const phase = (time * 1.6) % 1;
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = Math.max(2, cellPx * 0.07);
    ctx.lineCap = 'round';
    for (let k = 0; k < 2; k++) {
      const off = ((phase + k * 0.5) % 1) * s * 0.9 - s * 0.45;
      ctx.globalAlpha = 0.45 + 0.5 * Math.sin(((phase + k * 0.5) % 1) * Math.PI);
      ctx.beginPath();
      ctx.moveTo(off - s * 0.22, -s * 0.3);
      ctx.lineTo(off + s * 0.1, 0);
      ctx.lineTo(off - s * 0.22, s * 0.3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawAnchor(cx, cy) {
    const r = cellPx * 0.26;
    const pulse = 1 + 0.07 * Math.sin(time * 3.4);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = Math.max(2, cellPx * 0.055);
    ctx.beginPath(); ctx.arc(cx, cy, r * pulse, 0, 7); ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.34, 0, 7); ctx.fill();
    // точки по осям
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + time * 0.8;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r * 1.5, Math.max(1.5, cellPx * 0.04), 0, 7);
      ctx.fill();
    }
  }

  /* ───────── юниты ───────── */
  function drawUnits() {
    // тени/ордена под выбранным
    if (sel != null) {
      const p = visPos.get(sel);
      if (p) {
        const cx = ox + p.x * cellPx, cy = oy + p.y * cellPx;
        ctx.strokeStyle = COLORS.gold;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(cx, cy, cellPx * 0.44, time * 2, time * 2 + Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    for (const u of state.units) {
      const p = visPos.get(u.id);
      if (!p) continue;
      const cx = ox + p.x * cellPx, cy = oy + p.y * cellPx;
      drawUnit(u, cx, cy);
    }
  }

  function drawUnit(u, cx, cy) {
    const col = OWNER[u.owner];
    const R = cellPx * 0.34;
    const isMine = u.owner === myOwner;
    // свечение
    const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2);
    glow.addColorStop(0, hexA(col, isMine ? 0.34 : 0.26));
    glow.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, R * 2, 0, 7); ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);

    if (u.type === 'core') {
      // вращающаяся дуга + шестигранник
      const rot = time * (u.owner === 0 ? 1.1 : -1.1);
      ctx.strokeStyle = hexA(col, 0.95);
      ctx.lineWidth = Math.max(2.5, cellPx * 0.075);
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = rot + k * Math.PI / 3 - Math.PI / 6;
        const x = Math.cos(a) * R, y = Math.sin(a) * R;
        k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // ядро
      const g = ctx.createRadialGradient(0, -R * 0.2, 1, 0, 0, R * 0.75);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, col);
      g.addColorStop(1, hexA(col, 0.25));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.56, 0, 7); ctx.fill();
      // пульс
      const pu = (time * 1.4) % 1;
      ctx.strokeStyle = hexA(col, 0.5 * (1 - pu));
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, R * (0.6 + pu * 0.7), 0, 7); ctx.stroke();
    } else if (u.type === 'heavy') {
      ctx.rotate(Math.PI / 8);
      ctx.fillStyle = '#0f1a33';
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(2.5, cellPx * 0.08);
      octPath(R); ctx.fill(); ctx.stroke();
      ctx.rotate(-Math.PI / 8);
      // броневые линии
      ctx.strokeStyle = hexA(col, 0.85);
      ctx.lineWidth = Math.max(1.6, cellPx * 0.05);
      ctx.beginPath(); ctx.moveTo(-R * 0.5, -R * 0.18); ctx.lineTo(R * 0.5, -R * 0.18); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-R * 0.5, R * 0.18); ctx.lineTo(R * 0.5, R * 0.18); ctx.stroke();
      ctx.fillStyle = hexA(col, 0.95);
      ctx.beginPath(); ctx.arc(0, 0, R * 0.2, 0, 7); ctx.fill();
    } else if (u.type === 'spark') {
      const jit = Math.sin(time * 22 + u.id) * 0.05;
      ctx.rotate(jit);
      ctx.fillStyle = '#241305';
      ctx.strokeStyle = '#ffbb55';
      ctx.lineWidth = Math.max(2.5, cellPx * 0.075);
      ctx.beginPath();
      ctx.moveTo(0, -R * 1.05);
      ctx.lineTo(R * 0.95, R * 0.7);
      ctx.lineTo(-R * 0.95, R * 0.7);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffe28a';
      ctx.beginPath(); ctx.arc(0, R * 0.08, R * 0.3, 0, 7); ctx.fill();
      // искры
      if (Math.random() < 0.2) {
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.arc((Math.random() - 0.5) * R * 2, (Math.random() - 0.5) * R * 2, R * 0.1, 0, 7);
        ctx.fill();
      }
    } else { // node
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#0f1a33';
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(2.5, cellPx * 0.075);
      rrPath(-R * 0.78, -R * 0.78, R * 1.56, R * 1.56, R * 0.3);
      ctx.fill(); ctx.stroke();
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.3, 0, 7); ctx.fill();
      // блик
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.beginPath(); ctx.arc(-R * 0.1, -R * 0.1, R * 0.12, 0, 7); ctx.fill();
    }
    ctx.restore();

    // индикатор «мой ход» — подсветка для своих
    if (isMine && state.turn === myOwner && !animating) {
      ctx.strokeStyle = hexA(col, 0.5 + 0.3 * Math.sin(time * 4));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.36, 0, 7); ctx.stroke();
    }
  }

  function octPath(R) {
    ctx.beginPath();
    for (let k = 0; k <= 8; k++) {
      const a = k * Math.PI / 4 + Math.PI / 8;
      const x = Math.cos(a) * R, y = Math.sin(a) * R;
      k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  }
  function rrPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* предпросмотр толчка */
  function drawShovePreview() {
    if (!previewShove || !state) return;
    const { from, to, d } = previewShove;
    const a = cellCenter(from), b = cellCenter(to);
    const x1 = ox + a.x * cellPx, y1 = oy + a.y * cellPx;
    const x2 = ox + b.x * cellPx, y2 = oy + b.y * cellPx;
    const x3 = x2 + Math.cos([0, Math.PI, -Math.PI / 2, Math.PI / 2][d]) * cellPx;
    const y3 = y2 + Math.sin([0, Math.PI, -Math.PI / 2, Math.PI / 2][d]) * cellPx;
    ctx.strokeStyle = impMode ? COLORS.gold : COLORS.red;
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -time * 40;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.stroke();
    ctx.setLineDash([]);
  }

  /* ───────── частицы/текст ───────── */
  function drawFx(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt * p.decay;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.life -= dt * 0.9;
      if (f.life <= 0) { floats.splice(i, 1); continue; }
      f.y -= dt * 34;
      ctx.globalAlpha = Math.min(1, f.life * 1.6);
      ctx.font = `700 ${Math.max(12, cellPx * 0.3)}px Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = f.color;
      ctx.shadowColor = f.color; ctx.shadowBlur = 8;
      ctx.fillText(f.text, f.x, f.y);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  /* ───────── главный цикл ───────── */
  function loop(t) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    time += dt;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!state) return;

    // тряска
    let sx = 0, sy = 0;
    if (shake > 0.3) {
      sx = (Math.random() - 0.5) * shake;
      sy = (Math.random() - 0.5) * shake;
      shake *= Math.pow(0.0018, dt);
    } else shake = 0;
    ctx.save();
    ctx.translate(sx, sy);

    // интерполяция визуальных позиций
    const k = 1 - Math.pow(0.0001, dt * settings.speed);
    for (const u of state.units) {
      let p = visPos.get(u.id);
      const tgt = cellCenter(u.cell);
      if (!p) { visPos.set(u.id, { x: tgt.x, y: tgt.y }); continue; }
      p.x += (tgt.x - p.x) * k;
      p.y += (tgt.y - p.y) * k;
      if (Math.abs(tgt.x - p.x) < 0.002) p.x = tgt.x;
      if (Math.abs(tgt.y - p.y) < 0.002) p.y = tgt.y;
    }

    drawBoard();
    drawHighlights();
    drawShovePreview();
    drawUnits();
    drawFx(dt);

    // вспышка
    if (flash > 0.01) {
      ctx.globalAlpha = flash;
      ctx.fillStyle = flashColor;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      flash *= Math.pow(0.002, dt);
    } else flash = 0;

    ctx.restore();
  }

  /* ───────── утилиты стилей ───────── */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  /* ═══════════ ФОН ГЛАВНОГО МЕНЮ ═══════════ */
  const MenuBG = (function () {
    let bgCanvas, bgCtx, bgRaf = 0, parts = [], bw = 0, bh = 0, running = false;
    function start(cv) {
      bgCanvas = cv; bgCtx = cv.getContext('2d');
      running = true;
      resizeBg();
      window.addEventListener('resize', resizeBg);
      if (!bgRaf) bgRaf = requestAnimationFrame(bgLoop);
    }
    function stop() { running = false; }
    function resizeBg() {
      if (!bgCanvas) return;
      const d = Math.min(2, window.devicePixelRatio || 1);
      bw = window.innerWidth; bh = window.innerHeight;
      bgCanvas.width = bw * d; bgCanvas.height = bh * d;
      bgCanvas.style.width = bw + 'px'; bgCanvas.style.height = bh + 'px';
      bgCtx.setTransform(d, 0, 0, d, 0, 0);
      parts = [];
      const n = Math.min(90, (bw * bh) / 16000);
      for (let i = 0; i < n; i++) parts.push(newPart(true));
    }
    function newPart(rand) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const d = dirs[(Math.random() * 4) | 0];
      return {
        x: rand ? Math.random() * bw : (d[0] > 0 ? -20 : d[0] < 0 ? bw + 20 : Math.random() * bw),
        y: rand ? Math.random() * bh : (d[1] > 0 ? -20 : d[1] < 0 ? bh + 20 : Math.random() * bh),
        vx: d[0] * (30 + Math.random() * 70), vy: d[1] * (30 + Math.random() * 70),
        len: 40 + Math.random() * 130,
        hue: Math.random() < 0.7 ? '53,240,208' : '255,77,157',
        a: 0.06 + Math.random() * 0.16
      };
    }
    let last = 0;
    function bgLoop(t) {
      bgRaf = requestAnimationFrame(bgLoop);
      if (!running || !bgCtx) return;
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
      bgCtx.clearRect(0, 0, bw, bh);
      // сетка
      bgCtx.strokeStyle = 'rgba(30,47,82,0.35)';
      bgCtx.lineWidth = 1;
      const gs = 54;
      bgCtx.beginPath();
      for (let x = 0; x <= bw; x += gs) { bgCtx.moveTo(x + .5, 0); bgCtx.lineTo(x + .5, bh); }
      for (let y = 0; y <= bh; y += gs) { bgCtx.moveTo(0, y + .5); bgCtx.lineTo(bw, y + .5); }
      bgCtx.stroke();
      // бегущие импульсы
      for (const p of parts) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < -160 || p.x > bw + 160 || p.y < -160 || p.y > bh + 160) Object.assign(p, newPart(false));
        const nl = Math.hypot(p.vx, p.vy);
        const nx = p.x - (p.vx / nl) * p.len, ny = p.y - (p.vy / nl) * p.len;
        const g = bgCtx.createLinearGradient(p.x, p.y, nx, ny);
        g.addColorStop(0, `rgba(${p.hue},${p.a})`);
        g.addColorStop(1, `rgba(${p.hue},0)`);
        bgCtx.strokeStyle = g;
        bgCtx.lineWidth = 2;
        bgCtx.beginPath(); bgCtx.moveTo(p.x, p.y); bgCtx.lineTo(nx, ny); bgCtx.stroke();
      }
      // виньетка
      const vg = bgCtx.createRadialGradient(bw / 2, bh / 2, bh * 0.2, bw / 2, bh / 2, bh * 0.95);
      vg.addColorStop(0, 'rgba(7,11,20,0)');
      vg.addColorStop(1, 'rgba(7,11,20,0.85)');
      bgCtx.fillStyle = vg;
      bgCtx.fillRect(0, 0, bw, bh);
    }
    return { start, stop };
  })();

  root.GameView = {
    init, setState, setMyOwner, setSel, getSel, setImp, getImp, setLegal,
    refreshLegal, setAnimating, isAnimating, playEvents, addFloat, burst,
    doShake, doFlash, banner, resize, get state() { return state; },
    setSettings(s) { Object.assign(settings, s); },
    get settings() { return settings; },
    colors: COLORS, ownerColor: (o) => OWNER[o]
  };
  root.MenuBG = MenuBG;
})(typeof self !== 'undefined' ? self : this);
