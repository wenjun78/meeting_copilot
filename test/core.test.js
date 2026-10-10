'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-server');
const { tokenize } = require('../src/rag/tokenize');
const { chunkFile, isIndexable } = require('../src/rag/chunker');
const { parseRepoSpec, fetchRepo, listRepos } = require('../src/rag/github');
const { ingestUrl, liveSearch, itemsFromJson } = require('../src/rag/api');
const { ingestFolder } = require('../src/rag/local');
const { KnowledgeBase } = require('../src/rag/kb');
const { LLM, cleanTranscript } = require('../src/llm');
const { detectQuestion } = require('../src/question');
const { ConfigStore } = require('../src/config');
const { Copilot } = require('../src/copilot');
const { cleanOcrText } = require('../src/ocr');
const shortcuts = require('../src/shortcuts');

let srv;
test.before(async () => { srv = await mock.start({ sttLines: ['How do you handle duplicate customer records?'] }); });
test.after(async () => { await srv.close(); });

const cfgFor = (over = {}) => {
  const cfg = {
    profile: 'Data engineer.', autoAnswer: 'questions', answerLength: 'short',
    llm: { baseUrl: srv.base + '/v1', apiKey: 'test-key', model: 'chat-model', extra: { reasoning_effort: 'low' } },
    stt: { baseUrl: '', apiKey: '', model: 'whisper-large-v3', language: '', vocabulary: 'CPM, Jaro-Winkler' },
    embed: { baseUrl: '', apiKey: '', model: '' },
    api: { docUrls: [], searchUrl: '', headerName: 'X-Api-Key', headerValue: 'secret' },
    github: { token: '', repos: [] },
    ...over,
  };
  return () => cfg;
};

test('tokenize splits identifiers, stems and handles CJK', () => {
  assert.deepEqual(tokenize('customerMasterRecords get_user_id'), ['customer', 'master', 'record', 'user', 'id']);
  assert.ok(tokenize('数据管道').includes('数据'));
  assert.deepEqual(tokenize('How do you handle the duplicates?'), ['handle', 'duplicate']);
});

test('chunker keeps heading context and skips vendored files', () => {
  const chunks = chunkFile('docs/guide.md', '# Guide\n\nIntro text here.\n\n## Install\n\n' + 'Step. '.repeat(400) + '\n\n## Usage\n\nRun it.');
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.some(c => c.title.includes('Guide > Install')));
  assert.ok(chunks.every(c => c.text.length <= 1200));
  assert.equal(isIndexable('node_modules/x/index.js', 10), false);
  assert.equal(isIndexable('src/app.py', 10), true);
  assert.equal(isIndexable('package-lock.json', 10), false);
  assert.equal(isIndexable('img/logo.png', 10), false);
  const code = chunkFile('a.py', Array.from({ length: 200 }, (_, i) => `x${i} = ${i}`).join('\n'));
  assert.ok(code.length >= 3 && code[1].line > 1);
});

test('parseRepoSpec accepts the common ways of naming a repo', () => {
  assert.deepEqual(parseRepoSpec('wj/etl'), { owner: 'wj', repo: 'etl', ref: '', subdir: '' });
  assert.deepEqual(parseRepoSpec('wj/etl@dev'), { owner: 'wj', repo: 'etl', ref: 'dev', subdir: '' });
  assert.deepEqual(parseRepoSpec('https://github.com/wj/etl/tree/main/docs/api'), { owner: 'wj', repo: 'etl', ref: 'main', subdir: 'docs/api' });
  assert.deepEqual(parseRepoSpec('https://github.com/wj/etl.git'), { owner: 'wj', repo: 'etl', ref: '', subdir: '' });
  assert.equal(parseRepoSpec('wj').repo, '');
  assert.throws(() => parseRepoSpec('not a repo!'));
});

