'use strict';
const { tokenize } = require('./tokenize');

// Okapi BM25 over an array of {text, title, path} documents.
class BM25 {
  constructor(docs, { k1 = 1.4, b = 0.72 } = {}) {
    this.k1 = k1; this.b = b;
    this.n = docs.length;
    this.len = new Float32Array(this.n);
    this.postings = new Map(); // term -> [docIdx, tf, docIdx, tf, ...]
    this.inTitle = new Map();  // term -> [docIdx, ...] for terms in the passage's title
    let total = 0;
    for (let i = 0; i < this.n; i++) {
      const d = docs[i];
      // Title and path are repeated so a hit there outweighs a body mention.
      for (const t of new Set(tokenize(d.title || ''))) {
        let p = this.inTitle.get(t);
        if (!p) this.inTitle.set(t, (p = []));
        p.push(i);
      }
      const toks = tokenize(`${d.title || ''} ${d.title || ''} ${d.path || ''} ${d.text}`);
      this.len[i] = toks.length; total += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, f] of tf) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = []));
        p.push(i, f);
      }
    }
    this.avg = this.n ? total / this.n : 0;
  }

  search(query, k = 10) {
    if (!this.n) return [];
    const scores = new Map();
    const seen = new Set();
    for (const t of tokenize(query)) {
      if (seen.has(t)) continue; seen.add(t);
      const p = this.postings.get(t);
      if (!p) continue;
      const df = p.length / 2;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (let j = 0; j < p.length; j += 2) {
        const i = p[j], f = p[j + 1];
        const s = idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avg));
        scores.set(i, (scores.get(i) || 0) + s);
      }
      // A query word in the title says the whole passage is about it, however long the passage is.
      for (const i of this.inTitle.get(t) || []) scores.set(i, (scores.get(i) || 0) + idf * 1.5);
    }
    return [...scores].sort((a, b) => b[1] - a[1]).slice(0, k).map(([index, score]) => ({ index, score }));
  }
}

module.exports = { BM25 };
