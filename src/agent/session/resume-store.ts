/**
 * A convenience role-bound store over the P8 role-keyed `TASK_SESSION#<role>` rows
 * (src/storage/task-session/backend.ts), for callers that already know which role they mean
 * (e.g. src/index.ts's boot-time transcript-retention lookup — see `storage.createResumeStore`
 * in src/app/storage-layer.ts).
 *
 * `RoleResumeStore` is DELIBERATELY NOT the P7 {@link import('./ports').ResumeStore} port,
 * despite sharing method names: the port's `save` takes `(role, sessionId)` while this one's
 * takes `(sessionId)` alone. TypeScript's fewer-parameters assignability rule would otherwise let
 * a `RoleResumeStore` be assigned wherever a `ResumeStore` is expected — a caller doing so (e.g.
 * `createConductor({ resumeStore: createResumeStore(backend, role) })`) would compile, and the
 * conductor's port-conformant `resumeStore.save(role, sessionId)` call would then silently bind
 * `role`'s own string into this store's one `sessionId` parameter, persisting the literal role
 * name instead of the session id. Never assign a `RoleResumeStore` to a `ResumeStore`-typed
 * variable or parameter; build an explicit `{ load: (r) => ..., save: (r, id) => ... }` adapter
 * (asserting `r === role`) if one is ever needed.
 *
 * @module agent/session/resume-store
 */
import type { SessionRole } from './types';
import { createSessionId, type TaskSessionBackend } from '@/storage';

/** The role-bound resume store {@link createResumeStore} returns — see the module doc for why this is not the `ResumeStore` port. */
export interface RoleResumeStore {
    load:  () => Promise<string | undefined>
    save:  (sessionId: string) => Promise<void>
    clear: () => Promise<void>
}

/**
 * Creates a {@link RoleResumeStore} bound to `role`, backed by `backend`'s role-keyed rows.
 * @param backend The DynamoDB-backed task-session store.
 * @param role    The role this instance's `load`/`save`/`clear` always act on.
 */
export function createResumeStore(backend: Pick<TaskSessionBackend, 'getSessionIdForRole' | 'setSessionIdForRole' | 'clearSessionIdForRole'>, role: SessionRole): RoleResumeStore {
    let lastSaved: string | undefined;

    return {
        load(): Promise<string | undefined> {
            return backend.getSessionIdForRole(role);
        },

        async save(sessionId: string): Promise<void> {
            if(lastSaved === sessionId) {
                return;
            }
            // Recorded before the await settles (rather than after) so a second save() issued
            // while this one is still in flight sees the new intent immediately instead of racing
            // on the pre-await value of `lastSaved`.
            lastSaved = sessionId;
            await backend.setSessionIdForRole(role, createSessionId(sessionId));
        },

        async clear(): Promise<void> {
            await backend.clearSessionIdForRole(role);
            lastSaved = undefined;
        },
    };
}
