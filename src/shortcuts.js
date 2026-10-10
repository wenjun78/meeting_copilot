'use strict';
// Global shortcut defaults and a table of what the common meeting apps already use
// on Windows, so a chosen combination can be checked before it is registered.
// A global shortcut is taken from every other app while this one runs, which is why
// the defaults use Ctrl+Alt+punctuation: none of the apps below bind those.
// Sources (checked Oct 2026): Microsoft, Zoom, Google and Webex support pages.

const DEFAULTS = {
  answer: 'CommandOrControl+Alt+,',   // answer what they said
  screen: 'CommandOrControl+Alt+.',   // answer from the screen
  toggle: 'CommandOrControl+Alt+/',   // show or hide the window
};

const TAKEN = {
  'Microsoft Teams': {
    'Ctrl+Shift': 'A B C D E F H I J K L M N O Q R S T U X Y Space Enter Tab F6',
    'Ctrl+Alt': 'A B C F K L M P R T U X Z 1 2 3 4 5 Enter Left Right',
    'Alt+Shift': 'A E J L O R S V Y 0 1 2 3 4 5 Plus - Up Down Left Right',
    'Ctrl+Alt+Shift': 'R 1 Up Down',
    'Alt': 'F1 F10',
    '': 'F1 F6 F11',
  },
  Zoom: {
    'Alt': 'A C F H I L M N P Q R S T U V Y F1 F2 F4 Left Right',
    'Alt+Shift': 'E G I R S T 4 5 6 7 8 9',
    'Ctrl+Shift': 'A D E H J M N O T U Y Tab',
    'Ctrl+Alt': 'I',
    'Ctrl+Alt+Shift': 'D H',
    'Ctrl': '2 F K L N P W Up Down Tab Plus -',
    '': 'F6 PageUp PageDown',
  },
  'Google Meet': {
    'Ctrl': 'D E W /',
    'Ctrl+Alt': 'C H I P S X',
    'Alt': 'Left',
  },
  Webex: {
    'Ctrl+Shift': 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z 2 Space Enter , = - Up',
    'Ctrl+Alt': 'A D E F G H I K L M N O P Q R S T U V W Y 1 2 3 4 5 Space',
    'Alt+Shift': 'A C D E F G H J K L M N O P Q R S T U V W X Z 0 1 2 3 4 5 6 7 8 Left Right',
    'Ctrl+Alt+Shift': 'D F H S X',
    'Alt': 'A C G K L N P Q R T Enter F4 Up Down Left Right',
    'Ctrl': 'D E G H J L M N O Q R T W , / = - Plus F1 F6 Enter Delete',
    '': 'F1 F6',
  },
  Windows: {
    'Ctrl+Alt': 'Delete Tab',
    'Ctrl+Shift': 'Escape',
    'Alt': 'Tab F4 Space Escape',
    'Ctrl': 'A C V X Z Y S P F Space',
  },
};

const ALIASES = { control: 'Ctrl', ctrl: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', command: 'Cmd', cmd: 'Cmd', meta: 'Cmd', super: 'Cmd', alt: 'Alt', option: 'Alt', shift: 'Shift' };
const KEY_NAMES = { ' ': 'Space', spacebar: 'Space', return: 'Enter', esc: 'Escape', '+': 'Plus', plus: 'Plus', pgup: 'PageUp', pgdn: 'PageDown', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', del: 'Delete' };
const ORDER = ['Ctrl', 'Cmd', 'Alt', 'Shift'];

// "CommandOrControl+Alt+," -> { mods: 'Ctrl+Alt', key: ',' }   (null when it is not a usable shortcut)
function parse(accelerator) {
  const raw = String(accelerator || '').trim();
  if (!raw) return null;
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+');
  const mods = new Set();
  let key = '';
  for (const part of parts) {
    const p = part.trim();
    const mod = ALIASES[p.toLowerCase()];
    if (mod) mods.add(mod);
    else if (key) return null;
    else key = KEY_NAMES[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1));
  }
  if (!key) return null;
  return { mods: ORDER.filter(m => mods.has(m)).join('+'), key };
}

function pretty(accelerator) {
  const p = parse(accelerator);
  if (!p) return '';
  return (p.mods ? p.mods + '+' : '') + (p.key === 'Plus' ? '+' : p.key);
}

// Why a combination should not be used, or '' when it is fine.
function problem(accelerator) {
  const p = parse(accelerator);
  if (!p) return 'Not a key combination.';
  const fkey = /^F\d{1,2}$/.test(p.key);
  if (!/Ctrl|Alt|Cmd/.test(p.mods) && !fkey) return 'Add Ctrl or Alt, otherwise the key stops working for typing.';
  const users = [];
  for (const [app, table] of Object.entries(TAKEN)) {
    const keys = table[p.mods.replace('Cmd', 'Ctrl')];
    if (keys && keys.split(' ').includes(p.key)) users.push(app);
  }
  return users.length ? `Already used by ${users.join(', ')}.` : '';
}

module.exports = { DEFAULTS, TAKEN, parse, pretty, problem };
