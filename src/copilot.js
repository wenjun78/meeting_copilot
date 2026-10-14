'use strict';
const { EventEmitter } = require('events');
const { detectQuestion } = require('./question');
const { tokenize } = require('./rag/tokenize');
const { rankPrepared } = require('./qa');
const { planPinned } = require('./slots');

// Things said to be polite or to fill a pause, which add nothing to a question.
const COURTESY = /^(?:(?:ok(?:ay)?|right|yeah|yes|yep|sure|so|well|alright|all right|great|cool|good|perfect|thanks|thank you|please|go ahead|take your time|no rush|no pressure|no worries|whenever you(?:'re| are) ready|if you can|if (?:that|it) makes sense|if possible|that(?:'s| is) (?:it|all)|mm+-?hm+|uh-?huh|hm+|um+|uh+|好的?|嗯+|对|是的|可以|行|慢慢来|不急|不着急|谢谢|没问题)[\s,.!，。！、]*)+$/i;
// Greetings, thanks and sound checks: said by everyone at the start and end of a call, and
// not an answer to anything. Taken out of what the user said before deciding whether they
// have taken their turn ("Hello, nice to meet you. Yes, I can hear you." has not).
const SMALL_TALK = new RegExp('(?:\\b(?:' + [
  'hello(?: there| everyone| everybody| all)?', 'hi(?: there| everyone| everybody| all)?', 'hey(?: there)?', 'good (?:morning|afternoon|evening|day)',
  "(?:it(?:'s| is) |it was )?(?:very |so |really )?(?:nice|good|great|lovely|pleased|glad|happy|a pleasure|pleasure) (?:to (?:meet|see|e-?meet|talk to|speak (?:to|with)) you|meeting you)(?: too| as well| again| all)?",
  '(?:how are you|how do you do|how are things|how is it going|how\'s it going|how have you been)(?: doing)?(?: today)?', '(?:and|how about|what about) you(?:rself)?',
  "(?:i(?:'m| am)|we(?:'re| are)|doing|all|very|pretty|quite|really)? ?(?:good|fine|great|well|okay|ok|not bad|doing well|doing good|doing great)(?: too| as well)?",
  'thank(?:s| you)(?: so much| very much| a lot)?(?: for (?:having me|your time|the time|the opportunity|taking the time|joining|inviting me|the invitation|the introduction|asking|that))?(?: today)?',
  "(?:can|could) you (?:hear|see) (?:me|my screen)(?: okay| ok| clearly| well| now| all right| alright)?", "(?:yes,? ?|yeah,? ?)?i can (?:hear|see) (?:you|your screen|it|that)(?: okay| ok| clearly| well| fine| now| too| loud and clear)?",
  'you too', 'same here', 'likewise', 'of course', 'no problem', 'sounds good', 'sorry(?: about that)?', 'excuse me', 'pardon(?: me)?',
  '(?:just |give me )?(?:a|one) (?:moment|second|sec|minute)(?: please)?', 'let me (?:think|see)(?: about (?:that|it))?', "that(?:'s| is) a (?:good|great|interesting) question",
  'bye(?: bye)?', 'goodbye', 'see you(?: soon| later| then)?', 'take care', 'have a (?:nice|good|great|lovely) (?:day|one|weekend|evening|week|rest of (?:the|your) (?:day|week))',
  'ok(?:ay)?', 'right', 'yeah', 'yes', 'yep', 'sure', 'so', 'well', 'alright', 'all right', 'cool', 'perfect', 'please', 'mm+-?hm+', 'uh-?huh', 'hm+', 'um+', 'uh+',
].join('|') + ')\\b|大家好|你好|您好|早上好|上午好|下午好|晚上好|很?(?:高兴|开心|荣幸)(?:认识|见到)(?:你|您|大家)|幸会|(?:非常|很)?(?:谢谢|感谢)(?:你|您|大家)?(?:的时间|的邀请|给我这个机会)?|(?:你|您)?(?:能|可以)?听(?:得)?(?:到|见)(?:我)?(?:吗|了)?|(?:我)?(?:能|可以)听(?:得)?(?:到|见)|不好意思|对不起|没问题|没关系|好的?|嗯+|对|是的|可以|行|再见|拜拜)', 'gi');
// Words a finished sentence does not end on.
const TRAILING_WORD = /\b(the|a|an|of|to|and|or|but|in|on|at|for|with|from|by|that|which|is|are|was|were|if|as|so|because|when|where|how|what|your|you|would|could|should)$/i;

