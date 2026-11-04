/* ============================================================
   РЕЗОНАНС — интерфейс: экраны, режимы, контроллер партии
   ============================================================ */
(function (root) {
  'use strict';
  const E = root.Engine, AI = root.AI, C = root.Content, GV = root.GameView, Snd = root.Snd;

  /* ═════════ хранение ═════════ */
  const DEF_SETTINGS = { sfx: 80, music: 50, soundOn: true, speed: 100, shake: true, hints: true };
  const DEF_PROGRESS = {
    nick: '', campaign: {}, ladder: {}, arcadeWins: {}, ach: {},
    stats: { games: 0, wins: 0, impUsed: 0, chargeEarned: 0, onlineGames: 0, onlineWins: 0, streak: 0, bestStreak: 0 },
    elo: 1200, bestElo: 1200, w: 0, l: 0, d: 0
  };
  function load(key, def) {
    try {
      const raw = localStorage.getItem('resonance_' + key);
      if (!raw) return JSON.parse(JSON.stringify(def));
      return Object.assign(JSON.parse(JSON.stringify(def)), JSON.parse(raw));
    } catch (e) { return JSON.parse(JSON.stringify(def)); }
  }
  function save(key, obj) {
    try { localStorage.setItem('resonance_' + key, JSON.stringify(obj)); } catch (e) { }
  }
  let settings = load('settings', DEF_SETTINGS);
  let progress = load('progress', DEF_PROGRESS);
  if (!progress.nick) progress.nick = 'Оператор-' + (1000 + Math.floor(Math.random() * 9000));

  /* ═════════ утилиты ═════════ */
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function toast(msg, kind) {
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    $('toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2600);
  }
  function sfx(name) { if (settings.soundOn && Snd.sfx[name]) Snd.sfx[name](); }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  /* ═════════ навигация ═════════ */
  const screens = ['menu', 'campaign', 'duel', 'online', 'arcade', 'game', 'codex', 'achieve', 'settings'];
  let current = 'menu';
  function show(name) {
    if (screens.indexOf(name) < 0) return;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $('scr-' + name).classList.add('active');
    current = name;
    sfx('click');
    if (name === 'menu') { root.MenuBG.start($('menu-bg')); Snd.music('menu'); root.MenuBG.start; }
    else root.MenuBG.stop();
    if (name === 'campaign') renderCampaign();
    if (name === 'duel') renderDuel();
    if (name === 'arcade') renderArcade();
    if (name === 'achieve') renderAchievements();
    if (name === 'settings') renderSettings();
    if (name === 'codex') renderCodex();
    if (name === 'online') { enterOnline(); }
    if (name !== 'game') { Snd.music(name === 'menu' ? 'menu' : 'campaign'); }
    if (name === 'menu') updateMenuProfile();
  }

  /* ═════════ профиль ═════════ */
  function updateMenuProfile() {
    $('pc-name').textContent = progress.nick;
    $('pc-elo').textContent = progress.elo;
    const r = C.rankOf(progress.elo);
    $('pc-rank').textContent = r.name;
    $('pc-rank').style.color = r.color;
    const done = Object.keys(progress.ach).filter(k => progress.ach[k]).length;
    $('ach-counter').textContent = done + ' / ' + C.ACHIEVEMENTS.length;
  }

  function unlock(id) {
    if (progress.ach[id]) return;
    const a = C.ACHIEVEMENTS.find(x => x.id === id);
    if (!a) return;
    progress.ach[id] = true;
    save('progress', progress);
    toast('★ Достижение: ' + a.name, 'good');
    sfx('star');
  }
  function countAch() { return Object.keys(progress.ach).filter(k => progress.ach[k]).length; }

  /* ═════════ кампания ═════════ */
  let curSector = 0;
  let pendingMission = null;

  function starsTotal() {
    let n = 0;
    for (const m of C.CAMPAIGN) { const rec = progress.campaign[m.id]; if (rec) n += rec.stars || 0; }
    return n;
  }
  function missionUnlocked(idx) {
    if (idx === 0) return true;
    const prev = C.CAMPAIGN[idx - 1];
    const rec = progress.campaign[prev.id];
    return !!(rec && rec.done);
  }

  function renderCampaign() {
    $('camp-stars').textContent = '★ ' + starsTotal() + ' / ' + (C.CAMPAIGN.length * 3);
    const tabs = $('sector-tabs'); tabs.innerHTML = '';
    C.SECTORS.forEach((s, i) => {
      const b = el('button', 'stab' + (i === curSector ? ' active' : ''), (i + 1) + ' · ' + s.name);
      b.onclick = () => { curSector = i; renderCampaign(); sfx('click'); };
      tabs.appendChild(b);
    });
    const grid = $('camp-grid'); grid.innerHTML = '';
    C.CAMPAIGN.forEach((m, idx) => {
      if (m.sector !== curSector) return;
      const unlocked = missionUnlocked(idx);
      const rec = progress.campaign[m.id] || { stars: 0, done: false };
      const card = el('button', 'mcard' + (unlocked ? '' : ' locked') + (m.boss ? ' boss' : ''));
      const st = [1, 2, 3].map(i => `<span class="${i <= rec.stars ? 'on' : ''}">★</span>`).join('');
      card.innerHTML = `
        <div class="mc-num">МИССИЯ ${String(m.id).padStart(2, '0')}</div>
        <div class="mc-name">${m.name}</div>
        <div class="mc-stars">${st}</div>
        ${m.boss ? '<div class="mc-boss">☠</div>' : rec.done ? '<div class="mc-done">✓</div>' : ''}`;
      card.onclick = () => openBrief(m, idx);
      grid.appendChild(card);
    });
    $('sector-lore').textContent = C.SECTORS[curSector].lore;
  }

  function openBrief(m, idx) {
    pendingMission = { m, idx };
    $('brief-sector').textContent = 'СЕКТОР ' + ['I', 'II', 'III', 'IV'][m.sector] + ' · МИССИЯ ' + String(m.id).padStart(2, '0');
    $('brief-name').textContent = m.name;
    $('brief-name').style.color = m.boss ? 'var(--pink)' : 'var(--text)';
    $('brief-text').textContent = m.brief;
    const rec = progress.campaign[m.id];
    $('brief-stars').textContent = rec && rec.stars ? 'Ваши звёзды: ' + '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : 'Звёзды не получены';
    $('brief-tips').innerHTML = (m.tips || []).map(t => `<div>${t}</div>`).join('') +
      (m.tutorial ? m.tutorial.map(t => `<div>▸ ${t}</div>`).join('') : '');
    $('brief-meta').textContent = `поле ${m.size}×${m.size} · враг: ${m.enemy.level.toUpperCase()}${m.boss ? ' · БОСС' : ''} · цель: ${m.stars.moves} раундов на2★`;
    $('brief-modal').hidden = false;
    sfx('select');
  }
  $('brief-close').onclick = () => { $('brief-modal').hidden = true; sfx('click'); };
  $('brief-start').onclick = () => {
    if (!pendingMission) return;
    $('brief-modal').hidden = true;
    startCampaignMission(pendingMission.m);
  };

  function buildMissionState(m) {
    return E.createGame({
      size: m.size,
      terrain: C.parseTerrain(m.t0),
      spawns: [C.units(m.p0, m.size), C.units(m.p1, m.size)],
      seed: m.id,
      startShrink: m.startShrink || 36,
      shrinkEvery: m.shrinkEvery || 8,
      arrowChaos: m.arrowChaos || 0,
      mode: 'campaign'
    });
  }

  function startCampaignMission(m) {
    const state = buildMissionState(m);
    const botOpts = AI.levelOpts(m.enemy.level, m.enemy.style);
    startGame(state, {
      source: 'campaign', mySeat: 0, botOpts, mission: m,
      modeLabel: 'миссия ' + String(m.id).padStart(2, '0'),
      introTips: m.tutorial || m.tips || null
    });
  }

  /* ═════════ дуэль ═════════ */
  let duelCfg = { level: 'operator', style: 'balanced', map: 'classic' };
  const LEVEL_META = [
    { id: 'novice', ico: '◔', name: 'НОВИЧОК', desc: 'учится ходить ·600 узлов', nodes: 600 },
    { id: 'pilot', ico: '◑', name: 'ПИЛОТ', desc: 'видит на пару ходов ·4 тыс.', nodes: 4000 },
    { id: 'operator', ico: '◕', name: 'ОПЕРАТОР', desc: 'солидный расчёт ·14 тыс.', nodes: 14000 },
    { id: 'strategist', ico: '●', name: 'СТРАТЕГ', desc: 'глубоко и жёстко ·45 тыс.', nodes: 45000 },
    { id: 'oracle', ico: '◉', name: 'ОРАКУЛ', desc: 'почти безошибочный ·90 тыс.', nodes: 90000 }
  ];
  const STYLES = [
    { id: 'balanced', name: 'Стандарт' }, { id: 'aggressor', name: 'Агрессор' },
    { id: 'turtle', name: 'Черепаха' }, { id: 'belmaster', name: 'Потокомант' },
    { id: 'hoarder', name: 'Копилка' }, { id: 'berserk', name: 'Берсерк' }
  ];

  function renderDuel() {
    const lc = $('level-cards'); lc.innerHTML = '';
    LEVEL_META.forEach(L => {
      const b = el('button', 'lcard' + (duelCfg.level === L.id ? ' active' : ''));
      b.innerHTML = `<div class="lc-ico">${L.ico}</div>
        <div><div class="lc-name">${L.name}</div><div class="lc-desc">${L.desc}</div></div>
        <div class="lc-nodes">${fmt(L.nodes)}</div>`;
      b.onclick = () => { duelCfg.level = L.id; renderDuel(); sfx('click'); };
      lc.appendChild(b);
    });
    const mp = $('duel-maps'); mp.innerHTML = '';
    C.MAPS.forEach(m => {
      const b = el('button', 'mapchip' + (duelCfg.map === m.id ? ' active' : ''), m.name);
      b.onclick = () => { duelCfg.map = m.id; renderDuel(); sfx('click'); };
      mp.appendChild(b);
    });
    const rb = el('button', 'mapchip' + (duelCfg.map === 'chaos' ? ' active' : ''), 'СЛУЧАЙНАЯ');
    rb.onclick = () => { duelCfg.map = 'chaos'; renderDuel(); sfx('click'); };
    mp.appendChild(rb);

    const sp = $('style-pick'); sp.innerHTML = '';
    STYLES.forEach(s => {
      const b = el('button', 'schip' + (duelCfg.style === s.id ? ' active' : ''), s.name);
      b.onclick = () => { duelCfg.style = s.id; renderDuel(); sfx('click'); };
      sp.appendChild(b);
    });

    const lr = $('ladder-row'); lr.innerHTML = '';
    C.LADDER.forEach((bot, i) => {
      const beaten = !!progress.ladder[bot.id];
      const unlocked = i === 0 || !!progress.ladder[C.LADDER[i - 1].id];
      const b = el('button', 'bcard' + (beaten ? ' beaten' : ''));
      b.style.opacity = unlocked ? '' : '.4';
      b.innerHTML = `<div class="bc-name">${bot.name}</div>
        <div class="bc-title">${bot.title}</div>
        <div class="bc-lore">${unlocked ? bot.lore : '🔒 закрыт — победите предыдущего'}</div>
        <div class="bc-foot"><span class="bc-lvl">${bot.level.toUpperCase()}</span><span>${bot.rating}</span></div>`;
      if (unlocked) b.onclick = () => startLadderBot(bot);
      lr.appendChild(b);
    });
  }

  $('duel-start').onclick = () => {
    const map = duelCfg.map === 'chaos' ? null : C.MAPS.find(m => m.id === duelCfg.map);
    let terrain;
    if (map) terrain = C.parseTerrain(map.rows);
    else terrain = E.genChaosTerrain(7, E.mulberry32((Math.random() * 1e9) | 0), 0.16);
    const state = E.createGame({ size: 7, terrain, seed: (Math.random() * 1e9) | 0, mode: 'duel' });
    startGame(state, {
      source: 'duel', mySeat: 0,
      botOpts: AI.levelOpts(duelCfg.level, duelCfg.style),
      modeLabel: LEVEL_META.find(l => l.id === duelCfg.level).name.toLowerCase() + ' · ' + duelCfg.style
    });
    sfx('start');
  };

  function startLadderBot(bot) {
    const map = C.MAPS[(bot.name.length + bot.rating) % C.MAPS.length];
    const state = E.createGame({ size: 7, terrain: C.parseTerrain(map.rows), seed: bot.rating, mode: 'ladder' });
    startGame(state, {
      source: 'ladder', mySeat: 0,
      botOpts: AI.levelOpts(bot.level, bot.style),
      ladderBot: bot, modeLabel: 'лестница · ' + bot.name
    });
    toast('Протокол ' + bot.name + ': ' + bot.lore);
    sfx('start');
  }

  /* ═════════ аркада ═════════ */
  const ARCADE_BOT = { standard: 'strategist', rush: 'operator', chaos: 'strategist', survival: 'strategist', charged: 'operator', iron: 'strategist' };
  function renderArcade() {
    const g = $('arcade-grid'); g.innerHTML = '';
    C.ARCADE.forEach(a => {
      const b = el('button', 'acard');
      b.innerHTML = `<div class="ac-ico">${a.icon}</div>
        <div class="ac-name">${a.name}</div>
        <div class="ac-desc">${a.desc}</div>
        <div class="ac-go">ИГРАТЬ ▸ ${progress.arcadeWins[a.id] ? ' · побед: ✓' : ''}</div>`;
      b.onclick = () => startArcade(a);
      g.appendChild(b);
    });
  }

  function startArcade(a) {
    const cfg = a.cfg;
    let terrain = null, spawns = null;
    if (cfg.asymmetric === 'iron') {
      terrain = C.parseTerrain(C.MAPS[0].rows);
      spawns = [
        C.units([['core', 1, 5], ['node', 2, 5], ['node', 1, 4], ['node', 2, 4]], 7),
        C.units([['core', 5, 1], ['heavy', 4, 1], ['node', 5, 2], ['node', 4, 2]], 7)
      ];
    } else if (a.id === 'chaos') {
      terrain = E.genChaosTerrain(cfg.size, E.mulberry32((Math.random() * 1e9) | 0), 0.17);
    } else {
      const map = a.id === 'rush' ? C.MAPS.find(m => m.id === 'pillars') : C.MAPS[0];
      terrain = C.parseTerrain(map.rows.map(r => r.slice(0, cfg.size).padEnd(cfg.size, '#')).slice(0, cfg.size));
      // для5×5 быстрого боя — просто маленькое поле без внутренностей
      if (cfg.size === 5) terrain = E.defaultTerrain(5);
    }
    const state = E.createGame({
      size: cfg.size, terrain, spawns, seed: (Math.random() * 1e9) | 0,
      startShrink: cfg.startShrink, shrinkEvery: cfg.shrinkEvery,
      arrowChaos: cfg.arrowChaos || 0, charge: cfg.charge || [0, 0], mode: a.id
    });
    startGame(state, {
      source: 'arcade', mySeat: 0, arcadeId: a.id,
      botOpts: AI.levelOpts(ARCADE_BOT[a.id] || 'operator', 'balanced'),
      modeLabel: a.name.toLowerCase()
    });
    sfx('start');
  }

  /* ═════════ кодекс / достижения / настройки ═════════ */
  function renderCodex() {
    const r = $('codex-rules'); r.innerHTML = '';
    C.CODEX.rules.forEach(([k, v]) => r.appendChild(el('div', 'cx-item', `<b>${k}</b><span>${v}</span>`)));
    const u = $('codex-units'); u.innerHTML = '';
    const ico = { core: '⬡', node: '◇', heavy: '⬢', spark: '▲', anchor: '◎', flow: '➜' };
    C.CODEX.units.forEach(x => {
      u.appendChild(el('div', 'cu-card', `
        <div class="cu-head"><div class="cu-ico">${ico[x.type] || '◈'}</div><div class="cu-name">${x.name}</div></div>
        <div class="cu-desc">${x.desc}</div>`));
    });
    const l = $('codex-lore'); l.innerHTML = '';
    C.CODEX.lore.forEach(([k, v]) => l.appendChild(el('div', 'cl-card', `<div class="cl-name">${k}</div><div class="cl-text">${v}</div>`)));
  }
  document.querySelectorAll('#codex-tabs .otab').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#codex-tabs .otab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('[id^="ctab-"]').forEach(x => x.classList.remove('active'));
      $('ctab-' + b.dataset.ctab).classList.add('active');
      sfx('click');
    };
  });

  function renderAchievements() {
    $('ach-count').textContent = countAch() + ' / ' + C.ACHIEVEMENTS.length;
    const g = $('ach-grid'); g.innerHTML = '';
    C.ACHIEVEMENTS.forEach(a => {
      const done = !!progress.ach[a.id];
      g.appendChild(el('div', 'ach' + (done ? ' done' : ''), `
        <div class="ach-ico">${a.icon}</div>
        <div><div class="ach-name">${a.name}</div><div class="ach-desc">${a.desc}</div></div>`));
    });
  }

  function renderSettings() {
    $('set-sfx').value = settings.sfx; $('val-sfx').textContent = settings.sfx;
    $('set-music').value = settings.music; $('val-music').textContent = settings.music;
    $('set-sound-on').checked = settings.soundOn;
    $('set-speed').value = settings.speed; $('val-speed').textContent = settings.speed + '%';
    $('set-shake').checked = settings.shake;
    $('set-hints').checked = settings.hints;
    $('set-nick').value = progress.nick;
    const s = progress.stats;
    $('set-progress').innerHTML =
      `кампания: ★${starsTotal()} · миссий: ${Object.keys(progress.campaign).length}/36<br>` +
      `лестница: ${Object.keys(progress.ladder).length}/12 · аркада: ${Object.keys(progress.arcadeWins).length}/6<br>` +
      `партий: ${s.games} · побед: ${s.wins} · импульсов: ${s.impUsed} · зарядов: ${s.chargeEarned}<br>` +
      `онлайн: ${s.onlineGames} (побед ${s.onlineWins}) · лучшая серия: ${s.bestStreak}`;
  }
  function bindRange(inputId, valId, key, suffix, after) {
    $(inputId).addEventListener('input', () => {
      const v = +$(inputId).value;
      settings[key] = v;
      $(valId).textContent = v + (suffix || '');
      save('settings', settings);
      if (after) after(v);
    });
  }
  bindRange('set-sfx', 'val-sfx', 'sfx', '', applyAudio);
  bindRange('set-music', 'val-music', 'music', '', applyAudio);
  bindRange('set-speed', 'val-speed', 'speed', '%', applyView);
  $('set-sound-on').onchange = e => { settings.soundOn = e.target.checked; save('settings', settings); applyAudio(); };
  $('set-shake').onchange = e => { settings.shake = e.target.checked; save('settings', settings); applyView(); };
  $('set-hints').onchange = e => { settings.hints = e.target.checked; save('settings', settings); applyView(); };
  $('set-nick-save').onclick = () => {
    const v = $('set-nick').value.trim().slice(0, 20);
    if (!v) return;
    progress.nick = v; save('progress', progress);
    if (root.Net.connected) root.Net.send({ t: 'rename', name: v });
    toast('Никнейм сохранён', 'good');
  };
  $('set-reset').onclick = () => {
    if (!confirm('Сбросить весь прогресс (кампания, достижения, лестница)?')) return;
    progress = JSON.parse(JSON.stringify(DEF_PROGRESS));
    progress.nick = 'Оператор-' + (1000 + Math.floor(Math.random() * 9000));
    save('progress', progress);
    renderSettings(); updateMenuProfile();
    toast('Прогресс сброшен');
  };
  function applyAudio() { Snd.setVolumes({ sfx: settings.sfx / 100 * (settings.soundOn ? 1 : 0), music: settings.music / 100 * (settings.soundOn ? 1 : 0), on: settings.soundOn }); }
  function applyView() {
    GV.setSettings({ speed: settings.speed / 100, shake: settings.shake, hints: settings.hints });
  }

  /* ═════════ онлайн ═════════ */
  let onlineMode = 'standard';
  let inRoom = null;      // {code, you, opp, searching, hostStartable}
  let quickSearching = false;

  document.querySelectorAll('#online-tabs .otab').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#online-tabs .otab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('#scr-online .otab-page').forEach(x => x.classList.remove('active'));
      $('otab-' + b.dataset.otab).classList.add('active');
      sfx('click');
      if (b.dataset.otab === 'rooms') root.Net.send({ t: 'list' });
      if (b.dataset.otab === 'top') root.Net.send({ t: 'top' });
    };
  });
  document.querySelectorAll('#online-modes .mode-chip').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#online-modes .mode-chip').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      onlineMode = b.dataset.mode;
      sfx('click');
    };
  });

  function enterOnline() {
    root.Net.connect();
    renderProfilePanel();
    if (root.Net.connected) { root.Net.send({ t: 'hello', name: progress.nick }); root.Net.send({ t: 'list' }); root.Net.send({ t: 'top' }); }
  }
  function renderProfilePanel() {
    $('nick-input').value = progress.nick;
    $('prof-elo').textContent = progress.elo;
    const r = C.rankOf(progress.elo);
    $('prof-rank').textContent = r.name;
    $('prof-rank').style.color = r.color;
    $('prof-stats').textContent = `${progress.w} побед · ${progress.l} поражений · ${progress.d} ничьих`;
    $('prof-best').textContent = 'рекорд: ' + progress.bestElo;
  }
  $('nick-save').onclick = () => {
    const v = $('nick-input').value.trim().slice(0, 20);
    if (!v) return;
    progress.nick = v; save('progress', progress);
    root.Net.send({ t: 'rename', name: v });
    toast('Профиль обновлён', 'good');
  };
  $('btn-quick').onclick = () => {
    if (quickSearching) { root.Net.send({ t: 'cancelSearch' }); return; }
    if (!root.Net.connected) { root.Net.connect(); toast('Подключение…'); return; }
    root.Net.send({ t: 'quick', settings: { size: onlineMode === 'rush' ? 5 : 7, mode: onlineMode } });
    quickSearching = true;
    $('btn-quick').textContent = 'ОТМЕНИТЬ ПОИСК ✕';
    toast('Ищем соперника по рейтингу…');
  };
  $('btn-create').onclick = () => {
    if (!root.Net.connected) { root.Net.connect(); toast('Подключение…'); return; }
    root.Net.send({ t: 'create', settings: { size: onlineMode === 'rush' ? 5 : 7, mode: onlineMode } });
  };
  $('btn-join').onclick = () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length < 3) { toast('Введите код комнаты', 'bad'); return; }
    if (!root.Net.connected) { root.Net.connect(); toast('Подключение…'); return; }
    root.Net.send({ t: 'join', code });
  };
  $('rooms-refresh').onclick = () => { root.Net.send({ t: 'list' }); sfx('click'); };

  function resetQuickBtn() {
    quickSearching = false;
    $('btn-quick').textContent = 'НАЙТИ СОПЕРНИКА ▸';
  }

  function renderRooms(list) {
    const box = $('room-list');
    if (inRoom) {
      box.innerHTML = '';
      const r = inRoom;
      const item = el('div', 'room-item');
      item.innerHTML = `<div><div class="ri-host">ВАША КОМНАТА</div>
        <div class="ri-meta">${r.opp ? 'соперник: ' + esc(r.opp.name) : 'ждём соперника…'} · ${r.mode || 'стандарт'}</div></div>
        <div class="ri-code">${r.code}</div>`;
      const btns = el('div', '');
      if (r.opp && r.you === 0) {
        const b = el('button', 'mid-btn', 'НАЧАТЬ ▸');
        b.onclick = () => root.Net.send({ t: 'start' });
        btns.appendChild(b);
      }
      const leave = el('button', 'mid-btn danger', 'ВЫЙТИ');
      leave.onclick = () => { root.Net.send({ t: 'leave' }); inRoom = null; renderRooms(list); };
      btns.appendChild(leave);
      item.appendChild(btns);
      box.appendChild(item);
      if (r.you === 0 && !r.opp) box.appendChild(el('div', 'empty', 'Код приглашения: <b style="color:var(--gold);letter-spacing:.3em">' + r.code + '</b><br>друг вводит его в поле «ВОЙТИ»'));
      return;
    }
    box.innerHTML = '';
    if (!list || !list.length) { box.appendChild(el('div', 'empty', 'Комнат пока нет — создайте свою!')); return; }
    list.forEach(r => {
      const item = el('div', 'room-item');
      item.innerHTML = `<div><div class="ri-host">${esc(r.host)}</div>
        <div class="ri-meta">${r.mode === 'chaos' ? 'хаос' : r.mode === 'rush' ? 'быстрый' : 'стандарт'} · ${r.size}×${r.size} · рейтинг ${r.hostRating}</div></div>
        <div class="ri-code">${r.code}</div>`;
      const b = el('button', 'mid-btn', 'ВОЙТИ');
      b.onclick = () => root.Net.send({ t: 'join', code: r.code });
      item.appendChild(b);
      box.appendChild(item);
    });
  }
  function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  function renderTop(list, you) {
    const box = $('top-table');
    box.innerHTML = `<div class="trow head"><div>#</div><div>ОПЕРАТОР</div><div style="text-align:right">ELO</div><div style="text-align:right">В/П/Н</div><div style="text-align:right">ПАРТИИ</div></div>`;
    if (!list || !list.length) { box.appendChild(el('div', 'empty', 'Пока пусто. Будьте первым!')); return; }
    list.forEach((p, i) => {
      const me = you && p.name.toLowerCase() === String(you).toLowerCase();
      box.appendChild(el('div', 'trow' + (me ? ' me' : ''), `
        <div class="tr-pos">${i + 1}</div>
        <div class="tr-name">${esc(p.name)}${me ? ' (вы)' : ''}</div>
        <div class="tr-elo">${p.rating}</div>
        <div class="tr-wl">${p.wins}/${p.losses}/${p.draws}</div>
        <div class="tr-games">${p.games}</div>`));
    });
  }

  /* ── сетевые события ── */
  root.Net.on('welcome', m => {
    progress.elo = m.rating; progress.bestElo = Math.max(progress.bestElo, m.rating);
    if (m.stats) { progress.w = m.stats.wins; progress.l = m.stats.losses; progress.d = m.stats.draws; }
    save('progress', progress);
    renderProfilePanel(); updateMenuProfile();
    renderTop(m.top, m.name);
    if (m.rooms) renderRooms(m.rooms);
    toast('Подключено к ТЕССИТу · онлайн: ' + m.online, 'good');
    sfx('connect');
  });
  root.Net.on('rooms', m => renderRooms(m.rooms));
  root.Net.on('top', m => renderTop(m.top, m.you ? m.you.name : progress.nick));
  root.Net.on('err', m => {
    toast(m.msg, 'bad'); sfx('error'); resetQuickBtn();
    if (game && !game.over && game.source === 'online') { GV.setAnimating(false); GV.refreshLegal(); updateHUD(); }
  });
  root.Net.on('searchCanceled', () => { resetQuickBtn(); toast('Поиск отменён'); });
  root.Net.on('roomClosed', () => { inRoom = null; renderRooms([]); });
  root.Net.on('room', m => {
    resetQuickBtn();
    inRoom = { code: m.room.code, you: m.you, opp: m.opp || null, mode: m.room.mode, searching: m.searching };
    renderRooms([]);
    document.querySelector('#online-tabs .otab[data-otab="rooms"]').click();
    if (m.searching) toast('Комната создана, ждём соперника… Код: ' + m.room.code, 'good');
    else if (m.opp) toast('Соперник: ' + m.opp.name + ' (' + m.opp.rating + ')', 'good');
    sfx('connect');
  });
  root.Net.on('gameStart', m => {
    const state = E.deserialize(m.state);
    inRoom = m.room ? { code: m.room, you: m.you, opp: m.opp, mode: m.mode } : inRoom;
    startGame(state, {
      source: 'online', mySeat: m.you, online: { room: m.room || (inRoom && inRoom.code), deadline: m.deadline },
      oppName: m.opp.name, oppElo: m.opp.rating, modeLabel: m.mode === 'chaos' ? 'онлайн · хаос' : m.mode === 'rush' ? 'онлайн · быстрый' : 'онлайн · стандарт',
      botOpts: null
    });
    progress.stats.onlineGames++; save('progress', progress);
    unlock('online_first');
  });
  root.Net.on('state', m => {
    if (!game || game.source !== 'online' || game.over) return;
    game.state = E.deserialize(m.state);
    game.deadline = Date.now() + 60000;
    trackEvents(m.events || []);
    GV.setState(game.state);
    GV.playEvents(m.events || [], () => onAfterTurn());
  });
  root.Net.on('deadline', m => { if (game) game.deadline = m.deadline; });
  root.Net.on('over', m => {
    if (!game) return;
    game.serverOver = m;
    if (!game.over) setTimeout(() => finishGame(), 700);
  });
  root.Net.on('rematchVote', m => {
    if (m.votes && m.votes[0] && m.votes[1]) toast('Реванш начинается…', 'good');
    else toast('Соперник хочет реванш', 'good');
  });
  root.Net.on('emote', m => showEmote(m.who, m.id, m.who !== game.mySeat));
  root.Net.on('chat', m => toast(esc(m.from) + ': ' + esc(m.text)));

  /* ═════════ КОНТРОЛЛЕР ПАРТИИ ═════════ */
  let game = null;
  let worker = null;
  let waitTimer = 0;
  let timerInt = 0;

  function ensureWorker() {
    if (worker) return worker;
    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = onWorkerMsg;
      worker.onerror = () => { worker = null; };
    } catch (e) { worker = null; }
    return worker;
  }
  let reqId = 0;
  const pending = {};
  function thinkAsync(state, opts, cb) {
    const w = ensureWorker();
    const id = ++reqId;
    pending[id] = cb;
    if (w) {
      w.postMessage({ id, state: E.serialize(state), opts });
      // страховка: если воркер умер — синхронный расчёт
      setTimeout(() => {
        if (pending[id]) {
          delete pending[id];
          cb(syncThink(state, opts));
        }
      }, (opts && opts.time ? opts.time : 15000) + 3000);
    } else {
      setTimeout(() => cb(syncThink(state, opts)), 30);
    }
  }
  function onWorkerMsg(e) {
    const cb = pending[e.data.id];
    if (cb) { delete pending[e.data.id]; cb(e.data.action); }
  }
  function syncThink(state, opts) {
    try { return AI.think(E.cloneState(state), opts); } catch (e) { return null; }
  }

  function startGame(state, meta) {
    game = Object.assign({
      state, over: false, usedImp: 0, earnedCharge: 0,
      initUnits: [E.countUnits(state, 0), E.countUnits(state, 1)],
      coreKills: [], deadline: 0, botThinking: false, hintsShown: false
    }, meta);

    show('game');
    Snd.music('game');
    GV.resize();
    GV.setMyOwner(game.mySeat);
    GV.setSel(null);
    GV.setImp(false);
    GV.setState(state);
    GV.setAnimating(false);
    updateHUD();
    $('result-modal').hidden = true;
    $('game-log').innerHTML = '';
    $('waiting-overlay').hidden = true;
    $('imp-toggle').classList.remove('armed', 'locked');
    logItem('партия началась · ' + (game.modeLabel || ''), 'hi');

    if (game.introTips) {
      let i = 0;
      const showTip = () => { if (i < game.introTips.length) { toast(game.introTips[i]); i++; setTimeout(showTip, 3400); } };
      setTimeout(showTip, 700);
    }
    clearInterval(timerInt);
    if (game.source === 'online') {
      game.deadline = (game.online && game.online.deadline) || (Date.now() + 60000);
      timerInt = setInterval(tickTimer, 150);
      $('timer-bar').hidden = false;
    } else {
      $('timer-bar').hidden = true;
    }
    sfx('start');
    // первый ход
    if (state.turn !== game.mySeat && game.source !== 'online') setTimeout(botMove, 450);
  }

  function tickTimer() {
    if (!game || game.over) { $('timer-bar').hidden = true; clearInterval(timerInt); return; }
    const left = Math.max(0, game.deadline - Date.now());
    const pct = Math.min(100, left / 60000 * 100);
    const fill = $('timer-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('low', left < 10000);
  }

  function updateHUD() {
    if (!game) return;
    const s = game.state;
    const oppSeat = 1 - game.mySeat;
    const oppName = game.source === 'online' ? game.oppName
      : game.ladderBot ? game.ladderBot.name
      : game.mission ? 'ПРОТОКОЛ «' + game.mission.name + '»'
      : game.source === 'campaign' ? 'ПРОТОКОЛ' : 'БОТ';
    const oppElo = game.source === 'online' ? game.oppElo
      : game.ladderBot ? game.ladderBot.rating : '';

    $('me-name').textContent = progress.nick + (game.mySeat === 0 ? ' ◀' : ' ▶');
    $('opp-name').textContent = oppName + (game.mySeat === 1 ? ' ◀' : ' ▶');
    $('me-elo').textContent = game.source === 'online' ? game.myElo || progress.elo : '';
    $('opp-elo').textContent = oppElo !== '' ? oppElo : '';

    renderCharge($('me-charge'), s.charge[game.mySeat]);
    renderCharge($('opp-charge'), s.charge[oppSeat]);
    $('me-units').textContent = E.countUnits(s, game.mySeat) + ' юн.';
    $('opp-units').textContent = E.countUnits(s, oppSeat) + ' юн.';

    $('round-num').textContent = 'РАУНД ' + s.round;
    $('round-sub').textContent = game.modeLabel || '';

    // обратный отсчёт сжатия
    const cfg = s.cfg;
    let warn = '';
    if (cfg && cfg.startShrink) {
      const startA = cfg.startShrink * 2 - 1, everyA = cfg.shrinkEvery * 2 - 1;
      const ac = s.actCount || 0;
      const next = ac < startA ? startA : startA + Math.floor((ac - startA) / everyA + 1) * everyA;
      const d = next - ac;
      if (d <= 20) warn = '◫ ПЕРИМЕТР СЖИМАЕТСЯ ЧЕРЕЗ ' + d + ' ход' + plural(d);
    }
    $('shrink-warn').textContent = warn;

    document.getElementById('card-me').classList.toggle('turn', s.turn === game.mySeat && !game.over);
    document.getElementById('card-opp').classList.toggle('turn', s.turn !== game.mySeat && !game.over);

    const impBtn = $('imp-toggle');
    const charge = s.charge[game.mySeat];
    impBtn.classList.toggle('locked', charge <= 0 || s.turn !== game.mySeat);
    impBtn.classList.toggle('armed', GV.getImp() && charge > 0);
    $('imp-label').textContent = 'ИМПУЛЬС: ' + (GV.getImp() ? 'ВКЛ' : 'ВЫКЛ') + ' (↯' + charge + ')';

    if (s.turn === game.mySeat && !game.over) {
      $('action-hint').textContent = GV.getSel() != null ? 'цель: кликните клетку' : 'ваш ход — выберите юнита';
    } else {
      $('action-hint').textContent = game.over ? 'партия окончена' : 'ход соперника…';
    }
  }
  function plural(n) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return '';
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 'А';
    return 'ОВ';
  }
  function renderCharge(box, n) {
    box.innerHTML = '';
    for (let i = 0; i < 3; i++) box.appendChild(el('i', i < n ? 'on' : ''));
  }
  function logItem(text, cls) {
    const box = $('game-log');
    const it = el('div', 'log-item' + (cls ? ' ' + cls : ''), text);
    box.prepend(it);
    while (box.children.length > 6) box.lastChild.remove();
    setTimeout(() => { it.style.opacity = '0'; it.style.transition = 'opacity .6s'; }, 5200);
    setTimeout(() => it.remove(), 6000);
  }

  /* ── выбор и исполнение хода ── */
  function canAct() {
    return game && !game.over && !GV.isAnimating() && game.state.turn === game.mySeat &&
      (game.source !== 'online' || true);
  }

  function onPick(cell) {
    if (!canAct()) { if (game && !game.over && game.state.turn !== game.mySeat) toast('Ждите хода соперника'); return; }
    const s = game.state;
    const u = E.unitAt(s, cell);
    const sel = GV.getSel();

    if (sel != null) {
      const acts = E.legalActions(s).filter(a => a.id === sel);
      // шаг?
      const mv = acts.find(a => a.k === 'm' && a.to === cell);
      if (mv) { execAction(mv); return; }
      // толчок?
      const shoves = acts.filter(a => a.k === 's');
      for (const a of shoves) {
        const tgt = E.getUnit(s, a.tgt);
        if (!tgt || tgt.cell !== cell) continue;
        const hasNormal = acts.some(x => !x.imp && x.tgt === a.tgt);
        const hasImp = acts.some(x => x.imp && x.tgt === a.tgt);
        let pick = null;
        if (GV.getImp() && hasImp) pick = 'imp';
        else if (hasNormal) pick = 'normal';
        else if (hasImp) pick = 'imp'; // тяжёлый: только импульс
        if (pick === 'imp') { execAction(acts.find(x => x.imp && x.tgt === a.tgt)); return; }
        if (pick === 'normal') { execAction(acts.find(x => !x.imp && x.tgt === a.tgt)); return; }
        toast('Тяжёлого двигает только ИМПУЛЬС — нужен заряд', 'bad'); sfx('deny'); return;
      }
      // свой юнит — переключить
      if (u && u.owner === game.mySeat) { GV.setSel(u.id); sfx('select'); updateHUD(); return; }
      GV.setSel(null); sfx('click'); updateHUD(); return;
    }
    if (u && u.owner === game.mySeat) { GV.setSel(u.id); sfx('select'); updateHUD(); }
    else if (u) { sfx('deny'); }
  }

  function execAction(action) {
    const s = game.state;
    if (!E.validate(s, action)) { sfx('deny'); return; }
    if (action.imp) { game.usedImp++; progress.stats.impUsed++; GV.setImp(false); }
    sfx('move');
    if (game.source === 'online') {
      GV.setSel(null);
      GV.setAnimating(true);
      root.Net.send({ t: 'action', action });
      updateHUD();
      return;
    }
    const ev = E.applyAction(s, action, true) || [];
    trackEvents(ev);
    GV.setSel(null);
    GV.setState(s);
    GV.setAnimating(true);
    updateHUD();
    GV.playEvents(ev, () => onAfterTurn());
  }

  function trackEvents(events) {
    for (const ev of events) {
      if (ev.t === 'charge') { game.earnedCharge++; progress.stats.chargeEarned++; }
      if (ev.t === 'kill' && ev.type === 'core') game.coreKills.push({ owner: ev.owner, cause: ev.cause });
    }
  }

  function onAfterTurn() {
    const s = game.state;
    updateHUD();
    if (s.winner !== null) {
      if (game.source === 'online' && !game.serverOver) setTimeout(finishGame, 3000);
      else finishGame();
      return;
    }
    if (game.source === 'online') {
      GV.setAnimating(false);
      GV.refreshLegal();
      updateHUD();
      if (s.turn !== game.mySeat) showWait(true, 'ход соперника…');
      else showWait(false);
      return;
    }
    if (s.turn !== game.mySeat) { botMove(); return; }
    GV.setAnimating(false);
    GV.refreshLegal();
    updateHUD();
    showWait(false);
  }

  function botMove() {
    if (!game || game.over || game.source === 'online') return;
    const s = game.state;
    if (s.turn === game.mySeat || s.winner !== null) return;
    GV.setAnimating(true);
    showWait(true, 'протокол думает…');
    $('opp-think').classList.add('on');
    const opts = game.botOpts;
    thinkAsync(s, opts, (action) => {
      $('opp-think').classList.remove('on');
      if (!game || game.over) return;
      showWait(false);
      if (!E.validate(game.state, action)) {
        const acts = E.legalActions(game.state);
        action = acts[(Math.random() * acts.length) | 0];
      }
      if (!action) return;
      const ev = E.applyAction(game.state, action, true) || [];
      trackEvents(ev);
      GV.setState(game.state);
      GV.playEvents(ev, () => onAfterTurn());
    });
  }

  function showWait(on, text) {
    $('waiting-overlay').hidden = !on;
    if (text) $('wait-text').textContent = text;
  }

  /* ── подсказка ── */
  $('btn-hint').onclick = () => {
    if (!game || game.over) return;
    if (game.source === 'online') { toast('Подсказки доступны в одиночной игре'); return; }
    if (game.state.turn !== game.mySeat) { toast('Сейчас ход соперника'); return; }
    sfx('click');
    toast('Считаю…');
    setTimeout(() => {
      if (!game || game.over) return;
      const a = AI.hint(E.cloneState(game.state));
      if (!a) return;
      GV.setSel(a.id);
      const desc = a.k === 'm' ? 'шаг' : (a.imp ? 'импульс-толчок' : 'толчок');
      toast('Подсказка: ' + desc + (a.k === 'm' ? '' : ' · цель ' + coordName(a.to != null ? a.to : (E.getUnit(game.state, a.tgt) || {}).cell)));
      GV.burst && GV.burst((E.getUnit(game.state, a.id) || { cell: 0 }).cell, '#fbbf24', 14, 1);
      updateHUD();
    }, 60);
  };
  function coordName(cell) {
    if (cell == null || !game) return '';
    const n = game.state.size;
    return String.fromCharCode(65 + (cell % n)) + (n - ((cell / n) | 0));
  }

  /* ── импульс ── */
  $('imp-toggle').onclick = () => {
    if (!game || game.over) return;
    if (game.state.charge[game.mySeat] <= 0) { toast('Нет зарядов', 'bad'); sfx('deny'); return; }
    GV.setImp(!GV.getImp());
    sfx(GV.getImp() ? 'charge' : 'click');
    updateHUD();
  };

  /* ── выход / сдача ── */
  $('btn-leave').onclick = () => leaveGame();
  $('btn-resign').onclick = () => {
    if (!game || game.over) return;
    if (!confirm(game.source === 'online' ? 'Сдаться? Соперник победит.' : 'Сдаться и признать поражение?')) return;
    if (game.source === 'online') { root.Net.send({ t: 'leave' }); game.state.winner = 1 - game.mySeat; game.state.overReason = 'resign'; finishGame(); return; }
    game.state.winner = 1 - game.mySeat;
    game.state.overReason = 'resign';
    finishGame();
  };
  function leaveGame() {
    if (game && !game.over && game.source === 'online') {
      if (!confirm('Покинуть партию? Соперник победит.')) return;
      root.Net.send({ t: 'leave' });
      game.state.winner = 1 - game.mySeat;
      game.state.overReason = 'leave';
      finishGame();
      return;
    }
    if (game && !game.over && !confirm('Покинуть партию? Она будет засчитана как поражение.')) {
      game.state.winner = 1 - game.mySeat; game.state.overReason = 'leave';
      finishGame(); return;
    }
    clearInterval(timerInt);
    game = null;
    show('menu');
  }
  document.addEventListener('keydown', (e) => {
    if (current !== 'game') {
      if (e.key === 'Escape' && current !== 'menu') show('menu');
      return;
    }
    if (e.key === 'Escape') { GV.setSel(null); updateHUD(); }
    if (e.key === 'h' || e.key === 'H' || e.key === 'р' || e.key === 'Р') $('btn-hint').click();
    if (e.key === 'e' || e.key === 'E' || e.key === 'у' || e.key === 'У') $('btn-emote').click();
  });

  /* ── эмоции ── */
  $('btn-emote').onclick = () => {
    const w = $('emote-wheel');
    if (game && game.source !== 'online') { toast('Эмоции — только в онлайне'); return; }
    if (!w.hidden) { w.hidden = true; return; }
    w.innerHTML = '';
    C.EMOTES.forEach(t => {
      const b = el('button', '', t);
      b.onclick = () => {
        w.hidden = true;
        root.Net.send({ t: 'emote', id: t });
        showEmote(game.mySeat, t, true);
        sfx('emote');
      };
      w.appendChild(b);
    });
    w.hidden = false;
    sfx('click');
  };
  function showEmote(who, text, mine) {
    if (!game) return;
    const box = document.querySelector('.game-layout');
    const b = el('div', 'emote-float', '💬 ' + esc(text));
    b.style.right = '18px';
    b.style.top = who === game.mySeat ? 'auto' : '76px';
    b.style.bottom = who === game.mySeat ? '76px' : 'auto';
    if (who !== game.mySeat) b.style.borderColor = 'var(--pink)';
    box.appendChild(b);
    setTimeout(() => b.remove(), 2700);
    sfx('emote');
  }

  /* ═════════ завершение партии ═════════ */
  function finishGame() {
    if (!game || game.over) return;
    game.over = true;
    clearInterval(timerInt);
    $('timer-bar').hidden = true;
    showWait(false);
    $('opp-think').classList.remove('on');
    GV.setAnimating(false);
    GV.refreshLegal();

    const s = game.state;
    const win = s.winner === game.mySeat;
    const draw = s.winner === 'draw';

    progress.stats.games++;
    if (win) progress.stats.wins++;

    // причина победы
    let cause = null;
    const myKill = game.coreKills.find(k => k.owner !== game.mySeat);
    if (myKill) cause = myKill.cause;

    let stars = null;
    if (game.source === 'campaign' && game.mission) {
      const m = game.mission;
      if (win) {
        const rec = progress.campaign[m.id] || { stars: 0, done: false };
        let st = 1;
        if (s.round <= m.stars.moves) st = 2;
        const losses = game.initUnits[game.mySeat] - E.countUnits(s, game.mySeat);
        if (st === 2 && losses === 0) st = 3;
        rec.stars = Math.max(rec.stars || 0, st);
        rec.done = true;
        progress.campaign[m.id] = rec;
        stars = rec.stars;
        unlock('campaign_start');
        if (m.sector === 0) unlock('sector1');
        if (m.sector === 1) unlock('sector2');
        if (m.sector === 2) unlock('sector3');
        if (m.id === 36) unlock('campaign_done');
        if (starsTotal() >= 12) unlock('stars12');
        if (starsTotal() >= 60) unlock('stars60');
        const perfect = Object.values(progress.campaign).filter(r => r.stars >= 3).length;
        if (perfect >= 10) unlock('perfect10');
      }
    }
    if (game.source === 'ladder' && win && game.ladderBot) {
      progress.ladder[game.ladderBot.id] = true;
      const beaten = Object.keys(progress.ladder).filter(k => progress.ladder[k]).length;
      if (beaten >= 5) unlock('ladder5');
      if (beaten >= C.LADDER.length) unlock('ladder_all');
    }
    if (game.source === 'arcade' && win && game.arcadeId) {
      progress.arcadeWins[game.arcadeId] = true;
      if (Object.keys(progress.arcadeWins).length >= 5) unlock('arcade5');
    }
    if (win) unlock('first_win');
    if (win && cause === 'grind') unlock('grind_win');
    if (win && cause === 'flow') unlock('flow_win');
    if (win && cause === 'shrink') unlock('shrink_win');
    if (progress.stats.impUsed >= 10) unlock('imp10');
    if (progress.stats.chargeEarned >= 50) unlock('charge50');
    if (progress.stats.games >= 25) unlock('games25');

    // онлайн-серия
    if (game.source === 'online') {
      if (win) { progress.stats.onlineWins++; progress.stats.streak++; progress.stats.bestStreak = Math.max(progress.stats.bestStreak, progress.stats.streak); if (progress.stats.streak >= 3) unlock('streak3'); }
      else progress.stats.streak = 0;
    }
    save('progress', progress);

    // музыка
    Snd.music(win ? 'win' : draw ? null : 'lose');
    setTimeout(() => { if (current === 'game') Snd.music('game'); }, 3800);
    sfx(win ? 'win' : draw ? 'draw' : 'lose');
    if (win) GV.doFlash('#35f0d044', 0.4);
    else if (!draw) GV.doFlash('#ff4d9d44', 0.4);

    showResult(win, draw, stars, cause);
    updateHUD();
  }

  function showResult(win, draw, stars, cause) {
    const modal = $('result-modal');
    const ico = $('result-ico'), title = $('result-title'), sub = $('result-sub');
    ico.textContent = draw ? '◇' : win ? '◈' : '✕';
    title.textContent = draw ? 'НИЧЬЯ' : win ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    title.className = 'result-title ' + (draw ? 'draw' : win ? 'win' : 'lose');

    const s = game.state;
    const reasons = {
      core: win ? 'Вражеское ядро уничтожено.' : 'Ваше ядро уничтожено.',
      double: 'Оба ядра погибли одновременно.',
      limit: 'Лимит раундов исчерпан.',
      shrink: 'Периметр сжался до предела.',
      resign: 'Партия сдана.',
      leave: 'Соперник покинул партию.',
      timeout: 'Превышено время хода.'
    };
    let text = reasons[s.overReason] || 'Партия окончена.';
    if (cause && win) text += cause === 'grind' ? ' Ядро в шлифовке!' : cause === 'flow' ? ' Поток доделал дело!' : cause === 'shrink' ? ' Сжатие свершило своё.' : '';
    text += ` · раунд ${s.round}`;
    sub.textContent = text;

    // звёзды
    const sb = $('result-stars');
    if (stars != null) {
      sb.hidden = false;
      sb.innerHTML = [1, 2, 3].map(i => `<span class="${i <= stars ? 'on' : ''}">★</span>`).join('');
    } else sb.hidden = true;

    // рейтинг
    const rb = $('result-rating');
    rb.hidden = true;
    if (game.source === 'online' && game.serverOver && game.serverOver.result) {
      const r = game.serverOver.result;
      const me = game.mySeat === 0 ? r.host : r.guest;
      const before = game.mySeat === 0 ? r.before.h : r.before.g;
      const delta = me.rating - before;
      rb.hidden = false;
      rb.innerHTML = `ELO: <b>${me.rating}</b> <span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}</span>`;
      progress.elo = me.rating;
      progress.bestElo = Math.max(progress.bestElo, me.rating);
      if (delta >= 0 && game.serverOver.winner === game.mySeat) { progress.w++; } else if (game.serverOver.winner !== game.mySeat && game.serverOver.winner !== 'draw') progress.l++;
      else if (game.serverOver.winner === 'draw') progress.d++;
      if (game.serverOver.winner === game.mySeat) unlock('online_win');
      if (progress.elo >= 1400) unlock('rating1400');
      if (progress.elo >= 1600) unlock('rating1600');
      if (progress.elo >= 1800) unlock('rating1800');
      save('progress', progress);
      if (game.serverOver.top) renderTop(game.serverOver.top, progress.nick);
    }

    // кнопки
    const acts = $('result-actions');
    acts.innerHTML = '';
    if (game.source === 'online') {
      const rm = el('button', 'big-btn', 'РЕВАНШ ▸');
      rm.onclick = () => { root.Net.send({ t: 'rematch' }); toast('Ждём соперника…'); sfx('click'); };
      acts.appendChild(rm);
      const back = el('button', 'mid-btn', 'В ЛОББИ');
      back.onclick = () => { root.Net.send({ t: 'leave' }); inRoom = null; modal.hidden = true; game = null; show('online'); };
      acts.appendChild(back);
    } else {
      const again = el('button', 'big-btn', 'ЕЩЁ РАЗ ▸');
      again.onclick = () => {
        modal.hidden = true;
        restartSame();
      };
      acts.appendChild(again);
      if (game.source === 'campaign' && win && pendingMission) {
        const idx = C.CAMPAIGN.findIndex(m => m.id === game.mission.id);
        const next = C.CAMPAIGN[idx + 1];
        if (next && missionUnlocked(idx + 1)) {
          const nb = el('button', 'mid-btn', 'СЛЕДУЮЩАЯ ▸');
          nb.onclick = () => { modal.hidden = true; pendingMission = { m: next, idx: idx + 1 }; startCampaignMission(next); };
          acts.appendChild(nb);
        }
      }
      if (game.source === 'ladder') {
        const lb = el('button', 'mid-btn', 'ЛЕСТНИЦА');
        lb.onclick = () => { modal.hidden = true; game = null; show('duel'); };
        acts.appendChild(lb);
      }
      const menu = el('button', 'mid-btn', 'В МЕНЮ');
      menu.onclick = () => { modal.hidden = true; game = null; show('menu'); };
      acts.appendChild(menu);
    }
    modal.hidden = false;
    sfx(win ? 'star' : 'click');
  }

  function restartSame() {
    const g = game;
    if (g.source === 'campaign' && g.mission) { startCampaignMission(g.mission); return; }
    if (g.source === 'ladder' && g.ladderBot) { startLadderBot(g.ladderBot); return; }
    if (g.source === 'arcade' && g.arcadeId) { startArcade(C.ARCADE.find(a => a.id === g.arcadeId)); return; }
    // дуэль — новая случайная партия с теми же настройками
    $('duel-start').click();
  }

  /* ═════════ бутстрап ═════════ */
  function boot() {
    applyAudio(); applyView(); updateMenuProfile();
    root.MenuBG.start($('menu-bg'));
    Snd.music('menu');
    GV.init($('game-canvas'), { onPick });
    // разводка кнопок меню
    document.querySelectorAll('[data-go]').forEach(b => {
      b.addEventListener('click', () => {
        const t = b.dataset.go;
        if (t === 'codex-lore') { show('codex'); document.querySelector('#codex-tabs .otab[data-ctab="lore"]').click(); return; }
        show(t);
      });
    });
    // первый гест — разбудить аудио
    const wake = () => { Snd.resume(); document.removeEventListener('pointerdown', wake); };
    document.addEventListener('pointerdown', wake);
    // сетевой статус
    root.Net.onStatus(s => {
      const dot = $('net-dot');
      dot.className = 'net-dot' + (s === 'online' ? ' on' : s === 'connecting' ? ' wait' : '');
      $('net-status').textContent = s === 'online' ? 'в сети' : s === 'connecting' ? 'подключение…' : 'отключено';
      if (s === 'online') root.Net.send({ t: 'hello', name: progress.nick });
    });
    // авто-подключение при первом заходе в онлайн
    renderRooms([]);
    show('menu');
  }

  root.UI = { show, toast, startGame, get game() { return game; }, unlock, progress, settings };
  document.addEventListener('DOMContentLoaded', boot);
})(typeof self !== 'undefined' ? self : this);
