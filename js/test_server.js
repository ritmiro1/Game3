/* Тест сервера: node js/test_server.js (сервер поднимается сам) */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const E = require('../js/engine.js');

const PORT = 8791;
const dataFile = path.join(__dirname, '..', 'server', 'data.json');
const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null;

const srv = spawn('node', [path.join(__dirname, '..', 'server', 'server.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', d => srvLog += d);
srv.stderr.on('data', d => srvLog += d);

let failed = 0;
function ok(c, m) { if (!c) { failed++; console.log('FAIL: ' + m); } else console.log('ok: ' + m); }

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const msgs = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      msgs.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) { waiters[i].res(m); waiters.splice(i, 1); }
      }
    };
    ws.onopen = () => resolve({
      ws, msgs,
      send: (o) => ws.send(JSON.stringify(o)),
      wait: (pred, timeout = 5000, from = 0) => new Promise((res, rej) => {
        const found = msgs.slice(from).find(pred);
        if (found) return res(found);
        const w = { pred, res, rej, from };
        waiters.push(w);
        setTimeout(() => rej(new Error('timeout waiting')), timeout);
      })
    });
    ws.onerror = (e) => reject(e);
  });
}

(async () => {
  await wait(700);
  try {
    const A = await connect();
    const B = await connect();
    A.send({ t: 'hello', name: 'ТестовыйА' });
    B.send({ t: 'hello', name: 'ТестовыйБ' });
    const wa = await A.wait(m => m.t === 'welcome');
    const wb = await B.wait(m => m.t === 'welcome');
    ok(wa.rating === 1200 && wb.rating === 1200, 'оба получили welcome с рейтингом1200');

    A.send({ t: 'create', settings: { size: 7, mode: 'standard' } });
    const room = await A.wait(m => m.t === 'room');
    ok(!!room.room.code, 'комната создана: ' + room.room.code);

    B.send({ t: 'join', code: room.room.code });
    const joined = await B.wait(m => m.t === 'room' && m.opp);
    ok(joined.opp.name === 'ТестовыйА', 'B видит соперника');

    A.send({ t: 'start' });
    const gsA = await A.wait(m => m.t === 'gameStart');
    const gsB = await B.wait(m => m.t === 'gameStart');
    ok(gsA.you === 0 && gsB.you === 1, 'стартовые позиции: A=0, B=1');

    // A делает ход (ждём состояние именно с этим действием — защита от гонки эхо-трансляции)
    let st = E.deserialize(gsA.state);
    let act = E.legalActions(st)[0];
    A.send({ t: 'action', action: act });
    const afterA = await B.wait(m => m.t === 'state' && m.by === 0 &&
      JSON.stringify(m.action) === JSON.stringify(act));
    ok(afterA.by === 0, 'B получил ход A');
    ok(afterA.state.turn === 1, 'ход перешёл к1');

    // играем случайно до конца (с ограничением)
    let cur = afterA;
    let guard = 0;
    while (cur.state.winner === null && guard++ < 300) {
      const s = E.deserialize(cur.state);
      const legal = E.legalActions(s);
      if (!legal.length) break;
      const a = legal[(Math.random() * legal.length) | 0];
      const sender = cur.state.turn === 0 ? A : B;
      const receiver = cur.state.turn === 0 ? B : A;
      const from = receiver.msgs.length;
      const sfrom = sender.msgs.length;
      const who = cur.state.turn;
      sender.send({ t: 'action', action: a });
      try {
        // строгое совпадение: тот же отправитель и то же действие —
        // иначе можно поймать отложенное эхо предыдущего хода
        cur = await receiver.wait(m => m.t === 'state' && m.by === who &&
          JSON.stringify(m.action) === JSON.stringify(a), 8000, from);
      } catch (e) {
        console.log('  loop fail at guard=' + guard + ' turn=' + cur.state.turn + ' action=' + JSON.stringify(a));
        console.log('  receiver msgs:', JSON.stringify(receiver.msgs.map(m => m.t)));
        console.log('  sender new msgs:', JSON.stringify(sender.msgs.slice(sfrom)));
        console.log('  validate@senderState:', E.validate(E.deserialize(cur.state), a));
        throw e;
      }
    }
    ok(cur.state.winner !== null, 'партия завершена: winner=' + cur.state.winner + ' round=' + cur.state.round);

    const overA = await A.wait(m => m.t === 'over', 8000);
    const overB = await B.wait(m => m.t === 'over', 8000);
    ok(!!overA.result && !!overB.result, 'оба получили результат с изменением рейтинга');
    console.log('  результат:', JSON.stringify(overA.result));
    ok(overA.result.host.rating !== 1200 || overA.result.guest.rating !== 1200, 'рейтинг изменился');

    // таблица лидеров
    A.send({ t: 'top' });
    const top = await A.wait(m => m.t === 'top');
    ok(top.top.length >= 2, 'в таблице есть игроки: ' + top.top.length);

    // реванш
    A.send({ t: 'rematch' });
    B.send({ t: 'rematch' });
    const gs2 = await A.wait(m => m.t === 'gameStart' && m.you === 1, 6000);
    ok(true, 'реванш стартовал, теперь A играет за1');

    A.send({ t: 'leave' });
    await wait(200);
  } catch (e) {
    failed++;
    console.log('FAIL (exception):', e.message);
    console.log('server log:\n' + srvLog.slice(-2000));
  }

  srv.kill('SIGTERM');
  await wait(300);
  // восстановим данные
  try {
    if (backup !== null) fs.writeFileSync(dataFile, backup);
    else if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  } catch (e) { }
  console.log(failed ? '\nСЕРВЕР-ТЕСТЫ ПРОВАЛЕНЫ' : '\nСЕРВЕР-ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(failed ? 1 : 0);
})();
