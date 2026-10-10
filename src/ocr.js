'use strict';
const fs = require('fs');
const path = require('path');

// Reads text out of screen frames with Tesseract. English data ships with the
// app; other languages are downloaded once into the data folder.
class OcrEngine {
  constructor({ dataDir, fetchFn = fetch }) {
    this.dataDir = dataDir; this.fetch = fetchFn;
    this.worker = null; this.langs = ''; this.busy = false; this.starting = null;
  }

  async _ensureLang(lang) {
    const file = path.join(this.dataDir, `${lang}.traineddata.gz`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (lang === 'eng') {
      const bundled = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int', 'eng.traineddata.gz');
      fs.copyFileSync(bundled, file);
      return;
    }
    const url = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`Could not download OCR language "${lang}" (${res.status}). Check the language code.`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }

  async _start(langs) {
    const list = langs.split(/[+,\s]+/).filter(Boolean);
    for (const l of list) await this._ensureLang(l);
    const { createWorker } = require('tesseract.js');
    if (this.worker) { try { await this.worker.terminate(); } catch { /* already gone */ } }
    this.worker = await createWorker(list, 1, { langPath: this.dataDir, cachePath: this.dataDir, gzip: true, cacheMethod: 'none' });
    await this.worker.setParameters({ preserve_interword_spaces: '1' });
    this.langs = langs;
  }

  // image: PNG/JPEG Buffer. Returns cleaned text, or null when a previous frame is still being read.
  async recognize(image, langs = 'eng') {
    if (this.busy) return null;
    this.busy = true;
    try {
      if (!this.worker || this.langs !== langs) await this._start(langs);
      const { data } = await this.worker.recognize(Buffer.from(image));
      return cleanOcrText(data.text || '');
    } finally { this.busy = false; }
  }

  async stop() {
    if (this.worker) { try { await this.worker.terminate(); } catch { /* ignore */ } this.worker = null; }
  }
}

// Removes the junk lines OCR produces from icons, toolbars and video tiles.
function cleanOcrText(text) {
  const out = [];
  for (let line of text.split('\n')) {
    line = line.replace(/\s{2,}/g, ' ').trim();
    if (line.length < 3) continue;
    const letters = (line.match(/[\p{L}\p{N}]/gu) || []).length;
    if (letters < 3 || letters / line.length < 0.55) continue;
    const words = line.split(' ');
    const real = words.filter(w => /[\p{L}\p{N}]{2,}/u.test(w)).length;
    if (real / words.length < 0.5) continue;
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out.join('\n');
}

module.exports = { OcrEngine, cleanOcrText };
