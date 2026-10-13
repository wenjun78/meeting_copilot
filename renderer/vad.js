'use strict';
// Finding speech in a stream of audio and cutting it into utterances.
//
// Whether a 32 ms block holds speech is decided by a trained model (Silero VAD, MIT licence,
// run locally with ONNX Runtime). Loudness cannot decide it: a quiet voice after a loud one
// looks like silence, and hiss, fans and typing look like sound. The model was trained on
// thousands of hours of speech and noise and tells the two apart at any volume.
// If the model cannot be loaded, loudness is used instead (see loudnessDetector) and the
// app says so.
//
// Works in the window (as window.VAD) and in Node (for the tests).
(function (root) {
  const BLOCK = 512, RATE = 16000, BLOCK_MS = (BLOCK / RATE) * 1000;

  // ort: ONNX Runtime. model: the bytes of silero_vad_v5.onnx.
  // -> { stream() } ; each audio source gets its own stream, because the model carries
  // what it has heard so far. A stream is a function: block (512 samples) -> chance of speech, 0..1.
  async function loadSpeechModel(ort, model) {
    const session = await ort.InferenceSession.create(model);
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
    return {
      stream() {
        let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
        let context = new Float32Array(64); // the tail of the previous block, as the model expects
        return async (block) => {
          const frame = new Float32Array(64 + BLOCK);
          frame.set(context, 0); frame.set(block, 64);
          context = block.slice(BLOCK - 64);
          const out = await session.run({ input: new ort.Tensor('float32', frame, [1, frame.length]), state, sr });
          state = out.stateN;
          return out.output.data[0];
        };
      },
    };
  }

  // The fallback: speech is taken to be sound that rises clear of the background, the
  // background being the quietest the signal has been over the last three seconds.
  function loudnessDetector() {
    const lows = []; let low = Infinity, lowN = 0, prev = 0, noise = 0.002;
    return async (block) => {
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      const rms = Math.sqrt(sum / block.length);
      const smooth = (rms + prev) / 2; prev = rms;
      if (smooth < low) low = smooth;
      if (++lowN >= 16) { lows.push(low); if (lows.length > 6) lows.shift(); low = Infinity; lowN = 0; }
      let m = low;
      for (const v of lows) if (v < m) m = v;
      if (m !== Infinity) noise = Math.min(0.05, m * 1.25);
      return rms >= Math.max(0.005, noise * 2.6) ? 0.9 : rms >= Math.max(0.0035, noise * 1.7) ? 0.4 : 0.05;
    };
  }

  // Cuts one side's audio into utterances and hands each to onUtterance(pcm).
  //   detect(block) -> chance of speech; start / stay: the chance needed to begin and to continue.
  //   masked(): true while the other side is audible (the microphone hearing the speakers).
  // An utterance ends on a pause. A long turn is cut at a breath so text keeps coming, and
  // recording carries straight on, so nothing between two pieces is lost.
  class Segmenter {
    constructor({ detect, onUtterance, onLevel = () => {}, onSpeaking = () => {}, onProblem = () => {}, masked = null, start = 0.5, stay = 0.35 }) {
      Object.assign(this, { detect, onUtterance, onLevel, onSpeaking, onProblem, masked, start, stay });
      this.pre = []; this.cur = null; this.hot = 0; this.n = 0; this.heardAt = -1e9;
      this.chain = Promise.resolve();
    }

    // Blocks are judged one after another, in the order they arrive. -> a promise for this block
    push(block) {
      this.chain = this.chain.then(() => this._step(block));
      return this.chain;
    }

    async _step(block) {
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      this.onLevel(Math.sqrt(sum / block.length));
      let p;
      try { p = await this.detect(block); } catch (e) {
        // The model stopped working: carry on by loudness rather than go deaf.
        this.detect = loudnessDetector();
        this.onProblem(e);
        p = await this.detect(block);
      }
      this.n++;
      if (p >= this.start) this.heardAt = this.n;

      if (!this.cur) {
        this.hot = p >= this.start ? this.hot + 1 : 0;
        this.pre.push(block); if (this.pre.length > 12) this.pre.shift(); // ~380 ms lead-in
        if (this.hot >= 2) {
          this.cur = { blocks: this.pre.slice(), voiced: 2, quiet: 0, masked: 0 };
          this.pre = []; this.hot = 0;
          this.onSpeaking(true);
        }
        return;
      }
      const c = this.cur;
      c.blocks.push(block);
      if (p >= this.stay) { c.voiced++; c.quiet = 0; } else c.quiet++;
      if (this.masked && this.masked()) c.masked++;
      const seconds = c.blocks.length * BLOCK_MS / 1000;
      if (c.quiet >= 22) this._finish();                                          // a real pause (0.7 s): the thought is over
      else if ((seconds > 9 && c.quiet >= 8) || seconds > 18) this._finish(true); // a long turn: cut at a breath and carry on
    }

    // carryOn: the speaker has not stopped, so the next piece starts at once.
    _finish(carryOn = false) {
      const c = this.cur; this.cur = null;
      if (!c) return;
      if (carryOn) this.cur = { blocks: [], voiced: 0, quiet: c.quiet, masked: 0 };
      else this.onSpeaking(false);
      if (c.voiced < 6) return; // under a fifth of a second of speech: a click, a cough, "mm"
      // Heard mostly while the other side was talking: it is their voice from the speakers.
      if (this.masked && c.masked / c.blocks.length >= 0.6) return;
      const keep = c.blocks.length - Math.max(0, c.quiet - 6); // leave ~200 ms of trailing silence
      const pcm = new Float32Array(keep * BLOCK);
      for (let i = 0; i < keep; i++) pcm.set(c.blocks[i], i * BLOCK);
      this.onUtterance(pcm);
    }

    // True while this side was speaking within the last quarter of a second.
    audible() { return this.n - this.heardAt <= 8; }

    // Ends whatever is being recorded, once the blocks already pushed have been judged.
    flush() { this.chain = this.chain.then(() => { if (this.cur) this._finish(); }); return this.chain; }
  }

  root.VAD = { loadSpeechModel, loudnessDetector, Segmenter, BLOCK, RATE };
})(typeof window !== 'undefined' ? window : globalThis);