test('GitHub ingestion reads a tarball, flattens notebooks, skips binaries and vendored code', async () => {
  const r = await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh', token: 'ghp_x' });
  assert.equal(r.files, 3);
  assert.equal(srv.log.github.at(-1), 'Bearer ghp_x');
  const paths = new Set(r.chunks.map(c => c.path));
  assert.ok(paths.has('etl-pipeline/README.md') && paths.has('etl-pipeline/src/dedupe.py') && paths.has('etl-pipeline/notebooks/eda.ipynb'));
  assert.ok(![...paths].some(p => p.includes('node_modules') || p.endsWith('.png')));
  assert.ok(!r.chunks.some(c => c.text.includes('xxxxxxxx')), 'notebook outputs are dropped');
  assert.ok(r.chunks.find(c => c.path.endsWith('dedupe.py')).url.includes('/blob/main/src/dedupe.py#L1'));
  const repos = await listRepos('wj', { apiBase: srv.base + '/gh' });
  assert.deepEqual(repos.map(x => x.repo), ['etl-pipeline']);
  await assert.rejects(fetchRepo(parseRepoSpec('wj/missing'), { apiBase: srv.base + '/gh' }), /not found/);
});

test('knowledge base ranks the right chunk, persists and reloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const kb = new KnowledgeBase(dir);
  kb.setSource(await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh' }));
  const hits = kb.search('How do you handle duplicate customer records?', 3);
  assert.match(hits[0].text, /Jaro-Winkler/);
  assert.match(kb.search('when does the job run, how long does the full load take', 2)[0].text, /40 minutes/);
  kb.save();
  const again = new KnowledgeBase(dir).load();
  assert.equal(again.chunks.length, kb.chunks.length);
  assert.match(again.search('fuzzy threshold', 1)[0].text, /0\.92/);
  again.removeSource('github:wj/etl-pipeline');
  assert.equal(again.search('duplicate', 3).length, 0);
});

test('embeddings add semantic matches that keywords miss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const kb = new KnowledgeBase(dir);
  kb.setSource(await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh' }));
  const llm = new LLM(cfgFor({ embed: { baseUrl: '', apiKey: '', model: 'embed-model' } }));
  const n = await kb.embedMissing(t => llm.embed(t), 'embed-model');
  assert.equal(n, kb.chunks.length);
  // No keyword overlap with the README, but the toy embedding maps it to the dedupe topic.
  const q = 'What if the same company shows up twice?';
  const [vec] = await llm.embed([q]);
  assert.match(kb.search(q, 2, vec)[0].text, /Jaro|duplicate/i);
  kb.save();
  const again = new KnowledgeBase(dir).load();
  assert.equal(again.stats().embedded, kb.chunks.length);
  assert.equal(again.chunks[0].vec.length, 3);
});

test('API ingestion handles JSON collections and HTML pages; live search passes auth and times out', async () => {
  const faq = await ingestUrl(srv.base + '/kb/faq.json');
  assert.equal(faq.chunks.length, 2);
  assert.match(faq.chunks[0].text, /Q: What is CPM\?\nA: CPM is the customer profile/);
  const page = await ingestUrl(srv.base + '/kb/page.html');
  assert.match(page.chunks[0].text, /systemctl restart loader/);
  assert.ok(!page.chunks.some(c => /alert\(1\)|x\{\}/.test(c.text)));
  const hits = await liveSearch(srv.base + '/kb/search?q={query}', 'sla for change requests', { auth: { headerName: 'X-Api-Key', headerValue: 'secret' } });
  assert.equal(hits[0].title, 'SLA policy');
  assert.deepEqual(srv.log.search.at(-1), { q: 'sla for change requests', auth: 'secret' });
  await assert.rejects(liveSearch(srv.base + '/kb/slow', 'x', { timeoutMs: 150 }), /timed out/);
  assert.equal(itemsFromJson({ hits: { hits: [{ _source: { title: 'T', body: 'B' } }] } })[0].text, 'B');
});

test('local folder ingestion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nThe CPM system owns account hierarchies.');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.md'), 'ignore me');
  const r = ingestFolder(dir);
  assert.equal(r.files, 1);
  assert.match(r.chunks[0].text, /account hierarchies/);
});

