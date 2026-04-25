/** Public function — not internal */
export function publicFunction(): string {
    return 'public';
}

/**
 * Internal implementation detail — do not import directly.
 * @internal
 */
export function internalFunction(): string {
    return 'internal';
}

/**
 * Internal class.
 * @internal
 */
export class InternalClass {
    method(): void {
        // nothing
    }
}

/**
 * Internal constant.
 * @internal
 */
export const INTERNAL_CONST = 99;
