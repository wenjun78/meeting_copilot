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
const { LLM, cleanTranscript, speechLanguage, languageToForce } = require('../src/llm');
const { detectQuestion } = require('../src/question');
const { ConfigStore } = require('../src/config');
const { SLOTS, NOTE, planPinned, moveLooseFilesIntoSections } = require('../src/slots');
const { Copilot } = require('../src/copilot');
const { cleanOcrText } = require('../src/ocr');
const { describe: describeDoc, sectionize, abstractOf, extractDoc } = require('../src/rag/extract');
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
  assert.ok(sent.hasWav); assert.equal(sent.prompt, 'This meeting is in English and Mandarin Chinese. 这场会议使用英语和普通话。 Glossary: CPM'); assert.equal(sent.model, 'whisper-large-v3');
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
  assert.equal(b.llm.model, 'gpt-6.1-sol');

  // Settings saved while gpt-5.6-sol was the default move to the new default once; picking
  // gpt-5.6-sol again afterwards sticks, and any other saved model is never touched.
  const old = path.join(path.dirname(file), 'old.json');
  fs.writeFileSync(old, JSON.stringify({ llm: { model: 'gpt-5.6-sol', apiKey: 'enc:' + crypto.encrypt('sk-kept') } }));
  const c = new ConfigStore(old, crypto); c.load();
  assert.equal(c.get().llm.model, 'gpt-6.1-sol');
  assert.equal(c.get().llm.apiKey, 'sk-kept');
  c.update({ llm: { model: 'gpt-5.6-sol' } });
  assert.equal(new ConfigStore(old, crypto).load().llm.model, 'gpt-5.6-sol');
  fs.writeFileSync(old, JSON.stringify({ llm: { model: 'openai/gpt-oss-120b', baseUrl: 'https://api.groq.com/openai/v1' } }));
  assert.equal(new ConfigStore(old, crypto).load().llm.model, 'openai/gpt-oss-120b');
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
  assert.equal(srv.log.stt.at(-1).prompt, 'This meeting is in English and Mandarin Chinese. 这场会议使用英语和普通话。 Glossary: CPM, Jaro-Winkler');
  assert.equal(srv.log.stt.at(-1).language, '', 'with both languages allowed the service chooses per sentence');

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
  // The saved log has what was said and each answer suggested, in the order they happened.
  const saved = co.transcriptText();
  assert.match(saved, /\] Them: How do you handle[^\n]*\n\[[^\]]*\] Suggested answer \(first words \d+\.\d s after they stopped\):\n {4}\S/);
  assert.match(saved, /Suggested answer \(you asked: What threshold do we use\?\):\n {4}[\s\S]*?0\.92/);
  assert.match(saved, /Suggested answer \(from the screen\):/);
  // Without the answers it is the transcript alone.
  assert.ok(!/Suggested answer/.test(co.transcriptText({ answers: false })) && /Them: How do you handle/.test(co.transcriptText({ answers: false })));
  co.reset();
  assert.equal(co.transcriptText(), '');
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
  assert.equal(SLOTS.filter(s => !s.searched && !s.papers && !s.qa).length, 5);
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

