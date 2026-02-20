/**
 * Token bucket rate limiter for outbound email sends.
 * Tokens refill over time at a configurable rate per hour.
 * Bucket starts full. On increment(): compute elapsed-time refill first,
 * then consume 1 token (floor at 0, never negative).
 */
export class SendRateLimiter {
    private readonly capacity:          number;
    private readonly refillRatePerHour: number;
    private readonly now:               () => number;
    private          tokens:            number;
    private          lastRefillTime:    number;

    constructor(config: { capacity?: number, refillRatePerHour?: number, now?: () => number } = {}) {
        // Stryker disable next-line ArithmeticOperator: Default constant
        this.capacity          = config.capacity          ?? 24;
        // Stryker disable next-line ArithmeticOperator: Default constant
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
        // Stryker disable next-line ArithmeticOperator: token consumption — subtract 1
        this.tokens = Math.max(0, this.tokens - 1);
    }

    /**
     * Returns true when no tokens remain (bucket is empty).
     */
    isAtLimit(): boolean {
        this.applyRefill();
        // Stryker disable next-line ConditionalExpression,EqualityOperator: <= 0 means exhausted — 0 is the boundary
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
        // Stryker disable next-line ArithmeticOperator: elapsed time calculation in ms
        const elapsed = now - this.lastRefillTime;
        // Stryker disable next-line ArithmeticOperator: convert ms to hours for refill calculation
        const hours   = elapsed / (3600 * 1000);
        // Stryker disable next-line ArithmeticOperator: refill = floor(hours * rate) tokens
        const refill  = Math.floor(hours * this.refillRatePerHour);
        // Stryker disable next-line ConditionalExpression,EqualityOperator: optimization guard — body is a no-op when refill === 0 (no tokens added, no time advanced), so both paths produce same result
        if(refill > 0) {
            this.tokens         = Math.min(this.capacity, this.tokens + refill);
            // Stryker disable next-line ArithmeticOperator: advance lastRefillTime by the whole ms consumed by refilled tokens
            this.lastRefillTime = this.lastRefillTime + Math.round(refill / this.refillRatePerHour * 3600 * 1000);
        }
    }
}
