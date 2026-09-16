/**
 * Token bucket rate limiter.
 * Tokens refill over time at a configurable rate per hour.
 * Bucket starts full. On increment(): compute elapsed-time refill first,
 * then consume 1 token (floor at 0, never negative).
 */
export class TokenBucketRateLimiter {
    private readonly capacity:          number;
    private readonly refillRatePerHour: number;
    private readonly now:               () => number;
    private          tokens:            number;
    private          lastRefillTime:    number;

    constructor(config: { capacity?: number, refillRatePerHour?: number, now?: () => number } = {}) {
        this.capacity          = config.capacity          ?? 24;
        this.refillRatePerHour = config.refillRatePerHour ?? 1;
        this.now               = config.now               ?? (() => Date.now());
        this.tokens            = this.capacity;
        this.lastRefillTime    = this.now();
    }

    /**
     * Consume 1 token. Applies elapsed-time refill first, then decrements.
     * Tokens are floored at 0 (never negative).
     */
    increment(): void {
        this.applyRefill();
        this.tokens = Math.max(0, this.tokens - 1);
    }

    /**
     * Returns true when no tokens remain (bucket is empty).
     */
    isAtLimit(): boolean {
        this.applyRefill();
        return this.tokens <= 0;
    }

    /**
     * Returns the current number of tokens remaining.
     */
    tokensRemaining(): number {
        this.applyRefill();
        return this.tokens;
    }

    private applyRefill(): void {
        const now     = this.now();
        const elapsed = now - this.lastRefillTime;
        const hours   = elapsed / (3600 * 1000);
        const refill  = Math.max(0, Math.floor(hours * this.refillRatePerHour));
        this.tokens = Math.min(this.capacity, this.tokens + refill);
        // A zero refill consumes no elapsed time, including when refill is disabled with a zero rate.
        this.lastRefillTime += Math.round(refill / this.refillRatePerHour * 3600 * 1000) || 0;
    }
}