const unit = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Array.from(v, x => x / n); };

// Holds the meeting state (transcript, shared-screen text) and produces
// answer suggestions. No Electron dependencies, so it can be tested in Node.
//
// Events:
//   'transcript' {type:'add'|'update'|'remove', entry:{id,who,text,t,pending}}
//   'answer'     {type:'start'|'sources'|'delta'|'done'|'error', id, ...}
//   'summary'    {type:'start'|'delta'|'done'|'error', ...} the write-up of the call, made when it ends
//   'notice'     {level:'error'|'info', message}
class Copilot extends EventEmitter {
  // debounceMs: how long after a finished question the answer starts. By then the pause has
  // already lasted through the silence that ended the utterance and its transcription, so
  // this only needs to cover a new utterance starting. trailMs: the longer wait when the
  // sentence trails off and more is probably coming.
  constructor({ getConfig, llm, kb, liveSearch, debounceMs = 250, trailMs = Math.round(debounceMs * 3.6) }) {
    super();
    this.getConfig = getConfig; this.llm = llm; this.kb = kb; this.liveSearch = liveSearch;
    this.debounceMs = debounceMs; this.trailMs = trailMs;
    this.entries = [];
    this.screenText = '';
    this.seq = 0;
    this.answerSeq = 0;
    this.pendingThem = 0;
    this.lastAnsweredId = 0;
    this.timer = null;
    this.abort = null;
    this.lastError = '';
    this.history = [];   // earlier questions and the answers suggested for them, oldest first
    this.speakingThem = false;
    this.generation = 0;
    this.sttTimeoutMs = 25000;
    this.summary = null;      // { t, text }: the write-up of this call, once made
    this.summaryAbort = null;
  }

