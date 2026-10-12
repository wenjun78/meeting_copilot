'use strict';
// Client for any OpenAI-compatible API (Groq, OpenAI, Azure-style gateways, Ollama, vLLM ...):
// speech-to-text, streaming chat and embeddings.

const ARTIFACTS = /^(thanks for watching|thank you for watching|please subscribe|subtitles by.*|.*amara\.org.*|字幕.*|ご視聴ありがとうございました|transcribed by.*|\[.*\]|\(.*\)|♪.*|\.+)$/i;
const FILLER = /^(thank you|thanks|you|bye|bye bye|okay|ok|yeah|so|hmm|uh|um|oh)$/i;

function friendlyError(status, body, what) {
  let msg = '';
  try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { msg = String(body || '').slice(0, 200); }
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  if (status === 401 || status === 403) return `${what}: the API key was rejected. Check it in Settings.`;
  if (status === 404) return `${what}: model or endpoint not found. Check the model name and base URL in Settings. ${msg}`.trim();
  if (status === 429) return `${what}: rate limit reached. ${msg}`.trim();
  return `${what} failed (${status}). ${msg}`.trim();
}

// Speech is transcribed as English, Mandarin, or either of the two. Limiting it to these keeps
// accented English from being written down as another language.
const speechLanguage = (v) => (v === 'en' || v === 'zh' ? v : 'en+zh');
const LANGUAGE_HINT = {
  en: 'This meeting is in English.',
  zh: '这场会议使用普通话，请用简体中文。',
  'en+zh': 'This meeting is in English and Mandarin Chinese. 这场会议使用英语和普通话。',
};
// Words that mark a sentence as English; ones shared with other languages ("a", "no", "me") are left out.
const ENGLISH = new Set(("the and is are was were to of for with from this that these those you they my your our their does did have has had " +
  "can could would should will not yes if then there here what which who when where why how about just like know think going get got it be been at by but we i " +
  "i'm it's don't that's i've we're you're can't didn't").split(' '));
const OTHER_SCRIPT = /[Ͱ-ϿЀ-ԯ֐-ݏऀ-෿฀-໿က-႟぀-ヿㇰ-ㇿ가-힯]/; // Greek, Cyrillic, Hebrew, Arabic, Indic, Thai, Lao, Burmese, kana, Hangul
const EAST_ASIAN = /[぀-ヿㇰ-ㇿ가-힯一-鿿]/;

// With English and Mandarin both allowed: '' when the text is in one of them, otherwise the
// language to transcribe the audio in again ('zh' when it came out in an East Asian script
// or language, 'en' for anything else).
function languageToForce(text, detected = '') {
  const lang = detected.toLowerCase();
  const named = lang ? (/^(en|english)$/.test(lang) ? 'en' : /^(zh|cmn|chinese|mandarin)/.test(lang) ? 'zh' : 'other') : '';
  if (OTHER_SCRIPT.test(text)) return EAST_ASIAN.test(text) ? 'zh' : 'en';
  if (named === 'other') return /^(ja|ko|yue|japanese|korean|cantonese|vietnamese|vi|wuu|nan|hak)/.test(lang) || EAST_ASIAN.test(text) ? 'zh' : 'en';
  if (named) return '';
  // No language reported: Chinese characters are Mandarin; Latin text has to read as English.
  if (/[一-鿿]/.test(text)) return '';
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 5) return '';
  let common = 0; for (const w of words) if (ENGLISH.has(w)) common++;
  return common / words.length >= 0.15 ? '' : 'en';
}

class LLM {
  // getConfig() -> { llm:{baseUrl,apiKey,model,extra}, stt:{...}, embed:{...} }
  constructor(getConfig, fetchFn = fetch) { this.getConfig = getConfig; this.fetch = fetchFn; }

  _endpoint(kind) {
    const cfg = this.getConfig();
    const own = cfg[kind] || {};
    const base = (own.baseUrl || cfg.llm.baseUrl || '').replace(/\/+$/, '');
    const key = own.baseUrl ? own.apiKey : (own.apiKey || cfg.llm.apiKey); // a custom endpoint never inherits the chat key
    if (!base) throw new Error('Add an API base URL in Settings.');
    return { base, key, model: own.model, own };
  }

