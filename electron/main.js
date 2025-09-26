const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const DEV_PORT = process.env.VITE_DEV_PORT || '5173';

// More robust path resolution for production
function getRendererURL() {
    if (isDev) {
        return `http://localhost:${DEV_PORT}`;
    } else {
        // In production, try multiple possible locations for the dist folder
        const possiblePaths = [
            path.join(__dirname, '../dist/index.html'),
            path.join(process.resourcesPath, 'app/dist/index.html'),
            path.join(process.resourcesPath, 'dist/index.html'),
            path.join(__dirname, '../../dist/index.html')
        ];

        let distPath = null;
        for (const testPath of possiblePaths) {
            console.log('Testing path:', testPath, 'exists:', fs.existsSync(testPath));
            if (fs.existsSync(testPath)) {
                distPath = testPath;
                break;
            }
        }

        if (!distPath) {
            console.error('Could not find dist/index.html in any expected location');
            distPath = possiblePaths[0]; // fallback
        }

        console.log('Using production renderer path:', distPath);
        return `file://${distPath}`;
    }
}

const RENDERER_URL = getRendererURL();

// Data & settings
const DEFAULT_SETTINGS = {
    missions: [
        { name: 'Pink Mission', color: '#e91e63' },
        { name: 'Green Mission', color: '#2e7d32' },
        { name: 'Untracked', color: '#9e9e9e', untracked: true }
    ],
    acceptableHourRange: 6,
    durations: { workMinutes: 28, breakMinutes: 3 },
};

const DEFAULT_STATE = {
    currentMissionIndex: 0,
    timer: { running: false, isBreak: false, remainingSeconds: 0, endTs: 0, initialSeconds: 0 },
    lastEnded: null,
    dailyMinutes: {} // Structure: {"mission_0": {"2025-01-01": 4}, "mission_1": {"2025-01-01": 2}}
};

let mainWindow = null; // popover window
let tray = null;
let saveInterval = null;
let tickInterval = null;
let minuteTrackingInterval = null;
let settings = { ...DEFAULT_SETTINGS };
let state = { ...DEFAULT_STATE };
let dataFilePath = '';

function getUserDir() {
    return app.getPath('userData');
}

function ensureDataDir() {
    const dir = getUserDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    return dir;
}

function getDataFilePath() {
    const dir = ensureDataDir();
    return path.join(dir, 'balance.json');
}

function loadData() {
    try {
        const p = getDataFilePath();
        dataFilePath = p;
        if (fs.existsSync(p)) {
            const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
            settings = { ...DEFAULT_SETTINGS, ...json.settings };
            // Deep merge missions if missing
            if (!settings.missions || settings.missions.length !== 3) settings.missions = DEFAULT_SETTINGS.missions;
            if (!settings.durations) settings.durations = DEFAULT_SETTINGS.durations;
            state = { ...DEFAULT_STATE, ...json.state };
            if (!state.dailyMinutes) state.dailyMinutes = {};
        } else {
            saveData();
        }
    } catch (e) {
        console.error('Failed to load data:', e);
    }
}

function saveData() {
    try {
        const p = getDataFilePath();
        dataFilePath = p;
        const payload = { settings, state };
        fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
        console.error('Failed to save data:', e);
    }
}

function setSaveScheduler() {
    if (saveInterval) clearInterval(saveInterval);
    // Save every 2 minutes
    saveInterval = setInterval(saveData, 2 * 60 * 1000);
}

function secondsToMinutesFloor(seconds) {
    return Math.max(0, Math.floor(seconds / 60));
}

function getTotalMinutesForMission(missionIndex) {
    const missionKey = `mission_${missionIndex}`;
    const missionData = state.dailyMinutes[missionKey];
    if (!missionData) return 0;

    return Object.values(missionData).reduce((total, dayMinutes) => total + dayMinutes, 0);
}

function getOutOfBalanceHoursAbs() {
    // Only calculate balance for tracked missions (exclude untracked mission)
    const totalMinutes0 = getTotalMinutesForMission(0);
    const totalMinutes1 = getTotalMinutesForMission(1);
    const diffMinutes = Math.abs(totalMinutes0 - totalMinutes1);
    return Math.round(diffMinutes / 60);
}

function getOutOfBalanceSign() {
    // Only calculate balance for tracked missions (exclude untracked mission)
    const totalMinutes0 = getTotalMinutesForMission(0);
    const totalMinutes1 = getTotalMinutesForMission(1);
    const d = totalMinutes0 - totalMinutes1;
    return d === 0 ? 0 : (d > 0 ? 1 : -1); // 1 => pink has more, -1 => green has more
}

