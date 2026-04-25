/**
 * Tests for no-cross-module-internal rule behaviour around aliased re-exports.
 *
 * The rule delegates the @internal-tag lookup to `isExportInternal` from
 * `_ts-helpers.mjs`.  The bug this file guards against:
 *
 *   Source module has:  /** @internal * / export { internalFn as publicAlias } from './deeper'
 *   Importer does:      import { publicAlias } from '@/SourceModule'
 *
 * `isExportInternal(sourceFile, 'publicAlias')` must return true.  The buggy
 * code compared against `element.propertyName` (the pre-alias name, 'internalFn')
 * instead of `element.name` (the post-alias/exported name, 'publicAlias'), so it
 * silently returned false.
 *
 * We test `isExportInternal` directly here because the full RuleTester path for
 * `no-cross-module-internal` requires fixture files under `src/` paths for the
 * module-boundary detection to work.  A direct unit test of the helper is more
 * targeted and equally valid as a regression guard.
 */
import { describe, expect, it } from 'bun:test';
import ts from 'typescript';
import { isExportInternal } from '../../../../tools/eslint-rules/_ts-helpers.mjs';

/**
 * Helper: parse a TypeScript source string into a SourceFile so we can call
 * `isExportInternal` without needing a real file on disk or a full Program.
 */
function parseSource(code: string): ts.SourceFile {
    return ts.createSourceFile(
        'test.ts',
        code,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TS
    );
}

describe('isExportInternal — aliased re-export regression', () => {
    // ── Happy-path: plain named exports still work after the fix ─────────────

    it('returns true for a plain @internal function declaration', () => {
        const src = parseSource(`
/** @internal */
export function internalFn(): string { return 'x'; }
        `);
        expect(isExportInternal(src, 'internalFn')).toBe(true);
    });

    it('returns false for a public function declaration', () => {
        const src = parseSource(`
export function publicFn(): string { return 'x'; }
        `);
        expect(isExportInternal(src, 'publicFn')).toBe(false);
    });

    // ── Core regression: re-export with alias ─────────────────────────────────
    //
    // Source:   /** @internal */ export { internalFn as publicAlias } from './deeper'
    // Lookup:   isExportInternal(src, 'publicAlias')
    //
    // Buggy code used (element.propertyName ?? element.name).text which resolves
    // to 'internalFn' — doesn't match 'publicAlias' → returns false (BUG).
    // Fixed code uses element.name.text which resolves to 'publicAlias' → matches.
    //
    // NOTE: avoid putting '@internal' in comment text (not tagged with @) — the
    // TypeScript JSDoc parser treats any occurrence of the text "@internal" in a
    // comment as an @internal tag, which would make "not internal" comments appear
    // internal.  Use "not tagged internal" or "public" wording instead.

    it('returns true when looking up the POST-alias exported name of an @internal re-export', () => {
        const src = parseSource(`
/** @internal */
export { internalFn as publicAlias } from './deeper';
        `);
        // publicAlias is the *exported* name — what callers import
        expect(isExportInternal(src, 'publicAlias')).toBe(true);
    });

    it('returns false when looking up the PRE-alias original name of an @internal re-export', () => {
        // 'internalFn' is not the name callers see; the exported name is 'publicAlias'.
        const src = parseSource(`
/** @internal */
export { internalFn as publicAlias } from './deeper';
        `);
        // Callers never see 'internalFn' — only 'publicAlias' is exported
        expect(isExportInternal(src, 'internalFn')).toBe(false);
    });

    it('returns false for a public (not tagged internal) aliased re-export', () => {
        const src = parseSource(`
/** Public re-export with alias */
export { internalFn as publicAlias } from './deeper';
        `);
        expect(isExportInternal(src, 'publicAlias')).toBe(false);
    });

    it('handles a file with mixed tagged-internal and public aliased re-exports', () => {
        const src = parseSource(`
/** @internal */
export { internalFn as publicAlias } from './deeper';

/** Public aliased re-export */
export { otherFn as anotherAlias } from './deeper';
        `);
        expect(isExportInternal(src, 'publicAlias')).toBe(true);
        expect(isExportInternal(src, 'anotherAlias')).toBe(false);
    });

    // ── Edge case: no alias present (element.propertyName is undefined) ───────

    it('returns true for a plain (no alias) @internal re-export', () => {
        const src = parseSource(`
/** @internal */
export { internalFn } from './deeper';
        `);
        expect(isExportInternal(src, 'internalFn')).toBe(true);
    });
});
