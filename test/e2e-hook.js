'use strict';
// Loaded inside the app by `npm run e2e` (MC_E2E). Drives the real window:
// fake microphone audio -> speech segments -> mock transcription -> retrieval
// from a mock GitHub repo -> streamed answer, plus OCR of a slide on screen.
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

module.exports = async ({ app, win, copilot, kb, syncOrigin, globalShortcut, runShortcut }) => {
  const out = process.env.MC_E2E_OUT;
  const result = { steps: [], ok: false };
  const step = (name, data) => { result.steps.push({ name, ...data }); console.log('[e2e]', name, JSON.stringify(data || {})); };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const waitFor = async (what, fn, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
      await new Promise(r => setTimeout(r, 250));
    }
  };
  const finish = (err) => {
    if (err) { result.error = err.stack || String(err); console.log('[e2e] FAILED', result.error); }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    app.exit(err ? 1 : 0);
  };
  const timer = setTimeout(() => finish(new Error('overall timeout')), 110000);
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('[renderer]', e.message); });

  try {
    await waitFor('window load', () => !win.webContents.isLoading());
    await waitFor('ui boot', () => js(`!!document.querySelector('#card.idle')`));
    win.setBounds({ x: 1130, y: 30, width: 440, height: 700 });
    await shot('1-first-run');

    // A "shared slide" on the desktop for the screen reader to find.
    const slide = new BrowserWindow({ x: 30, y: 30, width: 1040, height: 620, frame: false, backgroundColor: '#ffffff' });
    await slide.loadURL('data:text/html,' + encodeURIComponent('<body style="font:28px Arial;margin:60px;color:#111"><h1 style="font-size:54px">SQL exercise</h1><p>Write a query to find customers with more than one order in the last 30 days.</p><p>Tables: customers(id, name)</p><p>orders(id, customer_id, created_at)</p></body>'));

    const added = await syncOrigin({ kind: 'github', spec: 'wj/etl-pipeline' });
    step('github sync', { added, chunks: kb.chunks.length });
    await js(`document.querySelector('[data-tab=knowledge]').click()`);
    await waitFor('kb list', () => js(`document.querySelectorAll('#kbList li').length === 1`));
    await js(`(async () => { document.getElementById('kbTryInput').value = 'fuzzy match threshold'; document.getElementById('kbTry').requestSubmit(); })()`);
    await waitFor('kb hits', () => js(`document.querySelectorAll('#kbHits li b').length > 0`));
    step('kb search', { top: await js(`document.querySelector('#kbHits li b').textContent`) });
    await shot('2-knowledge');

    // Route "their audio" to a fake input device (stands in for a loopback device).
    const devices = await js(`navigator.mediaDevices.getUserMedia({audio:true}).then(s => { s.getTracks().forEach(t=>t.stop()); return navigator.mediaDevices.enumerateDevices(); }).then(d => d.filter(x => x.kind==='audioinput').map(x => ({id:x.deviceId,label:x.label})))`);
    step('devices', { count: devices.length });
    const them = devices.find(d => d.id !== 'default' && d.id !== 'communications') || devices[0];
    await js(`window.mc.call('config:set', { capture: { themSource: ${JSON.stringify(them.id)}, ocrIntervalSec: 2 } })`);
    const loaded = new Promise(r => win.webContents.once('did-finish-load', r));
    win.webContents.reload();
    await loaded;
    await waitFor('reload', () => js(`!!document.querySelector('#card.idle') && document.getElementById('s-them').options.length > 1`));
    await js(`document.querySelector('[data-tab=settings]').click()`);
    await new Promise(r => setTimeout(r, 300));
    await shot('3-settings');
    const press = (id, init) => js(`document.getElementById('${id}').dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)})))`);
    await js(`document.getElementById('s-key-answer').scrollIntoView({ block: 'center' })`);
    await press('s-key-answer', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor('conflict warning', () => js(`/Teams/.test(document.getElementById('keyHint').textContent)`));
    step('recorder flags a Teams clash', { field: await js(`document.getElementById('s-key-answer').value`), hint: await js(`document.getElementById('keyHint').textContent`) });
    await new Promise(r => setTimeout(r, 200));
    await shot('3b-shortcut-clash');
    await press('s-key-answer', { key: ',', code: 'Comma', ctrlKey: true, altKey: true });
    await waitFor('free combination', () => js(`/is free/.test(document.getElementById('keyHint').textContent)`));
    step('recorder accepts the default', { field: await js(`document.getElementById('s-key-answer').value`), hint: await js(`document.getElementById('keyHint').textContent`) });
    await js(`document.querySelector('[data-tab=transcript]').click()`);

    await js(`document.getElementById('toggle').click()`);
    await waitFor('picker', () => js(`!document.getElementById('picker').hidden`));
    const listed = await js(`[...document.querySelectorAll('.pick span')].map(s => s.textContent)`);
    step('picker', { sources: listed });
    await new Promise(r => setTimeout(r, 300));
    await shot('4-picker');
    const realScreen = await js(`!![...document.querySelectorAll('.pick')].find(p => p.querySelector('small').textContent === 'Whole screen')`);
    if (realScreen) await js(`[...document.querySelectorAll('.pick')].find(p => p.querySelector('small').textContent === 'Whole screen').click()`);
    else {
      // Headless CI cannot enumerate screens: listen without one, then feed the screen reader a rendered slide instead.
      await js(`document.getElementById('pickNone').click()`);
    }
    await waitFor('listening', () => js(`document.body.classList.contains('listening')`));
    step('listening', { toasts: await js(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`) });

    await waitFor('transcript line', () => js(`document.querySelectorAll('.line.them:not(.pending)').length > 0`));
    await waitFor('answer', () => js(`document.querySelector('#card:not(.idle):not(.wait):not(.fail) .lead') && !document.getElementById('copy').hidden`));
    step('answer', {
      asked: await js(`document.getElementById('asked').textContent`),
      card: await js(`document.getElementById('card').innerText`),
      cites: await js(`document.querySelectorAll('#card .cite').length`),
      sources: await js(`[...document.querySelectorAll('.source')].map(s => s.textContent)`),
      lines: await js(`[...document.querySelectorAll('.line')].map(l => l.dataset.who + ': ' + l.lastChild.textContent)`),
      levels: await js(`[document.getElementById('lvThem').style.width, document.getElementById('lvYou').style.width]`),
    });
    let viaRealScreen = realScreen;
    if (realScreen) {
      try { await waitFor('real screen text', () => js(`/customers/i.test(document.getElementById('screenText').textContent)`), 20000); }
      catch { viaRealScreen = false; step('real screen capture produced no text here; using a rendered slide instead', {}); }
    }
    if (!viaRealScreen) {
      await js(`(() => {
        const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d');
        const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#111'; g.font = 'bold 54px Arial'; g.fillText('SQL exercise', 70, 130);
          g.font = '30px Arial'; g.fillText('Write a query to find customers with more than one order', 70, 230); g.fillText('in the last 30 days.', 70, 280); g.fillText('Tables: customers(id, name)', 70, 350); g.fillText('orders(id, customer_id, created_at)', 70, 400); };
        draw(); window.__slideTimer = setInterval(draw, 200);
        window.capture._watchScreen(c.captureStream(5), 2);
      })()`);
    }
    await waitFor('screen text', () => js(`/customers/i.test(document.getElementById('screenText').textContent)`), 45000);
    step('screen', { text: await js(`document.getElementById('screenText').textContent`), state: await js(`document.getElementById('screenState').textContent`), copilotHas: /more than one order/i.test(copilot.screenText), viaRealScreen });
    await shot('5-answer');

    // Shortcuts: registered under their default keys, and the screen shortcut reads the screen and answers with code.
    const keys = ['CommandOrControl+Alt+,', 'CommandOrControl+Alt+.', 'CommandOrControl+Alt+/'];
    step('shortcuts', { registered: keys.map(k => globalShortcut.isRegistered(k)), buttonTitles: await js(`[document.getElementById('answerNow').title, document.getElementById('answerScreen').title]`) });
    step('fresh read on demand', { read: await js(`window.capture.refreshScreen()`) });
    runShortcut('screen');
    await waitFor('code answer', () => js(`!!document.querySelector('#card pre code') && !document.getElementById('copy').hidden`));
    step('screen answer', { asked: await js(`document.getElementById('asked').textContent`), code: await js(`document.querySelector('#card pre code').textContent`), lang: await js(`document.querySelector('#card pre').dataset.lang`), rest: await js(`[...document.querySelectorAll('#card > p, #card li')].map(n => n.textContent)`) });
    await shot('5b-screen-answer');
    runShortcut('toggle'); await new Promise(r => setTimeout(r, 300));
    const hidden = !win.isVisible();
    runShortcut('toggle'); await new Promise(r => setTimeout(r, 300));
    step('toggle shortcut', { hidden, shownAgain: win.isVisible() });
    await js(`document.querySelector('[data-tab=screen]').click()`);
    await new Promise(r => setTimeout(r, 300));
    await shot('6-screen');

    await js(`document.getElementById('compact').click()`);
    await waitFor('compact', () => js(`document.body.classList.contains('compact')`));
    await new Promise(r => setTimeout(r, 400));
    step('compact', { bounds: win.getBounds() });
    await shot('7-compact');
    await js(`document.getElementById('compact').click()`);
    await waitFor('expanded', () => js(`!document.body.classList.contains('compact')`));
    step('restored', { bounds: win.getBounds() });

    await js(`document.querySelector('[data-tab=transcript]').click()`);
    win.setBounds({ x: 0, y: 0, width: 1500, height: 860 });
    await new Promise(r => setTimeout(r, 500));
    await shot('8-wide');

    await js(`document.getElementById('toggle').click()`);
    await waitFor('stopped', () => js(`!document.body.classList.contains('listening')`));
    result.ok = true;
    clearTimeout(timer);
    finish();
  } catch (e) { clearTimeout(timer); finish(e); }
};