function isWithinAcceptableRange() {
    const diffHours = getOutOfBalanceHoursAbs();
    return diffHours <= (settings.acceptableHourRange || DEFAULT_SETTINGS.acceptableHourRange);
}

function updateTrayTitleAndIcon() {
    const balanceNum = getOutOfBalanceHoursAbs();
    const minutesLeft = secondsToMinutesFloor(timeRemainingSeconds());
    renderTrayImage(balanceNum, minutesLeft, () => { });
    // Only show the minutes as system text; colored balance + pie are in the image
    try { tray.setTitle(`${minutesLeft}`); } catch { }
    tray.setToolTip(`${settings.missions[0].name}: ${Math.round(getTotalMinutesForMission(0) / 60)}h | ${settings.missions[1].name}: ${Math.round(getTotalMinutesForMission(1) / 60)}h`);
}

function timeRemainingSeconds() {
    if (!state.timer.running) return state.timer.remainingSeconds || 0;
    const rem = Math.max(0, Math.floor((state.timer.endTs - Date.now()) / 1000));
    return rem;
}

function getTodayDateString() {
    const today = new Date();
    return today.getFullYear() + '-' +
        String(today.getMonth() + 1).padStart(2, '0') + '-' +
        String(today.getDate()).padStart(2, '0');
}

function isInMinuteTrackingWindow() {
    const now = new Date();
    const seconds = now.getSeconds();
    return seconds >= 5 && seconds <= 15;
}

function incrementDailyMinute() {
    if (!state.timer.running || state.timer.isBreak) return;

    const today = getTodayDateString();
    const missionKey = `mission_${state.currentMissionIndex}`;

    // Initialize structure if needed
    if (!state.dailyMinutes) {
        state.dailyMinutes = {};
    }
    if (!state.dailyMinutes[missionKey]) {
        state.dailyMinutes[missionKey] = {};
    }
    if (!state.dailyMinutes[missionKey][today]) {
        state.dailyMinutes[missionKey][today] = 0;
    }

    // Increment today's minute count
    state.dailyMinutes[missionKey][today]++;

    // Save the updated data
    saveData();
    notifyRenderer('state');
}

function startMinuteTracking() {
    if (minuteTrackingInterval) clearTimeout(minuteTrackingInterval);

    const scheduleNext = () => {
        if (isInMinuteTrackingWindow()) {
            // We're in the tracking window (x:05 to x:15)
            incrementDailyMinute();
            // Set timer to run again in 30 seconds
            minuteTrackingInterval = setTimeout(scheduleNext, 30000);
        } else {
            // We're outside the tracking window, check again in 5 seconds
            minuteTrackingInterval = setTimeout(scheduleNext, 5000);
        }
    };

    // Start the tracking cycle
    scheduleNext();
}

function startTicking() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
        if (state.timer.running) {
            const rem = timeRemainingSeconds();
            const lastRem = state.timer.remainingSeconds;
            state.timer.remainingSeconds = rem;
            if (rem <= 0) {
                state.timer.running = false;
                state.timer.endTs = 0;
                state.lastEnded = { isBreak: state.timer.isBreak, missionIndex: state.currentMissionIndex, ts: Date.now() };
                notifyRenderer('timer-ended');
                try { app.beep(); } catch { }
                showWindowNearTray();
                // Flush to disk soon after end
                setTimeout(saveData, 250);
            }
            if (lastRem !== rem) {
                updateTrayTitleAndIcon();
                notifyRenderer('state');
            }
        }
    }, 1000);
}

