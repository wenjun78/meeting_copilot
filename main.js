'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, screen, dialog, shell, safeStorage, net, systemPreferences, Menu } = require('electron');
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
const { extractText } = require('./src/rag/extract');
const { isIndexable, frontMatter } = require('./src/rag/chunker');
const shortcuts = require('./src/shortcuts');
const { moveSettingsTextToNotes } = require('./src/migrate');
const { SLOTS, NOTE, slotById, planPinned, moveLooseFilesIntoSections } = require('./src/slots');

if (process.env.MC_USER_DATA) app.setPath('userData', process.env.MC_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('io.github.wenjun78.meetingcopilot');

// One copy at a time: a second launch (double-clicking the shortcut again) brings the open window forward.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.restore(); win.focus(); } });

// net.fetch follows the system proxy settings, which matters on managed work laptops.
const netFetch = (url, init) => net.fetch(url, init);

let win, config, kb, llm, copilot, ocr;
let chosenSourceId = null;      // screen/window picked in the renderer for the next capture
let chosenDisplayId = null;
let compactRestore = null;
let maxRestore = null;          // window bounds before maximising, to restore down to

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
  applyOnTop();
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(Math.max(0.35, Math.min(1, config.get().ui.opacity || 1)));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Right-click: cut, copy and paste in text boxes; copy for selected text anywhere else.
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.isEditable) {
      items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste },
        { type: 'separator' }, { role: 'selectAll', enabled: p.editFlags.canSelectAll });
    } else if (p.selectionText && p.selectionText.trim()) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  let saveTimer;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isMinimized() || compactRestore || maxRestore) return;
      config.update({ ui: { bounds: win.getBounds() } });
    }, 500);
  };
  win.on('resize', remember); win.on('move', remember);
  win.on('maximize', () => send('window', { maximized: true }));
  win.on('unmaximize', () => { maxRestore = null; send('window', { maximized: false }); });
  win.on('closed', () => { win = null; });
}

// Links come from indexed content and API responses, so only web links are opened, and
// local files only when they sit inside a folder the user added themselves.
// Staying above other windows is what makes this usable beside a full-screen meeting, but it
// is the user's choice: with it off this behaves like any other window.
function applyOnTop() {
  if (!win || win.isDestroyed()) return;
  if (config.get().ui.onTop !== false) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

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
  return { config: c, saved, labels, platform: process.platform, encrypted: safeStorage.isEncryptionAvailable(), version: app.getVersion(), updates: updater.supported };
}

// ---- knowledge sources ------------------------------------------------------

// Files added through the app are copied here, so they keep working if the originals move.
const myFilesDir = () => path.join(app.getPath('userData'), 'my-files');

// ---- sections: About me, CV, JD, Instructions, Portfolio -------------------------------

const slotDir = (slot) => path.join(myFilesDir(), slot.dir);
const syncMine = () => (fs.existsSync(myFilesDir()) ? syncOrigin({ kind: 'folder', spec: myFilesDir() }) : Promise.resolve([]));

// What a section holds: the text typed into it and the files added to it.
function slotInfo(slot) {
  const dir = slotDir(slot);
  let text = '';
  try { text = frontMatter(fs.readFileSync(path.join(dir, NOTE), 'utf8')).body.trim(); } catch { /* nothing typed yet */ }
  let files = [];
  try {
    const sourceId = `folder:${myFilesDir()}`;
    files = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name !== NOTE)
      .map(e => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size, ...kb.fileFacts(sourceId, `${slot.label}/${e.name}`) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { /* no folder yet */ }
  return { id: slot.id, label: slot.label, title: slot.title, searched: !!slot.searched, text, files };
}

// Readable files inside a folder (and its sub-folders), for sections that take files flat.
function filesUnder(dir, out = [], depth = 0) {
  if (depth > 4 || out.length > 300) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(full, out, depth + 1); else if (e.isFile()) out.push(full);
  }
  return out;
}

