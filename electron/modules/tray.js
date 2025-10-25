const { Tray, nativeImage, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

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

        const balanceNum = this.timerManager.getOutOfBalanceHoursAbs();
        const minutesLeft = this.timerManager.secondsToMinutesFloor(this.timerManager.timeRemainingSeconds());
        this.renderTrayImage(balanceNum, minutesLeft, () => { });
        // Only show the minutes as system text; colored balance + pie are in the image
        try { this.tray.setTitle(`${minutesLeft}`); } catch { }
        this.tray.setToolTip(
            `${this.settings.missions[0].name}: ${Math.round(this.timerManager.getTotalMinutesForMission(0) / 60)}h | ` +
            `${this.settings.missions[1].name}: ${Math.round(this.timerManager.getTotalMinutesForMission(1) / 60)}h`
        );
    }

    renderTrayImage(balanceNum, minutesLeft, cb) {
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
        const balanceColor = this.timerManager.isWithinAcceptableRange() ?
            '#9e9e9e' :
            (this.timerManager.getOutOfBalanceSign() >= 0 ?
                this.settings.missions[0].color :
                this.settings.missions[1].color);
        const pieColor = this.settings.missions[this.state.currentMissionIndex].color;
        const total = this.state.timer.initialSeconds || (this.state.timer.isBreak ?
            (this.settings.durations.breakMinutes || 3) * 60 :
            (this.settings.durations.workMinutes || 28) * 60);
        const rem = Math.max(0, this.timerManager.timeRemainingSeconds());
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
                this.tray.setImage(img);
            } catch { }
            try { off.destroy(); } catch { }
            cb();
        };
        off.webContents.once('did-finish-load', done);
    }

    getTray() {
        return this.tray;
    }
}

module.exports = { TrayManager };