function createWindow() {
    // macOS-specific window options to fix transparency issues
    const windowOptions = {
        width: 380,
        height: 520,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false // Allow file:// protocol in production
        }
    };

    // On macOS, use vibrancy instead of full transparency for better reliability
    if (process.platform === 'darwin') {
        windowOptions.transparent = false;
        windowOptions.vibrancy = 'popover';
        windowOptions.backgroundColor = '#00000000'; // Transparent background
    } else {
        windowOptions.transparent = true;
    }

    mainWindow = new BrowserWindow(windowOptions);

    // Wait for content to load before showing
    mainWindow.webContents.once('did-finish-load', () => {
        console.log('Window content loaded successfully');
    });

    // Handle loading failures
    mainWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error('Failed to load window content:', errorCode, errorDescription, validatedURL);
    });

    // Add more detailed debugging
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`Renderer console [${level}]:`, message);
    });

    mainWindow.webContents.on('dom-ready', () => {
        console.log('DOM ready');
    });

    console.log('Loading URL:', RENDERER_URL);
    console.log('__dirname:', __dirname);
    console.log('Process cwd:', process.cwd());

    mainWindow.loadURL(RENDERER_URL);

    // Optional: Uncomment to open dev tools for debugging in production
    // if (!isDev) {
    //     setTimeout(() => {
    //         mainWindow.webContents.openDevTools({ mode: 'detach' });
    //     }, 2000);
    // }

    // Add delay before allowing blur to hide window (prevents immediate hiding)
    let canHideOnBlur = false;
    setTimeout(() => { canHideOnBlur = true; }, 1000);

    mainWindow.on('blur', () => {
        // Hide when focus lost, like a popover, but with a delay to prevent immediate hiding
        if (canHideOnBlur && !mainWindow.webContents.isDevToolsOpened()) {
            setTimeout(() => {
                if (mainWindow && !mainWindow.isFocused()) {
                    mainWindow.hide();
                }
            }, 100);
        }
    });

    // Debug logging for macOS
    if (process.platform === 'darwin') {
        mainWindow.on('show', () => console.log('Window shown'));
        mainWindow.on('hide', () => console.log('Window hidden'));
        mainWindow.on('focus', () => console.log('Window focused'));
        mainWindow.on('blur', () => console.log('Window blurred'));
    }
}

function getWindowPosition() {
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const windowBounds = mainWindow.getBounds();
    let x = 0;
    let y = 0;

    if (process.platform === 'darwin') {
        // macOS: Position below the menu bar
        x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
        y = Math.round(trayBounds.y + trayBounds.height + 4);

        // Debug logging for macOS
        console.log('macOS positioning:', {
            trayBounds,
            windowBounds,
            display: display.workArea,
            calculated: { x, y }
        });
    } else {
        // Windows/Linux: place above the tray if at bottom, otherwise below
        const taskbarAtBottom = trayBounds.y > (display.workArea.y + display.workArea.height / 2);
        x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
        y = taskbarAtBottom ? Math.round(trayBounds.y - windowBounds.height - 8) : Math.round(trayBounds.y + trayBounds.height + 4);
    }

    // Keep inside screen bounds with more generous margins
    const margin = 20;
    x = Math.min(Math.max(display.workArea.x + margin, x), display.workArea.x + display.workArea.width - windowBounds.width - margin);
    y = Math.min(Math.max(display.workArea.y + margin, y), display.workArea.y + display.workArea.height - windowBounds.height - margin);

    return { x, y };
}

function toggleWindow() {
    if (!mainWindow) return;

    console.log('Toggle window called, currently visible:', mainWindow.isVisible());

    if (mainWindow.isVisible()) {
        mainWindow.hide();
    } else {
        showWindowNearTray();
    }
}

function showWindowNearTray() {
    if (!mainWindow) return;

    const position = getWindowPosition();
    console.log('Showing window at position:', position);

    // Set position first
    mainWindow.setPosition(position.x, position.y, false);

    // Show and focus the window
    mainWindow.show();

    // On macOS, we need to ensure the window actually gets focus
    if (process.platform === 'darwin') {
        // Force focus on macOS
        setTimeout(() => {
            mainWindow.focus();
            mainWindow.moveTop();
        }, 50);
    } else {
        mainWindow.focus();
    }
}

function createTray() {
    // Base icon with transparent fallback
    let image;
    try {
        let iconPath = path.join(__dirname, 'trayTemplate.png');
        if (!fs.existsSync(iconPath)) {
            iconPath = path.join(__dirname, 'tray.png');
        }
        if (fs.existsSync(iconPath)) {
            image = nativeImage.createFromPath(iconPath);
        }
    } catch { }
    if (!image || image.isEmpty()) {
        const transparentPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottQAAAABJRU5ErkJggg==';
        image = nativeImage.createFromDataURL(transparentPixel);
    }
    tray = new Tray(image);
    updateTrayTitleAndIcon();
    // Remove context menu to hide system menu - only handle click events
    tray.on('click', toggleWindow);
}

