'use strict';
// Prepared answers: questions the user expects, each with the answer they want to give.
// Kept as a list in one file of the Prepared answers section; parsed from pasted text or documents.
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

const TERMINAL = /[.?!:。？！：]["”')\]]?$/;
const NUMBERED = /^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.):](?:\s+|(?=[A-Z]))(\S.*)$/;
const LIST_ITEM = /^\s*(?:[-*•▪◦·]|\d{1,2}[.)]|[a-z][.)])\s+/i;
const PAGE_MARK = /^\s*(?:\d{1,4}|page\s+\d+(?:\s+of\s+\d+)?|\d+\s*\/\s*\d+)\s*$/i;

// Text taken from a PDF comes with every line cut at the page width. Returns that width (the
// length long lines reach) when the text looks cut that way, otherwise 0.
function wrapWidth(lines) {
  const long = lines.map(l => l.trim()).filter(l => l.length > 40);
  if (long.length < 6) return 0;
  const cut = long.filter(l => !TERMINAL.test(l)).length / long.length;
  if (cut < 0.3) return 0;
  const lengths = long.map(l => l.length).sort((x, y) => x - y);
  return lengths[Math.floor(lengths.length * 0.9)];
}

// Whether the sentence on `line` carries on to `next`: the line was cut at the page width.
// A line set in bold or larger type holds fewer letters, so its length alone does not tell;
// a next line starting in lower case, or a line ending on a word that cannot end a sentence, does.
const DANGLING = /\b(the|a|an|of|to|and|or|in|on|at|for|with|from|by|that|which|is|are|was|were|be|you|your|how|what|when|why|would|could|should|do|does|did|if|as|its|their|our|my|between|into|about)$/i;
function cutMidSentence(line, next, width) {
  const a = line.trim(), b = next.trim();
  if (!a || !b || TERMINAL.test(a)) return false;
  return a.length >= width * 0.8 || /^[a-z(]/.test(b) || DANGLING.test(a);
}

// Lines of one answer back into paragraphs: cut lines are joined, list items and blank
// lines keep their breaks, page numbers go.
function unwrap(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (PAGE_MARK.test(line)) continue;
    if (!line) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    const last = out.length ? out[out.length - 1] : '';
    if (last && !LIST_ITEM.test(line)) out[out.length - 1] = `${last} ${line}`; else out.push(line);
  }
  return out.join('\n');
}

// A line that only titles what follows ("Spark", "Behavioural questions") at the end of an
// answer, just before the next question, is a section heading of the document, not part of
// the answer.
function dropTrailingHeading(body) {
  const kept = [...body];
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  if (kept.length < 2) return kept;
  const last = kept[kept.length - 1].trim();
  let k = kept.length - 2;
  while (k >= 0 && !kept[k].trim()) k--;
  if (k >= 0 && last.length <= 60 && !TERMINAL.test(last) && !LIST_ITEM.test(last) && TERMINAL.test(kept[k].trim()) && /^[A-Z0-9]/.test(last)) kept.pop();
  return kept;
}
const answerText = (body, width) => { const kept = dropTrailingHeading(body); return width ? unwrap(kept) : kept.join('\n'); };

