const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cactus', {
    getState: () => ipcRenderer.invoke('cactus:get-state'),
    startWork: () => ipcRenderer.invoke('cactus:start-work'),
    startBreak: () => ipcRenderer.invoke('cactus:start-break'),
    stop: () => ipcRenderer.invoke('cactus:stop'),
    pause: () => ipcRenderer.invoke('cactus:pause'),
    resume: () => ipcRenderer.invoke('cactus:resume'),
    extend: (seconds) => ipcRenderer.invoke('cactus:extend', seconds),
    saveSettings: (settings) => ipcRenderer.invoke('cactus:save-settings', settings),
    open: () => ipcRenderer.invoke('cactus:open'),
    openDataFolder: () => ipcRenderer.invoke('cactus:open-data-folder'),
    openGithub: () => ipcRenderer.invoke('cactus:open-github'),
    quit: () => ipcRenderer.invoke('cactus:quit'),
    onState: (callback) => {
        const handler = (_event, message) => callback(message);
        ipcRenderer.on('cactus:state', handler);
        return () => {
            try { ipcRenderer.removeListener('cactus:state', handler); } catch { }
        };
    },
    platform: process.platform
});


