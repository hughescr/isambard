/**
 * ESLint Rule: require-mock-cleanup
 *
 * Every test file that calls jest.spyOn(...) must have an afterEach that
 * calls jest.restoreAllMocks() OR iterates a tracked-spies array calling
 * .mockRestore() on each element.
 *
 * Without restoration, spies accumulate call history and intercept real
 * implementations across subsequent tests. With Bun's randomize=true,
 * this causes ordering-sensitive failures.
 *
 * Acceptable cleanup patterns (file-scoped check):
 *   1. jest.restoreAllMocks() in any afterEach
 *   2. for (const spy of spies) { spy.mockRestore() } in any afterEach
 *   3. spies.forEach(spy => spy.mockRestore()) in any afterEach
 */

/** AST keys to skip to avoid circular references (parent pointer, metadata) */
const SKIP_KEYS = new Set(['parent', 'loc', 'start', 'end', 'range', 'tokens', 'comments']);

/**
 * Walk an AST node deeply and call visitor for each node.
 * Skips circular-reference-prone keys like 'parent'.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- AST walker inherently handles many node types
function walk(node, visitor) {
    if(!node || typeof node !== 'object') {
        return;
    }
    visitor(node);
    for(const key of Object.keys(node)) {
        if(SKIP_KEYS.has(key)) {
            continue;
        }
        const child = node[key];
        if(Array.isArray(child)) {
            for(const item of child) {
                if(item && typeof item === 'object' && item.type) {
                    walk(item, visitor);
                }
            }
        } else if(child && typeof child === 'object' && child.type) {
            walk(child, visitor);
        }
    }
}

/**
 * Returns true if the node is a jest.spyOn(...) call.
 */
function isSpyOnCall(node) {
    return (
        node.type === 'CallExpression'
        && node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier'
        && node.callee.object.name === 'jest'
        && node.callee.property.type === 'Identifier'
        && node.callee.property.name === 'spyOn'
    );
}

/**
 * Returns true if a function body contains jest.restoreAllMocks() or
 * a forEach/.for-of loop calling .mockRestore() on each element.
 */
function hasRestoreInCallback(callback) {
    if(!callback) {
        return false;
    }
    let found = false;
    walk(callback, (node) => {
        if(found) {
            return;
        }

        // jest.restoreAllMocks()
        if(
            node.type === 'CallExpression'
            && node.callee.type === 'MemberExpression'
            && node.callee.object.type === 'Identifier'
            && node.callee.object.name === 'jest'
            && node.callee.property.type === 'Identifier'
            && node.callee.property.name === 'restoreAllMocks'
        ) {
            found = true;
            return;
        }

        // for (const spy of spies) { spy.mockRestore() }
        if(
            node.type === 'ForOfStatement'
            && node.body
        ) {
            walk(node.body, (inner) => {
                if(
                    inner.type === 'CallExpression'
                    && inner.callee.type === 'MemberExpression'
                    && inner.callee.property.type === 'Identifier'
                    && inner.callee.property.name === 'mockRestore'
                ) {
                    found = true;
                }
            });
        }

        // spies.forEach(spy => spy.mockRestore())
        if(
            node.type === 'CallExpression'
            && node.callee.type === 'MemberExpression'
            && node.callee.property.type === 'Identifier'
            && node.callee.property.name === 'forEach'
            && node.arguments.length > 0
        ) {
            const cb = node.arguments[0];
            walk(cb, (inner) => {
                if(
                    inner.type === 'CallExpression'
                    && inner.callee.type === 'MemberExpression'
                    && inner.callee.property.type === 'Identifier'
                    && inner.callee.property.name === 'mockRestore'
                ) {
                    found = true;
                }
            });
        }
    });
    return found;
}

/**
 * Returns true if the program body contains at least one afterEach call
 * with a cleanup callback matching the restore patterns.
 */
function hasRestoreAfterEach(body) {
    let found = false;
    walk({ type: 'Program', body }, (node) => {
        if(found) {
            return;
        }
        if(
            node.type === 'CallExpression'
            && node.callee.type === 'Identifier'
            && node.callee.name === 'afterEach'
            && node.arguments.length > 0
            && hasRestoreInCallback(node.arguments[0])
        ) {
            found = true;
        }
    });
    return found;
}

const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require jest.restoreAllMocks() or mockRestore() cleanup when spyOn is used',
            category:    'Best Practices',
        },
        messages: {
            missingRestore: 'spyOn() used without jest.restoreAllMocks() in an afterEach. Spies leak across tests. Add jest.restoreAllMocks() to an afterEach, or use a tracked spies array with mockRestore() cleanup.',
        },
        schema: [],
    },

    create(context) {
        /** @type {import('eslint').Rule.Node | null} */
        let firstSpyOnNode = null;

        return {
            CallExpression(node) {
                if(firstSpyOnNode === null && isSpyOnCall(node)) {
                    firstSpyOnNode = node;
                }
            },

            'Program:exit'(programNode) {
                if(firstSpyOnNode === null) {
                    return; // No spyOn calls — nothing to enforce
                }

                if(!hasRestoreAfterEach(programNode.body)) {
                    context.report({
                        node:      firstSpyOnNode,
                        messageId: 'missingRestore',
                    });
                }
            },
        };
    },
};

export default rule;
