'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-server');
const { tokenize } = require('../src/rag/tokenize');
const { chunkFile, readNote, isIndexable } = require('../src/rag/chunker');
const { parseRepoSpec, fetchRepo, listRepos } = require('../src/rag/github');
const { ingestUrl, liveSearch, itemsFromJson } = require('../src/rag/api');
const { ingestFolder } = require('../src/rag/local');
const { KnowledgeBase } = require('../src/rag/kb');
const { LLM, cleanTranscript } = require('../src/llm');
const { detectQuestion } = require('../src/question');
const { ConfigStore } = require('../src/config');
const { SLOTS, NOTE, planPinned, moveLooseFilesIntoSections } = require('../src/slots');
const { Copilot } = require('../src/copilot');
const { cleanOcrText } = require('../src/ocr');
const { describe: describeDoc, sectionize } = require('../src/rag/extract');
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
  assert.deepEqual(parseRepoSpec('https://wenjun78.github.io/portfolio/'), { owner: 'wenjun78', repo: 'portfolio', ref: '', subdir: '' });
  assert.deepEqual(parseRepoSpec('https://wenjun78.github.io/FIFA/RefVision/docs/refvision.html'), { owner: 'wenjun78', repo: 'FIFA', ref: '', subdir: '' });
  assert.equal(parseRepoSpec('https://wenjun78.github.io/').repo, 'wenjun78.github.io');
  assert.equal(parseRepoSpec('https://wenjun78.github.io/index.html').repo, 'wenjun78.github.io');
  assert.equal(parseRepoSpec('wj').repo, '');
  assert.throws(() => parseRepoSpec('not a repo!'));
});

test('GitHub ingestion reads a tarball, flattens notebooks, skips binaries and vendored code', async () => {
  const r = await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh', token: 'ghp_x' });
  assert.equal(r.files, 7);
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

test('local folder ingestion reads text and PDF files and reports a version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nThe CPM system owns account hierarchies.');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.md'), 'ignore me');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'), path.join(dir, 'cv.pdf'));
  const r = await ingestFolder(dir);
  assert.equal(r.files, 2);
  assert.ok(r.chunks.some(c => c.path.endsWith('/cv.pdf') && /Jaro-Winkler fuzzy matching/.test(c.text)));
  assert.equal((await ingestFolder(dir)).version, r.version, 'unchanged folder keeps its version');
  fs.appendFileSync(path.join(dir, 'notes.md'), '\nMore.');
  assert.notEqual((await ingestFolder(dir)).version, r.version);
  assert.ok(r.chunks.some(c => /account hierarchies/.test(c.text)));
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
  assert.equal(b.stt.model, 'gpt-4o-transcribe');
  assert.equal(b.llm.baseUrl, 'https://api.openai.com/v1');
  assert.equal(b.llm.model, 'gpt-5.6-sol');
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
  assert.match(prompt, /Pinned notes from my sources[^\n]*\n### (About Alex|_jd\.md)/, 'pinned notes from the repo ride along');
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

test('PDF and Word files in a repo become searchable passages', async () => {
  const kb = new KnowledgeBase(null);
  kb.setSource(await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh' }));
  const pdf = kb.search('how many customer records does the nightly load handle, and how fast', 3).find(h => h.path.endsWith('sample-cv.pdf'));
  assert.ok(pdf, 'PDF passage found');
  assert.match(pdf.text, /12 million customer records in 40 minutes/);
  assert.match(pdf.url, /\/blob\/main\/cv\/sample-cv\.pdf$/);
  const docx = kb.search('XLM-RoBERTa ticket routing macro F1', 2)[0];
  assert.ok(docx.path.endsWith('sample-cv.docx'));
  assert.match(docx.text, /0\.87 macro F1/);
  assert.match(kb.search('AWS certification', 2)[0].text, /AWS Machine Learning Specialty/);
});

test('a PDF behind a URL is read as a document', async () => {
  const r = await ingestUrl(srv.base + '/kb/cv.pdf');
  assert.ok(r.chunks.length >= 1);
  assert.equal(r.chunks[0].title.split(' ')[0], 'cv.pdf');
  assert.match(r.chunks.map(c => c.text).join(' '), /MSc Applied Statistics/);
  assert.equal((await ingestUrl(srv.base + '/kb/cv.pdf')).version, r.version);
});

test('a repo that has not been pushed to is not downloaded again; a new push is picked up', async () => {
  const s2 = await mock.start({ pushedAt: '2026-10-01T00:00:00Z' });
  const opts = { apiBase: s2.base + '/gh' };
  const first = await fetchRepo(parseRepoSpec('wj/etl-pipeline'), opts);
  assert.equal(s2.log.tarballs, 1);
  const again = await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { ...opts, knownVersion: first.version });
  assert.deepEqual(again, { id: 'github:wj/etl-pipeline', unchanged: true });
  assert.equal(s2.log.tarballs, 1, 'no second download');
  s2.state.pushedAt = '2026-10-10T09:00:00Z';
  const updated = await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { ...opts, knownVersion: first.version });
  assert.ok(updated.chunks.length > 0);
  assert.notEqual(updated.version, first.version);
  assert.equal(s2.log.tarballs, 2);
  // Listing a user's repos carries the same information, so unchanged repos cost no extra request.
  const [listed] = await listRepos('wj', opts);
  assert.deepEqual(await fetchRepo(listed, { ...opts, knownVersion: updated.version }), { id: 'github:wj/etl-pipeline', unchanged: true });
  await s2.close();
});

