import { InvariantViolationError } from '@/errors';

/**
 * Exhaustiveness helper for discriminated union switch statements.
 *
 * When all cases of a discriminated union are handled, TypeScript's narrowing
 * ensures `x` has type `never` and this function is statically unreachable.
 * At runtime, if a value slips through (e.g., from an untyped boundary),
 * this throws with a clear diagnostic message.
 *
 * @param x       - The value that should have been narrowed to `never`.
 * @param message - Optional custom message; defaults to `Unexpected value: <json>`.
 *
 * @example
 * function platformLabel(p: KnownPlatform): string {
 *     switch (p) {
 *         case 'discord': return 'discord';
 *         case 'email':   return 'email';
 *         // Adding a new platform without a case here → compile error
 *         default: return assertNever(p);
 *     }
 * }
 */
export function assertNever(x: never, message?: string): never {
    const msg = message ?? `Unexpected value: ${String(x)}`;
    // Stryker disable next-line StringLiteral: invariant location label is informational only
    throw new InvariantViolationError('assertNever', msg);
}
