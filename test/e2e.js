'use strict';
// End-to-end smoke test: `npm run e2e` (Linux needs xvfb-run).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-server');

function fakeSpeechWav(file) {
  // A spoken phrase (synthesized speech from the test fixtures, about 3.9 s), then 2.6 s of
  // silence, looped by Chromium as the microphone. It has to be real speech: the app's
  // detector does not take noise for a voice.
  const b = fs.readFileSync(path.join(__dirname, 'fixtures', 'phrase-a.ulaw'));
  const speech = new Float32Array(b.length); // 16 kHz mu-law -> samples
  for (let i = 0; i < b.length; i++) { const u = ~b[i] & 0xff, t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4); speech[i] = ((u & 0x80) ? (0x84 - t) : (t - 0x84)) / 32768; }
  const rate = 48000, n = speech.length * 3 + Math.round(rate * 2.6), pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < speech.length * 3; i++) { // 16 kHz -> 48 kHz, straight lines between samples
    const k = Math.floor(i / 3), f = (i % 3) / 3, v = speech[k] * (1 - f) + (speech[Math.min(speech.length - 1, k + 1)]) * f;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * 0.9)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, pcm);
}

(async () => {
  const srv = await mock.start({ sttLines: ['How do you handle duplicate customer records?'] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-e2e-'));
  const out = process.env.MC_E2E_OUT || path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    llm: { baseUrl: srv.base + '/v1', apiKey: 'test-key', model: 'mock-chat', extra: {} },
    github: { apiBase: srv.base + '/gh' },
  }));
  const wav = path.join(tmp, 'speech.wav'); fakeSpeechWav(wav);
  // MC_E2E_BIN runs the test against a packaged build instead of the source tree.
  const packaged = process.env.MC_E2E_BIN;
  const electron = packaged || require('electron');
  const args = [...(packaged ? [] : ['.']), '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`];
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  const cmd = useXvfb ? 'xvfb-run' : electron;
  const argv = useXvfb ? ['-a', '-s', '-screen 0 1600x900x24', electron, ...args] : args;
  const child = spawn(cmd, argv, { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, MC_USER_DATA: tmp, MC_E2E: path.join(__dirname, 'e2e-hook.js'), MC_E2E_OUT: out, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  child.on('exit', async (code) => {
    await srv.close();
    console.log(`\nmock API saw: ${srv.log.stt.length} transcription calls, ${srv.log.chat.length} chat calls`);
    console.log(`screenshots and result.json in ${out}`);
    process.exit(code || 0);
  });
})();