function renderTrayImage(balanceNum, minutesLeft, cb) {
    // Create an offscreen BrowserWindow to render a small crisp canvas (HiDPI)
    const scale = 2; // render at 2x for crisper downscale in tray
    const pointH = 26; // increased for better visibility

    // Calculate dynamic width based on content
    const balanceText = String(balanceNum);
    const fontSize = 15 * scale;
    const pieSize = 18 * scale; // larger pie chart
    const spaceBetween = 8; // space between number and pie

    // Estimate text width (approximate: 0.6 * fontSize per character for bold font)
    const estimatedTextWidth = balanceText.length * fontSize * 0.6;
    const totalContentWidth = estimatedTextWidth + spaceBetween + pieSize;
    const minWidth = 32 * scale; // minimum width
    const w = Math.max(minWidth, Math.ceil(totalContentWidth + 8)); // add some padding
    const pointW = Math.ceil(w / scale);

    const h = pointH * scale; // target height
    const padding = 0 * scale; // padding between the pie chart and the countdown, but balance number to countdown aren't affected
    const off = new BrowserWindow({
        width: w,
        height: h,
        show: false,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true }
    });
    const balanceColor = isWithinAcceptableRange() ? '#9e9e9e' : (getOutOfBalanceSign() >= 0 ? settings.missions[0].color : settings.missions[1].color);
    const pieColor = settings.missions[state.currentMissionIndex].color;
    const total = state.timer.initialSeconds || (state.timer.isBreak ? (settings.durations.breakMinutes || 3) * 60 : (settings.durations.workMinutes || 28) * 60);
    const rem = Math.max(0, timeRemainingSeconds());
    const frac = total > 0 ? Math.max(0, Math.min(1, 1 - rem / total)) : 0;
    const html = `<!doctype html><html><body style="margin:0;background:transparent;">
        <canvas id="c" width="${w}" height="${h}" style="display:block"></canvas>
        <script>
        const c = document.getElementById('c');
        const ctx = c.getContext('2d');
        ctx.clearRect(0,0,${w},${h});
        ctx.imageSmoothingEnabled = false;
        ctx.font = 'bold ${15 * scale}px -apple-system, Segoe UI, Arial, Helvetica';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        // balance number
        ctx.fillStyle = '${balanceColor}';
        const text = String(${balanceNum});
        const tx = ${padding};
        const ty = ${h}/2 + 2;
        ctx.fillText(text, tx, ty);
        const tm = Math.ceil(ctx.measureText(text).width);
        // pie timer
        const pieSize = ${pieSize};
        const cx = tx + tm + pieSize/2 + ${spaceBetween};
        const cy = ${h}/2;
        ctx.strokeStyle = '${pieColor}';
        ctx.lineWidth = ${Math.max(1, Math.round(0.9 * scale))};
        ctx.beginPath(); ctx.arc(cx, cy, pieSize/2, 0, Math.PI*2); ctx.stroke();
        // filled wedge (clockwise from top)
        const start = -Math.PI/2;
        const end = start + Math.PI*2*${frac};
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.fillStyle = '${pieColor}';
        ctx.arc(cx, cy, pieSize/2 - ${Math.max(1, Math.round(0.8 * scale))}, start, end);
        ctx.closePath();
        ctx.globalAlpha = 0.6; ctx.fill(); ctx.globalAlpha = 1;
        </script></body></html>`;
    off.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const done = async () => {
        try {
            let img = await off.webContents.capturePage();
            try { img.setTemplateImage(false); } catch { }
            img = img.resize({ width: pointW, height: pointH, quality: 'best' });
            tray.setImage(img);
        } catch { }
        try { off.destroy(); } catch { }
        cb();
    };
    off.webContents.once('did-finish-load', done);
}

function notifyRenderer(type) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('balance:state', { type, payload: getPublicState() });
    }
}

function getPublicState() {
    return {
        settings,
        state: {
            ...state,
            timer: { ...state.timer, remainingSeconds: timeRemainingSeconds() }
        },
        computed: {
            outOfBalanceHours: getOutOfBalanceHoursAbs(),
            outOfBalanceSign: getOutOfBalanceSign(),
            withinRange: isWithinAcceptableRange(),
            lifetimeMinutes: getTotalMinutesForMission(state.currentMissionIndex)
        }
    };
}

function getTodayMinutesForCurrentMission() {
    const today = getTodayDateString();
    const missionKey = `mission_${state.currentMissionIndex}`;
    return state.dailyMinutes?.[missionKey]?.[today] || 0;
}

function startTimer(isBreak) {
    const minutes = isBreak ? (settings.durations.breakMinutes || DEFAULT_SETTINGS.durations.breakMinutes) : (settings.durations.workMinutes || DEFAULT_SETTINGS.durations.workMinutes);
    state.timer.isBreak = !!isBreak;
    state.timer.running = true;
    state.timer.remainingSeconds = Math.max(0, Math.floor(minutes * 60));
    state.timer.initialSeconds = state.timer.remainingSeconds;
    state.timer.endTs = Date.now() + state.timer.remainingSeconds * 1000;
    state.lastEnded = null;
    notifyRenderer('state');
    updateTrayTitleAndIcon();
}

function stopTimer() {
    state.timer.running = false;
    state.timer.endTs = 0;
    notifyRenderer('state');
    updateTrayTitleAndIcon();
}

