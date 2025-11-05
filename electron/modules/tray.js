const { Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');

const THEME_PALETTES = {
    pink: {
        bg: "#FFE2F5",
        card: "#FDB3DB",
        stroke: "#BF6091",
        accent: "#E47ED1",
        primary: "#e91e63"
    },
    green: {
        bg: "#E0F2F1",
        card: "#B2DFDB",
        stroke: "#00695C",
        accent: "#4DB6AC",
        primary: "#2e7d32"
    },
    neutral: {
        bg: "#F3F3F3",
        card: "#E8E8E8",
        stroke: "#9E9E9E",
        accent: "#BDBDBD",
        primary: "#8C8C8C"
    },
    blue: {
        bg: "#E3F2FD",
        card: "#90CAF9",
        stroke: "#1565C0",
        accent: "#42A5F5",
        primary: "#1976D2"
    },
    purple: {
        bg: "#F3E5F5",
        card: "#CE93D8",
        stroke: "#6A1B9A",
        accent: "#AB47BC",
        primary: "#8E24AA"
    },
    orange: {
        bg: "#FFF3E0",
        card: "#FFCC80",
        stroke: "#E65100",
        accent: "#FF9800",
        primary: "#F57C00"
    }
};

class TrayManager {
    constructor(timerManager, windowManager) {
        this.timerManager = timerManager;
        this.windowManager = windowManager;
        this.tray = null;
    }

    get state() {
        return this.timerManager.state;
    }

    get settings() {
        return this.timerManager.settings;
    }

    createTray() {
        // Base icon with transparent fallback
        let image;
        try {
            let iconPath = path.join(__dirname, '../trayTemplate.png');
            if (!fs.existsSync(iconPath)) {
                iconPath = path.join(__dirname, '../tray.png');
            }
            if (fs.existsSync(iconPath)) {
                image = nativeImage.createFromPath(iconPath);
            }
        } catch { }
        if (!image || image.isEmpty()) {
            const transparentPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottQAAAABJRU5ErkJggg==';
            image = nativeImage.createFromDataURL(transparentPixel);
        }
        this.tray = new Tray(image);
        this.updateTrayTitleAndIcon();
        // Remove context menu to hide system menu - only handle click events
        this.tray.on('click', () => this.windowManager.toggleWindow());

        return this.tray;
    }

    updateTrayTitleAndIcon() {
        if (!this.tray) return;

        const minutesLeft = this.timerManager.secondsToMinutesFloor(this.timerManager.timeRemainingSeconds());
        this.renderTrayImage(0, minutesLeft, () => { });

        // Only show the minutes as system text; colored balance + pie are in the image
        try { this.tray.setTitle(`${minutesLeft}`); } catch { }

        this.tray.setToolTip(`Timer: ${minutesLeft} minutes remaining`);
    }

    renderTrayImage(balanceNum, minutesLeft, cb) {
        try {
            // Render at 2x for HiDPI displays
            const scale = 2;
            const pointH = 26;

            // Calculate dynamic width based on content
            const balanceText = String(balanceNum);
            const fontSize = 15 * scale;
            const pieSize = 18 * scale;
            const spaceBetween = 8;

            // Estimate text width (approximate: 0.6 * fontSize per character for bold font)
            const estimatedTextWidth = balanceText.length * fontSize * 0.6;
            const totalContentWidth = estimatedTextWidth + spaceBetween + pieSize;
            const minWidth = 32 * scale;
            const w = Math.max(minWidth, Math.ceil(totalContentWidth + 8));
            const pointW = Math.ceil(w / scale);
            const h = pointH * scale;
            const padding = 0 * scale;

            // Create canvas
            const canvas = createCanvas(w, h);
            const ctx = canvas.getContext('2d');

            // Clear and setup
            ctx.clearRect(0, 0, w, h);
            ctx.imageSmoothingEnabled = false;

            // Determine colors - use theme from settings
            const themeName = this.settings.theme || 'neutral';
            const theme = THEME_PALETTES[themeName] || THEME_PALETTES.neutral;
            const balanceColor = THEME_PALETTES.neutral.primary;
            const pieColor = theme.primary;

            // Calculate timer progress
            const total = this.state.timer.initialSeconds || (this.state.timer.isBreak ?
                (this.settings.durations.breakMinutes) * 60 :
                (this.settings.durations.workMinutes) * 60);
            const rem = Math.max(0, this.timerManager.timeRemainingSeconds());
            const frac = total > 0 ? Math.max(0, Math.min(1, 1 - rem / total)) : 0;

            // Draw balance number
            ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, Helvetica, sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.fillStyle = balanceColor;
            const tx = padding;
            const ty = h / 2;
            ctx.fillText(balanceText, tx, ty);
            const tm = Math.ceil(ctx.measureText(balanceText).width);

            // Draw pie timer
            const cx = tx + tm + pieSize / 2 + spaceBetween;
            const cy = h / 2;

            // Outer circle
            ctx.strokeStyle = pieColor;
            ctx.lineWidth = Math.max(1, Math.round(0.9 * scale));
            ctx.beginPath();
            ctx.arc(cx, cy, pieSize / 2, 0, Math.PI * 2);
            ctx.stroke();

            // Filled wedge (clockwise from top)
            const start = -Math.PI / 2;
            const end = start + Math.PI * 2 * frac;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.fillStyle = pieColor;
            ctx.arc(cx, cy, pieSize / 2 - Math.max(1, Math.round(0.8 * scale)), start, end);
            ctx.closePath();
            ctx.globalAlpha = 0.6;
            ctx.fill();
            ctx.globalAlpha = 1;

            // Convert to image buffer and create nativeImage
            const buffer = canvas.toBuffer('image/png');
            let img = nativeImage.createFromBuffer(buffer);
            try { img.setTemplateImage(false); } catch { }

            // Resize for actual display size
            img = img.resize({ width: pointW, height: pointH, quality: 'best' });
            this.tray.setImage(img);
        } catch (e) {
            console.error('Failed to render tray image:', e);
        }
        cb();
    }

    getTray() {
        return this.tray;
    }
}

module.exports = { TrayManager };

