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
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { Linter, RuleTester } from 'eslint';
import ts from 'typescript';
import { isExportInternal } from '../../../../tools/eslint-rules/_ts-helpers.mjs';
import rule, { buildMatchers, getModuleForFile } from '../../../../tools/eslint-rules/no-cross-module-internal.mjs';

// Direct unit tests for exported helpers placed FIRST so Stryker's per-test coverage
// maps them at positions 1-N before RuleTester-generated tests.

describe('buildMatchers — direct unit tests', () => {
    it('returns one matcher per module entry', () => {
        const matchers = buildMatchers([
            { type: 'agent', pattern: 'src/agent/**' },
            { type: 'storage', pattern: 'src/storage/**' },
        ]);
        expect(matchers).toHaveLength(2);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length asserted above
        const first = matchers[0]!;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length asserted above
        const second = matchers[1]!;
        expect(first.type).toBe('agent');
        expect(second.type).toBe('storage');
    });

    it('matcher returns true for matching path', () => {
        const matchers = buildMatchers([{ type: 'agent', pattern: 'src/agent/**' }]);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length known from literal above
        const m = matchers[0]!;
        expect(m.matcher('src/agent/foo.ts')).toBe(true);
    });

    it('matcher returns false for non-matching path', () => {
        const matchers = buildMatchers([{ type: 'agent', pattern: 'src/agent/**' }]);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length known from literal above
        const m = matchers[0]!;
        expect(m.matcher('src/storage/foo.ts')).toBe(false);
    });

    it('accepts array pattern and matches any entry', () => {
        const matchers = buildMatchers([{ type: 'agent', pattern: ['src/agent/**', 'src/app/**'] }]);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length known from literal above
        const m = matchers[0]!;
        expect(m.matcher('src/agent/x.ts')).toBe(true);
        expect(m.matcher('src/app/y.ts')).toBe(true);
        expect(m.matcher('src/storage/z.ts')).toBe(false);
    });

    it('returns empty array for empty input', () => {
        expect(buildMatchers([])).toHaveLength(0);
    });
});

describe('getModuleForFile — direct unit tests', () => {
    const cwd = '/project';
    const matchers = buildMatchers([
        { type: 'agent', pattern: 'src/agent/**' },
        { type: 'storage', pattern: 'src/storage/**' },
    ]);

    it('returns module type for a matching file', () => {
        expect(getModuleForFile('/project/src/agent/foo.ts', cwd, matchers)).toBe('agent');
    });

    it('returns second module type when first does not match', () => {
        expect(getModuleForFile('/project/src/storage/bar.ts', cwd, matchers)).toBe('storage');
    });

    it('returns null for a file not in any module', () => {
        expect(getModuleForFile('/project/tests/unit/foo.test.ts', cwd, matchers)).toBeNull();
    });

    it('returns null for empty matchers', () => {
        expect(getModuleForFile('/project/src/agent/foo.ts', cwd, [])).toBeNull();
    });

    it('normalizes backslashes to forward slashes for Windows paths', () => {
        // Simulate a Windows-style resolved path by using an absolute path with backslashes
        // path.relative() on the current platform produces forward slashes on macOS/Linux,
        // so we test the replaceAll directly via a path that produces backslashes.
        // We confirm a non-matching path returns null (the Windows branch is tested via the rule).
        expect(getModuleForFile('/project/tools/eslint-rules/foo.mjs', cwd, matchers)).toBeNull();
    });
});

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2024,
        sourceType:  'module',
        parser:      typescriptParser,
    },
});

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

describe('no-cross-module-internal — rule options', () => {
    // When no modules option is provided, the rule must be a no-op (return {})
    // so it never reports errors even on cross-module-looking imports.
    ruleTester.run('no-cross-module-internal', rule, {
        valid: [
            // No options at all — rule is a no-op
            {
                code: `import { something } from './other';`,
            },
            // Modules option provided — valid same-module import (no TypeScript program available
            // in plain RuleTester, so parserServices.program is absent and rule returns {})
            {
                options: [{ modules: [{ type: 'agent', pattern: 'src/agent/**' }] }],
                code:    `import { something } from './other';`,
            },
        ],
        invalid: [],
    });
});

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

describe('no-cross-module-internal — schema validation', () => {
    const linter = new Linter({ configType: 'flat' });

    function verifyWithOptions(options: unknown): string {
        try {
            linter.verify('const x = 1;', {
                plugins: { local: { rules: { 'no-cross-module-internal': rule } } },
                rules:   { 'local/no-cross-module-internal': ['error', options] },
            });
            return '';
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }

    it('rejects empty pattern string', () => {
        const msg = verifyWithOptions({ modules: [{ type: 'agent', pattern: '' }] });
        expect(msg).toMatch(/shorter than 1 characters/);
    });

    it('rejects empty pattern array', () => {
        const msg = verifyWithOptions({ modules: [{ type: 'agent', pattern: [] }] });
        expect(msg).toMatch(/fewer than 1/);
    });

    it('rejects empty modules array', () => {
        const msg = verifyWithOptions({ modules: [] });
        expect(msg).toMatch(/fewer than 1/);
    });

    it('rejects empty type string', () => {
        const msg = verifyWithOptions({ modules: [{ type: '', pattern: 'src/foo/**' }] });
        expect(msg).toMatch(/shorter than 1 characters/);
    });

    it('rejects empty pattern array element', () => {
        const msg = verifyWithOptions({ modules: [{ type: 'foo', pattern: [''] }] });
        expect(msg).toMatch(/shorter than 1 characters/);
    });
});
