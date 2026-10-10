'use strict';
const fs = require('fs');
const path = require('path');

const { DEFAULTS: SHORTCUTS } = require('./shortcuts');

const DEFAULTS = {
  profile: '',
  context: '',                        // this meeting: job description, agenda or brief; always given to the model
  autoAnswer: 'questions',            // 'questions' | 'off'
  autoSync: true,                     // re-read sources in the background when they change
  answerLength: 'short',              // 'short' | 'detailed'
  llm: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '', model: 'openai/gpt-oss-120b', extra: { reasoning_effort: 'low' } },
  stt: { baseUrl: '', apiKey: '', model: 'whisper-large-v3', language: '', vocabulary: '' },
  embed: { baseUrl: '', apiKey: '', model: '' },
  github: { token: '', apiBase: 'https://api.github.com' },
  api: { searchUrl: '', headerName: 'Authorization', headerValue: '' },
  capture: { micDeviceId: '', themSource: 'system', ocrIntervalSec: 4, ocrLangs: 'eng' },
  shortcuts: { ...SHORTCUTS },         // '' turns one off
  ui: { opacity: 1, bounds: null },
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
    this.data = merge(DEFAULTS, raw);
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
