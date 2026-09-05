/**
 * In-memory double for the {@link ResumeStore} port (src/agent/session/ports.ts): a role-keyed
 * `Map` standing in for the real DynamoDB-backed store (P8).
 *
 * @module tests/helpers/fake-resume-store
 */
import type { ResumeStore } from '@/agent/session/ports';
import type { SessionRole } from '@/agent/session/types';

/** Scriptable double of the session's role-keyed resumable-session-id store. */
export class FakeResumeStore implements ResumeStore {
    private readonly ids = new Map<SessionRole, string>();
    private scriptedSaveRejection: Error | undefined;

    load(role: SessionRole): Promise<string | undefined> {
        return Promise.resolve(this.ids.get(role));
    }

    save(role: SessionRole, sessionId: string): Promise<void> {
        if(this.scriptedSaveRejection !== undefined) {
            return Promise.reject(this.scriptedSaveRejection);
        }
        this.ids.set(role, sessionId);
        return Promise.resolve();
    }

    /** Make every subsequent {@link save} call reject with `error`, until cleared with `undefined`. */
    scriptSaveRejection(error: Error | undefined): void {
        this.scriptedSaveRejection = error;
    }
}