// Copies files into a section. A folder dropped on Portfolio becomes a source that stays in
// step with that folder; anywhere else its readable files are copied in.
async function addToSlot(slot, paths) {
  const dir = slotDir(slot);
  const added = [], skipped = [], folders = [];
  const queue = [];
  for (const p of paths || []) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (slot.searched) { await syncOrigin({ kind: 'folder', spec: p }); folders.push(path.basename(p)); }
      else queue.push(...filesUnder(p));
    } else if (st.isFile()) queue.push(p);
  }
  for (const p of queue) {
    const name = path.basename(p);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { continue; }
    if (name === NOTE || !isIndexable(name, size)) { skipped.push(name); continue; }
    fs.mkdirSync(dir, { recursive: true });
    if (path.resolve(p) !== path.join(dir, name)) fs.copyFileSync(p, path.join(dir, name));
    added.push(name);
  }
  if (added.length) await syncMine();
  return { added, skipped, folders, slot: slotInfo(slot) };
}

// Sources as the window needs them: the app's own files are marked, since the sections show them.
function publicStats() {
  const stats = kb.stats();
  for (const src of stats.sources) src.mine = !!(src.origin && src.origin.spec === myFilesDir());
  return stats;
}

// Reads one origin (a repo, every repo of a user, a URL or a folder) into the index.
// quiet: a background refresh. Sources that have not changed are skipped without being
// downloaded again, and nothing is reported unless something actually changed.
async function syncOriginNow(origin, { quiet = false } = {}) {
  const cfg = config.get();
  const added = [];
  const progress = (message) => { if (!quiet) send('kb', { type: 'progress', message }); };
  const keep = (result) => {
    const known = kb.sources[result.id];
    if (result.unchanged || (quiet && known && known.version && known.version === result.version)) { kb.touch(result.id); return; }
    kb.setSource(result, origin); added.push(result);
  };
  if (origin.kind === 'github') {
    const opts = { token: cfg.github.token, fetchFn: netFetch, apiBase: (cfg.github.apiBase || 'https://api.github.com').replace(/\/+$/, '') };
    const spec = github.parseRepoSpec(origin.spec);
    const specs = spec.repo ? [spec] : await github.listRepos(spec.owner, opts);
    if (!specs.length) throw new Error(`No repositories found for "${spec.owner}".`);
    for (const [i, s] of specs.entries()) {
      progress(`Reading ${s.owner}/${s.repo} (${i + 1} of ${specs.length})`);
      try {
        const known = kb.sources[github.specId(s)];
        keep(await github.fetchRepo(s, { ...opts, knownVersion: quiet && known ? known.version : '' }));
      } catch (e) {
        if (specs.length === 1) throw e;
        if (!quiet) send('notice', { level: 'error', message: `${s.owner}/${s.repo}: ${e.message}` });
      }
    }
  } else if (origin.kind === 'url') {
    progress(`Fetching ${origin.spec}`);
    const result = await api.ingestUrl(origin.spec, { auth: cfg.api, fetchFn: netFetch });
    if (!result.chunks.length) throw new Error('That URL returned nothing readable.');
    keep(result);
  } else if (origin.kind === 'folder') {
    const mine = origin.spec === myFilesDir();
    progress(mine ? 'Reading your notes and files' : `Reading ${origin.spec}`);
    const result = await ingestFolder(origin.spec, { sections: mine });
    if (mine) result.label = 'Your notes and files';
    if (!result.chunks.length) {
      if (!mine) throw new Error('No readable text, code, PDF or Word files in that folder.');
      kb.removeSource(result.id); added.push({ label: result.label, files: 0, chunks: [] }); // everything was removed
    } else keep(result);
  }
  if (added.length) await embedIfConfigured();
  kb.save();
  if (added.length || !quiet) send('kb', { type: 'changed', stats: publicStats() });
  return added.map(r => ({ label: r.label, files: r.files, chunks: r.chunks.length }));
}

// Syncs run one at a time, whether started by the user or by the background refresh.
let syncQueue = Promise.resolve();
function syncOrigin(origin, opts) {
  const run = syncQueue.then(() => syncOriginNow(origin, opts));
  syncQueue = run.catch(() => {});
  return run;
}

function uniqueOrigins(sources) {
  const origins = new Map();
  for (const s of sources) if (s.origin) origins.set(s.origin.kind + '|' + s.origin.spec, s.origin);
  return [...origins.values()];
}

