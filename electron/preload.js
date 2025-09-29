const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('balance', {
    getState: () => ipcRenderer.invoke('balance:get-state'),
    startWork: () => ipcRenderer.invoke('balance:start-work'),
    startBreak: () => ipcRenderer.invoke('balance:start-break'),
    stop: () => ipcRenderer.invoke('balance:stop'),
    pause: () => ipcRenderer.invoke('balance:pause'),
    resume: () => ipcRenderer.invoke('balance:resume'),
    extend: (seconds) => ipcRenderer.invoke('balance:extend', seconds),
    switchMission: (index) => ipcRenderer.invoke('balance:switch-mission', index),
    saveSettings: (settings) => ipcRenderer.invoke('balance:save-settings', settings),
    open: () => ipcRenderer.invoke('balance:open'),
    openDataFolder: () => ipcRenderer.invoke('balance:open-data-folder'),
    quit: () => ipcRenderer.invoke('balance:quit'),
    onState: (callback) => {
        const handler = (_event, message) => callback(message);
        ipcRenderer.on('balance:state', handler);
        return () => {
            try { ipcRenderer.removeListener('balance:state', handler); } catch { }
        };
    },
    platform: process.platform
});

// Disable all zooming in the renderer (pinch, Cmd/Ctrl +/- , programmatic)
try {
    // Disallow visual zoom (pinch/gesture)
    if (typeof webFrame.setVisualZoomLevelLimits === 'function') {
        webFrame.setVisualZoomLevelLimits(1, 1);
    }
    // Disallow zoom level changes
    if (typeof webFrame.setZoomLevelLimits === 'function') {
        webFrame.setZoomLevelLimits(1, 1);
    }
    // Ensure base zoom factor is 1
    if (typeof webFrame.setZoomFactor === 'function') {
        webFrame.setZoomFactor(1);
    }
} catch {}


