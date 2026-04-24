/**
 * ESLint Rule: require-fake-timers-cleanup
 *
 * Every jest.useFakeTimers() call must be paired with jest.useRealTimers()
 * in the corresponding cleanup scope:
 *
 *   - In beforeEach → require useRealTimers() in sibling afterEach
 *   - In beforeAll  → require useRealTimers() in sibling afterAll
 *   - In a test body (it/test) → require useRealTimers() at end of test body
 *     OR in an enclosing afterEach
 *
 * When useFakeTimers() is at the top level of a describe block or at the
 * file top level, it is SKIPPED — the Phase 4 safety net in tests/setup.ts
 * (a global afterEach that always calls jest.useRealTimers()) covers those.
 *
 * This rule only fires when a local beforeEach/beforeAll/test body calls
 * useFakeTimers() without a corresponding local cleanup.
 */

/** Hook name pairs: setup → cleanup */
const HOOK_PAIRS = {
    beforeEach: 'afterEach',
    beforeAll:  'afterAll',
};

function isUseFakeTimersCall(node) {
    return (
        node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier'
        && node.callee.object.name === 'jest'
        && node.callee.property.type === 'Identifier'
        && node.callee.property.name === 'useFakeTimers'
    );
}

function isUseRealTimersCall(node) {
    return (
        node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier'
        && node.callee.object.name === 'jest'
        && node.callee.property.type === 'Identifier'
        && node.callee.property.name === 'useRealTimers'
    );
}

/**
 * Returns true if node is a call to the given function name (e.g. 'beforeEach').
 */
function isHookCall(node, name) {
    return (
        node.type === 'CallExpression'
        && node.callee.type === 'Identifier'
        && node.callee.name === name
    );
}

function isTestCall(node) {
    return (
        node.type === 'CallExpression'
        && node.callee.type === 'Identifier'
        && (node.callee.name === 'it' || node.callee.name === 'test')
    );
}

function isDescribeCall(node) {
    return (
        node.type === 'CallExpression'
        && node.callee.type === 'Identifier'
        && (node.callee.name === 'describe' || node.callee.name === 'fdescribe' || node.callee.name === 'xdescribe')
    );
}

/**
 * Check if a function body (array of statements in a block) contains a
 * useFakeTimers call directly (not inside a nested function).
 */
function bodyContainsFakeTimers(body) {
    if(!body || !body.body) {
        return false;
    }
    return body.body.some((stmt) => {
        return (
            stmt.type === 'ExpressionStatement'
            && stmt.expression.type === 'CallExpression'
            && isUseFakeTimersCall(stmt.expression)
        );
    });
}

/**
 * A more lenient cleanup checker: the callback arrow body can be either a
 * block or an expression. Walk the callback to find useRealTimers.
 */
function callbackContainsUseRealTimers(callback) {
    if(!callback) {
        return false;
    }
    const body = callback.body;
    if(!body) {
        return false;
    }

    // Expression body: () => jest.useRealTimers()
    if(body.type !== 'BlockStatement') {
        return isUseRealTimersCall(body);
    }

    // Block body: check top-level statements
    return body.body.some((stmt) => {
        return (
            stmt.type === 'ExpressionStatement'
            && isUseRealTimersCall(stmt.expression)
        );
    });
}

/**
 * Find all afterEach/afterAll calls at a given list of statements.
 */
function findCleanupHooksAt(stmts, cleanupHookName) {
    return stmts.filter((stmt) => {
        return (
            stmt.type === 'ExpressionStatement'
            && isHookCall(stmt.expression, cleanupHookName)
        );
    });
}

/**
 * Returns true if any of the given cleanup hook call statements have a
 * callback that calls useRealTimers.
 */
function cleanupHooksHaveUseRealTimers(hookStmts) {
    return hookStmts.some((stmt) => {
        const call = stmt.expression;
        if(call.arguments.length === 0) {
            return false;
        }
        return callbackContainsUseRealTimers(call.arguments[0]);
    });
}

/**
 * Check the body of a test (it/test) for useRealTimers call anywhere inside
 * (not just top-level, since it may be at end).
 */
