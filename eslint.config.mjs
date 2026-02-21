import config from '@hughescr/eslint-config-default';
import { boundariesConfig } from './eslint-boundaries.config.mjs';
import noCrossModuleInternal from './tools/eslint-rules/no-cross-module-internal.mjs';

/**
 * ESLint Configuration with Architectural Boundaries
 *
 * Boundary Philosophy:
 * - Enforce clean separation of concerns across the codebase
 * - Prevent circular dependencies and tight coupling
 * - Make architectural violations visible during development
 * - Rules represent the IDEAL architecture; violations are tracked with eslint-disable comments
 *   rather than weakening the rules to allow current coupling
 *
 * Module Hierarchy (from independent to dependent):
 * 1. utils      - Pure utilities, no domain knowledge
 * 2. config     - Configuration loading, minimal dependencies
 * 3. storage    - Data layer, independent of application/agent
 * 4. agent      - Platform-agnostic AI agent logic
 * 5. discord    - Discord integration, depends on agent
 * 6. app        - Composition root (src/index.ts), wires everything together
 */
export default [
    ...config,
    {
        ignores: [
            'scratch/', // Izzy's work area
            'running/', // Running worktree

            'dist/',
            'node_modules/',

            '.stryker-tmp/',
            'reports/',

            '.serena/',

            '.claude/',

            '.sst/',
            'sst/',
            'sst.config.ts',
            'sst-env.d.ts'
        ]
    },
    {
        rules: {
            'n/no-missing-import':     'off',
            'n/no-unpublished-import': 'off'
        }
    },
    boundariesConfig,
    {
        files:   ['src/**/*.ts', 'src/**/*.tsx'],
        plugins: {
            local: {
                rules: {
                    'no-cross-module-internal': noCrossModuleInternal
                }
            }
        },
        rules: {
            'local/no-cross-module-internal': 'error'
        }
    },
    {
        files: ['tests/**/*.ts'],
        rules: {
            // Bun's expect().rejects is thenable at runtime but types don't declare PromiseLike
            '@typescript-eslint/await-thenable':          'off',
            // Mock assertions use expect(mock.method).toHaveBeenCalled() — unbound reference is fundamental to mock libraries
            '@typescript-eslint/unbound-method':          'off',
            // Test mock callbacks use () => {} for mock creation
            '@typescript-eslint/no-empty-function':       'off',
            // Tests verify behavior with non-Error throwables (HTTP error objects, strings)
            '@typescript-eslint/only-throw-error':        'off',
            // Mock callbacks use () => value; lodash _.constant() doesn't compose with Bun's mock()
            'lodash/prefer-constant':                     'off',
            // Same as above for () => {} vs _.noop
            'lodash/prefer-noop':                         'off',
            // Tests for generators that throw before first yield are intentional
            'require-yield':                              'off',
            // Disable high-volume type-unsafe noise from mock interactions;
            // no-explicit-any stays enforced to require developers to type their mocks
            '@typescript-eslint/no-unsafe-assignment':    'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-call':          'off',
            '@typescript-eslint/no-unsafe-argument':      'off',
            '@typescript-eslint/no-unsafe-return':        'off',
        }
    }
];