test('Publications: a paper is searched by section, its abstract goes with every answer, and papers in Portfolio move over once', async () => {
  const { movePapersToPublications, planPinned, SLOTS } = require('../src/slots');
  assert.deepEqual(SLOTS.map(s => s.id), ['about', 'cv', 'jd', 'instructions', 'qa', 'ask', 'publications', 'portfolio']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubs-'));
  const file = '3c1d9a7e-55aa-4f0b-9d2e-0a1b2c3d4e5f.pdf';
  fs.mkdirSync(path.join(dir, 'portfolio'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', file), path.join(dir, 'portfolio', file));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample-cv.pdf'), path.join(dir, 'portfolio', 'sample-cv.pdf'));
  const isPaper = async (f) => /^Publication \(research paper\)/.test((await extractDoc(path.basename(f), fs.readFileSync(f))).name);

  // The paper moves, the CV stays; a second run moves nothing, even if a paper is put in Portfolio again.
  assert.deepEqual(await movePapersToPublications(dir, isPaper), [file]);
  assert.ok(fs.existsSync(path.join(dir, 'publications', file)) && fs.existsSync(path.join(dir, 'portfolio', 'sample-cv.pdf')));
  fs.copyFileSync(path.join(dir, 'publications', file), path.join(dir, 'portfolio', 'again.pdf'));
  assert.deepEqual(await movePapersToPublications(dir, isPaper), []);
  fs.rmSync(path.join(dir, 'portfolio', 'again.pdf'));

  // A plain write-up in Publications counts as a paper too; typed text is sent with every answer.
  fs.writeFileSync(path.join(dir, 'publications', 'thesis.md'), '# Churn thesis\n\n## Abstract\n\nWe model churn for a telecom with survival analysis over 12,000 accounts and find contract length matters most.\n\n## Methods\n\nCox regression with time-varying covariates.\n');
  fs.writeFileSync(path.join(dir, 'publications', '_note.md'), 'I led the modelling for the shipment paper.\n');
  const mine = await ingestFolder(dir, { sections: true });
  const paper = mine.chunks.filter(c => c.path === `Publications/${file}`);
  assert.ok(paper.length >= 5 && paper.every(c => c.title.startsWith('Publication (research paper): Predicting shipment delays')));
  assert.ok(mine.chunks.some(c => c.path === 'Publications/thesis.md' && c.title.startsWith('Publication (research paper): thesis.md — Churn thesis') && /Cox regression/.test(c.text)));

  const pins = mine.pinned.filter(p => p.slot === 'publications');
  assert.deepEqual(pins.map(p => p.title).sort(), ['About my publications', 'Publication: Predicting shipment delays with gradient boosting: an explainable approach (' + file + ')', 'Publication: thesis.md']);
  const brief = pins.find(p => p.path === `Publications/${file}`);
  assert.match(brief.text, /^We predict shipment delays/);
  assert.ok(brief.text.length <= 1500 && !/XGBoost reached an F1/.test(brief.text), 'only the abstract, not the whole paper');
  assert.match(pins.find(p => p.path === 'Publications/thesis.md').text, /^We model churn .* matters most\.$/);
  // Publications come after Instructions and before other pinned files in what is sent.
  const sent = planPinned([{ title: 'x', text: 'x', slot: '' }, ...pins, { title: 'Instructions', text: 'i', slot: 'instructions' }]);
  assert.deepEqual(sent.map(n => n.slot), ['instructions', 'publications', 'publications', 'publications', '']);

  assert.equal(abstractOf('Title line\n\n## Introduction\n\n' + 'Long sentence here. '.repeat(200)).length <= 1500, true);
  assert.equal(abstractOf(''), '');
});

test('Q&A: prepared answers are read from pasted text, kept one per question, and offered when a similar question is asked', async () => {
  const { parseQA, rankPrepared, normalizePairs, QA_FILE } = require('../src/qa');

  // Three ways of writing them down.
  assert.deepEqual(parseQA('Q: Why do you want to leave\nyour current role?\nA: I want to build ML systems end to end.\nMy current team only maintains them.\n\n**Q2.** What is your biggest weakness?\nAnswer: I over-prepare.'), [
    { q: 'Why do you want to leave your current role?', a: 'I want to build ML systems end to end.\nMy current team only maintains them.' },
    { q: 'What is your biggest weakness?', a: 'I over-prepare.' }]);
  assert.deepEqual(parseQA('## Tell me about yourself\n\nI am an AI engineer.\n\n## Why us?\nThe platform team.'), [{ q: 'Tell me about yourself', a: 'I am an AI engineer.' }, { q: 'Why us?', a: 'The platform team.' }]);
  assert.deepEqual(parseQA('1. Tell me about yourself?\nI am an AI engineer.\n\nFour years in data.\n\nWhy this role?\nIt fits. Does it not?\n'), [{ q: 'Tell me about yourself?', a: 'I am an AI engineer.\n\nFour years in data.' }, { q: 'Why this role?', a: 'It fits. Does it not?' }]);
  assert.deepEqual(parseQA('Just some notes with no questions.'), []);
  // A spreadsheet saved as CSV: named columns in any order, quoted cells with commas and line breaks.
  const { parseQATable } = require('../src/qa');
  assert.deepEqual(parseQATable('Topic,Answer,Question\nHR,"I want scope, not just title.\nAnd a team that ships.","Why leave?"\nHR,"Three months, negotiable",Notice period?\n'), [
    { q: 'Why leave?', a: 'I want scope, not just title.\nAnd a team that ships.' }, { q: 'Notice period?', a: 'Three months, negotiable' }]);
  assert.deepEqual(parseQATable('Why us?\tThe "platform" team\nEmpty one\t\n'), [{ q: 'Why us?', a: 'The "platform" team' }]);
  // The same question again replaces the earlier answer; empty halves are dropped.
  assert.deepEqual(normalizePairs([{ q: 'Why us?', a: 'One' }, { q: 'x', a: '' }, { q: '  why us ', a: 'Two' }]), [{ q: 'why us', a: 'Two' }]);

  // Differently worded questions still point at the right prepared answer.
  const pairs = [
    { q: 'Why do you want to leave your current role?', a: 'I want to own models end to end; my current work is support for the CPM system.' },
    { q: 'What is your biggest weakness?', a: 'I over-prepare, so I now time-box research to a day.' },
    { q: 'What are your salary expectations?', a: 'I am looking at the market range for a senior AI engineer and am flexible for the right scope.' },
  ];
  const top = (asked) => rankPrepared(pairs, asked)[0];
  assert.match(top('So, um, why are you leaving your current job?').q, /leave/);
  assert.ok(top('So, um, why are you leaving your current job?').match);
  assert.match(top('What would you say are your weaknesses?').q, /weakness/);
  assert.match(top('And what salary are you expecting?').q, /salary/);
  assert.ok(!top('How do you handle duplicate customer records?').match, 'an unrelated question matches nothing');

  // In the app's files the list is one passage per pair, found by search and listed as prepared.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  fs.mkdirSync(path.join(dir, 'qa'));
  fs.writeFileSync(path.join(dir, 'qa', QA_FILE), JSON.stringify(pairs));
  fs.mkdirSync(path.join(dir, 'cv'));
  fs.writeFileSync(path.join(dir, 'cv', '_note.md'), 'Engineer, AI Systems. Built ETL pipelines and a chatbot.');
  const mine = await ingestFolder(dir, { sections: true });
  assert.equal(mine.chunks.filter(c => c.path === 'Prepared answers/your list').length, 3);
  assert.ok(!mine.pinned.some(p => p.slot === 'qa'), 'prepared answers are not pinned notes');
  const kb = new KnowledgeBase(null);
  kb.setSource(mine);
  assert.deepEqual(kb.prepared(), pairs);
  assert.equal(kb.search('salary expectations', 3)[0].title, 'Prepared answer: What are your salary expectations?');

  // Asked in a meeting: the prepared answers go to the model in their own block, the closest
  // first, named among the sources, and not repeated as numbered references.
  const s2 = await mock.start({ sttLines: ['So why are you leaving your current job?'], answer: 'I want to own models end to end.' });
  const getConfig = cfgFor({ llm: { baseUrl: s2.base + '/v1', apiKey: 'test-key', model: 'chat-model', extra: {} } });
  const co = new Copilot({ getConfig, llm: new LLM(getConfig), kb, debounceMs: 20 });
  let sources = null;
  co.on('answer', e => { if (e.type === 'sources') sources = e.sources; });
  await co.answer({ mode: 'typed', question: 'Why are you leaving your current job?' });
  const prompt = s2.log.chat.at(-1).messages[1].content;
  const block = /Answers I prepared for questions I expect[^\n]*\n([\s\S]*?)\n\nReference material/.exec(prompt);
  assert.ok(block, prompt);
  assert.match(block[1], /^Q: Why do you want to leave your current role\?\nA: I want to own models end to end/);
  assert.match(block[1], /Q: What is your biggest weakness\?[\s\S]*Q: What are your salary expectations\?/, 'the others are still offered, for questions worded differently');
  assert.ok(!/\[\d+\] Prepared answer/.test(prompt), 'not repeated as a numbered reference');
  assert.match(s2.log.chat.at(-1).messages[0].content, /"Answers I prepared" are replies the user wrote in advance/);
  assert.deepEqual(sources.filter(x => x.n === 'Q').map(x => x.title), ['Prepared: Why do you want to leave your current role?']);
  assert.ok(sources.filter(x => x.n !== 'Q').every((x, i) => x.n === i + 1));

  // Lean mode sends only the closest two; with nothing prepared there is no block at all.
  const lean = co._buildMessages({ asked: 'x', mode: 'typed', refs: [], prepared: rankPrepared(pairs, 'salary'), cfg: getConfig(), lean: true })[1].content;
  assert.equal((lean.match(/^Q: /gm) || []).length, 2);
  assert.match(lean, /prepared[^\n]*\nQ: What are your salary expectations\?/);
  assert.ok(!/Answers I prepared/.test(co._buildMessages({ asked: 'x', mode: 'typed', refs: [], cfg: getConfig() })[1].content));
  await s2.close();
});

test('speech is written down as English or Mandarin only; anything else is transcribed again in one of the two', async () => {
  assert.deepEqual(['', 'ms', 'auto', 'en', 'zh', 'en+zh', undefined].map(speechLanguage), ['en+zh', 'en+zh', 'en+zh', 'en', 'zh', 'en+zh', 'en+zh']);

  // What counts as "neither", and which language the audio is tried in again.
  assert.equal(languageToForce('So how do you handle duplicate customer records?', 'english'), '');
  assert.equal(languageToForce('你平时怎么处理重复的客户记录？', 'chinese'), '');
  assert.equal(languageToForce('我们用 Databricks 和 Spark 做 ETL', ''), '', 'Mandarin with English terms is fine');
  assert.equal(languageToForce('Tell me about the pipeline you built at Lenovo', ''), '');
  assert.equal(languageToForce('Databricks, Spark', ''), '', 'too short to judge: kept');
  assert.equal(languageToForce('Saya rasa kita boleh mulakan mesyuarat sekarang', ''), 'en', 'Latin script that does not read as English');
  assert.equal(languageToForce('Boleh you explain the pipeline', 'malay'), 'en', 'the service named another language');
  assert.equal(languageToForce('重複した顧客レコードはどう処理しますか', 'japanese'), 'zh');
  assert.equal(languageToForce('중복 고객 기록은 어떻게 처리합니까', ''), 'zh');
  assert.equal(languageToForce('Как вы обрабатываете дубликаты', ''), 'en');
  assert.equal(languageToForce('重复的客户记录', 'cantonese'), 'zh');

  const make = async (lines, stt = {}) => {
    const s = await mock.start({ sttLines: lines });
    const getConfig = () => ({ llm: { baseUrl: s.base + '/v1', apiKey: 'test-key', model: 'chat-model' }, stt: { baseUrl: '', apiKey: '', model: 'whisper-large-v3', language: 'en+zh', vocabulary: '', ...stt } });
    const llm = new LLM(getConfig); llm.retryDelayMs = 1;
    return { s, llm };
  };
  const wav = Buffer.from('RIFF....WAVEfmt ');

  // English heard as Malay: sent again as English, and that version is used.
  let { s, llm } = await make([(req) => (req.language === 'en' ? { text: 'I think we can start the meeting now.', language: 'english' } : { text: 'Saya rasa kita boleh mulakan mesyuarat sekarang.', language: 'malay' })]);
  assert.equal(await llm.transcribe(wav), 'I think we can start the meeting now.');
  assert.deepEqual(s.log.stt.map(r => r.language), ['', 'en']);
  assert.equal(s.log.stt[1].prompt, 'This meeting is in English.');
  // English and Mandarin sentences pass straight through, one request each.
  await s.close();
  ({ s, llm } = await make([{ text: 'How do you handle duplicates?', language: 'english' }, { text: '你怎么处理重复的记录？', language: 'chinese' }]));
  assert.equal(await llm.transcribe(wav), 'How do you handle duplicates?');
  assert.equal(await llm.transcribe(wav), '你怎么处理重复的记录？');
  assert.equal(s.log.stt.length, 2);
  await s.close();
  // Mandarin heard as Japanese: sent again as Mandarin.
  ({ s, llm } = await make([(req) => (req.language === 'zh' ? { text: '重复的客户记录怎么处理？', language: 'chinese' } : { text: '重複した顧客レコードはどう処理しますか', language: 'japanese' })]));
  assert.equal(await llm.transcribe(wav), '重复的客户记录怎么处理？');
  assert.match(s.log.stt[1].prompt, /^这场会议使用普通话/);
  await s.close();

  // One language chosen: every request names it, and nothing is sent twice.
  ({ s, llm } = await make(['Ini bukan bahasa Inggeris sama sekali ya'], { language: 'en' }));
  await llm.transcribe(wav, { prompt: 'Glossary: CPM' });
  assert.deepEqual(s.log.stt.map(r => [r.language, r.prompt]), [['en', 'This meeting is in English. Glossary: CPM']]);
  await s.close();

  // A model without the detailed reply format: found out once, then asked the plain way;
  // with no language reported, the words themselves decide.
  const heardAsMalay = (req) => (req.language === 'en' ? 'So what is your notice period?' : 'Jadi berapa lama tempoh notis anda sekarang?');
  ({ s, llm } = await make([heardAsMalay, heardAsMalay, 'And when could you start with us?'], { model: 'plain-json-stt' }));
  assert.equal(await llm.transcribe(wav), 'So what is your notice period?');
  assert.equal(await llm.transcribe(wav), 'And when could you start with us?');
  assert.deepEqual(s.log.stt.map(r => `${r.format}:${r.language}`), ['verbose_json:', 'json:', 'json:en', 'json:']);
  await s.close();

  // The hint coming back as the "speech" is silence, not a sentence.
  ({ s, llm } = await make(['This meeting is in English.'], { language: 'en' }));
  assert.equal(await llm.transcribe(wav), '');
  await s.close();

  // Saved settings: anything other than the two languages becomes "both".
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lang-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ stt: { language: 'ms' } }));
  assert.equal(new ConfigStore(file).load().stt.language, 'en+zh');
  fs.writeFileSync(file, JSON.stringify({ stt: { language: 'zh' } }));
  assert.equal(new ConfigStore(file).load().stt.language, 'zh');
  assert.equal(new ConfigStore(path.join(path.dirname(file), 'none.json')).load().stt.language, 'en+zh');
});

