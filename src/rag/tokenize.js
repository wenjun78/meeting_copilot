'use strict';
// Tokeniser shared by indexing and querying. Splits camelCase / snake_case so
// spoken words ("customer master") match identifiers ("customerMaster"),
// and emits CJK characters as unigrams + bigrams.

const STOP = new Set(('a an the and or but if then else of to in on at by for with from as is are was were be been being ' +
  'it its this that these those i you he she we they me my your our their them us do does did done have has had ' +
  'can could would should will shall may might must not no yes so than too very just about into over under again ' +
  'what which who whom when where why how there here am also any all some such only own same both each more most ' +
  'other up down out off once tell walk through talk explain describe please thanks thank okay ok um uh like know ' +
  'think mean kind sort really actually basically going get got').split(' '));

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

function stem(w) {
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es') && /(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

// Words used interchangeably in questions and documents are indexed as one.
const SAME = { methodology: 'method', methodologies: 'method', methodological: 'method', finding: 'result', outcome: 'result',
  publish: 'publication', paper: 'publication', article: 'publication', resume: 'cv', limitation: 'limit', weaknes: 'limit', conclusion: 'conclude' };

// Words in a question that also ask for another word. Only for questions: a document that
// says "our approach" is not thereby a Methods section.
const ASKS = { approach: 'method', technique: 'method', algorithm: 'method', achieve: 'result', accuracy: 'result', performance: 'result' };

function tokenize(text, { question = false } = {}) {
  const out = [];
  if (!text) return out;
  const parts = String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u);
  for (const raw of parts) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      const chars = Array.from(raw);
      for (let i = 0; i < chars.length; i++) {
        out.push(chars[i]);
        if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
      }
      continue;
    }
    const w = raw.toLowerCase();
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOP.has(w)) continue;
    const t = stem(w);
    out.push(SAME[t] || t);
    if (question && ASKS[t]) out.push(ASKS[t]);
  }
  return out;
}

module.exports = { tokenize, STOP };
