/**
 * ESLint Rule: require-fs-mock-reset
 *
 * If a test file imports any tracked mock identifier from tests/setup
 * (mockFsPromises, mockSstResource, mockHeicConvert), it must also call
 * the corresponding reset function inside an afterEach.
 *
 * Without cleanup, mock state (call counts, recorded arguments, in-memory
 * virtual filesystem entries) accumulates across tests. With Bun's
 * randomize=true, this causes non-deterministic failures.
 *
 * Mapping (hardcoded):
 *   mockFsPromises  → resetMockFs or resetMockFsPrefix
 *   mockSstResource → resetMockSstResource
 *   mockHeicConvert → resetHeicConvertImpl
 *
 * See tests/setup.ts:542 for the accompanying documentation.
 */

/** @type {Record<string, {resets: string[], description: string}>} */
const MOCK_RESET_MAP = {
    mockFsPromises:  { resets: ['resetMockFs', 'resetMockFsPrefix'], description: 'resetMockFs() or resetMockFsPrefix(...)' },
    mockSstResource: { resets: ['resetMockSstResource'], description: 'resetMockSstResource()' },
    mockHeicConvert: { resets: ['resetHeicConvertImpl'], description: 'resetHeicConvertImpl()' },
};

/**
 * Returns true if the import source looks like a path ending in /setup
 * (e.g. '../setup', '../../setup', './setup', '../../../../setup').
 */
function isSetupImport(source) {
    return source === './setup'
      || source === '../setup'
      || source.endsWith('/setup');
}

/**
 * Collect all reset function names called inside afterEach or afterAll blocks.
 * Returns a Set of called function names found anywhere in those callbacks.
 * afterAll is also accepted since some test files do one-time teardown there.
 */
function collectAfterEachResets(body) {
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
}

/**
 * Collect all direct call-expression callee names within a function body.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- handles both expression and block arrow bodies; branching inherent to AST traversal
function collectCallsInNode(node, names) {
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
}

const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require reset helpers for mocks imported from tests/setup in afterEach',
            category:    'Best Practices',
        },
        messages: {
            missingReset: "'{{identifier}}' imported from tests/setup without a matching {{resetFn}} call in an afterEach or afterAll — mock state will leak across tests. See tests/setup.ts:542.",
        },
        schema: [],
    },

    create(context) {
        /** @type {Array<{name: string, node: import('eslint').Rule.Node}>} */
        const trackedImports = [];

        return {
            ImportDeclaration(node) {
                if(!isSetupImport(node.source.value)) {
                    return;
                }

                for(const specifier of node.specifiers) {
                    if(specifier.type === 'ImportSpecifier') {
                        const name = specifier.imported.name;
                        if(name in MOCK_RESET_MAP) {
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
                    const { resets, description } = MOCK_RESET_MAP[name];
                    const hasReset = resets.some(r => afterEachResets.has(r));
                    if(!hasReset) {
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

export default rule;
