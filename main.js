'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, screen, dialog, shell, safeStorage, net, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { ConfigStore } = require('./src/config');
const { LLM } = require('./src/llm');
const { Copilot } = require('./src/copilot');
const { OcrEngine } = require('./src/ocr');
const { KnowledgeBase } = require('./src/rag/kb');
const github = require('./src/rag/github');
const api = require('./src/rag/api');
const { ingestFolder } = require('./src/rag/local');
const shortcuts = require('./src/shortcuts');

if (process.env.MC_USER_DATA) app.setPath('userData', process.env.MC_USER_DATA);

// net.fetch follows the system proxy settings, which matters on managed work laptops.
const netFetch = (url, init) => net.fetch(url, init);

let win, config, kb, llm, copilot, ocr;
let chosenSourceId = null;      // screen/window picked in the renderer for the next capture
let chosenDisplayId = null;
let compactRestore = null;

const send = (event, payload) => { if (win && !win.isDestroyed()) win.webContents.send('mc:' + event, payload); };

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = config.get().ui.bounds;
  const bounds = saved && screen.getAllDisplays().some(d => saved.x >= d.bounds.x - 50 && saved.x < d.bounds.x + d.bounds.width && saved.y >= d.bounds.y - 50 && saved.y < d.bounds.y + d.bounds.height)
    ? saved : { width: 440, height: Math.min(680, area.height - 80), x: area.x + area.width - 460, y: area.y + 40 };
  win = new BrowserWindow({
    ...bounds, minWidth: 360, minHeight: 150,
    frame: false, show: false, backgroundColor: '#1B2530', title: 'Meeting Copilot',
    alwaysOnTop: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // stay above a full-screen meeting window
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(Math.max(0.35, Math.min(1, config.get().ui.opacity || 1)));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  let saveTimer;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isMinimized() || compactRestore) return;
      config.update({ ui: { bounds: win.getBounds() } });
    }, 500);
  };
  win.on('resize', remember); win.on('move', remember);
  win.on('maximize', () => send('window', { maximized: true }));
  win.on('unmaximize', () => send('window', { maximized: false }));
  win.on('closed', () => { win = null; });
}

// Links come from indexed content and API responses, so only web links are opened, and
// local files only when they sit inside a folder the user added themselves.
function openExternal(url) {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  if (!url.startsWith('file://')) return;
  let file;
  try { file = path.normalize(fileURLToPath(url)); } catch { return; }
  const allowed = Object.values(kb.sources).some(s => s.origin && s.origin.kind === 'folder'
    && (file + path.sep).startsWith(path.normalize(s.origin.spec) + path.sep));
  if (allowed) shell.showItemInFolder(file);
}

// Secrets never go to the renderer; it only learns whether one is saved.
function publicConfig() {
  const c = JSON.parse(JSON.stringify(config.get()));
  const saved = { llmKey: !!c.llm.apiKey, sttKey: !!c.stt.apiKey, embedKey: !!c.embed.apiKey, githubToken: !!c.github.token, apiHeader: !!c.api.headerValue };
  c.llm.apiKey = c.stt.apiKey = c.embed.apiKey = c.github.token = c.api.headerValue = '';
  const labels = Object.fromEntries(Object.entries(c.shortcuts).map(([k, v]) => [k, shortcuts.pretty(v)]));
  return { config: c, saved, labels, platform: process.platform, encrypted: safeStorage.isEncryptionAvailable() };
}

// ---- knowledge sources ------------------------------------------------------

async function syncOrigin(origin) {
  const cfg = config.get();
  const added = [];
  if (origin.kind === 'github') {
    const opts = { token: cfg.github.token, fetchFn: netFetch, apiBase: (cfg.github.apiBase || 'https://api.github.com').replace(/\/+$/, '') };
    const spec = github.parseRepoSpec(origin.spec);
    const specs = spec.repo ? [spec] : await github.listRepos(spec.owner, opts);
    if (!specs.length) throw new Error(`No repositories found for "${spec.owner}".`);
    for (const [i, s] of specs.entries()) {
      send('kb', { type: 'progress', message: `Reading ${s.owner}/${s.repo} (${i + 1} of ${specs.length})` });
      try {
        const result = await github.fetchRepo(s, opts);
        kb.setSource(result, origin); added.push(result);
      } catch (e) {
        if (specs.length === 1) throw e;
        send('notice', { level: 'error', message: `${s.owner}/${s.repo}: ${e.message}` });
      }
    }
  } else if (origin.kind === 'url') {
    send('kb', { type: 'progress', message: `Fetching ${origin.spec}` });
    const result = await api.ingestUrl(origin.spec, { auth: cfg.api, fetchFn: netFetch });
    if (!result.chunks.length) throw new Error('That URL returned nothing readable.');
    kb.setSource(result, origin); added.push(result);
  } else if (origin.kind === 'folder') {
    send('kb', { type: 'progress', message: `Reading ${origin.spec}` });
    const result = ingestFolder(origin.spec);
    if (!result.chunks.length) throw new Error('No readable text or code files in that folder.');
    kb.setSource(result, origin); added.push(result);
  }
  await embedIfConfigured();
  kb.save();
  send('kb', { type: 'changed', stats: kb.stats() });
  return added.map(r => ({ label: r.label, files: r.files, chunks: r.chunks.length }));
}

