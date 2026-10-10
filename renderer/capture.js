'use strict';
// Audio and screen capture. Speech from each side is cut into utterances at
// natural pauses and sent for transcription; the shared screen is sampled and
// sent for OCR whenever it changes.

const RATE = 16000, BLOCK = 512, BLOCK_MS = (BLOCK / RATE) * 1000;

// Voice-activity segmenter with an adaptive noise floor.
class Segmenter {
  constructor(onUtterance, onLevel, onSpeaking = () => {}) {
    this.onUtterance = onUtterance; this.onLevel = onLevel; this.onSpeaking = onSpeaking;
    this.noise = 0.003; this.pre = []; this.cur = null; this.above = 0;
  }

  push(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    this.onLevel(rms);
    const on = Math.max(0.008, this.noise * 3.2), off = Math.max(0.005, this.noise * 2);

    if (!this.cur) {
      if (rms < on) this.noise = Math.min(0.05, this.noise * 0.95 + rms * 0.05);
      this.above = rms >= on ? this.above + 1 : 0;
      this.pre.push(block); if (this.pre.length > 10) this.pre.shift(); // 320 ms lead-in
      if (this.above >= 3) {
        this.cur = { blocks: this.pre.slice(), voiced: 3, quiet: 0, low: rms };
        this.pre = []; this.above = 0;
        this.onSpeaking(true);
      }
      return;
    }
    const c = this.cur;
    c.blocks.push(block);
    if (rms >= off) { c.voiced++; c.quiet = 0; } else c.quiet++;
    // Track the quietest recent level. Speech dips to the room's noise between words; if the
    // dips stay well above the assumed floor (a fan came on, hold music), the floor is raised
    // so pauses are found again instead of recording one endless utterance.
    c.low = rms < c.low ? rms : c.low * 1.012;
    if (c.blocks.length > 60 && c.low > off) this.noise = Math.min(0.05, Math.max(this.noise, c.low * 0.8));
    const seconds = c.blocks.length * BLOCK_MS / 1000;
    // End on a real pause; on long monologues cut at the next short breath so text keeps flowing.
    if (c.quiet >= 22 || (seconds > 9 && c.quiet >= 8) || seconds > 18) this._finish();
  }

  _finish() {
    const c = this.cur; this.cur = null;
    if (!c) return;
    this.onSpeaking(false);
    if (c.voiced < 8) return; // under ~250 ms of sound: a click or a cough
    const keep = c.blocks.length - Math.max(0, c.quiet - 6); // leave ~200 ms of trailing silence
    const pcm = new Float32Array(keep * BLOCK);
    for (let i = 0; i < keep; i++) pcm.set(c.blocks[i], i * BLOCK);
    this.onUtterance(pcm);
  }

  flush() { if (this.cur) this._finish(); }
}

function encodeWav(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  // Quiet sources (a soft-spoken guest, a low system volume) are brought up to a consistent level.
  let peak = 0; for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  const gain = peak > 0.001 ? Math.min(8, 0.85 / peak) : 1;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] * gain));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

class Capture {
  // hooks: onSegment(who, wavArrayBuffer, ms), onLevel(who, rms), onSpeaking(who, bool), onScreenText(text), onScreenFrame(canvas), onEnded(reason)
  constructor(hooks) { this.hooks = hooks; this.running = false; this.streams = []; this.refreshScreen = async () => false; }

