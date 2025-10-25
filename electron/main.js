const { app } = require('electron');

const { StateManager } = require('./modules/state');
const { TimerManager } = require('./modules/timer');
const { WindowManager } = require('./modules/window');
const { TrayManager } = require('./modules/tray');
const { setupIpcHandlers } = require('./modules/ipc-handlers');

const isDev = !app.isPackaged;
const DEV_PORT = process.env.VITE_DEV_PORT || '5173';

// Initialize managers
const stateManager = new StateManager();
const timerManager = new TimerManager(stateManager);
const windowManager = new WindowManager(isDev, DEV_PORT);
const trayManager = new TrayManager(timerManager, windowManager);

app.whenReady().then(() => {
    // Hide dock icon on macOS
    if (process.platform === 'darwin') {
        try {
            app.dock.hide();
        } catch (e) {
            console.error('Failed to hide dock icon:', e);
        }
    }

    // Load data and start auto-save
    stateManager.loadData();
    stateManager.startAutoSave();

    // Create window and tray
    windowManager.createWindow();
    const tray = trayManager.createTray();
    windowManager.setTray(tray);

    // Start timer systems
    timerManager.startTicking();
    timerManager.startMinuteTracking();

    // Set up IPC communication
    setupIpcHandlers(stateManager, timerManager, windowManager, trayManager);
});

app.on('window-all-closed', (e) => {
    // Prevent full quit on macOS
    if (process.platform === 'darwin') {
        e.preventDefault();
    }
});

app.on('before-quit', () => {
    stateManager.stopAutoSave();
    timerManager.stop();
    stateManager.saveData();
});
