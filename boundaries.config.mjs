import { defineBoundaries } from '@hughescr/oxlint-config-default';

/**
 * Architectural Boundary Policy
 *
 * One policy file, one `extends` entry in oxlint.config.ts. `defineBoundaries` validates the policy and
 * returns the Oxlint fragment that enables, with this policy as rule options:
 * - `@hughescr/module-boundaries/dependencies`: the layer allow-list, the barrel-only entry rule
 *   (a module is imported through its `index.ts`) and "every file under src/ belongs to a module"
 * - `@hughescr/module-boundaries/no-cross-module-internal`: no `@internal` import from another module
 *
 * Boundary Philosophy:
 * - Enforce clean separation of concerns across the codebase
 * - Prevent circular dependencies and tight coupling
 * - Make architectural violations visible during development
 * - Rules represent the IDEAL architecture; violations are tracked with eslint-disable comments
 *   rather than weakening the rules to allow current coupling
 *
 * Default deny: a module may import only the modules listed under `allow`; a module with no key
 * imports none. Importing inside one's own module is always allowed.
 *
 * Module Hierarchy (from independent to dependent):
 * 1. utils      - Pure utilities, no domain knowledge
 *    Note: utils/path-validator.ts, utils/contained-fs.ts, utils/media/**,
 *    utils/assert-never.ts, and utils/delivery-code.ts are allowed to import from errors (throw typed
 *    errors). This is scoped through `exceptions`.
 * 2. errors     - Error types, minimal dependencies
 * 3. config     - Configuration loading, minimal dependencies
 * 4. storage    - Data layer, independent of application/agent
 * 4b. services  - Platform-neutral resilience infrastructure: health, lifecycle, outbox (Discord
 *                 wire types via discord-api-types only), approved-outbound-action executor,
 *                 allowlist saga; never discord.js (fenced in oxlint.config.ts, #40)
 * 5. agent      - Agent core plus per-platform MCP adapters; never imports src/integrations/discord
 *                 Discord-specific MCP ports live in src/agent/discord-ports.ts
 * 6. discord    - Discord integration; may import utils/errors/config/storage/services/agent/
 *                 email/bsky/caldav (the broadest of the platform integrations), depends on agent
 *    email      - Email integration; agent<->email is type-only in BOTH directions (neither
 *                 side depends on the other's runtime values, only on shared types)
 *    bsky       - Bluesky integration; agent<->bsky is a full value-level relationship in BOTH
 *                 directions (agent may import bsky's values, bsky may import agent's values)
 *    caldav     - CalDAV calendar integration; one-way only - agent may import caldav, but
 *                 caldav may not import agent (caldav stays independent of agent)
 *    utraque    - Vendor quota/capacity wire adapter; utraque->agent is type-only (agent's
 *                 quota types flow in), utraque never imports agent's runtime values, never
 *                 app, never the anthropic integration
 *    anthropic  - Direct Anthropic usage/quota wire adapter; imports agent's runtime values
 *                 (fileQuotaWindow, hasQuotaWindow, unifiedAnthropicQuotaId), never app, never
 *                 the utraque integration
 *    zotero     - Zotero Web API v3 client pinned to the shared group library, plus Crossref/arXiv/
 *                 HTML metadata (#157); reaches only utils, errors and config, never agent. One-way
 *                 like caldav: agent (the zotero MCP server) and app may import zotero
 *    typesafe   - TypeSafe (Jev) outbox failure classifier; reaches utils, errors, config and
 *                 services (it implements services' OutboxFailureClassifier), never agent. Only
 *                 app and main import it
 * 7. app        - Composition root wiring (src/app/**), wires everything together; imports utraque
 *                 and anthropic directly (src/app/quota-poller.ts)
 * 8. main       - The process entry point (src/index.ts), a one-file module of its own; imports every
 *                 module plus app (through the `@/app` barrel)
 *
 * The discord.js package fence (services and non-discord integrations may not import
 * discord.js directly) is enforced separately in oxlint.config.ts, not here.
 *
 * Every directory module is entered through its `index.ts`: a deep import past the barrel is
 * reported, including on an edge that `allow` permits. Test files are ignored; no other file under
 * src/ may sit outside the modules below.
 */

// What the composition root may reach: everything except itself.
const APP_MAY_IMPORT = ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'discord', 'email', 'bsky', 'caldav', 'utraque', 'anthropic', 'zotero', 'typesafe'];

export default defineBoundaries({
    root:    import.meta.dirname,
    include: ['src/**'],
    ignore:  ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    modules: {
        utils:     'src/utils',
        errors:    'src/errors',
        config:    'src/config',
        storage:   'src/storage',
        services:  'src/services',
        agent:     'src/agent',
        discord:   'src/integrations/discord',
        email:     'src/integrations/email',
        bsky:      'src/integrations/bsky',
        caldav:    'src/integrations/caldav',
        utraque:   'src/integrations/utraque',
        anthropic: 'src/integrations/anthropic',
        zotero:    'src/integrations/zotero',
        typesafe:  'src/integrations/typesafe',
        app:       'src/app',
        main:      'src/index.ts',
    },
    allow: {
        errors:    ['utils'],
        config:    ['utils', 'errors'],
        storage:   ['utils', 'errors', 'config'],
        services:  ['utils', 'errors', 'config', 'storage'],
        agent:     ['utils', 'errors', 'config', 'storage', 'services', 'bsky', 'caldav', 'zotero'],
        email:     ['utils', 'errors', 'config', 'storage', 'services'],
        bsky:      ['utils', 'errors', 'config', 'storage', 'services', 'agent'],
        caldav:    ['utils', 'errors', 'config', 'storage', 'services'],
        discord:   ['utils', 'errors', 'config', 'storage', 'services', 'agent', 'email', 'bsky', 'caldav'],
        utraque:   ['utils', 'errors', 'config'],
        anthropic: ['utils', 'errors', 'config', 'agent'],
        zotero:    ['utils', 'errors', 'config'],
        typesafe:  ['utils', 'errors', 'config', 'services'],
        app:       APP_MAY_IMPORT,
        main:      [...APP_MAY_IMPORT, 'app'],
    },
    allowTypeOnly: {
        agent:   ['email'],
        email:   ['agent'],
        utraque: ['agent'],
    },
    exceptions: [
        { files: ['src/utils/path-validator.ts', 'src/utils/contained-fs.ts', 'src/utils/media/**', 'src/utils/assert-never.ts', 'src/utils/delivery-code.ts'], allow: ['errors'] },
    ],
});
