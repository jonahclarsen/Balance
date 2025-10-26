const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_SETTINGS = {
    missions: [
        { name: 'Pink Mission', theme: 'pink', targetPercent: 50, untracked: false, deleted: false },
        { name: 'Green Mission', theme: 'green', targetPercent: 50, untracked: false, deleted: false },
        { name: 'Other', theme: 'neutral', targetPercent: 0, untracked: true, deleted: false }
    ],
    acceptableHourRange: 6,
    durations: { workMinutes: 30, breakMinutes: 3 },
};

const DEFAULT_STATE = {
    currentMissionIndex: 0,
    timer: { running: false, isBreak: false, remainingSeconds: 0, endTs: 0, initialSeconds: 0 },
    lastEnded: null,
    dailyMinutes: {} // Structure: {"mission_0": {"2025-01-01": 4}, "mission_1": {"2025-01-01": 2}}
};

class StateManager {
    constructor() {
        this.settings = { ...DEFAULT_SETTINGS };
        this.state = { ...DEFAULT_STATE };
        this.dataFilePath = '';
        this.lastBackupDate = '';
        this.saveInterval = null;
    }

    getUserDir() {
        return app.getPath('userData');
    }

    ensureDataDir() {
        const dir = this.getUserDir();
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
        return dir;
    }

    getDataFilePath() {
        const dir = this.ensureDataDir();
        return path.join(dir, 'balance.json');
    }

    getBackupDir() {
        return path.join(this.getUserDir(), 'config_backups');
    }

    getTodayDateString() {
        const today = new Date();
        return today.getFullYear() + '-' +
            String(today.getMonth() + 1).padStart(2, '0') + '-' +
            String(today.getDate()).padStart(2, '0');
    }

    maybeBackupDaily() {
        try {
            const srcPath = this.dataFilePath || this.getDataFilePath();
            const today = this.getTodayDateString();
            if (this.lastBackupDate === today) return;

            const backupDir = this.getBackupDir();
            try { fs.mkdirSync(backupDir, { recursive: true }); } catch { }
            const destPath = path.join(backupDir, `balance-${today}.json`);
            try {
                fs.copyFileSync(srcPath, destPath, fs.constants.COPYFILE_EXCL);
                this.lastBackupDate = today;
            } catch (e) {
                if (e && e.code === 'EEXIST') {
                    // Backup for today already exists; mark as done to avoid checks
                    this.lastBackupDate = today;
                }
            }
        } catch (e) {
            // Swallow errors to avoid impacting primary save flow
        }
    }

    loadData() {
        try {
            const p = this.getDataFilePath();
            this.dataFilePath = p;
            if (fs.existsSync(p)) {
                const json = JSON.parse(fs.readFileSync(p, 'utf-8'));
                this.settings = json.settings;
                this.state = json.state;
            } else {
                this.saveData();
            }
        } catch (e) {
            console.error('Failed to load data:', e);
        }
    }

    saveData() {
        try {
            const p = this.getDataFilePath();
            this.dataFilePath = p;
            const payload = { settings: this.settings, state: this.state };
            fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf-8');
            this.maybeBackupDaily();
        } catch (e) {
            console.error('Failed to save data:', e);
        }
    }

    startAutoSave() {
        if (this.saveInterval) clearInterval(this.saveInterval);
        // Save every 2 minutes
        this.saveInterval = setInterval(() => this.saveData(), 2 * 60 * 1000);
    }

    stopAutoSave() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
            this.saveInterval = null;
        }
    }

    normalizeTargetPercents(missions) {
        // Normalize target percentages for tracked missions to sum to exactly 100%
        const trackedMissions = missions.filter(m => !m.untracked && !m.deleted);
        if (trackedMissions.length === 0) return;

        const total = trackedMissions.reduce((sum, m) => sum + m.targetPercent, 0);
        if (total === 0) {
            // If all zeros, distribute equally using largest remainder method
            const base = Math.floor(100 / trackedMissions.length);
            const remainder = 100 - (base * trackedMissions.length);
            trackedMissions.forEach((m, i) => {
                m.targetPercent = base + (i < remainder ? 1 : 0);
            });
        } else {
            // Normalize to 100% using largest remainder method
            // 1. Calculate normalized values and floor them
            const normalized = trackedMissions.map(m => (m.targetPercent / total) * 100);
            const floored = normalized.map(v => Math.floor(v));
            const fractionals = normalized.map((v, i) => ({ index: i, frac: v - floored[i] }));

            // 2. Calculate deficit
            const flooredSum = floored.reduce((sum, v) => sum + v, 0);
            const deficit = 100 - flooredSum;

            // 3. Sort by fractional part (largest first) and distribute deficit
            fractionals.sort((a, b) => b.frac - a.frac);
            const final = [...floored];
            for (let i = 0; i < deficit; i++) {
                final[fractionals[i].index]++;
            }

            // 4. Assign back to missions
            trackedMissions.forEach((m, i) => {
                m.targetPercent = final[i];
            });
        }
    }

    updateSettings(nextSettings) {
        const prevDir = this.getUserDir();
        this.settings = { ...this.settings, ...nextSettings };

        // Normalize target percentages
        this.normalizeTargetPercents(this.settings.missions);

        const newDir = this.getUserDir();
        if (newDir !== prevDir) {
            try { fs.mkdirSync(newDir, { recursive: true }); } catch { }
            const newPath = path.join(newDir, 'balance.json');
            fs.writeFileSync(newPath, JSON.stringify({ settings: this.settings, state: this.state }, null, 2), 'utf-8');
            this.dataFilePath = newPath;
        } else {
            this.saveData();
        }
    }
}

module.exports = { StateManager, DEFAULT_SETTINGS };

