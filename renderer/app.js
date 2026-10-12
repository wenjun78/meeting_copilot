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
function inline(parent, text, sources = state.answer.sources) {
  for (const part of text.split(/(\*\*[^*]+\*\*|\[\d+\]|`[^`]+`)/)) {
    if (!part) continue;
    let m;
    if ((m = /^\*\*([^*]+)\*\*$/.exec(part))) parent.append(el('strong', { text: m[1] }));
    else if ((m = /^`([^`]+)`$/.exec(part))) parent.append(el('code', { text: m[1] }));
    else if ((m = /^\[(\d+)\]$/.exec(part))) {
      const src = sources.find(s => s.n === Number(m[1]));
      if (src) parent.append(el('button', { class: 'cite', type: 'button', title: `${src.title}\n${src.snippet}`, text: m[1], onclick: () => openSource(src) }));
      else parent.append(part);
    } else parent.append(part);
  }
}

function renderAnswerText(card, text, sources = state.answer.sources) {
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
      const li = el('li'); inline(li, bullet[1], sources); list.append(li);
      continue;
    }
    list = null;
    const p = el('p', { class: /^check:/i.test(line) ? 'check' : first ? 'lead' : '' });
    inline(p, line.replace(/^#+\s*/, ''), sources);
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
      el('li', { class: hasKb ? 'done' : '', text: 'Fill in About me, CV and JD under Knowledge.' }),
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
  else if (!a.text && a.stale) { card.className = 'card stale'; renderAnswerText(card, a.stale, a.staleSources); card.prepend(el('p', { class: 'updating', text: 'They added to the question. Updating the answer' })); }
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
  // When an answer is replaced while it was being written (they carried on talking), what
  // was written so far stays in view, dimmed, until the new one starts to arrive.
  if (e.type === 'start') state.answer = { id: e.id, text: '', sources: [], status: 'working', question: e.question, mode: e.mode,
    stale: a.status === 'working' && e.mode === 'auto' ? (a.text || a.stale || '') : '', staleSources: a.status === 'working' ? (a.text ? a.sources : a.staleSources || []) : [] };
  else if (e.id < a.id) return; // a newer answer has replaced this one
  else if (e.type === 'sources') a.sources = e.sources;
  else if (e.type === 'delta') a.text += e.text;
  else if (e.type === 'done') { a.status = 'done'; a.text = e.text || a.text; logAnswer(a); }
  else if (e.type === 'error') {
    if (a.status === 'idle' || e.id > a.id) state.answer = { id: e.id, text: '', sources: [], status: 'error', error: e.message };
    else { a.status = 'error'; a.error = e.message; }
  }
  cancelAnimationFrame(state.raf);
  state.raf = requestAnimationFrame(() => { renderAnswer(); renderLog(); updateSetupMode(); });
});

// ---- conversation log: every answer given, kept for the meeting ----------------------
// Each finished answer is added to the transcript where it was given, and listed under
// the current answer (in the wide layout) so an earlier one can be read again.
const answerLog = [];
const askedLabel = (a) => (a.mode === 'typed' ? `You asked: ${a.question}` : a.mode === 'screen' ? (a.question ? `About the screen: ${a.question}` : 'From the screen') : `They said: ${a.question}`);
function logAnswer(a) {
  if (!a.text || !a.text.trim() || answerLog.some(x => x.id === a.id)) return;
  const item = { id: a.id, t: Date.now(), mode: a.mode, question: a.question || '', text: a.text, sources: a.sources || [] };
  answerLog.push(item);
  const panel = $('tab-transcript');
  const pinned = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 60;
  const lead = item.text.split('\n').map(l => l.trim()).find(l => l && !/^(```|~~~)/.test(l)) || '';
  $('lines').append(el('div', { class: 'line answer', 'data-who': 'answer' }, el('span', { class: 'who', text: 'Answer' }),
    el('details', {}, el('summary', { title: askedLabel(item), text: lead.replace(/\*\*|\s*\[\d+\]/g, '') }), el('pre', { text: item.text }))));
  restyleLines();
  if (pinned) panel.scrollTop = panel.scrollHeight;
}
function renderLog() {
  // The answer on the card is not repeated beneath itself.
  const earlier = answerLog.filter(x => x.id !== state.answer.id || state.answer.status === 'idle').reverse();
  $('log').classList.toggle('has', earlier.length > 0);
  const open = new Set([...$('logList').querySelectorAll('details[open]')].map(d => d.dataset.id));
  $('logList').replaceChildren(...earlier.map(x => {
    const body = el('div', { class: 'card' });
    renderAnswerText(body, x.text, x.sources);
    const d = el('details', { 'data-id': String(x.id) },
      el('summary', {}, el('time', { text: new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), el('span', { text: askedLabel(x) })), body);
    d.open = open.has(String(x.id));
    return d;
  }));
}

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
  answerLog.length = 0;
  state.answer = { id: state.answer.id, text: '', sources: [], status: 'idle' }; renderAnswer(); renderLog();
});
$('exportBtn').addEventListener('click', async () => {
  try { const p = await call('meeting:export', { answers: false }); if (p) toast(`Transcript saved to ${p}`); } catch (e) { fail(e); }
});
$('exportAllBtn').addEventListener('click', async () => {
  try { const p = await call('meeting:export', { answers: true }); if (p) toast(`Transcript with answers saved to ${p}`); } catch (e) { fail(e); }
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
  updateSetupMode();
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
  updateSetupMode();
}
// While Knowledge or Settings is open and there is no call or answer, give them the whole
// window. (Side by side, in the wide layout, the answer area stays: see the stylesheet.)
function updateSetupMode() {
  const tab = document.querySelector('.tabs button[aria-selected="true"]');
  const settingUp = tab && (tab.dataset.tab === 'knowledge' || tab.dataset.tab === 'settings');
  document.body.classList.toggle('setup', !!settingUp && !state.listening && state.answer.status === 'idle');
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => { showTab(b.dataset.tab); if (b.dataset.tab === 'knowledge') showSection(kbView.name); });
$('min').addEventListener('click', () => call('win:minimize'));
$('max').addEventListener('click', async () => { try { showMaximized(await call('win:maximize')); } catch (e) { fail(e); } });
$('close').addEventListener('click', () => call('win:close'));
$('compact').addEventListener('click', async () => {
  const on = await call('win:compact', !document.body.classList.contains('compact'));
  document.body.classList.toggle('compact', on);
  $('compact').setAttribute('aria-pressed', String(on));
});
document.querySelector('.bar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) call('win:maximize'); });
function showMaximized(on) {
  document.body.classList.toggle('maximized', on);
  $('max').title = on ? 'Restore down' : 'Maximise';
  $('max').setAttribute('aria-label', $('max').title);
}
window.mc.on('window', (w) => showMaximized(!!w.maximized));
$('onTop').addEventListener('click', async () => {
  try {
    const on = await call('win:onTop', $('onTop').getAttribute('aria-pressed') !== 'true');
    $('onTop').setAttribute('aria-pressed', String(on));
    toast(on ? 'Stays on top of other windows' : 'Behaves like a normal window: other windows can cover it');
  } catch (e) { fail(e); }
});
window.mc.on('notice', (n) => toast(n.message, n.level));

// ---- knowledge --------------------------------------------------------------
// Sections (About me, CV, JD, Instructions, Prepared answers, Questions to ask, Publications,
// Portfolio) are the way in; typing, files and
// drag-and-drop are how each one is filled. "Equipped" shows everything that results.
const SECTION_TEXT = {
  about: { what: 'Who you are: your role, strengths, goals and how you like to sound. Sent with every answer.', hint: 'I am a ... with ... years in ... I want my answers to sound ...' },
  cv: { what: 'Your CV. Paste it here or add the file. Sent with every answer.', hint: 'Paste your CV, or drop the PDF or Word file below.' },
  jd: { what: 'The job description, agenda or brief for this meeting. Sent with every answer; replace it before a different meeting.', hint: 'Paste the job description, or drop the file below.' },
  ask: { what: 'Questions you want to ask them. When they invite your questions, two or three that fit the conversation are suggested, leaving out any it has already answered. Sent with every answer.', hint: 'One question per line, the most important first.\nWhat does success look like in the first six months?\nHow is the team split between building and support?' },
  publications: { what: 'Your papers. Add each PDF or Word file: it is searched section by section (methods, results, limitations), and its title and abstract go with every answer. Text typed here goes with every answer too.', hint: 'How you would sum up each paper in 30 seconds, your part in it, and what you would do differently.' },
  instructions: { what: 'How the answers should behave: tone, length, what to stress, what to avoid. Sent with every answer.', hint: 'Keep answers under 30 seconds. Lead with ...' },
};
const kbView = { name: 'about', savedText: '', busy: false };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const num = (n) => n.toLocaleString('en-US');
const isTextSection = (name) => name in SECTION_TEXT;

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

// One row per added file: its name, what the app made of it, and how much was read. A file
// that gave no text (a scanned or protected PDF) is said so here rather than silently ignored.
function fileRows(list, slotId, after) {
  return list.map(f => {
    const unread = !f.passages;
    const known = f.title && f.title !== f.name ? f.title.replace(` (${f.name})`, '').replace(' (research paper)', '') : '';
    return el('li', { class: unread ? 'unread' : '' },
      el('span', { class: 'name', title: f.name, text: f.name }),
      el('span', { class: 'size', text: fmtSize(f.size) }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Remove', onclick: async () => { try { after(await call('slot:removeFile', slotId, f.name)); } catch (e) { fail(e); } } }),
      el('span', { class: 'meta', text: unread ? 'No text could be read from this file. If it is a scan or is protected, paste the text instead.'
        : `${known ? `${known}. ` : ''}${num(f.passages)} ${f.passages === 1 ? 'passage' : 'passages'} read` }));
  });
}

function renderSlot(info) {
  kbView.savedText = info.text;
  $('slotText').value = info.text; // always replaced, so nothing carries over from another section
  $('slotText').placeholder = SECTION_TEXT[info.id].hint;
  $('slotText').setAttribute('aria-label', info.title);
  $('slotWhat').textContent = SECTION_TEXT[info.id].what;
  $('slotFiles').replaceChildren(...fileRows(info.files, info.id, renderSlot));
  slotState();
}
function slotState() {
  const n = $('slotText').value.trim().length;
  const dirty = $('slotText').value.trim() !== kbView.savedText;
  $('slotState').textContent = dirty ? 'Not saved yet' : n ? `Saved, ${num(n)} characters${n > 8000 ? '. The first 8,000 are sent with every answer; the rest is searched.' : ''}` : 'Nothing typed';
  $('slotSave').disabled = !dirty;
}
async function saveSlot(quiet) {
  if (!isTextSection(kbView.name) || $('slotText').value.trim() === kbView.savedText) return;
  const name = kbView.name;
  const info = await call('slot:save', name, $('slotText').value);
  if (kbView.name === name) renderSlot(info); else kbView.savedText = '';
  if (!quiet) toast(`${info.title} saved`);
  refreshIdle();
}
$('slotSave').addEventListener('click', () => saveSlot(false).catch(fail));
$('slotText').addEventListener('input', slotState);

// Switching always completes: unsaved text in the section being left is saved first, then
// the new section is loaded from what is stored.
async function showSection(name) {
  if (kbView.busy) return;
  kbView.busy = true;
  try {
    if (name !== kbView.name) { try { await saveSlot(true); await saveQaDraft(); } catch (e) { fail(e); } }
    kbView.name = name;
    for (const b of document.querySelectorAll('#slotTabs button')) b.setAttribute('aria-selected', String(b.dataset.view === name));
    $('slotPanel').hidden = !isTextSection(name);
    $('portfolioPanel').hidden = name !== 'portfolio';
    $('equippedPanel').hidden = name !== 'equipped';
    $('qaPanel').hidden = name !== 'qa';
    if (isTextSection(name)) renderSlot(await call('slot:get', name));
    else if (name === 'qa') renderQa(await call('qa:list'));
    else if (name === 'portfolio') await renderPortfolio();
    else await renderEquipped();
  } catch (e) { fail(e); } finally { kbView.busy = false; }
}
for (const b of document.querySelectorAll('#slotTabs button')) b.addEventListener('click', () => showSection(b.dataset.view));

// ---- adding files: click a drop area, or drop onto it (or anywhere on the window) ----
async function addFilesTo(slotId, paths) {
  try {
    if (isTextSection(kbView.name)) await saveSlot(true);
    const r = await call('slot:addFiles', slotId, paths);
    if (!r) return;
    const parts = [];
    if (r.added.length) parts.push(`Added ${r.added.join(', ')}`);
    if (r.folders.length) parts.push(`Added folder ${r.folders.join(', ')}`);
    if (r.skipped.length) parts.push(`Skipped (not a readable type): ${r.skipped.join(', ')}`);
    toast(parts.join('. '), r.added.length || r.folders.length ? 'info' : 'error');
    if (kbView.name === slotId) { if (isTextSection(slotId)) renderSlot(r.slot); else await renderPortfolio(); }
    refreshIdle();
  } catch (e) { fail(e); }
}
function wireDrop(zone, slotOf) {
  zone.addEventListener('click', () => addFilesTo(slotOf(), null));
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addFilesTo(slotOf(), null); } });
  zone.addEventListener('dragenter', () => zone.classList.add('over'));
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('over'); });
  zone.addEventListener('drop', () => zone.classList.remove('over'));
}
wireDrop($('slotDrop'), () => kbView.name);
wireDrop($('portfolioDrop'), () => 'portfolio');
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e) || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map(f => window.mc.pathFor(f)).filter(Boolean);
  if (!paths.length) return;
  // Dropped on a section: it goes there. Dropped anywhere else: it goes to Portfolio.
  const onKnowledge = !$('tab-knowledge').hidden;
  if (onKnowledge && kbView.name === 'qa') return qaImport(() => call('qa:importFiles', paths));
  const target = onKnowledge && (isTextSection(kbView.name) || kbView.name === 'portfolio') ? kbView.name : 'portfolio';
  if (!onKnowledge || target !== kbView.name) { showTab('knowledge'); await showSection(target); }
  addFilesTo(target, paths);
});

// ---- Prepared answers ----
// One list of question-and-answer pairs. The form adds a pair or, after "Edit", changes one.
const qa = { list: [], editing: -1 };
function renderQa(list) {
  qa.list = list;
  if (qa.editing >= list.length) qa.editing = -1;
  $('qaList').replaceChildren(...list.map((p, i) => {
    const li = el('li', { class: i === qa.editing ? 'editing' : '' },
      el('span', { class: 'q', text: p.q }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Edit', onclick: () => { qa.editing = i; $('qaQ').value = p.q; $('qaA').value = p.a; renderQa(qa.list); $('qaA').focus(); } }),
      el('button', { class: 'btn quiet', type: 'button', text: 'Remove', onclick: async () => {
        try { if (qa.editing === i) clearQaForm(); else if (qa.editing > i) qa.editing--; renderQa(await call('qa:save', qa.list.filter((_, k) => k !== i))); refreshIdle(); } catch (e) { fail(e); }
      } }),
      el('p', { class: 'a', text: p.a }));
    for (const part of li.querySelectorAll('.q, .a')) part.addEventListener('click', () => { if (!String(getSelection())) li.classList.toggle('open'); });
    return li;
  }));
  $('qaEmpty').hidden = list.length > 0;
  $('qaTools').hidden = list.length < 2;
  $('qaCount').textContent = `${num(list.length)} questions`;
  armQaClear(false);
  $('qaAdd').textContent = qa.editing >= 0 ? 'Save changes' : 'Add';
  $('qaCancel').hidden = qa.editing < 0;
  const chars = list.reduce((n, p) => n + p.q.length + Math.min(p.a.length, 1200) + 8, 0);
  $('qaState').textContent = qa.editing >= 0 ? 'Editing the highlighted answer' : !list.length ? ''
    : `${num(list.length)} prepared ${list.length === 1 ? 'answer' : 'answers'}. ${chars <= 16000 ? 'All of them are offered with every question.' : `With each question, the ones closest to it ${state.kb.embedded ? 'in meaning' : 'in wording'} are offered, roughly 30 at a time.`}`;
}
// "Remove all" asks once more before it empties the list.
let qaClearTimer = 0;
function armQaClear(on) {
  clearTimeout(qaClearTimer);
  $('qaClear').dataset.armed = on ? '1' : '';
  $('qaClear').textContent = on ? `Click again to remove all ${num(qa.list.length)}` : 'Remove all';
  if (on) qaClearTimer = setTimeout(() => armQaClear(false), 5000);
}
$('qaClear').addEventListener('click', async () => {
  if (!$('qaClear').dataset.armed) return armQaClear(true);
  try { clearQaForm(); renderQa(await call('qa:save', [])); toast('All prepared answers removed'); refreshIdle(); } catch (e) { fail(e); }
});
function clearQaForm() { qa.editing = -1; $('qaQ').value = ''; $('qaA').value = ''; }
// Adds what is in the form, or saves the edit. Nothing happens unless both boxes are filled.
async function saveQaDraft() {
  const q = $('qaQ').value.trim(), a = $('qaA').value.trim();
  if (!q || !a) return false;
  const list = qa.editing >= 0 ? qa.list.map((p, i) => (i === qa.editing ? { q, a } : p)) : [...qa.list, { q, a }];
  const saved = await call('qa:save', list);
  clearQaForm();
  if (kbView.name === 'qa') renderQa(saved); else qa.list = saved;
  refreshIdle();
  return true;
}
$('qaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const editing = qa.editing >= 0;
    if (await saveQaDraft()) { toast(editing ? 'Answer updated' : 'Answer added'); $('qaQ').focus(); }
    else toast('Fill in both the question and your answer.', 'error');
  } catch (err) { fail(err); }
});
$('qaCancel').addEventListener('click', () => { clearQaForm(); renderQa(qa.list); });
async function qaImport(run) {
  try {
    const r = await run();
    if (!r) return false;
    renderQa(r.list);
    toast(`${r.added ? `Added ${num(r.added)} ${r.added === 1 ? 'answer' : 'answers'}` : 'Nothing new'}${r.updated ? `, updated ${num(r.updated)}` : ''}${r.empty && r.empty.length ? `. Nothing found in ${r.empty.join(', ')}` : ''}`);
    refreshIdle();
    return true;
  } catch (e) { fail(e); return false; }
}
$('qaBulkAdd').addEventListener('click', async () => {
  if (!$('qaBulk').value.trim()) return toast('Paste your questions and answers first.', 'error');
  if (await qaImport(() => call('qa:importText', $('qaBulk').value))) $('qaBulk').value = '';
});
{
  const zone = $('qaDrop');
  const pick = () => qaImport(() => call('qa:importFiles', null));
  zone.addEventListener('click', pick);
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  zone.addEventListener('dragenter', () => zone.classList.add('over'));
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('over'); });
  zone.addEventListener('drop', () => zone.classList.remove('over'));
}

// ---- portfolio ----
async function renderPortfolio() {
  const [stats, slot] = await Promise.all([call('kb:stats'), call('slot:get', 'portfolio')]);
  state.kb = stats;
  const sources = stats.sources.filter(s => !s.mine);
  $('kbList').replaceChildren(...sources.map(s => el('li', {},
    el('span', { class: 'label', title: s.label, text: s.label }),
    s.origin && s.origin.kind === 'folder'
      ? el('button', { class: 'btn quiet', type: 'button', text: 'Open', title: 'Open the folder', onclick: () => call('kb:openFolder', s.id).catch(fail) })
      : el('button', { class: 'btn quiet', type: 'button', text: 'Sync', onclick: () => kbRun(() => call('kb:sync', s.id), `${s.label} synced`) }),
    el('button', { class: 'btn quiet', type: 'button', text: 'Remove', onclick: () => kbRun(() => call('kb:remove', s.id), `${s.label} removed`) }),
    el('span', { class: 'meta', text: `${num(s.files)} ${s.files === 1 ? 'file' : 'files'}, ${num(s.chunkCount)} passages, updated ${ago(s.syncedAt)}${s.checkedAt && s.checkedAt - s.syncedAt > 60000 ? `, checked ${ago(s.checkedAt)}` : ''}` }))));
  $('portfolioFiles').replaceChildren(...fileRows(slot.files, 'portfolio', () => renderPortfolio()));
  $('kbEmpty').hidden = sources.length > 0 || slot.files.length > 0;
  $('kbStatus').textContent = '';
}
async function kbRun(fn, doneMessage) {
  for (const b of document.querySelectorAll('#portfolioPanel button')) b.disabled = true;
  try {
    const r = await fn();
    if (r === null) return;
    const msg = typeof doneMessage === 'function' ? doneMessage(r) : doneMessage;
    if (msg) toast(msg);
  } catch (e) { fail(e); } finally {
    for (const b of document.querySelectorAll('#portfolioPanel button')) b.disabled = false;
    if (kbView.name === 'portfolio') await renderPortfolio().catch(fail);
    refreshIdle();
  }
}
const addedMessage = (list) => (list.length === 1
  ? `Added ${list[0].label}: ${num(list[0].chunks)} passages from ${num(list[0].files)} files`
  : `Added ${list.length} repositories, ${num(list.reduce((n, x) => n + x.chunks, 0))} passages`);
$('kbForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('kbInput').value.trim();
  if (v) kbRun(() => call('kb:add', v), (r) => { $('kbInput').value = ''; return addedMessage(r); });
});
$('kbFolder').addEventListener('click', () => kbRun(() => call('kb:addFolder'), addedMessage));
$('kbAuto').addEventListener('change', async () => {
  try { const r = await call('config:set', { autoSync: $('kbAuto').checked }); state.cfg = r.config; } catch (e) { fail(e); }
});
window.mc.on('kb', (e) => {
  if (e.type === 'progress') $('kbStatus').textContent = e.message;
  if (e.type === 'changed') {
    state.kb = e.stats; refreshIdle();
    if (kbView.name === 'portfolio' && !$('tab-knowledge').hidden && !kbView.busy) renderPortfolio().catch(() => {});
    if (kbView.name === 'equipped' && !$('tab-knowledge').hidden && !kbView.busy) renderEquipped().catch(() => {});
  }
});

// ---- equipped: exactly what the answers can draw on ----
// A row that opens to show the text of one file as the app read it.
function previewRow(label, meta, sourceId, filePath, cut) {
  const body = el('pre', { class: 'preview-text', text: 'Loading' });
  const details = el('details', {}, el('summary', {}, el('b', { title: label, text: label }), el('span', { class: cut ? 'cut' : '', text: meta })), body);
  details.addEventListener('toggle', async () => {
    if (!details.open || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    try {
      const r = await call('kb:fileText', { sourceId, path: filePath });
      body.textContent = r.text + (r.more ? `\n\n... and ${num(r.more)} more characters` : '');
    } catch (e) { body.textContent = e.message; }
  });
  return details;
}
async function renderEquipped() {
  const inv = await call('kb:inventory');
  const sent = inv.always.reduce((n, a) => n + a.sent, 0);
  const files = inv.searched.reduce((n, s) => n + s.files.length, 0);
  $('eqSummary').textContent = `${inv.always.length ? `${inv.always.length} ${inv.always.length === 1 ? 'note is' : 'notes are'} sent with every answer (${num(sent)} characters, about ${num(Math.round(sent / 6))} words).` : 'Nothing is sent with every answer yet.'} ${num(files)} ${files === 1 ? 'file' : 'files'} can be searched (${num(inv.passages)} passages).${inv.lean ? ' Lean mode is on, so less is sent.' : ''}${state.kb.embedded ? ' Search is by meaning as well as keywords.' : ' Search is by keywords.'}`;
  $('eqAlways').replaceChildren(...(inv.always.length ? inv.always.map(a => el('li', {},
    previewRow(a.title, a.sent < a.chars ? (a.sent ? `first ${num(a.sent)} of ${num(a.chars)} characters sent` : `not sent: the limit is used up (${num(a.chars)} characters)`) : `${num(a.chars)} characters`, a.sourceId, a.path, a.sent < a.chars)))
    : [el('li', {}, el('p', { class: 'empty', text: 'Fill in About me, CV and JD to give every answer your background and the role.' }))]));
  const filter = $('eqFilter').value.trim().toLowerCase();
  $('eqSearched').replaceChildren(...(inv.searched.length ? inv.searched.map(src => {
    const shown = src.files.filter(f => !filter || f.path.toLowerCase().includes(filter));
    if (filter && !shown.length) return null;
    const passages = shown.reduce((n, f) => n + f.passages, 0);
    const list = el('ul', {}, ...shown.slice(0, 400).map(f => el('li', {}, previewRow(f.path, `${num(f.passages)} ${f.passages === 1 ? 'passage' : 'passages'}`, src.id, f.path, false))),
      shown.length > 400 ? el('li', {}, el('p', { class: 'empty', text: `and ${num(shown.length - 400)} more files. Use the filter to find one.` })) : null);
    const d = el('details', {}, el('summary', {}, el('b', { title: src.label, text: src.label }), el('span', { text: `${num(shown.length)} ${shown.length === 1 ? 'file' : 'files'}, ${num(passages)} passages` })), list);
    if (filter || shown.length <= 8) d.open = true;
    return d;
  }).filter(Boolean) : [el('p', { class: 'empty', text: 'Nothing to search yet. Add your CV, or a repository under Portfolio.' })]));
}
let eqTimer;
$('eqFilter').addEventListener('input', () => { clearTimeout(eqTimer); eqTimer = setTimeout(() => renderEquipped().catch(fail), 200); });
$('kbTry').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const hits = await call('kb:search', $('kbTryInput').value);
    $('kbHits').replaceChildren(...(hits.length ? hits.map(h => el('li', {}, el('b', { text: `${h.title}${h.path ? ` (${h.path})` : ''}` }), el('span', { text: h.snippet })))
      : [el('li', {}, el('span', { text: 'Nothing matched. Try the words they would use in the meeting.' }))]));
  } catch (err) { fail(err); }
});

// The start-up card ticks its steps off as sections are filled.
async function refreshIdle() {
  try { state.kb = await call('kb:stats'); } catch { /* keep the last known state */ }
  if (state.answer.status === 'idle') renderIdle();
}

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
  $('s-llm-base').value = c.llm.baseUrl; $('s-llm-model').value = c.llm.model; $('s-llm-key').placeholder = keyHint(s.llmKey) || 'Paste your API key';
  $('s-service').value = serviceOf(c.llm.baseUrl); showService();
  $('keyState').textContent = s.llmKey ? 'A key is saved on this computer and stays until you replace it.' : 'No key saved yet. Paste one and press Save settings.';
  $('keyState').classList.toggle('warn', !s.llmKey);
  $('s-llm-extra').value = JSON.stringify(c.llm.extra || {});
  $('s-stt-model').value = c.stt.model; $('s-stt-lang').value = ['en', 'zh'].includes(c.stt.language) ? c.stt.language : 'en+zh'; $('s-stt-vocab').value = c.stt.vocabulary;
  $('s-stt-base').value = c.stt.baseUrl; $('s-stt-key').placeholder = keyHint(s.sttKey);
  $('s-auto').checked = c.autoAnswer === 'questions'; $('s-length').value = c.answerLength;
  $('s-ocr-int').value = String(c.capture.ocrIntervalSec); $('s-ocr-langs').value = c.capture.ocrLangs;
  $('s-gh-token').placeholder = keyHint(s.githubToken); $('s-gh-api').value = c.github.apiBase;
  $('s-api-url').value = c.api.searchUrl; $('s-api-hname').value = c.api.headerName; $('s-api-hvalue').placeholder = keyHint(s.apiHeader);
  $('s-embed-model').value = c.embed.model; $('s-embed-base').value = c.embed.baseUrl; $('s-embed-key').placeholder = keyHint(s.embedKey);
  $('opacity').value = String(c.ui.opacity || 1);
  $('kbAuto').checked = c.autoSync !== false;
  $('s-context').value = c.answerContext === 'lean' ? 'lean' : 'full';
  $('onTop').setAttribute('aria-pressed', String(c.ui.onTop !== false));
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

// Picking a service fills in its address and sensible models, so only the key is left to paste.
// `models` are suggestions for the answer model (any model name can be typed), with the price
// per million tokens in and out as published in October 2026.
const SERVICES = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', stt: 'gpt-4o-transcribe', extra: { reasoning_effort: 'low' },
    models: [['gpt-6.1-sol', 'default: balanced, $2 in / $10 out'], ['gpt-6-astra', 'most capable, $10 / $50'], ['gpt-5.6-sol', '$4 / $20'], ['gpt-6-luna', 'cheapest, $0.10 / $0.50']] },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', stt: 'whisper-large-v3', extra: { reasoning_effort: 'low' },
    models: [['openai/gpt-oss-120b', 'fast, $0.15 / $0.60'], ['openai/gpt-oss-20b', 'faster and smaller']] },
};
const serviceOf = (baseUrl) => (/api\.openai\.com/i.test(baseUrl) ? 'openai' : /api\.groq\.com/i.test(baseUrl) ? 'groq' : 'custom');
function showService() {
  const svc = SERVICES[$('s-service').value];
  $('s-llm-base-row').hidden = !!svc;
  $('modelChoices').replaceChildren(...(svc ? svc.models.map(([id, note]) => el('option', { value: id, label: note })) : []));
  $('modelHint').textContent = svc ? `Suggestions: ${svc.models.map(([id]) => id).join(', ')}. Any model your key can use works; type its name.` : '';
}
$('s-service').addEventListener('change', () => {
  const svc = SERVICES[$('s-service').value];
  if (svc) {
    $('s-llm-base').value = svc.baseUrl; $('s-llm-model').value = svc.model; $('s-stt-model').value = svc.stt;
    $('s-llm-extra').value = JSON.stringify(svc.extra);
    $('s-llm-key').placeholder = 'Paste the key for this service'; // the saved key belongs to the previous service
    $('keyState').textContent = 'The saved key belongs to the service you had before. Paste the key for this one, then Save settings.';
    $('keyState').classList.add('warn');
  }
  showService();
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
    autoAnswer: $('s-auto').checked ? 'questions' : 'off', answerLength: $('s-length').value, answerContext: $('s-context').value,
    llm: { baseUrl: v('s-llm-base'), model: v('s-llm-model'), extra },
    stt: { baseUrl: v('s-stt-base'), model: v('s-stt-model'), language: v('s-stt-lang'), vocabulary: v('s-stt-vocab') },
    embed: { baseUrl: v('s-embed-base'), model: v('s-embed-model') },
    github: { apiBase: v('s-gh-api') || 'https://api.github.com' },
    api: { searchUrl: v('s-api-url'), headerName: v('s-api-hname') },
    capture: { micDeviceId: $('s-mic').value, themSource: $('s-them').value, ocrIntervalSec: Number($('s-ocr-int').value), ocrLangs: v('s-ocr-langs') || 'eng' },
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
// Window opacity, in the title bar: applied as the slider moves.
$('opacity').addEventListener('input', () => call('config:set', { ui: { opacity: Number($('opacity').value) } }).catch(() => {}));

// ---- boot -------------------------------------------------------------------
(async () => {
  const r = await call('config:get');
  state.cfg = r.config; state.saved = r.saved; state.labels = r.labels; state.platform = r.platform;
  state.version = r.version;
  $('versionNote').textContent = `Version ${r.version}${r.updates ? '' : ' (updates are installed by hand for this copy)'}`;
  $('s-update').disabled = !r.updates;
  $('keyNote').textContent = r.encrypted ? 'Keys are encrypted with your OS account.' : 'Keys are stored unencrypted on this machine.';
  fillSettings(); fillDevices();
  state.kb = await call('kb:stats');
  renderAnswer();
  navigator.mediaDevices.addEventListener('devicechange', fillDevices);
})().catch(fail);
