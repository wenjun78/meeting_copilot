'use strict';
// Live transcription: one side's speech is streamed to the service while it is being spoken,
// so the words come back as they are said and the final text is ready the moment the
// speaker pauses, instead of after an upload.
//
// Protocol (OpenAI Realtime, transcription sessions, model gpt-live-transcribe):
//   connect  wss://.../v1/realtime?intent=transcription        Authorization: Bearer <key>
//   send     session.update { session: { type: 'transcription', audio: { input: {
//              format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null,
//              transcription: { model, languages, keywords, prompt, delay } } } } }
//   send     input_audio_buffer.append { audio: <base64 PCM16 mono 24 kHz> }   while speech lasts
//   send     input_audio_buffer.commit                                         when it pauses
//   receive  conversation.item.input_audio_transcription.delta { item_id, delta }
//            conversation.item.input_audio_transcription.completed { item_id, transcript }
// The model does not find the turns itself: this app's own speech detection says when an
// utterance starts and ends. A session lasts 60 minutes at most, so it is renewed before that.
//
// No Electron dependencies: tested in Node against a local server speaking the same protocol.
const { EventEmitter } = require('events');

const SESSION_MS = 50 * 60 * 1000; // renew well before the 60-minute limit

// http(s)://host/v1 -> ws(s)://host/v1/realtime?intent=transcription
const liveUrl = (base) => String(base || '').replace(/\/+$/, '').replace(/^http/i, 'ws') + '/realtime?intent=transcription';
const isLiveModel = (model) => /live/i.test(String(model || ''));

// Names and terms to listen for. A keyword with <, > or a line break makes the service
// reject the whole session, so those are taken out.
function keywordsFrom(vocabulary) {
  return String(vocabulary || '').split(/[,;\n]+/).map(k => k.replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim()).filter(k => k && k.length <= 60).slice(0, 80);
}

