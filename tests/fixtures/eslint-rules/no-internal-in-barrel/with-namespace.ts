/* eslint-disable @typescript-eslint/no-namespace -- fixture intentionally uses namespaces to test isModuleDeclaration handling */

/** Public namespace — not internal */
export namespace PublicNamespace {
    export function foo(): string {
        return 'public';
    }
}

/**
 * Internal namespace — do not re-export.
 * @internal
 */
export namespace InternalNs {
    export function bar(): string {
        return 'internal';
    }
}