  _headers(key, extra = {}) {
    const h = { ...extra };
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  // wav: Buffer (16 kHz mono PCM16). Returns the cleaned text ('' when nothing was said).
  // Speech is read as English or Mandarin only (see speechLanguage). With both allowed the
  // service picks between them per sentence; when what comes back is in neither (a sentence
  // heard as Malay, Japanese, Korean ...), the same audio is sent once more with the language
  // fixed, so the words come out in the language that was spoken.
  async transcribe(wav, { prompt = '', signal } = {}) {
    const { base, key, model, own } = this._endpoint('stt');
    const mode = speechLanguage(own.language);
    const send = async (format, language) => {
      const boundary = '----mc' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      const fields = { model: model || 'whisper-large-v3', response_format: format, temperature: '0' };
      if (language) fields.language = language;
      fields.prompt = [LANGUAGE_HINT[language || mode], prompt].filter(Boolean).join(' ');
      const parts = [];
      for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
      parts.push(Buffer.from(wav), Buffer.from(`\r\n--${boundary}--\r\n`));
      return this.fetch(`${base}/audio/transcriptions`, {
        method: 'POST', signal, body: Buffer.concat(parts),
        headers: this._headers(key, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }),
      });
    };
    // Which reply format this model takes is learned once, not asked again for every sentence.
    this._sttFormat = this._sttFormat || {};
    const formatKey = `${base}|${model}`;
    const once = async (language) => {
      let format = this._sttFormat[formatKey] || 'verbose_json';
      let res = await send(format, language);
      if (res.status === 400 && format === 'verbose_json') { // endpoint without verbose_json support
        res = await send((format = 'json'), language);
        if (res.ok) this._sttFormat[formatKey] = 'json';
      }
      if (res.status === 429 || res.status >= 500) {
        // Busy or rate-limited: wait briefly and try once more rather than lose the sentence.
        const wait = Math.min(6000, (Number(res.headers.get('retry-after')) || 1.5) * 1000);
        await new Promise(r => setTimeout(r, this.retryDelayMs ?? wait));
        res = await send(format, language);
      }
      const body = await res.text();
      if (!res.ok) throw new Error(friendlyError(res.status, body, 'Transcription'));
      let data; try { data = JSON.parse(body); } catch { data = { text: body }; }
      const text = cleanTranscript(data);
      // The hint itself coming back means nothing was said.
      const bare = text.replace(/[.。!！?？\s]+$/u, '').toLowerCase();
      const echoed = bare.length >= 10 && LANGUAGE_HINT[language || mode].toLowerCase().includes(bare);
      return { text: echoed ? '' : text, language: String(data.language || '') };
    };
    if (mode !== 'en+zh') return (await once(mode)).text;
    const first = await once('');
    const forced = first.text ? languageToForce(first.text, first.language) : '';
    if (!forced) return first.text;
    try { return (await once(forced)).text; } catch { return ''; } // better no line than one in the wrong language
  }

