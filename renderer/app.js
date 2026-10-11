'use strict';
/* global Capture */
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};
async function call(channel, ...args) {
  const r = await window.mc.call(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const state = {
  cfg: null, saved: {}, platform: '', listening: false, startedAt: 0, clockTimer: null,
  answer: { id: 0, text: '', sources: [], status: 'idle' },
  kb: { sources: [], chunks: 0 }, raf: 0,
};

// ---- toasts -----------------------------------------------------------------
function toast(message, level = 'info') {
  const t = el('div', { class: `toast ${level}`, text: message, role: level === 'error' ? 'alert' : 'status' });
  t.addEventListener('click', () => t.remove());
  $('toasts').append(t);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => t.remove(), level === 'error' ? 12000 : 5000);
}
const fail = (e) => toast(e.message || String(e), 'error');

// ---- cue card ---------------------------------------------------------------
function inline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|\[\d+\]|`[^`]+`)/)) {
    if (!part) continue;
    let m;
    if ((m = /^\*\*([^*]+)\*\*$/.exec(part))) parent.append(el('strong', { text: m[1] }));
    else if ((m = /^`([^`]+)`$/.exec(part))) parent.append(el('code', { text: m[1] }));
    else if ((m = /^\[(\d+)\]$/.exec(part))) {
      const src = state.answer.sources.find(s => s.n === Number(m[1]));
      if (src) parent.append(el('button', { class: 'cite', type: 'button', title: `${src.title}\n${src.snippet}`, text: m[1], onclick: () => openSource(src) }));
      else parent.append(part);
    } else parent.append(part);
  }
}

