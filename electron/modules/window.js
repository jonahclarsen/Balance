const { BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');

function getRendererURL(isDev, devPort) {
    if (isDev) {
        return `http://localhost:${devPort}`;
    } else {
        // In production, try multiple possible locations for the dist folder
        const possiblePaths = [
            path.join(__dirname, '../../dist/index.html'),
            path.join(process.resourcesPath, 'app/dist/index.html'),
            path.join(process.resourcesPath, 'dist/index.html'),
            path.join(__dirname, '../../../dist/index.html')
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

class WindowManager {
    constructor(isDev, devPort = '5173') {
        this.isDev = isDev;
        this.rendererURL = getRendererURL(isDev, devPort);
        this.mainWindow = null;
        this.tray = null;
    }

    setTray(tray) {
        this.tray = tray;
    }

    createWindow() {
        // macOS-specific window options to fix transparency issues
        const windowOptions = {
            width: 360 + 14 * 2, // width + 14px*2 padding
            height: 340 + 14 * 2,
            show: false,
            frame: false,
            resizable: false,
            movable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            webPreferences: {
                preload: path.join(__dirname, '../preload.js'),
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

        this.mainWindow = new BrowserWindow(windowOptions);

        // Disable all zooming behaviors: keyboard, wheel, and pinch
        try {
            const wc = this.mainWindow.webContents;
            // Prevent pinch-to-zoom and wheel-based zoom
            wc.setVisualZoomLevelLimits(1, 1).catch(() => { });
            wc.setZoomFactor(1);

            // Intercept keyboard shortcuts like Cmd/Ctrl + '+', '-', '0'
            wc.on('before-input-event', (event, input) => {
                const isAccel = !!(input.control || input.meta);
                if (!isAccel) return;
                const k = (input.key || '').toLowerCase();
                if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0') {
                    event.preventDefault();
                }
            });
        } catch { }

        // Wait for content to load before showing
        this.mainWindow.webContents.once('did-finish-load', () => {
            console.log('Window content loaded successfully');
        });

        // Handle loading failures
        this.mainWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
            console.error('Failed to load window content:', errorCode, errorDescription, validatedURL);
        });

        // Add more detailed debugging
        this.mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
            console.log(`Renderer console [${level}]:`, message);
        });

        this.mainWindow.webContents.on('dom-ready', () => {
            console.log('DOM ready');
        });

        console.log('Loading URL:', this.rendererURL);
        console.log('__dirname:', __dirname);
        console.log('Process cwd:', process.cwd());

        this.mainWindow.loadURL(this.rendererURL);

        // Uncomment to open dev tools for debugging in production
        // setTimeout(() => {
        //     this.mainWindow.webContents.openDevTools({ mode: 'detach' });
        // }, 2000);

        // Add delay before allowing blur to hide window (prevents immediate hiding)
        let canHideOnBlur = false;
        setTimeout(() => { canHideOnBlur = true; }, 1000);

        this.mainWindow.on('blur', () => {
            // Hide when focus lost, like a popover, but with a delay to prevent immediate hiding
            if (canHideOnBlur && !this.mainWindow.webContents.isDevToolsOpened()) {
                setTimeout(() => {
                    if (this.mainWindow && !this.mainWindow.isFocused()) {
                        this.mainWindow.hide();
                    }
                }, 100);
            }
        });

        // Debug logging for macOS
        if (process.platform === 'darwin') {
            this.mainWindow.on('show', () => console.log('Window shown'));
            this.mainWindow.on('hide', () => console.log('Window hidden'));
            this.mainWindow.on('focus', () => console.log('Window focused'));
            this.mainWindow.on('blur', () => console.log('Window blurred'));
        }

        return this.mainWindow;
    }

    getWindowPosition() {
        if (!this.tray || !this.mainWindow) return { x: 0, y: 0 };

        const trayBounds = this.tray.getBounds();
        const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
        const windowBounds = this.mainWindow.getBounds();
        let x = 0;
        let y = 0;

        if (process.platform === 'darwin') {
            x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
            y = Math.round(trayBounds.y + trayBounds.height);

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
        const margin = process.platform === 'darwin' ? 0 : 20; // on macOS, this is the gap between the menu bar and the window
        x = Math.min(Math.max(display.workArea.x + margin, x), display.workArea.x + display.workArea.width - windowBounds.width - margin);
        y = Math.min(Math.max(display.workArea.y + margin, y), display.workArea.y + display.workArea.height - windowBounds.height - margin);

        return { x, y };
    }

    toggleWindow() {
        if (!this.mainWindow) return;

        console.log('Toggle window called, currently visible:', this.mainWindow.isVisible());

        if (this.mainWindow.isVisible()) {
            this.mainWindow.hide();
        } else {
            this.showWindowNearTray();
        }
    }

    showWindowNearTray() {
        if (!this.mainWindow) return;

        const position = this.getWindowPosition();
        console.log('Showing window at position:', position);

        // Set position first
        this.mainWindow.setPosition(position.x, position.y, false);

        // Show and focus the window
        this.mainWindow.show();

        // On macOS, we need to ensure the window actually gets focus
        if (process.platform === 'darwin') {
            // Force focus on macOS
            setTimeout(() => {
                this.mainWindow.focus();
                this.mainWindow.moveTop();
            }, 50);
        } else {
            this.mainWindow.focus();
        }
    }

    getWindow() {
        return this.mainWindow;
    }
}

module.exports = { WindowManager };

