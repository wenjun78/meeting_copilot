'use strict';
const fs = require('fs');
const path = require('path');

// The sections of what a user gives the app. Each is a folder among the app's own files:
// the text typed into the section is saved as NOTE, files added to it sit beside that.
// About me, CV, JD, Instructions and Questions to ask are sent to the model with every answer.
// Prepared answers holds replies to expected questions, offered when a question comes up. Publications are
// searched by section, with each paper's title and abstract sent every time. Portfolio is searched.
const SLOTS = [
  { id: 'about', dir: 'about-me', label: 'About me', title: 'About me' },
  { id: 'cv', dir: 'cv', label: 'CV', title: 'CV' },
  { id: 'jd', dir: 'jd', label: 'JD', title: 'Job description' },
  { id: 'instructions', dir: 'instructions', label: 'Instructions', title: 'Instructions for this meeting' },
  { id: 'qa', dir: 'qa', label: 'Prepared answers', title: 'Prepared answers', qa: true },
  { id: 'ask', dir: 'questions-to-ask', label: 'Questions to ask', title: 'Questions I want to ask the other side' },
  { id: 'publications', dir: 'publications', label: 'Publications', title: 'Publication', papers: true },
  { id: 'portfolio', dir: 'portfolio', label: 'Portfolio', title: 'Portfolio', searched: true },
];
const NOTE = '_note.md';
const slotById = (id) => SLOTS.find(s => s.id === id) || null;
const slotByDir = (dir) => SLOTS.find(s => s.dir === dir) || null;

// How much of each always-sent note fits. Notes are taken in section order (About me, CV,
// JD, Instructions, then pinned files from other sources), each cut to `perNote`, until
// `total` characters are used. -> the same notes with `sent` (characters that go out).
// The notes open every request in the same order, so a service that keeps a prefix it has
// seen reads them once and reuses them: the budget can be generous without slowing answers.
function planPinned(notes, { total = 40000, perNote = 16000 } = {}) {
  const order = (n) => { const i = SLOTS.findIndex(s => s.id === n.slot); return i < 0 ? SLOTS.length : i; };
  let room = total;
  // Within a section, what the user typed comes before the files they added.
  return [...notes].sort((a, b) => order(a) - order(b) || (b.typed ? 1 : 0) - (a.typed ? 1 : 0)).map((n) => {
    const sent = Math.max(0, Math.min(n.text.length, perNote, room));
    room -= sent;
    return { ...n, sent };
  });
}

// Papers that were added to Portfolio before there was a Publications section are moved to it,
// once: the Publications folder existing means this has been done.
// isPaper(fullPath) -> Promise<boolean>. -> names of the files moved.
async function movePapersToPublications(notesDir, isPaper) {
  const from = path.join(notesDir, slotById('portfolio').dir), to = path.join(notesDir, slotById('publications').dir);
  if (fs.existsSync(to)) return [];
  let names = [];
  try { names = fs.readdirSync(from, { withFileTypes: true }).filter(e => e.isFile() && /\.(pdf|docx)$/i.test(e.name)).map(e => e.name); } catch { /* no Portfolio files */ }
  if (!fs.existsSync(notesDir)) return [];
  fs.mkdirSync(to, { recursive: true });
  const moved = [];
  for (const name of names) {
    let paper = false;
    try { paper = await isPaper(path.join(from, name)); } catch { /* unreadable: stays where it is */ }
    if (!paper) continue;
    fs.renameSync(path.join(from, name), path.join(to, name));
    moved.push(name);
  }
  return moved;
}

// Earlier versions kept notes loose in one folder and decided their use by name. Each loose
// file is moved into the section its name points to; anything else becomes a Portfolio file.
// A note that was exactly "About me", "CV", "JD" or "Instructions" becomes that section's text.
function moveLooseFilesIntoSections(notesDir) {
  let entries;
  try { entries = fs.readdirSync(notesDir, { withFileTypes: true }); } catch { return []; }
  const moved = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const stem = e.name.replace(/\.[^.]+$/, '');
    const word = (re) => new RegExp(`(^|[\\s_.()\\[\\]-])(${re})($|[\\s_.()\\[\\]-])`, 'i').test(stem);
    let slot;
    if (word('about[\\s_-]?me|bio')) slot = slotById('about');
    else if (word('cv|resume|résumé|curriculum[\\s_-]?vitae')) slot = slotById('cv');
    else if (word('jd|job[\\s_-]?descriptions?|meeting[\\s_-]?brief|agenda|brief(ing)?')) slot = slotById('jd');
    else if (word('instructions?')) slot = slotById('instructions');
    else {
      // A note the user had ticked "send with every answer" keeps doing so, as an instruction.
      let head = '';
      try { head = fs.readFileSync(path.join(notesDir, e.name), 'utf8').slice(0, 200); } catch { /* binary or unreadable */ }
      slot = /^﻿?---\r?\n[\s\S]*?pinned:\s*(true|yes|1)/i.test(head) ? slotById('instructions') : slotById('portfolio');
    }
    const dir = path.join(notesDir, slot.dir);
    fs.mkdirSync(dir, { recursive: true });
    const isTheNote = /\.(md|txt)$/i.test(e.name) && /^(about[\s_-]?me|cv|jd|job[\s_-]?description|instructions)$/i.test(stem) && !fs.existsSync(path.join(dir, NOTE));
    let target = path.join(dir, isTheNote ? NOTE : e.name);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, e.name.replace(/(\.[^.]+)?$/, ` ${n}$1`));
    fs.renameSync(path.join(notesDir, e.name), target);
    moved.push(`${e.name} -> ${slot.dir}/${path.basename(target)}`);
  }
  return moved;
}

module.exports = { SLOTS, NOTE, slotById, slotByDir, planPinned, moveLooseFilesIntoSections, movePapersToPublications };
