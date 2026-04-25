/** Public function — not internal */
export function publicFunction(): string {
    return 'public';
}

/** Public class — not internal */
export class PublicClass {
    method(): void {
        // nothing
    }
}

/** Public const — not internal */
export const PUBLIC_CONST = 42;
