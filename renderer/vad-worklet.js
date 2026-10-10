// Runs on the audio thread: mixes the input to mono and hands it to the page in 32 ms blocks (512 samples at 16 kHz).
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const frames = input[0].length, chans = input.length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < chans; c++) s += input[c][i];
      this.buf[this.n++] = s / chans;
      if (this.n === 512) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
