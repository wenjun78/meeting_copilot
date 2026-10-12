'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readNote, isIndexable } = require('./chunker');
const { extractDoc, abstractOf } = require('./extract');
const { NOTE, slotByDir } = require('../slots');
const { QA_FILE, normalizePairs, parseQA } = require('../qa');

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
// a section are named after it and, outside Publications and Portfolio, sent with every answer.
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
    const parts = f.rel.split('/');
    const slot = sections && parts.length > 1 ? slotByDir(parts[0]) : null;
    // Q&A: the list of prepared answers (or a document of them) gives one passage per pair,
    // each carrying its question and answer so it can be offered whole.
    if (slot && slot.qa) {
      let pairs = [];
      try {
        if (parts[1] === QA_FILE) pairs = normalizePairs(JSON.parse(fs.readFileSync(f.full, 'utf8')));
        else if (isIndexable(f.rel, st.size)) pairs = parseQA((await extractDoc(f.rel, fs.readFileSync(f.full), { plain: true, outline: true })).text);
      } catch { /* unreadable list: nothing prepared */ }
      if (!pairs.length) { skipped++; continue; }
      files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
      const shown = `${slot.label}/${parts[1] === QA_FILE ? 'prepared answers' : parts.slice(1).join('/')}`;
      for (const p of pairs) chunks.push({ path: shown, url: pathToFileURL(f.full).href, title: `Prepared answer: ${p.q}`, text: `Question: ${p.q}\nMy answer: ${p.a}`, qa: p });
      continue;
    }
    if (!isIndexable(f.rel, st.size) || files >= maxFiles) { skipped++; continue; }
    const isTyped = !!slot && parts.length === 2 && parts[1] === NOTE;
    const paper = !!slot && !!slot.papers && !isTyped;
    const { text, name } = await extractDoc(f.rel, fs.readFileSync(f.full), { paper });
    if (!text.trim()) { skipped++; continue; }
    files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
    const url = pathToFileURL(f.full).href;
    let shown = `${path.basename(root)}/${f.rel}`, opts = { name }, typed = false;
    if (slot) {
      typed = parts.length === 2 && parts[1] === NOTE;
      const fileName = parts.slice(1).join('/');
      shown = `${slot.label}/${typed ? 'typed text' : fileName}`;
      opts = { pin: !slot.searched && !paper, name: typed ? (slot.papers ? 'About my publications' : slot.title) : name, title: typed ? (slot.papers ? 'About my publications' : slot.title) : `${slot.title}: ${name}` };
    }
    const note = readNote(f.rel, text, opts);
    for (const c of note.chunks) chunks.push({ path: shown, url, title: c.title, text: c.text });
    // A paper is too long to send whole: its title and abstract go with every answer, so the
    // model always knows the paper exists and what it found; the sections are searched.
    if (paper) {
      const about = abstractOf(text);
      const title = name.replace(' (research paper)', '');
      if (about) pinned.push({ path: shown, url, title, text: about, chars: about.length, slot: slot.id });
    }
    if (note.pinned) pinned.push({ path: shown, url, ...note.pinned, ...(slot ? { slot: slot.id } : {}), ...(typed ? { typed: true } : {}) });
  }
  // Same files, same sizes, nothing modified since -> same version.
  return { id: `folder:${folder}`, label: folder, url: '', version: `r3:${files}:${bytes}:${Math.round(newest)}`, chunks, pinned, files, skipped };
}

module.exports = { ingestFolder };
