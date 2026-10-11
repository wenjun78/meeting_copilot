'use strict';
const fs = require('fs');
const path = require('path');

// Earlier versions kept "About you" and "This meeting" as boxes in Settings. They are notes
// now, like everything else the model is given: each is saved once under a name that keeps
// it sent with every answer, and the setting is cleared. Returns the files written.
function moveSettingsTextToNotes(config, notesDir) {
  const written = [];
  for (const [key, name] of [['profile', 'About me'], ['context', 'Meeting brief']]) {
    const text = String(config.get()[key] || '').trim();
    if (!text) continue;
    fs.mkdirSync(notesDir, { recursive: true });
    let file = path.join(notesDir, `${name}.md`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(notesDir, `${name} ${n}.md`);
    fs.writeFileSync(file, text + '\n');
    config.update({ [key]: '' });
    written.push(file);
  }
  return written;
}

module.exports = { moveSettingsTextToNotes };
