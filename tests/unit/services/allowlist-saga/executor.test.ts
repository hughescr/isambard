import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import type { AllowlistSagaBackend, AllowlistSagaLookup } from '@/services/allowlist-saga/backend';
import { AllowlistSagaExecutor } from '@/services/allowlist-saga/executor';
import {
    allowlistSagaSchema,
    type AllowlistSaga,
    type PendingNameAllowlistSaga,
    type PendingReviewAllowlistSaga
} from '@/services/allowlist-saga/types';
import type { ContactBackend } from '@/storage/contacts/backend';
import type { Contact, ContactId } from '@/storage/contacts/types';
import type { PersonAllowlist } from '@/storage/person-allowlist';

const SAGA_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';
const ALICE_ID  = 'alice-smith' as ContactId;

function makeContact(personId: ContactId, displayName: string): Contact {
    return {
        personId,
        displayName,
        identifiers: [{ platform: 'email', value: 'alice@example.com' }],
        createdAt:   '2026-01-01T00:00:00.000Z',
        updatedAt:   '2026-01-01T00:00:00.000Z',
    };
}

const SAGA_BASE = {
    id:              SAGA_UUID,
    platform:        'email',
    identifierValue: 'alice@example.com',
    addedBy:         'outbound-approval',
    createdAt:       '2026-01-01T00:00:00.000Z',
    updatedAt:       '2026-01-01T00:00:00.000Z',
} as const;

function makePendingName(overrides: { displayNameHint?: string } = {}): PendingNameAllowlistSaga {
    return { ...SAGA_BASE, state: 'pending_name', ...overrides };
}

/** Built through the schema so fuzzyMatches carry the ContactId brand, as get() returns them. */
function makeReview(fields: {
    fuzzyMatches:      string[]
    matchIndex?:       number
    adminDisplayName?: string
    displayNameHint?:  string
}): PendingReviewAllowlistSaga {
    return allowlistSagaSchema.parse({ ...SAGA_BASE, state: 'pending_review', matchIndex: 0, ...fields }) as PendingReviewAllowlistSaga;
}

function makeCompleted(resultPersonId: string): AllowlistSaga {
    return allowlistSagaSchema.parse({ ...SAGA_BASE, state: 'completed', resultPersonId });
}

function found(saga: AllowlistSaga): AllowlistSagaLookup {
    return { status: 'found', saga };
}

function controlledPromise(): { promise: Promise<void>, start: () => void, started: Promise<void>, resolve: () => void } {
    const gate = Promise.withResolvers<void>();
    const signal = Promise.withResolvers<void>();
    return { promise: gate.promise, start: () => signal.resolve(), started: signal.promise, resolve: () => gate.resolve() };
}

