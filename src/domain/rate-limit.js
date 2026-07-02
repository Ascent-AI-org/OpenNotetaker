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
    const cutoff = nowMs - this.windowMs;
    const timestamps = (this.hits.get(key) || []).filter((at) => at > cutoff);
    if (timestamps.length >= this.max) {
      this.hits.set(key, timestamps);
      return { allowed: false, retryAfterMs: timestamps[0] + this.windowMs - nowMs };
    }
    timestamps.push(nowMs);
    this.hits.set(key, timestamps);
    return { allowed: true, retryAfterMs: 0 };
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
