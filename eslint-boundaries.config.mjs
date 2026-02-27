// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
import boundariesPlugin from 'eslint-plugin-boundaries';

/**
 * Architectural Boundary Configuration
 *
 * Extracted from eslint.config.mjs for maintainability.
 * Protected by PreToolUse hook to prevent accidental modification.
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

export const boundaryElements = [
    { type: 'utils',   pattern: 'src/utils/**' },
    { type: 'errors',  pattern: 'src/errors/**' },
    { type: 'config',  pattern: 'src/config/**' },
    { type: 'storage', pattern: 'src/storage/**' },
    { type: 'agent',   pattern: 'src/agent/**' },
    { type: 'discord', pattern: 'src/integrations/discord/**' },
    { type: 'email',   pattern: 'src/integrations/email/**' },
    { type: 'app',     pattern: ['src/index.ts', 'src/app/**'] },
];

export const boundariesConfig = {
    files:   ['src/**/*.ts', 'src/**/*.tsx'],
    plugins: {
        boundaries: boundariesPlugin
    },
    settings: {
        'import/resolver': {
            typescript: {
                alwaysTryTypes: true,
                project:        './tsconfig.json'
            }
        },
        'boundaries/elements': boundaryElements,
        'boundaries/ignore':   [
            'src/**/*.test.ts',
            'src/**/*.spec.ts'
        ]
    },
    rules: {
        'boundaries/element-types': ['error', {
            'default': 'disallow',
            rules:     [
                { from: 'utils',   allow: [] },
                { from: 'errors',  allow: ['utils'] },
                { from: 'config',  allow: ['utils'] },
                { from: 'storage', allow: ['utils', 'errors', 'config'] },
                { from: 'agent',   allow: ['utils', 'errors', 'config', 'storage', 'email'] },
                { from: 'email',   allow: ['utils', 'errors', 'config', 'storage', 'agent'] },
                { from: 'discord', allow: ['utils', 'errors', 'config', 'storage', 'agent', 'email'] },
                { from: 'app',     allow: ['utils', 'errors', 'config', 'storage', 'agent', 'discord', 'email'] },
            ]
        }],
        'boundaries/entry-point': ['error', {
            'default': 'disallow',
            rules:     [
                {
                    target: ['utils', 'errors', 'config', 'storage', 'agent', 'discord', 'email', 'app'],
                    allow:  'index.ts'
                }
            ]
        }]
    }
};
