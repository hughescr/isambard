/**
 * ESLint Rule: no-mock-module-in-test-body
 *
 * Bans mock.module(...) calls in any file except tests/setup.ts.
 *
 * mock.module() is global and order-dependent — Bun registers it at module
 * evaluation time. Scattering it across test files creates ordering hazards
 * that Bun's randomized test ordering (bunfig.toml: randomize = true) will
 * surface as flaky failures. All shared module mocks belong in tests/setup.ts.
 *
 * Per-test overrides should use spyOn() or mock().mockImplementation() instead.
 */

const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow mock.module() calls outside tests/setup.ts',
            category:    'Best Practices',
        },
        messages: {
            noMockModuleOutsideSetup: 'mock.module() is global and order-dependent — declare shared mocks only in tests/setup.ts. For per-test mock overrides, use spyOn() or mock().mockImplementation().',
        },
        schema: [],
    },

    create(context) {
        const filename = context.filename ?? context.getFilename?.() ?? '';

        // tests/setup.ts is exempt — it is the canonical home for module mocks
        if(filename.endsWith('tests/setup.ts')) {
            return {};
        }

        return {
            CallExpression(node) {
                // Match mock.module(...)
                if(
                    node.callee.type === 'MemberExpression'
                    && node.callee.object.type === 'Identifier'
                    && node.callee.object.name === 'mock'
                    && node.callee.property.type === 'Identifier'
                    && node.callee.property.name === 'module'
                ) {
                    context.report({
                        node,
                        messageId: 'noMockModuleOutsideSetup',
                    });
                }
            },
        };
    },
};

export default rule;
