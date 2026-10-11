'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readNote, isIndexable } = require('./chunker');
const { extractDoc } = require('./extract');
const { NOTE, slotByDir } = require('../slots');

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

// sections: the folder is the app's own files, laid out as one folder per section. Files in
// a section are named after it and, outside Portfolio, sent with every answer.
async function ingestFolder(folder, { maxFiles = 2000, sections = false } = {}) {
  const stat = fs.statSync(folder);
  const root = stat.isDirectory() ? folder : path.dirname(folder);
  const list = [];
  if (stat.isDirectory()) walk(folder, root, list, maxFiles * 3);
  else list.push({ full: folder, rel: path.basename(folder) });
  const chunks = [], pinned = [];
  let files = 0, skipped = 0, newest = 0, bytes = 0;
  for (const f of list) {
    let st;
    try { st = fs.statSync(f.full); } catch { continue; }
    if (!isIndexable(f.rel, st.size) || files >= maxFiles) { skipped++; continue; }
    const { text, name } = await extractDoc(f.rel, fs.readFileSync(f.full));
    if (!text.trim()) { skipped++; continue; }
    files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
    const parts = f.rel.split('/');
    const slot = sections && parts.length > 1 ? slotByDir(parts[0]) : null;
    const url = pathToFileURL(f.full).href;
    let shown = `${path.basename(root)}/${f.rel}`, opts = { name }, typed = false;
    if (slot) {
      typed = parts.length === 2 && parts[1] === NOTE;
      const fileName = parts.slice(1).join('/');
      shown = `${slot.label}/${typed ? 'typed text' : fileName}`;
      opts = { pin: !slot.searched, name: typed ? slot.title : name, title: typed ? slot.title : `${slot.title}: ${name}` };
    }
    const note = readNote(f.rel, text, opts);
    for (const c of note.chunks) chunks.push({ path: shown, url, title: c.title, text: c.text });
    if (note.pinned) pinned.push({ path: shown, url, ...note.pinned, ...(slot ? { slot: slot.id } : {}), ...(typed ? { typed: true } : {}) });
  }
  // Same files, same sizes, nothing modified since -> same version.
  return { id: `folder:${folder}`, label: folder, url: '', version: `${files}:${bytes}:${Math.round(newest)}`, chunks, pinned, files, skipped };
}

module.exports = { ingestFolder };
