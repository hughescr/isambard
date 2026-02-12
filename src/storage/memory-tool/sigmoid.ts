/**
 * Sigmoid scoring for memory prioritization
 *
 * Combines frequency (access count) and recency (time since last access)
 * into a single priority score using sigmoid activation and exponential decay.
 */

/**
 * Parameters for the sigmoid scoring function
 */
export interface SigmoidParams {
    /**
     * Steepness of the sigmoid curve (default: 0.5)
     * Higher values create a steeper transition at the midpoint
     */
    steepness: number

    /**
     * Midpoint of the sigmoid curve in access count (default: 5)
     * The access count where frequency score = 0.5
     */
    midpoint: number

    /**
     * Decay rate for recency (default: ln(2) / 7 days in ms)
     * Controls how quickly old memories lose priority
     * Default gives a 7-day half-life
     */
    lambda: number
}

/* Stryker disable ObjectLiteral: Sigmoid parameter defaults — config values are not behavioral */
/**
 * Default parameters for sigmoid scoring
 */
export const DEFAULT_SIGMOID_PARAMS: SigmoidParams = {
    steepness: 0.5,
    midpoint:  5,
    lambda:    Math.LN2 / (7 * 24 * 60 * 60 * 1000), // 7-day half-life in milliseconds
};
/* Stryker restore ObjectLiteral */

/**
 * Calculate priority score using sigmoid activation and exponential decay
 *
 * @param accessCount - Number of times the memory has been accessed
 * @param timeSinceLastAccessMs - Time in milliseconds since last access
 * @param params - Optional custom sigmoid parameters (merges with defaults)
 * @returns Priority score between 0 and 1
 *
 * @example
 * ```typescript
 * // Recent, frequently accessed memory
 * sigmoidScore(10, 0); // ~0.99 (high priority)
 *
 * // Old, rarely accessed memory
 * sigmoidScore(2, 30 * 24 * 60 * 60 * 1000); // very low (30 days old, low access count)
 *
 * // Custom parameters
 * sigmoidScore(5, 0, { steepness: 1.0, midpoint: 10 }); // shifted midpoint
 * ```
 */
export function sigmoidScore(
    accessCount: number,
    timeSinceLastAccessMs: number,
    params?: Partial<SigmoidParams>
): number {
    const { steepness, midpoint, lambda } = { ...DEFAULT_SIGMOID_PARAMS, ...params };

    // Clamp inputs to prevent nonsensical scores from negative values or clock skew
    const clampedCount = Math.max(0, accessCount);
    const clampedTime = Math.max(0, timeSinceLastAccessMs);

    // Frequency component: sigmoid activation
    // 1 / (1 + e^(-steepness * (clampedCount - midpoint)))
    const frequencyScore = 1 / (1 + Math.exp(-steepness * (clampedCount - midpoint)));

    // Recency component: exponential decay
    // e^(-lambda * clampedTime)
    const recencyDecay = Math.exp(-lambda * clampedTime);

    // Combined score
    return frequencyScore * recencyDecay;
}
