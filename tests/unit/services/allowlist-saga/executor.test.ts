import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import type { AllowlistSagaBackend } from '@/services/allowlist-saga/backend';
import { AllowlistSagaExecutor } from '@/services/allowlist-saga/executor';
import { allowlistSagaSchema, type AllowlistSaga } from '@/services/allowlist-saga/types';
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

        test('rejects a sparse fuzzy-match result array with the persisted-data invariant', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga());
            const sparseMatches: Contact[] = [];
            sparseMatches.length = 1;
            jest.spyOn(contactBackend, 'fuzzyLookup').mockResolvedValue(sparseMatches);

            await expect(executor.submitName(SAGA_UUID, 'Bob')).rejects.toMatchObject({
                context: {
                    location:  'submitName',
                    invariant: 'fuzzyMatches[0] undefined despite matches.length > 0',
                },
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

        test('rejects a persisted out-of-range matchIndex with the persisted-data invariant', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga({
                state:        'pending_review',
                fuzzyMatches: ['bob-jones'],
                matchIndex:   4,
            }));

            await expect(executor.confirmMatch(SAGA_UUID)).rejects.toMatchObject({
                context: {
                    location:  'confirmMatch',
                    invariant: 'fuzzyMatches[matchIndex] undefined despite valid saga state',
                },
            });
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

        test.each([
            ['display-name hint', { displayNameHint: 'Alice Hint' }, 'Alice Hint'],
            ['identifier value', {}, 'alice@example.com'],
        ] as const)('uses the %s for an accepted review row without an admin display name', async (_label, optionalNames, expectedName) => {
            const persisted = allowlistSagaSchema.parse(makeSaga({
                state:        'pending_review',
                fuzzyMatches: ['alice-a'],
                matchIndex:   0,
                ...optionalNames,
            }));
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(persisted);
            jest.spyOn(contactBackend, 'getContact').mockResolvedValue(undefined);

            const result = await executor.skipMatch(SAGA_UUID);

            expect(contactBackend.putContact).toHaveBeenCalledWith(expect.objectContaining({
                personId:    expect.any(String),
                displayName: expectedName,
            }));
            expect(result).toEqual(expect.objectContaining({ action: 'completed', displayName: expectedName }));
            expect(allowlistSagaBackend.update).toHaveBeenCalledWith(SAGA_UUID, expect.objectContaining({
                state:          'completed',
                resultPersonId: expect.any(String),
            }));
        });

        test('returns cancelled for invalid state', async () => {
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'pending_name' }));

            const result = await executor.skipMatch(SAGA_UUID);

            expect(result).toEqual({ action: 'cancelled' });
        });

        test('rejects a sparse persisted fuzzyMatches array with the persisted-data invariant', async () => {
            const fuzzyMatches = ['alice-a'] as string[];
            fuzzyMatches.length = 2;
            jest.spyOn(allowlistSagaBackend, 'get').mockResolvedValue(makeSaga({
                state: 'pending_review', fuzzyMatches, matchIndex: 0,
            }));

            await expect(executor.skipMatch(SAGA_UUID)).rejects.toMatchObject({
                context: {
                    location:  'skipMatch',
                    invariant: 'fuzzyMatches[nextIndex] undefined despite nextIndex < fuzzyMatches.length',
                },
            });
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

    describe('public completion boundaries', () => {
        const cases: [string, string, string][] = [
            ['start existing contact allowlist write', 'start-existing', 'addPerson'],
            ['start new saga persistence', 'start-new', 'update'],
            ['submit-name review persistence', 'submit-review', 'update'],
            ['confirm-match identifier write', 'confirm', 'addIdentifier'],
            ['confirm-match allowlist write', 'confirm', 'addPerson'],
            ['confirm-match allowlist refresh', 'confirm', 'refreshPerson'],
            ['confirm-match completion persistence', 'confirm', 'update'],
            ['skip-match index persistence', 'skip', 'update'],
            ['cancellation persistence', 'cancel', 'update'],
            ['create-new allowlist write', 'create-new', 'addPerson'],
            ['create-new completion persistence', 'create-new', 'update'],
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
                create: jest.fn(async () => undefined),
                get:    jest.fn(async (): Promise<AllowlistSaga | undefined> => undefined),
                update: jest.fn(async () => undefined),
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
                default: { targetMock = method === 'start-new' ? localSagaBackend.create : localSagaBackend.update;
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
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(makeSaga());
                    jest.spyOn(localContactBackend, 'fuzzyLookup').mockResolvedValue([bob]);
                    completion = localExecutor.submitName(SAGA_UUID, 'Bob');
                    break;
                }
                case 'confirm': {
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'pending_review', fuzzyMatches: ['bob-jones'], matchIndex: 0 }));
                    completion = localExecutor.confirmMatch(SAGA_UUID);
                    break;
                }
                case 'skip': {
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'pending_review', fuzzyMatches: ['alice-a', 'alice-b'], matchIndex: 0 }));
                    completion = localExecutor.skipMatch(SAGA_UUID);
                    break;
                }
                case 'cancel': {
                    completion = localExecutor.cancel(SAGA_UUID);
                    break;
                }
                default: {
                    jest.spyOn(localSagaBackend, 'get').mockResolvedValue(makeSaga({ state: 'pending_name', displayNameHint: 'Alice Smith' }));
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
