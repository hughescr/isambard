// Fixture: no module-scope let/var — per-request state is threaded through an
// explicit argument instead of ambient mutable module state. Function-scoped
// `let` (inside a loop, say) is fine and must not be flagged.
// This file is scanned by tests/unit/tools/ast-grep-rules.test.ts and is expected
// to pass cleanly; it is not part of the production build.

const DEFAULT_USER_ID = 'system';

export function resolveUserId(requestingUserId?: string): string {
    let resolved = DEFAULT_USER_ID;
    if(requestingUserId) {
        resolved = requestingUserId;
    }
    return resolved;
}
