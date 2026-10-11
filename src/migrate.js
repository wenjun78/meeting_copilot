'use strict';
const fs = require('fs');
const path = require('path');

// Earlier versions had a "This meeting" box in Settings. Its text now lives with the other
// notes: it is saved once as a note whose name keeps it sent with every answer, and the
// setting is cleared. Returns the file written, or '' when there was nothing to move.
function moveMeetingBoxToNotes(config, notesDir) {
  const text = String(config.get().context || '').trim();
  if (!text) return '';
  fs.mkdirSync(notesDir, { recursive: true });
  let file = path.join(notesDir, 'Meeting brief.md');
  for (let n = 2; fs.existsSync(file); n++) file = path.join(notesDir, `Meeting brief ${n}.md`);
  fs.writeFileSync(file, text + '\n');
  config.update({ context: '' });
  return file;
}

module.exports = { moveMeetingBoxToNotes };
