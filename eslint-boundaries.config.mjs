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
 *    Note: utils/path-validator.ts and utils/media/video/frame-extractor.ts
 *    are allowed to import from errors (throw typed invariant errors).
 *    This is scoped via internalPath.
 * 2. errors     - Error types, minimal dependencies
 * 3. config     - Configuration loading, minimal dependencies
 * 4. storage    - Data layer, independent of application/agent
 * 4b. services  - Service health, lifecycle, outbox infrastructure
 * 5. agent      - Platform-agnostic AI agent logic
 * 6. discord    - Discord integration, depends on agent
 *    email      - Email integration, depends on agent
 *    bsky       - Bluesky integration, depends on agent
 *    caldav     - CalDAV calendar integration, independent of agent
 * 7. app        - Composition root (src/index.ts + src/app/**), wires everything together
 */

export const boundaryElements = [
    { type: 'utils',   pattern: 'src/utils/**' },
    { type: 'errors',  pattern: 'src/errors/**' },
    { type: 'config',  pattern: 'src/config/**' },
    { type: 'storage',   pattern: 'src/storage/**' },
    { type: 'services', pattern: 'src/services/**' },
    { type: 'agent',    pattern: 'src/agent/**' },
    { type: 'discord', pattern: 'src/integrations/discord/**' },
    { type: 'email',   pattern: 'src/integrations/email/**' },
    { type: 'bsky',    pattern: 'src/integrations/bsky/**' },
    { type: 'caldav',  pattern: 'src/integrations/caldav/**' },
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
        'boundaries/dependencies': ['error', {
            'default': 'disallow',
            rules:     [
                { from: { type: 'utils', internalPath: 'path-validator.ts' }, allow: { to: { type: ['errors'] } } },
                { from: { type: 'utils', internalPath: 'media/video/frame-extractor.ts' }, allow: { to: { type: ['errors'] } } },
                { from: { type: 'errors' },  allow: { to: { type: ['utils'] } } },
                { from: { type: 'config' },  allow: { to: { type: ['utils'] } } },
                { from: { type: 'storage' },  allow: { to: { type: ['utils', 'errors', 'config'] } } },
                { from: { type: 'services' }, allow: { to: { type: ['utils', 'errors', 'config', 'storage'] } } },
                { from: { type: 'agent' },    allow: { to: { type: ['utils', 'errors', 'config', 'storage', 'services', 'email', 'bsky', 'caldav'] } } },
                { from: { type: 'email' },   allow: { to: { type: ['utils', 'errors', 'config', 'storage', 'services', 'agent'] } } },
                { from: { type: 'bsky' },    allow: { to: { type: ['utils', 'errors', 'config', 'storage', 'services', 'agent'] } } },
                { from: { type: 'caldav' },  allow: { to: { type: ['utils', 'errors', 'config', 'storage', 'services'] } } },
                { from: { type: 'discord' }, allow: { to: { type: ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'email', 'bsky', 'caldav'] } } },
                { from: { type: 'app' },     allow: { to: { type: ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'discord', 'email', 'bsky', 'caldav'] } } },
                // Entry-point enforcement (merged from boundaries/entry-point)
                {
                    disallow: {
                        to: {
                            type:         ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'discord', 'email', 'bsky', 'caldav', 'app'],
                            internalPath: '!index.ts'
                        }
                    }
                },
            ]
        }],
    }
};
