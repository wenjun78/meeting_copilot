'use strict';
// A local stand-in for the OpenAI-compatible API, the GitHub API and a
// user-owned search API. Used by the unit tests and the end-to-end smoke test.
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { writeTar } = require('../src/rag/tar');

const REPO_FILES = [
  { path: 'wj-etl-pipeline-abc123/README.md', data: '# Customer ETL pipeline\n\nNightly pipeline that loads customer master records.\n\n## Deduplication\n\nDuplicates are removed in two passes. First an exact match on the normalised tax ID and country code. Then a fuzzy match on company name using Jaro-Winkler with a 0.92 threshold, blocked by postal code so the comparison stays linear. Survivorship keeps the most recently verified record.\n\n## Scheduling\n\nJobs run from cron on a Linux server as bash plus SQL scripts. The full load takes about 40 minutes for 12 million records.\n' },
  { path: 'wj-etl-pipeline-abc123/src/dedupe.py', data: 'import jellyfish\n\nTHRESHOLD = 0.92\n\ndef is_duplicate(a, b):\n    """Fuzzy company-name match used in the second dedupe pass."""\n    if a.postal_code != b.postal_code:\n        return False\n    return jellyfish.jaro_winkler_similarity(a.name, b.name) >= THRESHOLD\n' },
  { path: 'wj-etl-pipeline-abc123/notebooks/eda.ipynb', data: JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Exploratory analysis\n', 'Null rate per column before cleaning.'] }, { cell_type: 'code', source: 'df.isna().mean()', outputs: [{ text: 'x'.repeat(5000) }] }] }) },
  { path: 'wj-etl-pipeline-abc123/node_modules/junk/index.js', data: 'module.exports = 1' },
  { path: 'wj-etl-pipeline-abc123/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
  { path: 'wj-etl-pipeline-abc123/knowledge/about.md', data: '---\ntitle: About Alex\npinned: true\n---\n# About\n\nAlex Tan is an engineer based in Penang who enjoys badminton.\n' },
  { path: 'wj-etl-pipeline-abc123/knowledge/_jd.md', data: '# Senior ML Engineer, Example Corp\n\n## Must have\n\n- Kubernetes and model serving\n- Feature stores\n' },
  { path: 'wj-etl-pipeline-abc123/cv/sample-cv.pdf', data: fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf')) },
  { path: 'wj-etl-pipeline-abc123/cv/sample-cv.docx', data: fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.docx')) },
];

// live: how the live-transcription socket behaves: { lines: [...] } the final text of each
// committed utterance in turn (default: sttLines), { refuse: 'reason' } rejects the session
// settings, { silent: true } never sends a final text, { closeAfter: n } drops the connection
// after n utterances.
function start({ sttLines = ['Hello there.'], sttBusy = 0, pushedAt = '2026-10-01T00:00:00Z', answer = 'I remove duplicates in two passes [1].\n- Exact match on tax ID\n- Fuzzy match at 0.92', live = {} } = {}) {
  const log = { chat: [], stt: [], embed: [], search: [], github: [], tarballs: 0, live: { sessions: [], auth: [], appended: [], commits: 0, clears: 0 } };
  const state = { pushedAt };
  let sttIndex = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (url.pathname === '/v1/audio/transcriptions') {
        if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: { message: 'bad key' } });
        if (sttBusy-- > 0) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' }); return res.end(JSON.stringify({ error: { message: 'slow down' } })); }
        const text = body.toString('latin1');
        const field = (name) => (new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(text) || [])[1] || '';
        const asked = { bytes: body.length, hasWav: text.includes('RIFF'), prompt: Buffer.from(field('prompt'), 'latin1').toString('utf8'), model: field('model'), language: field('language'), format: field('response_format') };
        log.stt.push(asked);
        if (asked.model === 'plain-json-stt' && asked.format === 'verbose_json') return json(400, { error: { message: 'response_format verbose_json is not supported' } });
        // A line is text, {text, language}, or a function of the request (to answer by language).
        let line = sttLines[sttIndex++ % sttLines.length];
        if (typeof line === 'function') line = line(asked);
        if (typeof line === 'string') line = { text: line };
        if (asked.format !== 'verbose_json') return json(200, { text: line.text });
        return json(200, { text: line.text, ...(line.language ? { language: line.language } : {}), segments: [{ text: line.text, no_speech_prob: 0.01, avg_logprob: -0.2 }] });
      }
      if (url.pathname === '/v1/chat/completions') {
        const payload = JSON.parse(body.toString());
        log.chat.push(payload);
        if (payload.reject_me) return json(400, { error: { message: 'unknown param' } });
        if (payload.model === 'strict-reasoner') { // behaves like a reasoning model that refuses the classic parameters one at a time
          if ('max_tokens' in payload) return json(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
          if ('temperature' in payload) return json(400, { error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported." } });
          if ('verbosity' in payload) return json(400, { error: { message: "Unknown parameter: 'verbosity'." } });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const SQL = 'Here is the query.\n```sql\nSELECT c.id, c.name, COUNT(*) AS orders\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nWHERE o.created_at >= CURRENT_DATE - INTERVAL \'30\' DAY\nGROUP BY c.id, c.name\nHAVING COUNT(*) > 1;\n```\nI join orders to customers, keep the last 30 days, and filter groups with more than one order.\n- Customers with no orders drop out of the inner join';
        const fromScreen = /Base the reply on the shared-screen text/.test(payload.messages.at(-1).content);
        const words = (fromScreen ? SQL : answer).split(/(?<= )/);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', reasoning: 'thinking...' } }] })}\n\n`);
        let i = 0;
        const tick = () => {
          if (i >= words.length) { res.write('data: [DONE]\n\n'); return res.end(); }
          // Split one event across two writes to exercise the stream parser.
          const ev = `data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`;
          res.write(ev.slice(0, 9)); res.write(ev.slice(9));
          setTimeout(tick, 4);
        };
        return tick();
      }
      if (url.pathname === '/v1/embeddings') {
        const payload = JSON.parse(body.toString());
        log.embed.push(payload);
        // Toy embedding: 3 dims keyed on topic words.
        const vec = (t) => [/dedup|duplicate|same compan|twice/i.test(t) ? 1 : 0, /schedul|cron|nightly/i.test(t) ? 1 : 0, 0.1];
        return json(200, { data: payload.input.map((t, index) => ({ index, embedding: vec(t) })) });
      }
      if (url.pathname === '/gh/repos/wj/etl-pipeline') { log.github.push(req.headers.authorization || ''); return json(200, { default_branch: 'main', html_url: 'https://github.com/wj/etl-pipeline', description: 'Customer master ETL', pushed_at: state.pushedAt }); }
      if (url.pathname === '/gh/repos/wj/etl-pipeline/tarball/main') {
        log.tarballs++;
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        return res.end(zlib.gzipSync(writeTar(REPO_FILES)));
      }
      if (url.pathname === '/gh/users/wj/repos') return json(200, [{ name: 'etl-pipeline', owner: { login: 'wj' }, size: 10, default_branch: 'main', html_url: 'https://github.com/wj/etl-pipeline', description: 'Customer master ETL', pushed_at: state.pushedAt }, { name: 'a-fork', owner: { login: 'wj' }, fork: true, size: 5 }]);
      if (url.pathname === '/gh/__push') { state.pushedAt = new Date().toISOString(); return json(200, { ok: true }); } // test helper: simulate a push
      if (url.pathname.startsWith('/gh/')) return json(404, { message: 'Not Found' });
      if (url.pathname === '/kb/search') {
        log.search.push({ q: url.searchParams.get('q'), auth: req.headers['x-api-key'] });
        return json(200, { results: [{ title: 'SLA policy', content: 'Master data change requests are completed within 2 business days.', url: 'https://kb.example/sla' }] });
      }
      if (url.pathname === '/kb/slow') return void setTimeout(() => json(200, []), 5000);
      if (url.pathname === '/kb/faq.json') return json(200, [{ question: 'What is CPM?', answer: 'CPM is the customer profile management system.' }, { question: 'Who approves new accounts?', answer: 'The account service team approves them.' }]);
      if (url.pathname === '/kb/cv.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'))); }
      if (url.pathname === '/kb/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><head><style>x{}</style></head><body><h1>Runbook</h1><p>Restart the loader with <b>systemctl restart loader</b>.</p><script>alert(1)</script></body></html>'); }
      json(404, { error: { message: 'no route' } });
    });
  });
  // Live transcription: the Realtime transcription protocol, as far as the app uses it.
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/v1/realtime' || url.searchParams.get('intent') !== 'transcription') return socket.destroy();
    if (req.headers.authorization !== 'Bearer test-key') { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      log.live.auth.push(req.headers.authorization);
      const lines = live.lines || sttLines;
      let bytes = 0, item = 0, said = 0, done = 0, lineIndex = 0;
      const send = (o) => ws.send(JSON.stringify(o));
      const current = () => `item_${item}`;
      const lineFor = () => lines[lineIndex % lines.length];
      ws.on('message', (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === 'session.update') {
          log.live.sessions.push(e.session);
          if (live.refuse) return send({ type: 'error', error: { code: 'invalid_request_error', message: live.refuse } });
          return send({ type: 'session.updated', session: e.session });
        }
        if (e.type === 'input_audio_buffer.append') {
          const n = Buffer.from(e.audio, 'base64').length;
          bytes += n;
          // Words come back while the audio is still arriving: one more for every 0.2 s (9,600 bytes at 24 kHz, 16 bit).
          const words = lineFor().split(' ');
          while (said < words.length - 1 && said < Math.floor(bytes / 9600)) send({ type: 'conversation.item.input_audio_transcription.delta', item_id: current(), content_index: 0, delta: (said ? ' ' : '') + words[said++] });
          return;
        }
        if (e.type === 'input_audio_buffer.clear') { log.live.clears++; bytes = 0; said = 0; item++; return; }
        if (e.type === 'input_audio_buffer.commit') {
          if (!bytes) return send({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'Error committing input audio buffer: buffer too small.' } });
          log.live.commits++; log.live.appended.push(bytes);
          const id = current(), words = lineFor().split(' '), text = lineFor(), from = said;
          bytes = 0; said = 0; item++; lineIndex++;
          send({ type: 'input_audio_buffer.committed', item_id: id });
          if (live.silent) return;
          for (let i = from; i < words.length; i++) send({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: (i ? ' ' : '') + words[i] });
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text });
          if (live.closeAfter && ++done >= live.closeAfter) ws.close();
        }
      });
    });
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, log, state, close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); server.closeAllConnections(); server.close(r); }) });
  }));
}

module.exports = { start };
if (require.main === module) start().then(s => console.log(s.base));
