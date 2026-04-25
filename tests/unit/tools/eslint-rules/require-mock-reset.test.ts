import { describe, expect, it } from 'bun:test';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- @typescript-eslint/parser is a devDependency used only in tests
import typescriptParser from '@typescript-eslint/parser';
import { Linter, RuleTester } from 'eslint';
import rule, { isSetupImport, collectAfterEachResets, collectCallsInNode } from '../../../../tools/eslint-rules/require-mock-reset.mjs';

/**
 * Parse code into a Program AST body using @typescript-eslint/parser.
 * This lets us test collectAfterEachResets directly without needing ESLint's rule runner.
 */
function parseBody(code: string): unknown[] {
    const ast = typescriptParser.parse(code, { range: false, tokens: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing AST body for test purposes
    return (ast as any).body as unknown[];
}

// Direct unit tests placed FIRST so Stryker's per-test coverage maps them at lower positions,
// ensuring they are visible to the Bun inspector before RuleTester-generated tests.

describe('isSetupImport — direct unit tests', () => {
    it('matches ./setup', () => {
        expect(isSetupImport('./setup', ['setup'])).toBe(true);
    });

    it('matches ../setup', () => {
        expect(isSetupImport('../setup', ['setup'])).toBe(true);
    });

    it('matches deep path ending in /setup', () => {
        expect(isSetupImport('../../../../setup', ['setup'])).toBe(true);
    });

    it('does not match unrelated path', () => {
        expect(isSetupImport('./other-module', ['setup'])).toBe(false);
    });

    it('does not match path containing setup but not ending in /setup', () => {
        expect(isSetupImport('./setup-utils', ['setup'])).toBe(false);
    });

    it('matches custom setupModules entry', () => {
        expect(isSetupImport('./test-setup', ['test-setup'])).toBe(true);
    });

    it('does not match when setupModules is empty', () => {
        expect(isSetupImport('./setup', [])).toBe(false);
    });

    it('matches any entry in setupModules', () => {
        expect(isSetupImport('./test-helpers', ['setup', 'test-helpers'])).toBe(true);
    });
});

describe('collectAfterEachResets — direct unit tests', () => {
    it('collects reset names from afterEach block body', () => {
        const body = parseBody(`
            afterEach(() => {
                resetMockFs();
            });
        `);
        const result = collectAfterEachResets(body);
        expect(result.has('resetMockFs')).toBe(true);
    });

    it('collects reset names from afterAll block body', () => {
        const body = parseBody(`
            afterAll(() => {
                resetMockSstResource();
            });
        `);
        const result = collectAfterEachResets(body);
        expect(result.has('resetMockSstResource')).toBe(true);
    });

    it('collects reset names from afterEach with expression body', () => {
        const body = parseBody(`
            afterEach(() => resetHeicConvertImpl());
        `);
        const result = collectAfterEachResets(body);
        expect(result.has('resetHeicConvertImpl')).toBe(true);
    });

    it('collects reset names from nested describe block', () => {
        const body = parseBody(`
            describe('suite', () => {
                afterEach(() => {
                    resetMockFs();
                });
            });
        `);
        const result = collectAfterEachResets(body);
        expect(result.has('resetMockFs')).toBe(true);
    });

    it('does not collect from non-afterEach calls', () => {
        const body = parseBody(`
            beforeEach(() => {
                resetMockFs();
            });
        `);
        const result = collectAfterEachResets(body);
        expect(result.has('resetMockFs')).toBe(false);
    });

    it('returns empty set for empty body', () => {
        const result = collectAfterEachResets([]);
        expect(result.size).toBe(0);
    });

    it('handles fdescribe blocks', () => {
        const body = parseBody(`
            fdescribe('suite', () => {
                afterEach(() => {
                    resetMockFs();
                });
            });
        `);
        const result = collectAfterEachResets(body);
        expect(result.has('resetMockFs')).toBe(true);
    });

    it('handles xdescribe blocks', () => {
        const body = parseBody(`
            xdescribe('suite', () => {
                afterEach(() => {
                    resetMockFs();
                });
            });
        `);
        const result = collectAfterEachResets(body);
        expect(result.has('resetMockFs')).toBe(true);
    });

    it('handles afterEach with no callback arguments gracefully', () => {
        // afterEach() with no args shouldn't crash
        const body = parseBody('afterEach();');
        const result = collectAfterEachResets(body);
        expect(result.size).toBe(0);
    });
});

describe('collectCallsInNode — direct unit tests', () => {
    it('collects call from block body', () => {
        const body = parseBody(`
            afterEach(() => { resetMockFs(); });
        `);
        // Navigate to the arrow function's block body
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AST navigation in test
        const arrowFn = (body[0] as any)?.expression?.arguments?.[0];
        const names = new Set<string>();
        collectCallsInNode(arrowFn, names);
        expect(names.has('resetMockFs')).toBe(true);
    });

    it('collects call from expression body', () => {
        const body = parseBody(`
            afterEach(() => resetMockFs());
        `);
        // Navigate to the arrow function with expression body
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AST navigation in test
        const arrowFn = (body[0] as any)?.expression?.arguments?.[0];
        const names = new Set<string>();
        collectCallsInNode(arrowFn, names);
        expect(names.has('resetMockFs')).toBe(true);
    });

    it('returns without error when node is null', () => {
        const names = new Set<string>();
        collectCallsInNode(null, names);
        expect(names.size).toBe(0);
    });

    it('returns without error when node.body is null', () => {
        const names = new Set<string>();
        collectCallsInNode({ body: null }, names);
        expect(names.size).toBe(0);
    });

    it('does not collect non-identifier callees in block body', () => {
        // obj.method() has a MemberExpression callee, not an Identifier
        const body = parseBody(`
            afterEach(() => { obj.method(); });
        `);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AST navigation in test
        const arrowFn = (body[0] as any)?.expression?.arguments?.[0];
        const names = new Set<string>();
        collectCallsInNode(arrowFn, names);
        expect(names.size).toBe(0);
    });
});

// RuleTester calls describe()/it() internally — invoke it at the describe scope,
// NOT inside an it() (Bun throws if describe() is nested inside an it()).
const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2024,
        sourceType:  'module',
        parser:      typescriptParser,
    },
});

