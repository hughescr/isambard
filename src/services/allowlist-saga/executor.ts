import type { AllowlistSagaBackend } from './backend';
import type {
    AllowlistSaga,
    AllowlistSagaPlatform,
    OpenAllowlistSaga,
    PendingNameAllowlistSaga
} from './types';
import { InvariantViolationError } from '@/errors';
import {
    type ContactBackend,
    type PersonId,
    findOrCreateContact,
    type PersonAllowlist
} from '@/storage';

interface AllowlistSagaExecutorDeps {
    contactBackend:       ContactBackend
    personAllowlist:      PersonAllowlist
    allowlistSagaBackend: AllowlistSagaBackend
}

/**
 * A step was invoked on a saga it can no longer advance: the row is gone, unparseable,
 * in a state the step does not accept, or already completed (carrying the completed
 * result so the caller can re-render it idempotently).
 */
export type SagaUnavailableResult
    = | { action: 'unavailable', reason: 'not_found' | 'wrong_state' | 'invalid_step_data' }
      | { action: 'unavailable', reason: 'already_completed', personId: PersonId, displayName: string };

/** Result of a saga step — tells the caller what UI action to take */
export type SagaStepResult
    = | { action: 'completed', personId: PersonId, displayName: string }
      | { action: 'need_name', sagaId: string, hint?: string }
      | { action: 'review_match', sagaId: string, matchPersonId: PersonId }
      | SagaUnavailableResult;

/** Results returned after the initial saga start, suitable for rendering in an existing interaction. */
export type SagaInteractionResult = Exclude<SagaStepResult, { action: 'need_name' }>;

type OpenSagaState = OpenAllowlistSaga['state'];
type SagaInState<S extends AllowlistSaga['state']> = Extract<AllowlistSaga, { state: S }>;
type LoadedSaga<S extends OpenSagaState> = { saga: SagaInState<S> } | { unavailable: SagaUnavailableResult };

function isInState<S extends AllowlistSaga['state']>(saga: AllowlistSaga, states: readonly S[]): saga is SagaInState<S> {
    return (states as readonly AllowlistSaga['state'][]).includes(saga.state);
}

export class AllowlistSagaExecutor {
    constructor(private readonly deps: AllowlistSagaExecutorDeps) {}

    /**
     * Start a new allowlist saga for a given identifier.
     * If the identifier already belongs to a known contact, immediately completes.
     * Otherwise, creates a saga in 'pending_name' state.
     */
    async start(
        platform: AllowlistSagaPlatform,
        identifierValue: string,
        displayNameHint?: string,
        addedBy?: string
    ): Promise<SagaStepResult> {
        // Step 1: Check if identifier already resolves to a contact
        const matches = await this.deps.contactBackend.resolveIdentifier(platform, identifierValue);
        if(matches.length > 0) {
            const firstMatch = matches[0];
            if(firstMatch === undefined) {
                throw new InvariantViolationError('start', 'matches[0] undefined despite matches.length > 0');
            }
            const { personId, displayName } = firstMatch;
            await this.deps.personAllowlist.addPerson(personId, { addedBy: addedBy ?? 'outbound-approval' });
            return { action: 'completed', personId, displayName };
        }

        // Step 2: Create saga in pending_name state
        const now = new Date().toISOString();
        const saga: PendingNameAllowlistSaga = {
            id:        crypto.randomUUID(),
            state:     'pending_name',
            platform,
            identifierValue,
            displayNameHint,
            addedBy:   addedBy ?? 'outbound-approval',
            createdAt: now,
            updatedAt: now,
        };
        await this.deps.allowlistSagaBackend.create(saga);
        return { action: 'need_name', sagaId: saga.id, hint: displayNameHint };
    }

    /**
     * Handle admin providing a display name.
     * Performs fuzzy match against existing contacts.
     */
    async submitName(sagaId: string, displayName: string): Promise<SagaInteractionResult> {
        const loaded = await this.loadOpen(sagaId, ['pending_name']);
        if('unavailable' in loaded) {
            return loaded.unavailable;
        }
        const { saga } = loaded;

        // Fuzzy match
        const matches = await this.deps.contactBackend.fuzzyLookup(displayName);

        if(matches.length === 0) {
            // No matches — create contact and complete
            return this.createAndComplete(saga, displayName);
        }

        // Has matches — enter review state
        const firstMatch = matches[0];
        if(firstMatch === undefined) {
            throw new InvariantViolationError('submitName', 'fuzzyMatches[0] undefined despite matches.length > 0');
        }
        await this.deps.allowlistSagaBackend.enterReview(saga, {
            adminDisplayName: displayName,
            fuzzyMatches:     matches.map(c => c.personId),
        });
        return { action: 'review_match', sagaId, matchPersonId: firstMatch.personId };
    }

