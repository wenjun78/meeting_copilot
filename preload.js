'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['transcript', 'answer', 'notice', 'kb', 'hotkey', 'window'];

contextBridge.exposeInMainWorld('mc', {
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, handler) => {
    if (!EVENTS.includes(event)) return;
    ipcRenderer.on('mc:' + event, (_e, payload) => handler(payload));
  },
});
