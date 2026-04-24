import { describe } from 'bun:test';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import rule from '../../../../tools/eslint-rules/require-fs-mock-reset.mjs';

// RuleTester calls describe()/it() internally — invoke it at the describe scope,
// NOT inside an it() (Bun throws if describe() is nested inside an it()).
const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2024,
        sourceType:  'module',
        parser:      typescriptParser,
    },
});

describe('require-fs-mock-reset', () => {
    // RuleTester.run() calls describe/it under the hood — that is the test.

    ruleTester.run('require-fs-mock-reset', rule, {
        valid: [
            // 1. mockFsPromises imported with resetMockFs in afterEach
            {
                code: `
                    import { mockFsPromises, resetMockFs } from '../setup';
                    describe('test', () => {
                        afterEach(() => {
                            resetMockFs();
                        });
                        it('uses mockFsPromises', () => {});
                    });
                `,
            },
            // 2. mockFsPromises imported with resetMockFsPrefix in afterEach
            {
                code: `
                    import { mockFsPromises, resetMockFsPrefix } from '../../setup';
                    describe('test', () => {
                        afterEach(() => {
                            resetMockFsPrefix('/tmp');
                        });
                        it('uses mockFsPromises', () => {});
                    });
                `,
            },
            // 3. mockSstResource imported with resetMockSstResource in afterEach
            {
                code: `
                    import { mockSstResource, resetMockSstResource } from '../setup';
                    describe('test', () => {
                        afterEach(() => {
                            resetMockSstResource();
                        });
                        it('uses mockSstResource', () => {});
                    });
                `,
            },
            // 4. mockHeicConvert imported with resetHeicConvertImpl in afterEach
            {
                code: `
                    import { mockHeicConvert, resetHeicConvertImpl } from '../../setup';
                    describe('test', () => {
                        afterEach(() => {
                            resetHeicConvertImpl();
                        });
                        it('uses mockHeicConvert', () => {});
                    });
                `,
            },
            // 5. No import from setup — rule does not apply
            {
                code: `
                    import { something } from '../other-module';
                    describe('test', () => {
                        it('does not use setup mocks', () => {});
                    });
                `,
            },
            // 6. Import from setup but only non-tracked identifiers
            {
                code: `
                    import { mockLogger, textContent } from '../setup';
                    describe('test', () => {
                        it('only uses mockLogger', () => {});
                    });
                `,
            },
            // 7. mockFsPromises imported from deep relative path ending in /setup
            {
                code: `
                    import { mockFsPromises, resetMockFs } from '../../../../setup';
                    afterEach(() => {
                        resetMockFs();
                    });
                    it('works', () => {});
                `,
            },
        ],

        invalid: [
            // 1. mockFsPromises imported but no resetMockFs or resetMockFsPrefix in afterEach
            {
                code: `
                    import { mockFsPromises } from '../setup';
                    describe('test', () => {
                        it('uses mockFsPromises', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 2. mockSstResource imported but no resetMockSstResource in afterEach
            {
                code: `
                    import { mockSstResource } from '../setup';
                    describe('test', () => {
                        it('uses mockSstResource without reset', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 3. mockHeicConvert imported but no resetHeicConvertImpl in afterEach
            {
                code: `
                    import { mockHeicConvert } from '../../setup';
                    describe('test', () => {
                        it('uses mockHeicConvert without cleanup', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 4. mockFsPromises imported, afterEach exists but calls wrong reset
            {
                code: `
                    import { mockFsPromises } from '../setup';
                    describe('test', () => {
                        afterEach(() => {
                            resetMockSstResource();
                        });
                        it('uses mockFsPromises', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 5. Multiple mock imports, both missing their resets
            {
                code: `
                    import { mockFsPromises, mockSstResource } from '../setup';
                    describe('test', () => {
                        it('uses both mocks', () => {});
                    });
                `,
                errors: [
                    { messageId: 'missingReset' },
                    { messageId: 'missingReset' },
                ],
            },
        ],
    });
});