    /**
     * Admin confirms a fuzzy match — link identifier to existing contact and complete.
     */
    async confirmMatch(sagaId: string): Promise<SagaInteractionResult> {
        const loaded = await this.loadOpen(sagaId, ['pending_review']);
        if('unavailable' in loaded) {
            return loaded.unavailable;
        }
        const { saga } = loaded;
        const personId = saga.fuzzyMatches[saga.matchIndex];
        if(personId === undefined) {
            // The schema rejects an out-of-range cursor on read and write; only a row that bypassed it lands here.
            return { action: 'unavailable', reason: 'invalid_step_data' };
        }

        // Add the identifier to the existing contact
        await this.deps.contactBackend.addIdentifier(personId, {
            platform: saga.platform,
            value:    saga.identifierValue,
        });

        // Add to allowlist
        await this.deps.personAllowlist.addPerson(personId, { addedBy: saga.addedBy });
        await this.deps.personAllowlist.refreshPerson(personId);

        // Get display name for result
        const contact = await this.deps.contactBackend.getContact(personId);

        await this.deps.allowlistSagaBackend.complete(saga, personId);

        return { action: 'completed', personId, displayName: contact?.displayName ?? personId };
    }

    /**
     * Admin skips current match — show next match or transition to create.
     */
    async skipMatch(sagaId: string): Promise<SagaInteractionResult> {
        const loaded = await this.loadOpen(sagaId, ['pending_review']);
        if('unavailable' in loaded) {
            return loaded.unavailable;
        }
        const { saga } = loaded;

        const nextIndex = saga.matchIndex + 1;
        const nextMatch = saga.fuzzyMatches[nextIndex];
        if(nextMatch !== undefined) {
            // More matches to review
            await this.deps.allowlistSagaBackend.advanceCursor(saga, nextIndex);
            return { action: 'review_match', sagaId, matchPersonId: nextMatch };
        }

        // No more matches — create new contact
        return this.createAndComplete(saga, saga.adminDisplayName ?? saga.displayNameHint ?? saga.identifierValue);
    }

    /**
     * Admin explicitly requests creating a new contact (skipping remaining matches).
     */
    async createNew(sagaId: string): Promise<SagaInteractionResult> {
        const loaded = await this.loadOpen(sagaId, ['pending_name', 'pending_review']);
        if('unavailable' in loaded) {
            return loaded.unavailable;
        }
        const { saga } = loaded;

        const adminDisplayName = saga.state === 'pending_review' ? saga.adminDisplayName : undefined;
        return this.createAndComplete(saga, adminDisplayName ?? saga.displayNameHint ?? saga.identifierValue);
    }

    /**
     * Internal: load a saga a step can advance, or explain why the step is unavailable.
     * A completed saga reports its result so a repeated click can re-render it.
     */
    private async loadOpen<S extends OpenSagaState>(sagaId: string, accepted: readonly S[]): Promise<LoadedSaga<S>> {
        const lookup = await this.deps.allowlistSagaBackend.get(sagaId);
        if(lookup.status === 'not_found') {
            return { unavailable: { action: 'unavailable', reason: 'not_found' } };
        }
        if(lookup.status === 'invalid') {
            return { unavailable: { action: 'unavailable', reason: 'invalid_step_data' } };
        }
        const { saga } = lookup;
        if(isInState(saga, accepted)) {
            return { saga };
        }
        if(saga.state === 'completed') {
            const personId = saga.resultPersonId;
            const contact  = await this.deps.contactBackend.getContact(personId);
            return { unavailable: { action: 'unavailable', reason: 'already_completed', personId, displayName: contact?.displayName ?? personId } };
        }
        return { unavailable: { action: 'unavailable', reason: 'wrong_state' } };
    }

    /** Internal: create contact and add to allowlist */
    private async createAndComplete(saga: OpenAllowlistSaga, displayName: string): Promise<SagaInteractionResult> {
        const personId = await findOrCreateContact(
            this.deps.contactBackend,
            saga.platform,
            saga.identifierValue,
            displayName
        );

        await this.deps.personAllowlist.addPerson(personId, { addedBy: saga.addedBy });

        await this.deps.allowlistSagaBackend.complete(saga, personId);

        const contact = await this.deps.contactBackend.getContact(personId);
        return { action: 'completed', personId, displayName: contact?.displayName ?? displayName };
    }
}
