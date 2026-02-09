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
 * 7. app        - Composition root (src/index.ts), wires everything together
 */

export const boundaryElements = [
    { type: 'utils',   pattern: 'src/utils/**' },
    { type: 'errors',  pattern: 'src/errors/**' },
    { type: 'config',  pattern: 'src/config/**' },
    { type: 'storage', pattern: 'src/storage/**' },
    { type: 'agent',   pattern: 'src/agent/**' },
    { type: 'discord', pattern: 'src/integrations/discord/**' },
    { type: 'app',     pattern: ['src/index.ts', 'src/app/**'] },
];

export const boundariesConfig = {
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
                {
                    from:     'utils',
                    disallow: ['agent', 'storage', 'discord', 'errors', 'config', 'app']
                },
                {
                    from:  'errors',
                    allow: ['utils', 'discord', 'storage']
                },
                {
                    from:     'config',
                    disallow: ['agent', 'storage', 'discord', 'errors', 'app']
                },
                {
                    from:     'storage',
                    allow:    ['errors'],
                    disallow: ['agent', 'discord', 'app']
                },
                {
                    from:     'agent',
                    allow:    ['storage', 'errors', 'config', 'utils'],
                    disallow: ['discord', 'app']
                },
                {
                    from:     'discord',
                    allow:    ['agent', 'storage', 'errors', 'config', 'utils'],
                    disallow: ['app']
                },
                {
                    from:  'app',
                    allow: ['agent', 'storage', 'discord', 'errors', 'config', 'utils']
                }
            ]
        }]
    }
};
