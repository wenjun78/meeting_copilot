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
  const paper = isPaper(text);
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

// PDF and Word text arrives without structure. Lines that are section headings of a paper,
// report or CV ("Methods", "2.1 Data analysis", "Work experience") are marked as headings, so
// each section becomes its own passage and carries its name: a question about "methodology"
// then finds the Methods section rather than whichever paragraph repeats the word.
const SECTION = new RegExp('^(?:(?:\\d{1,2}(?:\\.\\d{1,2}){0,2}|[IVX]{1,4})[.)]?\\s+)?(' + [
  'abstract', 'summary', 'executive summary', 'introduction', 'background', 'literature review', 'related work', 'theoretical framework',
  'objectives?', 'research questions?', 'hypothes[ie]s', 'methods?', 'methodology', 'research methodology', 'research methods?', 'proposed (?:method|methodology|approach|framework|model|system)', 'materials? and methods', 'research design', 'study design',
  'data', 'dataset', 'data collection', 'data sources?', 'participants', 'sample', 'measures', 'instruments?', 'procedure', 'variables',
  'data analysis', 'statistical analysis', 'analysis', 'model', 'models?', 'modell?ing', 'model development', 'model evaluation', 'evaluation', 'experiments?', 'experimental setup',
  'data pre-?processing', 'pre-?processing', 'feature engineering', 'feature selection', 'implementation', 'system (?:design|architecture)', 'architecture',
  'explainability', 'interpretability', 'results?', 'findings', 'experimental results', 'results? and (?:discussion|analysis)', 'discussion', 'limitations?', 'strengths? and limitations',
  'implications', 'recommendations', 'future work', 'conclusions?', 'conclusions? and future work', 'concluding remarks', 'acknowledge?ments?', 'funding', 'declarations?', 'appendix(?: [a-z0-9])?',
  'references', 'bibliography', 'works cited',
  'profile', 'professional summary', 'experience', 'work experience', 'professional experience', 'employment(?: history)?', 'education', 'skills', 'technical skills',
  'certifications?', 'publications?', 'projects?', 'awards?', 'languages',
].join('|') + ')\\s*:?$', 'i');

// Headings that are parts of a Methods section when they follow one ("Methods" then "Data",
// "Model"): kept beneath it, so those passages are still known as the method of the paper.
const METHODS = /^(methods?|methodology|research methodology|research methods?|proposed (?:method|methodology|approach|framework|model|system)|materials? and methods|research design|study design|experimental setup)$/i;
const METHOD_PART = /^(data|dataset|data collection|data sources?|participants|sample|measures|instruments?|procedure|variables|data analysis|statistical analysis|analysis|models?|modell?ing|model development|model evaluation|evaluation|experiments?|data pre-?processing|pre-?processing|feature engineering|feature selection|implementation|explainability|interpretability)$/i;

// In a paper, a short numbered line after the abstract ("3.2 Feature engineering") is a heading
// whatever it is called.
const NUMBERED = /^\d{1,2}(?:\.\d{1,2}){0,2}[.)]?\s+[A-Z][A-Za-z,&:/\- ]{2,58}$/;

function sectionize(text, paper) {
  if (/^#{1,6}\s/m.test(text)) return text; // already has headings
  const lines = text.split('\n');
  let cutAt = -1, inMethods = false, started = false;
  const out = lines.map((line, i) => {
    const t = line.trim();
    const known = t.length <= 48 && SECTION.test(t);
    if (!known && !(paper && started && NUMBERED.test(t) && t.split(/\s+/).length <= 9)) return line;
    started = true;
    const name = t.replace(/\s*:$/, '');
    const num = /^\d{1,2}((?:\.\d{1,2}){0,2})[.)]?\s+/.exec(name);
    const bare = name.replace(/^(?:\d{1,2}(?:\.\d{1,2}){0,2}|[IVX]{1,4})[.)]?\s+/, '');
    // The reference list is other people's work and full of matching keywords: left out for papers.
    if (paper && i > lines.length * 0.5 && /^(references|bibliography|works cited)$/i.test(bare)) cutAt = cutAt < 0 ? i : cutAt;
    // Depth from the numbering ("3.1" sits under "3"); without numbers, the usual parts of a
    // Methods section sit under it.
    let level = num ? 2 + (num[1].match(/\./g) || []).length : 2;
    if (level === 2 && inMethods && METHOD_PART.test(bare) && !(num && num[1] === '')) level = 3;
    if (level === 2) inMethods = METHODS.test(bare);
    return `\n${'#'.repeat(level)} ${name}\n`;
  });
  return (cutAt >= 0 ? out.slice(0, cutAt) : out).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const isPaper = (text) => {
  const head = text.slice(0, 4000);
  return /\babstract\b/i.test(head) && /\breferences\b|\bbibliography\b/i.test(text) && /doi|journal|proceedings|arxiv|springer|elsevier|ieee|©/i.test(head);
};

// -> { text, name } ; text is '' for anything that is not readable (scanned, protected, binary)
async function extractDoc(path, buf) {
  const ext = extOf(path);
  const fileName = String(path).split('/').pop();
  try {
    if (ext === 'pdf') { const d = await pdfDoc(buf); return { text: sectionize(d.text, isPaper(d.text)), name: d.text.trim() ? describe(fileName, d.text, d.title) : fileName }; }
    if (ext === 'docx') { const text = await docxText(buf); return { text: sectionize(text, isPaper(text)), name: describe(fileName, text) }; }
  } catch {
    return { text: '', name: fileName }; // encrypted, scanned-image or damaged document
  }
  return { text: looksBinary(buf) ? '' : Buffer.from(buf).toString('utf8'), name: fileName };
}

const extractText = async (path, buf) => (await extractDoc(path, buf)).text;

module.exports = { extractText, extractDoc, describe, sectionize };
