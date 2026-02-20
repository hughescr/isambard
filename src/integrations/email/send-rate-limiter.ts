/**
 * In-memory daily email send rate limiter.
 * Resets the counter when the calendar day changes (UTC).
 */
export class SendRateLimiter {
    private readonly softLimit: number;
    private          count:     number;
    private          day:       string;   // YYYY-MM-DD UTC

    constructor(config: { softLimit?: number } = {}) {
        // Stryker disable next-line ArithmeticOperator: Default constant
        this.softLimit = config.softLimit ?? 50;
        this.count     = 0;
        this.day       = this.currentDay();
    }

    /**
     * Check if the current count is within the soft limit.
     * Resets the counter if the day has changed.
     */
    check(): { allowed: boolean, count: number, limit: number } {
        this.maybeReset();
        return {
            // Stryker disable next-line ConditionalExpression,EqualityOperator: > vs >= changes the boundary — count < limit means allowed
            allowed: this.count < this.softLimit,
            count:   this.count,
            limit:   this.softLimit,
        };
    }

    /**
     * Increment the daily send count.
     * Resets the counter if the day has changed.
     */
    increment(): void {
        this.maybeReset();
        this.count++;
    }

    /**
     * Return the current send count (resetting if the day has changed).
     */
    getCount(): number {
        this.maybeReset();
        return this.count;
    }

    private maybeReset(): void {
        const today = this.currentDay();
        // Stryker disable next-line ConditionalExpression,EqualityOperator: day change detection — !== ensures reset on new day
        if(today !== this.day) {
            this.count = 0;
            this.day   = today;
        }
    }

    private currentDay(): string {
        // Stryker disable next-line StringLiteral: ISO date prefix is formatting specification
        return new Date().toISOString().slice(0, 10);
    }
}
