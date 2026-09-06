/**
 * Function-style double for the {@link ServiceHealthRegistry} port (src/services/health-registry.ts),
 * mirroring the shape of the file-local `makeEntry`/`makeRegistry` helpers already hand-rolled in
 * tests/unit/agent/mcp-helpers.test.ts — but shared, and with a `getAll()` that actually reflects
 * the entries handed to {@link makeHealthRegistry} rather than always stubbing `{}`.
 *
 * @module tests/helpers/fake-health-registry
 */
import { mock, type Mock } from 'bun:test';
import type { ServiceHealthRegistry } from '@/services';
import { serviceNameSchema, type HealthChangeListener, type ServiceHealthEntry, type ServiceName } from '@/services/types';

const SERVICE_NAMES = serviceNameSchema.options;

function noopUnsubscribe(): void {
    // no listeners are ever registered by this double, so unsubscribing is a no-op
}

/** Build one {@link ServiceHealthEntry}, defaulting to an `'offline'` service with no recorded failures or errors. */
export function makeHealthEntry(overrides: Partial<ServiceHealthEntry> = {}): ServiceHealthEntry {
    return {
        state:        'offline',
        epoch:        0,
        failureCount: 0,
        ...overrides,
    };
}

export interface MakeHealthRegistryOptions {
    /** Per-service entries. A {@link ServiceName} not named here still gets an entry — {@link makeHealthEntry}'s all-offline default — so `getAll()` always covers every known service. */
    entries?:        Partial<Record<ServiceName, ServiceHealthEntry>>
    /** Per-service `isAvailable()` answers. Defaults to `false` for any service not named here. */
    available?:      Partial<Record<ServiceName, boolean>>
    /** Per-service `isWriteAvailable()` answers. Defaults to `false` for any service not named here. */
    writeAvailable?: Partial<Record<ServiceName, boolean>>
    /** What `buildStatusSummary()` returns. Omit (or pass `undefined`) to model "nothing to report". */
    summary?:        string
}

/**
 * A {@link ServiceHealthRegistry} double whose side-effecting methods are typed as `Mock`s, so a
 * reusing test can read `.mock.calls`/assert on them directly — e.g. to invoke a listener captured
 * via `subscribe` — with no cast at the call site.
 */
export interface FakeHealthRegistry extends ServiceHealthRegistry {
    sendEvent: Mock<(service: ServiceName, event: string, payload?: Record<string, unknown>) => void>
    subscribe: Mock<(listener: HealthChangeListener) => () => void>
    stop:      Mock<() => void>
}

/**
 * Build a scriptable {@link FakeHealthRegistry} double whose read methods (`getAll`,
 * `getEntry`, `getState`, `isAvailable`, `isWriteAvailable`, `buildStatusSummary`) genuinely derive
 * from `options`, and whose side-effecting methods (`sendEvent`, `subscribe`, `stop`) are `mock()`s
 * a test can assert against.
 */
export function makeHealthRegistry(options: MakeHealthRegistryOptions = {}): FakeHealthRegistry {
    const { entries = {}, available = {}, writeAvailable = {}, summary } = options;

    const resolvedEntries = Object.fromEntries(
        SERVICE_NAMES.map(name => [name, entries[name] ?? makeHealthEntry()])
    ) as Record<ServiceName, ServiceHealthEntry>;

    return {
        getState:           mock((service: ServiceName) => resolvedEntries[service].state),
        getEntry:           mock((service: ServiceName) => resolvedEntries[service]),
        getAll:             mock(() => resolvedEntries),
        isAvailable:        mock((service: ServiceName) => available[service] ?? false),
        isWriteAvailable:   mock((service: ServiceName) => writeAvailable[service] ?? false),
        sendEvent:          mock(() => undefined),
        subscribe:          mock(() => noopUnsubscribe),
        buildStatusSummary: mock(() => summary),
        stop:               mock(() => undefined),
    };
}