async function embedIfConfigured() {
  if (!llm.embedConfigured()) return;
  try {
    await kb.embedMissing(t => llm.embed(t), config.get().embed.model,
      (done, total) => send('kb', { type: 'progress', message: `Embedding passages ${done} of ${total}` }));
  } catch (e) {
    send('notice', { level: 'error', message: `${e.message} Keyword search still works.` });
  }
}

// ---- shortcuts ---------------------------------------------------------------

const SHORTCUT_NAMES = { answer: 'Answer what they said', screen: 'Answer from the screen', toggle: 'Show or hide the window' };

function runShortcut(action) {
  if (!win) return;
  if (action === 'toggle') {
    if (win.isVisible() && !win.isMinimized()) win.hide(); else { win.show(); win.restore(); }
  } else send('hotkey', { action });
}

// Registers the configured shortcuts and returns the actions whose keys could not be taken
// (another running program already holds them).
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const failed = [];
  const seen = new Set();
  for (const [action, accel] of Object.entries(config.get().shortcuts || {})) {
    if (!accel || !SHORTCUT_NAMES[action]) continue;
    let ok = false;
    try { ok = !seen.has(accel) && globalShortcut.register(accel, () => runShortcut(action)); } catch { ok = false; }
    seen.add(accel);
    if (!ok) failed.push(action);
  }
  return failed;
}

const shortcutFailure = (failed) => `Could not take the shortcut for: ${failed.map(a => SHORTCUT_NAMES[a]).join('; ')}. Another program is holding those keys. Choose different ones under Settings.`;

// ---- IPC --------------------------------------------------------------------

function wireIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });

  handle('config:get', () => publicConfig());
  handle('config:set', (patch) => {
    const before = config.get().embed.model;
    config.update(patch);
    if (patch.ui && patch.ui.opacity && win) win.setOpacity(Math.max(0.35, Math.min(1, patch.ui.opacity)));
    if (patch.shortcuts) {
      const failed = registerShortcuts();
      if (failed.length) send('notice', { level: 'error', message: shortcutFailure(failed) });
    }
    if (config.get().embed.model && config.get().embed.model !== before && kb.chunks.length) {
      embedIfConfigured().then(() => { kb.save(); send('kb', { type: 'changed', stats: kb.stats() }); });
    }
    return publicConfig();
  });

  // While a shortcut field is being edited the shortcuts are released, so the keys reach the field.
  handle('shortcuts:suspend', (on) => { if (on) globalShortcut.unregisterAll(); else registerShortcuts(); return true; });
  handle('shortcuts:check', (accel) => ({ label: shortcuts.pretty(accel), problem: shortcuts.problem(accel) }));

  handle('kb:stats', () => kb.stats());
  handle('kb:add', (text) => {
    const spec = String(text || '').trim();
    if (!spec) throw new Error('Enter a GitHub repository (owner/repo) or a URL.');
    const isUrl = /^https?:\/\//i.test(spec) && !/^https?:\/\/(www\.)?github\.com\//i.test(spec);
    return syncOrigin({ kind: isUrl ? 'url' : 'github', spec });
  });
  handle('kb:addFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Add a folder of notes or code' });
    if (r.canceled || !r.filePaths[0]) return null;
    return syncOrigin({ kind: 'folder', spec: r.filePaths[0] });
  });
  handle('kb:remove', (id) => { kb.removeSource(id); kb.save(); return kb.stats(); });
  handle('kb:sync', async (id) => {
    const all = Object.values(kb.sources);
    const origins = new Map();
    for (const s of id ? all.filter(x => x.id === id) : all) if (s.origin) origins.set(s.origin.kind + '|' + s.origin.spec, s.origin);
    const failures = [];
    for (const origin of origins.values()) {
      try { await syncOrigin(origin); } catch (e) { failures.push(`${origin.spec}: ${e.message}`); }
    }
    if (failures.length) throw new Error(failures.join(' '));
    return kb.stats();
  });
  handle('kb:search', (q) => kb.search(q, 5).map(h => ({ title: h.title, path: h.path, url: h.url, snippet: h.text.slice(0, 320) })));

  handle('capture:sources', async () => {
    const own = win.getMediaSourceId();
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
    return list.filter(s => s.id !== own && s.name !== 'Meeting Copilot')
      .map(s => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }));
  });
  handle('capture:select', async (sourceId) => {
    chosenSourceId = sourceId || null; chosenDisplayId = null;
    if (sourceId && sourceId.startsWith('screen')) {
      const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const src = list.find(s => s.id === sourceId);
      chosenDisplayId = src && src.display_id ? src.display_id : String(screen.getPrimaryDisplay().id);
    }
    if (process.platform === 'darwin') {
      try { await systemPreferences.askForMediaAccess('microphone'); } catch { /* the capture call reports the failure */ }
    }
    return { systemAudio: process.platform === 'win32' };
  });
  // Where this overlay sits inside the captured screen (0..1), so OCR can blank it out
  // instead of reading its own answers back in.
  handle('capture:overlayRect', () => {
    if (!chosenDisplayId || !win || win.isMinimized() || !win.isVisible()) return null;
    const d = screen.getAllDisplays().find(x => String(x.id) === String(chosenDisplayId)) || screen.getPrimaryDisplay();
    const b = win.getBounds();
    const r = { x: (b.x - d.bounds.x) / d.bounds.width, y: (b.y - d.bounds.y) / d.bounds.height, w: b.width / d.bounds.width, h: b.height / d.bounds.height };
    return r.x + r.w <= 0 || r.y + r.h <= 0 || r.x >= 1 || r.y >= 1 ? null : r;
  });

  handle('stt:segment', (who, wav, durationMs) => {
    if (who !== 'them' && who !== 'you') return false;
    copilot.onSegment(who, Buffer.from(wav), Number(durationMs) || 0); // result arrives as 'transcript' events
    return true;
  });
  handle('stt:speaking', (who, on) => { copilot.setSpeaking(who, !!on); return true; });
  handle('ocr:frame', async (image) => {
    const text = await ocr.recognize(Buffer.from(image), config.get().capture.ocrLangs || 'eng');
    if (text !== null) copilot.setScreenText(text);
    return text;
  });
  handle('ocr:clear', () => { copilot.setScreenText(''); return true; });

  handle('answer:ask', (req) => { copilot.answer(req || {}); return true; });
  handle('meeting:reset', () => { copilot.reset(); return true; });
  handle('meeting:export', async () => {
    const text = copilot.transcriptText();
    if (!text) throw new Error('The transcript is empty.');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const r = await dialog.showSaveDialog(win, { defaultPath: `meeting-${stamp}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });

  handle('win:minimize', () => win.minimize());
  handle('win:maximize', () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); return win.isMaximized(); });
  handle('win:close', () => win.close());
  handle('win:compact', (on) => {
    if (on && !compactRestore) {
      if (win.isMaximized()) win.unmaximize();
      compactRestore = win.getBounds();
      win.setBounds({ ...compactRestore, height: 260 });
    } else if (!on && compactRestore) {
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: compactRestore.height });
      compactRestore = null;
    }
    return !!compactRestore;
  });
  handle('open:external', (url) => openExternal(String(url)));
}

// ---- app --------------------------------------------------------------------

app.whenReady().then(() => {
  const dir = app.getPath('userData');
  const crypto = safeStorage.isEncryptionAvailable()
    ? { encrypt: s => safeStorage.encryptString(s).toString('base64'), decrypt: s => safeStorage.decryptString(Buffer.from(s, 'base64')) }
    : null;
  config = new ConfigStore(path.join(dir, 'config.json'), crypto);
  config.load();
  kb = new KnowledgeBase(path.join(dir, 'knowledge')).load();
  llm = new LLM(() => config.get(), netFetch);
  ocr = new OcrEngine({ dataDir: path.join(dir, 'tessdata'), fetchFn: netFetch });
  copilot = new Copilot({ getConfig: () => config.get(), llm, kb, liveSearch: (t, q, o) => api.liveSearch(t, q, { ...o, fetchFn: netFetch }) });
  for (const ev of ['transcript', 'answer', 'notice']) copilot.on(ev, (p) => send(ev, p));

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const src = list.find(s => s.id === chosenSourceId) || list.find(s => s.id.startsWith('screen'));
      if (!src) return callback(null);
      const streams = { video: src };
      // Electron can tap system playback ("what you hear") on Windows only.
      if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch { callback(null); }
  });

  wireIpc();
  createWindow();

  const failed = registerShortcuts();
  if (failed.length) win.webContents.once('did-finish-load', () => send('notice', { level: 'error', message: shortcutFailure(failed) }));

  if (process.env.MC_E2E) require(path.resolve(process.env.MC_E2E))({ app, win, copilot, kb, config, syncOrigin, globalShortcut, runShortcut });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocr) ocr.stop(); });
app.on('window-all-closed', () => app.quit());