test('transcription sends a WAV with the glossary prompt and filters non-speech', async () => {
  const llm = new LLM(cfgFor());
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100)]);
  assert.equal(await llm.transcribe(wav, { prompt: 'Glossary: CPM' }), 'How do you handle duplicate customer records?');
  const sent = srv.log.stt.at(-1);
  assert.ok(sent.hasWav); assert.equal(sent.prompt, 'Glossary: CPM'); assert.equal(sent.model, 'whisper-large-v3');
  await assert.rejects(new LLM(cfgFor({ llm: { baseUrl: srv.base + '/v1', apiKey: 'wrong', model: 'm' } })).transcribe(wav), /API key was rejected/);
  assert.equal(cleanTranscript({ text: 'Thanks for watching!' }), '');
  assert.equal(cleanTranscript({ segments: [{ text: ' Thank you.', no_speech_prob: 0.5, avg_logprob: -0.9 }] }), '');
  assert.equal(cleanTranscript({ segments: [{ text: ' Thank you.', no_speech_prob: 0.02, avg_logprob: -0.1 }] }), 'Thank you.');
  assert.equal(cleanTranscript({ segments: [{ text: ' hello', no_speech_prob: 0.9 }, { text: ' Real words here.', no_speech_prob: 0.1 }] }), 'Real words here.');
  assert.equal(cleanTranscript({ text: 'I agree, I agree, I agree, I agree, I agree, I agree.' }), '');
});

test('transcription retries once when the service is rate-limited', async () => {
  const s2 = await mock.start({ sttLines: ['Second try worked.'], sttBusy: 1 });
  const cfg = { llm: { baseUrl: s2.base + '/v1', apiKey: 'test-key', model: 'm' }, stt: { model: 'w' }, embed: {} };
  const llm = new LLM(() => cfg); llm.retryDelayMs = 10;
  assert.equal(await llm.transcribe(Buffer.from('RIFF')), 'Second try worked.');
  const s3 = await mock.start({ sttBusy: 5 });
  const cfg3 = { llm: { baseUrl: s3.base + '/v1', apiKey: 'test-key', model: 'm' }, stt: { model: 'w' }, embed: {} };
  const llm3 = new LLM(() => cfg3); llm3.retryDelayMs = 10;
  await assert.rejects(llm3.transcribe(Buffer.from('RIFF')), /rate limit reached/);
  await s2.close(); await s3.close();
});

test('chat streaming reassembles split events, ignores reasoning and retries without extra params', async () => {
  const llm = new LLM(cfgFor());
  const pieces = [];
  const text = await llm.chatStream([{ role: 'user', content: 'hi' }], { onDelta: p => pieces.push(p) });
  assert.match(text, /^I remove duplicates in two passes \[1\]/);
  assert.equal(pieces.join(''), text);
  assert.ok(!text.includes('thinking'));
  assert.equal(srv.log.chat.at(-1).reasoning_effort, 'low');
  const before = srv.log.chat.length;
  const llm2 = new LLM(cfgFor({ llm: { baseUrl: srv.base + '/v1', apiKey: 'test-key', model: 'm', extra: { reject_me: true } } }));
  assert.ok((await llm2.chatStream([{ role: 'user', content: 'hi' }])).length > 0);
  assert.equal(srv.log.chat.length, before + 2);
});

test('question detection', () => {
  const yes = ['How do you handle duplicate customer records?', 'So tell me about a time you had to deal with a difficult stakeholder.',
    'Can you walk us through your ETL pipeline', 'I\'m curious how you evaluated the model.', 'What about latency', '你能介绍一下你的项目吗',
    'Okay great. And what was the F1 score on that?', 'Boleh terangkan bagaimana sistem ini berfungsi?'];
  const no = ['Okay.', 'Right?', 'Thanks, that makes sense.', 'Let me share my screen.', 'We deployed it last quarter and it went fine.', 'Can you hear me?', 'Hello'];
  for (const t of yes) assert.equal(detectQuestion(t).ask, true, t);
  for (const t of no) assert.equal(detectQuestion(t).ask, false, t);
});

test('config store encrypts secrets at rest and keeps free-form extra params', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  const crypto = { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
  const a = new ConfigStore(file, crypto); a.load();
  a.update({ llm: { apiKey: 'gsk_secret', extra: {} }, github: { apiBase: 'https://ghe.example/api/v3' } });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('gsk_secret'));
  const b = new ConfigStore(file, crypto).load();
  assert.equal(b.llm.apiKey, 'gsk_secret');
  assert.deepEqual(b.llm.extra, {});
  assert.equal(b.github.apiBase, 'https://ghe.example/api/v3');
  assert.equal(b.stt.model, 'whisper-large-v3');
});

