'use strict';
const fs = require('fs');
const path = require('path');

const { DEFAULTS: SHORTCUTS, OLD_DEFAULTS: OLD_SHORTCUTS } = require('./shortcuts');

const DEFAULTS = {
  autoAnswer: 'questions',            // 'questions' | 'off'
  autoUpdate: true,                   // download and install new versions of the app
  autoSync: true,                     // re-read sources in the background when they change
  answerLength: 'short',              // 'short' | 'detailed'
  answerContext: 'full',              // 'full' | 'lean' (less sent per answer, for services with tight token limits)
  summaryOnStop: true,                // write up the call when listening stops
  defaults: 3,                        // which set of defaults these settings were last brought up to
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-6.1-sol', extra: { reasoning_effort: 'low' } },
  // stt.model: a live model (gpt-live-transcribe) streams the other side's speech as it is spoken;
  // batchModel transcribes recordings: the microphone, and anything the live model fails on.
  stt: { baseUrl: '', apiKey: '', model: 'gpt-live-transcribe', batchModel: 'gpt-4o-transcribe', delay: 'low', language: 'en+zh', vocabulary: '' }, // language: 'en+zh' | 'en' | 'zh'
  embed: { baseUrl: '', apiKey: '', model: '' },
  github: { token: '', apiBase: 'https://api.github.com' },
  api: { searchUrl: '', headerName: 'Authorization', headerValue: '' },
  capture: { micDeviceId: '', themSource: 'system', ocrIntervalSec: 4, ocrLangs: 'eng', record: false }, // record: keep the meeting's audio as a file
  shortcuts: { ...SHORTCUTS },         // '' turns one off
  ui: { opacity: 1, bounds: null, onTop: true, theme: 'dark' }, // theme: 'dark' | 'light'
};

const SECRET_PATHS = [['llm', 'apiKey'], ['stt', 'apiKey'], ['embed', 'apiKey'], ['github', 'token'], ['api', 'headerValue']];

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined || over === null ? base : over;
}

// crypto: { encrypt(str)->base64, decrypt(base64)->str } or null (keys stored as plain text).
class ConfigStore {
  constructor(file, crypto = null) { this.file = file; this.crypto = crypto; this.data = merge(DEFAULTS, {}); }

  load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    for (const [a, b] of SECRET_PATHS) {
      const v = raw[a] && raw[a][b];
      if (typeof v === 'string' && v.startsWith('enc:')) {
        try { raw[a][b] = this.crypto ? this.crypto.decrypt(v.slice(4)) : ''; } catch { raw[a][b] = ''; }
      }
    }
    // The answer model that used to be the default moves to the current one, once; a model
    // chosen after that is left alone.
    if ((raw.defaults || 1) < 2 && raw.llm && raw.llm.model === 'gpt-5.6-sol') raw.llm.model = 'gpt-6.1-sol';
    // Shortcuts still on the old defaults move to the easier ones; a combination the user chose stays.
    if ((raw.defaults || 1) < 3 && raw.shortcuts) {
      for (const [action, old] of Object.entries(OLD_SHORTCUTS)) if (old.includes(raw.shortcuts[action])) raw.shortcuts[action] = SHORTCUTS[action];
    }
    // Speech: the earlier default model moves to live transcription, on OpenAI only (where it exists).
    if ((raw.defaults || 1) < 3 && raw.stt && raw.stt.model === 'gpt-4o-transcribe' && !raw.stt.baseUrl && /^https:\/\/api\.openai\.com/.test((raw.llm && raw.llm.baseUrl) || DEFAULTS.llm.baseUrl)) raw.stt.model = 'gpt-live-transcribe';
    raw.defaults = DEFAULTS.defaults;
    this.data = merge(DEFAULTS, raw);
    // Speech is read as English, Mandarin or both; any other saved setting becomes both.
    if (!['en', 'zh', 'en+zh'].includes(this.data.stt.language)) this.data.stt.language = 'en+zh';
    // `extra` is free-form: keep exactly what the user saved, including {}.
    if (raw.llm && raw.llm.extra && typeof raw.llm.extra === 'object') this.data.llm.extra = raw.llm.extra;
    return this.data;
  }

  get() { return this.data; }

  update(patch) {
    const extra = patch && patch.llm && patch.llm.extra;
    this.data = merge(this.data, patch);
    if (extra && typeof extra === 'object') this.data.llm.extra = extra;
    this.save();
    return this.data;
  }

  save() {
    const out = JSON.parse(JSON.stringify(this.data));
    if (this.crypto) {
      for (const [a, b] of SECRET_PATHS) if (out[a][b]) out[a][b] = 'enc:' + this.crypto.encrypt(out[a][b]);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
  }
}

module.exports = { ConfigStore, DEFAULTS };