test('Q&A files: a numbered list of 14 questions is read whole from PDF and Word, with wrapped questions, steps inside answers and section titles handled', async () => {
  const { parseQA } = require('../src/qa');
  const want = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qa-list.json'), 'utf8')).map(([q, a]) => ({ q, a }));
  const flat = (pairs) => pairs.map(p => ({ q: p.q, a: p.a.replace(/\s+/g, ' ') }));
  // The PDF: lines cut at the page width, bold questions cut sooner, page numbers, section
  // titles between questions, an answer with its own "1. 2. 3." steps, questions without "?".
  // Word with typed numbers on heading lines, and Word numbering the questions itself (the
  // numbers are then not in the text at all).
  for (const file of ['qa-list.pdf', 'qa-headings.docx', 'qa-autonumbered.docx']) {
    const { text } = await extractDoc(file, fs.readFileSync(path.join(__dirname, 'fixtures', file)), { plain: true, outline: true });
    assert.deepEqual(flat(parseQA(text)), flat(want), file);
  }

  // The same as pasted text.
  const pasted = parseQA('Prep notes\n\n1. Why this role?\nIt is the work I want. My reasons:\n1. scope,\n2. team,\n3. product.\n2. Explain idempotency\nRunning it twice gives the same result.\n\nBehavioural\n3) Tell me about a conflict.\nA disagreement over ETL ownership.\n4. Notice period?\nThree months.');
  assert.deepEqual(pasted.map(p => p.q), ['Why this role?', 'Explain idempotency', 'Tell me about a conflict.', 'Notice period?']);
  assert.equal(pasted[0].a, 'It is the work I want. My reasons:\n1. scope,\n2. team,\n3. product.');
  assert.equal(pasted[1].a, 'Running it twice gives the same result.', 'the section title before question 3 is not part of the answer');
  // Three numbered steps inside one answer do not turn a list of plain questions into three "questions".
  assert.deepEqual(parseQA('Why us?\nThree reasons:\n1. scope,\n2. team,\n3. product.\n\nNotice period?\nThree months.\n\nSalary?\nMarket range.').map(p => p.q), ['Why us?', 'Notice period?', 'Salary?']);
  // A title above "Q:"-less numbered questions, or a lone heading, does not decide the format.
  assert.equal(parseQA('# My prep\n\n1. Why us?\nScope.\n2. Why now?\nTiming.\n3. Why you?\nFit.').length, 3);

  // With a hundred prepared answers, words that are in many questions count for less.
  const { rankPrepared } = require('../src/qa');
  const many = [];
  for (const t of ['a Spark job', 'an Airflow DAG', 'a Kafka consumer', 'a dbt model', 'a Delta table']) {
    many.push({ q: `${t} is running slowly. What would you inspect first?`, a: 'x' }, { q: `${t} fails halfway through after partial data has been written. How would you recover safely?`, a: 'y' }, { q: `How do you monitor ${t} in production?`, a: 'z' });
  }
  assert.equal(rankPrepared(many, 'Okay, so say your Kafka consumer is slow, where do you look?')[0].q, 'a Kafka consumer is running slowly. What would you inspect first?');
  assert.equal(rankPrepared(many, 'If a Spark job died midway and left partial data, how do you recover?')[0].q, 'a Spark job fails halfway through after partial data has been written. How would you recover safely?');
});

