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
    this.boost = {};     // sourceId -> factor; the user's own notes and files outrank bulk sources
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
    // Passages that did not change keep their embeddings, so a re-sync only embeds what is new.
    const vecs = new Map();
    for (const c of this.chunks) if (c.sourceId === result.id && c.vec) vecs.set(c.path + '\n' + c.title + '\n' + c.text, c.vec);
    this.chunks = this.chunks.filter(c => c.sourceId !== result.id);
    for (const c of result.chunks) {
      const vec = vecs.get(c.path + '\n' + c.title + '\n' + c.text);
      this.chunks.push(vec ? { sourceId: result.id, ...c, vec } : { sourceId: result.id, ...c });
    }
    const now = Date.now();
    this.sources[result.id] = {
      id: result.id, label: result.label, url: result.url || '', files: result.files,
      chunkCount: result.chunks.length, syncedAt: now, checkedAt: now, version: result.version || '', origin,
      pinned: result.pinned || [],
    };
    this._bm25 = null;
  }

  // The source was checked and had not changed.
  touch(id) { if (this.sources[id]) this.sources[id].checkedAt = Date.now(); }

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
    let lexical = this._bm25.search(query, 60);
    if (Object.keys(this.boost).length) {
      lexical = lexical.map(r => ({ index: r.index, score: r.score * (this.boost[this.chunks[r.index].sourceId] || 1) })).sort((a, b) => b.score - a.score);
    }
    lexical = lexical.slice(0, 30);
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
    // At most two passages per file, so one long README cannot crowd out the rest; the file
    // of the best match may give up to five, because the question is most likely about it.
    // Which parts of that file is decided within the file: there, the words every passage of
    // it shares (its title, "publication") count for nothing and the section asked about wins.
    const perFile = new Map(), out = [], taken = new Set();
    const keyOf = (c) => c.sourceId + '|' + c.path;
    const take = (index, score) => {
      const c = this.chunks[index];
      taken.add(index);
      perFile.set(keyOf(c), (perFile.get(keyOf(c)) || 0) + 1);
      out.push({ sourceId: c.sourceId, path: c.path, url: c.url, title: c.title, text: c.text, score, ...(c.qa ? { qa: c.qa } : {}) });
    };
    const top = ranked.length ? keyOf(this.chunks[ranked[0].index]) : '';
    if (top) {
      take(ranked[0].index, ranked[0].score);
      const own = [];
      this.chunks.forEach((c, i) => { if (keyOf(c) === top) own.push(i); });
      if (own.length > 2) {
        const local = new BM25(own.map(i => this.chunks[i])).search(query, 4);
        const best = local.length ? local[0].score : 0;
        for (const r of local) {
          if (out.length >= Math.min(k, 4) || r.score < best * 0.35) break;
          if (!taken.has(own[r.index])) take(own[r.index], ranked[0].score);
        }
      }
    }
    for (const r of ranked) {
      if (out.length >= k) break;
      if (taken.has(r.index)) continue;
      const key = keyOf(this.chunks[r.index]);
      if ((perFile.get(key) || 0) >= (key === top ? 5 : 2)) continue;
      take(r.index, r.score);
    }
    return out;
  }

  // Answers the user prepared for questions they expect: [{q, a}]
  prepared() {
    return this.chunks.filter(c => c.qa && c.qa.q && c.qa.a).map(c => ({ q: c.qa.q, a: c.qa.a }));
  }

  // Notes that go to the model with every answer: [{path, url, title, text}]
  pinned() {
    return Object.values(this.sources).flatMap(s => (s.pinned || []).map(p => ({ ...p, sourceId: s.id })));
  }

  // Every file that can be searched, grouped by source: [{id, label, files:[{path, passages, chars}]}]
  inventory() {
    const bySource = new Map();
    for (const c of this.chunks) {
      let files = bySource.get(c.sourceId);
      if (!files) bySource.set(c.sourceId, (files = new Map()));
      const f = files.get(c.path) || { path: c.path, passages: 0, chars: 0 };
      f.passages++; f.chars += c.text.length;
      files.set(c.path, f);
    }
    return [...bySource].map(([id, files]) => ({ id, label: (this.sources[id] || {}).label || id, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) }));
  }

  // How one file was read: how many passages it gave and the name it was given.
  fileFacts(sourceId, filePath) {
    const mine = this.chunks.filter(c => c.sourceId === sourceId && c.path === filePath);
    return { passages: mine.length, title: mine.length ? mine[0].title.split(' — ')[0] : '' };
  }

  // The text of one file as it was read, passages joined in order.
  fileText(sourceId, filePath) {
    return this.chunks.filter(c => c.sourceId === sourceId && c.path === filePath).map(c => c.text).join('\n\n');
  }

  stats() {
    // The pinned notes' text stays in the main process; the window only needs their names.
    const sources = Object.values(this.sources).map(({ pinned, ...s }) => ({ ...s, pinned: (pinned || []).map(p => p.path) }));
    return { sources, chunks: this.chunks.length, embedded: this.chunks.filter(c => c.vec).length, embedModel: this.embedModel };
  }
}

function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

module.exports = { KnowledgeBase };
