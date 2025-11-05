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


    getTodayDateString() {
        return this.stateManager.getTodayDateString();
    }

    isInMinuteTrackingWindow() {
        const now = new Date();
        const seconds = now.getSeconds();
        return seconds >= 5 && seconds <= 15;
    }

    incrementDailyMinute() {
        // Mission tracking removed - no-op
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
            (this.settings.durations.breakMinutes) :
            (this.settings.durations.workMinutes);
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

