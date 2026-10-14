'use strict';
// Audio and screen capture. Speech from each side is cut into utterances at
// natural pauses and sent for transcription; the shared screen is sampled and
// sent for OCR whenever it changes.

const { RATE, BLOCK, Segmenter, loadSpeechModel, loudnessDetector } = window.VAD;

// The speech model is loaded once and shared by both sides. -> the model, or null when it
// cannot be loaded (speech is then found by loudness).
let speechModel;
function speechModelOnce() {
  if (!speechModel) speechModel = (async () => {
    const assets = await window.mc.call('vad:assets');
    if (!assets.ok) throw new Error(assets.error);
    if (!window.ort) throw new Error('the model runtime did not load');
    window.ort.env.wasm.numThreads = 1;
    window.ort.env.wasm.wasmBinary = assets.value.wasm; // handed over directly, so nothing is fetched
    window.ort.env.wasm.wasmPaths = assets.value.runtimeDir;
    return loadSpeechModel(window.ort, new Uint8Array(assets.value.model));
  })().catch((e) => { console.warn('speech model unavailable:', e); return null; });
  return speechModel;
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

  // opts: { micDeviceId, themSource ('system' | deviceId), wantScreen, systemAudio, ocrIntervalSec, record, live }
  // live: their speech is also handed on while it is being spoken (hooks.onAudio), for live transcription.
  async start(opts) {
    await this.stop();
    const result = { mic: false, them: false, screen: false, problems: [] };
    this.ctx = new AudioContext({ sampleRate: RATE });
    await this.ctx.audioWorklet.addModule('vad-worklet.js');
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0; this.sink.connect(this.ctx.destination);
    this.segmenters = []; this.themSeg = null; this.live = !!opts.live;
    this.sources = []; this.recMix = null; this.recorder = null;
    this.model = await speechModelOnce();
    if (!this.model) result.problems.push('Speech detection is running in basic mode (the speech model could not be loaded), so quiet speech may be missed. Restart the app; if this stays, reinstall it.');

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
    if (opts.record && (result.mic || result.them)) {
      const problem = this.startRecording();
      if (problem) result.problems.push(problem); else result.recording = true;
    }
    return result;
  }

  // Recording: both sides mixed into one track, encoded as it goes and handed on in pieces
  // every few seconds, so a crash loses seconds, not the meeting. Can begin and end at any
  // point of a call. -> '' or why it could not start.
  startRecording() {
    if (this.recorder) return '';
    if (!this.running || !this.ctx || !this.sources.length) return 'Nothing is being listened to yet, so there is nothing to record.';
    try {
      const out = this.ctx.createMediaStreamDestination();
      this.recMix = this.ctx.createGain(); this.recMix.gain.value = 0.7; // headroom for when both sides speak at once
      this.recMix.connect(out);
      for (const src of this.sources) src.connect(this.recMix);
      this.recorder = new MediaRecorder(out.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
      this.recorder.ondataavailable = async (e) => { if (e.data && e.data.size) this.hooks.onRecording(await e.data.arrayBuffer()); };
      this.recorder.start(3000);
      return '';
    } catch (e) {
      this.recMix = null; this.recorder = null;
      return `The call is not being recorded (${e.message || e.name}).`;
    }
  }

  get recording() { return !!this.recorder; }

  // Ends the recording; resolves once the last piece has been handed on.
  async stopRecording() {
    const rec = this.recorder; this.recorder = null;
    if (!rec) return;
    await new Promise((done) => { rec.onstop = () => setTimeout(done, 50); try { rec.stop(); } catch { done(); } });
    if (this.recMix) { try { this.recMix.disconnect(); } catch { /* closed */ } this.recMix = null; }
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
    // The other side is recorded readily (their words matter most); the microphone needs a
    // clearer case. Without headphones the microphone also hears the other side from the
    // speakers: what it picks up while they are speaking is their voice, and is not sent on.
    // Live: their audio goes out about ten times a second while they speak, and what is
    // still held is sent before the utterance is closed, so the pieces arrive in order.
    let held = [], heldFirst = false;
    const sendHeld = () => {
      if (!held.length) return;
      const samples = new Float32Array(held.length * BLOCK);
      held.forEach((b, i) => samples.set(b, i * BLOCK));
      this.hooks.onAudio(who, samples, heldFirst);
      held = []; heldFirst = false;
    };
    const streaming = who === 'them' && this.live;
    const seg = new Segmenter({
      detect: this.model ? this.model.stream() : loudnessDetector(),
      onUtterance: (pcm, quietMs) => { sendHeld(); this.hooks.onSegment(who, encodeWav(pcm), Math.round(pcm.length / RATE * 1000), Math.round(quietMs)); },
      ...(streaming ? {
        onAudio: (blocks, first) => { if (first) { held = []; heldFirst = true; } held.push(...blocks); if (first || held.length >= 3) sendHeld(); },
        onDiscard: () => { held = []; heldFirst = false; this.hooks.onDiscard(who); },
      } : {}),
      onLevel: (rms) => this.hooks.onLevel(who, rms),
      onSpeaking: (on) => this.hooks.onSpeaking(who, on),
      onProblem: (e) => console.warn('speech model failed, using loudness:', e),
      // Their utterance ends after 0.55 s of quiet, so the answer can start sooner; yours after 0.7 s.
      ...(who === 'you' ? { start: 0.5, stay: 0.35, pause: 22, masked: () => !!this.themSeg && this.themSeg.audible() } : { start: 0.4, stay: 0.3, pause: 17 }),
    });
    if (who === 'them') this.themSeg = seg;
    tap.port.onmessage = (e) => seg.push(e.data);
    src.connect(tap); tap.connect(this.sink); // the muted sink keeps the graph running
    this.sources.push(src);
    if (this.recMix) src.connect(this.recMix); // both sides go into the recording, when one is being made
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
    await this.stopRecording(); // the last piece is handed on before the audio closes
    for (const s of this.streams) s.getTracks().forEach(t => t.stop());
    this.streams = []; this.segmenters = []; this.sources = [];
    if (this.ctx) { try { await this.ctx.close(); } catch { /* already closed */ } this.ctx = null; }
  }
}

window.Capture = Capture;