  // Streams a chat completion. onDelta(textPiece). Returns the full text.
  async chatStream(messages, { onDelta = () => {}, signal, maxTokens = 500, temperature = 0.3 } = {}) {
    const { base, key } = this._endpoint('llm');
    const cfg = this.getConfig().llm;
    if (!cfg.model) throw new Error('Add a chat model name in Settings.');
    const payload = { model: cfg.model, messages, stream: true, temperature, max_tokens: maxTokens };
    // The stream is abandoned if nothing arrives for `stallMs`.
    const stall = new AbortController();
    const linked = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), this.stallMs ?? 20000); };
    const post = (body) => this.fetch(`${base}/chat/completions`, {
      method: 'POST', signal: linked, body: JSON.stringify(body),
      headers: this._headers(key, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    });
    const extra = cfg.extra && typeof cfg.extra === 'object' ? cfg.extra : {};
    let full = '', buf = '';
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j; try { j = JSON.parse(data); } catch { return; }
      if (j.error) throw new Error(j.error.message || 'The model returned an error.');
      const piece = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (piece) { full += piece; onDelta(piece); }
    };
    try {
      arm();
      let body = { ...payload, ...extra };
      let res = await post(body);
      // Services differ in which parameters they accept. When a request is refused for one,
      // adjust it and try again: OpenAI's reasoning models want max_completion_tokens and no
      // temperature; other services may not know the extra parameters at all.
      for (let attempt = 0; res.status === 400 && attempt < 4; attempt++) {
        const why = await res.text();
        const extras = Object.keys(extra).filter(k => k in body);
        if ('max_tokens' in body && /max_tokens/.test(why)) {
          const { max_tokens: limit, ...rest } = body; body = { ...rest, max_completion_tokens: limit };
        } else if ('temperature' in body && /temperature/.test(why)) {
          const { temperature: _dropped, ...rest } = body; body = rest;
        } else if (extras.length) {
          const named = extras.filter(k => why.includes(k));
          body = { ...body }; for (const k of (named.length ? named : extras)) delete body[k];
        } else throw new Error(friendlyError(400, why, 'Answer'));
        arm();
        res = await post(body);
      }
      if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), 'Answer'));
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        arm();
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
      }
      if (buf.trim()) handle(buf.trim());
      return full;
    } catch (e) {
      if (stall.signal.aborted && !(signal && signal.aborted)) throw new Error('The model stopped responding. Try again.');
      throw e;
    } finally { clearTimeout(timer); }
  }

  // Search by meaning needs an embedding model: the one named in Settings, or, when nothing
  // is named and the service is OpenAI, its small embedding model with the same key.
  // "off" in Settings keeps search to keywords.
  embedModel() {
    const cfg = this.getConfig(), e = cfg.embed || {};
    const named = String(e.model || '').trim();
    if (/^(off|none|no|keyword)$/i.test(named)) return '';
    if (named) return named;
    const base = e.baseUrl || (cfg.llm && cfg.llm.baseUrl) || '';
    const key = e.baseUrl ? e.apiKey : (e.apiKey || (cfg.llm && cfg.llm.apiKey));
    return /^https:\/\/api\.openai\.com(\/|$)/.test(base) && key ? 'text-embedding-3-small' : '';
  }

  embedConfigured() { return Boolean(this.embedModel()); }

  async embed(texts, { signal } = {}) {
    const { base, key } = this._endpoint('embed');
    const model = this.embedModel();
    const res = await this.fetch(`${base}/embeddings`, {
      method: 'POST', signal, body: JSON.stringify({ model, input: texts }),
      headers: this._headers(key, { 'Content-Type': 'application/json' }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(friendlyError(res.status, body, 'Embedding'));
    const data = JSON.parse(body).data || [];
    return data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }
}

// Drops segments Whisper itself marks as non-speech and its well-known silence hallucinations.
function cleanTranscript(data) {
  let text;
  let doubtful = false;
  if (Array.isArray(data.segments) && data.segments.length) {
    const kept = data.segments.filter(s => !(s.no_speech_prob > 0.6) && !(s.no_speech_prob > 0.35 && s.avg_logprob < -1) && !(s.compression_ratio > 2.6));
    text = kept.map(s => s.text).join('').trim();
    doubtful = kept.some(s => s.no_speech_prob > 0.3 || s.avg_logprob < -0.8);
  } else text = String(data.text || '').trim();
  text = text.replace(/\s+/g, ' ');
  const bare = text.replace(/[.!?,。！？…\s]+$/u, '').trim();
  if (!bare || ARTIFACTS.test(bare)) return '';
  if (doubtful && FILLER.test(bare)) return '';
  // A phrase repeated many times in a row is a decoding loop, not speech.
  if (/(\b[\p{L}' ]{3,40}\b)(?:[,.!?]?\s+\1){4,}/iu.test(text)) return '';
  return text;
}

module.exports = { LLM, cleanTranscript, speechLanguage, languageToForce };
