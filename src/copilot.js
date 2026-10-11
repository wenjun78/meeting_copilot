'use strict';
const { EventEmitter } = require('events');
const { detectQuestion } = require('./question');
const { tokenize } = require('./rag/tokenize');
const { rankPrepared } = require('./qa');
const { planPinned } = require('./slots');

// Holds the meeting state (transcript, shared-screen text) and produces
// answer suggestions. No Electron dependencies, so it can be tested in Node.
//
// Events:
//   'transcript' {type:'add'|'update'|'remove', entry:{id,who,text,t,pending}}
//   'answer'     {type:'start'|'sources'|'delta'|'done'|'error', id, ...}
//   'notice'     {level:'error'|'info', message}
class Copilot extends EventEmitter {
  constructor({ getConfig, llm, kb, liveSearch, debounceMs = 900 }) {
    super();
    this.getConfig = getConfig; this.llm = llm; this.kb = kb; this.liveSearch = liveSearch;
    this.debounceMs = debounceMs;
    this.entries = [];
    this.screenText = '';
    this.seq = 0;
    this.answerSeq = 0;
    this.pendingThem = 0;
    this.lastAnsweredId = 0;
    this.timer = null;
    this.abort = null;
    this.lastError = '';
    this.lastRun = null;
    this.history = [];   // earlier questions and the answers suggested for them, oldest first
    this.speakingThem = false;
    this.generation = 0;
    this.sttTimeoutMs = 25000;
  }

  // Clears the conversation. Screen text is kept: the slide on screen has not changed.
  reset() {
    clearTimeout(this.timer);
    if (this.abort) this.abort.abort();
    this.entries = []; this.lastAnsweredId = 0; this.lastRun = null; this.history = [];
    this.pendingThem = 0; this.speakingThem = false;
    this.generation = (this.generation || 0) + 1; // segments still being transcribed belong to the old meeting
  }

  // The renderer reports when the other side starts and stops making sound, so an
  // answer is not fired while they are still mid-question.
  setSpeaking(who, on) {
    if (who !== 'them') return;
    this.speakingThem = !!on;
    if (on) clearTimeout(this.timer);
    else setTimeout(() => this._maybeAutoAnswer(), 350); // covers a trailing sound too short to be a segment
  }