describe('AllowlistSagaExecutor', () => {
    let contactBackend:       ContactBackend;
    let personAllowlist:      PersonAllowlist;
    let allowlistSagaBackend: AllowlistSagaBackend;
    let executor:             AllowlistSagaExecutor;

    beforeEach(() => {
        contactBackend = {
            resolveIdentifier: jest.fn(async (): Promise<Contact[]> => []),
            fuzzyLookup:       jest.fn(async (): Promise<Contact[]> => []),
            addIdentifier:     jest.fn(async () => undefined),
            getContact:        jest.fn(async (): Promise<Contact | undefined> => undefined),
            putContact:        jest.fn(async () => undefined),
            deleteContact:     jest.fn(async () => undefined),
            removeIdentifier:  jest.fn(async () => undefined),
            listContacts:      jest.fn(async (): Promise<Contact[]> => []),
        } as unknown as ContactBackend;

        personAllowlist = {
            addPerson:     jest.fn(async () => undefined),
            refreshPerson: jest.fn(async () => undefined),
        } as unknown as PersonAllowlist;

        allowlistSagaBackend = {
            create:        jest.fn(async () => undefined),
            get:           jest.fn(async (): Promise<AllowlistSagaLookup> => ({ status: 'not_found' })),
            enterReview:   jest.fn(async () => undefined),
            advanceCursor: jest.fn(async () => undefined),
            complete:      jest.fn(async () => undefined),
        } as unknown as AllowlistSagaBackend;

        executor = new AllowlistSagaExecutor({
            contactBackend,
            personAllowlist,
            allowlistSagaBackend,
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('start()', () => {
        test('returns completed immediately when identifier resolves to existing contact', async () => {
            const alice = makeContact(ALICE_ID, 'Alice Smith');
            jest.spyOn(contactBackend, 'resolveIdentifier').mockResolvedValue([alice]);

            const result = await executor.start('email', 'alice@example.com');

            expect(result).toEqual({ action: 'completed', personId: ALICE_ID, displayName: 'Alice Smith' });
        });

        test('calls addPerson when identifier resolves to existing contact', async () => {
            const alice = makeContact(ALICE_ID, 'Alice Smith');
            jest.spyOn(contactBackend, 'resolveIdentifier').mockResolvedValue([alice]);

            await executor.start('email', 'alice@example.com', undefined, 'my-trigger');

            expect(personAllowlist.addPerson).toHaveBeenCalledWith(ALICE_ID, { addedBy: 'my-trigger' });
        });

        test('uses outbound-approval as default addedBy when not provided', async () => {
            const alice = makeContact(ALICE_ID, 'Alice Smith');
            jest.spyOn(contactBackend, 'resolveIdentifier').mockResolvedValue([alice]);

            await executor.start('email', 'alice@example.com');

            expect(personAllowlist.addPerson).toHaveBeenCalledWith(ALICE_ID, { addedBy: 'outbound-approval' });
        });

        test('creates saga with pending_name state when no contact found', async () => {
            jest.spyOn(contactBackend, 'resolveIdentifier').mockResolvedValue([]);

            await executor.start('email', 'alice@example.com', 'Alice');

            expect(allowlistSagaBackend.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    state:           'pending_name',
                    platform:        'email',
                    identifierValue: 'alice@example.com',
                    displayNameHint: 'Alice',
                    addedBy:         'outbound-approval',
                })
            );
            const created = (allowlistSagaBackend.create as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as AllowlistSaga;
            expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(created.updatedAt).toBe(created.createdAt);
        });

        test('returns need_name with sagaId and hint when no contact found', async () => {
            jest.spyOn(contactBackend, 'resolveIdentifier').mockResolvedValue([]);

            const result = await executor.start('email', 'alice@example.com', 'Alice');

            expect(result.action).toBe('need_name');
            if(result.action === 'need_name') {
                expect(result.hint).toBe('Alice');
                expect(result.sagaId).toMatch(/^[0-9a-f-]{36}$/);
            }
        });

        test('rejects a sparse identifier match array with the persisted-data invariant', async () => {
            const sparseMatches: Contact[] = [];
            sparseMatches.length = 1;
            jest.spyOn(contactBackend, 'resolveIdentifier').mockResolvedValue(sparseMatches);

            await expect(executor.start('email', 'alice@example.com')).rejects.toMatchObject({
                context: {
                    location:  'start',
                    invariant: 'matches[0] undefined despite matches.length > 0',
                },
            });
        });
    });

    describe('unavailable interactions', () => {
        const steps = {
            submitName:   (e: AllowlistSagaExecutor) => e.submitName(SAGA_UUID, 'Alice'),
            confirmMatch: (e: AllowlistSagaExecutor) => e.confirmMatch(SAGA_UUID),
            skipMatch:    (e: AllowlistSagaExecutor) => e.skipMatch(SAGA_UUID),
            createNew:    (e: AllowlistSagaExecutor) => e.createNew(SAGA_UUID),
        } as const;
        const allSteps = Object.keys(steps) as (keyof typeof steps)[];

        function expectNoStepEffects(): void {
            expect(allowlistSagaBackend.enterReview).not.toHaveBeenCalled();
            expect(allowlistSagaBackend.advanceCursor).not.toHaveBeenCalled();
            expect(allowlistSagaBackend.complete).not.toHaveBeenCalled();
            expect(contactBackend.fuzzyLookup).not.toHaveBeenCalled();
            expect(contactBackend.addIdentifier).not.toHaveBeenCalled();
            expect(contactBackend.putContact).not.toHaveBeenCalled();
            expect(personAllowlist.addPerson).not.toHaveBeenCalled();
            expect(personAllowlist.refreshPerson).not.toHaveBeenCalled();
        }

        test.each(allSteps)('%s reports a missing saga as not_found', async (step) => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue({ status: 'not_found' });

            expect(await steps[step](executor)).toEqual({ action: 'unavailable', reason: 'not_found' });
            expect(allowlistSagaBackend.get).toHaveBeenCalledWith(SAGA_UUID);
            expectNoStepEffects();
        });

        test.each(allSteps)('%s reports an unparseable saga row as invalid_step_data', async (step) => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue({ status: 'invalid' });

            expect(await steps[step](executor)).toEqual({ action: 'unavailable', reason: 'invalid_step_data' });
            expectNoStepEffects();
        });

        test.each(allSteps)('%s reports a completed saga as already_completed with the contact display name', async (step) => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(makeCompleted('bob-jones')));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            expect(await steps[step](executor)).toEqual({
                action:      'unavailable',
                reason:      'already_completed',
                personId:    'bob-jones' as ContactId,
                displayName: 'Bob Jones',
            });
            expect(contactBackend.getContact).toHaveBeenCalledWith('bob-jones');
            expectNoStepEffects();
        });

        test.each(allSteps)('%s falls back to the personId for an already_completed saga whose contact is gone', async (step) => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(makeCompleted('bob-jones')));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            expect(await steps[step](executor)).toEqual({
                action:      'unavailable',
                reason:      'already_completed',
                personId:    'bob-jones' as ContactId,
                displayName: 'bob-jones',
            });
        });

        test.each(allSteps)('%s reports a cancelled saga as wrong_state', async (step) => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found({ ...SAGA_BASE, state: 'cancelled' }));

            expect(await steps[step](executor)).toEqual({ action: 'unavailable', reason: 'wrong_state' });
            expect(contactBackend.getContact).not.toHaveBeenCalled();
            expectNoStepEffects();
        });

        test.each([
            ['submitName', makeReview({ fuzzyMatches: ['bob-jones'] })],
            ['confirmMatch', makePendingName()],
            ['skipMatch', makePendingName()],
        ] as const)('%s reports a saga in another open state as wrong_state', async (step, saga) => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));

            expect(await steps[step](executor)).toEqual({ action: 'unavailable', reason: 'wrong_state' });
            expectNoStepEffects();
        });
    });

    describe('submitName()', () => {
        test('creates contact and completes when no fuzzy matches', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(makePendingName()));
            jest.spyOn(contactBackend, 'fuzzyLookup').mockResolvedValue([]);
            // getContact returns undefined (no collision), so personId will be generated from displayName
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.submitName(SAGA_UUID, 'Alice Smith');

            expect(result.action).toBe('completed');
            if(result.action === 'completed') {
                // personId derived from generatePersonId('Alice Smith') = 'alice-smith'
                expect(result.personId).toBe(ALICE_ID);
                // displayName falls back to input since getContact returns undefined
                expect(result.displayName).toBe('Alice Smith');
            }
            expect(allowlistSagaBackend.enterReview).not.toHaveBeenCalled();
        });

        test('enters pending_review with every fuzzy match when fuzzy matches found', async () => {
            const saga = makePendingName();
            const bob = makeContact('bob-jones' as ContactId, 'Bob Jones');
            const bobby = makeContact('bobby-jones' as ContactId, 'Bobby Jones');
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'fuzzyLookup').mockResolvedValue([bob, bobby]);

            await executor.submitName(SAGA_UUID, 'Bob');

            expect(contactBackend.fuzzyLookup).toHaveBeenCalledWith('Bob');
            expect(allowlistSagaBackend.enterReview).toHaveBeenCalledWith(saga, {
                adminDisplayName: 'Bob',
                fuzzyMatches:     ['bob-jones', 'bobby-jones'],
            });
        });

        test('returns review_match with first match when fuzzy matches found', async () => {
            const bob = makeContact('bob-jones' as ContactId, 'Bob Jones');
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(makePendingName()));
            jest.spyOn(contactBackend, 'fuzzyLookup').mockResolvedValue([bob]);

            const result = await executor.submitName(SAGA_UUID, 'Bob');

            expect(result).toEqual({
                action:        'review_match',
                sagaId:        SAGA_UUID,
                matchPersonId: 'bob-jones' as ContactId,
            });
        });

        test('rejects a sparse fuzzy-match result array with the persisted-data invariant', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(makePendingName()));
            const sparseMatches: Contact[] = [];
            sparseMatches.length = 1;
            jest.spyOn(contactBackend, 'fuzzyLookup').mockResolvedValue(sparseMatches);

            await expect(executor.submitName(SAGA_UUID, 'Bob')).rejects.toMatchObject({
                context: {
                    location:  'submitName',
                    invariant: 'fuzzyMatches[0] undefined despite matches.length > 0',
                },
            });
            expect(allowlistSagaBackend.enterReview).not.toHaveBeenCalled();
        });
    });

    describe('confirmMatch()', () => {
        const reviewSaga = makeReview({ adminDisplayName: 'Bob', fuzzyMatches: ['bob-jones'] });

        test('adds identifier to matched contact', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(reviewSaga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            await executor.confirmMatch(SAGA_UUID);

            expect(contactBackend.addIdentifier).toHaveBeenCalledWith('bob-jones', {
                platform: 'email',
                value:    'alice@example.com',
            });
        });

        test('adds person to allowlist', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(reviewSaga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            await executor.confirmMatch(SAGA_UUID);

            expect(personAllowlist.addPerson).toHaveBeenCalledWith('bob-jones', { addedBy: 'outbound-approval' });
            expect(personAllowlist.refreshPerson).toHaveBeenCalledWith('bob-jones');
        });

        test('confirms the candidate under the persisted review cursor', async () => {
            const saga = makeReview({ fuzzyMatches: ['bob-jones', 'bobby-jones'], matchIndex: 1 });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bobby-jones' as ContactId, 'Bobby Jones'));

            const result = await executor.confirmMatch(SAGA_UUID);

            expect(result).toEqual({ action: 'completed', personId: 'bobby-jones' as ContactId, displayName: 'Bobby Jones' });
            expect(allowlistSagaBackend.complete).toHaveBeenCalledWith(saga, 'bobby-jones');
        });

        test('returns completed with correct personId and displayName', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(reviewSaga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            const result = await executor.confirmMatch(SAGA_UUID);

            expect(result).toEqual({
                action:      'completed',
                personId:    'bob-jones' as ContactId,
                displayName: 'Bob Jones',
            });
        });

        test('falls back to personId when the matched contact has no display name', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(reviewSaga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue({
                ...makeContact('bob-jones' as ContactId, 'Bob Jones'),
                // A legacy/partial contact record can carry an absent display name.
                displayName: undefined as unknown as string,
            });

            const result = await executor.confirmMatch(SAGA_UUID);

            expect(result).toEqual({
                action:      'completed',
                personId:    'bob-jones' as ContactId,
                displayName: 'bob-jones',
            });
        });

        test('reports a review cursor outside the candidate list as invalid_step_data without side effects', async () => {
            // Bypasses the schema, which rejects this cursor on read and write.
            const saga: PendingReviewAllowlistSaga = { ...reviewSaga, matchIndex: 4 };
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));

            const result = await executor.confirmMatch(SAGA_UUID);

            expect(result).toEqual({ action: 'unavailable', reason: 'invalid_step_data' });
            expect(contactBackend.addIdentifier).not.toHaveBeenCalled();
            expect(personAllowlist.addPerson).not.toHaveBeenCalled();
            expect(allowlistSagaBackend.complete).not.toHaveBeenCalled();
        });

        test('persists resultPersonId through the complete transition', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(reviewSaga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            await executor.confirmMatch(SAGA_UUID);

            expect(allowlistSagaBackend.complete).toHaveBeenCalledWith(reviewSaga, 'bob-jones');
        });
    });

    describe('skipMatch()', () => {
        test('shows next match when more available', async () => {
            const saga = makeReview({ adminDisplayName: 'Alice', fuzzyMatches: ['alice-a', 'alice-b'] });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));

            const result = await executor.skipMatch(SAGA_UUID);

            expect(allowlistSagaBackend.advanceCursor).toHaveBeenCalledWith(saga, 1);
            expect(result).toEqual({
                action:        'review_match',
                sagaId:        SAGA_UUID,
                matchPersonId: 'alice-b' as ContactId,
            });
        });

        test('creates new contact when no more matches', async () => {
            const saga = makeReview({ adminDisplayName: 'Alice Smith', fuzzyMatches: ['alice-a'] });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.skipMatch(SAGA_UUID);

            expect(result.action).toBe('completed');
            expect(allowlistSagaBackend.advanceCursor).not.toHaveBeenCalled();
        });

        test.each([
            ['display-name hint', { displayNameHint: 'Alice Hint' }, 'Alice Hint'],
            ['identifier value', {}, 'alice@example.com'],
        ] as const)('uses the %s for an accepted review row without an admin display name', async (_label, optionalNames, expectedName) => {
            const persisted = makeReview({
                fuzzyMatches: ['alice-a'],
                matchIndex:   0,
                ...optionalNames,
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(persisted));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.skipMatch(SAGA_UUID);

            expect(contactBackend.putContact).toHaveBeenCalledWith(expect.objectContaining({
                personId:    expect.any(String),
                displayName: expectedName,
            }));
            expect(result).toEqual(expect.objectContaining({ action: 'completed', displayName: expectedName }));
            expect(allowlistSagaBackend.complete).toHaveBeenCalledWith(persisted, expect.any(String));
        });

        test('prefers the admin display name over the caller-supplied hint when no more matches', async () => {
            const saga = makeReview({
                adminDisplayName: 'Alice Smith',
                displayNameHint:  'Alice Hint',
                fuzzyMatches:     ['alice-a'],
                matchIndex:       0,
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.skipMatch(SAGA_UUID);

            expect(contactBackend.putContact).toHaveBeenCalledWith(expect.objectContaining({
                displayName: 'Alice Smith',
            }));
            expect(result).toEqual(expect.objectContaining({ action: 'completed', displayName: 'Alice Smith' }));
        });
    });

    describe('createNew()', () => {
        test('creates new contact and completes', async () => {
            const saga = makeReview({ adminDisplayName: 'Alice Smith', fuzzyMatches: ['some-match'] });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.createNew(SAGA_UUID);

            expect(result.action).toBe('completed');
            expect(personAllowlist.addPerson).toHaveBeenCalledWith(ALICE_ID, { addedBy: 'outbound-approval' });
            expect(allowlistSagaBackend.complete).toHaveBeenCalledWith(saga, ALICE_ID);
        });

        test('uses adminDisplayName when available', async () => {
            const saga = makeReview({
                adminDisplayName: 'Alice Smith',
                displayNameHint:  'A. Smith',
                fuzzyMatches:     ['x'],
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            await executor.createNew(SAGA_UUID);

            // saga completes successfully with admin-provided display name
            expect(contactBackend.putContact).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Alice Smith' }));
            expect(allowlistSagaBackend.complete).toHaveBeenCalledWith(saga, ALICE_ID);
        });

        test('falls back to identifierValue when no name available', async () => {
            const saga = makeReview({ fuzzyMatches: ['x'] });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.createNew(SAGA_UUID);

            expect(result.action).toBe('completed');
        });

        test('creates contact and completes when in pending_name state', async () => {
            const saga = makePendingName({ displayNameHint: 'Alice Smith' });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.createNew(SAGA_UUID);

            expect(result.action).toBe('completed');
            expect(allowlistSagaBackend.complete).toHaveBeenCalledWith(saga, ALICE_ID);
        });

        test('ignores a stray admin display name on a pending_name saga', async () => {
            // Bypasses the schema: only a pending_review saga may carry adminDisplayName.
            const saga = { ...makePendingName({ displayNameHint: 'Alice Smith' }), adminDisplayName: 'Stray' } as PendingNameAllowlistSaga;
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(found(saga));
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.createNew(SAGA_UUID);

            expect(contactBackend.putContact).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Alice Smith' }));
            expect(result).toEqual({ action: 'completed', personId: ALICE_ID, displayName: 'Alice Smith' });
        });
    });

    describe('public completion boundaries', () => {
        const cases: [string, string, string][] = [
            ['start existing contact allowlist write', 'start-existing', 'addPerson'],
            ['start new saga persistence', 'start-new', 'create'],
            ['submit-name review persistence', 'submit-review', 'enterReview'],
            ['confirm-match identifier write', 'confirm', 'addIdentifier'],
            ['confirm-match allowlist write', 'confirm', 'addPerson'],
            ['confirm-match allowlist refresh', 'confirm', 'refreshPerson'],
            ['confirm-match completion persistence', 'confirm', 'complete'],
            ['skip-match index persistence', 'skip', 'advanceCursor'],
            ['create-new allowlist write', 'create-new', 'addPerson'],
            ['create-new completion persistence', 'create-new', 'complete'],
        ];

        test.each(cases)('waits for %s', async (_name, method, target) => {
            const localContactBackend = {
                resolveIdentifier: jest.fn(async (): Promise<Contact[]> => []),
                fuzzyLookup:       jest.fn(async (): Promise<Contact[]> => []),
                addIdentifier:     jest.fn(async () => undefined),
                getContact:        jest.fn(async (): Promise<Contact | undefined> => undefined),
                putContact:        jest.fn(async () => undefined),
            } as unknown as ContactBackend;
            const localAllowlist = {
                addPerson:     jest.fn(async () => undefined),
                refreshPerson: jest.fn(async () => undefined),
            } as unknown as PersonAllowlist;
            const localSagaBackend = {
                create:        jest.fn(async () => undefined),
                get:           jest.fn(async (): Promise<AllowlistSagaLookup> => ({ status: 'not_found' })),
                enterReview:   jest.fn(async () => undefined),
                advanceCursor: jest.fn(async () => undefined),
                complete:      jest.fn(async () => undefined),
            } as unknown as AllowlistSagaBackend;
            const localExecutor = new AllowlistSagaExecutor({
                contactBackend: localContactBackend, personAllowlist: localAllowlist, allowlistSagaBackend: localSagaBackend,
            });
            const gate = controlledPromise();
            let targetMock;
            switch(target) {
                case 'addIdentifier': {
                    targetMock = localContactBackend.addIdentifier;
                    break;
                }
                case 'addPerson': {
                    targetMock = localAllowlist.addPerson;
                    break;
                }
                case 'refreshPerson': {
                    targetMock = localAllowlist.refreshPerson;
                    break;
                }
                default: {
                    targetMock = localSagaBackend[target as 'create' | 'enterReview' | 'advanceCursor' | 'complete'];
                }
            }
            (targetMock as ReturnType<typeof jest.fn>).mockImplementation(() => {
                gate.start();
                return gate.promise;
            });

            const bob = makeContact('bob-jones' as ContactId, 'Bob Jones');
            let completion: Promise<unknown>;
            switch(method) {
                case 'start-existing': {
                    jest.spyOn(localContactBackend, 'resolveIdentifier').mockResolvedValue([bob]);
                    completion = localExecutor.start('email', 'bob@example.com');
                    break;
                }
                case 'start-new': {
                    completion = localExecutor.start('email', 'alice@example.com');
                    break;
                }
                case 'submit-review': {
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(found(makePendingName()));
                    jest.spyOn(localContactBackend, 'fuzzyLookup').mockResolvedValue([bob]);
                    completion = localExecutor.submitName(SAGA_UUID, 'Bob');
                    break;
                }
                case 'confirm': {
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(found(makeReview({ fuzzyMatches: ['bob-jones'] })));
                    completion = localExecutor.confirmMatch(SAGA_UUID);
                    break;
                }
                case 'skip': {
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(found(makeReview({ fuzzyMatches: ['alice-a', 'alice-b'] })));
                    completion = localExecutor.skipMatch(SAGA_UUID);
                    break;
                }
                default: {
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(found(makePendingName({ displayNameHint: 'Alice Smith' })));
                    completion = localExecutor.createNew(SAGA_UUID);
                }
            }
            let completed = false;
            const observed = completion.finally(() => {
                completed = true;
            });
            try {
                await gate.started;
                await Bun.sleep(0);
                expect(completed).toBe(false);
            } finally {
                gate.resolve();
                await observed;
            }
        });
    });
});
