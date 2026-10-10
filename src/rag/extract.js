'use strict';
// Turns a file's bytes into text: PDF and Word documents are parsed, everything
// else is read as UTF-8. Returns '' for anything that is not readable text.

function extOf(path) {
  const base = String(path).split('/').pop().toLowerCase();
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1);
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function pdfText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map(page => page.trim()).filter(Boolean).join('\n\n');
}

async function docxText(buf) {
  const { value } = await require('mammoth').extractRawText({ buffer: Buffer.from(buf) });
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

async function extractText(path, buf) {
  const ext = extOf(path);
  try {
    if (ext === 'pdf') return await pdfText(buf);
    if (ext === 'docx') return await docxText(buf);
  } catch {
    return ''; // encrypted, scanned-image or damaged document
  }
  return looksBinary(buf) ? '' : Buffer.from(buf).toString('utf8');
}

module.exports = { extractText };
