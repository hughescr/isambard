import type { AllowlistSagaBackend } from './backend';
import type { AllowlistSaga, AllowlistSagaPlatform } from './types';
import {
    type ContactBackend,
    type ContactId,
    createContactId,
    findOrCreateContact,
    type PersonAllowlist
} from '@/storage';

interface AllowlistSagaExecutorDeps {
    contactBackend:       ContactBackend
    personAllowlist:      PersonAllowlist
    allowlistSagaBackend: AllowlistSagaBackend
}

/** Result of a saga step — tells the caller what UI action to take */
export type SagaStepResult
    = | { action: 'completed', personId: ContactId, displayName: string }
      | { action: 'need_name', sagaId: string, hint?: string }
      | { action: 'review_match', sagaId: string, matchPersonId: ContactId }
      | { action: 'cancelled' };

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
            const personId = matches[0].personId;
            await this.deps.personAllowlist.addPerson(personId, { addedBy: addedBy ?? 'outbound-approval' });
            return { action: 'completed', personId, displayName: matches[0].displayName };
        }

        // Step 2: Create saga in pending_name state
        const now = new Date().toISOString();
        const saga: AllowlistSaga = {
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
    async submitName(sagaId: string, displayName: string): Promise<SagaStepResult> {
        const saga = await this.deps.allowlistSagaBackend.get(sagaId);
        if(saga?.state !== 'pending_name') {
            return { action: 'cancelled' };
        }

        // Fuzzy match
        const matches = await this.deps.contactBackend.fuzzyLookup(displayName);

        if(matches.length === 0) {
            // No matches — create contact and complete
            return this.createAndComplete(saga, displayName);
        }

        // Has matches — enter review state
        const fuzzyMatches = matches.map(c => c.personId as string);
        await this.deps.allowlistSagaBackend.update(sagaId, {
            state:            'pending_review',
            adminDisplayName: displayName,
            fuzzyMatches,
            matchIndex:       0,
        });
        return { action: 'review_match', sagaId, matchPersonId: createContactId(fuzzyMatches[0]) };
    }

    /**
     * Admin confirms a fuzzy match — link identifier to existing contact and complete.
     */
    async confirmMatch(sagaId: string): Promise<SagaStepResult> {
        const saga = await this.deps.allowlistSagaBackend.get(sagaId);
        if(saga?.state !== 'pending_review' || !saga.fuzzyMatches || saga.matchIndex === undefined) {
            return { action: 'cancelled' };
        }

        const personId = createContactId(saga.fuzzyMatches[saga.matchIndex]);

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

        await this.deps.allowlistSagaBackend.update(sagaId, {
            state:          'completed',
            resultPersonId: personId,
        });

        return { action: 'completed', personId, displayName: contact?.displayName ?? personId };
    }

    /**
     * Admin skips current match — show next match or transition to create.
     */
    async skipMatch(sagaId: string): Promise<SagaStepResult> {
        const saga = await this.deps.allowlistSagaBackend.get(sagaId);
        if(saga?.state !== 'pending_review' || !saga.fuzzyMatches || saga.matchIndex === undefined) {
            return { action: 'cancelled' };
        }

        const nextIndex = saga.matchIndex + 1;
        if(nextIndex < saga.fuzzyMatches.length) {
            // More matches to review
            await this.deps.allowlistSagaBackend.update(sagaId, { matchIndex: nextIndex });
            return { action: 'review_match', sagaId, matchPersonId: createContactId(saga.fuzzyMatches[nextIndex]) };
        }

        // No more matches — create new contact
        return this.createAndComplete(saga, saga.adminDisplayName!);
    }

    /**
     * Admin explicitly requests creating a new contact (skipping remaining matches).
     */
    async createNew(sagaId: string): Promise<SagaStepResult> {
        const saga = await this.deps.allowlistSagaBackend.get(sagaId);
        if(saga?.state !== 'pending_review' && saga?.state !== 'pending_name') {
            return { action: 'cancelled' };
        }

        const displayName = saga.adminDisplayName ?? saga.displayNameHint ?? saga.identifierValue;
        return this.createAndComplete(saga, displayName);
    }

    /**
     * Admin cancels the flow.
     */
    async cancel(sagaId: string): Promise<SagaStepResult> {
        await this.deps.allowlistSagaBackend.update(sagaId, { state: 'cancelled' });
        return { action: 'cancelled' };
    }

    /** Internal: create contact and add to allowlist */
    private async createAndComplete(saga: AllowlistSaga, displayName: string): Promise<SagaStepResult> {
        const personId = await findOrCreateContact(
            this.deps.contactBackend,
            saga.platform,
            saga.identifierValue,
            displayName
        );

        await this.deps.personAllowlist.addPerson(personId, { addedBy: saga.addedBy });

        await this.deps.allowlistSagaBackend.update(saga.id, {
            state:          'completed',
            resultPersonId: personId,
        });

        const contact = await this.deps.contactBackend.getContact(personId);
        return { action: 'completed', personId, displayName: contact?.displayName ?? displayName };
    }
}
