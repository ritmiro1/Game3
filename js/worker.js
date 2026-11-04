/* РЕЗОНАНС — воркер ИИ (ходы бота без подвешивания UI) */
'use strict';
importScripts('engine.js', 'ai.js');

onmessage = function (e) {
  const d = e.data;
  try {
    const s = Engine.deserialize(d.state);
    const action = AI.think(s, d.opts || {});
    postMessage({ id: d.id, action });
  } catch (err) {
    postMessage({ id: d.id, action: null, error: String(err) });
  }
};