// Standard options used in most test cases — combines real entries (matching eslint.config.mjs)
// with one synthetic entry (mockExample) for testing rule behavior on additional mock identifiers
const standardOptions = [{
    mocks: {
        mockFsPromises:  ['resetMockFs', 'resetMockFsPrefix'],
        mockSstResource: ['resetMockSstResource'],
        mockHeicConvert: ['resetHeicConvertImpl'],
        mockExample:     ['resetMockExample'],
    },
    setupModules: ['setup'],
}];

describe('require-mock-reset', () => {
    // RuleTester.run() calls describe/it under the hood — that is the test.

    ruleTester.run('require-mock-reset', rule, {
        valid: [
            // 1. mockFsPromises imported with resetMockFs in afterEach
            {
                options: standardOptions,
                code:    `
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
                options: standardOptions,
                code:    `
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
                options: standardOptions,
                code:    `
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
                options: standardOptions,
                code:    `
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
                options: standardOptions,
                code:    `
                    import { something } from '../other-module';
                    describe('test', () => {
                        it('does not use setup mocks', () => {});
                    });
                `,
            },
            // 6. Import from setup but only non-tracked identifiers
            {
                options: standardOptions,
                code:    `
                    import { textContent } from '../setup';
                    describe('test', () => {
                        it('only uses textContent', () => {});
                    });
                `,
            },
            // 7. mockFsPromises imported from deep relative path ending in /setup
            {
                options: standardOptions,
                code:    `
                    import { mockFsPromises, resetMockFs } from '../../../../setup';
                    afterEach(() => {
                        resetMockFs();
                    });
                    it('works', () => {});
                `,
            },
            // 8. mockExample imported with resetMockExample in afterEach — synthetic mock entry to verify rule handles arbitrary identifiers
            {
                options: standardOptions,
                code:    `
                    import { mockExample, resetMockExample } from '../setup';
                    describe('test', () => {
                        afterEach(() => {
                            resetMockExample();
                        });
                        it('uses mockExample', () => {});
                    });
                `,
            },
            // 9. No mocks provided — rule is a no-op (imports but nothing in mocks)
            {
                options: [{ mocks: {} }],
                code:    `
                    import { mockFsPromises } from '../setup';
                    describe('test', () => {
                        it('uses mockFsPromises without reset', () => {});
                    });
                `,
            },
            // 10. setupModules defaults to ['setup'] when not specified — reset provided
            {
                options: [{ mocks: { mockFsPromises: ['resetMockFs'] } }],
                code:    `
                    import { mockFsPromises, resetMockFs } from './setup';
                    afterEach(() => { resetMockFs(); });
                    it('uses default setup module', () => {});
                `,
            },
            // 11. Import matches a different setupModules value — not tracked
            {
                options: [{ mocks: { mockFsPromises: ['resetMockFs'] }, setupModules: ['test-setup'] }],
                code:    `
                    import { mockFsPromises } from '../setup';
                    describe('test', () => {
                        it('setup not in setupModules', () => {});
                    });
                `,
            },
            // 12. Import matches configured setupModules value — tracked and reset provided
            {
                options: [{ mocks: { mockFsPromises: ['resetMockFs'] }, setupModules: ['test-setup'] }],
                code:    `
                    import { mockFsPromises, resetMockFs } from '../test-setup';
                    afterEach(() => { resetMockFs(); });
                    it('works', () => {});
                `,
            },
        ],

        invalid: [
            // 1. mockFsPromises imported but no resetMockFs or resetMockFsPrefix in afterEach
            {
                options: standardOptions,
                code:    `
                    import { mockFsPromises } from '../setup';
                    describe('test', () => {
                        it('uses mockFsPromises', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 2. mockSstResource imported but no resetMockSstResource in afterEach
            {
                options: standardOptions,
                code:    `
                    import { mockSstResource } from '../setup';
                    describe('test', () => {
                        it('uses mockSstResource without reset', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 3. mockHeicConvert imported but no resetHeicConvertImpl in afterEach
            {
                options: standardOptions,
                code:    `
                    import { mockHeicConvert } from '../../setup';
                    describe('test', () => {
                        it('uses mockHeicConvert without cleanup', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 4. mockFsPromises imported, afterEach exists but calls wrong reset
            {
                options: standardOptions,
                code:    `
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
                options: standardOptions,
                code:    `
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
            // 6. mockExample imported without reset — synthetic mock entry to verify rule handles arbitrary identifiers
            {
                options: standardOptions,
                code:    `
                    import { mockExample } from '../setup';
                    describe('test', () => {
                        it('uses mockExample without reset', () => {});
                    });
                `,
                errors: [{ messageId: 'missingReset' }],
            },
            // 7. setupModules defaults to ['setup'] — missing reset triggers error
            {
                options: [{ mocks: { mockFsPromises: ['resetMockFs'] } }],
                code:    `
                    import { mockFsPromises } from './setup';
                    it('missing reset', () => {});
                `,
                errors: [{ messageId: 'missingReset' }],
            },
        ],
    });
});

describe('require-mock-reset — schema validation', () => {
    const linter = new Linter({ configType: 'flat' });

    function verifyWithOptions(options: unknown): string {
        try {
            linter.verify('const x = 1;', {
                plugins: { local: { rules: { 'require-mock-reset': rule } } },
                rules:   { 'local/require-mock-reset': ['error', options] },
            });
            return '';
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }

    it('rejects empty setupModules array', () => {
        const msg = verifyWithOptions({ mocks: {}, setupModules: [] });
        expect(msg).toMatch(/fewer than 1/);
    });

    it('rejects mocks value array with no entries', () => {
        const msg = verifyWithOptions({ mocks: { mockFoo: [] } });
        expect(msg).toMatch(/fewer than 1/);
    });

    it('rejects empty mock key', () => {
        const msg = verifyWithOptions({ mocks: { '': ['resetFoo'] } });
        expect(msg).toMatch(/shorter than 1 characters/);
    });

    it('rejects empty reset function name', () => {
        const msg = verifyWithOptions({ mocks: { mockFoo: [''] } });
        expect(msg).toMatch(/shorter than 1 characters/);
    });

    it('rejects empty setupModules element', () => {
        const msg = verifyWithOptions({ mocks: { mockFoo: ['resetFoo'] }, setupModules: [''] });
        expect(msg).toMatch(/shorter than 1 characters/);
    });
});