test('re-syncing a source keeps the embeddings of passages that did not change', () => {
  const kb = new KnowledgeBase(null);
  const a = { path: 'r/a.md', url: '', title: 'a.md', text: 'alpha' }, b = { path: 'r/b.md', url: '', title: 'b.md', text: 'beta' };
  kb.setSource({ id: 's', label: 's', files: 2, version: 'v1', chunks: [a, b] });
  kb.chunks.forEach((c, i) => { c.vec = Float32Array.from([i, 1]); });
  kb.setSource({ id: 's', label: 's', files: 2, version: 'v2', chunks: [a, { ...b, text: 'beta changed' }] });
  assert.deepEqual([...kb.chunks[0].vec], [0, 1]);
  assert.equal(kb.chunks[1].vec, undefined);
  assert.equal(kb.sources.s.version, 'v2');
});

test('a pinned job description reaches the model with a guard against claiming its requirements', async () => {
  const { co, chats } = scripted();
  co.kb.setSource({ id: 'folder:x', label: 'My files', files: 2, chunks: [{ path: 'my-files/JD.md', url: '', title: 'JD.md', text: 'Senior ML Engineer.' }],
    pinned: [{ path: 'my-files/About me.md', url: '', title: 'About me.md', text: 'Data engineer, five years of SQL and Python.' },
      { path: 'my-files/JD.md', url: '', title: 'JD.md', text: 'Senior ML Engineer. Must have: Kubernetes, model serving, feature stores.' }] });
  const seen = [];
  const original = co.llm.chatStream;
  co.llm.chatStream = (messages, opts) => { seen.push(messages[0].content); return original(messages, opts); };
  await co.answer({ mode: 'typed', question: 'Tell me about your experience with model serving.' });
  assert.match(chats[0], /Pinned notes from my sources[^\n]*\n### About me\.md\nData engineer, five years of SQL and Python\./);
  assert.match(chats[0], /### JD\.md\nSenior ML Engineer\. Must have: Kubernetes/);
  assert.ok(!/^About me:/m.test(chats[0]), 'no separate profile section any more');
  assert.match(seen[0], /never present one of its requirements as the user's experience/);
});

test('text from the old Settings boxes is moved into notes once, and both are sent with every answer', () => {
  const { moveSettingsTextToNotes } = require('../src/migrate');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ profile: 'Data engineer in KL.', context: 'Role: Data Engineer. Must have SQL.', autoAnswer: 'off' }));
  const config = new ConfigStore(path.join(dir, 'config.json'));
  config.load();
  const notes = path.join(dir, 'my-files');
  assert.deepEqual(moveSettingsTextToNotes(config, notes).map(f => path.basename(f)), ['About me.md', 'Meeting brief.md']);
  assert.equal(fs.readFileSync(path.join(notes, 'About me.md'), 'utf8'), 'Data engineer in KL.\n');
  for (const f of ['About me.md', 'Meeting brief.md']) assert.ok(readNote(f, fs.readFileSync(path.join(notes, f), 'utf8')).pinned, f);
  const reloaded = new ConfigStore(path.join(dir, 'config.json')).load();
  assert.equal(reloaded.profile, ''); assert.equal(reloaded.context, ''); assert.equal(reloaded.autoAnswer, 'off');
  assert.deepEqual(moveSettingsTextToNotes(config, notes), [], 'nothing to move the second time');
  assert.deepEqual(fs.readdirSync(notes).sort(), ['About me.md', 'Meeting brief.md']);
});

