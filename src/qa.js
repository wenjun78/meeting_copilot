'use strict';
// Prepared answers: questions the user expects, each with the answer they want to give.
// Kept as a list in one file of the Q&A section; parsed from pasted text or documents.
const { tokenize } = require('./rag/tokenize');

const QA_FILE = '_qa.json';
const clean = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const oneLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ');

// -> [{q, a}] : trimmed, without empty or repeated questions (a repeat replaces the earlier one
// where it stood), within limits.
function normalizePairs(list) {
  const byQuestion = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    const q = oneLine(p && p.q).replace(/^#+\s*/, '').slice(0, 400), a = clean(p && p.a).slice(0, 4000);
    if (!q || !a) continue;
    const key = q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    byQuestion.set(key, { q, a });
  }
  return [...byQuestion.values()].slice(0, 300);
}

const Q_MARK = /^\s*(?:[-*]\s+)?(?:\*\*|__)?\s*Q(?:uestion)?\s*\d{0,3}\s*[:.)]\s*(?:\*\*|__)?\s*(.*)$/i;
const A_MARK = /^\s*(?:[-*]\s+)?(?:\*\*|__)?\s*A(?:ns(?:wer)?)?\s*\d{0,3}\s*[:)]\s*(?:\*\*|__)?\s*(.*)$/i;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const strip = (s) => s.replace(/(\*\*|__)\s*$/, '').replace(/^(\*\*|__)/, '').trim();

// Reads question-and-answer pairs out of free text. Understands, in this order:
//   "Q: ... / A: ..." (also "Question 1:", "Answer:"), markdown headings with the answer
//   beneath, and plain text where each question is a line ending in "?".
function parseQA(text) {
  const lines = clean(text).split('\n');
  const pairs = [];
  let q = null, a = [];
  const flush = () => { if (q !== null) pairs.push({ q, a: a.join('\n') }); q = null; a = []; };

  if (lines.some(l => Q_MARK.test(l)) && lines.some(l => A_MARK.test(l))) {
    let inAnswer = false;
    for (const line of lines) {
      const mq = Q_MARK.exec(line), ma = !mq && q !== null && A_MARK.exec(line);
      if (mq) { flush(); q = strip(mq[1]); inAnswer = false; }
      else if (ma) { inAnswer = true; a.push(strip(ma[1])); }
      else if (q !== null) { if (inAnswer) a.push(line); else if (line.trim()) q = `${q} ${line.trim()}`.trim(); }
    }
  } else if (lines.some(l => HEADING.test(l))) {
    for (const line of lines) {
      const m = HEADING.exec(line);
      if (m) { flush(); q = m[1]; } else if (q !== null) a.push(line);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const isQuestion = /\?["”')\]]?$/.test(line) && line.length <= 400 && (q === null || a.join('').trim() !== '');
      if (isQuestion) { flush(); q = line.replace(/^(?:\d{1,3}[.)]|[-*•])\s+/, ''); }
      else if (q !== null) a.push(lines[i]);
    }
  }
  flush();
  return normalizePairs(pairs);
}

// A table saved as CSV or TSV: the first column is the question, the second the answer (a
// header row naming them is skipped; with named columns, those named question and answer are used).
function parseQATable(text) {
  const src = clean(text);
  const delim = (src.split('\n')[0].match(/\t/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  let qi = 0, ai = 1, start = 0;
  const head = (rows[0] || []).map(c => c.trim().toLowerCase());
  const hq = head.findIndex(c => /^(questions?|q)$/.test(c)), ha = head.findIndex(c => /^(answers?|a|my answer|response|reply)$/.test(c));
  if (hq >= 0 && ha >= 0) { qi = hq; ai = ha; start = 1; }
  return normalizePairs(rows.slice(start).map(r => ({ q: r[qi], a: r[ai] })));
}

// Orders prepared answers by how close their question is to what was asked. The wording of a
// spoken question rarely repeats the prepared one, so this only decides the order (and which
// to name as used); the model is shown the answers and judges which one fits.
// -> [{q, a, score, match}] ; match: the questions share their main words.
const norm = (t) => (t.length > 4 ? t.replace(/e$/, '') : t); // leave / leaving, manage / managing
const words = (text, opts) => new Set(tokenize(text, opts).map(norm));
function rankPrepared(pairs, asked) {
  const said = words(asked, { question: true });
  return pairs.map((p, i) => {
    const qt = words(p.q), at = words(p.a);
    let inQ = 0, inA = 0;
    for (const t of said) { if (qt.has(t)) inQ++; if (at.has(t)) inA++; }
    const share = inQ / Math.max(1, Math.min(qt.size, said.size));
    const score = share + 0.15 * (inA / Math.max(1, said.size));
    return { ...p, i, score, match: inQ >= (qt.size >= 4 ? 2 : 1) && share >= 0.5 };
  }).sort((x, y) => (y.match ? 1 : 0) - (x.match ? 1 : 0) || y.score - x.score || x.i - y.i).map(({ i, ...p }) => p);
}

module.exports = { QA_FILE, normalizePairs, parseQA, parseQATable, rankPrepared };
