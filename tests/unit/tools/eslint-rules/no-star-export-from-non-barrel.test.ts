import { describe } from 'bun:test';
import path from 'node:path';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import rule from '../../../../tools/eslint-rules/no-star-export-from-non-barrel.mjs';

// The fixture directory is next to this test's fixture files
const fixturesDir = path.resolve(import.meta.dir, '../../../fixtures/eslint-rules/no-star-export-from-non-barrel');

// RuleTester with TypeScript type-checking via project service, pointed at the fixture dir.
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
                ],
                defaultProject: path.resolve(import.meta.dir, '../../../../tsconfig.json'),
            },
            tsconfigRootDir: path.resolve(import.meta.dir, '../../../..'),
        },
    },
});

describe('no-star-export-from-non-barrel', () => {
    // RuleTester.run() calls describe/it under the hood — that is the test.

    ruleTester.run('no-star-export-from-non-barrel', rule, {
        valid: [
            // 1. export * from a sub-directory barrel (index.ts) — barrel-of-barrels, allowed by default
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export * from './sub';`,
            },
            // 2. Non-barrel file (not index.ts) — rule doesn't apply; no error
            {
                filename: path.join(fixturesDir, 'some-module.ts'),
                code:     `export * from './regular-module';`,
            },
            // 3. External package star re-export — rule only checks relative imports
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export * from 'some-external-package';`,
            },
            // 4. Named re-export from a non-barrel — rule only fires on ExportAllDeclaration
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export { Foo } from './regular-module';`,
            },
        ],

        invalid: [
            // 5. Barrel uses export * from a regular (non-barrel) file — reports
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export * from './regular-module';`,
                errors:   [{ messageId: 'starFromNonBarrel', data: { source: './regular-module' } }],
            },
            // 6. Barrel uses export * from an unresolvable source — reports
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export * from './nonexistent-module';`,
                errors:   [{ messageId: 'starFromNonBarrel', data: { source: './nonexistent-module' } }],
            },
            // 7. Barrel uses aliased star re-export (export * as Ns) from a non-barrel — reports
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export * as Ns from './regular-module';`,
                errors:   [{ messageId: 'starFromNonBarrel', data: { source: './regular-module' } }],
            },
            // 8. With allowBarrelOfBarrels: false, even barrel-to-barrel export * is flagged
            {
                filename: path.join(fixturesDir, 'index.ts'),
                code:     `export * from './sub';`,
                options:  [{ allowBarrelOfBarrels: false }],
                errors:   [{ messageId: 'starFromNonBarrel', data: { source: './sub' } }],
            },
        ],
    });
});
