const { ipcMain, shell } = require('electron');

function setupIpcHandlers(stateManager, timerManager, windowManager, trayManager) {

    function getPublicState() {
        return {
            settings: stateManager.settings,
            state: {
                ...stateManager.state,
                timer: { ...stateManager.state.timer, remainingSeconds: timerManager.timeRemainingSeconds() }
            },
            computed: {}
        };
    }

    function notifyRenderer(type) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('cactus:state', { type, payload: getPublicState() });
        }
    }

    // Set up callbacks
    timerManager.onTick = () => {
        notifyRenderer('state');
        trayManager.updateTrayTitleAndIcon();
    };

    timerManager.onEnd = () => {
        notifyRenderer('timer-ended');
        windowManager.showWindowNearTray();
    };

    // Register IPC handlers
    ipcMain.handle('cactus:get-state', () => getPublicState());

    ipcMain.handle('cactus:start-work', () => {
        timerManager.startTimer(false);
        return getPublicState();
    });

    ipcMain.handle('cactus:start-break', () => {
        timerManager.startTimer(true);
        return getPublicState();
    });

    ipcMain.handle('cactus:stop', () => {
        timerManager.stopTimer();
        return getPublicState();
    });

    ipcMain.handle('cactus:pause', () => {
        timerManager.pauseTimer();
        return getPublicState();
    });

    ipcMain.handle('cactus:resume', () => {
        timerManager.resumeTimer();
        return getPublicState();
    });

    ipcMain.handle('cactus:extend', (_e, seconds) => {
        timerManager.extendTimer(seconds);
        return getPublicState();
    });

    ipcMain.handle('cactus:save-settings', (_e, nextSettings) => {
        stateManager.updateSettings(nextSettings);
        notifyRenderer('state');
        trayManager.updateTrayTitleAndIcon();
        return getPublicState();
    });

    ipcMain.handle('cactus:open', () => {
        windowManager.showWindowNearTray();
    });

    ipcMain.handle('cactus:open-data-folder', () => {
        try {
            shell.openPath(stateManager.getUserDir());
        } catch (e) {
            console.error('Failed to open data folder:', e);
        }
    });

    ipcMain.handle('cactus:open-github', () => {
        try {
            shell.openExternal('https://github.com/jonahclarsen/Cactus');
        } catch (e) {
            console.error('Failed to open GitHub:', e);
        }
    });

    ipcMain.handle('cactus:quit', () => {
        const { app } = require('electron');
        app.quit();
    });
}

module.exports = { setupIpcHandlers };

