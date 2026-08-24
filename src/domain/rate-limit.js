// In-memory sliding-window rate limiter. Counters live in this process only: correct
// for the current single-instance deployment, and must move to Redis (or another
// shared store) before the web app runs more than one replica.
export class SlidingWindowRateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.lastPruneMs = 0;
  }

  consume(key, nowMs = Date.now()) {
    this.maybePrune(nowMs);
    const timestamps = this.live(key, nowMs);
    if (timestamps.length >= this.max) {
      this.hits.set(key, timestamps);
      return { allowed: false, retryAfterMs: timestamps[0] + this.windowMs - nowMs };
    }
    timestamps.push(nowMs);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  }

  // Read the budget without spending it, so a caller can reject an over-budget request
  // up front while charging the counter only for the outcomes it actually wants to
  // limit — failed logins, say, leaving successful ones free.
  check(key, nowMs = Date.now()) {
    const timestamps = this.live(key, nowMs);
    if (timestamps.length >= this.max) {
      return { allowed: false, retryAfterMs: timestamps[0] + this.windowMs - nowMs };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  // Timestamps still inside the window, oldest first.
  live(key, nowMs) {
    const cutoff = nowMs - this.windowMs;
    return (this.hits.get(key) || []).filter((at) => at > cutoff);
  }

  maybePrune(nowMs) {
    if (nowMs - this.lastPruneMs < this.windowMs) return;
    this.lastPruneMs = nowMs;
    const cutoff = nowMs - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const alive = timestamps.filter((at) => at > cutoff);
      if (alive.length) this.hits.set(key, alive);
      else this.hits.delete(key);
    }
  }
}
