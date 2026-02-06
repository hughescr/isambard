import config from '@hughescr/eslint-config-default';
import boundariesPlugin from 'eslint-plugin-boundaries';

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
    {
        files:   ['src/**/*.ts', 'src/**/*.tsx'],
        plugins: {
            boundaries: boundariesPlugin
        },
        settings: {
            'import/resolver': {
                node: {
                    extensions: ['.ts', '.tsx', '.js', '.jsx']
                }
            },
            'boundaries/elements': [
                {
                    type:    'utils',
                    pattern: 'src/utils/**'
                },
                {
                    type:    'config',
                    pattern: 'src/config/**'
                },
                {
                    type:    'storage',
                    pattern: 'src/storage/**'
                },
                {
                    type:    'agent',
                    pattern: 'src/agent/**'
                },
                {
                    type:    'discord',
                    pattern: 'src/integrations/discord/**'
                },
                {
                    type:    'app',
                    pattern: 'src/index.ts'
                }
            ],
            'boundaries/ignore': [
                'src/**/*.test.ts',
                'src/**/*.spec.ts'
            ]
        },
        rules: {
            'boundaries/element-types': ['error', {
                'default': 'disallow',
                rules:     [
                    // utils can't import from any application modules
                    {
                        from:     'utils',
                        disallow: ['agent', 'storage', 'discord', 'config', 'app']
                    },
                    // config can only import from utils
                    {
                        from:     'config',
                        disallow: ['agent', 'storage', 'discord', 'app']
                    },
                    // storage can import from config and utils, but not agent or discord
                    {
                        from:     'storage',
                        disallow: ['agent', 'discord', 'app']
                    },
                    // agent should be platform-agnostic, can't import from discord
                    // Can import from storage, config, and utils
                    {
                        from:     'agent',
                        allow:    ['storage', 'config', 'utils'],
                        disallow: ['discord', 'app']
                    },
                    // discord can import from everything except app
                    {
                        from:     'discord',
                        allow:    ['agent', 'storage', 'config', 'utils'],
                        disallow: ['app']
                    },
                    // app (composition root) can import from anything
                    {
                        from:  'app',
                        allow: ['agent', 'storage', 'discord', 'config', 'utils']
                    }
                ]
            }]
        }
    }
];
