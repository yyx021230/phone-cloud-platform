export const SCREEN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const SCREEN_IDLE_DECISION_MS = 10 * 1000;

export class ScreenInactivityGuard {
  constructor({
    idleMs = SCREEN_IDLE_TIMEOUT_MS,
    decisionMs = SCREEN_IDLE_DECISION_MS,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    setTicker = (callback, delay) => setInterval(callback, delay),
    clearTicker = (timer) => clearInterval(timer),
    onWarning = () => {},
    onCountdown = () => {},
    onTimeout = () => {}
  } = {}) {
    this.idleMs = Math.max(1, Number(idleMs) || SCREEN_IDLE_TIMEOUT_MS);
    this.decisionMs = Math.max(1, Number(decisionMs) || SCREEN_IDLE_DECISION_MS);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setTicker = setTicker;
    this.clearTicker = clearTicker;
    this.onWarning = onWarning;
    this.onCountdown = onCountdown;
    this.onTimeout = onTimeout;
    this.active = false;
    this.warningOpen = false;
    this.idleDeadline = 0;
    this.decisionDeadline = 0;
    this.idleTimer = null;
    this.decisionTimer = null;
    this.countdownTicker = null;
    this.lastCountdownSecond = null;
  }

  start() {
    this.stop();
    this.active = true;
    this.#scheduleIdleDeadline();
  }

  activity() {
    if (!this.active || this.warningOpen) return false;
    this.#scheduleIdleDeadline();
    return true;
  }

  continueSession() {
    if (!this.active || !this.warningOpen) return false;
    this.#closeWarning();
    this.#scheduleIdleDeadline();
    return true;
  }

  stop() {
    const shouldCloseWarning = this.warningOpen;
    this.active = false;
    this.warningOpen = false;
    this.idleDeadline = 0;
    this.decisionDeadline = 0;
    this.#clearTimers();
    if (shouldCloseWarning) this.onWarning({ open: false, seconds: 0, progress: 0 });
  }

  reconcile() {
    if (!this.active) return;
    const currentTime = this.now();
    if (this.warningOpen) {
      if (currentTime >= this.decisionDeadline) {
        this.#expire();
        return;
      }
      this.#emitCountdown();
      return;
    }
    if (currentTime >= this.idleDeadline) this.#openWarning();
  }

  #scheduleIdleDeadline() {
    if (this.idleTimer !== null) this.clearTimer(this.idleTimer);
    this.idleDeadline = this.now() + this.idleMs;
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      this.reconcile();
    }, this.idleMs);
  }

  #openWarning() {
    if (!this.active || this.warningOpen) return;
    this.warningOpen = true;
    this.decisionDeadline = this.now() + this.decisionMs;
    this.lastCountdownSecond = null;
    this.onWarning({ open: true, ...this.#countdownState() });
    this.#emitCountdown();
    this.decisionTimer = this.setTimer(() => {
      this.decisionTimer = null;
      this.reconcile();
    }, this.decisionMs);
    this.countdownTicker = this.setTicker(() => this.reconcile(), 250);
  }

  #closeWarning() {
    this.warningOpen = false;
    this.decisionDeadline = 0;
    if (this.decisionTimer !== null) this.clearTimer(this.decisionTimer);
    if (this.countdownTicker !== null) this.clearTicker(this.countdownTicker);
    this.decisionTimer = null;
    this.countdownTicker = null;
    this.lastCountdownSecond = null;
    this.onWarning({ open: false, seconds: 0, progress: 0 });
  }

  #emitCountdown() {
    if (!this.active || !this.warningOpen) return;
    const countdown = this.#countdownState();
    if (countdown.seconds === this.lastCountdownSecond) return;
    this.lastCountdownSecond = countdown.seconds;
    this.onCountdown(countdown);
  }

  #countdownState() {
    const remainingMs = Math.max(0, this.decisionDeadline - this.now());
    return {
      seconds: Math.max(0, Math.ceil(remainingMs / 1000)),
      progress: Math.min(1, remainingMs / this.decisionMs)
    };
  }

  #expire() {
    if (!this.active || !this.warningOpen) return;
    this.active = false;
    this.warningOpen = false;
    this.idleDeadline = 0;
    this.decisionDeadline = 0;
    this.#clearTimers();
    this.onWarning({ open: false, seconds: 0, progress: 0 });
    this.onTimeout();
  }

  #clearTimers() {
    if (this.idleTimer !== null) this.clearTimer(this.idleTimer);
    if (this.decisionTimer !== null) this.clearTimer(this.decisionTimer);
    if (this.countdownTicker !== null) this.clearTicker(this.countdownTicker);
    this.idleTimer = null;
    this.decisionTimer = null;
    this.countdownTicker = null;
    this.lastCountdownSecond = null;
  }
}
