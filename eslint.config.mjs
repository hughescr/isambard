// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
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
 * 2. errors     - Error types, minimal dependencies
 * 3. config     - Configuration loading, minimal dependencies
 * 4. storage    - Data layer, independent of application/agent
 * 5. agent      - Platform-agnostic AI agent logic
 * 6. discord    - Discord integration, depends on agent
 *    email      - Email integration, depends on agent
 * 7. app        - Composition root (src/index.ts + src/app/**), wires everything together
 */
const eslintConfig = [
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
            'n/no-unpublished-import': 'off',
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
            '@typescript-eslint/await-thenable': 'off',
            // bun:* is a builtin under Bun but classified as external under Node; force it to builtin
            'import-x/order':                    ['warn', {
                groups:                        ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
                pathGroups:                    [{ pattern: 'bun:*', group: 'builtin' }],
                pathGroupsExcludedImportTypes: [],
                'newlines-between':            'never',
                alphabetize:                   { order: 'asc', caseInsensitive: true },
            }],
        }
    }
];

export default eslintConfig;
