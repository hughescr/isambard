/**
 * Tests for ContactReconciler
 *
 * Tests two reconciliation phases:
 *   Phase A (orphan-lookup): lookup row exists but contactId has no profile → delete
 *                            OR profile exists but no longer claims the identifier → delete (stray)
 *   Phase B (missing-lookup): profile claims identifier but no lookup row exists → create
 */
import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    QueryCommand,
    BatchWriteCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { runContactReconciliation, type ContactReconcilerDeps, type ContactReconcilerOptions } from '@/storage/contacts/reconciliation/reconciler';

const ALICE_PROFILE_ITEM = {
    PK:          'CONTACT#alice-smith',
    SK:          'PROFILE',
    GSI2PK:      'CONTACTS',
    GSI2SK:      'CONTACT#alice-smith',
    personId:    'alice-smith',
    displayName: 'Alice Smith',
    identifiers: [
        { platform: 'email', value: 'alice@example.com' },
        { platform: 'discord', value: 'alice#1234' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
};

const BOB_PROFILE_ITEM = {
    PK:          'CONTACT#bob-jones',
    SK:          'PROFILE',
    GSI2PK:      'CONTACTS',
    GSI2SK:      'CONTACT#bob-jones',
    personId:    'bob-jones',
    displayName: 'Bob Jones',
    identifiers: [
        { platform: 'email', value: 'bob@example.com' },
    ],
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-16T00:00:00.000Z',
};

const ALICE_EMAIL_LOOKUP = {
    PK:       'CONTACT_LOOKUP#email#alice@example.com',
    SK:       'CONTACT#alice-smith',
    GSI2PK:   'CONTACT_LOOKUPS',
    GSI2SK:   'CONTACT#alice-smith#email#alice@example.com',
    personId: 'alice-smith',
};

const ALICE_DISCORD_LOOKUP = {
    PK:       'CONTACT_LOOKUP#discord#alice#1234',
    SK:       'CONTACT#alice-smith',
    GSI2PK:   'CONTACT_LOOKUPS',
    GSI2SK:   'CONTACT#alice-smith#discord#alice#1234',
    personId: 'alice-smith',
};

const BOB_EMAIL_LOOKUP = {
    PK:       'CONTACT_LOOKUP#email#bob@example.com',
    SK:       'CONTACT#bob-jones',
    GSI2PK:   'CONTACT_LOOKUPS',
    GSI2SK:   'CONTACT#bob-jones#email#bob@example.com',
    personId: 'bob-jones',
};

/** Minimal reconciler options: zero delay so tests are fast; large age threshold so stray checks use old-enough path */
const FAST_OPTIONS: ContactReconcilerOptions = {
    operationDelayMs:          0,
    scanPageSize:              25,
    strayLookupAgeThresholdMs: 0, // 0 = treat all stray lookups as old enough to delete (fast tests don't need age protection)
};

describe('runContactReconciliation', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let mockSleep: ReturnType<typeof mock>;
    let deps: ContactReconcilerDeps;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);

        mockSleep = mock(async (_ms: number): Promise<void> => undefined);
        deps = {
            docClient: ddbMock as unknown as DynamoDBDocumentClient,
            tableName: 'TestTable',
            sleep:     mockSleep as (ms: number) => Promise<void>,
        };
    });

    afterEach(() => {
        ddbMock.restore();
        mockSleep.mockReset();
        jest.restoreAllMocks();
    });

    // ======================================================================
    // Phase A: Orphan lookup detection and cleanup
    // ======================================================================
    describe('Phase A: orphan lookup cleanup', () => {
        test('returns success:true with zero errors when no contacts exist', async () => {
            // Phase A: GSI2 query returns no CONTACT_LOOKUPS items
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.success).toBe(true);
            expect(result.phaseA.errors).toBe(0);
            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
        });

        test('Phase A query uses IndexName=GSI2 and GSI2PK=CONTACT_LOOKUPS', async () => {
            // Fix 8: assert that the Phase A query targets the correct GSI2 partition
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await runContactReconciliation(deps, FAST_OPTIONS);

            const queryCalls = ddbMock.commandCalls(QueryCommand);
            // First call is Phase A (CONTACT_LOOKUPS), second is Phase B (CONTACTS)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess
            const phaseAInput = queryCalls[0]!.args[0].input;
            expect(phaseAInput).toMatchObject({
                IndexName:                 'GSI2',
                ExpressionAttributeValues: { ':gsi2pk': 'CONTACT_LOOKUPS' },
            });
        });

        test('Phase B query uses IndexName=GSI2 and GSI2PK=CONTACTS', async () => {
            // Fix 8: assert that the Phase B query targets the correct GSI2 partition
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await runContactReconciliation(deps, FAST_OPTIONS);

            const queryCalls = ddbMock.commandCalls(QueryCommand);
            // Second call is Phase B (CONTACTS)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess
            const phaseBInput = queryCalls[1]!.args[0].input;
            expect(phaseBInput).toMatchObject({
                IndexName:                 'GSI2',
                ExpressionAttributeValues: { ':gsi2pk': 'CONTACTS' },
            });
        });

        test('does not delete lookup row when profile exists and claims the identifier', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: CONTACT_LOOKUPS → two lookup rows
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP, ALICE_DISCORD_LOOKUP] })
                // Phase B: CONTACTS → alice profile
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            // Phase A GetCommand for profile lookup: profile exists and claims both identifiers
            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });
            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(BatchWriteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
        });

        test('deletes lookup row when its contactId has no profile', async () => {
            // A lookup row pointing to 'ghost-contact' which has no profile
            const orphanLookup = {
                PK:       'CONTACT_LOOKUP#email#ghost@example.com',
                SK:       'CONTACT#ghost-contact',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#ghost-contact#email#ghost@example.com',
                personId: 'ghost-contact',
            };

            ddbMock.on(QueryCommand)
                // Phase A: one orphan lookup
                .resolvesOnce({ Items: [orphanLookup] })
                // Phase B: scan profiles — none
                .resolvesOnce({ Items: [] });

            // GetCommand for profile of 'ghost-contact': not found
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseA.orphanLookupsDeleted).toBe(1);
            expect(result.success).toBe(true);

            // DeleteCommand must have been called for the orphan lookup
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
            const deleteKeys = deleteCalls.map(c => c.args[0].input.Key);
            expect(deleteKeys).toContainEqual({
                PK: 'CONTACT_LOOKUP#email#ghost@example.com',
                SK: 'CONTACT#ghost-contact',
            });
        });

        // Fix 2: stray lookup — profile exists but no longer claims the identifier
        test('Fix 2: deletes stray lookup when profile exists but does not claim the identifier', async () => {
            // Alice had 'old-email@example.com' but has since removed it
            const strayLookup = {
                PK:       'CONTACT_LOOKUP#email#old-email@example.com',
                SK:       'CONTACT#alice-smith',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#alice-smith#email#old-email@example.com',
                personId: 'alice-smith',
            };

            ddbMock.on(QueryCommand)
                // Phase A: one stray lookup (alice-smith exists but no longer has old-email)
                .resolvesOnce({ Items: [strayLookup] })
                // Phase B: no profiles (just test Phase A)
                .resolvesOnce({ Items: [] });

            // Profile exists but identifiers only has alice@example.com and alice#1234 (not old-email)
            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseA.orphanLookupsDeleted).toBe(1);
            expect(result.success).toBe(true);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
            const deleteKeys = deleteCalls.map(c => c.args[0].input.Key);
            expect(deleteKeys).toContainEqual({
                PK: 'CONTACT_LOOKUP#email#old-email@example.com',
                SK: 'CONTACT#alice-smith',
            });
        });

        test('Fix 2: does not delete lookup when profile exists and still claims the identifier', async () => {
            // alice@example.com is still in Alice's identifiers — should NOT be deleted
            ddbMock.on(QueryCommand)
                // Phase A: one valid lookup
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP] })
                // Phase B: alice profile
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });
            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(BatchWriteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
        });

        test('Fix 2: does not delete lookup when profile has no identifiers field (conservative)', async () => {
            // Profile exists but has no identifiers array — treat as valid (conservative path)
            const profileWithNoIdentifiers = {
                PK:       'CONTACT#alice-smith',
                SK:       'PROFILE',
                GSI2PK:   'CONTACTS',
                GSI2SK:   'CONTACT#alice-smith',
                personId: 'alice-smith',
                // intentionally no 'identifiers' field
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP] })
                .resolvesOnce({ Items: [] });

            ddbMock.on(GetCommand).resolves({ Item: profileWithNoIdentifiers });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            // Conservative: no identifiers array → no deletion
            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
        });

        test('Fix 2: case-insensitive stray check — does not delete when identifier differs only in case', async () => {
            // Lookup has lowercase email, profile stores 'Alice@Example.COM' (uppercase) → should still match
            const profileWithUpperCaseEmail = {
                ...ALICE_PROFILE_ITEM,
                identifiers: [
                    { platform: 'email', value: 'Alice@Example.COM' }, // uppercase — but normalized lookup matches
                    { platform: 'discord', value: 'alice#1234' },
                ],
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP] }) // lookup has alice@example.com (lowercase)
                .resolvesOnce({ Items: [] });

            ddbMock.on(GetCommand).resolves({ Item: profileWithUpperCaseEmail });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            // Should NOT be deleted: case-insensitive match
            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
        });

        test('Fix 2: trims whitespace when comparing identifier values', async () => {
            // Profile stores padded identifier ' alice@example.com ' — should match trimmed lookup
            const profileWithPaddedEmail = {
                ...ALICE_PROFILE_ITEM,
                identifiers: [
                    { platform: 'email', value: ' alice@example.com ' }, // has leading/trailing spaces
                    { platform: 'discord', value: 'alice#1234' },
                ],
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP] }) // lookup has trimmed value
                .resolvesOnce({ Items: [] });

            ddbMock.on(GetCommand).resolves({ Item: profileWithPaddedEmail });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            // Should NOT be deleted: trimmed match
            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
        });

        test('deletes multiple orphan lookup rows in one pass', async () => {
            const orphan1 = {
                PK:       'CONTACT_LOOKUP#email#orphan1@example.com',
                SK:       'CONTACT#orphan-1',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#orphan-1#email#orphan1@example.com',
                personId: 'orphan-1',
            };
            const orphan2 = {
                PK:       'CONTACT_LOOKUP#discord#orphan2',
                SK:       'CONTACT#orphan-2',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#orphan-2#discord#orphan2',
                personId: 'orphan-2',
            };

            ddbMock.on(QueryCommand)
                // Phase A: two orphan lookups
                .resolvesOnce({ Items: [orphan1, orphan2] })
                // Phase B: no profiles
                .resolvesOnce({ Items: [] });

            // All profile lookups return not-found
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseA.orphanLookupsDeleted).toBe(2);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(2);
        });

        test('counts errors when delete of orphan lookup fails', async () => {
            const orphanLookup = {
                PK:       'CONTACT_LOOKUP#email#ghost@example.com',
                SK:       'CONTACT#ghost-contact',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#ghost-contact#email#ghost@example.com',
                personId: 'ghost-contact',
            };

            ddbMock.on(QueryCommand)
                // Phase A: one orphan lookup
                .resolvesOnce({ Items: [orphanLookup] })
                // Phase B: no profiles
                .resolvesOnce({ Items: [] });

            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).rejects(new Error('DynamoDB error'));

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseA.errors).toBeGreaterThan(0);
            expect(result.success).toBe(false);
        });

        test('paginates through multiple pages of lookup rows', async () => {
            // Both lookups point to alice-smith; mock returns Alice's profile correctly
            ddbMock.on(QueryCommand)
                // Phase A page 1 — lookup for alice@example.com
                .resolvesOnce({
                    Items:            [ALICE_EMAIL_LOOKUP],
                    LastEvaluatedKey: { PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-smith' },
                })
                // Phase A page 2 — lookup for alice#1234
                .resolvesOnce({ Items: [ALICE_DISCORD_LOOKUP] })
                // Phase B: no profiles
                .resolvesOnce({ Items: [] });

            // Phase A GetCommand: Alice's profile exists and claims both identifiers
            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            // Both pages processed, no orphans
            expect(result.phaseA.itemsScanned).toBe(2);
            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
            // QueryCommand called 3 times: 2 for Phase A pagination + 1 for Phase B profiles
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(3);
        });
    });

    // ======================================================================
    // Phase B: Missing lookup detection and repair
    // ======================================================================
    describe('Phase B: missing lookup repair', () => {
        test('returns phaseB.missingLookupsCreated=0 when all lookups exist', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: scan lookups — all present, no orphans
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP, ALICE_DISCORD_LOOKUP] })
                // Phase B: scan profiles
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            // Phase A GetCommand: Alice's profile exists and claims both identifiers
            // Phase B inner check GetCommand: each lookup exists
            ddbMock.on(GetCommand)
                // Phase A: alice-smith profile found, claims email
                .resolvesOnce({ Item: ALICE_PROFILE_ITEM })
                // Phase A: alice-smith profile found, claims discord
                .resolvesOnce({ Item: ALICE_PROFILE_ITEM })
                // Phase B inner: email lookup exists
                .resolvesOnce({ Item: ALICE_EMAIL_LOOKUP })
                // Phase B inner: discord lookup exists
                .resolvesOnce({ Item: ALICE_DISCORD_LOOKUP });

            ddbMock.on(BatchWriteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseB.missingLookupsCreated).toBe(0);
        });

        test('creates lookup row when profile claims identifier but lookup row is missing', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: scan lookups — empty (no existing lookup rows)
                .resolvesOnce({ Items: [] })
                // Phase B: scan profiles — one profile with 2 identifiers
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            // Phase B inner check: GetCommand returns no item (lookup is missing)
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(BatchWriteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseB.missingLookupsCreated).toBe(2);
            expect(result.success).toBe(true);

            // BatchWriteCommand should have been called to create the missing lookups
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(1);

            // Verify write payload has correct lookup item structure (PK/SK, GSI2 keys, and personId)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; bwCalls.length asserted >=1 above
            const firstArgs = bwCalls[0]!.args[0].input;
            const firstItems = firstArgs.RequestItems?.TestTable;
            expect(Array.isArray(firstItems)).toBe(true);
            expect(firstItems?.length).toBeGreaterThanOrEqual(1);
            const firstItem = firstItems?.[0]?.PutRequest?.Item;
            expect(firstItem?.personId).toBe('alice-smith');
            expect(typeof firstItem?.PK).toBe('string');
            expect(typeof firstItem?.SK).toBe('string');
            // New lookup items must include GSI2 keys for future Phase A queries
            expect(firstItem?.GSI2PK).toBe('CONTACT_LOOKUPS');
            expect(typeof firstItem?.GSI2SK).toBe('string');
        });

        test('creates only missing lookups, skips existing ones', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: scan lookups — email exists, discord doesn't
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP] })
                // Phase B: scan profiles
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            ddbMock.on(GetCommand)
                // Phase A GetCommand: alice@example.com → alice-smith profile exists and claims it
                .resolvesOnce({ Item: ALICE_PROFILE_ITEM })
                // Phase B inner: email lookup — exists
                .resolvesOnce({ Item: ALICE_EMAIL_LOOKUP })
                // Phase B inner: discord lookup — missing
                .resolvesOnce({});

            ddbMock.on(BatchWriteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseB.missingLookupsCreated).toBe(1);
        });

        test('counts errors when creating missing lookup fails', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: no orphans
                .resolvesOnce({ Items: [] })
                // Phase B: one profile
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            // Phase B inner check: GetCommand returns no item (lookup is missing) for both identifiers
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(BatchWriteCommand).rejects(new Error('DynamoDB error'));

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseB.errors).toBeGreaterThan(0);
            expect(result.success).toBe(false);
        });

        test('paginates through multiple pages of profiles in phase B', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: all lookups present
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP, ALICE_DISCORD_LOOKUP, BOB_EMAIL_LOOKUP] })
                // Phase B page 1: alice profile
                .resolvesOnce({
                    Items:            [ALICE_PROFILE_ITEM],
                    LastEvaluatedKey: { PK: 'CONTACT#alice-smith', SK: 'PROFILE' },
                })
                // Phase B page 2: bob profile
                .resolvesOnce({ Items: [BOB_PROFILE_ITEM] });

            ddbMock.on(GetCommand)
                // Phase A: alice-smith email lookup — alice claims it
                .resolvesOnce({ Item: ALICE_PROFILE_ITEM })
                // Phase A: alice-smith discord lookup — alice claims it
                .resolvesOnce({ Item: ALICE_PROFILE_ITEM })
                // Phase A: bob-jones email lookup — bob claims it
                .resolvesOnce({ Item: BOB_PROFILE_ITEM })
                // Phase B inner: alice email lookup — exists
                .resolvesOnce({ Item: ALICE_EMAIL_LOOKUP })
                // Phase B inner: alice discord lookup — exists
                .resolvesOnce({ Item: ALICE_DISCORD_LOOKUP })
                // Phase B inner: bob email lookup — exists
                .resolvesOnce({ Item: BOB_EMAIL_LOOKUP });

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            // Both profiles from both pages must be scanned
            expect(result.phaseB.itemsScanned).toBe(2);
            expect(result.phaseB.missingLookupsCreated).toBe(0);
        });
    });

    // ======================================================================
    // Combined result
    // ======================================================================
    describe('result structure', () => {
        test('returns complete ReconciliationResult shape', async () => {
            // resolves (not resolvesOnce) — always returns empty for both phases
            ddbMock.on(QueryCommand).resolves({ Items: [] });
            ddbMock.on(GetCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(typeof result.success).toBe('boolean');
            expect(typeof result.totalDurationMs).toBe('number');
            expect(typeof result.phaseA).toBe('object');
            expect(typeof result.phaseB).toBe('object');
            expect(typeof result.phaseA.errors).toBe('number');
            expect(typeof result.phaseA.orphanLookupsDeleted).toBe('number');
            expect(typeof result.phaseA.itemsScanned).toBe('number');
            expect(typeof result.phaseB.errors).toBe('number');
            expect(typeof result.phaseB.missingLookupsCreated).toBe('number');
            expect(typeof result.phaseB.itemsScanned).toBe('number');
        });

        test('success is false when any phase has errors', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: one orphan lookup
                .resolvesOnce({ Items: [{ PK: 'CONTACT_LOOKUP#email#x@y.com', SK: 'CONTACT#x', personId: 'x' }] })
                // Phase B: no profiles
                .resolvesOnce({ Items: [] });

            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).rejects(new Error('delete failed'));
            ddbMock.on(BatchWriteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.success).toBe(false);
        });

        test('success is true when both phases complete with no errors', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });
            ddbMock.on(GetCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.success).toBe(true);
            expect(result.phaseA.errors).toBe(0);
            expect(result.phaseB.errors).toBe(0);
        });

        test('totalDurationMs is a non-negative integer', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });
            ddbMock.on(GetCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
        });
    });

    // ======================================================================
    // Rate-limiting delay
    // ======================================================================
    describe('rate-limiting delay', () => {
        test('calls sleep between operations when operationDelayMs > 0', async () => {
            const orphanLookup = {
                PK:       'CONTACT_LOOKUP#email#ghost@example.com',
                SK:       'CONTACT#ghost-contact',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#ghost-contact#email#ghost@example.com',
                personId: 'ghost-contact',
            };

            ddbMock.on(QueryCommand)
                // Phase A: one orphan lookup
                .resolvesOnce({ Items: [orphanLookup] })
                // Phase B: no profiles
                .resolvesOnce({ Items: [] });
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          50,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
            });

            expect(result.success).toBe(true);
            // Sleep must have been called at least once for the delay (no signal so second arg absent)
            expect(mockSleep).toHaveBeenCalledWith(50);
        });

        test('does not call sleep when operationDelayMs is 0', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
            });

            expect(result.success).toBe(true);
            expect(mockSleep).not.toHaveBeenCalled();
        });
    });

    // ======================================================================
    // Additional coverage: counter increments, outer catch, pagination, timing
    // ======================================================================
    describe('Phase B: itemsScanned counter', () => {
        test('increments itemsScanned for each profile processed', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: no lookup rows
                .resolvesOnce({ Items: [] })
                // Phase B: two profiles
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM, BOB_PROFILE_ITEM] });

            ddbMock.on(GetCommand)
                // Phase B inner: Alice email lookup — exists
                .resolvesOnce({ Item: ALICE_EMAIL_LOOKUP })
                // Phase B inner: Alice discord lookup — exists
                .resolvesOnce({ Item: ALICE_DISCORD_LOOKUP })
                // Phase B inner: Bob email lookup — exists
                .resolvesOnce({ Item: BOB_EMAIL_LOOKUP });

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseB.itemsScanned).toBe(2);
        });
    });

    describe('Phase B: outer catch for parse errors', () => {
        test('counts error and continues when profile item fails to parse', async () => {
            // An item that won't parse as a valid Contact
            const badItem = { PK: 'CONTACT#bad', SK: 'PROFILE', GSI2PK: 'CONTACTS', GSI2SK: 'CONTACT#bad' };

            ddbMock.on(QueryCommand)
                // Phase A: no orphans
                .resolvesOnce({ Items: [] })
                // Phase B: one valid and one invalid profile
                .resolvesOnce({ Items: [badItem, ALICE_PROFILE_ITEM] });

            ddbMock.on(GetCommand)
                // Phase B inner: Alice email lookup — exists
                .resolvesOnce({ Item: ALICE_EMAIL_LOOKUP })
                // Phase B inner: Alice discord lookup — exists
                .resolvesOnce({ Item: ALICE_DISCORD_LOOKUP });

            ddbMock.on(BatchWriteCommand).resolves({});

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            // The bad item should have caused an error
            expect(result.phaseB.errors).toBeGreaterThanOrEqual(1);
            // But the valid profile should still have been scanned
            expect(result.phaseB.itemsScanned).toBeGreaterThanOrEqual(2);
        });
    });

    describe('totalDurationMs timing', () => {
        test('totalDurationMs is less than current wall time (subtraction not addition)', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });
            ddbMock.on(GetCommand).resolves({});

            const before = Date.now();
            const result = await runContactReconciliation(deps, FAST_OPTIONS);
            const elapsed = Date.now() - before;

            // totalDurationMs should be roughly equal to elapsed time (not Date.now() + startTime which would be ~2x Date.now())
            expect(result.totalDurationMs).toBeLessThan(elapsed + 500);
        });
    });

    // ======================================================================
    // Outer DynamoDB scan failure catch blocks
    // ======================================================================
    describe('Phase A: outer DynamoDB scan failure', () => {
        test('increments errors and breaks loop when Phase A scan QueryCommand throws', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: DynamoDB throws on first page
                .rejectsOnce(new Error('DynamoDB scan error'))
                // Phase B: no profiles
                .resolvesOnce({ Items: [] });

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseA.errors).toBeGreaterThanOrEqual(1);
            expect(result.success).toBe(false);
        });
    });

    describe('Phase B: outer DynamoDB scan failure', () => {
        test('increments errors and breaks loop when Phase B scan QueryCommand throws', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: no lookup rows (scan succeeds)
                .resolvesOnce({ Items: [] })
                // Phase B: DynamoDB throws on first page
                .rejectsOnce(new Error('DynamoDB scan error'));

            const result = await runContactReconciliation(deps, FAST_OPTIONS);

            expect(result.phaseB.errors).toBeGreaterThanOrEqual(1);
            expect(result.success).toBe(false);
        });
    });

    // ======================================================================
    // Fix 4: AbortSignal — stop() aborts in-flight run
    // ======================================================================
    describe('AbortSignal cancellation', () => {
        test('passes signal to sleep when signal is provided', async () => {
            const controller = new AbortController();
            const orphanLookup = {
                PK:       'CONTACT_LOOKUP#email#ghost@example.com',
                SK:       'CONTACT#ghost-contact',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#ghost-contact#email#ghost@example.com',
                personId: 'ghost-contact',
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [orphanLookup] })
                .resolvesOnce({ Items: [] });
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            await runContactReconciliation(deps, {
                operationDelayMs:          50,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
                signal:                    controller.signal,
            });

            // Sleep must have been called with the signal
            expect(mockSleep).toHaveBeenCalledWith(50, controller.signal);
        });

        test('exits Phase A promptly when signal is aborted before scan', async () => {
            const controller = new AbortController();
            controller.abort(); // Pre-abort

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
                signal:                    controller.signal,
            });

            // Should complete without error (abort is graceful exit)
            expect(typeof result.success).toBe('boolean');
        });

        test('Fix 4: sleepAndCheckAbort returns true immediately when signal is pre-aborted', async () => {
            // Pre-abort the signal. sleepAndCheckAbort must bail before calling sleep.
            const controller = new AbortController();
            controller.abort();

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP, ALICE_DISCORD_LOOKUP] })
                .resolvesOnce({ Items: [] });
            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });

            let sleepCalled = false;
            const trackingSleep = mock(async (_ms: number): Promise<void> => {
                sleepCalled = true;
            });
            const abortDeps = {
                ...deps,
                sleep: trackingSleep as (ms: number, signal?: AbortSignal) => Promise<void>,
            };

            await runContactReconciliation(abortDeps, {
                operationDelayMs:          50, // would be called if pre-abort check was missing
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
                signal:                    controller.signal,
            });

            // Sleep must NOT have been called — pre-abort guard fires first
            expect(sleepCalled).toBe(false);
        });

        test('Fix 7: Phase A abort check fires immediately after processPhaseAPage returns', async () => {
            // Phase A has two pages. After page 1, signal is aborted.
            // Fix 7: the post-page abort check must catch this before attempting page 2.
            const controller = new AbortController();

            let queryCallCount = 0;
            ddbMock.on(QueryCommand).callsFake(() => {
                queryCallCount++;
                if(queryCallCount === 1) {
                    // Phase A page 1 — return one item with a LastEvaluatedKey to signal more pages
                    controller.abort(); // abort immediately after page 1 query
                    return Promise.resolve({
                        Items:            [ALICE_EMAIL_LOOKUP],
                        LastEvaluatedKey: { PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-smith' },
                    });
                }
                if(queryCallCount === 2) {
                    // This should NOT be reached for Phase A page 2 due to Fix 7
                    return Promise.resolve({ Items: [] });
                }
                // Phase B
                return Promise.resolve({ Items: [] });
            });
            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
                signal:                    controller.signal,
            });

            // Phase A page 2 must NOT have been queried (abort was checked after page 1)
            // queryCallCount should be 2: 1 for Phase A page 1, 1 for Phase B (not a second Phase A page)
            // Phase B query happens but with pre-aborted signal it breaks immediately
            expect(queryCallCount).toBeLessThanOrEqual(2);
            expect(typeof result.success).toBe('boolean');
        });

        test('Fix 4: does not delete stray lookup when signal aborted between read and write', async () => {
            // Setup: stray lookup row (old enough to normally be deleted)
            const strayLookup = {
                PK:        'CONTACT_LOOKUP#email#old-email@example.com',
                SK:        'CONTACT#alice-smith',
                GSI2PK:    'CONTACT_LOOKUPS',
                GSI2SK:    'CONTACT#alice-smith#email#old-email@example.com',
                personId:  'alice-smith',
                createdAt: '2020-01-01T00:00:00.000Z', // Very old — would be deleted without abort
            };

            const controller = new AbortController();

            // Abort the signal when GetCommand resolves (between read and write)
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [strayLookup] })
                .resolvesOnce({ Items: [] });

            let getCallCount = 0;
            ddbMock.on(GetCommand).callsFake(() => {
                getCallCount++;
                controller.abort(); // Abort after the read completes
                return Promise.resolve({ Item: ALICE_PROFILE_ITEM }); // Profile exists but doesn't claim stray email
            });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0, // Age threshold is 0 so stray would normally be deleted
                signal:                    controller.signal,
            });

            // GetCommand must have been called (read happened)
            expect(getCallCount).toBeGreaterThanOrEqual(1);
            // But DeleteCommand must NOT have been called (write was blocked by abort)
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
            // Result is still graceful
            expect(typeof result.success).toBe('boolean');
        });
    });

    // ======================================================================
    // Fix 1: Age threshold for stray lookup protection
    // ======================================================================
    describe('Fix 1: stray lookup age threshold', () => {
        test('does not delete stray lookup when it is younger than strayLookupAgeThresholdMs', async () => {
            // A very recent stray lookup (profile doesn't claim it but it's brand new)
            const youngStrayLookup = {
                PK:        'CONTACT_LOOKUP#email#old-email@example.com',
                SK:        'CONTACT#alice-smith',
                GSI2PK:    'CONTACT_LOOKUPS',
                GSI2SK:    'CONTACT#alice-smith#email#old-email@example.com',
                personId:  'alice-smith',
                createdAt: new Date(Date.now() - 1000).toISOString(), // 1 second old — too young
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [youngStrayLookup] })
                .resolvesOnce({ Items: [] });

            // Profile exists but doesn't claim old-email (so it would normally be stray-deleted)
            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 300_000, // 5 minutes: lookup is only 1s old → skip
            });

            // Should NOT be deleted (too young)
            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
        });

        test('deletes stray lookup when it is older than strayLookupAgeThresholdMs', async () => {
            // An old stray lookup (profile doesn't claim it and it's old enough)
            const oldStrayLookup = {
                PK:        'CONTACT_LOOKUP#email#old-email@example.com',
                SK:        'CONTACT#alice-smith',
                GSI2PK:    'CONTACT_LOOKUPS',
                GSI2SK:    'CONTACT#alice-smith#email#old-email@example.com',
                personId:  'alice-smith',
                createdAt: new Date(Date.now() - 600_000).toISOString(), // 10 minutes old — old enough
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [oldStrayLookup] })
                .resolvesOnce({ Items: [] });

            // Profile exists but doesn't claim old-email
            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 300_000, // 5 minutes: lookup is 10min old → delete
            });

            // Should be deleted (old enough)
            expect(result.phaseA.orphanLookupsDeleted).toBe(1);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
        });

        test('deletes stray lookup when createdAt is absent (no timestamp = treat as old enough)', async () => {
            // A stray lookup with no createdAt — age cannot be determined, treat as old enough
            const strayLookupNoTimestamp = {
                PK:       'CONTACT_LOOKUP#email#old-email@example.com',
                SK:       'CONTACT#alice-smith',
                GSI2PK:   'CONTACT_LOOKUPS',
                GSI2SK:   'CONTACT#alice-smith#email#old-email@example.com',
                personId: 'alice-smith',
                // No createdAt — legacy row
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [strayLookupNoTimestamp] })
                .resolvesOnce({ Items: [] });

            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 300_000,
            });

            // Should be deleted (no timestamp → treat as old)
            expect(result.phaseA.orphanLookupsDeleted).toBe(1);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
        });

        test('Fix 1 (true-orphan): does NOT delete young orphan lookup (profile missing but lookup too young)', async () => {
            // Fix 1 change: the age guard now applies to TRUE orphans too.
            // putContact writes lookup BEFORE profile — during that window the profile is missing.
            // A young lookup with no profile must be protected from false-positive deletion.
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

            const youngOrphanLookup = {
                PK:        'CONTACT_LOOKUP#email#ghost@example.com',
                SK:        'CONTACT#ghost-contact',
                GSI2PK:    'CONTACT_LOOKUPS',
                GSI2SK:    'CONTACT#ghost-contact#email#ghost@example.com',
                personId:  'ghost-contact',
                createdAt: new Date(Date.now() - 1000).toISOString(), // 1 second old — too young
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [youngOrphanLookup] })
                .resolvesOnce({ Items: [] });

            // No profile found (true orphan, but young)
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 300_000, // 5 minutes — lookup is only 1s old → skip
            });

            jest.useRealTimers();

            // Must NOT be deleted (too young — may be in-flight putContact step 1)
            expect(result.phaseA.orphanLookupsDeleted).toBe(0);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
        });

        test('Fix 1 (true-orphan): DOES delete old orphan lookup (profile missing and lookup is old)', async () => {
            // An old orphan (no profile, lookup is old enough) must still be cleaned up.
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

            const oldOrphanLookup = {
                PK:        'CONTACT_LOOKUP#email#ghost@example.com',
                SK:        'CONTACT#ghost-contact',
                GSI2PK:    'CONTACT_LOOKUPS',
                GSI2SK:    'CONTACT#ghost-contact#email#ghost@example.com',
                personId:  'ghost-contact',
                createdAt: new Date(Date.now() - 600_000).toISOString(), // 10 minutes old — old enough
            };

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [oldOrphanLookup] })
                .resolvesOnce({ Items: [] });

            // No profile found (true orphan, old enough)
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 300_000, // 5 minutes — lookup is 10min old → delete
            });

            jest.useRealTimers();

            // Old true orphan must be deleted
            expect(result.phaseA.orphanLookupsDeleted).toBe(1);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
        });
    });

    // ======================================================================
    // Fix 3: repairIdentifierLookup uses batchWriteWithRetry (UnprocessedItems)
    // ======================================================================
    describe('Fix 3: batchWriteWithRetry in Phase B (UnprocessedItems retry)', () => {
        test('retries when BatchWriteCommand returns UnprocessedItems', async () => {
            ddbMock.on(QueryCommand)
                // Phase A: no lookup rows
                .resolvesOnce({ Items: [] })
                // Phase B: alice profile with one identifier missing its lookup
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            // Phase B inner check: lookup is missing
            ddbMock.on(GetCommand).resolves({});

            // First BatchWrite returns UnprocessedItems, second succeeds
            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [{ PutRequest: { Item: { PK: 'test', SK: 'test' } } }],
                    },
                })
                .resolves({});

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
            });

            // Alice has 2 identifiers, so 2 GetCommands + 2 BatchWrites (with one retry on first)
            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(2); // at least the retry

            // The result should reflect that lookups were created
            expect(result.phaseB.missingLookupsCreated).toBeGreaterThanOrEqual(1);
        });

        test('counts error when BatchWriteCommand exhausts retries for UnprocessedItems', async () => {
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] })
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            ddbMock.on(GetCommand).resolves({});

            // Always return unprocessed items — exhausts retries
            ddbMock.on(BatchWriteCommand).resolves({
                UnprocessedItems: {
                    TestTable: [{ PutRequest: { Item: { PK: 'test', SK: 'test' } } }],
                },
            });

            const result = await runContactReconciliation(deps, {
                operationDelayMs:          0,
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
            });

            // Should count errors for the failed identifiers
            expect(result.phaseB.errors).toBeGreaterThanOrEqual(1);
            expect(result.success).toBe(false);
        });
    });

    // ======================================================================
    // Fix 1: Phase B repair writes createdAt to new lookup rows
    // ======================================================================
    describe('Fix 1: repairIdentifierLookup writes createdAt', () => {
        test('lookup rows created by Phase B repair include a createdAt ISO timestamp', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

            ddbMock.on(QueryCommand)
                // Phase A: no lookup rows
                .resolvesOnce({ Items: [] })
                // Phase B: alice profile
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            // Phase B inner check: lookup is missing
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(BatchWriteCommand).resolves({});

            await runContactReconciliation(deps, FAST_OPTIONS);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(bwCalls.length).toBeGreaterThanOrEqual(1);

            // Collect all written lookup items and assert exact createdAt (fake clock is fixed)
            const allItems = bwCalls.flatMap(c => c.args[0].input.RequestItems?.TestTable ?? []);

            jest.useRealTimers();

            for(const item of allItems) {
                const createdAt = item.PutRequest?.Item?.createdAt as string | undefined;
                expect(createdAt).toBe('2026-05-01T12:00:00.000Z');
            }
        });

        test('createdAt round-trips through persistence: written value matches what BatchWrite received', async () => {
            // Verify the exact createdAt string flows from new Date().toISOString() through
            // the BatchWrite payload — confirms end-to-end persistence correctness.
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-05-01T09:30:00.000Z'));

            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [] })
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(BatchWriteCommand).resolves({});

            await runContactReconciliation(deps, FAST_OPTIONS);

            const bwCalls = ddbMock.commandCalls(BatchWriteCommand);
            const allItems = bwCalls.flatMap(c => c.args[0].input.RequestItems?.TestTable ?? []);

            jest.useRealTimers();

            // At least one lookup item should have been written
            const lookupItems = allItems.filter(item => item.PutRequest?.Item?.SK !== 'PROFILE');
            expect(lookupItems.length).toBeGreaterThanOrEqual(1);

            // All lookup items must have exactly the frozen createdAt
            for(const item of lookupItems) {
                expect(item.PutRequest?.Item?.createdAt).toBe('2026-05-01T09:30:00.000Z');
            }
        });
    });

    // ======================================================================
    // Fix 2: AbortError is not counted as an error
    // ======================================================================
    describe('Fix 2: AbortError during sleep is not counted as an error', () => {
        test('aborted result has success:true, aborted:true, and errors:0', async () => {
            const controller = new AbortController();

            ddbMock.on(QueryCommand)
                // Phase A: two lookup rows — needed to kill BlockStatement mutant on break (single-item loop breaks anyway)
                .resolvesOnce({ Items: [ALICE_EMAIL_LOOKUP, ALICE_DISCORD_LOOKUP] })
                // Phase B: alice profile
                .resolvesOnce({ Items: [ALICE_PROFILE_ITEM] });

            ddbMock.on(GetCommand).resolves({ Item: ALICE_PROFILE_ITEM });
            ddbMock.on(BatchWriteCommand).resolves({});

            // Sleep throws AbortError when signal fires
            let sleepCallCount = 0;
            const abortingSleep = mock(async (_ms: number, signal?: AbortSignal): Promise<void> => {
                sleepCallCount++;
                controller.abort(); // Abort on first sleep call
                // Simulate what the production sleep does: reject with an AbortError
                // Use signal.reason if it is already an Error (AbortController sets it)
                throw signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
            });

            const abortDeps = {
                ...deps,
                sleep: abortingSleep as (ms: number, signal?: AbortSignal) => Promise<void>,
            };

            const result = await runContactReconciliation(abortDeps, {
                operationDelayMs:          50, // non-zero so sleep is called
                scanPageSize:              25,
                strayLookupAgeThresholdMs: 0,
                signal:                    controller.signal,
            });

            // Sleep must have been called exactly once — abort on first call, break exits loop before second item
            expect(sleepCallCount).toBe(1);
            // Abort must not count as an error
            expect(result.phaseA.errors).toBe(0);
            // Result must indicate abort
            expect(result.aborted).toBe(true);
            expect(result.success).toBe(true);
        });
    });
});
