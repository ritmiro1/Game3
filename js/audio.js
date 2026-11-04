/* ============================================================
   РЕЗОНАНС — звук: WebAudio-синтез SFX + генеративная музыка
   ============================================================ */
(function (root) {
  'use strict';

  let ctx = null;
  let master, sfxGain, musicGain;
  let musicTimer = null;
  let mood = null;
  let step = 0;
  let nextTime = 0;
  const BPM = 96;
  const settings = { sfx: 0.8, music: 0.5, on: true };

  function ensure() {
    if (ctx) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      sfxGain = ctx.createGain(); sfxGain.gain.value = settings.sfx; sfxGain.connect(master);
      musicGain = ctx.createGain(); musicGain.gain.value = settings.music; musicGain.connect(master);
      return true;
    } catch (e) { return false; }
  }

  function resume() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setVolumes(s) {
    Object.assign(settings, s || {});
    if (sfxGain) sfxGain.gain.value = settings.sfx;
    if (musicGain) musicGain.gain.value = settings.music;
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!settings.on || !ensure()) return;
    const t0 = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.2, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, freq, q, delay) {
    if (!settings.on || !ensure()) return;
    const t0 = ctx.currentTime + (delay || 0);
    const len = Math.max(1, (dur * ctx.sampleRate) | 0);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq || 1000; f.Q.value = q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol || 0.3, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(sfxGain);
    src.start(t0);
  }

  const SFX = {
    click() { tone(660, 0.06, 'square', 0.06); },
    hover() { tone(880, 0.03, 'sine', 0.03); },
    select() { tone(520, 0.08, 'triangle', 0.12); tone(780, 0.1, 'triangle', 0.08, 0, 0.04); },
    deny() { tone(180, 0.15, 'sawtooth', 0.1, 120); },
    move() { tone(320, 0.09, 'triangle', 0.14, 430); noise(0.05, 0.05, 2400, 2); },
    shove() { noise(0.16, 0.28, 700, 1.4); tone(140, 0.18, 'square', 0.14, 70); },
    grind() { noise(0.3, 0.4, 500, 0.8); tone(90, 0.35, 'sawtooth', 0.2, 45); noise(0.2, 0.2, 3000, 3, 0.05); },
    kill() { noise(0.35, 0.35, 900, 0.7); tone(220, 0.3, 'sawtooth', 0.16, 55); },
    flow() { tone(240, 0.25, 'sine', 0.1, 480); noise(0.22, 0.1, 1800, 0.6, 0.02); },
    shrink() { noise(0.5, 0.35, 300, 0.5); tone(70, 0.6, 'sawtooth', 0.22, 40); },
    charge() { tone(660, 0.1, 'sine', 0.14); tone(990, 0.14, 'sine', 0.12, 0, 0.06); tone(1320, 0.16, 'sine', 0.1, 0, 0.12); },
    impetus() { tone(200, 0.2, 'square', 0.18, 900); noise(0.18, 0.2, 1200, 1, 0.03); },
    boom() { noise(0.5, 0.5, 400, 0.4); tone(60, 0.5, 'sawtooth', 0.3, 30); noise(0.3, 0.25, 2500, 0.8, 0.04); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.4, 'triangle', 0.16, 0, i * 0.11)); },
    lose() { [440, 370, 294, 220].forEach((f, i) => tone(f, 0.45, 'sawtooth', 0.12, 0, i * 0.13)); },
    draw() { [440, 440].forEach((f, i) => tone(f, 0.4, 'triangle', 0.12, 0, i * 0.18)); },
    star() { tone(1047, 0.12, 'sine', 0.14); tone(1568, 0.2, 'sine', 0.12, 0, 0.08); },
    emote() { tone(740, 0.08, 'square', 0.08); tone(980, 0.1, 'square', 0.07, 0, 0.06); },
    connect() { tone(440, 0.1, 'sine', 0.1); tone(660, 0.14, 'sine', 0.1, 0, 0.07); },
    error() { tone(140, 0.2, 'square', 0.14, 90); }
  };

  /* ---------- музыка ---------- */
  const Scales = {
    menu: { root: 110, seq: [0, 3, 7, 10, 12, 10, 7, 3], bass: [0, 0, -2, -2], mood: 'dark' },
    game: { root: 98, seq: [0, 7, 3, 10, 5, 12, 7, 3], bass: [0, -4, -2, -5], mood: 'tense' },
    campaign: { root: 130, seq: [0, 5, 7, 12, 10, 7, 5, 3], bass: [0, 0, -5, -3], mood: 'calm' },
    win: { root: 146, seq: [0, 4, 7, 12, 16, 12, 7, 4], bass: [0, 5, 7, 0], mood: 'bright' },
    lose: { root: 98, seq: [0, -1, -4, -5, -7, -5, -4, -1], bass: [0, -3, -5, -7], mood: 'dark' }
  };

  function playNote(freq, time, dur, type, vol, dest) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g); g.connect(dest || musicGain);
    o.start(time); o.stop(time + dur + 0.05);
  }

  function scheduler() {
    if (!ctx || !mood || !settings.on || !settings.music) { nextTime = 0; return; }
    const sc = Scales[mood] || Scales.menu;
    const stepDur = 60 / BPM / 2; // восьмые
    if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.05;
    while (nextTime < ctx.currentTime + 0.25) {
      const s = step % 8;
      const bar = Math.floor(step / 8) % 4;
      // бас
      if (s % 4 === 0) {
        const bf = sc.root * Math.pow(2, sc.bass[bar] / 12) / 2;
        playNote(bf, nextTime, stepDur * 3.6, 'triangle', 0.18);
      }
      // арпеджио
      const n = sc.seq[s];
      const f = sc.root * Math.pow(2, n / 12);
      playNote(f, nextTime, stepDur * 0.9, sc.mood === 'tense' ? 'square' : 'sine', sc.mood === 'tense' ? 0.045 : 0.06);
      // верхняя искра на пустых долях
      if (s % 2 === 1 && sc.mood !== 'dark') {
        playNote(f * 2, nextTime + stepDur * 0.5, stepDur * 0.5, 'sine', 0.03);
      }
      nextTime += stepDur;
      step++;
    }
  }

  function music(moodName) {
    if (moodName === mood) return;
    mood = moodName;
    step = 0;
    nextTime = 0;
    if (!moodName) { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } return; }
    if (!musicTimer) musicTimer = setInterval(scheduler, 80);
  }

  root.Snd = { resume, setVolumes, music, settings, sfx: SFX, get ctx() { return ctx; } };
})(typeof self !== 'undefined' ? self : this);
