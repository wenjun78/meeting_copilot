'use strict';
// Audio and screen capture. Speech from each side is cut into utterances at
// natural pauses and sent for transcription; the shared screen is sampled and
// sent for OCR whenever it changes.

const RATE = 16000, BLOCK = 512, BLOCK_MS = (BLOCK / RATE) * 1000;

// Cuts one side's audio into utterances. The aim is to lose no speech: when in doubt it
// records, and leaves it to transcription to return nothing for a stretch without words.
//
// The background level is the quietest the signal has been over the last three seconds.
// (An average would creep up to the level of quiet or continuous speech and then shut that
// speech out; the quietest moment does not: even fluent speech drops to the room's level
// between words.) Speech starts when the level rises clear of that background, and ends on
// a pause. A long turn is cut at a breath so text keeps coming, and recording carries
// straight on, so nothing between two pieces is lost.
class Segmenter {
  // K: how far above the background counts (see Segmenter.THEM and Segmenter.YOU).
  // masked(): optional, true while the other side is audible (see Capture._listen).
  constructor(onUtterance, onLevel, onSpeaking = () => {}, { K = Segmenter.THEM, masked = null } = {}) {
    this.onUtterance = onUtterance; this.onLevel = onLevel; this.onSpeaking = onSpeaking; this.K = K; this.masked = masked;
    this.loudAt = -1e9; this.n = 0; // when this side was last clearly audible, counted in blocks
    this.noise = 0.002; this.pre = []; this.cur = null; this.above = 0; this.level = 0; this.raised = 0;
    this.lows = []; this.low = Infinity; this.lowN = 0; this.prev = 0;
  }

  // Background level: the minimum over six half-second windows, a little above it.
  _background(rms) {
    const smooth = (rms + this.prev) / 2; this.prev = rms; // one odd block does not set the floor
    if (smooth < this.low) this.low = smooth;
    if (++this.lowN >= 16) { this.lows.push(this.low); if (this.lows.length > 6) this.lows.shift(); this.low = Infinity; this.lowN = 0; }
    let m = this.low;
    for (const v of this.lows) if (v < m) m = v;
    if (m !== Infinity) this.noise = Math.min(0.05, m * 1.25);
  }

  push(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    this.onLevel(rms);
    this._background(rms);
    this.level = this.level * 0.8 + rms * 0.2; // the level over the last ~150 ms
    const K = this.K;
    const on = Math.max(K.onMin, this.noise * K.on), off = Math.max(K.offMin, this.noise * K.off);
    this.n++;
    if (rms >= Math.max(0.008, this.noise * 3.5)) this.loudAt = this.n; // plainly audible, not merely above the floor

    if (!this.cur) {
      this.above = rms >= on ? this.above + 1 : 0;
      // Soft or choppy speech may never give three loud blocks in a row, but it lifts the
      // level as a whole: about a fifth of a second at twice the background is speech too.
      this.raised = this.level >= Math.max(K.raiseMin, this.noise * K.raise) ? this.raised + 1 : 0;
      this.pre.push(block); if (this.pre.length > 14) this.pre.shift(); // ~450 ms lead-in
      if (this.above >= 3 || this.raised >= 6) {
        this.cur = { blocks: this.pre.slice(), voiced: 3, quiet: 0, masked: 0 };
        this.pre = []; this.above = 0; this.raised = 0;
        this.onSpeaking(true);
      }
      return;
    }
    const c = this.cur;
    c.blocks.push(block);
    if (rms >= off) { c.voiced++; c.quiet = 0; } else c.quiet++;
    if (this.masked && this.masked()) c.masked++;
    const seconds = c.blocks.length * BLOCK_MS / 1000;
    if (c.quiet >= 22) this._finish();                                            // a real pause: the turn, or the thought, is over
    else if ((seconds > 9 && c.quiet >= 8) || seconds > 18) this._finish(true);   // a long turn: cut at a breath and carry on
  }

  // carryOn: the speaker has not stopped, so the next piece starts at once.
  _finish(carryOn = false) {
    const c = this.cur; this.cur = null;
    if (!c) return;
    if (carryOn) this.cur = { blocks: [], voiced: 0, quiet: c.quiet, masked: 0 };
    else this.onSpeaking(false);
    if (c.voiced < 8) return; // under ~250 ms of sound: a click or a cough
    // Heard mostly while the other side was talking: it is their voice from the speakers.
    if (this.masked && c.masked / c.blocks.length >= 0.6) return;
    const keep = c.blocks.length - Math.max(0, c.quiet - 6); // leave ~200 ms of trailing silence
    const pcm = new Float32Array(keep * BLOCK);
    for (let i = 0; i < keep; i++) pcm.set(c.blocks[i], i * BLOCK);
    this.onUtterance(pcm);
  }

  flush() { if (this.cur) this._finish(); }
}

// How far above the background counts: to start at once (on), to stay in (off), and to
// start when sustained (raise); the "Min" values apply when the background is silent.
// The other side comes as clean system audio and losing their words costs the most, so it is
// recorded readily. The microphone sits in a room with its own noise: it needs a clearer
// rise, which keeps keyboard and fan sounds from being sent off as speech.
Segmenter.THEM = { on: 2.4, onMin: 0.003, off: 1.5, offMin: 0.002, raise: 1.6, raiseMin: 0.0025 };
Segmenter.YOU = { on: 2.6, onMin: 0.005, off: 1.7, offMin: 0.0035, raise: 1.8, raiseMin: 0.004 };
// True while this side was clearly audible within the last ~250 ms.
Segmenter.prototype.audible = function () { return this.n - this.loudAt <= 8; };

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
    this.segmenters = []; this.themSeg = null;

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
    // Without headphones the microphone also hears the other side from the speakers. What it
    // picks up while they are audible is their voice, not the user's, and is not sent on.
    const seg = new Segmenter(
      (pcm) => this.hooks.onSegment(who, encodeWav(pcm), Math.round(pcm.length / RATE * 1000)),
      (rms) => this.hooks.onLevel(who, rms),
      (on) => this.hooks.onSpeaking(who, on),
      who === 'you' ? { K: Segmenter.YOU, masked: () => !!this.themSeg && this.themSeg.audible() } : { K: Segmenter.THEM });
    if (who === 'them') this.themSeg = seg;
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
