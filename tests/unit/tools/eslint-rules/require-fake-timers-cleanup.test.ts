import { describe } from 'bun:test';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import rule from '../../../../tools/eslint-rules/require-fake-timers-cleanup.mjs';

// RuleTester calls describe()/it() internally — invoke it at the describe scope,
// NOT inside an it() (Bun throws if describe() is nested inside an it()).
const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2024,
        sourceType:  'module',
        parser:      typescriptParser,
    },
});

describe('require-fake-timers-cleanup', () => {
    // RuleTester.run() calls describe/it under the hood — that is the test.
    // The surrounding describe is just a namespace.

    ruleTester.run('require-fake-timers-cleanup', rule, {
        valid: [
            // 1. useFakeTimers in beforeEach with useRealTimers in afterEach (same describe)
            {
                code: `
                        describe('test', () => {
                            beforeEach(() => {
                                jest.useFakeTimers();
                            });
                            afterEach(() => {
                                jest.useRealTimers();
                            });
                            it('does something', () => {});
                        });
                    `,
            },
            // 2. useFakeTimers in beforeAll with useRealTimers in afterAll
            {
                code: `
                        describe('test', () => {
                            beforeAll(() => {
                                jest.useFakeTimers();
                            });
                            afterAll(() => {
                                jest.useRealTimers();
                            });
                            it('does something', () => {});
                        });
                    `,
            },
            // 3. useFakeTimers in a test body with useRealTimers at end
            {
                code: `
                        it('uses fake timers inline', () => {
                            jest.useFakeTimers();
                            jest.advanceTimersByTime(1000);
                            jest.useRealTimers();
                        });
                    `,
            },
            // 4. useFakeTimers at top-level of describe (safety-net covers it — skip)
            {
                code: `
                        describe('top level', () => {
                            jest.useFakeTimers();
                            it('does something', () => {});
                        });
                    `,
            },
            // 5. useFakeTimers at file top-level (safety-net covers it — skip)
            {
                code: `
                        jest.useFakeTimers();
                        it('does something', () => {});
                    `,
            },
            // 6. No fake timers at all — nothing to enforce
            {
                code: `
                        describe('test', () => {
                            beforeEach(() => {
                                // setup without fake timers
                            });
                            it('does something', () => {});
                        });
                    `,
            },
            // 7. useFakeTimers in test body with enclosing afterEach doing cleanup
            {
                code: `
                        describe('test', () => {
                            afterEach(() => {
                                jest.useRealTimers();
                            });
                            it('uses fake timers', () => {
                                jest.useFakeTimers();
                                jest.advanceTimersByTime(100);
                            });
                        });
                    `,
            },
            // 8. Nested describes with proper cleanup at each level
            {
                code: `
                        describe('outer', () => {
                            describe('inner', () => {
                                beforeEach(() => {
                                    jest.useFakeTimers();
                                });
                                afterEach(() => {
                                    jest.useRealTimers();
                                });
                                it('does something', () => {});
                            });
                        });
                    `,
            },
        ],

        invalid: [
            // 1. useFakeTimers in beforeEach with no afterEach cleanup
            {
                code: `
                        describe('test', () => {
                            beforeEach(() => {
                                jest.useFakeTimers();
                            });
                            it('does something', () => {});
                        });
                    `,
                errors: [{ messageId: 'missingCleanup' }],
            },
            // 2. useFakeTimers in beforeEach but afterEach lacks useRealTimers
            {
                code: `
                        describe('test', () => {
                            beforeEach(() => {
                                jest.useFakeTimers();
                            });
                            afterEach(() => {
                                jest.restoreAllMocks();
                            });
                            it('does something', () => {});
                        });
                    `,
                errors: [{ messageId: 'missingCleanup' }],
            },
            // 3. useFakeTimers in beforeAll with no afterAll cleanup
            {
                code: `
                        describe('test', () => {
                            beforeAll(() => {
                                jest.useFakeTimers();
                            });
                            it('does something', () => {});
                        });
                    `,
                errors: [{ messageId: 'missingCleanup' }],
            },
            // 4. useFakeTimers in test body with no cleanup
            {
                code: `
                        it('uses fake timers without cleanup', () => {
                            jest.useFakeTimers();
                            jest.advanceTimersByTime(1000);
                        });
                    `,
                errors: [{ messageId: 'missingCleanup' }],
            },
            // 5. Nested beforeEach with fake timers but no inner afterEach
            {
                code: `
                        describe('outer', () => {
                            describe('inner', () => {
                                beforeEach(() => {
                                    jest.useFakeTimers();
                                });
                                it('does something', () => {});
                            });
                        });
                    `,
                errors: [{ messageId: 'missingCleanup' }],
            },
        ],
    });
});
