// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
import boundariesPlugin from 'eslint-plugin-boundaries';

/**
 * Architectural Boundary Configuration
 *
 * Extracted from eslint.config.mjs for maintainability.
 *
 * Module Hierarchy (from independent to dependent):
 * 1. utils      - Pure utilities, no domain knowledge
 *    Note: utils/path-validator.ts, utils/media/**, and
 *    utils/assert-never.ts are allowed to import from errors (throw typed errors).
 *    This is scoped via fileInternalPath.
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
 *
 * Written against eslint-plugin-boundaries v7. Three things differ from the v6 shape:
 * `rules` is now `policies`; a bare `{ type }` is an ELEMENT selector and must be wrapped
 * in an ENTITY selector as `{ element: { type } }`; and `internalPath` on an element
 * selector is now `fileInternalPath` (plain `internalPath` survives only inside a `module`
 * sub-selector, for external packages).
 */

/**
 * The module hierarchy, as folders plus the composition-root entry file.
 *
 * This is also consumed by @hughescr/module-boundaries in eslint.config.mjs, which
 * classifies by path prefix and does want the entry file listed here.
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

/**
 * `boundaries/elements` classifies FOLDERS, and v7 warns about any element pattern that
 * looks like a single file. So the entry file is stripped out here and classified through
 * `boundaries/files` instead; the ENTRY_POINT_CATEGORY policy below restores its
 * permissions verbatim. boundaryElements itself keeps the entry file because the
 * @hughescr/module-boundaries rules consume that array and do not share this constraint.
 */
const elementDescriptors = boundaryElements.map(element => (
    element.type === 'app'
        ? { ...element, pattern: 'src/app/**' }
        : element
));

const ENTRY_POINT_CATEGORY = 'entrypoint';

// What the composition root may reach: everything except itself.
const APP_MAY_IMPORT = ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'discord', 'email', 'bsky', 'caldav'];

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
        'boundaries/elements': elementDescriptors,
        'boundaries/files':    [
            { category: ENTRY_POINT_CATEGORY, pattern: 'src/index.ts' }
        ],
        'boundaries/ignore': [
            'src/**/*.test.ts',
            'src/**/*.spec.ts'
        ]
    },
    rules: {
        'boundaries/dependencies': ['error', {
            'default': 'disallow',
            policies:  [
                { from: { element: { type: 'utils', fileInternalPath: 'path-validator.ts' } }, allow: { to: { element: { type: ['errors'] } } } },
                { from: { element: { type: 'utils', fileInternalPath: 'media/**' } }, allow: { to: { element: { type: ['errors'] } } } },
                { from: { element: { type: 'utils', fileInternalPath: 'assert-never.ts' } }, allow: { to: { element: { type: ['errors'] } } } },
                { from: { element: { type: 'errors' } },  allow: { to: { element: { type: ['utils'] } } } },
                { from: { element: { type: 'config' } },  allow: { to: { element: { type: ['utils', 'errors'] } } } },
                { from: { element: { type: 'storage' } },  allow: { to: { element: { type: ['utils', 'errors', 'config'] } } } },
                { from: { element: { type: 'services' } }, allow: { to: { element: { type: ['utils', 'errors', 'config', 'storage'] } } } },
                { from: { element: { type: 'agent' } },    allow: { to: { element: { type: ['utils', 'errors', 'config', 'storage', 'services', 'email', 'bsky', 'caldav'] } } } },
                { from: { element: { type: 'email' } },   allow: { to: { element: { type: ['utils', 'errors', 'config', 'storage', 'services', 'agent'] } } } },
                { from: { element: { type: 'bsky' } },    allow: { to: { element: { type: ['utils', 'errors', 'config', 'storage', 'services', 'agent'] } } } },
                { from: { element: { type: 'caldav' } },  allow: { to: { element: { type: ['utils', 'errors', 'config', 'storage', 'services'] } } } },
                { from: { element: { type: 'discord' } }, allow: { to: { element: { type: ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'email', 'bsky', 'caldav'] } } } },
                { from: { element: { type: 'app' } },     allow: { to: { element: { type: APP_MAY_IMPORT } } } },
                // src/index.ts is the other half of the composition root. It is classified as a
                // file category rather than an element (see elementDescriptors above), so it needs
                // its own policy. Note the extra 'app': under v6 the entry file and src/app/**
                // were one element type, so `import ... from '@/app'` was an intra-type import and
                // never consulted a policy. Splitting them makes that edge visible, and it has to
                // be allowed explicitly or the composition root cannot reach its own layers. The
                // entry-point policy below still restricts it to the '@/app' barrel.
                { from: { file: { categories: ENTRY_POINT_CATEGORY } }, allow: { to: { element: { type: [...APP_MAY_IMPORT, 'app'] } } } },
                // Entry-point enforcement (merged from boundaries/entry-point)
                {
                    disallow: {
                        to: {
                            element: {
                                type:             ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'discord', 'email', 'bsky', 'caldav', 'app'],
                                fileInternalPath: '!index.ts'
                            }
                        }
                    }
                },
            ]
        }],
    }
};
