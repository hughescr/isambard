import { describe } from 'bun:test';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import rule from '../../../../tools/eslint-rules/require-mock-cleanup.mjs';

// RuleTester calls describe()/it() internally — invoke it at the describe scope,
// NOT inside an it() (Bun throws if describe() is nested inside an it()).
const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2024,
        sourceType:  'module',
        parser:      typescriptParser,
    },
});

describe('require-mock-cleanup', () => {
    // RuleTester.run() calls describe/it under the hood — that is the test.

    ruleTester.run('require-mock-cleanup', rule, {
        valid: [
            // 1. spyOn with jest.restoreAllMocks() in afterEach
            {
                code: `
                    describe('test', () => {
                        afterEach(() => {
                            jest.restoreAllMocks();
                        });
                        it('uses spyOn', () => {
                            jest.spyOn(obj, 'method');
                        });
                    });
                `,
            },
            // 2. spyOn with tracked-spies array using for...of and mockRestore
            {
                code: `
                    describe('test', () => {
                        const spies = [];
                        afterEach(() => {
                            for (const spy of spies) {
                                spy.mockRestore();
                            }
                        });
                        it('uses spyOn', () => {
                            spies.push(jest.spyOn(obj, 'method'));
                        });
                    });
                `,
            },
            // 3. No spyOn calls — rule does not apply
            {
                code: `
                    describe('test', () => {
                        it('does not use spyOn', () => {
                            expect(1 + 1).toBe(2);
                        });
                    });
                `,
            },
            // 4. spyOn with forEach .mockRestore()
            {
                code: `
                    describe('test', () => {
                        const spies = [];
                        afterEach(() => {
                            spies.forEach(spy => spy.mockRestore());
                        });
                        it('uses spyOn', () => {
                            spies.push(jest.spyOn(obj, 'method'));
                        });
                    });
                `,
            },
            // 5. Empty file — no violations
            {
                code: '',
            },
            // 6. spyOn in a nested describe, restoreAllMocks at outer afterEach
            {
                code: `
                    describe('outer', () => {
                        afterEach(() => {
                            jest.restoreAllMocks();
                        });
                        describe('inner', () => {
                            it('uses spyOn', () => {
                                jest.spyOn(obj, 'method');
                            });
                        });
                    });
                `,
            },
        ],

        invalid: [
            // 1. spyOn with no afterEach at all
            {
                code: `
                    describe('test', () => {
                        it('uses spyOn without cleanup', () => {
                            jest.spyOn(obj, 'method');
                        });
                    });
                `,
                errors: [{ messageId: 'missingRestore' }],
            },
            // 2. afterEach present but no restoreAllMocks or mockRestore
            {
                code: `
                    describe('test', () => {
                        afterEach(() => {
                            jest.clearAllMocks();
                        });
                        it('uses spyOn', () => {
                            jest.spyOn(obj, 'method');
                        });
                    });
                `,
                errors: [{ messageId: 'missingRestore' }],
            },
            // 3. spyOn at file top level with no restoring afterEach
            {
                code: `
                    jest.spyOn(obj, 'method');
                    it('test', () => {});
                `,
                errors: [{ messageId: 'missingRestore' }],
            },
            // 4. Multiple spyOn calls but no cleanup
            {
                code: `
                    describe('test', () => {
                        beforeEach(() => {
                            jest.spyOn(obj, 'method1');
                            jest.spyOn(obj, 'method2');
                        });
                        it('does something', () => {});
                    });
                `,
                errors: [{ messageId: 'missingRestore' }],
            },
            // 5. afterEach with clearAllMocks only (not restoreAllMocks)
            {
                code: `
                    describe('test', () => {
                        afterEach(() => {
                            jest.clearAllMocks();
                            jest.resetAllMocks();
                        });
                        it('uses spyOn', () => {
                            jest.spyOn(obj, 'method');
                        });
                    });
                `,
                errors: [{ messageId: 'missingRestore' }],
            },
        ],
    });
});
