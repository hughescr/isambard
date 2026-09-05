import { describe, test, expect, mock } from 'bun:test';
import { createResumeStore } from '@/agent/session/resume-store';
import type { TaskSessionBackend } from '@/storage/task-session/backend';

const SESSION_ID_A = '550e8400-e29b-41d4-a716-446655440000';
const SESSION_ID_B = '660e8400-e29b-41d4-a716-446655440001';

function createFakeBackend() {
    const stored = new Map<string, string>();
    return {
        getSessionIdForRole: mock((role: string) => Promise.resolve(stored.get(role))),
        setSessionIdForRole: mock((role: string, id: string) => {
            stored.set(role, id);
            return Promise.resolve();
        }),
        clearSessionIdForRole: mock((role: string) => {
            stored.delete(role);
            return Promise.resolve();
        }),
    };
}

describe('createResumeStore', () => {
    // Deliberately NOT `const store: ResumeStore = createResumeStore(...)`: RoleResumeStore's
    // single-argument save(sessionId) is structurally assignable to the P7 ResumeStore port's
    // save(role, sessionId) (fewer-params assignability), but semantically wrong — a
    // port-conformant caller's save(role, sessionId) call would bind `role` into this store's
    // `sessionId` parameter. See the module doc on RoleResumeStore for the full explanation.
    test('returns a role-bound store exposing load/save/clear with no role parameter', () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'conversation');

        expect(typeof store.load).toBe('function');
        expect(store.load).toHaveLength(0);
        expect(store.save).toHaveLength(1);
    });

    test('load() resolves undefined when nothing was ever saved', async () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'conversation');

        await expect(store.load()).resolves.toBeUndefined();
    });

    test('save() then load() round-trips the id', async () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'conversation');

        await store.save(SESSION_ID_A);

        await expect(store.load()).resolves.toBe(SESSION_ID_A);
        expect(backend.setSessionIdForRole).toHaveBeenCalledTimes(1);
    });

    test('save() with the role baked in writes under that role, not another', async () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'perch');

        await store.save(SESSION_ID_A);

        expect(backend.setSessionIdForRole).toHaveBeenCalledWith('perch', SESSION_ID_A);
    });

    test('a repeated save() of the same id is a no-op against the backend', async () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'conversation');
        await store.save(SESSION_ID_A);

        await store.save(SESSION_ID_A);

        expect(backend.setSessionIdForRole).toHaveBeenCalledTimes(1);
    });

    test('save() of a different id after an earlier save writes through again', async () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'conversation');
        await store.save(SESSION_ID_A);

        await store.save(SESSION_ID_B);

        expect(backend.setSessionIdForRole).toHaveBeenCalledTimes(2);
        await expect(store.load()).resolves.toBe(SESSION_ID_B);
    });

    test('clear() deletes the stored id for this store\'s own role', async () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'conversation');
        await store.save(SESSION_ID_A);

        await store.clear();

        expect(backend.clearSessionIdForRole).toHaveBeenCalledWith('conversation');
        await expect(store.load()).resolves.toBeUndefined();
    });

    test('a save() after clear() writes through again (not suppressed as a repeat)', async () => {
        const backend = createFakeBackend();
        const store = createResumeStore(backend as unknown as TaskSessionBackend, 'conversation');
        await store.save(SESSION_ID_A);
        await store.clear();

        await store.save(SESSION_ID_A);

        expect(backend.setSessionIdForRole).toHaveBeenCalledTimes(2);
    });
});
