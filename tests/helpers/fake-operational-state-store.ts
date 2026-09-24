/**
 * In-memory {@link OperationalStateStore} for manager-level tests. Values are held as the JSON
 * `content` strings a real row would carry, and every read decodes through the real
 * {@link decodeOperationalState}, so corrupt-row behaviour matches production. `read`, `put` and
 * `listByPrefix` are `mock()` spies so call counts and exact arguments can be asserted.
 */
import { mock, type Mock } from 'bun:test';
import type {
    OperationalStateKey,
    OperationalStateRead,
    OperationalStateSchema,
    OperationalStateStore
} from '@/storage/operational-state';
import { decodeOperationalState } from '@/storage/operational-state/decode';

type ReadFn = (key: OperationalStateKey, schema: OperationalStateSchema<unknown>) => Promise<OperationalStateRead<unknown>>;
type ListFn = (prefix: OperationalStateKey, schema: OperationalStateSchema<unknown>) => Promise<unknown[]>;

export interface FakeOperationalStateStore extends OperationalStateStore {
    read:         OperationalStateStore['read'] & Mock<ReadFn>
    put:          Mock<OperationalStateStore['put']>
    listByPrefix: OperationalStateStore['listByPrefix'] & Mock<ListFn>
    /** Stores raw `content` (e.g. corrupt JSON) under `key` without recording a `put` call. */
    seedRaw(key: OperationalStateKey, content: string): void
    /** Stores `value` JSON-encoded under `key` without recording a `put` call. */
    seed(key: OperationalStateKey, value: unknown): void
    /** The value currently stored under `key`, JSON-decoded, or undefined when absent. */
    stored(key: OperationalStateKey): unknown
}

function storageKey(key: OperationalStateKey): string {
    return `${key.owner}\u0000${key.name}`;
}

export function createFakeOperationalStateStore(): FakeOperationalStateStore {
    const rows = new Map<string, { key: OperationalStateKey, content: string }>();

    async function read<T>(key: OperationalStateKey, schema: OperationalStateSchema<T>): Promise<OperationalStateRead<T>> {
        const row = rows.get(storageKey(key));
        return row ? decodeOperationalState(row.content, schema) : { status: 'absent' };
    }

    async function put(key: OperationalStateKey, value: unknown): Promise<void> {
        rows.set(storageKey(key), { key, content: JSON.stringify(value) });
    }

    async function listByPrefix<T>(prefix: OperationalStateKey, schema: OperationalStateSchema<T>): Promise<T[]> {
        const matching = [...rows.values()]
            .filter(row => row.key.owner === prefix.owner && row.key.name.startsWith(prefix.name))
            .toSorted((a, b) => a.key.name.localeCompare(b.key.name));
        const values: T[] = [];
        for(const row of matching) {
            const decoded = decodeOperationalState(row.content, schema);
            if(decoded.status === 'valid') {
                values.push(decoded.value);
            }
        }
        return values;
    }

    return {
        read:         mock(read) as unknown as FakeOperationalStateStore['read'],
        put:          mock(put),
        listByPrefix: mock(listByPrefix) as unknown as FakeOperationalStateStore['listByPrefix'],
        seedRaw:      (key, content) => {
            rows.set(storageKey(key), { key, content });
        },
        seed: (key, value) => {
            rows.set(storageKey(key), { key, content: JSON.stringify(value) });
        },
        stored: (key) => {
            const row = rows.get(storageKey(key));
            return row === undefined ? undefined : JSON.parse(row.content) as unknown;
        },
    };
}
