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

// -> { text, title } ; title is the document's own title when its properties carry one
async function pdfDoc(buf) {
  const { extractText: pages, getDocumentProxy, getMeta } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await pages(pdf, { mergePages: false });
  let title = '';
  try { title = String(((await getMeta(pdf)).info || {}).Title || '').trim(); } catch { /* no properties */ }
  return { text: text.map(page => page.trim()).filter(Boolean).join('\n\n'), title };
}

async function docxText(buf) {
  const { value } = await require('mammoth').extractRawText({ buffer: Buffer.from(buf) });
  return value.replace(/\n{3,}/g, '\n\n').trim();
}

// A name for a document that says what it is. Files are often called something meaningless
// ("5f6f95d7-....pdf", "download (3).pdf"), so the document's own title is used when there
// is one, and a research paper is labelled as a publication so questions about "my paper"
// or "my publication" find it.
function describe(fileName, text, metaTitle = '') {
  const head = text.slice(0, 4000);
  let title = metaTitle.replace(/\s+/g, ' ').trim();
  if (title.length < 8 || /^\W*(untitled|anonymous|unspecified|unknown|microsoft word|document\d*|slide \d+)/i.test(title) || /\.(pdf|docx?|tex|indd)$/i.test(title)) title = '';
  const paper = /\babstract\b/i.test(head) && /\breferences\b|\bbibliography\b/i.test(text) && /doi|journal|proceedings|arxiv|springer|elsevier|ieee|©/i.test(head);
  if (!title && paper) {
    // No title in the properties: take the lines between the journal banner and the authors/abstract.
    const lines = head.split('\n').map(l => l.trim()).filter(Boolean);
    const stop = lines.findIndex(l => /^abstract\b/i.test(l));
    const cand = lines.slice(0, stop > 0 ? stop : 8).filter(l => l.split(/\s+/).length >= 2 && !/^(original (paper|article)|research article|review|open access)$/i.test(l) && !/journal|proceedings|©|https?:|doi/i.test(l));
    title = cand.slice(0, -1).join(' ').slice(0, 160) || (cand[0] || '');
  }
  if (!title) return fileName;
  return `${paper ? 'Publication (research paper): ' : ''}${title} (${fileName})`;
}

// -> { text, name } ; text is '' for anything that is not readable (scanned, protected, binary)
async function extractDoc(path, buf) {
  const ext = extOf(path);
  const fileName = String(path).split('/').pop();
  try {
    if (ext === 'pdf') { const d = await pdfDoc(buf); return { text: d.text, name: d.text.trim() ? describe(fileName, d.text, d.title) : fileName }; }
    if (ext === 'docx') { const text = await docxText(buf); return { text, name: describe(fileName, text) }; }
  } catch {
    return { text: '', name: fileName }; // encrypted, scanned-image or damaged document
  }
  return { text: looksBinary(buf) ? '' : Buffer.from(buf).toString('utf8'), name: fileName };
}

const extractText = async (path, buf) => (await extractDoc(path, buf)).text;

module.exports = { extractText, extractDoc, describe };