function testBodyHasUseRealTimers(callback) {
    if(!callback || !callback.body || !callback.body.body) {
        return false;
    }
    return callback.body.body.some((stmt) => {
        return (
            stmt.type === 'ExpressionStatement'
            && isUseRealTimersCall(stmt.expression)
        );
    });
}

const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require jest.useRealTimers() cleanup when jest.useFakeTimers() is used in a hook or test body',
            category:    'Best Practices',
        },
        messages: {
            missingCleanup: 'jest.useFakeTimers() in {{hookKind}} at line {{line}} has no matching jest.useRealTimers() in the corresponding cleanup hook. Add it to avoid fake-timer leakage.',
        },
        schema: [],
    },

    create(context) {
        /**
         * Process a block of statements (program body or describe callback body)
         * looking for beforeEach/beforeAll/test calls that use fake timers without
         * corresponding cleanup.
         *
         * @param {unknown[]} stmts - Array of statement nodes
         * @param {unknown[]} enclosingAfterEachChain - afterEach candidates from outer scopes
         */
        // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- walks describes + hooks + tests; branching inherent to AST traversal
        function processBlock(stmts, enclosingAfterEachChain) {
            for(const stmt of stmts) {
                if(stmt.type !== 'ExpressionStatement') {
                    continue;
                }
                const call = stmt.expression;

                // Check beforeEach and beforeAll hooks
                for(const [hookName, cleanupName] of Object.entries(HOOK_PAIRS)) {
                    if(!isHookCall(call, hookName)) {
                        continue;
                    }
                    if(call.arguments.length === 0) {
                        continue;
                    }

                    const callback = call.arguments[0];
                    if(!bodyContainsFakeTimers(callback.body)) {
                        continue;
                    }

                    // Look for cleanup in sibling statements at same level
                    const cleanupHooks = findCleanupHooksAt(stmts, cleanupName);
                    if(cleanupHooksHaveUseRealTimers(cleanupHooks)) {
                        continue;
                    }

                    // Report violation
                    context.report({
                        node:      call,
                        messageId: 'missingCleanup',
                        data:      { hookKind: hookName, line: call.loc?.start.line ?? '?' },
                    });
                }

                // Check test bodies (it/test)
                if(isTestCall(call) && call.arguments.length >= 2) {
                    const callback = call.arguments[call.arguments.length - 1];
                    if(!callback.body) {
                        continue;
                    }
                    if(!bodyContainsFakeTimers(callback.body)) {
                        continue;
                    }

                    // Check: useRealTimers at end of test body
                    if(testBodyHasUseRealTimers(callback)) {
                        continue;
                    }

                    // Check: enclosing afterEach (at this level or outer levels)
                    const siblingsAfterEach = findCleanupHooksAt(stmts, 'afterEach');
                    const allAfterEach = [...siblingsAfterEach, ...enclosingAfterEachChain];
                    const hasEnclosingCleanup = allAfterEach.some((hookStmt) => {
                        const hookCall = hookStmt.expression ?? hookStmt;
                        if(!hookCall.arguments?.length) {
                            return false;
                        }
                        return callbackContainsUseRealTimers(hookCall.arguments[0]);
                    });
                    if(hasEnclosingCleanup) {
                        continue;
                    }

                    context.report({
                        node:      call,
                        messageId: 'missingCleanup',
                        data:      { hookKind: 'test body', line: call.loc?.start.line ?? '?' },
                    });
                }

                // Recurse into describe blocks
                if(isDescribeCall(call) && call.arguments.length >= 2) {
                    const callback = call.arguments[call.arguments.length - 1];
                    if(!callback.body || !callback.body.body) {
                        continue;
                    }

                    // Collect afterEach from this level to pass down to nested scopes
                    const thisLevelAfterEach = findCleanupHooksAt(stmts, 'afterEach');
                    processBlock(callback.body.body, [...enclosingAfterEachChain, ...thisLevelAfterEach]);
                }
            }
        }

        return {
            'Program:exit'(programNode) {
                processBlock(programNode.body, []);
            },
        };
    },
};

export default rule;
