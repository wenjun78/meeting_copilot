'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chunkFile, isIndexable } = require('./chunker');
const { extractText } = require('./extract');

function walk(dir, root, out, limit) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) { if (isIndexable(rel + '/x.md', 0) && !e.name.startsWith('.')) walk(full, root, out, limit); }
    else if (e.isFile()) out.push({ full, rel });
  }
}

async function ingestFolder(folder, { maxFiles = 2000 } = {}) {
  const stat = fs.statSync(folder);
  const root = stat.isDirectory() ? folder : path.dirname(folder);
  const list = [];
  if (stat.isDirectory()) walk(folder, root, list, maxFiles * 3);
  else list.push({ full: folder, rel: path.basename(folder) });
  const chunks = [];
  let files = 0, skipped = 0, newest = 0, bytes = 0;
  for (const f of list) {
    let st;
    try { st = fs.statSync(f.full); } catch { continue; }
    if (!isIndexable(f.rel, st.size) || files >= maxFiles) { skipped++; continue; }
    const text = await extractText(f.rel, fs.readFileSync(f.full));
    if (!text.trim()) { skipped++; continue; }
    files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
    for (const c of chunkFile(f.rel, text)) {
      chunks.push({ path: `${path.basename(root)}/${f.rel}`, url: pathToFileURL(f.full).href, title: c.title, text: c.text });
    }
  }
  // Same files, same sizes, nothing modified since -> same version.
  return { id: `folder:${folder}`, label: folder, url: '', version: `${files}:${bytes}:${Math.round(newest)}`, chunks, files, skipped };
}

module.exports = { ingestFolder };
