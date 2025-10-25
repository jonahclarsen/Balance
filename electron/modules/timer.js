const { app } = require('electron');

class TimerManager {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this.tickInterval = null;
        this.minuteTrackingInterval = null;
        this.onTick = null; // Callback when timer updates
        this.onEnd = null; // Callback when timer ends
    }

    get state() {
        return this.stateManager.state;
    }

    get settings() {
        return this.stateManager.settings;
    }

    timeRemainingSeconds() {
        if (!this.state.timer.running) return this.state.timer.remainingSeconds || 0;
        const rem = Math.max(0, Math.floor((this.state.timer.endTs - Date.now()) / 1000));
        return rem;
    }

    secondsToMinutesFloor(seconds) {
        return Math.max(0, Math.floor(seconds / 60));
    }

    getTotalMinutesForMission(missionIndex) {
        const missionKey = `mission_${missionIndex}`;
        const missionData = this.state.dailyMinutes[missionKey];
        if (!missionData) return 0;

        return Object.values(missionData).reduce((total, dayMinutes) => total + dayMinutes, 0);
    }

    getOutOfBalanceHoursAbs() {
        // Only calculate balance for tracked missions (exclude untracked mission)
        const totalMinutes0 = this.getTotalMinutesForMission(0);
        const totalMinutes1 = this.getTotalMinutesForMission(1);
        const diffMinutes = Math.abs(totalMinutes0 - totalMinutes1);
        return Math.round(diffMinutes / 60);
    }

    getOutOfBalanceSign() {
        // Only calculate balance for tracked missions (exclude untracked mission)
        const totalMinutes0 = this.getTotalMinutesForMission(0);
        const totalMinutes1 = this.getTotalMinutesForMission(1);
        const d = totalMinutes0 - totalMinutes1;
        return d === 0 ? 0 : (d > 0 ? 1 : -1); // 1 => pink has more, -1 => green has more
    }

    isWithinAcceptableRange() {
        const diffHours = this.getOutOfBalanceHoursAbs();
        return diffHours <= (this.settings.acceptableHourRange || 6);
    }

    getTodayDateString() {
        return this.stateManager.getTodayDateString();
    }

    isInMinuteTrackingWindow() {
        const now = new Date();
        const seconds = now.getSeconds();
        return seconds >= 5 && seconds <= 15;
    }

    incrementDailyMinute() {
        if (!this.state.timer.running || this.state.timer.isBreak) return;

        const today = this.getTodayDateString();
        const missionKey = `mission_${this.state.currentMissionIndex}`;

        // Initialize structure if needed
        if (!this.state.dailyMinutes) {
            this.state.dailyMinutes = {};
        }
        if (!this.state.dailyMinutes[missionKey]) {
            this.state.dailyMinutes[missionKey] = {};
        }
        if (!this.state.dailyMinutes[missionKey][today]) {
            this.state.dailyMinutes[missionKey][today] = 0;
        }

        // Increment today's minute count
        this.state.dailyMinutes[missionKey][today]++;

        // Save the updated data
        this.stateManager.saveData();
        if (this.onTick) this.onTick();
    }

    startMinuteTracking() {
        if (this.minuteTrackingInterval) clearTimeout(this.minuteTrackingInterval);

        const scheduleNext = () => {
            if (this.isInMinuteTrackingWindow()) {
                // We're in the tracking window (x:05 to x:15)
                this.incrementDailyMinute();
                // Set timer to run again in 30 seconds
                this.minuteTrackingInterval = setTimeout(scheduleNext, 30000);
            } else {
                // We're outside the tracking window, check again in 5 seconds
                this.minuteTrackingInterval = setTimeout(scheduleNext, 5000);
            }
        };

        // Start the tracking cycle
        scheduleNext();
    }

    startTicking() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        this.tickInterval = setInterval(() => {
            if (this.state.timer.running) {
                const rem = this.timeRemainingSeconds();
                const lastRem = this.state.timer.remainingSeconds;
                this.state.timer.remainingSeconds = rem;
                if (rem <= 0) {
                    this.state.timer.running = false;
                    this.state.timer.endTs = 0;
                    this.state.lastEnded = {
                        isBreak: this.state.timer.isBreak,
                        missionIndex: this.state.currentMissionIndex,
                        ts: Date.now()
                    };
                    if (this.onEnd) this.onEnd();
                    try { app.beep(); } catch { }
                    // Flush to disk soon after end
                    setTimeout(() => this.stateManager.saveData(), 250);
                }
                if (lastRem !== rem && this.onTick) {
                    this.onTick();
                }
            }
        }, 1000);
    }

    startTimer(isBreak) {
        const minutes = isBreak ?
            (this.settings.durations.breakMinutes || 3) :
            (this.settings.durations.workMinutes || 28);
        this.state.timer.isBreak = !!isBreak;
        this.state.timer.running = true;
        this.state.timer.remainingSeconds = Math.max(0, Math.floor(minutes * 60));
        this.state.timer.initialSeconds = this.state.timer.remainingSeconds;
        this.state.timer.endTs = Date.now() + this.state.timer.remainingSeconds * 1000;
        this.state.lastEnded = null;
        if (this.onTick) this.onTick();
    }

    stopTimer() {
        this.state.timer.running = false;
        this.state.timer.endTs = 0;
        if (this.onTick) this.onTick();
    }

    pauseTimer() {
        // Pause only if currently running
        if (!this.state.timer.running) return;
        this.state.timer.remainingSeconds = this.timeRemainingSeconds();
        this.state.timer.running = false;
        this.state.timer.endTs = 0;
        // Keep initialSeconds as-is so progress visuals remain consistent
        if (this.onTick) this.onTick();
    }

    resumeTimer() {
        // Resume only if currently paused with time remaining
        if (this.state.timer.running) return;
        const next = Math.max(0, this.state.timer.remainingSeconds || 0);
        if (next <= 0) return;
        this.state.timer.endTs = Date.now() + next * 1000;
        this.state.timer.running = true;
        this.state.lastEnded = null;
        if (!this.state.timer.initialSeconds) this.state.timer.initialSeconds = next;
        if (this.onTick) this.onTick();
    }

    extendTimer(secondsDelta) {
        const delta = Math.floor(secondsDelta);
        const wasRunning = this.state.timer.running;
        if (wasRunning) {
            this.state.timer.endTs += delta * 1000;
            this.state.timer.remainingSeconds = this.timeRemainingSeconds();
        } else {
            const next = Math.max(0, (this.state.timer.remainingSeconds || 0) + delta);
            this.state.timer.remainingSeconds = next;
            // If timer had ended (lastEnded set) and user extends, auto-resume.
            // If it's just paused (no lastEnded), stay paused.
            if (next > 0 && this.state.lastEnded) {
                this.state.timer.endTs = Date.now() + next * 1000;
                this.state.timer.running = true;
                if (!this.state.timer.initialSeconds) this.state.timer.initialSeconds = next;
                this.state.lastEnded = null;
            } else {
                this.state.timer.endTs = 0;
                this.state.timer.running = false;
            }
        }
        if (this.onTick) this.onTick();
    }

    switchMission(idx) {
        this.state.currentMissionIndex = Math.max(0, Math.min(2, idx));
        if (this.onTick) this.onTick();
    }

    stop() {
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
        if (this.minuteTrackingInterval) {
            clearTimeout(this.minuteTrackingInterval);
            this.minuteTrackingInterval = null;
        }
    }
}

module.exports = { TimerManager };