function pauseTimer() {
    // Pause only if currently running
    if (!state.timer.running) return;
    state.timer.remainingSeconds = timeRemainingSeconds();
    state.timer.running = false;
    state.timer.endTs = 0;
    // Keep initialSeconds as-is so progress visuals remain consistent
    notifyRenderer('state');
    updateTrayTitleAndIcon();
}

function resumeTimer() {
    // Resume only if currently paused with time remaining
    if (state.timer.running) return;
    const next = Math.max(0, state.timer.remainingSeconds || 0);
    if (next <= 0) return;
    state.timer.endTs = Date.now() + next * 1000;
    state.timer.running = true;
    state.lastEnded = null;
    if (!state.timer.initialSeconds) state.timer.initialSeconds = next;
    notifyRenderer('state');
    updateTrayTitleAndIcon();
}

function extendTimer(secondsDelta) {
    const delta = Math.floor(secondsDelta);
    const wasRunning = state.timer.running;
    if (wasRunning) {
        state.timer.endTs += delta * 1000;
        state.timer.remainingSeconds = timeRemainingSeconds();
    } else {
        const next = Math.max(0, (state.timer.remainingSeconds || 0) + delta);
        state.timer.remainingSeconds = next;
        // If timer had ended (lastEnded set) and user extends, auto-resume.
        // If it's just paused (no lastEnded), stay paused.
        if (next > 0 && state.lastEnded) {
            state.timer.endTs = Date.now() + next * 1000;
            state.timer.running = true;
            if (!state.timer.initialSeconds) state.timer.initialSeconds = next;
            state.lastEnded = null;
        } else {
            state.timer.endTs = 0;
            state.timer.running = false;
        }
    }
    notifyRenderer('state');
    updateTrayTitleAndIcon();
}

// IPC
ipcMain.handle('balance:get-state', () => getPublicState());
ipcMain.handle('balance:start-work', () => { startTimer(false); return getPublicState(); });
ipcMain.handle('balance:start-break', () => { startTimer(true); return getPublicState(); });
ipcMain.handle('balance:stop', () => { stopTimer(); return getPublicState(); });
ipcMain.handle('balance:pause', () => { pauseTimer(); return getPublicState(); });
ipcMain.handle('balance:resume', () => { resumeTimer(); return getPublicState(); });
ipcMain.handle('balance:extend', (_e, seconds) => { extendTimer(seconds); return getPublicState(); });
ipcMain.handle('balance:switch-mission', (_e, idx) => { state.currentMissionIndex = Math.max(0, Math.min(2, idx)); notifyRenderer('state'); updateTrayTitleAndIcon(); return getPublicState(); });
ipcMain.handle('balance:save-settings', (_e, nextSettings) => {
    const prevDir = getUserDir();
    settings = { ...settings, ...nextSettings };
    // Ensure constraints
    if (!settings.missions || settings.missions.length !== 3) settings.missions = DEFAULT_SETTINGS.missions;
    if (!settings.durations) settings.durations = DEFAULT_SETTINGS.durations;
    const newDir = getUserDir();
    if (newDir !== prevDir) {
        try { fs.mkdirSync(newDir, { recursive: true }); } catch { }
        const newPath = path.join(newDir, 'balance.json');
        fs.writeFileSync(newPath, JSON.stringify({ settings, state }, null, 2), 'utf-8');
        dataFilePath = newPath;
    } else {
        saveData();
    }
    notifyRenderer('state');
    updateTrayTitleAndIcon();
    return getPublicState();
});

ipcMain.handle('balance:open', () => { showWindowNearTray(); });

ipcMain.handle('balance:open-data-folder', () => {
    try {
        shell.openPath(getUserDir());
    } catch (e) {
        console.error('Failed to open data folder:', e);
    }
});

ipcMain.handle('balance:quit', () => {
    app.quit();
});

app.whenReady().then(() => {
    // Hide dock icon on macOS
    if (process.platform === 'darwin') {
        try {
            app.dock.hide();
        } catch (e) {
            console.error('Failed to hide dock icon:', e);
        }
    }

    loadData();
    setSaveScheduler();
    createWindow();
    createTray();
    startTicking();
    startMinuteTracking();
});

app.on('window-all-closed', (e) => {
    // Prevent full quit on macOS
    if (process.platform === 'darwin') {
        e.preventDefault();
    }
});

app.on('before-quit', () => {
    try { if (saveInterval) clearInterval(saveInterval); } catch { }
    try { if (tickInterval) clearInterval(tickInterval); } catch { }
    try { if (minuteTrackingInterval) clearTimeout(minuteTrackingInterval); } catch { }
    saveData();
});