test('front matter is stripped, and pinned notes are picked up by flag or by file name', () => {
  const about = readNote('knowledge/about.md', '---\ntitle: About Alex\npinned: true\n---\n# About\n\nAlex is based in Penang.');
  assert.deepEqual(about.pinned, { title: 'About Alex', text: '# About\n\nAlex is based in Penang.', chars: 33 });
  assert.ok(!about.chunks.some(c => /pinned: true|title: About/.test(c.text)), 'front matter is not indexed as content');
  assert.equal(readNote('notes/skills.md', '---\ntitle: Skills\n---\nPython.').pinned, null);
  for (const name of ['jd.md', '_jd.md', 'JD.txt', 'job-description.md', 'job_description.docx', 'jd.pdf', 'JD - Data Engineer.pdf', 'Lenovo_JD.docx',
    'job description (final).md', 'interview instructions.md', 'agenda.txt', 'client-brief.md', 'About me.md', 'about_me.txt', 'bio.md']) assert.ok(readNote('x/' + name, 'Senior engineer wanted.').pinned, name);
  for (const name of ['jdbc.md', 'cv.md', 'jd.py', 'briefcase.md', 'reinstructions.md', 'projects.md', 'biology.md', 'about meetings.md']) assert.equal(readNote('x/' + name, 'text = 1').pinned, null, name);
  assert.equal(readNote('a.md', 'No front matter here.\n---\nnot: meta').pinned, null);
});

