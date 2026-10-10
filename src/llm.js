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
  async transcribe(wav, { prompt = '', signal } = {}) {
    const { base, key, model, own } = this._endpoint('stt');
    const send = async (format) => {
      const boundary = '----mc' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      const fields = { model: model || 'whisper-large-v3', response_format: format, temperature: '0' };
      if (own.language) fields.language = own.language;
      if (prompt) fields.prompt = prompt;
      const parts = [];
      for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
      parts.push(Buffer.from(wav), Buffer.from(`\r\n--${boundary}--\r\n`));
      return this.fetch(`${base}/audio/transcriptions`, {
        method: 'POST', signal, body: Buffer.concat(parts),
        headers: this._headers(key, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }),
      });
    };
    let format = 'verbose_json';
    let res = await send(format);
    if (res.status === 400) res = await send((format = 'json')); // endpoint without verbose_json support
    if (res.status === 429 || res.status >= 500) {
      // Busy or rate-limited: wait briefly and try once more rather than lose the sentence.
      const wait = Math.min(6000, (Number(res.headers.get('retry-after')) || 1.5) * 1000);
      await new Promise(r => setTimeout(r, this.retryDelayMs ?? wait));
      res = await send(format);
    }
    const body = await res.text();
    if (!res.ok) throw new Error(friendlyError(res.status, body, 'Transcription'));
    let data; try { data = JSON.parse(body); } catch { data = { text: body }; }
    return cleanTranscript(data);
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
      for (let attempt = 0; res.status === 400 && attempt < 2; attempt++) {
        const why = await res.text();
        if (/max_tokens/.test(why) && 'max_tokens' in body) { // newer OpenAI models renamed the limit
          const { max_tokens: limit, ...rest } = body; body = { ...rest, max_completion_tokens: limit };
        } else if (Object.keys(extra).some(k => k in body)) { // provider rejected the extra params
          body = { ...payload, ...('max_completion_tokens' in body ? { max_tokens: undefined, max_completion_tokens: maxTokens } : {}) };
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

  embedConfigured() {
    const e = this.getConfig().embed || {};
    return Boolean(e.model);
  }

  async embed(texts, { signal } = {}) {
    const { base, key, model } = this._endpoint('embed');
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

module.exports = { LLM, cleanTranscript };