  // A finished stretch of speech from one side. who: 'them' | 'you'
  async onSegment(who, wav, durationMs = 0) {
    const generation = this.generation || 0;
    const entry = { id: ++this.seq, who, text: '', t: Date.now() - durationMs, dur: durationMs, pending: true };
    this.entries.push(entry);
    this.emit('transcript', { type: 'add', entry: { ...entry } });
    if (who === 'them') { this.pendingThem++; clearTimeout(this.timer); }
    let text = '';
    try {
      const vocab = (this.getConfig().stt.vocabulary || '').trim();
      text = await this.llm.transcribe(wav, { prompt: vocab ? `Glossary: ${vocab}` : '', signal: AbortSignal.timeout(this.sttTimeoutMs) });
    } catch (e) {
      this._notice('error', e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Transcription timed out. Check your connection.' : e.message);
    }
    if (generation !== (this.generation || 0)) return null; // meeting was cleared meanwhile
    if (who === 'them') this.pendingThem--;
    if (!text || (who === 'you' && this._isEchoOfThem(entry, text))) {
      this._remove(entry);
    } else {
      entry.text = text; entry.pending = false;
      this.emit('transcript', { type: 'update', entry: { ...entry } });
      if (who === 'them') this._dropEchoesOf(entry);
    }
    if (who === 'them') this._maybeAutoAnswer();
    return entry.pending ? null : entry;
  }

  _remove(entry) {
    const i = this.entries.indexOf(entry);
    if (i < 0) return;
    this.entries.splice(i, 1);
    this.emit('transcript', { type: 'remove', entry: { id: entry.id } });
  }

  // The microphone also hears the other side when speakers are used. Those copies are
  // dropped, whichever of the two transcriptions comes back first.
  _echoes(you, youText, them) {
    if (you.t > them.t + them.dur + 3000 || them.t > you.t + you.dur + 3000) return false; // not at the same time
    const mine = new Set(tokenize(youText));
    if (mine.size < 3) return false;
    const theirs = new Set(tokenize(them.text));
    let hit = 0; for (const w of mine) if (theirs.has(w)) hit++;
    return hit / mine.size >= 0.7;
  }

  _isEchoOfThem(you, text) {
    return this.entries.some(e => e.who === 'them' && !e.pending && this._echoes(you, text, e));
  }

  _dropEchoesOf(them) {
    for (const e of this.entries.filter(x => x.who === 'you' && !x.pending)) if (this._echoes(e, e.text, them)) this._remove(e);
  }

  setScreenText(text) { this.screenText = String(text || '').trim(); }

  // The other side's most recent run of speech that has not been answered yet.
  // A brief "yeah" or "mm-hm" from the user does not break the run; a real reply does.
  _latestThemRun() {
    const run = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.pending) continue;
      if (e.who === 'you') { if (tokenize(e.text).length < 4) continue; break; }
      if (e.id <= this.lastAnsweredId) break;
      if (run.length && run[0].t - e.t > 30000) break;
      run.unshift(e);
      if (run.length >= 4) break;
    }
    return run;
  }

  // If they carry on right after an answer was started, the new words belong to the same
  // question: answer the whole thing rather than the tail on its own.
  _withContinuation(run) {
    const prev = this.lastRun;
    const joined = prev && run.length && run[0].t - prev.end < 6000 && Date.now() - prev.at < 20000;
    const text = (joined ? prev.text + ' ' : '') + run.map(e => e.text).join(' ');
    const last = run[run.length - 1];
    this.lastRun = { text, end: last.t + last.dur, at: Date.now() };
    return text;
  }

  _maybeAutoAnswer() {
    if (this.getConfig().autoAnswer !== 'questions' || this.pendingThem > 0 || this.speakingThem) return;
    const run = this._latestThemRun();
    if (!run.length) return;
    const prev = this.lastRun;
    const context = prev && run[0].t - prev.end < 6000 ? prev.text + ' ' : '';
    if (!detectQuestion(context + run.map(e => e.text).join(' ')).ask) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.pendingThem > 0 || this.speakingThem) return; // they kept talking; the next segment reschedules
      if (this._latestThemRun().length) this.answer({ mode: 'auto' }).catch(() => {});
    }, this.debounceMs);
  }

  _notice(level, message) {
    if (level === 'error' && message === this.lastError) return; // do not repeat the same failure for every segment
    if (level === 'error') this.lastError = message;
    this.emit('notice', { level, message });
  }

  // mode: 'auto' | 'manual' (answer the latest thing they said) | 'typed' | 'screen'
  async answer({ mode = 'manual', question = '' } = {}) {
    clearTimeout(this.timer);
    if (this.abort) this.abort.abort();
    const id = ++this.answerSeq;
    const cfg = this.getConfig();

    let asked = question.trim();
    if (mode === 'auto' || mode === 'manual') {
      let run = this._latestThemRun();
      if (!run.length && mode === 'manual') {
        // Nothing new: answer the last thing they said again.
        const last = [...this.entries].reverse().find(e => e.who === 'them' && !e.pending);
        if (last) run = [last];
      }
      if (!run.length) {
        this.emit('answer', { type: 'error', id, message: 'Nothing from the other side to answer yet.' });
        return '';
      }
      asked = this._withContinuation(run);
      this.lastAnsweredId = run[run.length - 1].id;
    }
    if (mode === 'screen') {
      if (!this.screenText) {
        this.emit('answer', { type: 'error', id, message: 'No shared-screen text has been read yet. Pick a screen or window when you start listening.' });
        return '';
      }
      asked = asked || 'Work out what the shared screen is asking of me (a question, a task, a query to write, an error to explain, a chart to comment on) and write my response to it.';
    }
    if (!asked) return '';

    const ctl = new AbortController();
    this.abort = ctl;
    // For a bare "answer from the screen" the card shows a short label, not the instruction sent to the model.
    this.emit('answer', { type: 'start', id, question: mode === 'screen' ? question.trim() : asked, mode });

    try {
      // Retrieval: the question, plus a little context when the question alone is too thin to search on.
      let query = asked;
      if (mode === 'screen') query = `${question} ${this.screenText.slice(0, 500)}`;
      else if (mode === 'typed' && tokenize(asked).length < 5 && this.history.length) {
        query = `${asked} ${this.history[this.history.length - 1].question}`;
      } else if (tokenize(asked).length < 4) {
        const prev = this.entries.filter(e => !e.pending && e.who === 'them').slice(-3).map(e => e.text).join(' ');
        query = `${asked} ${prev}`;
      }
      const [local, live] = await Promise.all([this._searchKb(query, ctl.signal), this._searchLive(asked, cfg)]);
      if (ctl.signal.aborted) return '';
      // Answers prepared in advance go to the model in their own block, closest first: those
      // the search found for this question, then by how alike the questions are worded.
      const found = new Set(local.filter(r => r.qa).map(r => r.qa.q));
      const prepared = rankPrepared(this.kb.prepared ? this.kb.prepared() : [], query)
        .map(p => ({ ...p, found: found.has(p.q) }))
        .sort((a, b) => ((b.match ? 2 : 0) + (b.found ? 1 : 0)) - ((a.match ? 2 : 0) + (a.found ? 1 : 0)));
      const refs = [...live, ...local.filter(r => !r.qa)].slice(0, cfg.answerContext === 'lean' ? 3 : 9);
      this.emit('answer', {
        type: 'sources', id,
        sources: [
          ...prepared.filter(p => p.match).slice(0, 2).map(p => ({ n: 'Q', title: `Prepared: ${p.q}`, path: '', url: '', snippet: p.a.slice(0, 280) })),
          ...refs.map((r, i) => ({ n: i + 1, title: r.title, path: r.path, url: r.url, snippet: r.text.slice(0, 280) })),
        ],
      });

      const send = (lean) => this.llm.chatStream(this._buildMessages({ asked, mode, refs, prepared, cfg, lean }), {
        signal: ctl.signal,
        maxTokens: cfg.answerLength === 'detailed' ? 1800 : 1000, // headroom for reasoning models; the prompt sets the real length
        onDelta: (piece) => this.emit('answer', { type: 'delta', id, text: piece }),
      });
      let lean = cfg.answerContext === 'lean';
      let text;
      try { text = await send(lean); } catch (e) {
        // The request was bigger than the service allows at once (free tiers cap tokens per
        // minute): send a trimmed version rather than no answer.
        if (lean || ctl.signal.aborted || !/too large|tokens per minute|\bTPM\b|context length|maximum context|request_too_large/i.test(e.message)) throw e;
        lean = true;
        this._notice('info', 'That was more than the service accepts in one go, so less of your notes was sent. Choose "Lean" under Settings > Answers to do this every time.');
        text = await send(true);
      }
      if (!text.trim()) throw new Error('The model returned no text. Try again, or check the chat model name in Settings.');
      this.lastError = '';
      // Remembered so a follow-up ("make it shorter", "and the second point?") has something to refer to.
      this.history.push({ t: Date.now(), mode, question: mode === 'screen' ? (question.trim() || 'what is on the shared screen') : asked, answer: text.trim() });
      if (this.history.length > 60) this.history.shift();
      this.emit('answer', { type: 'done', id, text });
      return text;
    } catch (e) {
      if (ctl.signal.aborted) return '';
      this.emit('answer', { type: 'error', id, message: e.message });
      return '';
    } finally {
      if (this.abort === ctl) this.abort = null;
    }
  }

  async _searchKb(query, signal) {
    let vec = null;
    if (this.llm.embedConfigured() && this.kb.stats().embedded) {
      try {
        const t = AbortSignal.timeout(1500);
        vec = (await this.llm.embed([query], { signal: AbortSignal.any([signal, t]) }))[0];
      } catch { /* fall back to keyword search */ }
    }
    return this.kb.search(query, 8, vec);
  }

  async _searchLive(query, cfg) {
    if (!cfg.api.searchUrl || !this.liveSearch) return [];
    try {
      return await this.liveSearch(cfg.api.searchUrl, query, { auth: cfg.api });
    } catch (e) {
      this._notice('error', `Your search API did not answer: ${e.message}`);
      return [];
    }
  }

  // lean: a smaller request (fewer notes, references and transcript lines).
  _buildMessages({ asked, mode, refs, prepared = [], cfg, lean = false }) {
    if (lean) refs = refs.slice(0, 3);
    const detailed = cfg.answerLength === 'detailed';
    const system = [
      'You sit beside the user during a live video meeting and write what they could say next. The user reads your text at a glance while talking, so it must be ready to speak.',
      'Format:',
      '- Start with the answer itself in one or two sentences, first person, in plain spoken language. No preamble, no "You could say".',
      `- Then up to ${detailed ? 6 : 4} short bullets ("- ") with the concrete facts, numbers, names or steps that back it up.`,
      `- Stay under ${detailed ? 220 : 110} words. Reply in the language the question was asked in.`,
      '- When what is wanted is a query or code (SQL, Python, a formula, a command): put the complete, runnable answer first in a fenced code block with the language named, then one or two spoken sentences on how it works, then at most two bullets on edge cases worth mentioning (NULLs, duplicates, ties, performance). Code does not count towards the word limit. Use the table and column names given; if they are not given, choose sensible ones and say which you assumed. Use the SQL dialect that is named or visible; otherwise standard SQL.',
      'Grounding:',
      '- The pinned notes and reference material are the user\'s own: their notes, CV, repositories, documents and API. Prefer them over general knowledge and cite references inline as [1], [2].',
      '- Papers, reports, projects and code in the user\'s material are the user\'s own work. Speak of them in the first person ("In my paper I ...", "we" for co-authored work), never as "the publication" or "the author". Give the specifics the references contain: the method, the data and its size, the numbers.',
      '- "Answers I prepared" are replies the user wrote in advance for questions they expect; what they state is the user\'s own fact. When what is asked is the same question as one of them, or close to it in meaning even if worded differently, build the reply on that prepared answer: keep its facts, examples, numbers and stance, fit it to the format and to exactly what was asked, and do not swap in other material or add a "Check:" line for what it states. When two apply, combine them. When none is close to the question, leave them out.',
      '- What the user has done (experience, projects, results, numbers, dates, employers, qualifications): answer only from the notes and references. If they do not cover it, do not invent it. Give the closest true experience from the notes and say how it relates, or an honest line the user can say ("I have not used X in production; the closest is ..."), and end with a line starting "Check:" naming what to confirm.',
      '- Questions with no fact to look up (where do you see yourself in five years, why this role, why this company, strengths and weaknesses, what motivates you, how do you handle pressure or conflict): write a specific, believable answer in the user\'s voice that follows from their background and, when there is a job description, from what the role offers. Build on the direction their work already shows. Do not invent events, employers, numbers or credentials to support it. No "Check:" line for these.',
      '- "Tell me about a time ..." questions: use a real example from the notes if one fits. If none does, name the closest real project and lay out how to tell it (situation, what I did, result) without making up the details, and add "Check:" saying the example needs the user\'s own specifics.',
      '- General knowledge (how something works, comparing tools, definitions): answer directly. No "Check:" line.',
      '- Personal facts the notes do not give (salary expectation, notice period, visa or relocation status, availability): never state one. Offer a neutral line the user can adapt and add "Check:".',
      '- When the pinned notes include a job description, agenda, brief or instructions for this meeting, shape the answer to them: lead with the experience, facts or skills they ask for, in their vocabulary, and follow any instructions on tone or length. A job description describes what the other side wants, not what the user has done: never present one of its requirements as the user\'s experience unless the user\'s own notes or references show it.',
      '- A question may lean on what came before ("make it shorter", "why?", "and the second one?", "can you elaborate?"). Resolve it from the conversation and the earlier suggestions, stay consistent with what was already said, and do not repeat an earlier answer word for word.',
      '- The transcript comes from speech recognition and the screen text from OCR; both can contain errors. Read through obvious mis-hearings.',
      '- If the other side did not actually ask for anything, give one sentence the user could use to acknowledge or move the conversation forward.',
    ].join('\n');

    // The conversation so far, newest last, as much as fits: about ten minutes of talk
    // normally, the last couple of minutes in lean mode.
    const spoken = [];
    let room = lean ? 1500 : 7000;
    for (const e of this.entries.filter(x => !x.pending).reverse()) {
      const line = `${e.who === 'them' ? 'Them' : 'Me'}: ${e.text}`;
      if (line.length > room && spoken.length) break;
      spoken.unshift(line); room -= line.length;
      if (room <= 0) break;
    }
    const convo = spoken.join('\n');
    // What was already asked and suggested, so answers build on each other instead of starting
    // over: as many exchanges as fit, newest first. The latest four keep most of their answer,
    // older ones a shorter cut, so a whole interview's worth of questions stays in view.
    const exchanges = [];
    let budget = lean ? 700 : 12000;
    for (let i = this.history.length - 1, n = 0; i >= 0; i--, n++) {
      if (lean && exchanges.length) break; // lean mode carries only the latest exchange
      const h = this.history[i];
      const item = `Asked: ${h.question.slice(0, 300)}\nSuggested: ${h.answer.slice(0, lean ? 400 : n < 4 ? 700 : 250)}`;
      if (item.length > budget && exchanges.length) break;
      exchanges.unshift(item); budget -= item.length;
      if (budget <= 0) break;
    }
    const earlier = exchanges.join('\n\n');
    const parts = [];
    // Notes sent with every answer: About me, CV, JD, Instructions, then pinned files from other sources.
    const notes = planPinned(this.kb.pinned ? this.kb.pinned() : [], lean ? { total: 6000, perNote: 2500 } : undefined)
      .filter(n => n.sent > 0).map(n => `### ${n.title}\n${n.text.slice(0, n.sent)}`);
    if (notes.length) parts.push(`Pinned notes from my sources (always included: who I am, my CV, the job description, instructions for this meeting):\n${notes.join('\n\n')}`);
    if (convo) parts.push(`Conversation so far (latest last):\n${convo}`);
    if (earlier) parts.push(`Earlier in this meeting you suggested these answers (most recent last):\n${earlier}`);
    if (this.screenText) parts.push(`Text on the shared screen (OCR):\n${this.screenText.slice(0, mode === 'screen' ? (lean ? 2500 : 5000) : (lean ? 600 : 1800))}`);
    // Prepared answers, closest first, as many as fit. In lean mode only the closest few.
    const ready = [];
    let space = lean ? 1500 : 8000;
    for (const p of prepared) {
      const item = `Q: ${p.q}\nA: ${p.a.slice(0, lean ? 600 : 1200)}`;
      if (item.length > space) { if (ready.length) break; continue; }
      ready.push(item); space -= item.length;
      if (lean && ready.length >= 2) break;
    }
    if (ready.length) parts.push(`Answers I prepared for questions I expect (the likeliest matches first):\n${ready.join('\n\n')}`);
    if (refs.length) {
      parts.push('Reference material:\n' + refs.map((r, i) => `[${i + 1}] ${r.title}${r.path ? ` (${r.path})` : ''}\n${r.text.slice(0, lean ? 800 : 1500)}`).join('\n\n'));
    } else parts.push('Reference material: none found for this question.');
    parts.push(mode === 'screen'
      ? `What I need: ${asked}\nBase the reply on the shared-screen text above. It is raw OCR of the whole screen, so ignore menus, toolbars, participant names and other clutter, and repair obvious OCR slips in names and code.`
      : mode === 'typed' ? `My question: ${asked}` : `They just said: "${asked}"\nWrite what I should say.`);
    return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }];
  }

  // The conversation as text, in order: what each side said and every answer suggested.
  transcriptText() {
    const at = (t) => `[${new Date(t).toLocaleTimeString()}]`;
    const said = this.entries.filter(e => !e.pending).map(e => ({ t: e.t, text: `${at(e.t)} ${e.who === 'them' ? 'Them' : 'You'}: ${e.text}` }));
    const answers = this.history.map(h => ({ t: h.t || 0,
      text: `${at(h.t || Date.now())} Suggested answer${h.mode === 'typed' ? ` (you asked: ${h.question})` : h.mode === 'screen' ? ' (from the screen)' : ''}:\n${h.answer.split('\n').map(l => '    ' + l).join('\n')}` }));
    return [...said, ...answers].sort((a, b) => a.t - b.t).map(x => x.text).join('\n');
  }
}

module.exports = { Copilot };
