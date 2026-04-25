import { describe } from 'bun:test';
import path from 'node:path';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import rule from '../../../../tools/eslint-rules/no-internal-in-barrel.mjs';

// The fixture directory is next to this test's fixture files
const fixturesDir = path.resolve(import.meta.dir, '../../../fixtures/eslint-rules/no-internal-in-barrel');

// RuleTester with TypeScript type-checking via project service, pointed at the fixture dir.
// The fixture files (public-only.ts, with-internal.ts) are the "source" modules that barrels re-export from.
const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion:   2024,
        sourceType:    'module',
        parser:        typescriptParser,
        parserOptions: {
            projectService: {
                // Allow test fixture files not explicitly included in any tsconfig.
                // Must include all eslint-rules fixture directories to avoid conflicts when
                // multiple rule test files run in the same bun process (projectService is a singleton).
                allowDefaultProject: [
                    'tests/fixtures/eslint-rules/no-internal-in-barrel/*.ts',
                    'tests/fixtures/eslint-rules/no-star-export-from-non-barrel/*.ts',
                    'tests/fixtures/eslint-rules/no-star-export-from-non-barrel/sub/*.ts',
                    'tests/fixtures/eslint-rules/no-cross-module-internal/src/storage/*.ts',
                    'tests/fixtures/eslint-rules/no-cross-module-internal/src/agent/*.ts',
                ],
                defaultProject: path.resolve(import.meta.dir, '../../../../tsconfig.json'),
            },
            tsconfigRootDir: path.resolve(import.meta.dir, '../../../..'),
        },
    },
});

describe('no-internal-in-barrel', () => {
    // RuleTester.run() calls describe/it under the hood — that is the test.

    ruleTester.run('no-internal-in-barrel', rule, {
        valid: [
            // 1. Barrel re-exports something that is NOT @internal — no error
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { publicFunction } from './public-only';`,
            },
            // 2. Barrel re-exports a function with no JSDoc at all — no error
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { PublicClass } from './public-only';`,
            },
            // 3. Non-barrel file (not index.ts) — rule does nothing even if @internal exported
            {
                filename: path.join(fixturesDir, 'some-module.ts'),
                code:     `export { internalFunction } from './with-internal';`,
            },
            // 4. Barrel with only default export, not named re-exports — no error
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     'export default function defaultExport() { return 42; }',
            },
            // 5. Barrel re-exports a public member mixed with an internal-containing file — only public exported
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { publicFunction } from './with-internal';`,
            },
            // 6. Star re-export — rule skips (cannot enumerate exported names)
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export * from './with-internal';`,
            },
            // 7. External package re-export — rule skips (not a relative import)
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { something } from 'some-external-package';`,
            },
            // 8. Type-only re-export of a public type — no error
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export type { PublicClass } from './public-only';`,
            },
            // 9. Namespace re-export of a public namespace — no error (Task 3)
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { PublicNamespace } from './with-namespace';`,
            },
            // 10. Default re-export aliased to a public name — no error (Task 4)
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { default as PublicThing } from './with-default';`,
            },
            // 11. Barrel re-exports a name that the source file re-exports with alias but WITHOUT @internal — no error
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { publicNonInternalAlias } from './with-aliased-reexport';`,
            },
        ],

        invalid: [
            // 1. Barrel re-exports an @internal function — reports on the specifier
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { internalFunction } from './with-internal';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'internalFunction' } }],
            },
            // 2. Barrel re-exports an @internal class — reports
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { InternalClass } from './with-internal';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'InternalClass' } }],
            },
            // 3. Barrel re-exports an @internal const declaration — reports
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { INTERNAL_CONST } from './with-internal';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'INTERNAL_CONST' } }],
            },
            // 4. Barrel re-exports several names, one is @internal, others not — reports only the @internal one
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { publicFunction, internalFunction, INTERNAL_CONST } from './with-internal';`,
                errors:   [
                    { messageId: 'internalInBarrel', data: { name: 'internalFunction' } },
                    { messageId: 'internalInBarrel', data: { name: 'INTERNAL_CONST' } },
                ],
            },
            // 5. Aliased export of an @internal — alias doesn't hide @internal tag
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { internalFunction as exposedFunction } from './with-internal';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'internalFunction' } }],
            },
            // 6. Type-only re-export of an @internal — still flagged
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export type { InternalClass } from './with-internal';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'InternalClass' } }],
            },
            // 7. Barrel re-exports an @internal namespace — reports (Task 3)
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { InternalNs } from './with-namespace';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'InternalNs' } }],
            },
            // 8. Barrel re-exports @internal default export via alias — reports (Task 4)
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { default as InternalThing } from './with-internal-default';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'default' } }],
            },
            // 9. Regression: barrel re-exports a name that the SOURCE FILE re-exports with an alias.
            //    `with-aliased-reexport.ts` has:  /** @internal */ export { internalFn as publicAlias } ...
            //    The barrel exports `publicAlias` — rule must detect the @internal tag on the
            //    re-export statement even when element.propertyName != element.name (alias present).
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { publicAlias } from './with-aliased-reexport';`,
                errors:   [{ messageId: 'internalInBarrel', data: { name: 'publicAlias' } }],
            },
        ],
    });
});
