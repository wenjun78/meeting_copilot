'use strict';
const zlib = require('zlib');

// Minimal tar reader (ustar + pax + GNU long names) for GitHub tarballs.
function* readTar(buf) {
  let off = 0, longName = null, paxPath = null;
  const str = (s, e) => { const z = buf.indexOf(0, s); return buf.toString('utf8', s, z >= s && z < e ? z : e); };
  while (off + 512 <= buf.length) {
    const name = str(off, off + 100);
    if (!name && buf[off] === 0) break;
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = str(off + 345, off + 500);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath || longName || (prefix ? `${prefix}/${name}` : name);
    longName = paxPath = null;
    if (type === '0' || type === '\0') yield { path, size, data };
  }
}

function readTarGz(gz) { return readTar(zlib.gunzipSync(gz)); }

// Used by tests to build fixtures.
function writeTar(files) {
  const blocks = [];
  for (const f of files) {
    const data = Buffer.from(f.data);
    const h = Buffer.alloc(512);
    h.write(f.path.slice(0, 100), 0);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

module.exports = { readTar, readTarGz, writeTar };
