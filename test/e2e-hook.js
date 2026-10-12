'use strict';
// Loaded inside the app by `npm run e2e` (MC_E2E). Drives the real window:
// fake microphone audio -> speech segments -> mock transcription -> retrieval
// from a mock GitHub repo -> streamed answer, plus OCR of a slide on screen.
const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

module.exports = async ({ app, win, copilot, kb, config, syncOrigin, autoSync, checkForUpdate, background, globalShortcut, runShortcut }) => {
  const out = process.env.MC_E2E_OUT;
  const result = { steps: [], ok: false };
  const step = (name, data) => { result.steps.push({ name, ...data }); console.log('[e2e]', name, JSON.stringify(data || {})); };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // Screenshots are a convenience; some machines (CI runners without a GPU) cannot take them.
  const shot = async (name) => {
    try { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
    catch (e) { step('screenshot skipped', { name, reason: String(e.message || e) }); }
  };
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

    if (!background.started) throw new Error('background refresh and update checks were not scheduled at launch');
    // Installed Windows builds ask GitHub for a newer release; other builds report "off".
    step('update check', await Promise.race([checkForUpdate({ manual: true }), new Promise(r => setTimeout(() => r({ state: 'timeout' }), 30000))]));

    const added = await syncOrigin({ kind: 'github', spec: 'wj/etl-pipeline' });
    step('github sync', { added, chunks: kb.chunks.length });
    // Documents inside the repo (a CV as PDF and as Word) are readable in this build.
    const hit = (q, file) => { const h = kb.search(q, 3).find(x => x.path.endsWith(file)); return h ? h.text.slice(0, 90) : null; };
    step('pinned notes', { names: kb.pinned().map(p => p.path) });
    step('documents', { pdf: hit('nightly load 12 million customer records', 'sample-cv.pdf'), docx: hit('XLM-RoBERTa ticket routing', 'sample-cv.docx') });
    if (!kb.search('nightly load 12 million customer records', 3).some(x => x.path.endsWith('sample-cv.pdf'))) throw new Error('PDF text was not indexed');
    // Background refresh: leaves an unchanged repo alone, picks up a new push. Checked through the
    // stored version rather than return values, because the app's own timer may do the work first.
    const versionNow = () => kb.sources['github:wj/etl-pipeline'].version;
    const v0 = versionNow();
    await autoSync();
    const v1 = versionNow();
    await fetch(config.get().github.apiBase + '/__push');
    await autoSync();
    const v2 = versionNow();
    step('background refresh', { unchangedKept: v1 === v0, pushPickedUp: v2 !== v1 });
    if (v1 !== v0 || v2 === v1) throw new Error('background refresh did not behave as expected');
    // ---- Knowledge: sections are the way in ----
    const os = require('os');
    await js(`document.querySelector('[data-tab=knowledge]').click()`);
    const selected = () => js(`[...document.querySelectorAll('#slotTabs button[aria-selected=true]')].map(b => b.dataset.view)`);
    const openSection = async (name) => {
      await js(`document.querySelector('#slotTabs [data-view=${name}]').click()`);
      await waitFor(`section ${name}`, async () => (await selected()).join() === name);
      await new Promise(r => setTimeout(r, 250));
    };
    await waitFor('about section', async () => (await selected()).join() === 'about' && !(await js(`document.getElementById('slotPanel').hidden`)));

    // Typing in one section never shows up in another, and leaving a section saves it.
    await js(`(() => { const t = document.getElementById('slotText'); t.value = 'I am a data engineer in Kuala Lumpur.'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await openSection('instructions');
    const carried = await js(`document.getElementById('slotText').value`);
    await js(`(() => { const t = document.getElementById('slotText'); t.value = 'Be professional when answering.'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await openSection('jd');
    const jdText = await js(`document.getElementById('slotText').value`);
    await openSection('about');
    const aboutBack = await js(`document.getElementById('slotText').value`);
    step('switching sections', { instructionsStartedEmpty: carried === '', jdStartedEmpty: jdText === '', aboutKept: aboutBack, oneSelected: await selected() });
    if (carried !== '' || jdText !== '' || aboutBack !== 'I am a data engineer in Kuala Lumpur.') throw new Error('text carried over between sections or was not saved on switch');

    // Files go into the section they are added to; unreadable types are refused by name.
    const drop = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-drop-'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample-cv.docx'), path.join(drop, 'my cv.docx'));
    fs.writeFileSync(path.join(drop, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    fs.writeFileSync(path.join(drop, 'role.md'), '# Platform Engineer\n\nMust have Terraform and on-call experience.');
    await openSection('cv');
    const cvAdd = await js(`window.mc.call('slot:addFiles', 'cv', ${JSON.stringify([path.join(drop, 'my cv.docx'), path.join(drop, 'photo.png')])})`);
    const jdAdd = await js(`window.mc.call('slot:addFiles', 'jd', ${JSON.stringify([path.join(drop, 'role.md')])})`);
    await openSection('cv');
    const cvFiles = await js(`[...document.querySelectorAll('#slotFiles .name')].map(n => n.textContent)`);
    const cvMeta = await js(`[...document.querySelectorAll('#slotFiles .meta')].map(n => n.textContent)`);
    await shot('2a-cv-section');
    step('files in sections', { cvAdded: cvAdd.value.added, skipped: cvAdd.value.skipped, jdAdded: jdAdd.value.added, cvFilesShown: cvFiles, cvMeta });
    if (!/passages? read/.test(cvMeta.join())) throw new Error('the file row does not say how much was read');
    if (cvFiles.join() !== 'my cv.docx' || cvAdd.value.skipped.join() !== 'photo.png' || jdAdd.value.added.join() !== 'role.md') throw new Error('adding files to a section did not behave as expected');

    // Portfolio: a repository by its GitHub Pages address, a dropped folder, a loose file.
    await openSection('portfolio');
    const viaPages = await js(`window.mc.call('kb:add', 'https://wj.github.io/etl-pipeline/')`);
    const folder = path.join(drop, 'side-project');
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'notes.md'), '# Serengeti rollout\n\nRolled out to nine regions.');
    fs.writeFileSync(path.join(drop, 'talk.md'), '# Conference talk\n\nSpoke about feature stores.');
    // A paper saved under a meaningless name, and a PDF with no readable text.
    const paper = '5f6f95d7-dbfd-4264-bb64-b633e88df350.pdf';
    fs.copyFileSync(path.join(__dirname, 'fixtures', '3c1d9a7e-55aa-4f0b-9d2e-0a1b2c3d4e5f.pdf'), path.join(drop, paper));
    fs.writeFileSync(path.join(drop, 'scan.pdf'), '%PDF-1.4 nothing readable');
    const pfAdd = await js(`window.mc.call('slot:addFiles', 'portfolio', ${JSON.stringify([folder, path.join(drop, 'talk.md'), path.join(drop, paper), path.join(drop, 'scan.pdf')])})`);
    await openSection('portfolio');
    await waitFor('portfolio lists', () => js(`document.querySelectorAll('#kbList li').length === 2 && document.querySelectorAll('#portfolioFiles li').length === 3`));
    const rows = await js(`[...document.querySelectorAll('#portfolioFiles li')].map(li => ({ name: li.querySelector('.name').textContent, meta: li.querySelector('.meta').textContent, unread: li.classList.contains('unread') }))`);
    const found = kb.search('Tell me about your publication', 2)[0];
    step('publication', { rows, topHitForPublication: found && found.title });
    const paperRow = rows.find(r => r.name === paper), scanRow = rows.find(r => r.name === 'scan.pdf');
    if (!paperRow || !/^Publication: Predicting shipment delays.*passages read$/.test(paperRow.meta) || !scanRow || !scanRow.unread || !/^Publication \(research paper\)/.test(found.title)) throw new Error('the publication was not read, named or found as expected');
    step('portfolio', { pages: viaPages.ok, sources: await js(`[...document.querySelectorAll('#kbList .label')].map(n => n.textContent)`), files: await js(`[...document.querySelectorAll('#portfolioFiles .name')].map(n => n.textContent)`), added: pfAdd.value.added, folders: pfAdd.value.folders });
    await shot('2b-portfolio');

    // Q&A: add an answer with the form, several by pasting, change one, remove one.
    await openSection('qa');
    const fillQa = (q, a) => js(`(() => { document.getElementById('qaQ').value = ${JSON.stringify(q)}; document.getElementById('qaA').value = ${JSON.stringify(a)}; document.getElementById('qaAdd').click(); })()`);
    const qaRows = () => js(`[...document.querySelectorAll('#qaList li')].map(li => ({ q: li.querySelector('.q').textContent, a: li.querySelector('.a').textContent }))`);
    await fillQa('How do you deal with duplicate customer records?', 'Two passes: exact match on tax ID, then fuzzy match on name and address at 0.92.');
    await waitFor('first prepared answer', async () => (await qaRows()).length === 1);
    await js(`(() => { document.getElementById('qaMany').open = true; document.getElementById('qaBulk').value = 'Q: Why do you want to leave your current role?\\nA: I want to own models end to end.\\n\\nQ: What is your biggest weakness?\\nA: I over-prepare.'; document.getElementById('qaBulkAdd').click(); })()`);
    await waitFor('pasted answers', async () => (await qaRows()).length === 3);
    await js(`document.querySelectorAll('#qaList li')[2].querySelectorAll('button')[0].click()`);
    await waitFor('editing', () => js(`document.getElementById('qaAdd').textContent === 'Save changes' && document.getElementById('qaQ').value === 'What is your biggest weakness?'`));
    await js(`(() => { document.getElementById('qaA').value = 'I over-prepare, so I time-box research to a day.'; document.getElementById('qaAdd').click(); })()`);
    await waitFor('edited', async () => /time-box/.test((await qaRows())[2].a) && await js(`document.getElementById('qaAdd').textContent === 'Add'`));
    await js(`document.querySelectorAll('#qaList li')[1].querySelectorAll('button')[1].click()`);
    await waitFor('removed', async () => (await qaRows()).length === 2);
    // A dropped file: the drop area is in view without opening anything, and a CSV is read.
    const dropShown = await js(`(() => { document.getElementById('qaMany').open = false; const r = document.getElementById('qaDrop').getBoundingClientRect(); return r.height > 20 && r.width > 100; })()`);
    fs.writeFileSync(path.join(drop, 'prep.csv'), 'Question,Answer\n"What is your notice period?","Three months, negotiable."\n');
    const csvAdd = await js(`window.mc.call('qa:importFiles', ${JSON.stringify([path.join(drop, 'prep.csv')])})`);
    if (!dropShown || !csvAdd.ok || csvAdd.value.added !== 1) throw new Error('the Q&A drop area is hidden or the CSV was not read');
    await js(`window.mc.call('qa:save', ${JSON.stringify([{ q: 'How do you deal with duplicate customer records?', a: 'Two passes: exact match on tax ID, then fuzzy match on name and address at 0.92.' }, { q: 'What is your biggest weakness?', a: 'I over-prepare, so I time-box research to a day.' }])})`);
    await openSection('qa');
    await new Promise(r => setTimeout(r, 300));
    await shot('2d-qa');
    const qaNow = await qaRows();
    step('prepared answers', { rows: qaNow, state: await js(`document.getElementById('qaState').textContent`), inKb: kb.prepared().map(p => p.q), selected: await selected() });
    if (qaNow.map(r => r.q).join('|') !== 'How do you deal with duplicate customer records?|What is your biggest weakness?' || kb.prepared().length !== 2) throw new Error('the prepared answers were not kept as edited');

    // Publications: the paper goes in its own section, is searched by section, and its
    // abstract is among what goes with every answer. "Sync all" is gone from Portfolio.
    await openSection('publications');
    await js(`window.mc.call('slot:removeFile', 'portfolio', ${JSON.stringify(paper)})`);
    const pubAdd = await js(`window.mc.call('slot:addFiles', 'publications', ${JSON.stringify([path.join(drop, paper)])})`);
    await openSection('publications');
    const pubRows = await js(`[...document.querySelectorAll('#slotFiles li')].map(li => ({ name: li.querySelector('.name').textContent, meta: li.querySelector('.meta').textContent }))`);
    const methods = kb.search('i mean publication methodology', 8).map(h => h.title.replace(/^.* — /, ''));
    const briefs = kb.pinned().filter(p => p.slot === 'publications').map(p => ({ title: p.title, chars: p.text.length }));
    const syncAllGone = await js(`!document.getElementById('kbSyncAll')`);
    await shot('2c-publications');
    step('publications section', { added: pubAdd.value.added, rows: pubRows, methods, briefs, syncAllGone, selected: await selected() });
    if (pubRows.length !== 1 || !/^Publication: Predicting shipment delays.*passages read$/.test(pubRows[0].meta)) throw new Error('the paper is not listed under Publications');
    if (!methods.includes('Methods > Model') || !methods.includes('Methods > Data')) throw new Error('a methodology question does not reach the Methods section');
    if (briefs.length !== 1 || !/^Publication: Predicting shipment delays/.test(briefs[0].title) || briefs[0].chars > 1500 || !syncAllGone) throw new Error('the abstract is not sent with every answer, or Sync all is still there');

    // Equipped: what goes with every answer, and every searchable file.
    await openSection('equipped');
    await waitFor('equipped lists', () => js(`document.querySelectorAll('#eqAlways details').length >= 4 && document.querySelectorAll('#eqSearched > details').length >= 2`));
    const always = await js(`[...document.querySelectorAll('#eqAlways summary b')].map(n => n.textContent)`);
    await js(`document.querySelector('#eqAlways details').open = true`);
    await waitFor('note text shown', () => js(`/data engineer in Kuala Lumpur/.test(document.querySelector('#eqAlways .preview-text').textContent)`));
    await js(`(() => { const f = document.getElementById('eqFilter'); f.value = 'dedupe'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor('filter applied', () => js(`document.querySelectorAll('#eqSearched li').length === 1`));
    const filtered = await js(`[...document.querySelectorAll('#eqSearched li summary b')].map(n => n.textContent)`);
    await js(`(() => { const f = document.getElementById('eqFilter'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await js(`(async () => { document.getElementById('kbTryInput').value = 'fuzzy match threshold'; document.getElementById('kbTry').requestSubmit(); })()`);
    await waitFor('kb hits', () => js(`document.querySelectorAll('#kbHits li b').length > 0`));
    step('equipped', { summary: await js(`document.getElementById('eqSummary').textContent`), always, filtered, searchTop: await js(`document.querySelector('#kbHits li b').textContent`) });
    const expectAlways = ['About me', 'CV: my cv.docx', 'Job description: role.md', 'Instructions for this meeting'];
    if (expectAlways.some(t => !always.includes(t))) throw new Error('Equipped does not list the notes sent with every answer: ' + always.join(' | '));
    await new Promise(r => setTimeout(r, 300));
    await shot('2c-equipped');
    fs.rmSync(drop, { recursive: true, force: true }); // the app keeps its own copies of files; the folder source simply empties

    // The window can stop staying on top, and say so.
    const before = win.isAlwaysOnTop();
    await js(`document.getElementById('onTop').click()`);
    await waitFor('not on top', () => !win.isAlwaysOnTop());
    await js(`document.getElementById('onTop').click()`);
    await waitFor('on top again', () => win.isAlwaysOnTop());
    step('stay on top', { before, toggledOff: true, backOn: win.isAlwaysOnTop() });


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
    if (!(await js(`[...document.querySelectorAll('.source')].map(s => s.textContent)`)).some(t => /^QPrepared: How do you deal with duplicate/.test(t))) throw new Error('the prepared answer for this question was not offered');
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
    // Conversation log: earlier answers sit under the current one in the wide layout, every
    // answer is in the transcript where it was given, and the saved log carries them too.
    await js(`document.querySelector('#logList details').open = true`);
    await new Promise(r => setTimeout(r, 200));
    await shot('8-wide');
    const log = {
      shown: await js(`getComputedStyle(document.getElementById('log')).display`),
      earlier: await js(`[...document.querySelectorAll('#logList details')].map(d => ({ asked: d.querySelector('summary span').textContent, answer: d.querySelector('.card').innerText.slice(0, 60) }))`),
      onCard: await js(`document.getElementById('asked').textContent`),
      inTranscript: await js(`[...document.querySelectorAll('.line.answer summary')].map(n => n.textContent)`),
      saved: copilot.transcriptText().split('\n').filter(l => /Suggested answer|^\[.*\] Them:/.test(l)).map(l => l.replace(/^\[[^\]]*\] /, '')).slice(0, 4),
    };
    step('conversation log', log);
    if (log.shown !== 'flex' || !log.earlier.length || !/duplicate/i.test(log.earlier[log.earlier.length - 1].asked) || log.earlier.some(x => x.asked === log.onCard) || log.inTranscript.length < 2 || !log.saved.some(l => /^Suggested answer/.test(l))) throw new Error('the conversation log is missing answers');

    await js(`document.getElementById('toggle').click()`);
    await waitFor('stopped', () => js(`!document.body.classList.contains('listening')`));

    // Nothing to answer and Knowledge open: side by side the answer area stays; in the
    // narrow window it steps aside. Clearing the meeting empties the log.
    await js(`document.getElementById('resetBtn').click()`);
    await waitFor('cleared', () => js(`document.getElementById('card').classList.contains('idle') && !document.querySelector('.line')`));
    await js(`document.querySelector('[data-tab=knowledge]').click()`);
    await new Promise(r => setTimeout(r, 400));
    const cueOf = () => js(`getComputedStyle(document.querySelector('.cue')).display`);
    const wide = { setup: await js(`document.body.classList.contains('setup')`), cue: await cueOf(), log: await js(`getComputedStyle(document.getElementById('log')).display`) };
    await shot('9-wide-knowledge');
    win.setBounds({ x: 0, y: 0, width: 440, height: 700 });
    await new Promise(r => setTimeout(r, 500));
    const narrow = { cue: await cueOf() };
    step('answer area while setting up', { wide, narrow });
    if (!wide.setup || wide.cue !== 'flex' || wide.log !== 'none' || narrow.cue !== 'none') throw new Error('the answer area is not kept in the wide layout while setting up');
    result.ok = true;
    clearTimeout(timer);
    finish();
  } catch (e) { clearTimeout(timer); finish(e); }
};
