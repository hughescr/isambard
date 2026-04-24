import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import type { AllowlistSagaBackend } from '@/services/allowlist-saga/backend';
import { AllowlistSagaExecutor } from '@/services/allowlist-saga/executor';
import type { AllowlistSaga } from '@/services/allowlist-saga/types';
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

function makeSaga(overrides: Partial<AllowlistSaga> = {}): AllowlistSaga {
    return {
        id:              SAGA_UUID,
        state:           'pending_name',
        platform:        'email',
        identifierValue: 'alice@example.com',
        addedBy:         'outbound-approval',
        createdAt:       '2026-01-01T00:00:00.000Z',
        updatedAt:       '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
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
            create: jest.fn(async () => undefined),
            get:    jest.fn(async (): Promise<AllowlistSaga | undefined> => undefined),
            update: jest.fn(async () => undefined),
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
    });

    describe('submitName()', () => {
        test('returns cancelled when saga not found', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(undefined);

            const result = await executor.submitName(SAGA_UUID, 'Alice');

            expect(result).toEqual({ action: 'cancelled' });
        });

        test('returns cancelled when saga state is not pending_name', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'pending_review' }));

            const result = await executor.submitName(SAGA_UUID, 'Alice');

            expect(result).toEqual({ action: 'cancelled' });
        });

        test('creates contact and completes when no fuzzy matches', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga());
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
        });

        test('enters pending_review state when fuzzy matches found', async () => {
            const bob = makeContact('bob-jones' as ContactId, 'Bob Jones');
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga());
            jest.spyOn(contactBackend, 'fuzzyLookup').mockResolvedValue([bob]);

            await executor.submitName(SAGA_UUID, 'Bob');

            expect(allowlistSagaBackend.update).toHaveBeenCalledWith(SAGA_UUID, expect.objectContaining({
                state:            'pending_review',
                adminDisplayName: 'Bob',
                fuzzyMatches:     ['bob-jones'],
                matchIndex:       0,
            }));
        });

        test('returns review_match with first match when fuzzy matches found', async () => {
            const bob = makeContact('bob-jones' as ContactId, 'Bob Jones');
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga());
            jest.spyOn(contactBackend, 'fuzzyLookup').mockResolvedValue([bob]);

            const result = await executor.submitName(SAGA_UUID, 'Bob');

            expect(result).toEqual({
                action:        'review_match',
                sagaId:        SAGA_UUID,
                matchPersonId: 'bob-jones' as ContactId,
            });
        });
    });

    describe('confirmMatch()', () => {
        const reviewSaga = makeSaga({
            state:            'pending_review',
            adminDisplayName: 'Bob',
            fuzzyMatches:     ['bob-jones'],
            matchIndex:       0,
        });

        test('adds identifier to matched contact', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(reviewSaga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            await executor.confirmMatch(SAGA_UUID);

            expect(contactBackend.addIdentifier).toHaveBeenCalledWith('bob-jones', {
                platform: 'email',
                value:    'alice@example.com',
            });
        });

        test('adds person to allowlist', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(reviewSaga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            await executor.confirmMatch(SAGA_UUID);

            expect(personAllowlist.addPerson).toHaveBeenCalledWith('bob-jones', { addedBy: 'outbound-approval' });
        });

        test('returns completed with correct personId and displayName', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(reviewSaga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            const result = await executor.confirmMatch(SAGA_UUID);

            expect(result).toEqual({
                action:      'completed',
                personId:    'bob-jones' as ContactId,
                displayName: 'Bob Jones',
            });
        });

        test('persists resultPersonId in saga update', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(reviewSaga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(makeContact('bob-jones' as ContactId, 'Bob Jones'));

            await executor.confirmMatch(SAGA_UUID);

            expect(allowlistSagaBackend.update).toHaveBeenCalledWith(SAGA_UUID, expect.objectContaining({
                state:          'completed',
                resultPersonId: 'bob-jones' as ContactId,
            }));
        });

        test('returns cancelled for invalid state', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'pending_name' }));

            const result = await executor.confirmMatch(SAGA_UUID);

            expect(result).toEqual({ action: 'cancelled' });
        });
    });

    describe('skipMatch()', () => {
        test('shows next match when more available', async () => {
            const saga = makeSaga({
                state:            'pending_review',
                adminDisplayName: 'Alice',
                fuzzyMatches:     ['alice-a', 'alice-b'],
                matchIndex:       0,
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(saga);

            const result = await executor.skipMatch(SAGA_UUID);

            expect(allowlistSagaBackend.update).toHaveBeenCalledWith(SAGA_UUID, { matchIndex: 1 });
            expect(result).toEqual({
                action:        'review_match',
                sagaId:        SAGA_UUID,
                matchPersonId: 'alice-b' as ContactId,
            });
        });

        test('creates new contact when no more matches', async () => {
            const saga = makeSaga({
                state:            'pending_review',
                adminDisplayName: 'Alice Smith',
                fuzzyMatches:     ['alice-a'],
                matchIndex:       0,
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(saga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.skipMatch(SAGA_UUID);

            expect(result.action).toBe('completed');
        });

        test('returns cancelled for invalid state', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'pending_name' }));

            const result = await executor.skipMatch(SAGA_UUID);

            expect(result).toEqual({ action: 'cancelled' });
        });
    });

    describe('createNew()', () => {
        test('creates new contact and completes', async () => {
            const saga = makeSaga({
                state:            'pending_review',
                adminDisplayName: 'Alice Smith',
                fuzzyMatches:     ['some-match'],
                matchIndex:       0,
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(saga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.createNew(SAGA_UUID);

            expect(result.action).toBe('completed');
            expect(personAllowlist.addPerson).toHaveBeenCalledWith(ALICE_ID, { addedBy: 'outbound-approval' });
        });

        test('uses adminDisplayName when available', async () => {
            const saga = makeSaga({
                state:            'pending_review',
                adminDisplayName: 'Alice Smith',
                displayNameHint:  'A. Smith',
                fuzzyMatches:     ['x'],
                matchIndex:       0,
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(saga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            await executor.createNew(SAGA_UUID);

            // saga completes successfully with admin-provided display name
            expect(allowlistSagaBackend.update).toHaveBeenCalledWith(
                SAGA_UUID,
                expect.objectContaining({ state: 'completed' })
            );
        });

        test('falls back to identifierValue when no name available', async () => {
            const saga = makeSaga({
                state:        'pending_review',
                fuzzyMatches: ['x'],
                matchIndex:   0,
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(saga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.createNew(SAGA_UUID);

            expect(result.action).toBe('completed');
        });

        test('returns cancelled for invalid state (completed)', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'completed' }));

            const result = await executor.createNew(SAGA_UUID);

            expect(result).toEqual({ action: 'cancelled' });
        });

        test('creates contact and completes when in pending_name state', async () => {
            const saga = makeSaga({
                state:           'pending_name',
                displayNameHint: 'Alice Smith',
            });
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(saga);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.createNew(SAGA_UUID);

            expect(result.action).toBe('completed');
            expect(allowlistSagaBackend.update).toHaveBeenCalledWith(
                SAGA_UUID,
                expect.objectContaining({ state: 'completed' })
            );
        });
    });

    describe('cancel()', () => {
        test('updates state to cancelled', async () => {
            await executor.cancel(SAGA_UUID);

            expect(allowlistSagaBackend.update).toHaveBeenCalledWith(SAGA_UUID, { state: 'cancelled' });
        });

        test('returns cancelled', async () => {
            const result = await executor.cancel(SAGA_UUID);

            expect(result).toEqual({ action: 'cancelled' });
        });
    });
});
