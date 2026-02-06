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
    }
];