// A numbered list of questions ("1. ...", "2) ...", "Q3. ..."), each followed by its answer.
// The questions are the longest run of lines numbered one after another; numbered steps
// inside an answer restart at 1 and so fall outside it. -> [{q, a}] ([] when there is no such run)
function parseNumbered(lines) {
  const width = wrapWidth(lines);
  const cands = [];
  lines.forEach((line, i) => { const m = NUMBERED.exec(line); if (m) cands.push({ i, n: Number(m[1]), text: m[2].trim() }); });
  const isCand = new Set(cands.map(c => c.i));
  // Longest consecutive run. A line that reads as a question counts for more, which settles
  // whether "3." is the third question or the third step inside an answer: a question asks
  // something, starts a sentence, and is followed by its answer rather than by another number.
  cands.forEach((c, k) => {
    let next = c.i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    c.score = 1 + (/\?/.test(c.text) || (width > 0 && !isCand.has(c.i + 1) && /\?\s*$/.test(lines[c.i + 1] || '')) ? 0.5 : 0)
      + (next < lines.length && !isCand.has(next) ? 0.25 : 0) + (/^[A-Z"“']/.test(c.text) ? 0.1 : 0) - (/[,;]$/.test(c.text) ? 0.3 : 0);
    c.prev = -1;
    let best = 0;
    for (let j = 0; j < k; j++) if (cands[j].n === c.n - 1 && cands[j].score > best) { best = cands[j].score; c.prev = j; }
    c.score += best;
  });
  let end = -1;
  cands.forEach((c, k) => { if (end < 0 || c.score > cands[end].score) end = k; });
  const run = [];
  for (let k = end; k >= 0; k = cands[k].prev) run.unshift(cands[k]);
  if (run.length < 3) return [];

  const pairs = [];
  run.forEach((c, k) => {
    const stop = k + 1 < run.length ? run[k + 1].i : lines.length;
    let q = c.text, at = c.i + 1;
    if (width) {
      // The question itself may be cut over several lines: it runs on while the line reached
      // the page width without finishing its sentence, and takes a closing "...?" line with it.
      while (at < stop && at - c.i <= 4 && cutMidSentence(lines[at - 1], lines[at], width)) { q = `${q} ${lines[at].trim()}`; at++; }
      // "... written to the target." / "How would you recover safely?": the asking part is on the next line.
      if (at < stop && !/\?["”')\]]?$/.test(q) && /\?["”')\]]?$/.test(lines[at].trim()) && lines[at].trim().length < width * 0.9 && !isCand.has(at)) { q = `${q} ${lines[at].trim()}`; at++; }
    }
    pairs.push({ q, a: answerText(lines.slice(at, stop), width) });
  });
  return pairs;
}

// "Q: ... / A: ..." (also "Question 1:", "Answer:").
function parseMarked(lines) {
  if (!(lines.some(l => Q_MARK.test(l)) && lines.some(l => A_MARK.test(l)))) return [];
  const width = wrapWidth(lines), pairs = [];
  let q = null, a = [], inAnswer = false;
  const flush = () => { if (q !== null) pairs.push({ q, a: width ? unwrap(a) : a.join('\n') }); q = null; a = []; };
  for (const line of lines) {
    const mq = Q_MARK.exec(line), ma = !mq && q !== null && A_MARK.exec(line);
    if (mq) { flush(); q = strip(mq[1]); inAnswer = false; }
    else if (ma) { inAnswer = true; a.push(strip(ma[1])); }
    else if (q !== null) { if (inAnswer) a.push(line); else if (line.trim()) q = `${q} ${line.trim()}`.trim(); }
  }
  flush();
  return pairs;
}

// Markdown headings, each with its answer beneath.
function parseHeadings(lines) {
  const pairs = [];
  let q = null, a = [];
  const flush = () => { if (q !== null) pairs.push({ q, a: a.join('\n') }); q = null; a = []; };
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) { flush(); q = strip(m[1]).replace(/^(?:Q(?:uestion)?\s*)?\d{1,3}\s*[.):]\s*/i, ''); } else if (q !== null) a.push(line);
  }
  flush();
  return pairs;
}

// Plain text where each question is a line ending in "?".
function parseQuestionLines(lines) {
  const width = wrapWidth(lines), pairs = [];
  let q = null, a = [];
  const flush = () => { if (q !== null) pairs.push({ q, a: answerText(a, width) }); q = null; a = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isQuestion = /\?["”')\]]?$/.test(line) && line.length <= 400 && (q === null || a.join('').trim() !== '');
    if (!isQuestion) { if (q !== null) a.push(lines[i]); continue; }
    // In text cut at the page width the question may have begun on the lines above.
    let head = '';
    if (width) for (let back = 0; back < 3 && a.length; back++) {
      const above = a[a.length - 1].trim();
      if (!cutMidSentence(above, head || line, width)) break;
      head = `${above} ${head}`.trim(); a.pop();
    }
    flush();
    q = `${head} ${line}`.trim().replace(/^(?:\d{1,3}[.)]|[-*•])\s+/, '');
  }
  flush();
  return pairs;
}

// Reads question-and-answer pairs out of free text, written in any of these ways:
//   "Q: ... / A: ...", markdown headings with the answer beneath, a numbered list of
//   questions with each answer beneath, or each question on a line ending in "?".
// The way that fits is the first of these that finds most of what any of them finds, so a
// lone title or a numbered list inside one answer does not decide how the file is read.
function parseQA(text) {
  const lines = clean(text).split('\n');
  const tries = [parseMarked, parseHeadings, parseNumbered, parseQuestionLines].map(read => normalizePairs(read(lines)));
  const most = Math.max(...tries.map(t => t.length));
  return most ? tries.find(t => t.length >= most * 0.6) : [];
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
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const normalized = (v) => { const n = Math.sqrt(dot(v, v)) || 1; return Array.from(v, x => x / n); };
const norm = (t) => (t.length > 5 && t.endsWith('ly') ? t.slice(0, -2) : t.length > 4 ? t.replace(/e$/, '') : t); // slowly / slow, leave / leaving
const words = (text, opts) => new Set(tokenize(text, opts).map(norm));
function rankPrepared(pairs, asked, askedVec = null) {
  const said = words(asked, { question: true });
  const unit = askedVec && askedVec.length ? normalized(askedVec) : null;
  const docs = pairs.map(p => ({ qt: words(p.q), at: words(p.a) }));
  // A word that appears in many of the prepared questions ("spark", "data") says less about
  // which one is meant than a word that appears in one.
  const df = new Map();
  for (const d of docs) for (const t of d.qt) df.set(t, (df.get(t) || 0) + 1);
  const weight = (t) => Math.log(1 + (pairs.length + 0.5) / ((df.get(t) || 0) + 0.5));
  let saidWeight = 0;
  for (const t of said) if (df.has(t)) saidWeight += weight(t);
  return pairs.map((p, i) => {
    const { qt, at } = docs[i];
    let inQ = 0, inA = 0, hit = 0, total = 0;
    for (const t of qt) total += weight(t);
    for (const t of said) { if (qt.has(t)) { inQ++; hit += weight(t); } if (at.has(t)) inA++; }
    const share = hit ? Math.max(hit / total, hit / saidWeight) : 0;
    const worded = share + 0.15 * (inA / Math.max(1, said.size));
    // By meaning, when both sides have been embedded: a question asked in other words
    // ("where do you look when a job crawls?") still lands on the prepared one.
    const { vec, ...pair } = p;
    const alike = unit && vec && vec.length === unit.length ? Math.max(0, dot(unit, vec)) : null;
    const score = alike === null ? worded : 0.7 * alike + 0.3 * Math.min(1, worded);
    return { ...pair, i, score, match: (inQ >= (qt.size >= 4 ? 2 : 1) && share >= 0.5) || (alike !== null && alike >= 0.55) };
  }).sort((x, y) => (y.match ? 1 : 0) - (x.match ? 1 : 0) || y.score - x.score || x.i - y.i).map(({ i, ...p }) => p);
}

module.exports = { QA_FILE, normalizePairs, parseQA, parseQATable, rankPrepared };
