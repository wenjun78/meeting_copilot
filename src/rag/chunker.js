'use strict';
// Turns a file into retrieval-sized chunks. Markdown/prose splits on headings
// and paragraphs; code splits on line windows; notebooks are flattened first.

const PROSE_EXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'org', 'html', 'htm', 'pdf', 'docx', '']);
const CODE_EXT = new Set(['py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'cs', 'c', 'h',
  'cpp', 'hpp', 'swift', 'scala', 'r', 'sql', 'sh', 'bash', 'ps1', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'json', 'tf',
  'dockerfile', 'gradle', 'xml', 'css', 'scss', 'vue', 'svelte', 'ipynb', 'csv', 'tsv']);
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|venv|\.venv|env|__pycache__|\.next|\.cache|coverage|\.idea|\.vscode|site-packages|\.ipynb_checkpoints)(\/|$)/;
// Files that tend to hold credentials are never indexed or sent to a model.
const SECRET_FILE = /(^|\/)(\.[^/]*|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*(credentials?|secrets?|passwords?|passwd)[^/]*\.(json|ya?ml|toml|ini|cfg|conf|txt|csv|xml|properties)|[^/]*\.(pem|key|pfx|p12|jks|keystore|tfvars|tfstate|kdbx))$/i;
const PLAIN_NAMES = /^(readme|license|licence|changelog|changes|notes|todo|authors|contributing|history|install|usage|faq)$/i;
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|.*\.min\.(js|css)|.*\.map)$/;

function extOf(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return base;
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1);
}

function isIndexable(path, size = 0, maxBytes = 400_000) {
  if (SKIP_DIR.test(path) || SKIP_FILE.test(path) || SECRET_FILE.test(path)) return false;
  const ext = extOf(path);
  if (ext === '' && !PLAIN_NAMES.test(path.split('/').pop())) return false;
  if (!(PROSE_EXT.has(ext) || CODE_EXT.has(ext) || ext === 'makefile')) return false;
  if (ext === 'ipynb') return size <= 8_000_000; // outputs are stripped, so allow big notebooks
  if (ext === 'pdf' || ext === 'docx') return size <= 25_000_000; // text is extracted, so the file size says little
  // Exported reports (R Markdown, Jupyter) embed their charts as images: tens of MB of file, a few pages of text.
  if (ext === 'html' || ext === 'htm') return size <= 40_000_000;
  if ((ext === 'json' || ext === 'csv' || ext === 'tsv' || ext === 'xml') && size > 60_000) return false;
  return size <= maxBytes;
}

function notebookToText(raw) {
  let nb;
  try { nb = JSON.parse(raw); } catch { return ''; }
  const cells = nb.cells || (nb.worksheets && nb.worksheets[0] && nb.worksheets[0].cells) || [];
  const parts = [];
  for (const c of cells) {
    const src = Array.isArray(c.source) ? c.source.join('') : (c.source || c.input || '');
    if (!String(src).trim()) continue;
    parts.push(c.cell_type === 'markdown' ? String(src) : '```\n' + src + '\n```');
  }
  return parts.join('\n\n');
}

function htmlToText(html) {
  return html
    .replace(/\r/g, '')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    // A heading becomes one "#" line, even when the markup wraps it over several lines.
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => '\n' + '#'.repeat(+n) + ' ' + inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() + '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function splitLong(text, max, overlap) {
  if (text.length <= max) return [text];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + max);
    if (end < text.length) {
      const window = text.slice(i, end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (cut > max * 0.5) end = i + cut + 1;
    }
    out.push(text.slice(i, end).trim());
    if (end >= text.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out.filter(Boolean);
}

function chunkProse(text, { max = 1100, overlap = 150 } = {}) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let heads = [], buf = [], inFence = false;
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ heading: heads.filter(Boolean).join(' > '), body });
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      heads = heads.slice(0, level - 1);
      heads[level - 1] = m[2];
    } else buf.push(line);
  }
  flush();
  // Merge tiny neighbouring sections so a chunk carries enough context.
  const chunks = [];
  for (const s of sections) {
    const last = chunks[chunks.length - 1];
    if (last && last.body.length + s.body.length < max * 0.6 && last.heading.split(' > ')[0] === s.heading.split(' > ')[0]) {
      last.body += `\n\n${s.heading.split(' > ').pop()}\n${s.body}`;
    } else chunks.push({ ...s });
  }
  const out = [];
  for (const c of chunks) for (const piece of splitLong(c.body, max, overlap)) out.push({ heading: c.heading, text: piece });
  return out;
}

function chunkCode(text, { maxLines = 70, overlapLines = 10, maxChars = 2400 } = {}) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let end = Math.min(lines.length, i + maxLines);
    // Prefer to break just before a top-level definition.
    for (let j = end; j > i + maxLines * 0.6 && j < lines.length; j--) {
      if (/^(def |class |async def |function |export |public |private |func |fn |CREATE |-- |# %%|@)/.test(lines[j])) { end = j; break; }
    }
    // Long lines: shorten the window until it fits, so nothing between windows is skipped.
    let body = lines.slice(i, end).join('\n');
    while (body.length > maxChars && end > i + 1) {
      end = i + Math.max(1, Math.floor((end - i) * maxChars / body.length * 0.95));
      body = lines.slice(i, end).join('\n');
    }
    if (body.length > maxChars) body = body.slice(0, maxChars); // a single enormous line
    if (body.trim()) out.push({ heading: `lines ${i + 1}-${end}`, text: body, line: i + 1 });
    if (end >= lines.length) break;
    i = Math.max(end - Math.min(overlapLines, Math.floor((end - i) / 3)), i + 1);
  }
  return out;
}

// A leading "---" block of "key: value" lines, as used for notes in Markdown files.
function frontMatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

// A note is pinned (sent to the model with every answer, not only when a search finds it)
// when its front matter says "pinned: true" or its file name contains one of these as a
// whole word: jd, job description, instructions, agenda, brief ("JD - Data Engineer.pdf").
const PINNED_NAME = /(^|[\s_.()\[\]-])(jd|job[\s_-]?descriptions?|instructions?|agenda|brief(ing)?)($|[\s_.()\[\]-])/i;

// -> { chunks: [{title, text, line?}], pinned: null | {title, text} }
function readNote(path, raw) {
  const ext = extOf(path);
  const name = path.split('/').pop();
  let text = raw;
  let prose = PROSE_EXT.has(ext);
  let meta = {};
  if (ext === 'ipynb') { text = notebookToText(raw); prose = true; }
  else if (ext === 'html' || ext === 'htm') text = htmlToText(raw).slice(0, 400000);
  else if (prose) ({ meta, body: text } = frontMatter(String(raw || '')));
  if (!text || !text.trim()) return { chunks: [], pinned: null };
  const pieces = prose ? chunkProse(text) : chunkCode(text);
  const chunks = pieces.map(p => ({ title: p.heading ? `${name} — ${p.heading}` : name, text: p.text, line: p.line }));
  const stem = name.replace(/\.[^.]+$/, '');
  const pin = prose && (/^(true|yes|1)$/i.test(meta.pinned || '') || PINNED_NAME.test(stem));
  return { chunks, pinned: pin ? { title: meta.title || name, text: text.trim().slice(0, 6000) } : null };
}

const chunkFile = (path, raw) => readNote(path, raw).chunks;

module.exports = { chunkFile, readNote, frontMatter, chunkProse, chunkCode, isIndexable, htmlToText, notebookToText, extOf };
