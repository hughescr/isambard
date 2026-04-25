/**
 * ESLint Rule: require-mock-reset
 *
 * If a test file imports any tracked mock identifier from a setup module,
 * it must also call the corresponding reset function inside an afterEach or afterAll.
 *
 * Without cleanup, mock state (call counts, recorded arguments, in-memory
 * virtual filesystem entries) accumulates across tests. With Bun's
 * randomize=true, this causes non-deterministic failures.
 *
 * The mock-to-reset mapping and setup module paths are configurable via rule options:
 *   mocks: { mockFoo: ['resetFoo'], mockBar: ['resetBar', 'resetBarPrefix'] }
 *   setupModules: ['setup'] (matches ./setup, ../setup, path/to/setup)
 */

/**
 * Returns true if the import source matches one of the configured setup module suffixes.
 * @param {string} source - the import path
 * @param {string[]} setupModules - list of module name suffixes to match
 */
export function isSetupImport(source, setupModules) {
    // Stryker disable all -- helper function tested via direct unit tests; Bun inspector cannot map per-test coverage for .mjs source files
    return setupModules.some(name =>
        source === `./${name}` || source === `../${name}` || source.endsWith(`/${name}`)
    );
    // Stryker restore all
}

/**
 * Collect all reset function names called inside afterEach or afterAll blocks.
 * Returns a Set of called function names found anywhere in those callbacks.
 * afterAll is also accepted since some test files do one-time teardown there.
 */
export function collectAfterEachResets(body) {
    // Stryker disable all -- helper function tested via direct unit tests; Bun inspector cannot map per-test coverage for .mjs source files
    const resetNames = new Set();

    function visitNode(node) { // eslint-disable-line complexity, sonarjs/cognitive-complexity -- handles afterEach/afterAll/describe branches; branching inherent to AST traversal
        if(!node) {
            return;
        }

        if(node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
            const call = node.expression;
            // afterEach/afterAll (() => { ... }) or afterEach/afterAll(function() { ... })
            if(
                call.callee.type === 'Identifier'
                && (call.callee.name === 'afterEach' || call.callee.name === 'afterAll')
                && call.arguments.length > 0
            ) {
                const callback = call.arguments[0];
                collectCallsInNode(callback, resetNames);
            }
        }

        // Recurse into describe blocks and other containers
        if(node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
            const call = node.expression;
            if(
                call.callee.type === 'Identifier'
                && (call.callee.name === 'describe' || call.callee.name === 'fdescribe' || call.callee.name === 'xdescribe')
                && call.arguments.length >= 2
            ) {
                const callback = call.arguments[call.arguments.length - 1];
                if(callback && callback.body) {
                    for(const stmt of (callback.body.body ?? [])) {
                        visitNode(stmt);
                    }
                }
            }
        }
    }

    for(const stmt of body) {
        visitNode(stmt);
    }

    return resetNames;
    // Stryker restore all
}

/**
 * Collect all direct call-expression callee names within a function body.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- handles both expression and block arrow bodies; branching inherent to AST traversal
export function collectCallsInNode(node, names) {
    // Stryker disable all -- helper function tested via direct unit tests; Bun inspector cannot map per-test coverage for .mjs source files
    if(!node) {
        return;
    }

    const body = node.body;
    if(!body) {
        return;
    }

    // Arrow function with expression body: () => resetMockFs()
    if(body.type === 'CallExpression') {
        if(body.callee.type === 'Identifier') {
            names.add(body.callee.name);
        }
        return;
    }

    // Block body
    if(body.type === 'BlockStatement') {
        for(const stmt of body.body) {
            if(stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression') {
                const callee = stmt.expression.callee;
                if(callee.type === 'Identifier') {
                    names.add(callee.name);
                }
            }
        }
    }
    // Stryker restore all
}

// Stryker disable all -- rule meta/schema and create() body tested via RuleTester; Bun inspector cannot map per-test coverage for .mjs source files
const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require reset helpers for mocks imported from setup modules in afterEach',
            category:    'Best Practices',
        },
        messages: {
            missingReset: "'{{identifier}}' imported from setup module without a matching {{resetFn}} call in an afterEach or afterAll — mock state will leak across tests.",
        },
        schema: [
            {
                type:       'object',
                properties: {
                    mocks: {
                        type:                 'object',
                        propertyNames:        { minLength: 1 },
                        additionalProperties: {
                            type:     'array',
                            minItems: 1,
                            items:    { type: 'string', minLength: 1 },
                        },
                    },
                    setupModules: {
                        type:     'array',
                        minItems: 1,
                        items:    { type: 'string', minLength: 1 },
                    },
                },
                required:             ['mocks'],
                additionalProperties: false,
            },
        ],
    },

    create(context) {
        const options = context.options[0];
        const mockResetMap = options?.mocks ?? {};
        const setupModules = options?.setupModules ?? ['setup'];

        /** @type {Array<{name: string, node: import('eslint').Rule.Node}>} */
        const trackedImports = [];

        return {
            ImportDeclaration(node) {
                if(!isSetupImport(node.source.value, setupModules)) {
                    return;
                }

                for(const specifier of node.specifiers) {
                    if(specifier.type === 'ImportSpecifier') {
                        const name = specifier.imported.name;
                        if(name in mockResetMap) {
                            trackedImports.push({ name, node: specifier });
                        }
                    }
                }
            },

            'Program:exit'(programNode) {
                if(trackedImports.length === 0) {
                    return;
                }

                const afterEachResets = collectAfterEachResets(programNode.body);

                for(const { name, node } of trackedImports) {
                    const resets = mockResetMap[name];
                    const hasReset = resets.some(r => afterEachResets.has(r));
                    if(!hasReset) {
                        const description = `${resets.join(' or ')}()`;
                        context.report({
                            node,
                            messageId: 'missingReset',
                            data:      {
                                identifier: name,
                                resetFn:    description,
                            },
                        });
                    }
                }
            },
        };
    },
};
// Stryker restore all

export default rule;