  async listInputs() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Microphone' }));
  }

  // opts: { micDeviceId, themSource ('system' | deviceId), wantScreen, systemAudio, ocrIntervalSec }
  async start(opts) {
    await this.stop();
    const result = { mic: false, them: false, screen: false, problems: [] };
    this.ctx = new AudioContext({ sampleRate: RATE });
    await this.ctx.audioWorklet.addModule('vad-worklet.js');
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0; this.sink.connect(this.ctx.destination);
    this.segmenters = [];

    try {
      const mic = await this._openInput(opts.micDeviceId, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      this._listen(mic, 'you'); result.mic = true;
    } catch (e) {
      result.problems.push(`Microphone unavailable (${e.message || e.name}). Your side will not be transcribed.`);
    }

    const useSystem = opts.themSource === 'system';
    if (opts.wantScreen || (useSystem && opts.systemAudio)) {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: useSystem && opts.systemAudio });
        this.streams.push(display);
        if (display.getAudioTracks().length) { this._listen(new MediaStream(display.getAudioTracks()), 'them'); result.them = true; }
        const track = display.getVideoTracks()[0];
        if (opts.wantScreen && track) {
          this._watchScreen(display, opts.ocrIntervalSec || 4); result.screen = true;
          track.addEventListener('ended', () => this.hooks.onEnded('The shared window was closed. Screen reading stopped.'));
        } else if (track) track.stop();
      } catch (e) {
        result.problems.push(`Screen capture failed (${e.message || e.name}).`);
      }
    }
    if (!useSystem) {
      try {
        const them = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: opts.themSource }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        this._listen(them, 'them'); result.them = true;
      } catch (e) {
        result.problems.push(e.name === 'OverconstrainedError' || e.name === 'NotFoundError'
          ? 'The device chosen for their audio is not connected. Pick another under Settings.'
          : `Could not open the device chosen for their audio (${e.message || e.name}).`);
      }
    } else if (!result.them) {
      result.problems.push(opts.systemAudio
        ? 'System audio was not captured, so the other side will not be transcribed.'
        : 'System audio capture is only built in on Windows. Choose a loopback device for "Their audio" in Settings (see the README).');
    }
    this.running = result.mic || result.them || result.screen;
    if (!this.running) await this.stop();
    return result;
  }

  // Opens the saved device, or the system default if that device is no longer connected.
  async _openInput(deviceId, processing) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, ...processing } });
    } catch (e) {
      if (!deviceId || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
      return navigator.mediaDevices.getUserMedia({ audio: processing });
    }
  }

  _listen(stream, who) {
    this.streams.push(stream);
    const src = this.ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(this.ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 1 });
    const seg = new Segmenter(
      (pcm) => this.hooks.onSegment(who, encodeWav(pcm), Math.round(pcm.length / RATE * 1000)),
      (rms) => this.hooks.onLevel(who, rms),
      (on) => this.hooks.onSpeaking(who, on));
    tap.port.onmessage = (e) => seg.push(e.data);
    src.connect(tap); tap.connect(this.sink); // the muted sink keeps the graph running
    this.segmenters.push(seg);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (!this.running) return;
        seg.flush();
        this.hooks.onEnded(who === 'you' ? 'Your microphone was disconnected. Stop and start listening to pick it up again.'
          : 'Their audio stopped coming through. Stop and start listening to reconnect.');
      });
    }
  }

  _watchScreen(stream, intervalSec) {
    const video = document.createElement('video');
    video.muted = true; video.srcObject = new MediaStream(stream.getVideoTracks());
    video.play().catch(() => {});
    const small = document.createElement('canvas'); small.width = 96; small.height = 54;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const full = document.createElement('canvas');
    let lastSig = null, reading = false, skipped = 0;

    // force: read the frame now even if it looks unchanged (used when an answer is requested).
    const tick = async (force = false) => {
      if (!this.running || reading || video.readyState < 2 || !video.videoWidth) return;
      const mask = await window.mc.call('capture:overlayRect').then(r => (r.ok ? r.value : null));
      sctx.drawImage(video, 0, 0, 96, 54);
      if (mask) { sctx.fillStyle = '#000'; sctx.fillRect(mask.x * 96, mask.y * 54, mask.w * 96, mask.h * 54); }
      const px = sctx.getImageData(0, 0, 96, 54).data;
      const sig = new Uint8Array(96 * 54);
      for (let i = 0; i < sig.length; i++) sig[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
      if (lastSig && !force) {
        let changed = 0;
        for (let i = 0; i < sig.length; i++) if (Math.abs(sig[i] - lastSig[i]) > 18) changed++;
        // Unchanged slide: skip. A small edit (one new line of text) is picked up within a few ticks.
        const share = changed / sig.length;
        if (share < 0.004 && !(share > 0.0008 && ++skipped >= 3)) return;
      }
      skipped = 0;
      // Small captures are enlarged so body text is tall enough for OCR.
      const scale = video.videoWidth < 1500 ? 1.6 : video.videoWidth > 2600 ? 2600 / video.videoWidth : 1;
      full.width = Math.round(video.videoWidth * scale); full.height = Math.round(video.videoHeight * scale);
      const fctx = full.getContext('2d');
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(video, 0, 0, full.width, full.height);
      if (mask) { fctx.fillStyle = '#fff'; fctx.fillRect(mask.x * full.width, mask.y * full.height, mask.w * full.width, mask.h * full.height); }
      this.hooks.onScreenFrame(full);
      reading = true;
      try {
        const blob = await new Promise(r => full.toBlob(r, 'image/png'));
        const res = await window.mc.call('ocr:frame', await blob.arrayBuffer());
        if (res.ok && res.value !== null) { lastSig = sig; this.hooks.onScreenText(res.value); }
        else if (!res.ok) { clearInterval(this.screenTimer); this.hooks.onEnded(`Screen reading stopped: ${res.error}`); }
      } finally { reading = false; }
    };
    this.screenTimer = setInterval(() => tick(), Math.max(2, intervalSec) * 1000);
    setTimeout(() => tick(), 800);
    // Resolves once the screen as it is right now has been read.
    this.refreshScreen = async () => {
      for (let i = 0; reading && i < 100; i++) await new Promise(r => setTimeout(r, 100)); // let a read in progress finish
      await tick(true);
      return true;
    };
  }

  async stop() {
    this.running = false;
    this.refreshScreen = async () => false;
    clearInterval(this.screenTimer);
    for (const s of this.segmenters || []) s.flush();
    for (const s of this.streams) s.getTracks().forEach(t => t.stop());
    this.streams = []; this.segmenters = [];
    if (this.ctx) { try { await this.ctx.close(); } catch { /* already closed */ } this.ctx = null; }
  }
}

window.Capture = Capture;