test('OCR cleanup drops icon noise and keeps real lines', () => {
  const cleaned = cleanOcrText('© ® | ~\nQuarterly revenue by region\n=. |] ¢ »\nAPAC 12.4M   EMEA 9.1M\nx\nQuarterly revenue by region');
  assert.equal(cleaned, 'Quarterly revenue by region\nAPAC 12.4M EMEA 9.1M\nQuarterly revenue by region');
});

test('copilot: their question is transcribed, grounded in the repo and answered automatically', async () => {
  const getConfig = cfgFor({ api: { docUrls: [], searchUrl: srv.base + '/kb/search?q={query}', headerName: 'X-Api-Key', headerValue: 'secret' } });
  const kb = new KnowledgeBase(null);
  kb.setSource(await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh' }));
  const co = new Copilot({ getConfig, llm: new LLM(getConfig), kb, liveSearch, debounceMs: 20 });
  const events = [];
  co.on('transcript', e => events.push(['t', e.type, e.entry.who, e.entry.text]));
  co.on('answer', e => events.push(['a', e.type, e]));
  co.setScreenText('Slide 4: Data quality KPIs');
  const done = new Promise(r => co.on('answer', e => (e.type === 'done' || e.type === 'error') && r(e)));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64)]);
  await co.onSegment('them', wav, 3000);
  const end = await done;
  assert.equal(end.type, 'done');
  assert.match(end.text, /two passes/);
  assert.deepEqual(events.filter(e => e[0] === 't').map(e => e[1]), ['add', 'update']);
  const src = events.find(e => e[1] === 'sources')[2].sources;
  assert.equal(src[0].title, 'SLA policy', 'live API result comes first');
  assert.ok(src.some(s => /README\.md/.test(s.title) && /Jaro-Winkler/.test(s.snippet)));
  const prompt = srv.log.chat.at(-1).messages[1].content;
  assert.match(prompt, /About me:\nData engineer\./);
  assert.match(prompt, /Them: How do you handle duplicate customer records\?/);
  assert.match(prompt, /Slide 4: Data quality KPIs/);
  assert.match(prompt, /\[2\] README\.md/);
  assert.equal(srv.log.stt.at(-1).prompt, 'Glossary: CPM, Jaro-Winkler');

  // The same words picked up by the microphone are treated as echo and dropped.
  const removed = new Promise(r => co.on('transcript', e => e.type === 'remove' && r(e)));
  await co.onSegment('you', wav, 3000);
  await removed;
  assert.equal(co.entries.filter(e => e.who === 'you').length, 0);

  // Typed question and screen question.
  const typed = await co.answer({ mode: 'typed', question: 'What threshold do we use?' });
  assert.match(typed, /0\.92/);
  assert.match(srv.log.chat.at(-1).messages[1].content, /My question: What threshold do we use\?/);
  await co.answer({ mode: 'screen', question: 'Summarise this slide' });
  assert.match(srv.log.chat.at(-1).messages[1].content, /Base the reply on the shared-screen text/);
  assert.match(co.transcriptText(), /Them: How do you handle/);
});

test('copilot: statements do not trigger an answer; auto-answer can be turned off', async () => {
  const s2 = await mock.start({ sttLines: ['We shipped the release last week and it went fine.'] });
  const cfg = { profile: '', autoAnswer: 'questions', answerLength: 'short', llm: { baseUrl: s2.base + '/v1', apiKey: 'test-key', model: 'm', extra: {} }, stt: { model: 'w', vocabulary: '' }, embed: {}, api: { searchUrl: '' } };
  const co = new Copilot({ getConfig: () => cfg, llm: new LLM(() => cfg), kb: new KnowledgeBase(null), debounceMs: 10 });
  await co.onSegment('them', Buffer.from('RIFF'), 1000);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(s2.log.chat.length, 0);
  let err; co.on('answer', e => { if (e.type === 'error') err = e; });
  co.reset();
  await co.answer({ mode: 'manual' });
  assert.match(err.message, /Nothing from the other side/);
  await s2.close();
});