test('pinned notes from a repo reach the model with every answer and are replaced on re-sync', async () => {
  const { co, chats } = scripted();
  const repo = await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh' });
  assert.deepEqual(repo.pinned.map(p => p.path).sort(), ['etl-pipeline/knowledge/_jd.md', 'etl-pipeline/knowledge/about.md']);
  co.kb.setSource(repo, { kind: 'github', spec: 'wj/etl-pipeline' });
  assert.deepEqual(co.kb.stats().sources[0].pinned.sort(), ['etl-pipeline/knowledge/_jd.md', 'etl-pipeline/knowledge/about.md']);
  assert.equal(co.kb.stats().sources[0].pinned[0].text, undefined, 'only names go to the window');
  await co.answer({ mode: 'typed', question: 'What is the weather like?' }); // nothing a search would match
  assert.match(chats[0], /Pinned notes from my sources/);
  assert.match(chats[0], /### _jd\.md\n# Senior ML Engineer, Example Corp/);
  assert.match(chats[0], /### About Alex\n# About\n\nAlex Tan is an engineer based in Penang/);
  co.kb.setSource({ ...repo, pinned: [] }, { kind: 'github', spec: 'wj/etl-pipeline' });
  await co.answer({ mode: 'typed', question: 'And tomorrow?' });
  assert.ok(!/Pinned notes/.test(chats[1]));
});

test('large exported HTML reports are read: embedded images are dropped, the text is kept', () => {
  assert.equal(isIndexable('Forecasting.html', 24_000_000), true);
  assert.equal(isIndexable('bundle.js', 24_000_000), false);
  const image = '<img src="data:image/png;base64,' + 'A'.repeat(2_000_000) + '">';
  const html = `<html><head><style>p{}</style><script>var x = "${'B'.repeat(50000)}"</script></head><body><h1>Forecasting numeric\r\n  data</h1>\r\n<p>The ridge model reached an RMSE of 4.2 on the held-out set.</p>${image}<h2>Method</h2><p>Ten-fold cross validation.</p></body></html>`;
  const chunks = chunkFile('Forecasting.html', html);
  const text = chunks.map(c => c.text).join('\n');
  assert.match(text, /ridge model reached an RMSE of 4\.2/);
  assert.ok(text.length < 400, 'no image or script payload in the text');
  assert.equal(chunks[0].title, 'Forecasting.html — Forecasting numeric data', 'a heading wrapped over two lines stays one heading');
  assert.match(text, /Method\nTen-fold cross validation/);
});

test('a reasoning model that refuses max_tokens, temperature and an unknown extra still answers, keeping the effort setting', async () => {
  const llm = new LLM(cfgFor({ llm: { baseUrl: srv.base + '/v1', apiKey: 'test-key', model: 'strict-reasoner', extra: { reasoning_effort: 'low', verbosity: 'low' } } }));
  const before = srv.log.chat.length;
  const text = await llm.chatStream([{ role: 'user', content: 'hi' }], { maxTokens: 700 });
  assert.match(text, /two passes/);
  assert.equal(srv.log.chat.length, before + 4, 'three refusals, then accepted');
  const sent = srv.log.chat.at(-1);
  assert.equal(sent.max_completion_tokens, 700);
  assert.ok(!('max_tokens' in sent) && !('temperature' in sent) && !('verbosity' in sent));
  assert.equal(sent.reasoning_effort, 'low', 'the accepted extra parameter is kept');
});

test('the prompt tells the model how to answer what the notes do not cover', async () => {
  const { co } = scripted();
  const seen = [];
  const original = co.llm.chatStream;
  co.llm.chatStream = (messages, opts) => { seen.push(messages[0].content); return original(messages, opts); };
  await co.answer({ mode: 'typed', question: 'Where do you see yourself in five years?' });
  const system = seen[0];
  assert.match(system, /where do you see yourself in five years/);
  assert.match(system, /Do not invent events, employers, numbers or credentials/);
  assert.match(system, /answer only from the notes and references\. If they do not cover it, do not invent it/);
  assert.match(system, /salary expectation, notice period[^\n]*never state one/);
  assert.match(system, /General knowledge[^\n]*answer directly/);
});

// ---- sections --------------------------------------------------------------------------
function sectionFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('about-me/' + NOTE, 'I am a data engineer in Kuala Lumpur.');
  put('cv/' + NOTE, '# CV\n\nBuilt ETL pipelines for 12 million records.');
  fs.mkdirSync(path.join(dir, 'cv'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'), path.join(dir, 'cv', 'Old resume.pdf'));
  put('jd/Senior role.md', 'Senior ML Engineer. Must have Kubernetes.');
  put('instructions/' + NOTE, 'Be professional when answering.');
  put('portfolio/project notes.md', '# Zanzibar migration\n\nMoved 40 jobs to Airflow.');
  return dir;
}

test('sections: everything outside Portfolio is sent with every answer, in section order, under the section name', async () => {
  const dir = sectionFolder();
  const r = await ingestFolder(dir, { sections: true });
  assert.equal(r.files, 6);
  assert.deepEqual(r.pinned.map(p => [p.slot, p.title, p.path]).sort(), [
    ['about', 'About me', 'About me/typed text'],
    ['cv', 'CV', 'CV/typed text'],
    ['cv', 'CV: Old resume.pdf', 'CV/Old resume.pdf'],
    ['instructions', 'Instructions for this meeting', 'Instructions/typed text'],
    ['jd', 'Job description: Senior role.md', 'JD/Senior role.md'],
  ]);
  assert.ok(!r.pinned.some(p => p.slot === 'portfolio'), 'Portfolio is searched, not sent every time');
  assert.ok(r.chunks.some(c => c.path === 'Portfolio/project notes.md' && /Airflow/.test(c.text)));
  assert.ok(r.chunks.some(c => c.path === 'About me/typed text' && c.title === 'About me'), 'typed text is named after its section, not _note.md');

  const { co, chats } = scripted();
  co.kb.setSource(r, { kind: 'folder', spec: dir });
  await co.answer({ mode: 'typed', question: 'Tell me about yourself.' });
  const order = ['### About me\n', '### CV\n', '### CV: Old resume.pdf\n', '### Job description: Senior role.md\n', '### Instructions for this meeting\nBe professional when answering.'].map(h => chats[0].indexOf(h));
  assert.ok(order.every(i => i >= 0), 'every section is in the prompt');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in section order');
  assert.ok(!/### Portfolio/.test(chats[0]));
  // the same folder read without sections falls back to the file-name rule
  assert.equal((await ingestFolder(dir)).pinned.some(p => p.path.endsWith('about-me/_note.md')), false);
});

test('the send budget cuts long notes and reports what goes out; lean mode sends less', async () => {
  const notes = [
    { slot: 'instructions', title: 'Instructions', text: 'i'.repeat(500) },
    { slot: 'cv', title: 'CV', text: 'c'.repeat(8000), chars: 30000 },
    { title: 'repo note', text: 'r'.repeat(8000) },
    { slot: 'about', title: 'About me', text: 'a'.repeat(1000) },
    { slot: 'jd', title: 'JD', text: 'j'.repeat(7000) },
  ];
  const full = planPinned(notes);
  assert.deepEqual(full.map(n => [n.title, n.sent]), [['About me', 1000], ['CV', 8000], ['JD', 7000], ['Instructions', 500], ['repo note', 3500]]);
  assert.equal(full.reduce((n, x) => n + x.sent, 0), 20000);
  const lean = planPinned(notes, { total: 6000, perNote: 2500 });
  assert.deepEqual(lean.map(n => n.sent), [1000, 2500, 2500, 0, 0]);

  const { co, chats } = scripted();
  co.kb.setSource({ id: 's', label: 's', files: 1, chunks: [], pinned: notes });
  co.getConfig().answerContext = 'lean';
  await co.answer({ mode: 'typed', question: 'Hi there, a question.' });
  assert.ok(chats[0].includes('c'.repeat(2500)) && !chats[0].includes('c'.repeat(2501)));
  assert.ok(!chats[0].includes('### Instructions'), 'notes past the lean budget are left out');
});

test('a request the service calls too large is retried with less, and the answer still arrives', async () => {
  const { co, answers } = scripted();
  const sizes = [];
  co.llm.chatStream = async (messages, { onDelta }) => {
    sizes.push(messages[1].content.length);
    if (sizes.length === 1) throw new Error('Answer failed (413). Request too large for model: tokens per minute (TPM) limit 8000, requested 9120.');
    onDelta('Fine.'); return 'Fine.';
  };
  co.kb.setSource({ id: 's', label: 's', files: 1, chunks: [], pinned: [{ slot: 'cv', title: 'CV', text: 'c'.repeat(8000) }] });
  const notices = [];
  co.on('notice', n => notices.push(n.message));
  const text = await co.answer({ mode: 'typed', question: 'Summarise my background please.' });
  assert.equal(text, 'Fine.');
  assert.ok(sizes[1] < sizes[0] - 5000, 'the second request is much smaller');
  assert.match(notices[0], /less of your notes was sent/);
  assert.equal(answers.at(-1).type, 'done');
});

test('loose notes from earlier versions are moved into their sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loose-'));
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  put('About me.md', 'Engineer.'); put('JD.md', 'Role text.'); put('Instructions.md', 'Be brief.'); put('CV.md', 'My CV.');
  put('JD - Platform Engineer.pdf', 'x'); put('Meeting brief.md', 'Old box.'); put('my resume 2026.docx', 'x');
  put('Interview instructions round 2.md', 'More.'); put('Talking points.md', '---\npinned: true\n---\nMention X.'); put('project notes.md', 'Long.');
  fs.mkdirSync(path.join(dir, 'cv'));
  const moved = moveLooseFilesIntoSections(dir);
  assert.equal(moved.length, 10);
  const ls = (d) => fs.readdirSync(path.join(dir, d)).sort();
  assert.deepEqual(ls('about-me'), [NOTE]);
  assert.deepEqual(ls('cv'), [NOTE, 'my resume 2026.docx']);
  assert.deepEqual(ls('jd'), ['JD - Platform Engineer.pdf', 'Meeting brief.md', NOTE]);
  assert.deepEqual(ls('instructions'), ['Interview instructions round 2.md', 'Talking points.md', NOTE]);
  assert.deepEqual(ls('portfolio'), ['project notes.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'about-me', NOTE), 'utf8'), 'Engineer.');
  assert.deepEqual(moveLooseFilesIntoSections(dir), [], 'nothing left to move');
  assert.equal(SLOTS.filter(s => !s.searched).length, 4);
});

test('the inventory lists every searchable file with its passages, and returns a file as it was read', async () => {
  const kb = new KnowledgeBase(null);
  const dir = sectionFolder();
  kb.setSource({ ...(await ingestFolder(dir, { sections: true })), label: 'Your notes and files' }, { kind: 'folder', spec: dir });
  kb.setSource(await fetchRepo(parseRepoSpec('wj/etl-pipeline'), { apiBase: srv.base + '/gh' }));
  const inv = kb.inventory();
  assert.deepEqual(inv.map(s => s.label), ['Your notes and files', 'wj/etl-pipeline']);
  assert.deepEqual(inv[0].files.map(f => f.path), ['About me/typed text', 'CV/Old resume.pdf', 'CV/typed text', 'Instructions/typed text', 'JD/Senior role.md', 'Portfolio/project notes.md']);
  assert.ok(inv[1].files.find(f => f.path === 'etl-pipeline/README.md').passages >= 1);
  assert.equal(inv.reduce((n, s) => n + s.files.reduce((m, f) => m + f.passages, 0), 0), kb.chunks.length);
  assert.match(kb.fileText(inv[0].id, 'Portfolio/project notes.md'), /Moved 40 jobs to Airflow/);
  assert.ok(kb.pinned().every(p => p.sourceId), 'pinned notes know their source, so their text can be shown');
});

test('answers remember the meeting: earlier questions and suggestions, and a long conversation', async () => {
  const { co, chats } = scripted({ answer: 'I cut load time from six hours to forty minutes [1].' });
  await co.answer({ mode: 'typed', question: 'What was your biggest win on the ETL pipeline?' });
  assert.ok(!/Earlier in this meeting/.test(chats[0]), 'nothing to remember on the first question');
  await co.answer({ mode: 'typed', question: 'Make it shorter.' });
  assert.match(chats[1], /Earlier in this meeting you suggested these answers[^\n]*\nAsked: What was your biggest win on the ETL pipeline\?\nSuggested: I cut load time from six hours to forty minutes/);
  assert.match(chats[1], /My question: Make it shorter\./);

  // Forty utterances are all still there when the next question comes; clearing the meeting forgets everything.
  for (let i = 0; i < 40; i++) co.entries.push({ id: 100 + i, who: i % 2 ? 'you' : 'them', text: `Point number ${i} about the migration.`, t: Date.now(), dur: 1000, pending: false });
  await co.answer({ mode: 'typed', question: 'What did they say first?' });
  assert.match(chats[2], /Them: Point number 0 about the migration\./);
  assert.match(chats[2], /Me: Point number 39 about the migration\./);
  co.getConfig().answerContext = 'lean';
  await co.answer({ mode: 'typed', question: 'And in lean mode?' });
  assert.ok(!/Point number 0 about/.test(chats[3]) && /Point number 39 about/.test(chats[3]), 'lean keeps only the most recent part');
  assert.equal((chats[3].match(/^Asked: /gm) || []).length, 1, 'lean carries one earlier suggestion');
  co.reset();
  co.getConfig().answerContext = 'full';
  await co.answer({ mode: 'typed', question: 'Fresh start?' });
  assert.ok(!/Earlier in this meeting|Point number/.test(chats[4]));
});

test('a whole interview of earlier questions stays in view, the latest in most detail', async () => {
  const { co, chats } = scripted({ answer: 'Answer text. ' + 'detail '.repeat(150) });
  for (let i = 1; i <= 25; i++) await co.answer({ mode: 'typed', question: `Question number ${i} about my background?` });
  await co.answer({ mode: 'typed', question: 'What have we covered so far?' });
  const prompt = chats.at(-1);
  const asked = prompt.match(/^Asked: Question number \d+/gm) || [];
  assert.equal(asked.length, 25, 'all twenty-five earlier questions are included');
  assert.ok(prompt.indexOf('Question number 1 about') < prompt.indexOf('Question number 25 about'), 'oldest first');
  const cut = (n) => new RegExp(`Asked: Question number ${n} about my background\\?\\nSuggested: ([^\\n]*)`).exec(prompt)[1].length;
  assert.ok(cut(25) > 600 && cut(3) <= 250, 'recent answers are kept longer than old ones');
});

test('a paper saved under a meaningless file name is read, named by its title and found as "my publication"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  fs.mkdirSync(path.join(dir, 'portfolio'));
  const file = '3c1d9a7e-55aa-4f0b-9d2e-0a1b2c3d4e5f.pdf';
  fs.copyFileSync(path.join(__dirname, 'fixtures', file), path.join(dir, 'portfolio', file));
  fs.writeFileSync(path.join(dir, 'portfolio', 'scan.pdf'), '%PDF-1.4 not really a pdf');
  const mine = await ingestFolder(dir, { sections: true });
  assert.equal(mine.files, 1, 'the unreadable PDF gives no passages');
  assert.ok(mine.chunks.length >= 3);
  assert.ok(mine.chunks.every(c => c.title.startsWith('Publication (research paper): Predicting shipment delays with gradient boosting: an explainable approach (3c1d9a7e')), mine.chunks[0].title);

  // Beside a large repository, a question about "my publication" still lands on the paper.
  const kb = new KnowledgeBase(null);
  kb.setSource({ ...mine, label: 'Your notes and files' }, { kind: 'folder', spec: dir });
  kb.setSource({ id: 'github:x/big', label: 'x/big', files: 200, chunks: Array.from({ length: 400 }, (_, i) => ({ path: `big/report${i}.html`, url: '', title: `report${i}.html`, text: `Assignment ${i}: regression models, forecasting, research data and the model score${i % 20 ? '' : ' for publication quality charts'}.` })) });
  kb.boost = { [mine.id]: 1.5 };
  const hits = kb.search('Tell me about your publication', 4);
  assert.match(hits[0].title, /^Publication \(research paper\): Predicting shipment delays/);
  assert.match(kb.search('What F1 score did your paper reach and how did you interpret the model?', 3)[0].text, /F1 score of 0\.81|SHAP/);
  // "Methodology" brings back the parts of the Methods section with their specifics, and the
  // reference list (other people's work) is not kept.
  for (const q of ['i mean publication methodology', 'walk me through the approach of your paper']) {
    const got = kb.search(q, 8).filter(h => h.sourceId === mine.id);
    assert.ok(got.some(h => / — Methods > Model$/.test(h.title) && /XGBoost[\s\S]*SMOTE/.test(h.text)), q);
    assert.ok(got.some(h => / — Methods > Data$/.test(h.title) && /48,210/.test(h.text)), q);
  }
  assert.match(kb.search('what are the limitations of your paper', 3)[0].title, / — Limitations$/);
  assert.ok(!mine.chunks.some(c => /Lundberg|Guestrin/.test(c.text)), 'references left out');
  assert.deepEqual(kb.fileFacts(mine.id, `Portfolio/${file}`), { passages: mine.chunks.length, title: mine.chunks[0].title });
  assert.equal(kb.fileFacts(mine.id, 'Portfolio/scan.pdf').passages, 0);

  // Section headings of numbered papers, and of a CV, on their own.
  const numbered = sectionize('A study\nAbstract\nShort.\n1 Introduction\nWhy.\n2 Methodology\n2.1 Feature engineering\nLagged delays.\n2.2 Model training\nLightGBM.\n3 Results\nGood.\nReferences\n[1] Other.', true);
  assert.match(numbered, /^## 2 Methodology\n\n### 2\.1 Feature engineering\n\nLagged delays\.\n\n### 2\.2 Model training/m);
  assert.ok(!/Other/.test(numbered));
  assert.match(sectionize('Alex Tan\nWork experience\n1. Built pipelines at Acme\nEducation\nBSc', false), /## Work experience\n\n1\. Built pipelines at Acme\n\n## Education/);

  // Naming rules on their own.
  const paper = 'Journal of Things\nORIGINAL PAPER\nDeep learning for\nwidget inspection\nA. Author · B. Writer\nAbstract\nWe study widgets. https://doi.org/10.1/x\n' + 'text '.repeat(50) + '\nReferences\n[1] Someone.';
  assert.equal(describeDoc('download (3).pdf', paper, ''), 'Publication (research paper): Deep learning for widget inspection (download (3).pdf)');
  assert.equal(describeDoc('cv.pdf', 'Alex Tan\nData Engineer\nExperience ...', '(anonymous)'), 'cv.pdf');
  assert.equal(describeDoc('slides.pdf', 'Quarterly review\nAgenda', 'Quarterly business review'), 'Quarterly business review (slides.pdf)');
});
