const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('balance', {
    getState: () => ipcRenderer.invoke('balance:get-state'),
    startWork: () => ipcRenderer.invoke('balance:start-work'),
    startBreak: () => ipcRenderer.invoke('balance:start-break'),
    stop: () => ipcRenderer.invoke('balance:stop'),
    extend: (seconds) => ipcRenderer.invoke('balance:extend', seconds),
    switchMission: (index) => ipcRenderer.invoke('balance:switch-mission', index),
    saveSettings: (settings) => ipcRenderer.invoke('balance:save-settings', settings),
    open: () => ipcRenderer.invoke('balance:open'),
    openDataFolder: () => ipcRenderer.invoke('balance:open-data-folder'),
    onState: (callback) => {
        const handler = (_event, message) => callback(message);
        ipcRenderer.on('balance:state', handler);
        return () => {
            try { ipcRenderer.removeListener('balance:state', handler); } catch { }
        };
    },
    platform: process.platform
});