function renderAnswerText(card, text) {
  card.replaceChildren();
  let list = null, first = true, code = null;
  for (const raw of text.split('\n')) {
    const fence = /^\s*(```|~~~)\s*([\w+#-]*)\s*$/.exec(raw);
    if (fence) {
      if (code) code = null; // closing fence
      else { list = null; code = el('code'); card.append(el('pre', fence[2] ? { 'data-lang': fence[2].toLowerCase() } : {}, code)); }
      continue;
    }
    if (code) { code.append((code.textContent ? '\n' : '') + raw); continue; } // also covers a block still streaming in
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) card.append((list = el('ul')));
      const li = el('li'); inline(li, bullet[1]); list.append(li);
      continue;
    }
    list = null;
    const p = el('p', { class: /^check:/i.test(line) ? 'check' : first ? 'lead' : '' });
    inline(p, line.replace(/^#+\s*/, ''));
    card.append(p); first = false;
  }
}

function renderIdle() {
  const card = $('card');
  const hasKey = state.saved.llmKey || /localhost|127\.0\.0\.1/.test(state.cfg.llm.baseUrl);
  const hasKb = state.kb.chunks > 0;
  card.className = 'card idle';
  card.replaceChildren(
    el('strong', { text: state.listening ? 'Listening. Answers appear here when they ask something.' : 'Answers appear here during your call.' }),
    el('ol', {},
      el('li', { class: hasKey ? 'done' : '', text: 'Add your API key under Settings.' }),
      el('li', { class: hasKb ? 'done' : '', text: 'Add who you are, your CV and your repositories under Knowledge.' }),
      el('li', { class: state.listening ? 'done' : '', text: 'Start listening when the meeting begins.' })));
  $('asked').hidden = true; $('sources').hidden = true; $('copy').hidden = true;
}

function renderAnswer() {
  const a = state.answer, card = $('card');
  if (a.status === 'idle') return renderIdle();
  $('asked').hidden = !a.question && a.mode !== 'screen';
  $('asked').textContent = a.mode === 'typed' ? `You asked: ${a.question}`
    : a.mode === 'screen' ? (a.question ? `About the screen: ${a.question}` : a.reading ? 'Reading the screen' : 'Answering what is on the screen')
      : `They said: ${a.question}`;
  $('asked').className = 'asked' + (a.mode === 'typed' || a.mode === 'screen' ? ' mine' : '');
  if (a.status === 'error') { card.className = 'card fail'; card.textContent = a.error; }
  else if (!a.text) { card.className = 'card wait'; card.textContent = a.sources.length ? 'Writing your answer' : 'Looking through your sources'; }
  else { card.className = 'card'; renderAnswerText(card, a.text); }
  const row = $('sources');
  row.hidden = !a.sources.length;
  row.replaceChildren(...a.sources.map(s => el('button', { class: 'source', type: 'button', title: s.snippet, onclick: () => openSource(s) }, el('b', { text: String(s.n) }), s.title)));
  $('copy').hidden = !(a.status === 'done' && a.text);
}

function openSource(src) {
  if (src.url) call('open:external', src.url).catch(fail);
  else toast(`${src.title}: ${src.snippet}`);
}

window.mc.on('answer', (e) => {
  const a = state.answer;
  if (e.type === 'start') state.answer = { id: e.id, text: '', sources: [], status: 'working', question: e.question, mode: e.mode };
  else if (e.id < a.id) return; // a newer answer has replaced this one
  else if (e.type === 'sources') a.sources = e.sources;
  else if (e.type === 'delta') a.text += e.text;
  else if (e.type === 'done') { a.status = 'done'; a.text = e.text || a.text; }
  else if (e.type === 'error') {
    if (a.status === 'idle' || e.id > a.id) state.answer = { id: e.id, text: '', sources: [], status: 'error', error: e.message };
    else { a.status = 'error'; a.error = e.message; }
  }
  cancelAnimationFrame(state.raf);
  state.raf = requestAnimationFrame(renderAnswer);
});

const ask = (req) => call('answer:ask', req).catch(fail);
$('answerNow').addEventListener('click', () => ask({ mode: 'manual' }));
// Reads the screen as it is at this moment, then answers from it. Anything typed in the
// question box narrows the request ("optimise this query"); empty means "work out what is asked".
async function answerFromScreen() {
  if (state.listening) {
    state.answer = { id: state.answer.id, text: '', sources: [], status: 'working', question: '', reading: true, mode: 'screen' };
    renderAnswer();
    await capture.refreshScreen().catch(() => {});
  }
  ask({ mode: 'screen', question: $('askInput').value.trim() });
}
$('answerScreen').addEventListener('click', answerFromScreen);
$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('askInput').value.trim();
  if (q) { ask({ mode: 'typed', question: q }); $('askInput').value = ''; }
});
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.answer.text.replace(/\s*\[\d+\]/g, ''));
  toast('Answer copied');
});
window.mc.on('hotkey', (e) => {
  if (e.action === 'answer') ask({ mode: 'manual' });
  if (e.action === 'screen') answerFromScreen();
});

// ---- transcript -------------------------------------------------------------
const lines = new Map();
function restyleLines() {
  let prev = null;
  for (const node of $('lines').children) {
    const who = node.dataset.who;
    node.classList.toggle('same', prev === who);
    node.classList.toggle('turn', prev !== null && prev !== who);
    prev = who;
  }
  $('linesEmpty').hidden = $('lines').children.length > 0;
}
window.mc.on('transcript', ({ type, entry }) => {
  const panel = $('tab-transcript');
  const pinned = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
  if (type === 'add') {
    const node = el('div', { class: `line ${entry.who} pending`, 'data-who': entry.who }, el('span', { class: 'who', text: entry.who === 'them' ? 'Them' : 'You' }), el('p', { text: '…' }));
    lines.set(entry.id, node); $('lines').append(node);
  } else if (type === 'update') {
    const node = lines.get(entry.id);
    if (node) { node.classList.remove('pending'); node.lastChild.textContent = entry.text; }
  } else if (type === 'remove') {
    const node = lines.get(entry.id);
    if (node) { node.remove(); lines.delete(entry.id); }
  }
  restyleLines();
  if (pinned) panel.scrollTop = panel.scrollHeight;
});
$('resetBtn').addEventListener('click', async () => {
  await call('meeting:reset').catch(fail);
  lines.clear(); $('lines').replaceChildren(); restyleLines();
  state.answer = { id: state.answer.id, text: '', sources: [], status: 'idle' }; renderAnswer();
});
$('exportBtn').addEventListener('click', async () => {
  try { const p = await call('meeting:export'); if (p) toast(`Transcript saved to ${p}`); } catch (e) { fail(e); }
});

// ---- listening --------------------------------------------------------------
const levels = { them: 0, you: 0 };
const capture = window.capture = new Capture({
  onSegment: (who, wav, ms) => { window.mc.call('stt:segment', who, wav, ms); },
  onLevel: (who, rms) => { levels[who] = Math.max(rms, levels[who] * 0.8); },
  onSpeaking: (who, on) => { window.mc.call('stt:speaking', who, on); },
  onScreenText: (text) => {
    $('screenText').textContent = text; $('screenEmpty').hidden = true;
    const words = text ? text.split(/\s+/).length : 0;
    $('screenState').textContent = words ? `Screen: ${words} words read` : 'Screen: no text found';
  },
  onScreenFrame: (canvas) => {
    const p = $('screenPreview'); p.hidden = false;
    p.width = 480; p.height = Math.round(480 * canvas.height / canvas.width);
    p.getContext('2d').drawImage(canvas, 0, 0, p.width, p.height);
  },
  onEnded: (reason) => { toast(reason, 'error'); if (/screen|window/i.test(reason)) $('screenState').textContent = 'Screen: stopped'; },
});
setInterval(() => {
  if (!state.listening) return;
  for (const who of ['them', 'you']) $(who === 'them' ? 'lvThem' : 'lvYou').style.width = Math.min(100, Math.sqrt(levels[who]) * 260) + '%';
}, 100);

function setListening(on) {
  state.listening = on;
  window.mc.call('meeting:listening', on);
  document.body.classList.toggle('listening', on);
  $('toggle').textContent = on ? 'Stop' : 'Start listening';
  $('toggle').classList.toggle('primary', !on);
  $('meters').hidden = !on;
  clearInterval(state.clockTimer);
  if (on) {
    state.startedAt = Date.now();
    const tick = () => { const s = Math.floor((Date.now() - state.startedAt) / 1000); $('clock').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    tick(); state.clockTimer = setInterval(tick, 1000);
  } else $('clock').textContent = '';
  if (state.answer.status === 'idle') renderIdle();
}

async function begin(sourceId) {
  $('picker').hidden = true;
  $('toggle').disabled = true;
  try {
    const { systemAudio } = await call('capture:select', sourceId);
    const c = state.cfg.capture;
    const res = await capture.start({ micDeviceId: c.micDeviceId, themSource: c.themSource || 'system', wantScreen: !!sourceId, systemAudio, ocrIntervalSec: c.ocrIntervalSec });
    for (const p of res.problems) toast(p, 'error');
    document.querySelector('.meter.them').classList.toggle('off', !res.them);
    document.querySelector('.meter.you').classList.toggle('off', !res.mic);
    $('screenState').textContent = res.screen ? 'Screen: reading' : 'Screen: off';
    if (!res.screen) { $('screenPreview').hidden = true; $('screenText').textContent = ''; $('screenEmpty').hidden = false; call('ocr:clear'); }
    setListening(res.mic || res.them || res.screen);
    fillDevices();
  } catch (e) { fail(e); setListening(false); }
  $('toggle').disabled = false;
}

async function openPicker() {
  const hasKey = state.saved.llmKey || /localhost|127\.0\.0\.1/.test(state.cfg.llm.baseUrl);
  if (!hasKey) { showTab('settings'); $('s-llm-key').focus(); return toast('Add your API key first. Speech and answers both need it.', 'error'); }
  let sources = [];
  try { sources = await call('capture:sources'); } catch (e) { fail(e); }
  $('pickerGrid').replaceChildren(...sources.map(s => el('button', { class: 'pick', type: 'button', onclick: () => begin(s.id) },
    s.thumbnail ? el('img', { src: s.thumbnail, alt: '' }) : el('img', { alt: '' }),
    el('span', { text: s.name }), el('small', { text: s.kind === 'screen' ? 'Whole screen' : 'Window' }))));
  $('pickerEmpty').hidden = sources.length > 0;
  $('picker').hidden = false;
  const first = $('pickerGrid').querySelector('button') || $('pickNone');
  first.focus();
}
$('toggle').addEventListener('click', async () => {
  if (state.listening) { await capture.stop(); setListening(false); } else openPicker();
});
$('pickNone').addEventListener('click', () => begin(null));
$('pickCancel').addEventListener('click', () => { $('picker').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('picker').hidden = true; });

// ---- tabs and window --------------------------------------------------------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `tab-${name}`;
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
$('min').addEventListener('click', () => call('win:minimize'));
$('max').addEventListener('click', () => call('win:maximize'));
$('close').addEventListener('click', () => call('win:close'));
$('compact').addEventListener('click', async () => {
  const on = await call('win:compact', !document.body.classList.contains('compact'));
  document.body.classList.toggle('compact', on);
  $('compact').setAttribute('aria-pressed', String(on));
});
document.querySelector('.bar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) call('win:maximize'); });
window.mc.on('window', (w) => { $('max').title = w.maximized ? 'Restore' : 'Maximise'; });
window.mc.on('notice', (n) => toast(n.message, n.level));

// ---- knowledge --------------------------------------------------------------
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function renderKb(stats) {
  state.kb = stats;
  $('kbEmpty').hidden = stats.sources.length > 0;
  $('kbList').replaceChildren(...stats.sources.map(s => el('li', {},
    el('span', { class: 'label', title: s.label, text: s.label }),
    s.origin && s.origin.kind === 'folder'
      ? el('button', { class: 'btn quiet', type: 'button', text: 'Open', title: 'Open the folder to edit or delete files', onclick: () => call('kb:openFolder', s.id).catch(fail) })
      : el('button', { class: 'btn quiet', type: 'button', text: 'Sync', onclick: () => kbRun(() => call('kb:sync', s.id), `${s.label} synced`) }),
    el('button', { class: 'btn quiet', type: 'button', text: 'Remove', onclick: async () => renderKb(await call('kb:remove', s.id)) }),
    el('span', { class: 'meta', text: `${s.files} ${s.files === 1 ? 'file' : 'files'}, ${s.chunkCount} passages, updated ${ago(s.syncedAt)}${s.checkedAt && s.checkedAt - s.syncedAt > 60000 ? `, checked ${ago(s.checkedAt)}` : ''}` }),
    s.pinned && s.pinned.length ? el('span', { class: 'meta pin', text: `Always included: ${s.pinned.join(', ')}` }) : null)));
  const pins = stats.sources.flatMap(x => x.pinned || []);
  $('contextPins').textContent = pins.length
    ? `Sent with every answer: ${pins.map(p => p.split('/').pop().replace(/\.md$/, '')).join(', ')}. Everything else is searched when a question relates to it.`
    : 'Start with "Write a note" > About me. Notes you mark are sent with every answer; everything else is searched when a question relates to it.';
  $('kbStatus').textContent = stats.chunks ? `${stats.chunks} passages${stats.embedded ? `, ${stats.embedded} with embeddings` : ''}` : '';
  if (state.answer.status === 'idle') renderIdle();
}
async function kbRun(fn, doneMessage) {
  for (const b of document.querySelectorAll('#tab-knowledge button')) b.disabled = true;
  try {
    const r = await fn();
    if (r === null) return;
    const msg = typeof doneMessage === 'function' ? doneMessage(r) : doneMessage;
    if (msg) toast(msg);
    renderKb(await call('kb:stats'));
  } catch (e) { fail(e); renderKb(await call('kb:stats')); } finally {
    for (const b of document.querySelectorAll('#tab-knowledge button')) b.disabled = false;
  }
}
const addedMessage = (list) => (list.length === 1
  ? `Added ${list[0].label}: ${list[0].chunks} passages from ${list[0].files} files`
  : `Added ${list.length} repositories, ${list.reduce((n, x) => n + x.chunks, 0)} passages`);
$('kbForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('kbInput').value.trim();
  if (v) kbRun(() => call('kb:add', v), (r) => { $('kbInput').value = ''; return addedMessage(r); });
});
const filesMessage = (r) => {
  const parts = [];
  if (r.added.length) parts.push(addedMessage(r.added).replace(/^Added My files: (\d+) passages from (\d+) files$/, 'Your files are in: $2 files, $1 passages'));
  if (r.skipped.length) parts.push(`Skipped (not a readable type): ${r.skipped.join(', ')}`);
  return parts.join('. ');
};
$('kbFiles').addEventListener('click', () => kbRun(() => call('kb:addFiles', null), filesMessage));
// The note form: write or paste a note, choose whether it rides along with every answer or
// is searched like the rest. Picking a name that already exists loads it for editing.
const note = { byName: false };
function noteHint() {
  const on = $('kbPasteAlways').checked;
  $('kbPasteHint').textContent = note.byName ? 'A note with this name is always sent with every answer (the first 6,000 characters).'
    : on ? 'Sent with every answer (the first 6,000 characters). For instructions, the job description, who you are.'
      : 'Searched when a question relates to it. For a CV, project notes, anything long.';
}
async function loadNote(name, always) {
  $('kbPasteName').value = name;
  for (const c of document.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c.dataset.note === name));
  let info = { exists: false, alwaysByName: false };
  try { info = await call('kb:noteInfo', name); } catch { /* treat as a new note */ }
  note.byName = !!info.alwaysByName;
  if (info.exists) $('kbPasteText').value = info.text;
  $('kbPasteAlways').checked = info.exists ? info.always : (note.byName || always);
  $('kbPasteAlways').disabled = note.byName;
  noteHint();
  $('kbPasteText').focus();
}
function showPaste(on) {
  $('kbPasteForm').hidden = !on;
  $('kbPaste').setAttribute('aria-expanded', String(on));
  if (on) { noteHint(); $('kbPasteName').focus(); }
}
$('kbPaste').addEventListener('click', () => showPaste($('kbPasteForm').hidden));
$('kbPasteCancel').addEventListener('click', () => showPaste(false));
for (const c of document.querySelectorAll('.chip')) c.addEventListener('click', () => loadNote(c.dataset.note, c.dataset.always === '1'));
$('kbPasteName').addEventListener('change', () => { const n = $('kbPasteName').value.trim(); if (n) loadNote(n, $('kbPasteAlways').checked); });
$('kbPasteAlways').addEventListener('change', noteHint);
$('kbPasteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('kbPasteName').value.trim(), text = $('kbPasteText').value;
  if (!text.trim()) { $('kbPasteText').focus(); return toast('Write or paste some text first.', 'error'); }
  kbRun(() => call('kb:addText', { name, text, always: $('kbPasteAlways').checked }), (r) => {
    $('kbPasteName').value = ''; $('kbPasteText').value = ''; showPaste(false);
    for (const c of document.querySelectorAll('.chip')) c.setAttribute('aria-pressed', 'false');
    return `${r.replaced ? 'Updated' : 'Saved'} "${r.file.replace(/\.md$/, '')}": ${r.always ? 'sent with every answer' : 'searched when relevant'}`;
  });
});
// Files and folders can also be dropped anywhere on the window.
window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map(f => window.mc.pathFor(f)).filter(Boolean);
  if (!paths.length) return;
  showTab('knowledge');
  kbRun(() => call('kb:addFiles', paths), filesMessage);
});
$('kbFolder').addEventListener('click', () => kbRun(() => call('kb:addFolder'), addedMessage));
$('kbSyncAll').addEventListener('click', () => kbRun(() => call('kb:sync', null), 'All sources synced'));
$('kbAuto').addEventListener('change', async () => {
  try { const r = await call('config:set', { autoSync: $('kbAuto').checked }); state.cfg = r.config; } catch (e) { fail(e); }
});
$('kbTry').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const hits = await call('kb:search', $('kbTryInput').value);
    $('kbHits').replaceChildren(...(hits.length ? hits.map(h => el('li', {}, el('b', { text: h.title }), el('span', { text: h.snippet })))
      : [el('li', {}, el('span', { text: 'Nothing matched. Try the words they would use in the meeting.' }))]));
  } catch (err) { fail(err); }
});
window.mc.on('kb', (e) => {
  if (e.type === 'progress') $('kbStatus').textContent = e.message;
  if (e.type === 'changed') renderKb(e.stats);
});

// ---- settings ---------------------------------------------------------------
async function fillDevices() {
  let inputs = [];
  try { inputs = await capture.listInputs(); } catch { /* no device access yet */ }
  const c = state.cfg.capture;
  const opt = (value, text) => el('option', { value, text });
  $('s-mic').replaceChildren(opt('', 'System default'), ...inputs.filter(d => d.id !== 'default' && d.id !== 'communications').map(d => opt(d.id, d.label)));
  $('s-them').replaceChildren(opt('system', state.platform === 'win32' ? 'System audio: everything you hear' : 'System audio (Windows only)'),
    ...inputs.filter(d => d.id !== 'default' && d.id !== 'communications').map(d => opt(d.id, d.label)));
  $('s-mic').value = c.micDeviceId || ''; if ($('s-mic').selectedIndex < 0) $('s-mic').value = '';
  $('s-them').value = c.themSource || 'system'; if ($('s-them').selectedIndex < 0) $('s-them').value = 'system';
  $('themHint').textContent = state.platform === 'win32'
    ? 'Use headphones so your microphone does not pick up the other side.'
    : 'On macOS and Linux, pick a loopback device here (BlackHole, or a PulseAudio/PipeWire monitor) so the other side can be heard.';
}
function fillSettings() {
  const c = state.cfg, s = state.saved;
  const keyHint = (has) => (has ? 'Saved. Type to replace.' : '');
  $('s-llm-base').value = c.llm.baseUrl; $('s-llm-model').value = c.llm.model; $('s-llm-key').placeholder = keyHint(s.llmKey) || 'gsk_...';
  $('s-llm-extra').value = JSON.stringify(c.llm.extra || {});
  $('s-stt-model').value = c.stt.model; $('s-stt-lang').value = c.stt.language; $('s-stt-vocab').value = c.stt.vocabulary;
  $('s-stt-base').value = c.stt.baseUrl; $('s-stt-key').placeholder = keyHint(s.sttKey);
  $('s-auto').checked = c.autoAnswer === 'questions'; $('s-length').value = c.answerLength;
  $('s-ocr-int').value = String(c.capture.ocrIntervalSec); $('s-ocr-langs').value = c.capture.ocrLangs;
  $('s-gh-token').placeholder = keyHint(s.githubToken); $('s-gh-api').value = c.github.apiBase;
  $('s-api-url').value = c.api.searchUrl; $('s-api-hname').value = c.api.headerName; $('s-api-hvalue').placeholder = keyHint(s.apiHeader);
  $('s-embed-model').value = c.embed.model; $('s-embed-base').value = c.embed.baseUrl; $('s-embed-key').placeholder = keyHint(s.embedKey);
  $('s-opacity').value = String(c.ui.opacity || 1);
  $('kbAuto').checked = c.autoSync !== false;
  $('s-update').checked = c.autoUpdate !== false;
  for (const [action, id] of SHORTCUT_FIELDS) setShortcutField($(id), c.shortcuts[action] || '', state.labels[action] || '');
  applyShortcutLabels();
  for (const id of ['s-llm-key', 's-stt-key', 's-gh-token', 's-api-hvalue', 's-embed-key']) $(id).value = '';
}
$('updateCheck').addEventListener('click', async () => {
  $('versionNote').textContent = 'Checking';
  try {
    const r = await call('update:check');
    $('versionNote').textContent = !r.supported ? `Version ${state.version}. This copy does not update itself; get new versions from the Releases page.`
      : r.state === 'error' ? `Could not check: ${r.error}`
        : r.state === 'current' ? `Version ${state.version} is the latest.`
          : r.state === 'ready' ? `Version ${r.version} is downloaded and installs when you close the app.`
            : r.state === 'downloading' ? `Version ${r.version} is being downloaded.`
              : `Version ${r.version} is available. It downloads once you are not in a meeting.`;
  } catch (e) { $('versionNote').textContent = ''; fail(e); }
});

// Shortcut fields record the keys pressed in them instead of taking typed text.
const SHORTCUT_FIELDS = [['answer', 's-key-answer'], ['screen', 's-key-screen'], ['toggle', 's-key-toggle']];
function setShortcutField(input, accel, label) { input.dataset.accel = accel; input.value = label || (accel ? accel : ''); }
async function checkShortcutField(input) {
  const hint = $('keyHint');
  if (!input.dataset.accel) { hint.textContent = ''; return; }
  const r = await call('shortcuts:check', input.dataset.accel);
  input.value = r.label || input.dataset.accel;
  const twin = SHORTCUT_FIELDS.map(([, id]) => $(id)).find(o => o !== input && o.dataset.accel === input.dataset.accel);
  hint.textContent = twin ? `${r.label} is set twice. Each action needs its own keys.` : r.problem ? `${r.label}: ${r.problem} Pick something else.` : `${r.label} is free in Teams, Zoom, Meet and Webex.`;
  hint.classList.toggle('warn', !!(twin || r.problem));
}
for (const [, id] of SHORTCUT_FIELDS) {
  const input = $(id);
  input.addEventListener('focus', () => call('shortcuts:suspend', true));
  input.addEventListener('blur', () => call('shortcuts:suspend', false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Escape') { setShortcutField(input, '', ''); $('keyHint').textContent = ''; return; }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return; // wait for the main key
    // e.code names the physical key, so Shift+, is still "," and layouts with AltGr behave.
    const c = e.code;
    let key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c
      : ({ Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Minus: '-', Equal: '=',
        Space: 'Space', Enter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Insert: 'Insert' })[c];
    if (!key) return;
    const mods = [(e.ctrlKey || (state.platform === 'darwin' && e.metaKey)) && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    setShortcutField(input, [...mods, key].join('+'), '');
    checkShortcutField(input);
  });
}
function applyShortcutLabels() {
  const l = state.labels || {};
  $('answerNow').title = l.answer || ''; $('answerScreen').title = l.screen || '';
}

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  let extra;
  try { extra = JSON.parse($('s-llm-extra').value.trim() || '{}'); if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error(); }
  catch { $('s-llm-extra').focus(); return toast('Extra chat parameters must be a JSON object, for example {"reasoning_effort":"low"}.', 'error'); }
  const v = (id) => $(id).value.trim();
  const patch = {
    autoUpdate: $('s-update').checked,
    autoAnswer: $('s-auto').checked ? 'questions' : 'off', answerLength: $('s-length').value,
    llm: { baseUrl: v('s-llm-base'), model: v('s-llm-model'), extra },
    stt: { baseUrl: v('s-stt-base'), model: v('s-stt-model'), language: v('s-stt-lang'), vocabulary: v('s-stt-vocab') },
    embed: { baseUrl: v('s-embed-base'), model: v('s-embed-model') },
    github: { apiBase: v('s-gh-api') || 'https://api.github.com' },
    api: { searchUrl: v('s-api-url'), headerName: v('s-api-hname') },
    capture: { micDeviceId: $('s-mic').value, themSource: $('s-them').value, ocrIntervalSec: Number($('s-ocr-int').value), ocrLangs: v('s-ocr-langs') || 'eng' },
    ui: { opacity: Number($('s-opacity').value) },
    shortcuts: Object.fromEntries(SHORTCUT_FIELDS.map(([action, id]) => [action, $(id).dataset.accel || ''])),
  };
  const used = Object.values(patch.shortcuts).filter(Boolean);
  if (new Set(used).size !== used.length) { $('s-key-answer').focus(); return toast('Two actions have the same shortcut. Give each its own keys.', 'error'); }
  // Secrets are only sent when something new was typed.
  if (v('s-llm-key')) patch.llm.apiKey = v('s-llm-key');
  if (v('s-stt-key')) patch.stt.apiKey = v('s-stt-key');
  if (v('s-embed-key')) patch.embed.apiKey = v('s-embed-key');
  if (v('s-gh-token')) patch.github.token = v('s-gh-token');
  if (v('s-api-hvalue')) patch.api.headerValue = v('s-api-hvalue');
  try {
    const r = await call('config:set', patch);
    state.cfg = r.config; state.saved = r.saved; state.labels = r.labels;
    fillSettings(); fillDevices();
    toast(state.listening ? 'Settings saved. Audio changes apply the next time you start listening.' : 'Settings saved');
    if (state.answer.status === 'idle') renderIdle();
  } catch (err) { fail(err); }
});
$('s-opacity').addEventListener('input', () => call('config:set', { ui: { opacity: Number($('s-opacity').value) } }));

// ---- boot -------------------------------------------------------------------
(async () => {
  const r = await call('config:get');
  state.cfg = r.config; state.saved = r.saved; state.labels = r.labels; state.platform = r.platform;
  state.version = r.version;
  $('versionNote').textContent = `Version ${r.version}${r.updates ? '' : ' (updates are installed by hand for this copy)'}`;
  $('s-update').disabled = !r.updates;
  $('keyNote').textContent = r.encrypted ? 'Keys are encrypted with your OS account.' : 'Keys are stored unencrypted on this machine.';
  fillSettings(); fillDevices();
  renderKb(await call('kb:stats'));
  renderAnswer();
  navigator.mediaDevices.addEventListener('devicechange', fillDevices);
})().catch(fail);