  // Clears the conversation. Screen text is kept: the slide on screen has not changed.
  reset() {
    clearTimeout(this.timer);
    if (this.abort) this.abort.abort();
    if (this.summaryAbort) this.summaryAbort.abort();
    this.entries = []; this.lastAnsweredId = 0; this.history = []; this.summary = null;
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

  // A finished stretch of speech from one side, as a recording to transcribe. who: 'them' | 'you'
  // quietMs: how long the silence after it had already lasted when the piece was cut.
  async onSegment(who, wav, durationMs = 0, quietMs = 0) {
    const entry = this.openUtterance(who, Date.now() - durationMs);
    const vocab = (this.getConfig().stt.vocabulary || '').trim();
    return this.finishUtterance(entry, () => this.llm.transcribe(wav, { prompt: vocab ? `Glossary: ${vocab}` : '', signal: AbortSignal.timeout(this.sttTimeoutMs) }), durationMs, quietMs);
  }

  // Live transcription: the utterance is known to have started before its words are.
  // It shows in the transcript at once and holds back an answer until it is finished.
  openUtterance(who, startedAt = Date.now()) {
    const entry = { id: ++this.seq, who, text: '', t: startedAt, dur: 0, pending: true, generation: this.generation || 0 };
    this.entries.push(entry);
    this.emit('transcript', { type: 'add', entry: { ...entry } });
    if (who === 'them') { this.pendingThem++; clearTimeout(this.timer); }
    return entry;
  }

  // The words so far, while the utterance is still being spoken.
  partialUtterance(entry, text) {
    if (!entry.pending || entry.generation !== (this.generation || 0) || !this.entries.includes(entry)) return;
    this.emit('transcript', { type: 'update', entry: { ...entry, text: String(text || '').trim() } });
  }

  // The utterance ended. getText() -> its final text ('' when nothing was said).
  async finishUtterance(entry, getText, durationMs = 0, quietMs = 0) {
    const { who } = entry;
    entry.dur = durationMs; entry.ended = Date.now() - quietMs;
    let text = '';
    try { text = await getText(); } catch (e) {
      this._notice('error', e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Transcription timed out. Check your connection.' : e.message);
    }
    if (entry.generation !== (this.generation || 0)) return null; // meeting was cleared meanwhile
    if (who === 'them') this.pendingThem--;
    if (!text || (who === 'you' && this._isEchoOfThem(entry, text))) {
      this._remove(entry);
    } else {
      entry.text = text; entry.pending = false; entry.heard = Date.now();
      this.emit('transcript', { type: 'update', entry: { ...entry } });
      if (who === 'them') this._dropEchoesOf(entry);
    }
    if (who === 'them') this._maybeAutoAnswer();
    return entry.pending ? null : entry;
  }

  // The utterance was not speech after all (a cough, too short to count).
  cancelUtterance(entry) {
    if (entry.generation !== (this.generation || 0) || !this.entries.includes(entry)) return;
    if (entry.who === 'them') this.pendingThem--;
    this._remove(entry);
    if (entry.who === 'them') this._maybeAutoAnswer();
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

  // Whether something the microphone picked up is the user taking their turn: a real
  // reply, not a "yeah" or "mm-hm", not a greeting ("Hello, nice to meet you."), and not said
  // over the other side (their voice from the speakers, or a word of agreement while they talk).
  _isOwnTurn(you) {
    // Four words of substance once greetings and the like are set aside (Chinese: eight characters).
    const said = you.text.replace(SMALL_TALK, ' ');
    const cjk = (said.match(/[\u4e00-\u9fff]/g) || []).length;
    if (tokenize(said.replace(/[\u4e00-\u9fff]/g, ' ')).length + Math.floor(cjk / 2) < 4) return false;
    const start = you.t, end = you.t + (you.dur || 0);
    if (end <= start) return true;
    let over = 0;
    for (const e of this.entries) {
      if (e.who !== 'them' || e.pending) continue;
      over += Math.max(0, Math.min(end, e.t + (e.dur || 0)) - Math.max(start, e.t));
    }
    return over / (end - start) < 0.6;
  }

  // Their turn: everything the other side has said since the user last spoke, however long
  // and in however many pieces. That is the question, with its set-up; at the start of a
  // meeting, before the user has said anything, it is what they have said so far.
  // Bounded only against a silent or missing microphone: a gap of two minutes starts a new
  // turn, and at most about five minutes of talk is taken.
  // -> { run: its pieces in order, fresh: those not yet answered, answeredEnd: when the answered part ended (0 if none) }
  _theirTurn() {
    const run = [];
    let chars = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.pending) continue;
      if (e.who === 'you') { if (this._isOwnTurn(e)) break; continue; }
      if (run.length && run[0].t - (e.t + (e.dur || 0)) > 120000) break;
      run.unshift(e); chars += e.text.length;
      if (chars > 5000 || run.length >= 60) break;
    }
    const fresh = run.filter(e => e.id > this.lastAnsweredId);
    const answered = run.filter(e => e.id <= this.lastAnsweredId);
    const lastAnswered = answered[answered.length - 1];
    return { run, fresh, answeredEnd: lastAnswered ? lastAnswered.t + (lastAnswered.dur || 0) : 0 };
  }

  // What to search the user's material with for something they said.
  //   query: the words to look up. A long turn is searched by its end, where the question
  //   is; the set-up before it would pull in passages about everything mentioned on the way.
  //   A question too thin to search on gets a little of what came before it.
  //   whole: for search by meaning, the turn from its start as well (when it is longer than
  //   the query), so the set-up counts there too.
  _searchTexts(asked) {
    if (tokenize(asked).length < 4) {
      const prev = this.entries.filter(e => !e.pending && e.who === 'them').slice(-3).filter(e => !asked.includes(e.text)).map(e => e.text).join(' ');
      return { query: prev ? `${asked} ${prev}` : asked, whole: '' };
    }
    if (asked.length <= 700) return { query: asked, whole: '' };
    return { query: asked.slice(-700).replace(/^\S*\s/, ''), whole: asked.slice(-4000) };
  }

  // The meaning of some texts as vectors, or null when search by meaning is off or the
  // lookup fails. The last lookup is kept: it is started as soon as a question is heard,
  // while the app still waits to see whether they carry on, and the answer picks it up.
  _embed(texts) {
    if (!this.llm.embedConfigured() || !this.kb.stats().embedded) return Promise.resolve(null);
    const key = texts.join('\n\u0000\n');
    if (this._vecs && this._vecs.key === key) return this._vecs.promise;
    const promise = this.llm.embed(texts, { signal: AbortSignal.timeout(3000) }).catch(() => {
      if (this._vecs && this._vecs.promise === promise) this._vecs = null; // a failure is not remembered
      return null;
    });
    this._vecs = { key, promise };
    return promise;
  }

  _maybeAutoAnswer() {
    if (this.getConfig().autoAnswer !== 'questions' || this.pendingThem > 0 || this.speakingThem) return;
    const { run, fresh, answeredEnd } = this._theirTurn();
    if (!fresh.length) return;
    const said = fresh.map(e => e.text).join(' ');
    // Carrying straight on from what was already answered, the new words belong to that
    // question and the whole turn decides. After a longer gap they have to ask something
    // themselves: a remark added later ("We are a team of five.") does not restart the answer.
    const carriesOn = answeredEnd > 0 && fresh[0].t - answeredEnd < 6000;
    if (!detectQuestion(carriesOn || !answeredEnd ? run.map(e => e.text).join(' ') : said).ask) return;
    // Words of courtesy tacked on after the question was already taken up ("Take your time.",
    // "Right, okay.") are not a reason to start the answer over. Anything else is, however
    // short: "In SQL." changes what the answer should be.
    if (carriesOn && COURTESY.test(said.trim())) {
      this.lastAnsweredId = fresh[fresh.length - 1].id;
      return;
    }
    clearTimeout(this.timer);
    // The lookup of what they mean starts now and runs during the wait below.
    const texts = this._searchTexts(run.map(e => e.text).join(' '));
    this._embed(texts.whole ? [texts.query, texts.whole] : [texts.query]).catch(() => {});
    // A sentence that trails off ("How would you handle a pipeline that ...") is probably
    // not finished: wait longer before answering, so the answer is not started twice.
    // (Chinese is often written down without a closing mark, so there only an explicit
    // trailing-off counts.)
    const cjk = /[一-鿿]/.test(said);
    const trailsOff = /(\.\.\.|…|,|，)\s*$/.test(said) || (!cjk && (!/[.?!]["”')]?\s*$/.test(said) || TRAILING_WORD.test(said.replace(/[.\s]+$/, ''))));
    this.timer = setTimeout(() => {
      if (this.pendingThem > 0 || this.speakingThem) return; // they kept talking; the next segment reschedules
      if (this._theirTurn().fresh.length) this.answer({ mode: 'auto' }).catch(() => {});
    }, trailsOff ? this.trailMs : this.debounceMs);
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
    const begun = Date.now();
    let spoken = null; // when the words being answered ended, and when their transcript arrived

    let asked = question.trim();
    if (mode === 'auto' || mode === 'manual') {
      // The question is their whole turn: all they have said since the user last spoke.
      let { run } = this._theirTurn();
      if (!run.length && mode === 'manual') {
        // The user has spoken since: answer the last thing they said again.
        const last = [...this.entries].reverse().find(e => e.who === 'them' && !e.pending);
        if (last) run = [last];
      }
      if (!run.length) {
        this.emit('answer', { type: 'error', id, message: 'Nothing from the other side to answer yet.' });
        return '';
      }
      asked = run.map(e => e.text).join(' ');
      this.lastAnsweredId = run[run.length - 1].id;
      const last = run[run.length - 1];
      spoken = { end: last.ended || last.t + last.dur, heard: last.heard || Date.now() };
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
      // Retrieval: see _searchTexts.
      let { query, whole } = this._searchTexts(asked);
      if (mode === 'screen') { query = `${question} ${this.screenText.slice(0, 500)}`; whole = ''; }
      else if (mode === 'typed' && tokenize(asked).length < 5 && this.history.length) {
        query = `${asked} ${this.history[this.history.length - 1].question}`; whole = '';
      }
      const [{ hits: local, vecs }, live] = await Promise.all([this._searchKb(query, whole), this._searchLive(asked, cfg)]);
      if (ctl.signal.aborted) return '';
      // Answers prepared in advance go to the model in their own block, closest first: those
      // the search found for this question, then by how alike the questions are (in meaning
      // when search by meaning is on, in wording otherwise).
      const found = new Set(local.filter(r => r.qa).map(r => r.qa.q));
      const prepared = rankPrepared(this.kb.prepared ? this.kb.prepared() : [], query, vecs)
        .map(p => ({ ...p, found: found.has(p.q) }))
        .sort((a, b) => ((b.match ? 2 : 0) + (b.found ? 1 : 0)) - ((a.match ? 2 : 0) + (a.found ? 1 : 0)));
      const refs = [...live, ...local.filter(r => !r.qa)].slice(0, cfg.answerContext === 'lean' ? 3 : 9);
      // A prepared answer that fits is shown at once, to read while the reply is being written from it.
      if (mode !== 'screen' && prepared.length && prepared[0].match) this.emit('answer', { type: 'prepared', id, q: prepared[0].q, a: prepared[0].a });
      this.emit('answer', {
        type: 'sources', id,
        sources: [
          ...prepared.filter(p => p.match).slice(0, 2).map(p => ({ n: 'Q', title: `Prepared: ${p.q}`, path: '', url: '', snippet: p.a.slice(0, 280) })),
          ...refs.map((r, i) => ({ n: i + 1, title: r.title, path: r.path, url: r.url, snippet: r.text.slice(0, 280) })),
        ],
      });

      let firstWords = 0;
      const send = (lean) => this.llm.chatStream(this._buildMessages({ asked, mode, refs, prepared, cfg, lean }), {
        signal: ctl.signal,
        maxTokens: cfg.answerLength === 'detailed' ? 1800 : 1000, // headroom for reasoning models; the prompt sets the real length
        onDelta: (piece) => { if (!firstWords) firstWords = Date.now(); this.emit('answer', { type: 'delta', id, text: piece }); },
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
      // Where the time went, for an answer to something they said: from the end of their
      // words to the transcript (the silence that showed they had stopped, and transcription), from
      // there to starting (waiting to see whether they carry on), and from there to the first
      // words (search and the model).
      const timing = spoken && firstWords ? { heard: spoken.heard - spoken.end, wait: begun - spoken.heard, first: firstWords - begun } : null;
      this.history.push({ t: Date.now(), begun, mode, question: mode === 'screen' ? (question.trim() || 'what is on the shared screen') : asked, answer: text.trim(), ...(timing ? { timing } : {}) });
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

  // -> { hits, vecs }: vecs are the meaning of the query and, for a long turn, of the whole
  // turn (null without search by meaning). Passages are found by the two together, the end
  // of the turn counting twice because it is in both.
  async _searchKb(query, whole = '') {
    let timer;
    // A slow lookup is not worth holding the answer for: keywords still search.
    const vecs = await Promise.race([this._embed(whole ? [query, whole] : [query]), new Promise(resolve => { timer = setTimeout(resolve, 700, null); })]);
    clearTimeout(timer);
    let vec = null;
    if (vecs && vecs.length) {
      const units = vecs.map(unit);
      vec = units[0].map((x, i) => units.reduce((sum, u) => sum + (u[i] || 0), 0));
    }
    return { hits: this.kb.search(query, 8, vec), vecs: vecs && vecs.length ? vecs : null };
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
      '- When what is wanted is a query or code (SQL, Python, a formula, a command): put the complete, runnable answer first in a fenced code block with the language named. Inside the code, put a short comment above each logical step, numbered in the order the solution proceeds (for SQL: "-- 1. keep the last 30 days", "-- 2. count orders per customer", "-- 3. keep those with more than one"), each saying what the step does and why in plain words, so the user can talk through the code from top to bottom while typing it; no comment that merely restates the syntax, and none on trivial lines. Then one or two spoken sentences that follow the same steps in the same order, then at most two bullets on edge cases worth mentioning (NULLs, duplicates, ties, performance). Code does not count towards the word limit. Use the table and column names given; if they are not given, choose sensible ones and say which you assumed. Use the SQL dialect that is named or visible; otherwise standard SQL.',
      'Grounding:',
      '- The pinned notes and reference material are the user\'s own: their notes, CV, repositories, documents and API. Prefer them over general knowledge and cite references inline as [1], [2].',
      '- Papers, reports, projects and code in the user\'s material are the user\'s own work. Speak of them in the first person ("In my paper I ...", "we" for co-authored work), never as "the publication" or "the author". Give the specifics the references contain: the method, the data and its size, the numbers.',
      '- "Answers I prepared" are replies the user wrote in advance for questions they expect; what they state is the user\'s own fact. When what is asked is the same question as one of them, or close to it in meaning even if worded differently, build the reply on that prepared answer: keep its facts, examples, numbers and stance, fit it to the format and to exactly what was asked, and do not swap in other material or add a "Check:" line for what it states. When two apply, combine them. When none is close to the question, leave them out. The ones closest to what was asked are named under "Closest prepared answers", just before the question: start from those.',
      '- "Questions I want to ask the other side" in the pinned notes are the user\'s own questions for the people they are meeting. When the other side invites questions ("do you have any questions for us?", "anything you would like to ask?") or the user asks what to ask: write one short opening line, then every one of those questions that the conversation has not already answered, each as its own bullet, in the user\'s order and close to the user\'s wording (the limits on bullets and words do not apply to this reply). Leave out the ones the other side has already answered and end the list with one line starting "Skipped:" naming them in a few words each with what was said ("Skipped: team size (she said five)"); omit that line when none were answered. Then, under a line "Also worth asking:", add one or two further questions that follow from something the other side said in this conversation. Never answer these questions yourself, and do not bring them up at any other time.',
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
    // The request opens with what is the same from one answer to the next (the notes, the
    // prepared answers in their list's order) and only then what changes (the conversation,
    // the references, the question): services keep a prefix they have seen before, so the
    // unchanged part is not read again, and the reply starts sooner.
    // Notes sent with every answer: About me, CV, JD, Instructions, then pinned files from other sources.
    const notes = planPinned(this.kb.pinned ? this.kb.pinned() : [], lean ? { total: 6000, perNote: 2500 } : undefined)
      .filter(n => n.sent > 0).map(n => `### ${n.title}\n${n.text.slice(0, n.sent)}`);
    if (notes.length) parts.push(`Pinned notes from my sources (always included: who I am, my CV, the job description, instructions for this meeting):\n${notes.join('\n\n')}`);
    // Prepared answers: all of them, in the list's order, as many as fit; the closest ones are
    // named before the question (with their text, when they did not fit here). In lean mode
    // only the closest few, there.
    const sent = new Set();
    if (!lean) {
      const all = [];
      let space = 16000;
      for (const p of (this.kb.prepared ? this.kb.prepared() : [])) {
        const item = `Q: ${p.q}\nA: ${p.a.slice(0, 1200)}`;
        if (item.length > space) break; // the first so many, so the block stays the same from one answer to the next
        all.push(item); sent.add(p.q); space -= item.length;
      }
      if (all.length) parts.push(`Answers I prepared for questions I expect (my whole list):\n${all.join('\n\n')}`);
    }
    if (convo) parts.push(`Conversation so far (latest last):\n${convo}`);
    if (earlier) parts.push(`Earlier in this meeting you suggested these answers (most recent last):\n${earlier}`);
    if (this.screenText) parts.push(`Text on the shared screen (OCR):\n${this.screenText.slice(0, mode === 'screen' ? (lean ? 2500 : 5000) : (lean ? 600 : 1800))}`);
    if (refs.length) {
      parts.push('Reference material:\n' + refs.map((r, i) => `[${i + 1}] ${r.title}${r.path ? ` (${r.path})` : ''}\n${r.text.slice(0, lean ? 800 : 1500)}`).join('\n\n'));
    } else parts.push('Reference material: none found for this question.');
    const closest = [];
    for (const p of prepared) {
      if (!p.match && !lean) break; // lean mode sends the closest two even without a match
      closest.push(sent.has(p.q) ? `Q: ${p.q}` : `Q: ${p.q}\nA: ${p.a.slice(0, lean ? 600 : 1200)}`);
      if (closest.length >= (lean ? 2 : 3)) break;
    }
    if (closest.length) parts.push(`Closest prepared answers to what was asked (likeliest first):\n${closest.join('\n\n')}`);
    parts.push(mode === 'screen'
      ? `What I need: ${asked}\nBase the reply on the shared-screen text above. It is raw OCR of the whole screen, so ignore menus, toolbars, participant names and other clutter, and repair obvious OCR slips in names and code.`
      : mode === 'typed' ? `My question: ${asked}`
        : asked.length > 400 ? `Everything they have said since I last spoke (the question is usually at the end; what comes before sets it up, and every part of it counts):\n"${asked}"\nWrite what I should say.`
          : `They just said: "${asked}"\nWrite what I should say.`);
    return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }];
  }

  // ---- the write-up of the call ------------------------------------------------------
  // Whether enough was said for a summary to be worth writing: a real exchange, not a sound check.
  worthSummarising() {
    const said = this.entries.filter(e => !e.pending);
    return said.length >= 4 && said.reduce((n, e) => n + e.text.length, 0) >= 300;
  }

  // Writes a detailed account of the whole call from its transcript: what was covered, what
  // they said, how the user did, what to follow up. Made when listening stops, or on request.
  // auto: started by the app, so a call too short to summarise is passed over without a word.
  async summarize({ auto = false } = {}) {
    if (this.summaryAbort) this.summaryAbort.abort();
    const ctl = new AbortController();
    this.summaryAbort = ctl;
    const generation = this.generation || 0;
    try {
      // The last words are often still being transcribed when listening stops.
      for (let i = 0; i < 80 && this.entries.some(e => e.pending) && !ctl.signal.aborted; i++) await new Promise(r => setTimeout(r, 100));
      if (ctl.signal.aborted || generation !== (this.generation || 0)) return '';
      if (!this.worthSummarising()) {
        if (!auto) this.emit('summary', { type: 'error', message: 'There is not enough conversation to summarise yet.' });
        return '';
      }
      this.emit('summary', { type: 'start' });
      const cfg = this.getConfig();
      const send = (lean) => this.llm.chatStream(this._summaryMessages({ lean }), {
        signal: ctl.signal, maxTokens: 4000, // room for a long call and for reasoning models
        onDelta: (piece) => this.emit('summary', { type: 'delta', text: piece }),
      });
      let text;
      try { text = await send(cfg.answerContext === 'lean'); } catch (e) {
        // More than the service takes in one request: the end of the call, without the notes.
        if (cfg.answerContext === 'lean' || ctl.signal.aborted || !/too large|tokens per minute|\bTPM\b|context length|maximum context|request_too_large/i.test(e.message)) throw e;
        this.emit('summary', { type: 'start', trimmed: true });
        text = await send(true);
      }
      if (!text.trim()) throw new Error('The model returned no text. Try again, or check the chat model name in Settings.');
      this.summary = { t: Date.now(), text: text.trim() };
      this.emit('summary', { type: 'done', text: this.summary.text, t: this.summary.t });
      return this.summary.text;
    } catch (e) {
      if (!ctl.signal.aborted) this.emit('summary', { type: 'error', message: e.message });
      return '';
    } finally {
      if (this.summaryAbort === ctl) this.summaryAbort = null;
    }
  }

  // lean: for services that take little at once: the last part of the call, without the notes.
  _summaryMessages({ lean = false } = {}) {
    const system = [
      'You write the user\'s own record of a call that has just ended, from its transcript. "Me" is the user; "Them" is the other side (one person or several: the transcript does not tell them apart, so name a speaker only when the words make it clear). The user reads this afterwards to remember what happened, to judge how it went and to prepare for what comes next. Be complete, specific and honest.',
      'Write these sections in this order, each under a "## " heading with exactly this name. Leave a section out when the call has nothing for it.',
      '## Overview',
      'Three to five sentences: what kind of call it was, who it was with (names and roles only if they were said), what it was for, how long it ran, and how it ended, including any outcome or next step that was stated.',
      '## What was covered',
      'In the order of the call, one bullet for every question or topic the other side raised, none left out: the question or topic in a few words in bold, then what I answered (the substance and the specifics I gave: examples, numbers, tools), then how they reacted if they did.',
      '## What they told me',
      'Every fact the other side gave that I may need later, one bullet each: the role and its duties, the team and who is on it, the company, tools, expectations, the process and its stages, dates, pay or terms, anything they said about what they are looking for.',
      '## Questions I asked',
      'Each question I put to them and what they answered.',
      '## How I did',
      'Only when I was being assessed or was presenting (an interview, a pitch, a review, a demo). First "Went well:", then the strongest moments, each with what I said that made it work. Then "Weak:", then each answer that was thin, vague, rambling, off the question, contradicted something else I said, or missed what they were plainly looking for: name the question, quote a few of my words, and say in one sentence what was wrong. After each weak point add a line starting "Better:" giving what to say next time in one or two sentences, built on my notes when they cover it. Be direct. Do not flatter, do not soften a weak answer, and do not invent a weakness to fill the section. If the transcript holds little of what I said, state that my side was not captured and cannot be judged, and judge nothing.',
      '## Follow-ups',
      'What I said I would do or send, what they said they would do, and dates or deadlines, one bullet each, marked "Me:" or "Them:".',
      '## Worth preparing',
      'Questions from this call that I answered thinly or that are likely to be asked again elsewhere, worded as they were asked, one bullet each, so I can add them to my prepared answers.',
      'Rules:',
      '- Use only what the transcript supports. Never invent a name, number, date, outcome or reaction. Where the transcript is unclear, say so ("unclear in the transcript") rather than guess.',
      '- The transcript comes from speech recognition: read through obvious mis-hearings, and do not count a mis-heard word against me.',
      '- Lines marked "Suggested" are answers this app proposed on screen during the call. I may have said them, said something else, or said nothing. What I said is in the "Me" lines only: describe and judge my answers from those, never from a suggestion.',
      '- My notes, when given, are background: who I am and what the call was for (a job description describes what the other side wants, not what I have done). Use them to understand the call and for the "Better:" lines, not as things that were said.',
      '- Plain text: "## " headings as above, "- " bullets, bold (**like this**) only for the few words that open a bullet. No tables, no code blocks, no preamble before the first heading and no closing remarks after the last section.',
      '- Write in the language most of the call was held in. Length follows the call: every question and fact is kept, in few words each; an hour-long interview usually needs 600 to 1,000 words.',
    ].join('\n');

    const said = this.entries.filter(e => !e.pending);
    const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // A suggestion sits where it was asked for, straight after the words it answers.
    const items = [
      ...said.map(e => ({ t: e.t, text: `[${clock(e.t)}] ${e.who === 'them' ? 'Them' : 'Me'}: ${e.text}` })),
      ...this.history.filter(h => h.mode !== 'typed').map(h => ({ t: h.begun || h.t || 0, text: `[${clock(h.begun || h.t || Date.now())}] Suggested${h.mode === 'screen' ? ' (from the shared screen)' : ''}: ${h.answer.replace(/\s*\n\s*/g, ' ').slice(0, lean ? 200 : 500)}` })),
    ].sort((a, b) => a.t - b.t).map(x => x.text);
    // As much of the call as fits, counted from its end; a very long call loses its opening minutes.
    let room = lean ? 14000 : 150000, from = items.length;
    while (from > 0 && items[from - 1].length <= room) { room -= items[--from].length; }
    const cut = from > 0;
    const span = (ms) => { const m = Math.round(ms / 60000); return m >= 1 ? `${m} min` : `${Math.max(1, Math.round(ms / 1000))} s`; };
    const talk = (who) => span(said.filter(e => e.who === who).reduce((n, e) => n + (e.dur || 0), 0));
    const first = said[0], last = said[said.length - 1];
    const facts = `The call: ${new Date(first.t).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${clock(first.t)} to ${clock(last.t + (last.dur || 0))} (${span(last.t + (last.dur || 0) - first.t)}). Speech captured: them ${talk('them')}, me ${talk('you')}.`;
    const parts = [facts];
    if (!lean) {
      const notes = planPinned(this.kb.pinned ? this.kb.pinned() : [], { total: 12000, perNote: 4000 })
        .filter(n => n.sent > 0).map(n => `### ${n.title}\n${n.text.slice(0, n.sent)}`);
      if (notes.length) parts.push(`My notes (background, not part of the call):\n${notes.join('\n\n')}`);
    }
    parts.push(`Transcript${cut ? ' (the call was longer than fits; its opening is left out, so say in the overview that the summary starts part-way in)' : ''}:\n${items.slice(from).join('\n')}`);
    parts.push('Write the record of this call.');
    return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }];
  }

  // The conversation as text, in order: what each side said and, unless answers is false,
  // every answer suggested. (The summary of the call is in this.summary.)
  transcriptText({ answers: withAnswers = true } = {}) {
    const at = (t) => `[${new Date(t).toLocaleTimeString()}]`;
    const said = this.entries.filter(e => !e.pending).map(e => ({ t: e.t, text: `${at(e.t)} ${e.who === 'them' ? 'Them' : 'You'}: ${e.text}` }));
    const answers = this.history.map(h => ({ t: h.t || 0,
      text: `${at(h.t || Date.now())} Suggested answer${h.mode === 'typed' ? ` (you asked: ${h.question})` : h.mode === 'screen' ? ' (from the screen)' : ''}${h.timing ? ` (first words ${((h.timing.heard + h.timing.wait + h.timing.first) / 1000).toFixed(1)} s after they stopped)` : ''}:\n${h.answer.split('\n').map(l => '    ' + l).join('\n')}` }));
    return [...said, ...(withAnswers ? answers : [])].sort((a, b) => a.t - b.t).map(x => x.text).join('\n');
  }
}

module.exports = { Copilot };