// ---- timing-sensitive behaviour, with a scripted model instead of the mock server ----
function scripted({ answer = 'Sure. Here is my answer.' } = {}) {
  const waiting = [];
  const chats = [];
  const llm = {
    transcribe: (_wav, { signal } = {}) => new Promise((resolve, reject) => {
      waiting.push(resolve);
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    }),
    chatStream: async (messages, { onDelta }) => { chats.push(messages[1].content); if (answer) onDelta(answer); return answer; },
    embedConfigured: () => false,
  };
  const cfg = { profile: '', autoAnswer: 'questions', answerLength: 'short', stt: { vocabulary: '' }, api: { searchUrl: '' } };
  const co = new Copilot({ getConfig: () => cfg, llm, kb: new KnowledgeBase(null), debounceMs: 15 });
  const answers = [];
  co.on('answer', e => { if (e.type === 'done' || e.type === 'error') answers.push(e); });
  co.on('notice', () => {});
  return { co, waiting, chats, answers, say: (i, text) => waiting[i](text) };
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const WAV = Buffer.from('RIFF');

test('echo from speakers is dropped even when the microphone copy is transcribed first', async () => {
  const { co, say, answers } = scripted();
  const them = co.onSegment('them', WAV, 3000);
  const you = co.onSegment('you', WAV, 3000);
  say(1, 'How do you handle duplicate customer records?'); await you;   // microphone copy returns first
  say(0, 'How do you handle duplicate customer records?'); await them;
  await tick();
  assert.deepEqual(co.entries.map(e => e.who), ['them']);
  assert.equal(answers.length, 1, 'the question is still answered');
});

test('a short acknowledgement from the user does not cancel the answer, a real reply does', async () => {
  let s = scripted();
  let a = s.co.onSegment('them', WAV, 2000); s.say(0, 'What was the F1 score on that model?'); 
  let b = s.co.onSegment('you', WAV, 400); s.say(1, 'Yeah.');
  await Promise.all([a, b]); await tick();
  assert.equal(s.answers.length, 1);

  s = scripted();
  a = s.co.onSegment('them', WAV, 2000);
  b = s.co.onSegment('you', WAV, 4000);
  s.say(1, 'It reached seventy three percent on the held out test set.'); await b;
  s.say(0, 'What was the F1 score on that model?'); await a; await tick();
  assert.equal(s.answers.length, 0, 'the user already replied');
});

test('no answer while they are still speaking; a question cut in two is answered whole', async () => {
  const { co, say, answers, chats } = scripted();
  co.setSpeaking('them', true);
  const a = co.onSegment('them', WAV, 9000);
  say(0, 'Can you walk me through how the nightly pipeline is scheduled'); await a;
  await tick();
  assert.equal(answers.length, 0, 'held while speech continues');
  co.setSpeaking('them', false);
  const b = co.onSegment('them', WAV, 3000);
  say(1, 'and what happens when a job fails halfway?'); await b;
  await tick();
  assert.equal(answers.length, 1);
  assert.match(chats[0], /They just said: "Can you walk me through how the nightly pipeline is scheduled and what happens when a job fails halfway\?"/);

  // They add to the question right after the answer started: the follow-up is answered with the original.
  const c = co.onSegment('them', WAV, 2000);
  say(2, 'Especially for the deduplication step.'); await c;
  await tick();
  assert.equal(answers.length, 2);
  assert.match(chats[1], /They just said: "Can you walk me through .* halfway\? Especially for the deduplication step\."/);
});

test('clearing the meeting ignores segments still in flight and keeps the screen text', async () => {
  const { co, say, answers } = scripted();
  co.setScreenText('Slide 2');
  const a = co.onSegment('them', WAV, 1000);
  co.reset();
  say(0, 'What is the budget?'); await a; await tick();
  assert.equal(co.pendingThem, 0);
  assert.equal(co.entries.length, 0);
  assert.equal(answers.length, 0);
  assert.equal(co.screenText, 'Slide 2');
  const b = co.onSegment('them', WAV, 1000); say(1, 'What is the budget for next quarter?'); await b; await tick();
  assert.equal(answers.length, 1, 'auto-answer still works after a reset');
});

test('a hung transcription times out instead of blocking answers; an empty completion is reported', async () => {
  const { co, say, answers } = scripted({ answer: '' });
  co.sttTimeoutMs = 30;
  const stuck = co.onSegment('them', WAV, 1000);
  await stuck;
  assert.equal(co.pendingThem, 0);
  assert.equal(co.entries.length, 0);
  const b = co.onSegment('them', WAV, 1000); say(1, 'How long does the full load take?'); await b; await tick();
  assert.equal(answers.at(-1).type, 'error');
  assert.match(answers.at(-1).message, /returned no text/);
});

test('code with long lines is chunked without dropping any line; credential files are never indexed', () => {
  const src = Array.from({ length: 300 }, (_, i) => `L${i} ` + 'x'.repeat(85)).join('\n');
  const seen = new Set();
  for (const c of chunkFile('data.sql', src)) { assert.ok(c.text.length <= 2400); for (const l of c.text.split('\n')) seen.add(l.split(' ')[0]); }
  assert.equal(seen.size, 300);
  for (const f of ['.env', '.npmrc', 'keys/id_rsa', 'config/secrets.yaml', 'deploy.pem', 'aws_credentials.json']) assert.equal(isIndexable(f, 10), false, f);
  for (const f of ['README', 'src/tokenizer.py', 'docs/secrets-management.md', '.github/workflows/ci.yml']) assert.equal(isIndexable(f, 10), true, f);
});

test('small talk is ignored wherever it appears in the utterance', () => {
  assert.equal(detectQuestion("Can you hear me? Great, let's get started.").ask, false);
  assert.equal(detectQuestion('Hi, can you see my screen? Okay perfect.').ask, false);
  assert.equal(detectQuestion('Can you hear me? Okay. So how do you handle duplicates?').ask, true);
});

test('a stalled answer stream is abandoned', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const cfg = { llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', model: 'm', extra: {} } };
  const llm = new LLM(() => cfg); llm.stallMs = 80;
  await assert.rejects(llm.chatStream([{ role: 'user', content: 'hi' }]), /stopped responding/);
  server.closeAllConnections(); server.close();
});

test('default shortcuts do not collide with Teams, Zoom, Meet or Webex; known clashes are named', () => {
  for (const accel of Object.values(shortcuts.DEFAULTS)) assert.equal(shortcuts.problem(accel), '', accel);
  assert.equal(new Set(Object.values(shortcuts.DEFAULTS)).size, 3);
  assert.match(shortcuts.problem('CommandOrControl+Shift+Space'), /Microsoft Teams/);   // Teams: go to sharing toolbar
  assert.match(shortcuts.problem('CommandOrControl+Shift+Enter'), /Microsoft Teams/);   // Teams: reset pane width
  assert.match(shortcuts.problem('Alt+A'), /Zoom/);                                      // Zoom: mute
  assert.match(shortcuts.problem('Control+Alt+H'), /Google Meet/);                       // Meet: raise hand
  assert.match(shortcuts.problem('Control+Shift+M'), /Teams.*Zoom.*Webex/);
  assert.match(shortcuts.problem('K'), /Add Ctrl or Alt/);
  assert.equal(shortcuts.problem('Control+Shift+F9'), '');
  assert.equal(shortcuts.pretty('CommandOrControl+Alt+,'), 'Ctrl+Alt+,');
  assert.equal(shortcuts.pretty('Control++'), 'Ctrl++');
  assert.equal(shortcuts.parse('Control+A+B'), null);
});

test('answering from the screen asks for runnable code and tells the model to see past OCR clutter', async () => {
  const { co, chats } = scripted({ answer: '```sql\nSELECT 1;\n```\nDone.' });
  co.setScreenText('File Edit View\nWrite a query to find customers with more than one order\nTables: customers(id, name)');
  await co.answer({ mode: 'screen' });
  assert.match(chats[0], /Text on the shared screen \(OCR\):\nFile Edit View\nWrite a query to find customers/);
  assert.match(chats[0], /What I need: Work out what the shared screen is asking of me/);
  assert.match(chats[0], /ignore menus, toolbars/);
  await co.answer({ mode: 'screen', question: 'Rewrite it with a window function' });
  assert.match(chats[1], /What I need: Rewrite it with a window function/);
});
