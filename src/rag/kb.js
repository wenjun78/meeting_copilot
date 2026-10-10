'use strict';
const fs = require('fs');
const path = require('path');
const { BM25 } = require('./bm25');

// Knowledge base: chunks from every source, a BM25 index over them, and
// (optionally) embeddings for hybrid retrieval.
class KnowledgeBase {
  constructor(dir) {
    this.dir = dir;
    this.sources = {};   // id -> {id,label,url,files,chunkCount,syncedAt}
    this.chunks = [];    // {sourceId,path,url,title,text,vec?}
    this.embedModel = '';
    this._bm25 = null;
  }

  load() {
    if (!this.dir) return this;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'kb.json'), 'utf8'));
      this.sources = meta.sources || {};
      this.chunks = meta.chunks || [];
      this.embedModel = meta.embedModel || '';
      if (meta.dim) {
        const bin = fs.readFileSync(path.join(this.dir, 'kb.vec'));
        const all = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
        let k = 0;
        for (const c of this.chunks) if (c.v) { c.vec = all.slice(k * meta.dim, (k + 1) * meta.dim); k++; delete c.v; }
      }
    } catch { /* first run or unreadable index: start empty */ }
    this._bm25 = null;
    return this;
  }

  save() {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const withVec = this.chunks.filter(c => c.vec);
    const dim = withVec.length ? withVec[0].vec.length : 0;
    const meta = {
      sources: this.sources, embedModel: this.embedModel, dim,
      chunks: this.chunks.map(({ vec, ...c }) => (vec ? { ...c, v: 1 } : c)),
    };
    const tmp = path.join(this.dir, 'kb.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, path.join(this.dir, 'kb.json'));
    if (dim) {
      const all = new Float32Array(withVec.length * dim);
      withVec.forEach((c, i) => all.set(c.vec, i * dim));
      fs.writeFileSync(path.join(this.dir, 'kb.vec'), Buffer.from(all.buffer));
    }
  }

  // origin: {kind:'github'|'url'|'folder', spec} - what the user added, used to sync again.
  setSource(result, origin = null) {
    this.chunks = this.chunks.filter(c => c.sourceId !== result.id);
    for (const c of result.chunks) this.chunks.push({ sourceId: result.id, ...c });
    this.sources[result.id] = {
      id: result.id, label: result.label, url: result.url || '', files: result.files,
      chunkCount: result.chunks.length, syncedAt: Date.now(), origin,
    };
    this._bm25 = null;
  }

  removeSource(id) {
    this.chunks = this.chunks.filter(c => c.sourceId !== id);
    delete this.sources[id];
    this._bm25 = null;
  }

  // Embed any chunks that lack a vector. embedFn(texts) -> number[][]
  async embedMissing(embedFn, model, onProgress) {
    if (this.embedModel !== model) { for (const c of this.chunks) delete c.vec; this.embedModel = model; }
    const todo = this.chunks.filter(c => !c.vec);
    for (let i = 0; i < todo.length; i += 64) {
      const batch = todo.slice(i, i + 64);
      const vecs = await embedFn(batch.map(c => `${c.title}\n${c.text}`.slice(0, 6000)));
      batch.forEach((c, j) => { c.vec = normalize(Float32Array.from(vecs[j])); });
      if (onProgress) onProgress(Math.min(i + 64, todo.length), todo.length);
    }
    return todo.length;
  }

  // queryVec is optional; with it, lexical and semantic rankings are fused (RRF).
  search(query, k = 6, queryVec = null) {
    if (!this.chunks.length) return [];
    if (!this._bm25) this._bm25 = new BM25(this.chunks);
    const lexical = this._bm25.search(query, 30);
    let ranked = lexical;
    if (queryVec) {
      const q = normalize(Float32Array.from(queryVec));
      const sem = [];
      for (let i = 0; i < this.chunks.length; i++) {
        const v = this.chunks[i].vec;
        if (!v || v.length !== q.length) continue;
        let dot = 0; for (let j = 0; j < q.length; j++) dot += q[j] * v[j];
        sem.push({ index: i, score: dot });
      }
      sem.sort((a, b) => b.score - a.score);
      const fused = new Map();
      const add = (list) => list.forEach((r, rank) => fused.set(r.index, (fused.get(r.index) || 0) + 1 / (60 + rank)));
      add(lexical); add(sem.slice(0, 30));
      ranked = [...fused].sort((a, b) => b[1] - a[1]).map(([index, score]) => ({ index, score }));
    }
    // Keep at most two chunks per file so one long README cannot crowd out the rest.
    const perFile = new Map(), out = [];
    for (const r of ranked) {
      const c = this.chunks[r.index];
      const key = c.sourceId + '|' + c.path;
      const n = perFile.get(key) || 0;
      if (n >= 2) continue;
      perFile.set(key, n + 1);
      out.push({ sourceId: c.sourceId, path: c.path, url: c.url, title: c.title, text: c.text, score: r.score });
      if (out.length >= k) break;
    }
    return out;
  }

  stats() {
    return { sources: Object.values(this.sources), chunks: this.chunks.length, embedded: this.chunks.filter(c => c.vec).length, embedModel: this.embedModel };
  }
}

function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

module.exports = { KnowledgeBase };
