'use strict';
// End-to-end smoke test: `npm run e2e` (Linux needs xvfb-run).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-server');

function fakeSpeechWav(file) {
  // 2.6 s of syllable-shaped noise, then 2.4 s of silence, looped by Chromium as the microphone.
  const rate = 48000, n = rate * 5, pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = t < 2.6 ? Math.max(0, Math.sin(t * Math.PI * 4)) ** 2 : 0;
    lp = lp * 0.9 + (Math.random() * 2 - 1) * 0.1;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, lp * 2.2 * env + Math.sin(t * 2 * Math.PI * 180) * 0.15 * env)) * 32767), 44 + i * 2);
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
