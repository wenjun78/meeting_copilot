'use strict';
const { readTarGz } = require('./tar');
const { readNote, isIndexable } = require('./chunker');
const { extractText } = require('./extract');

// Accepts "owner", "owner/repo", "owner/repo@ref", "owner/repo/sub/dir", a github.com URL or a GitHub Pages address.
function parseRepoSpec(spec) {
  let s = String(spec || '').trim();
  if (!s) throw new Error('Enter a repository as owner/repo');
  let ref = '', subdir = '';
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)(?:\/([^/\s#?]+))?(?:\/(?:tree|blob)\/([^/\s#?]+)(?:\/([^#?\s]*))?)?/i.exec(s);
  if (url) {
    return { owner: url[1], repo: (url[2] || '').replace(/\.git$/, ''), ref: url[3] || '', subdir: (url[4] || '').replace(/\/+$/, '') };
  }
  // A GitHub Pages address is served from a repository: user.github.io/repo/ -> user/repo,
  // and the bare user.github.io -> user/user.github.io.
  const pages = /^https?:\/\/([\w-]+)\.github\.io(?:\/([^/\s#?]+))?/i.exec(s);
  if (pages) {
    const first = pages[2] && !/\.\w{2,5}$/.test(pages[2]) ? pages[2] : '';
    return { owner: pages[1], repo: first || `${pages[1]}.github.io`, ref: '', subdir: '' };
  }
  const at = s.indexOf('@');
  if (at > 0) { ref = s.slice(at + 1).trim(); s = s.slice(0, at); }
  const parts = s.split('/').filter(Boolean);
  if (!/^[\w.-]+$/.test(parts[0] || '')) throw new Error(`"${spec}" is not a GitHub owner/repo`);
  if (parts.length > 2) subdir = parts.slice(2).join('/');
  return { owner: parts[0], repo: (parts[1] || '').replace(/\.git$/, ''), ref, subdir };
}

function specId({ owner, repo, ref, subdir }) {
  return `github:${owner}/${repo}${subdir ? '/' + subdir : ''}${ref ? '@' + ref : ''}`;
}

async function gh(fetchFn, url, token, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept, 'User-Agent': 'meeting-copilot', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchFn(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* not json */ }
    if (res.status === 404) throw new Error(`GitHub: not found (${url.replace(/^https?:\/\/[^/]+/, '')}). Private repo? Add a token in Settings.`);
    if (res.status === 401) throw new Error('GitHub: the token was rejected.');
    if (res.status === 403 && /rate limit/i.test(msg)) throw new Error('GitHub: rate limit reached. Add a token in Settings to raise it.');
    throw new Error(`GitHub ${res.status}: ${msg || res.statusText}`);
  }
  return res;
}

async function listRepos(owner, { token, fetchFn = fetch, apiBase = 'https://api.github.com', max = 40 } = {}) {
  let url = `${apiBase}/users/${owner}/repos?per_page=100&sort=pushed`;
  if (token) {
    try {
      const me = await (await gh(fetchFn, `${apiBase}/user`, token)).json();
      if (me.login && me.login.toLowerCase() === owner.toLowerCase()) url = `${apiBase}/user/repos?per_page=100&sort=pushed&affiliation=owner`;
    } catch { /* fall back to the public list */ }
  }
  const repos = await (await gh(fetchFn, url, token)).json();
  return repos.filter(r => !r.fork && !r.archived && r.size > 0).slice(0, max)
    .map(r => ({ owner: r.owner.login, repo: r.name, ref: '', subdir: '', meta: r })); // meta saves a request per repo
}

// -> { id, label, url, version, chunks:[{path,url,title,text}], files, skipped }
// With knownVersion, a repo that has not been pushed to since is not downloaded: -> { id, unchanged: true }
async function fetchRepo(spec, { token, fetchFn = fetch, apiBase = 'https://api.github.com', maxFiles = 1500, knownVersion = '' } = {}) {
  const { owner, repo, subdir } = spec;
  const meta = spec.meta || await (await gh(fetchFn, `${apiBase}/repos/${owner}/${repo}`, token)).json();
  const ref = spec.ref || meta.default_branch || 'main';
  const htmlUrl = meta.html_url || `https://github.com/${owner}/${repo}`;
  const description = meta.description || '';
  const version = `${meta.pushed_at || ''}@${ref}`;
  const id = specId(spec);
  if (knownVersion && meta.pushed_at && knownVersion === version) return { id, unchanged: true };

  const res = await gh(fetchFn, `${apiBase}/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`, token);
  const gz = Buffer.from(await res.arrayBuffer());
  const chunks = [], pinned = [];
  let files = 0, skipped = 0;
  if (description) chunks.push({ path: `${repo}/(repository description)`, url: htmlUrl, title: `${owner}/${repo} — description`, text: `${owner}/${repo}: ${description}` });
  for (const entry of readTarGz(gz)) {
    const path = entry.path.split('/').slice(1).join('/'); // strip "owner-repo-sha/"
    if (!path) continue;
    if (subdir && !(path === subdir || path.startsWith(subdir + '/'))) continue;
    if (!isIndexable(path, entry.size) || files >= maxFiles) { skipped++; continue; }
    const text = await extractText(path, entry.data);
    if (!text.trim()) { skipped++; continue; }
    files++;
    const fileUrl = `${htmlUrl}/blob/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const note = readNote(path, text);
    for (const c of note.chunks) {
      chunks.push({ path: `${repo}/${path}`, url: c.line ? `${fileUrl}#L${c.line}` : fileUrl, title: c.title, text: c.text });
    }
    if (note.pinned) pinned.push({ path: `${repo}/${path}`, url: fileUrl, ...note.pinned });
  }
  return { id, label: `${owner}/${repo}${subdir ? '/' + subdir : ''}`, url: htmlUrl, version, chunks, pinned, files, skipped };
}

module.exports = { parseRepoSpec, specId, listRepos, fetchRepo };