test('search by meaning: on by itself with OpenAI, and prepared answers are found for a question asked in other words', async () => {
  // Which embedding model is used.
  const model = (llmCfg, embed = {}) => new LLM(() => ({ llm: llmCfg, embed: { baseUrl: '', apiKey: '', model: '', ...embed } })).embedModel();
  assert.equal(model({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' }), 'text-embedding-3-small');
  assert.equal(model({ baseUrl: 'https://api.openai.com/v1', apiKey: '' }), '', 'no key yet: nothing to call');
  assert.equal(model({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk' }), '', 'a service without embeddings keeps to keywords');
  assert.equal(model({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' }, { model: 'off' }), '');
  assert.equal(model({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk' }, { model: 'nomic-embed', baseUrl: 'http://localhost:11434/v1' }), 'nomic-embed');
  assert.equal(model({ baseUrl: 'https://api.openai.com.evil.example/v1', apiKey: 'sk-x' }), '');

  // Prepared answers whose wording shares nothing with what is asked.
  const { QA_FILE, rankPrepared } = require('../src/qa');
  const pairs = [
    { q: 'What are your salary expectations?', a: 'Market range for a senior AI engineer.' },
    { q: 'How do you remove entries that appear twice?', a: 'Exact match on tax ID, then fuzzy match at 0.92.' },
    { q: 'How do you run jobs every night?', a: 'Airflow with a nightly schedule and retries.' },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sem-'));
  fs.mkdirSync(path.join(dir, 'qa'));
  fs.writeFileSync(path.join(dir, 'qa', QA_FILE), JSON.stringify(pairs));
  const kb = new KnowledgeBase(null);
  kb.setSource(await ingestFolder(dir, { sections: true }));
  const getConfig = cfgFor({ embed: { baseUrl: '', apiKey: '', model: 'embed-model' } });
  const llm = new LLM(getConfig);
  assert.equal(await kb.embedMissing(t => llm.embed(t), llm.embedModel()), 3);
  assert.ok(kb.prepared().every(p => p.vec && p.vec.length === 3));

  const asked = 'What if the same company shows up in the data more than once?';
  assert.ok(!rankPrepared(kb.prepared(), asked)[0].match, 'by wording alone nothing matches');
  const [vec] = await llm.embed([asked]);
  const ranked = rankPrepared(kb.prepared(), asked, vec);
  assert.equal(ranked[0].q, 'How do you remove entries that appear twice?');
  assert.ok(ranked[0].match && !ranked[1].match);
  assert.ok(!('vec' in ranked[0]), 'the numbers stay out of what is passed on');

  // In a meeting: the question is embedded once, and the prepared answer leads the block and the sources.
  const co = new Copilot({ getConfig, llm, kb, debounceMs: 20 });
  let sources = null;
  co.on('answer', e => { if (e.type === 'sources') sources = e.sources; });
  const before = srv.log.embed.length;
  await co.answer({ mode: 'typed', question: asked });
  assert.equal(srv.log.embed.length, before + 1);
  assert.match(srv.log.chat.at(-1).messages[1].content, /Answers I prepared[^\n]*\nQ: How do you remove entries that appear twice\?/);
  assert.deepEqual(sources.filter(x => x.n === 'Q').map(x => x.title), ['Prepared: How do you remove entries that appear twice?']);
});

test('Questions to ask: sent with every answer, with the rule for when they are offered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'));
  fs.mkdirSync(path.join(dir, 'questions-to-ask'));
  fs.writeFileSync(path.join(dir, 'questions-to-ask', '_note.md'), 'What does success look like in the first six months?\nHow is the team split between building and support?\n');
  fs.mkdirSync(path.join(dir, 'instructions'));
  fs.writeFileSync(path.join(dir, 'instructions', '_note.md'), 'Keep it short.');
  const mine = await ingestFolder(dir, { sections: true });
  const pin = mine.pinned.find(p => p.slot === 'ask');
  assert.equal(pin.title, 'Questions I want to ask the other side');
  assert.match(pin.text, /first six months\?\nHow is the team split/);
  const kb = new KnowledgeBase(null);
  kb.setSource(mine);
  const getConfig = cfgFor();
  const co = new Copilot({ getConfig, llm: new LLM(getConfig), kb, debounceMs: 20 });
  const [system, user] = co._buildMessages({ asked: 'Do you have any questions for us?', mode: 'auto', refs: [], cfg: getConfig() });
  assert.match(user.content, /### Instructions for this meeting\nKeep it short\.\n\n### Questions I want to ask the other side\nWhat does success look like/);
  // The whole list is offered, less what the conversation already answered, plus follow-ups from what was said.
  assert.match(system.content, /When the other side invites questions[^\n]*every one of those questions that the conversation has not already answered[^\n]*limits on bullets and words do not apply[^\n]*"Skipped:"[^\n]*"Also worth asking:"[^\n]*Never answer these questions yourself/);
  const { detectQuestion } = require('../src/question');
  assert.ok(detectQuestion('Okay, that is all from my side. Do you have any questions for us?').ask);
});

test('an answer is not started over for a few trailing words, and waits longer when the question trails off', async () => {
  const lines = [];
  const waiting = [];
  const llm = {
    transcribe: () => new Promise((resolve) => waiting.push(resolve)),
    chatStream: async (messages, { onDelta }) => { lines.push(/They just said: "([^"]*)"/.exec(messages[1].content)[1]); onDelta('ok'); return 'ok'; },
    embedConfigured: () => false,
  };
  const cfg = { autoAnswer: 'questions', answerLength: 'short', stt: { vocabulary: '' }, api: { searchUrl: '' } };
  const co = new Copilot({ getConfig: () => cfg, llm, kb: new KnowledgeBase(null), debounceMs: 40 });
  const say = async (text) => { const p = co.onSegment('them', Buffer.from('x'), 800); waiting.shift()(text); await p; };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  await say('How do you handle duplicate customer records?');
  await wait(80);
  assert.deepEqual(lines, ['How do you handle duplicate customer records?']);
  // A short remark right after: the answer stands.
  await say('Take your time.');
  await wait(120);
  assert.equal(lines.length, 1);
  await say('Okay, no rush, whenever you are ready.');
  await wait(120);
  assert.equal(lines.length, 1);
  // Two words that change the question: answered again.
  await say('In SQL.');
  await wait(80);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], 'How do you handle duplicate customer records? In SQL.');
  lines.pop();
  // More of the question: answered again, as one question.
  await say('And how would that change with ten times the data?');
  await wait(80);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^How do you handle duplicate customer records\? In SQL\. And how would that change with ten times the data\?$/);

  // A sentence that trails off is given longer; when the rest arrives it is answered once, whole.
  co.reset(); lines.length = 0;
  await say('How would you design a pipeline that');
  await wait(60);
  assert.equal(lines.length, 0, 'still waiting: the sentence is not finished');
  await say('reloads only the changed partitions?');
  await wait(80);
  assert.deepEqual(lines, ['How would you design a pipeline that reloads only the changed partitions?']);
  // Chinese without a closing mark is a finished question, not one that trails off.
  co.reset(); lines.length = 0;
  await say('你怎么处理重复的客户记录');
  await wait(70);
  assert.deepEqual(lines, ['你怎么处理重复的客户记录']);
});

// ---- speech capture ------------------------------------------------------------------
// The detector and segmenter run in the window; here they are loaded on their own, with the
// same model, and fed real (synthesized) speech: phrases of a question at different
// loudness, with pauses, over several kinds of background.
require('../renderer/vad.js'); // outside a window it puts itself on globalThis
const { VAD } = globalThis;
const BLOCK = 512, RATE = 16000;
let modelOnce;
const speechModel = () => (modelOnce = modelOnce || (async () => {
  const ort = require('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  return VAD.loadSpeechModel(ort, fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vad', 'silero_vad_v5.onnx')));
})());
const THEM = { start: 0.4, stay: 0.3, pause: 17 }, YOU = { start: 0.5, stay: 0.35, pause: 22 }; // as set in capture.js
const phrase = (name) => { // 16 kHz mu-law -> samples in -1..1
  const b = fs.readFileSync(path.join(__dirname, 'fixtures', `phrase-${name}.ulaw`)), out = new Float32Array(b.length);
  for (let i = 0; i < b.length; i++) { const u = ~b[i] & 0xff, t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4); out[i] = ((u & 0x80) ? (0x84 - t) : (t - 0x84)) / 32768; }
  return out;
};
const PHRASES = ['a', 'b', 'c'].map(phrase);
const speechLevel = (w) => { let x = 0, n = 0; for (const v of w) if (Math.abs(v) > 0.01) { x += v * v; n++; } return Math.sqrt(x / n); };
// parts: [{ w, level, gapBefore (s) }]; background(blockIndex, rnd) -> noise level.
// -> { signal, speech: 1 per block that holds speech, lastSpeech: index of the last such block }
function scene(parts, background = () => 0.001, { seed = 5, tail = 2.5 } = {}) {
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let pos = 0; const at = [];
  for (const p of parts) { pos += Math.round(p.gapBefore * RATE); at.push(pos); pos += p.w.length; }
  const total = Math.ceil((pos + RATE * tail) / BLOCK) * BLOCK;
  const signal = new Float32Array(total), clean = new Float32Array(total);
  parts.forEach((p, k) => { const g = p.level / speechLevel(p.w); for (let i = 0; i < p.w.length; i++) { signal[at[k] + i] += p.w[i] * g; clean[at[k] + i] = p.w[i]; } });
  const speech = new Uint8Array(total / BLOCK); let lastSpeech = -1;
  for (let b = 0; b < speech.length; b++) {
    const lvl = background(b, rnd); let e = 0;
    for (let i = 0; i < BLOCK; i++) { signal[b * BLOCK + i] += (rnd() * 2 - 1) * lvl * 1.73; e += clean[b * BLOCK + i] ** 2; }
    if (Math.sqrt(e / BLOCK) > 0.01) { speech[b] = 1; lastSpeech = b; }
  }
  return { signal, speech, lastSpeech };
}
// Runs a signal through the segmenter.
// -> { kept: share of speech blocks inside emitted pieces, pieces: [seconds], seconds, pauseAfter: seconds from the last word to "stopped speaking" }
async function hear(sc, opts = THEM, extra = {}) {
  const model = await speechModel();
  const got = new Uint8Array(sc.speech.length), pieces = [];
  let idx = 0, covered = 0, stoppedAt = -1;
  const seg = new VAD.Segmenter({
    detect: model.stream(), ...opts, ...extra,
    onUtterance: (pcm) => { pieces.push(pcm.length / RATE); for (let i = Math.max(0, idx + 1 - covered); i <= idx; i++) got[i] = 1; },
    onSpeaking: (on) => { if (!on && idx >= sc.lastSpeech && stoppedAt < 0) stoppedAt = idx; },
  });
  const finish = seg._finish.bind(seg);
  seg._finish = (...a) => { covered = seg.cur ? seg.cur.blocks.length : 0; return finish(...a); };
  for (idx = 0; idx < sc.speech.length; idx++) await seg.push(sc.signal.subarray(idx * BLOCK, (idx + 1) * BLOCK));
  const stillSpeaking = !!seg.cur;
  idx = sc.speech.length - 1;
  await seg.flush();
  let all = 0, kept = 0;
  for (let b = 0; b < sc.speech.length; b++) if (sc.speech[b]) { all++; if (got[b]) kept++; }
  return { kept: all ? kept / all : 1, pieces, seconds: pieces.reduce((a, b) => a + b, 0), pauseAfter: stillSpeaking || stoppedAt < 0 ? Infinity : (stoppedAt - sc.lastSpeech) * BLOCK / RATE };
}
const BACKGROUNDS = {
  'a clean line': () => 0.0005,
  'steady hiss': () => 0.004,
  'hiss with dropouts': (b, rnd) => (rnd() < 0.04 ? 0 : 0.004),
  'hiss that cuts out every two seconds': (b) => (b % 62 < 9 ? 0 : 0.006),
  'room tone that swells': (b) => 0.0055 + 0.0025 * Math.sin(b / 25),
  'typing': (b) => (Math.floor(b / 2) % 15 === 0 ? 0.02 : 0.002),
};

test('speech capture: a question spoken in pieces, loud then quiet, is recorded whole', async () => {
  const [a, b, c] = PHRASES;
  // The first detector went by loudness: after a loud phrase it took quieter words for
  // silence, so "some highlights of your career progress" was heard and the rest was not.
  for (const [label, noise, levels] of [
    ['normal', 0.001, [0.08, 0.08, 0.08]],
    ['quiet after loud', 0.003, [0.09, 0.02, 0.03]],
    ['low system volume', 0.0015, [0.012, 0.006, 0.01]],
    ['barely audible', 0.0004, [0.004, 0.002, 0.003]],
    ['noisy line', 0.008, [0.06, 0.03, 0.05]],
  ]) {
    const r = await hear(scene([{ w: a, level: levels[0], gapBefore: 1.5 }, { w: b, level: levels[1], gapBefore: 0.45 }, { w: c, level: levels[2], gapBefore: 1.1 }], () => noise));
    assert.ok(r.kept >= 0.97, `${label}: ${(r.kept * 100).toFixed(0)}% of the speech was recorded`);
    assert.ok(r.pieces.length >= 1 && r.pieces.length <= 4, `${label}: ${r.pieces.length} pieces`);
  }
});

test('speech capture: a long turn is cut into pieces without a gap between them', async () => {
  const [a, b, c] = PHRASES;
  // About half a minute of speech with no real pause: breaths of 0.1 to 0.3 s only.
  const parts = [];
  for (let i = 0; i < 9; i++) parts.push({ w: [a, b, c][i % 3], level: 0.05, gapBefore: i ? 0.1 + (i % 3) * 0.1 : 1 });
  const r = await hear(scene(parts, () => 0.002));
  assert.ok(r.kept >= 0.995, `${(r.kept * 100).toFixed(1)}% recorded`);
  assert.ok(r.pieces.length >= 2 && r.pieces.every(s => s <= 18.1), `pieces: ${r.pieces.map(s => s.toFixed(1)).join(', ')}`);
});

test('speech capture: background noise is not recorded, and the end of a question is noticed at once whatever the background', async () => {
  const [a] = PHRASES;
  for (const [name, background] of Object.entries(BACKGROUNDS)) {
    // Twenty seconds of the background alone: nothing is sent for transcription, from either side.
    const quiet = { signal: scene([], background, { tail: 20 }).signal, speech: new Uint8Array(Math.floor(20 * RATE / BLOCK)), lastSpeech: -1 };
    for (const side of [THEM, YOU]) assert.equal((await hear(quiet, side)).seconds, 0, `${name}: background recorded as speech`);
    // A question over that background, normal and quiet: all of it is recorded, and "they
    // have stopped" comes within a second of the last word, so the answer can start. (A
    // detector that takes the background for a voice never reports the pause.)
    for (const level of [0.06, 0.015]) {
      const r = await hear(scene([{ w: a, level, gapBefore: 3 }], background, { tail: 6 }));
      assert.ok(r.kept >= 0.95, `${name}, level ${level}: ${(r.kept * 100).toFixed(0)}% recorded`);
      assert.ok(r.pauseAfter <= 1.0, `${name}, level ${level}: pause noticed after ${r.pauseAfter} s`);
      assert.ok(r.seconds <= a.length / RATE + 1.2, `${name}, level ${level}: ${r.seconds.toFixed(1)} s recorded for ${(a.length / RATE).toFixed(1)} s of speech`);
    }
  }
});

test('speech capture: what the microphone hears while the other side is talking is not sent', async () => {
  const [a, , c] = PHRASES;
  const model = await speechModel();
  // Them: phrase a. The microphone: the same phrase from the speakers (quieter, with room
  // noise), then, after they stop, the user's own reply.
  const them = scene([{ w: a, level: 0.08, gapBefore: 1 }, { w: new Float32Array(c.length), level: 1, gapBefore: 1.2 }], () => 0.001);
  const mic = scene([{ w: a, level: 0.03, gapBefore: 1.02 }, { w: c, level: 0.06, gapBefore: 1.18 }], () => 0.004);
  const themSeg = new VAD.Segmenter({ detect: model.stream(), ...THEM, onUtterance: () => {} });
  const heard = [];
  const youSeg = new VAD.Segmenter({ detect: model.stream(), ...YOU, masked: () => themSeg.audible(), onUtterance: (pcm) => heard.push(pcm.length / RATE) });
  const n = Math.min(them.signal.length, mic.signal.length) / BLOCK;
  for (let i = 0; i < n; i++) { await themSeg.push(them.signal.subarray(i * BLOCK, (i + 1) * BLOCK)); await youSeg.push(mic.signal.subarray(i * BLOCK, (i + 1) * BLOCK)); }
  await youSeg.flush();
  assert.equal(heard.length, 1, `sent ${heard.map(s => s.toFixed(1)).join(', ')} s`);
  assert.ok(Math.abs(heard[0] - c.length / RATE) < 1, 'the piece sent is the user\'s own reply');
  // With headphones (nothing from them in the microphone) the user's speech is sent as before.
  const own = await hear(scene([{ w: c, level: 0.06, gapBefore: 1 }], () => 0.004), YOU, { masked: () => themSeg.audible() });
  assert.equal(own.pieces.length, 1);
});

test('speech capture: if the model fails, detection carries on by loudness and says so', async () => {
  const [a] = PHRASES;
  const sc = scene([{ w: a, level: 0.06, gapBefore: 1.5 }], () => 0.002);
  const problems = [], pieces = [];
  let calls = 0;
  const seg = new VAD.Segmenter({ detect: async () => { if (++calls > 5) throw new Error('model gone'); return 0; }, onUtterance: (pcm) => pieces.push(pcm.length / RATE), onProblem: (e) => problems.push(e.message) });
  for (let i = 0; i < sc.speech.length; i++) await seg.push(sc.signal.subarray(i * BLOCK, (i + 1) * BLOCK));
  await seg.flush();
  assert.deepEqual(problems, ['model gone']);
  assert.equal(pieces.length, 1);
  assert.ok(Math.abs(pieces[0] - a.length / RATE) < 1.2, `${pieces[0].toFixed(1)} s recorded by loudness`);
});

test('a long question in many pieces is put together; accented short lines are heard again as English', async () => {
  const waiting = [], asked = [];
  const llm = {
    transcribe: () => new Promise((resolve) => waiting.push(resolve)),
    chatStream: async (messages, { onDelta }) => { asked.push(/They just said: "([^"]*)"/.exec(messages[1].content)[1]); onDelta('ok'); return 'ok'; },
    embedConfigured: () => false,
  };
  const cfg = { autoAnswer: 'questions', answerLength: 'short', stt: { vocabulary: '' }, api: { searchUrl: '' } };
  const co = new Copilot({ getConfig: () => cfg, llm, kb: new KnowledgeBase(null), debounceMs: 30 });
  const pieces = ['So I do have one scenario for you.', 'A director comes to you and says attrition spiked this quarter.', 'It went up to fifteen percent in this quarter alone.',
    'He believes it is because of the pay.', 'He wants you to look at the compensation data.', 'And tell him who to adjust so people do not quit.', 'So how would you approach this request?'];
  co.setSpeaking('them', true);
  for (const text of pieces) { const p = co.onSegment('them', Buffer.from('x'), 9000); waiting.shift()(text); await p; }
  co.setSpeaking('them', false);
  await new Promise(r => setTimeout(r, 520));
  assert.equal(asked.length, 1);
  assert.equal(asked[0], pieces.join(' '), 'all seven pieces are the question');
  assert.equal(languageToForce('Definições.', ''), 'en');
  assert.equal(languageToForce('I samma rå internen.', ''), 'en');
  assert.equal(languageToForce('Career opportunities', ''), '');
});

test('answers start promptly after a finished question, and the saved log says where the time went', async () => {
  const waiting = [];
  const llm = {
    transcribe: () => new Promise((resolve) => waiting.push(resolve)),
    chatStream: async (_m, { onDelta }) => { await new Promise(r => setTimeout(r, 30)); onDelta('I use two passes.'); return 'I use two passes.'; },
    embedConfigured: () => false,
  };
  const cfg = { autoAnswer: 'questions', answerLength: 'short', stt: { vocabulary: '' }, api: { searchUrl: '' } };
  // Defaults: a quarter of a second after the transcript of a finished question, longer when it trails off.
  const real = new Copilot({ getConfig: () => cfg, llm, kb: new KnowledgeBase(null) });
  assert.equal(real.debounceMs, 250);
  assert.equal(real.trailMs, 900);

  const co = new Copilot({ getConfig: () => cfg, llm, kb: new KnowledgeBase(null), debounceMs: 20 });
  const done = new Promise(r => co.on('answer', e => e.type === 'done' && r()));
  const p = co.onSegment('them', Buffer.from('x'), 4000, 550); // cut after 0.55 s of silence
  await new Promise(r => setTimeout(r, 40)); // transcription takes a moment
  waiting.shift()('How do you handle duplicate customer records?');
  await p; await done;
  const { timing } = co.history[0];
  assert.ok(timing.heard >= 585 && timing.heard < 950, `silence and transcription: ${timing.heard} ms`);
  assert.ok(timing.wait >= 15 && timing.wait < 200, `waiting: ${timing.wait} ms`);
  assert.ok(timing.first >= 25 && timing.first < 300, `to the first words: ${timing.first} ms`);
  assert.match(co.transcriptText(), /Suggested answer \(first words 0\.[6-9] s after they stopped\):/);
  // A typed question has no "they stopped" to measure from.
  await co.answer({ mode: 'typed', question: 'And the threshold?' });
  assert.ok(!co.history[1].timing);

  // Prepared answers ranked by meaning: fewer are sent, so the request is shorter.
  const many = Array.from({ length: 40 }, (_, i) => ({ q: `Question number ${i} about topic ${i}?`, a: 'x'.repeat(600), score: 1 - i / 40, match: i === 0 }));
  const count = (list) => (co._buildMessages({ asked: 'q', mode: 'typed', refs: [], prepared: list, cfg })[1].content.match(/^Q: /gm) || []).length;
  const byWording = count(many), byMeaning = count(many.map(x => ({ ...x, byMeaning: true })));
  assert.ok(byWording >= 24 && byMeaning >= 12 && byMeaning < byWording * 0.65, `${byWording} by wording, ${byMeaning} by meaning`);
});
