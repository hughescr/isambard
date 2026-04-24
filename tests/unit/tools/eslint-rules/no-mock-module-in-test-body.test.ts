import { describe } from 'bun:test';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import rule from '../../../../tools/eslint-rules/no-mock-module-in-test-body.mjs';

// RuleTester calls describe()/it() internally — invoke it at the describe scope,
// NOT inside an it() (Bun throws if describe() is nested inside an it()).
const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2024,
        sourceType:  'module',
        parser:      typescriptParser,
    },
});

describe('no-mock-module-in-test-body', () => {
    // RuleTester.run() calls describe/it under the hood — that is the test.

    ruleTester.run('no-mock-module-in-test-body', rule, {
        valid: [
            // 1. No mock.module call — trivially valid
            {
                code: `
                    describe('test', () => {
                        it('does something', () => {
                            expect(1 + 1).toBe(2);
                        });
                    });
                `,
                filename: 'tests/unit/some.test.ts',
            },
            // 2. tests/setup.ts is exempt (it defines the mocks)
            {
                code: `
                    mock.module('some-module', () => ({ key: 'value' }));
                `,
                filename: 'tests/setup.ts',
            },
            // 3. Absolute path also matching tests/setup.ts
            {
                code: `
                    mock.module('@/something', () => ({}));
                `,
                filename: '/Users/craig/code/isambard/tests/setup.ts',
            },
            // 4. mock.something-else is fine (only .module is banned)
            {
                code: `
                    mock.fn(() => {});
                    mock.spy(obj, 'method');
                `,
                filename: 'tests/unit/some.test.ts',
            },
            // 5. Empty file
            {
                code:     '',
                filename: 'tests/unit/empty.test.ts',
            },
            // 6. A utility file with no filename (no filename = not a test file context)
            {
                code: `
                    const x = 1;
                `,
            },
        ],

        invalid: [
            // 1. mock.module in a regular test file
            {
                code: `
                    mock.module('some-module', () => ({ key: 'value' }));
                    describe('test', () => {
                        it('does something', () => {});
                    });
                `,
                filename: 'tests/unit/some.test.ts',
                errors:   [{ messageId: 'noMockModuleOutsideSetup' }],
            },
            // 2. mock.module inside a describe block
            {
                code: `
                    describe('test', () => {
                        mock.module('some-module', () => ({}));
                        it('does something', () => {});
                    });
                `,
                filename: 'tests/unit/some.test.ts',
                errors:   [{ messageId: 'noMockModuleOutsideSetup' }],
            },
            // 3. mock.module inside beforeEach
            {
                code: `
                    describe('test', () => {
                        beforeEach(() => {
                            mock.module('sst', () => ({ Resource: {} }));
                        });
                        it('does something', () => {});
                    });
                `,
                filename: 'tests/unit/integrations/bsky.test.ts',
                errors:   [{ messageId: 'noMockModuleOutsideSetup' }],
            },
            // 4. mock.module inside a test body
            {
                code: `
                    it('overrides a module', () => {
                        mock.module('node:path', () => ({ join: () => 'fake' }));
                    });
                `,
                filename: 'tests/unit/some.test.ts',
                errors:   [{ messageId: 'noMockModuleOutsideSetup' }],
            },
            // 5. Multiple mock.module calls
            {
                code: `
                    mock.module('a', () => ({}));
                    mock.module('b', () => ({}));
                `,
                filename: 'tests/unit/some.test.ts',
                errors:   [
                    { messageId: 'noMockModuleOutsideSetup' },
                    { messageId: 'noMockModuleOutsideSetup' },
                ],
            },
        ],
    });
});
