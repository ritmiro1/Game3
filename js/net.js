/* РЕЗОНАНС — WebSocket-клиент */
(function (root) {
  'use strict';
  let ws = null;
  let status = 'offline'; // offline | connecting | online
  const handlers = {};
  const statusCbs = [];
  let retry = 0;
  let wantOpen = false;
  let lastUrl = null;

  function url() {
    if (lastUrl) return lastUrl;
    // в Electron сервер локальный; в браузере — относительный адрес (тот же origin)
    const isElectron = navigator.userAgent.includes('Electron');
    if (isElectron) lastUrl = 'ws://127.0.0.1:' + (root.RESONANCE_PORT || 8787);
    else if (location.protocol === 'http:' || location.protocol === 'https:')
      lastUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    else lastUrl = 'ws://127.0.0.1:8787';
    return lastUrl;
  }

  function setStatus(s) {
    if (status === s) return;
    status = s;
    statusCbs.forEach(cb => cb(s));
  }

  function connect() {
    wantOpen = true;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    setStatus('connecting');
    try { ws = new WebSocket(url()); } catch (e) { setStatus('offline'); return; }
    ws.onopen = () => { retry = 0; setStatus('online'); };
    ws.onclose = () => {
      ws = null;
      if (wantOpen && retry < 30) {
        retry++;
        setStatus('connecting');
        setTimeout(() => { if (wantOpen) connect(); }, Math.min(8000, 700 + retry * 900));
      } else setStatus(wantOpen ? 'connecting' : 'offline');
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { } };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'hi') return;
      (handlers[m.t] || []).forEach(fn => fn(m));
    };
  }

  function disconnect() {
    wantOpen = false; retry = 0;
    if (ws) { try { ws.close(); } catch (e) { } ws = null; }
    setStatus('offline');
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  }
  function onStatus(fn) { statusCbs.push(fn); }

  root.Net = { connect, disconnect, send, on, onStatus, get status() { return status; }, get connected() { return status === 'online'; } };
})(typeof self !== 'undefined' ? self : this);