// Background refresh: shortly after launch and then every half hour, but never during a
// meeting, when the network and CPU are needed for the call.
const background = { started: false };
let meetingOn = false;
let autoSyncFailure = '';
// force: the one refresh made as a meeting starts, so the CV and job description are current.
async function autoSync({ force = false } = {}) {
  if (!config.get().autoSync || (meetingOn && !force)) return { skipped: true };
  let updated = 0;
  const failures = [];
  for (const origin of uniqueOrigins(Object.values(kb.sources))) {
    if (meetingOn && !force) break;
    try { updated += (await syncOrigin(origin, { quiet: true })).length; } catch (e) { failures.push(`${origin.spec}: ${e.message}`); }
  }
  // Report a failure once, not every half hour.
  const failure = failures.join(' ');
  if (failure && failure !== autoSyncFailure) send('notice', { level: 'error', message: `Could not refresh some sources. ${failure}` });
  autoSyncFailure = failure;
  if (!updated) send('kb', { type: 'changed', stats: publicStats() }); // shows the new "checked" time
  return { updated, failures };
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

// ---- app updates ---------------------------------------------------------------

// The installed Windows app updates itself from the GitHub releases of this repository:
// it checks shortly after launch and every few hours, downloads in the background (never
// during a meeting) and installs when the app is closed. The portable exe and source runs
// do not update themselves.
const updater = { supported: false, state: 'off', version: '', error: '', pending: false, asked: false, lib: null };

function setupUpdates() {
  updater.supported = app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE;
  if (!updater.supported) return;
  const { autoUpdater } = require('electron-updater');
  updater.lib = autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('update-available', (info) => { updater.state = 'available'; updater.version = info.version; updater.pending = true; downloadUpdate(); });
  autoUpdater.on('update-not-available', () => { updater.state = 'current'; });
  autoUpdater.on('update-downloaded', (info) => {
    updater.state = 'ready'; updater.version = info.version; updater.pending = false;
    send('notice', { level: 'info', message: `Version ${info.version} is downloaded. It installs when you close the app.` });
  });
  autoUpdater.on('error', (e) => { updater.state = 'error'; updater.error = String(e && e.message || e).split('\n')[0]; });
  setTimeout(() => checkForUpdate(), 20000);
  setInterval(() => checkForUpdate(), 4 * 60 * 60 * 1000);
}

function downloadUpdate() {
  if (!updater.pending || meetingOn || process.env.MC_E2E || !(config.get().autoUpdate || updater.asked)) return;
  updater.pending = false;
  updater.state = 'downloading';
  updater.lib.downloadUpdate().catch(() => { updater.pending = true; });
}

// -> { supported, state, version?, error? }
async function checkForUpdate({ manual = false } = {}) {
  if (!updater.supported) return { supported: false, state: 'off' };
  if (!manual && (!config.get().autoUpdate || meetingOn)) return { supported: true, state: updater.state };
  if (manual) updater.asked = true; // asking by hand also downloads, even with automatic installs off
  try {
    const r = await updater.lib.checkForUpdates();
    if (r && r.updateInfo) updater.version = r.updateInfo.version;
  } catch (e) { updater.state = 'error'; updater.error = String(e && e.message || e).split('\n')[0]; }
  return { supported: true, state: updater.state, version: updater.version, error: updater.state === 'error' ? updater.error : undefined };
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
      embedIfConfigured().then(() => { kb.save(); send('kb', { type: 'changed', stats: publicStats() }); });
    }
    return publicConfig();
  });

  // While a shortcut field is being edited the shortcuts are released, so the keys reach the field.
  handle('shortcuts:suspend', (on) => { if (on) globalShortcut.unregisterAll(); else registerShortcuts(); return true; });
  handle('shortcuts:check', (accel) => ({ label: shortcuts.pretty(accel), problem: shortcuts.problem(accel) }));

  handle('update:check', () => checkForUpdate({ manual: true }));
  handle('kb:stats', () => publicStats());
  handle('kb:add', async (text) => {
    const spec = String(text || '').trim();
    if (!spec) throw new Error('Enter a GitHub repository (owner/repo) or a URL.');
    if (/^https?:\/\/([\w-]+\.)?linkedin\.com\//i.test(spec)) {
      throw new Error('LinkedIn does not let apps read profiles. On your profile choose More > Save to PDF, then add that file with "Add files".');
    }
    if (/^https?:\/\/([\w-]+\.)?(researchgate\.net|academia\.edu)\//i.test(spec)) {
      throw new Error('That site does not let apps read its pages. Download the PDF of the paper and add the file here instead.');
    }
    const pagesSite = /^https?:\/\/[\w-]+\.github\.io(\/|$)/i.test(spec);
    const isUrl = /^https?:\/\//i.test(spec) && !pagesSite && !/^https?:\/\/(www\.)?github\.com\//i.test(spec);
    if (pagesSite) {
      // Read the whole repository behind a GitHub Pages site; if it cannot be found under the
      // expected name, fall back to reading the one page at that address.
      const { owner, repo } = github.parseRepoSpec(spec);
      try { return await syncOrigin({ kind: 'github', spec: `${owner}/${repo}` }); }
      catch (e) { if (!/not found/i.test(e.message)) throw e; return syncOrigin({ kind: 'url', spec }); }
    }
    return syncOrigin({ kind: isUrl ? 'url' : 'github', spec });
  });
  handle('kb:addFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Add a folder of notes or code' });
    if (r.canceled || !r.filePaths[0]) return null;
    return syncOrigin({ kind: 'folder', spec: r.filePaths[0] });
  });
  handle('slot:list', () => SLOTS.map(slotInfo));
  handle('slot:get', (id) => { const slot = slotById(id); if (!slot) throw new Error('Unknown section.'); return slotInfo(slot); });
  handle('slot:save', async (id, text) => {
    const slot = slotById(id);
    if (!slot) throw new Error('Unknown section.');
    const body = String(text || '').trim();
    if (Buffer.byteLength(body) > 380000) throw new Error('That is more text than one section can hold (about 60,000 words). Put the long material in a file instead.');
    const file = path.join(slotDir(slot), NOTE);
    if (body) { fs.mkdirSync(slotDir(slot), { recursive: true }); fs.writeFileSync(file, body + '\n'); }
    else fs.rmSync(file, { force: true });
    await syncMine();
    return slotInfo(slot);
  });
  handle('slot:addFiles', async (id, paths) => {
    const slot = slotById(id);
    if (!slot) throw new Error('Unknown section.');
    if (!Array.isArray(paths)) {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: `Add files to ${slot.title}`,
        filters: [{ name: 'Documents and notes', extensions: ['pdf', 'docx', 'md', 'txt', 'html', 'ipynb', 'py', 'sql', 'json', 'csv'] }, { name: 'All files', extensions: ['*'] }] });
      if (r.canceled || !r.filePaths.length) return null;
      paths = r.filePaths;
    }
    const out = await addToSlot(slot, paths.filter(p => typeof p === 'string' && p));
    if (!out.added.length && !out.folders.length && out.skipped.length) throw new Error(`Could not read ${out.skipped.join(', ')}. Use PDF, Word, Markdown or text files.`);
    return out;
  });
  handle('slot:removeFile', async (id, name) => {
    const slot = slotById(id);
    if (!slot) throw new Error('Unknown section.');
    const safe = path.basename(String(name || ''));
    if (!safe || safe === NOTE) throw new Error('Nothing to remove.');
    fs.rmSync(path.join(slotDir(slot), safe), { force: true }); // the app's copy; the original file is untouched
    await syncMine();
    return slotInfo(slot);
  });
  // Everything the answers can draw on: what is sent every time, and every searchable file.
  handle('kb:inventory', () => {
    const lean = config.get().answerContext === 'lean';
    const always = planPinned(kb.pinned(), lean ? { total: 6000, perNote: 2500 } : undefined)
      .map(n => ({ title: n.title, path: n.path, slot: n.slot || '', sourceId: n.sourceId, chars: n.chars || n.text.length, sent: n.sent }));
    return { always, searched: kb.inventory(), passages: kb.chunks.length, lean };
  });
  handle('kb:fileText', ({ sourceId, path: filePath } = {}) => {
    const text = kb.fileText(String(sourceId), String(filePath));
    return { text: text.slice(0, 8000), more: Math.max(0, text.length - 8000) };
  });
  handle('kb:openFolder', (id) => {
    const src = kb.sources[id];
    if (src && src.origin && src.origin.kind === 'folder') shell.openPath(src.origin.spec);
    return true;
  });
  handle('kb:remove', (id) => {
    const src = kb.sources[id];
    if (src && src.origin && src.origin.spec === myFilesDir()) throw new Error('Remove your own notes and files from their section.');
    kb.removeSource(id); kb.save(); return publicStats();
  });
  handle('kb:sync', async (id) => {
    const all = Object.values(kb.sources);
    const failures = [];
    for (const origin of uniqueOrigins(id ? all.filter(x => x.id === id) : all)) {
      try { await syncOrigin(origin); } catch (e) { failures.push(`${origin.spec}: ${e.message}`); }
    }
    if (failures.length) throw new Error(failures.join(' '));
    return publicStats();
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
  handle('meeting:listening', (on) => {
    const starting = !!on && !meetingOn;
    meetingOn = !!on;
    if (starting) autoSync({ force: true }).catch(() => {}); // not awaited: listening starts immediately
    if (!on) downloadUpdate(); // an update found during the meeting is fetched once it ends
    return true;
  });
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
  // Maximise, or restore down. The bounds from before are kept here as well, because a
  // frameless window does not always report or restore its own state reliably.
  handle('win:maximize', () => {
    if (win.isMaximized() || maxRestore) {
      const back = maxRestore; maxRestore = null;
      if (win.isMaximized()) win.unmaximize();
      if (back) setTimeout(() => { if (win && !win.isDestroyed() && !win.isMaximized()) win.setBounds(back); }, 60);
      send('window', { maximized: false });
      return false;
    }
    maxRestore = win.getBounds();
    win.maximize();
    send('window', { maximized: true });
    return true;
  });
  handle('win:onTop', (on) => { config.update({ ui: { onTop: !!on } }); applyOnTop(); return config.get().ui.onTop; });
  handle('win:close', () => win.close());
  handle('win:compact', (on) => {
    if (on && !compactRestore) {
      if (win.isMaximized()) win.unmaximize();
      if (maxRestore) { win.setBounds(maxRestore); maxRestore = null; send('window', { maximized: false }); }
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
  if (!firstInstance) return;
  const dir = app.getPath('userData');
  const crypto = safeStorage.isEncryptionAvailable()
    ? { encrypt: s => safeStorage.encryptString(s).toString('base64'), decrypt: s => safeStorage.decryptString(Buffer.from(s, 'base64')) }
    : null;
  config = new ConfigStore(path.join(dir, 'config.json'), crypto);
  config.load();
  kb = new KnowledgeBase(path.join(dir, 'knowledge')).load();
  kb.boost = { [`folder:${myFilesDir()}`]: 1.5 }; // what the user added by hand outranks bulk repository content
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

  // Bring notes from earlier versions into the sections: the old Settings boxes first, then
  // loose files, then read the app's own files again so the sections take effect.
  try {
    moveSettingsTextToNotes(config, myFilesDir());
    moveLooseFilesIntoSections(myFilesDir());
    syncMine().catch(() => {});
  } catch { /* tried again next launch */ }

  // Background jobs: refresh sources shortly after launch and every half hour; look for app updates.
  setupUpdates();
  setTimeout(() => autoSync(), 8000);
  setInterval(() => autoSync(), 30 * 60 * 1000);
  background.started = true;

  const failed = registerShortcuts();
  if (failed.length) win.webContents.once('did-finish-load', () => send('notice', { level: 'error', message: shortcutFailure(failed) }));

  if (process.env.MC_E2E) require(path.resolve(process.env.MC_E2E))({ app, win, copilot, kb, config, syncOrigin, autoSync, checkForUpdate, background, globalShortcut, runShortcut, slotInfo, publicStats });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocr) ocr.stop(); });
app.on('window-all-closed', () => app.quit());
