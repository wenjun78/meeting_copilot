'use strict';
const crypto = require('crypto');
const { chunkFile, readNote, chunkProse, htmlToText } = require('./chunker');
const { extractDoc } = require('./extract');

const TEXT_KEYS = ['text', 'content', 'body', 'answer', 'snippet', 'description', 'summary', 'markdown', 'page_content', 'chunk'];
const TITLE_KEYS = ['title', 'name', 'question', 'heading', 'subject', 'id', 'key'];
const URL_KEYS = ['url', 'link', 'html_url', 'source', 'href'];
const LIST_KEYS = ['results', 'data', 'items', 'documents', 'docs', 'hits', 'matches', 'records', 'chunks', 'entries', 'value'];

const pick = (o, keys) => { for (const k of keys) if (o[k] != null && typeof o[k] !== 'object') return String(o[k]); return ''; };

// Finds the list of records in an arbitrary JSON response and normalises each to {title,text,url}.
function itemsFromJson(json) {
  let list = null;
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === 'object') {
    for (const k of LIST_KEYS) if (Array.isArray(json[k])) { list = json[k]; break; }
    if (!list && json.hits && Array.isArray(json.hits.hits)) list = json.hits.hits; // Elasticsearch
    if (!list) list = [json];
  } else if (json != null) list = [String(json)];
  const out = [];
  for (let item of list || []) {
    if (item == null) continue;
    if (typeof item !== 'object') { out.push({ title: '', text: String(item), url: '' }); continue; }
    for (const wrap of ['_source', 'document', 'metadata', 'payload', 'fields']) {
      if (item[wrap] && typeof item[wrap] === 'object' && !Array.isArray(item[wrap])) item = { ...item[wrap], ...item };
    }
    let text = pick(item, TEXT_KEYS);
    const title = pick(item, TITLE_KEYS);
    if (!text) {
      // No obvious text field: flatten scalar fields as "key: value" lines.
      text = Object.entries(item).filter(([, v]) => v != null && typeof v !== 'object' && String(v).length)
        .map(([k, v]) => `${k}: ${v}`).join('\n');
    } else if (item.question && item.answer) text = `Q: ${item.question}\nA: ${item.answer}`;
    if (text.trim()) out.push({ title, text, url: pick(item, URL_KEYS) });
  }
  return out;
}

function buildHeaders({ headerName, headerValue } = {}) {
  const h = { Accept: 'application/json, text/plain, */*', 'User-Agent': 'meeting-copilot' };
  if (headerName && headerValue) h[headerName] = headerValue;
  return h;
}

async function getBody(fetchFn, url, auth, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers: buildHeaders(auth), signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const bytes = Buffer.from(await res.arrayBuffer());
    return { type, bytes, body: bytes.toString('utf8') };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message);
  } finally { clearTimeout(timer); }
}

function parseBody(type, body) {
  const trimmed = body.trim();
  if (type.includes('json') || /^[[{]/.test(trimmed)) {
    try { return { json: JSON.parse(trimmed) }; } catch { /* fall through to text */ }
  }
  return { text: type.includes('html') || /^<!doctype html|^<html/i.test(trimmed) ? htmlToText(body) : body };
}

// Download a document or JSON collection once and chunk it for the index.
async function ingestUrl(url, { auth, fetchFn = fetch, timeoutMs = 30000 } = {}) {
  const { type, bytes, body } = await getBody(fetchFn, url, auth, timeoutMs);
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const version = crypto.createHash('sha1').update(bytes).digest('hex');
  const chunks = [];
  // A PDF or Word document behind the URL (a hosted CV, a spec) is read as a document.
  const docKind = type.includes('pdf') || /\.pdf($|[?#])/i.test(url) ? 'pdf' : type.includes('wordprocessingml') || /\.docx($|[?#])/i.test(url) ? 'docx' : '';
  if (docKind) {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || host).replace(/\.(pdf|docx)$/i, '') + '.' + docKind;
    const doc = await extractDoc(name, bytes);
    for (const c of readNote(name, doc.text, { name: doc.name, pin: false }).chunks) chunks.push({ path: host, url, title: c.title, text: c.text });
    return { id: `api:${url}`, label: url.replace(/^https?:\/\//, ''), url, version, chunks, files: 1, skipped: 0 };
  }
  const parsed = parseBody(type, body);
  if (parsed.json !== undefined) {
    for (const [i, it] of itemsFromJson(parsed.json).entries()) {
      const title = it.title || `${host} #${i + 1}`;
      for (const c of chunkProse(it.text)) chunks.push({ path: host, url: it.url || url, title: c.heading ? `${title} — ${c.heading}` : title, text: c.text });
    }
  } else {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || host);
    for (const c of chunkFile(/\.\w+$/.test(name) ? name : name + '.md', parsed.text)) chunks.push({ path: host, url, title: c.title, text: c.text });
  }
  return { id: `api:${url}`, label: url.replace(/^https?:\/\//, ''), url, version, chunks, files: 1, skipped: 0 };
}

// Query a search endpoint at answer time. `template` contains {query}.
async function liveSearch(template, query, { auth, fetchFn = fetch, timeoutMs = 2500, max = 4 } = {}) {
  if (!template) return [];
  const url = template.includes('{query}') ? template.replace(/\{query\}/g, encodeURIComponent(query))
    : template + (template.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(query);
  const { type, body } = await getBody(fetchFn, url, auth, timeoutMs);
  const parsed = parseBody(type, body);
  const items = parsed.json !== undefined ? itemsFromJson(parsed.json) : [{ title: '', text: parsed.text, url }];
  const host = new URL(url).host;
  return items.slice(0, max).map((it, i) => ({
    sourceId: 'live-api', path: host, url: it.url || '', title: it.title || `${host} result ${i + 1}`, text: it.text.slice(0, 1600),
  }));
}

module.exports = { ingestUrl, liveSearch, itemsFromJson };
