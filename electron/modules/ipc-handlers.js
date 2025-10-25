const { ipcMain, shell } = require('electron');

function setupIpcHandlers(stateManager, timerManager, windowManager, trayManager) {

    function getPublicState() {
        return {
            settings: stateManager.settings,
            state: {
                ...stateManager.state,
                timer: { ...stateManager.state.timer, remainingSeconds: timerManager.timeRemainingSeconds() }
            },
            computed: {
                outOfBalanceHours: timerManager.getOutOfBalanceHoursAbs(),
                outOfBalanceSign: timerManager.getOutOfBalanceSign(),
                withinRange: timerManager.isWithinAcceptableRange(),
                lifetimeMinutes: timerManager.getTotalMinutesForMission(stateManager.state.currentMissionIndex)
            }
        };
    }

    function notifyRenderer(type) {
        const mainWindow = windowManager.getWindow();
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('balance:state', { type, payload: getPublicState() });
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
    ipcMain.handle('balance:get-state', () => getPublicState());

    ipcMain.handle('balance:start-work', () => {
        timerManager.startTimer(false);
        return getPublicState();
    });

    ipcMain.handle('balance:start-break', () => {
        timerManager.startTimer(true);
        return getPublicState();
    });

    ipcMain.handle('balance:stop', () => {
        timerManager.stopTimer();
        return getPublicState();
    });

    ipcMain.handle('balance:pause', () => {
        timerManager.pauseTimer();
        return getPublicState();
    });

    ipcMain.handle('balance:resume', () => {
        timerManager.resumeTimer();
        return getPublicState();
    });

    ipcMain.handle('balance:extend', (_e, seconds) => {
        timerManager.extendTimer(seconds);
        return getPublicState();
    });

    ipcMain.handle('balance:switch-mission', (_e, idx) => {
        timerManager.switchMission(idx);
        notifyRenderer('state');
        trayManager.updateTrayTitleAndIcon();
        return getPublicState();
    });

    ipcMain.handle('balance:save-settings', (_e, nextSettings) => {
        stateManager.updateSettings(nextSettings);
        notifyRenderer('state');
        trayManager.updateTrayTitleAndIcon();
        return getPublicState();
    });

    ipcMain.handle('balance:open', () => {
        windowManager.showWindowNearTray();
    });

    ipcMain.handle('balance:open-data-folder', () => {
        try {
            shell.openPath(stateManager.getUserDir());
        } catch (e) {
            console.error('Failed to open data folder:', e);
        }
    });

    ipcMain.handle('balance:quit', () => {
        const { app } = require('electron');
        app.quit();
    });
}

module.exports = { setupIpcHandlers };