// 16 kHz float samples -> 24 kHz 16-bit PCM: three samples out for every two in, joined by straight lines.
function to24k(samples) {
  const out = Buffer.alloc(Math.floor(samples.length * 3 / 2) * 2);
  for (let i = 0, n = out.length / 2; i < n; i++) {
    const pos = i * 2 / 3, k = Math.floor(pos), f = pos - k;
    const a = samples[k];
    const b = k + 1 < samples.length ? samples[k + 1] : samples[k];
    const v = Math.max(-1, Math.min(1, a * (1 - f) + b * f));
    out.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  return out;
}

class LiveTranscriber extends EventEmitter {
  // options: { url, apiKey, model, languages: ['en','zh'], keywords: [], prompt, delay, WebSocket, finalMs }
  constructor(options) {
    super();
    this.o = { delay: 'low', finalMs: 4000, WebSocket: require('ws'), ...options };
    this.ws = null; this.ready = null; this.openedAt = 0;
    this.failed = '';        // why the session cannot be used, once known
    this.turn = null;        // the utterance being spoken: { text, itemId }
    this.waiting = [];       // committed utterances whose final text has not arrived: { itemId, text, resolve, reject, timer }
    this.items = new Map();  // item_id -> the turn or waiting entry it belongs to
  }

  // Opens the session. Resolves once the service has accepted the settings; rejects with the reason otherwise.
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { this.failed = err.message; reject(err); } else resolve(); };
      const timer = setTimeout(() => { done(new Error('The live transcription service did not respond.')); this.close(); }, 6000);
      let ws;
      try { ws = new this.o.WebSocket(this.o.url, { headers: { Authorization: `Bearer ${this.o.apiKey}` } }); } catch (e) { return done(e); }
      this.ws = ws;
      ws.on('open', () => {
        this.openedAt = Date.now();
        const transcription = { model: this.o.model, delay: this.o.delay };
        if (this.o.languages && this.o.languages.length) transcription.languages = this.o.languages;
        if (this.o.keywords && this.o.keywords.length) transcription.keywords = this.o.keywords;
        if (this.o.prompt) transcription.prompt = this.o.prompt;
        this._send({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null } } } });
      });
      ws.on('message', (data) => {
        let e; try { e = JSON.parse(data.toString()); } catch { return; }
        if (e.type === 'session.updated') return done();
        if (e.type === 'error') {
          const message = (e.error && (e.error.message || e.error.code)) || 'The live transcription service reported an error.';
          if (!settled) return done(new Error(message)); // the settings were refused
          return this._problem(message, e.error && e.error.code);
        }
        this._event(e);
      });
      ws.on('unexpected-response', (_req, res) => done(new Error(res.statusCode === 401 || res.statusCode === 403 ? 'The API key was rejected for live transcription.' : `The live transcription service answered ${res.statusCode}.`)));
      ws.on('error', (err) => { done(new Error(err.message || 'Could not reach the live transcription service.')); });
      ws.on('close', () => {
        done(new Error('The live transcription connection closed.'));
        if (this.ws === ws) { this.ws = null; this.ready = null; }
        for (const w of this.waiting.splice(0)) { clearTimeout(w.timer); w.reject(new Error('The live transcription connection closed.')); }
        this.turn = null; this.items.clear();
        this.emit('closed');
      });
    });
    this.ready.catch(() => {}); // callers that do not wait still must not crash the process
    return this.ready;
  }

  get open() { return !!this.ws && this.ws.readyState === 1 && !this.failed; }
  // A session about to reach its time limit is renewed between utterances.
  get stale() { return this.open && Date.now() - this.openedAt > SESSION_MS && !this.turn && !this.waiting.length; }

  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  // An utterance starts. Audio follows through append().
  begin() {
    this.turn = { text: '', itemId: '', bytes: 0 };
    return this.turn;
  }

  // samples: Float32Array, 16 kHz mono.
  append(samples) {
    if (!this.turn || !this.open || !samples.length) return;
    const pcm = to24k(samples);
    this.turn.bytes += pcm.length;
    this._send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  // The utterance ended. -> a promise for its final text; rejects when the service gives
  // none in time, so the caller can transcribe the recording another way.
  commit() {
    const turn = this.turn; this.turn = null;
    if (!turn || !this.open || !turn.bytes) return Promise.reject(new Error('Nothing was streamed for this utterance.'));
    return new Promise((resolve, reject) => {
      const entry = { itemId: turn.itemId, text: turn.text, resolve, reject };
      entry.timer = setTimeout(() => { this._drop(entry); reject(new Error('The live transcript did not arrive in time.')); }, this.o.finalMs);
      if (turn.itemId) this.items.set(turn.itemId, entry);
      this.waiting.push(entry);
      this._send({ type: 'input_audio_buffer.commit' });
    });
  }

  // The utterance turned out not to be speech worth keeping (a cough, their voice from the speakers).
  discard() {
    const turn = this.turn; this.turn = null;
    if (turn && turn.itemId) this.items.delete(turn.itemId);
    if (turn && turn.bytes) this._send({ type: 'input_audio_buffer.clear' });
  }

  _drop(entry) {
    const i = this.waiting.indexOf(entry);
    if (i >= 0) this.waiting.splice(i, 1);
    clearTimeout(entry.timer);
    if (entry.itemId) this.items.delete(entry.itemId);
  }

  // Which utterance an event belongs to. Events name an item; an item not seen before
  // belongs to the utterance being spoken, or, once that is committed, to the oldest
  // utterance still waiting without one.
  _owner(itemId) {
    if (itemId && this.items.has(itemId)) return this.items.get(itemId);
    const owner = (this.turn && !this.turn.itemId ? this.turn : null) || this.waiting.find(w => !w.itemId) || this.turn || this.waiting[0] || null;
    if (owner && itemId && !owner.itemId) { owner.itemId = itemId; this.items.set(itemId, owner); }
    return owner;
  }

  _event(e) {
    if (e.type === 'conversation.item.input_audio_transcription.delta') {
      const owner = this._owner(e.item_id);
      if (!owner || typeof e.delta !== 'string') return;
      owner.text += e.delta;
      if (owner === this.turn) this.emit('partial', owner.text);
    } else if (e.type === 'input_audio_buffer.committed') {
      const w = this.waiting.find(x => !x.itemId);
      if (w && e.item_id) { w.itemId = e.item_id; this.items.set(e.item_id, w); }
    } else if (e.type === 'conversation.item.input_audio_transcription.completed') {
      const owner = this._owner(e.item_id);
      if (!owner || owner === this.turn) return; // nothing is waiting for it
      this._drop(owner);
      owner.resolve(typeof e.transcript === 'string' ? e.transcript : owner.text);
    } else if (e.type === 'conversation.item.input_audio_transcription.failed') {
      const owner = this._owner(e.item_id);
      if (!owner || owner === this.turn) return;
      this._drop(owner);
      owner.reject(new Error((e.error && e.error.message) || 'The live transcript failed.'));
    }
  }

  // An error outside the opening handshake: the oldest waiting utterance is the one it concerns.
  _problem(message, code) {
    const w = this.waiting[0];
    if (w) { this._drop(w); w.reject(new Error(message)); }
    this.emit('problem', { message, code: code || '' });
  }

  close() {
    const ws = this.ws; this.ws = null; this.ready = null;
    if (ws) { try { ws.close(); } catch { /* already closed */ } }
  }
}

module.exports = { LiveTranscriber, liveUrl, isLiveModel, keywordsFrom, to24k };
