/* РЕЗОНАНС — точка входа: глобальные ошибки и версия */
(function () {
  'use strict';
  window.RESONANCE_VERSION = '1.0.0';
  window.addEventListener('error', (e) => {
    // не роняем игру — покажем тост, если UI готов
    try {
      if (window.UI && UI.toast) UI.toast('Ошибка: ' + (e.message || 'сбой модуля'), 'bad');
    } catch (err) { }
    console.error('[РЕЗОНАНС]', e.message, e.filename, e.lineno);
  });
  document.addEventListener('DOMContentLoaded', () => {
    console.log('%cРЕЗОНАНС v1.0.0%c — Дуэль Потоков · протокол ТЕССИТА',
      'color:#35f0d0;font-weight:bold;font-size:14px', 'color:#7d8db0;font-size:12px');
  });
})();
