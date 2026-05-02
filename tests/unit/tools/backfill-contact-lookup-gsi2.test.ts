import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import * as retryMod from '../../../src/utils/retry/retry-async';
import { type ContactProfileItem, type BackfillStats, type QueryPageFn, type ProcessContactsFn, runBackfillLoop, parseArgs, processContacts } from '../../../tools/backfill-contact-lookup-gsi2-core';

// backfill-contact-lookup-gsi2-core.ts has no top-level side-effects — safe to import in tests.
// The CLI entrypoint (backfill-contact-lookup-gsi2.ts) has `await main()` at module level and
// is NOT imported here.

// ============================================================
// runBackfillLoop tests
// ============================================================
describe('runBackfillLoop', () => {
    let fakeSleep: ReturnType<typeof mock<(ms: number) => Promise<void>>>;

    beforeEach(() => {
        fakeSleep = mock(async (_ms: number) => {});
    });

    afterEach(() => {
        fakeSleep.mockRestore();
    });

    function makeContact(personId: string, platforms: { platform: string, value: string }[]): ContactProfileItem {
        return {
            PK:          `CONTACT#${personId}`,
            SK:          'PROFILE',
            personId,
            identifiers: platforms.map(p => ({ platform: p.platform as 'email' | 'discord' | 'bsky' | 'name' | 'nickname', value: p.value })),
        };
    }

    function makeQueryPage(pages: { items: ContactProfileItem[], lastEvaluatedKey?: Record<string, unknown> }[]): QueryPageFn {
        let callIndex = 0;
        return async (_cursor: Record<string, unknown> | undefined) => {
            const idx = callIndex++;
            if(idx >= pages.length) {
                throw new Error(`Unexpected queryPage call at index ${idx} (only ${pages.length} pages defined)`);
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; bounds check is above
            const page = pages[idx]!;
            return {
                items:            page.items,
                lastEvaluatedKey: page.lastEvaluatedKey,
            };
        };
    }

    function makeFailingQueryPage(failCount: number, thenSucceed?: { items: ContactProfileItem[], lastEvaluatedKey?: Record<string, unknown> }): QueryPageFn {
        let callIndex = 0;
        return async (_cursor: Record<string, unknown> | undefined) => {
            callIndex++;
            if(callIndex <= failCount) {
                throw new Error(`Query failure ${callIndex}`);
            }
            return {
                items:            thenSucceed?.items ?? [],
                lastEvaluatedKey: thenSucceed?.lastEvaluatedKey,
            };
        };
    }

    function makeProcessContacts(stats?: { updated?: number, skipped?: number, errors?: number }): ProcessContactsFn {
        return mock(async _items => ({
            updated: stats?.updated ?? 0,
            skipped: stats?.skipped ?? 0,
            errors:  stats?.errors ?? 0,
        }));
    }

    test('single page with no continuation key — completes in one iteration', async () => {
        const item = makeContact('alice-id', [{ platform: 'email', value: 'alice@example.com' }]);
        const queryPage = makeQueryPage([{ items: [item], lastEvaluatedKey: undefined }]);
        const processOnePage = makeProcessContacts({ updated: 1 });
        const summaries: BackfillStats[] = [];
        let capturedLastCursor: Record<string, unknown> | undefined = { sentinel: true };
        const onSummary = (s: BackfillStats, lastCursor: Record<string, unknown> | undefined) => {
            summaries.push({ ...s });
            capturedLastCursor = lastCursor;
        };

        const result = await runBackfillLoop(queryPage, processOnePage, onSummary, fakeSleep, 5, 1000);

        expect(result.totalScanned).toBe(1);
        expect(result.totalUpdated).toBe(1);
        expect(result.totalErrors).toBe(0);
        expect(summaries).toHaveLength(1);
        expect(fakeSleep).not.toHaveBeenCalled();
        // On normal completion the cursor is undefined (loop exited after last page)
        expect(capturedLastCursor).toBeUndefined();
    });

    test('two pages — cursor advances after first page, loop exits after second', async () => {
        const item1 = makeContact('alice-id', [{ platform: 'email', value: 'a@a.com' }]);
        const item2 = makeContact('bob-id', [{ platform: 'email', value: 'b@b.com' }]);
        const queryPage = makeQueryPage([
            { items: [item1], lastEvaluatedKey: { PK: 'cursor1' } },
            { items: [item2], lastEvaluatedKey: undefined },
        ]);
        const processOnePage = makeProcessContacts({ updated: 1 });
        const summaries: BackfillStats[] = [];

        const result = await runBackfillLoop(queryPage, processOnePage, (s) => {
            summaries.push({ ...s });
        }, fakeSleep, 5, 1000);

        expect(result.totalScanned).toBe(2);
        expect(result.totalUpdated).toBe(2);
        expect(summaries).toHaveLength(1);
    });

    test('first-page failure → retried (same cursor) → eventually succeeds', async () => {
        // 2 failures then success
        const item = makeContact('charlie-id', [{ platform: 'email', value: 'c@c.com' }]);
        const queryPage = makeFailingQueryPage(2, { items: [item], lastEvaluatedKey: undefined });
        const processOnePage = makeProcessContacts({ updated: 1 });
        const summaries: BackfillStats[] = [];

        const result = await runBackfillLoop(queryPage, processOnePage, s => summaries.push(s), fakeSleep, 5, 100);

        expect(result.totalScanned).toBe(1);
        // 2 failure errors accumulated (one per failed attempt)
        expect(result.totalErrors).toBe(2);
        // Sleep called for each failure: 2 times
        expect(fakeSleep).toHaveBeenCalledTimes(2);
        expect(summaries).toHaveLength(1);
    });

    test('3 consecutive first-page failures then success — circuit-breaker not triggered', async () => {
        const item = makeContact('dave-id', [{ platform: 'email', value: 'd@d.com' }]);
        const queryPage = makeFailingQueryPage(3, { items: [item], lastEvaluatedKey: undefined });
        const processOnePage = makeProcessContacts();
        const summaries: BackfillStats[] = [];

        // MAX = 5, so 3 failures should not trigger circuit-breaker
        const result = await runBackfillLoop(queryPage, processOnePage, s => summaries.push(s), fakeSleep, 5, 100);

        expect(result.totalErrors).toBe(3);
        expect(fakeSleep).toHaveBeenCalledTimes(3);
        expect(summaries).toHaveLength(1);
    });

    test('5 consecutive first-page failures → circuit-breaker fires and summary prints before error', async () => {
        const queryPage = makeFailingQueryPage(5);
        const processOnePage = makeProcessContacts();
        const summaries: BackfillStats[] = [];
        const summaryOrder: string[] = [];
        let capturedLastCursor: Record<string, unknown> | undefined = { sentinel: true };

        const onSummary = (s: BackfillStats, lastCursor: Record<string, unknown> | undefined) => {
            summaryOrder.push('summary');
            summaries.push({ ...s });
            capturedLastCursor = lastCursor;
        };

        let errorCaught = false;
        await runBackfillLoop(queryPage, processOnePage, onSummary, fakeSleep, 5, 100)
            .catch(() => {
                summaryOrder.push('error');
                errorCaught = true;
            });

        expect(errorCaught).toBe(true);
        // Summary fires BEFORE the error propagates (try/finally guarantee)
        expect(summaryOrder[0]).toBe('summary');
        expect(summaryOrder[1]).toBe('error');
        // 5 failures accumulated
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; summaries is always populated before this line
        const firstSummary = summaries[0]!;
        expect(firstSummary.totalErrors).toBe(5);
        // Sleep called 4 times — 5th failure triggers circuit-breaker throw before sleep
        expect(fakeSleep).toHaveBeenCalledTimes(4);
        // lastCursor is undefined because all failures hit the first page (exclusiveStartKey never advanced)
        expect(capturedLastCursor).toBeUndefined();
    });

    test('backoff doubles on each consecutive failure', async () => {
        // 3 failures then success
        const queryPage = makeFailingQueryPage(3, { items: [], lastEvaluatedKey: undefined });
        const processOnePage = makeProcessContacts();
        const sleepCalls: number[] = [];
        const trackingSleep = mock(async (ms: number) => {
            sleepCalls.push(ms);
        });

        await runBackfillLoop(queryPage, processOnePage, () => {}, trackingSleep, 5, 1000);

        // Failure 1: 1000 * 2^0 = 1000ms
        // Failure 2: 1000 * 2^1 = 2000ms
        // Failure 3: 1000 * 2^2 = 4000ms
        expect(sleepCalls).toEqual([1000, 2000, 4000]);
    });

    test('empty query result — no items processed, loop exits cleanly', async () => {
        const queryPage = makeQueryPage([{ items: [], lastEvaluatedKey: undefined }]);
        const processOnePage = makeProcessContacts();
        const summaries: BackfillStats[] = [];

        const result = await runBackfillLoop(queryPage, processOnePage, s => summaries.push(s), fakeSleep, 5, 1000);

        expect(result.totalScanned).toBe(0);
        expect(result.totalUpdated).toBe(0);
        expect(summaries).toHaveLength(1);
    });

    test('summary callback receives accumulated stats on normal completion', async () => {
        const items = [
            makeContact('alice-id', [{ platform: 'email', value: 'a@a.com' }]),
            makeContact('bob-id', [{ platform: 'discord', value: 'user-123' }]),
        ];
        const queryPage = makeQueryPage([{ items, lastEvaluatedKey: undefined }]);
        const processOnePage: ProcessContactsFn = mock(async _items => ({ updated: 1, skipped: 1, errors: 0 }));
        let capturedStats: BackfillStats | undefined;

        await runBackfillLoop(queryPage, processOnePage, (s) => {
            capturedStats = { ...s };
        }, fakeSleep, 5, 1000);

        expect(capturedStats).toBeDefined();
        expect(capturedStats?.totalScanned).toBe(2);
        expect(capturedStats?.totalUpdated).toBe(1);
        expect(capturedStats?.totalSkipped).toBe(1);
    });

    test('page failure increments totalErrors but not totalScanned or totalUpdated', async () => {
        // First page fails, then succeeds with 1 item
        const item = makeContact('eve-id', [{ platform: 'email', value: 'e@e.com' }]);
        const queryPage = makeFailingQueryPage(1, { items: [item], lastEvaluatedKey: undefined });
        const processOnePage = makeProcessContacts({ updated: 1 });

        const result = await runBackfillLoop(queryPage, processOnePage, () => {}, fakeSleep, 5, 100);

        expect(result.totalErrors).toBe(1); // from the failed query
        expect(result.totalScanned).toBe(1); // from the successful retry
        expect(result.totalUpdated).toBe(1);
    });

    test('cursor is preserved across failure — retry sees same start key', async () => {
        // Page 1 succeeds with a cursor, page 2 fails once then succeeds
        const item1 = makeContact('frank-id', [{ platform: 'email', value: 'f@f.com' }]);
        const item2 = makeContact('grace-id', [{ platform: 'email', value: 'g@g.com' }]);
        const cursorAfterPage1 = { PK: 'cursor-after-page1' };
        const cursorsSeenOnCall2: (Record<string, unknown> | undefined)[] = [];

        let callIndex = 0;
        const queryPage: QueryPageFn = async (cursor: Record<string, unknown> | undefined) => {
            callIndex++;
            if(callIndex === 1) {
                // First page: succeed with a cursor
                return { items: [item1], lastEvaluatedKey: cursorAfterPage1 };
            }
            // All subsequent calls are "page 2" (retry after failure)
            cursorsSeenOnCall2.push(cursor);
            if(callIndex === 2) {
                throw new Error('Page 2 failure');
            }
            // On the 3rd call (retry of page 2), succeed
            return { items: [item2], lastEvaluatedKey: undefined };
        };

        await runBackfillLoop(queryPage, makeProcessContacts(), () => {}, fakeSleep, 5, 100);

        // Both calls to page 2 (failure and retry) must use the SAME cursor
        expect(cursorsSeenOnCall2).toHaveLength(2);
        expect(cursorsSeenOnCall2[0]).toEqual(cursorAfterPage1);
        expect(cursorsSeenOnCall2[1]).toEqual(cursorAfterPage1);
    });

    test('processContacts errors are accumulated in totalErrors', async () => {
        // processOnePage returns errors > 0 — must be reflected in totalErrors
        const item = makeContact('henry-id', [{ platform: 'email', value: 'h@h.com' }]);
        const queryPage = makeQueryPage([{ items: [item], lastEvaluatedKey: undefined }]);
        const processOnePage = makeProcessContacts({ updated: 0, skipped: 0, errors: 2 });

        const result = await runBackfillLoop(queryPage, processOnePage, () => {}, fakeSleep, 5, 100);

        expect(result.totalErrors).toBe(2);
        expect(result.totalUpdated).toBe(0);
    });
});

// ============================================================
// parseArgs tests
// ============================================================
describe('parseArgs', () => {
    test('no flags — defaults to dryRun=false showHelp=false', () => {
        const opts = parseArgs(['node', 'script.ts']);
        expect(opts.dryRun).toBe(false);
        expect(opts.showHelp).toBe(false);
    });

    test('--dry-run flag sets dryRun=true', () => {
        const opts = parseArgs(['node', 'script.ts', '--dry-run']);
        expect(opts.dryRun).toBe(true);
        expect(opts.showHelp).toBe(false);
    });

    test('--help flag sets showHelp=true', () => {
        const opts = parseArgs(['node', 'script.ts', '--help']);
        expect(opts.dryRun).toBe(false);
        expect(opts.showHelp).toBe(true);
    });

    test('-h flag sets showHelp=true', () => {
        const opts = parseArgs(['node', 'script.ts', '-h']);
        expect(opts.showHelp).toBe(true);
    });

    test('argv.slice(2) — leading two args are stripped (process argv[0] and argv[1])', () => {
        // The first two args are the runtime and script path; parseArgs must ignore them.
        // Passing --help as argv[1] (not argv[2]) should NOT trigger showHelp.
        const opts = parseArgs(['--help', 'script.ts']);
        expect(opts.showHelp).toBe(false);
    });

    test('unknown flag throws an error', () => {
        expect(() => parseArgs(['node', 'script.ts', '--unknown'])).toThrow('Unknown option: --unknown');
    });

    test('positional arg (no leading dashes) is silently ignored — does not throw', () => {
        // Tests the else-if(arg?.startsWith('--')) guard: single-dash or bare words must not throw
        const opts = parseArgs(['node', 'script.ts', 'positional-arg']);
        expect(opts.dryRun).toBe(false);
        expect(opts.showHelp).toBe(false);
    });

    test('single-dash flag is silently ignored — does not throw', () => {
        // Tests the else-if(arg?.startsWith('--')) guard: '-x' does not start with '--'
        const opts = parseArgs(['node', 'script.ts', '-x']);
        expect(opts.dryRun).toBe(false);
        expect(opts.showHelp).toBe(false);
    });
});

// ============================================================
// processContacts tests
// ============================================================
describe('processContacts', () => {
    const TABLE_NAME = 'TestTable';

    // Stub docClient: only `send` is used by processContacts.
    // Captures sent commands so tests can inspect UpdateCommand parameters.
    let sentCommands: unknown[];
    let sendMock: ReturnType<typeof mock<(cmd: unknown) => Promise<void>>>;
    let docClient: DynamoDBDocumentClient;

    // Spy on retryAsync to avoid real exponential-backoff delays.
    // The spy makes retryAsync call the operation exactly once (no retries, no sleep).
    let retryAsyncSpy: ReturnType<typeof spyOn<typeof retryMod, 'retryAsync'>>;

    // Spy on process.stdout.write to capture dry-run output without polluting test output.
    let stdoutSpy: ReturnType<typeof spyOn<NodeJS.WriteStream, 'write'>>;

    beforeEach(() => {
        sentCommands = [];
        sendMock = mock(async (cmd: unknown) => {
            sentCommands.push(cmd);
        });
        docClient = { send: sendMock } as unknown as DynamoDBDocumentClient;

        // Pass-through: call the operation once without retry logic.
        retryAsyncSpy = spyOn(retryMod, 'retryAsync').mockImplementation(async op => op());

        stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        retryAsyncSpy.mockRestore();
        stdoutSpy.mockRestore();
    });

    function makeContact(personId: string, identifiers: { platform: string, value: string }[], extra?: Partial<ContactProfileItem>): ContactProfileItem {
        return {
            PK:          `CONTACT#${personId}`,
            SK:          'PROFILE',
            personId,
            identifiers: identifiers.map(i => ({ platform: i.platform as 'email' | 'discord' | 'bsky' | 'name' | 'nickname', value: i.value })),
            ...extra,
        };
    }

    test('contact with one email identifier → UpdateCommand sent with correct GSI2 keys, updated=1', async () => {
        const item = makeContact('alice-id', [{ platform: 'email', value: 'alice@example.com' }]);

        const result = await processContacts([item], TABLE_NAME, docClient, false);

        expect(result.updated).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.errors).toBe(0);
        expect(sendMock).toHaveBeenCalledTimes(1);

        // Verify the UpdateCommand was constructed with correct parameters
        const sentCommand = sentCommands[0] as { input: Record<string, unknown> };
        expect(sentCommand.input).toMatchObject({
            TableName: TABLE_NAME,
            Key:       { PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-id' },
        });
        // UpdateExpression must set GSI2PK, GSI2SK, and createdAt with if_not_exists
        expect(sentCommand.input.UpdateExpression).toContain('GSI2PK');
        expect(sentCommand.input.UpdateExpression).toContain('GSI2SK');
        expect(sentCommand.input.UpdateExpression).toContain('if_not_exists');
        // ConditionExpression must guard that the row exists AND does not already have GSI2PK
        expect(sentCommand.input.ConditionExpression).toBe('attribute_exists(PK) AND attribute_not_exists(GSI2PK)');
        // ExpressionAttributeValues must include the correct GSI2 keys
        const exprValues = sentCommand.input.ExpressionAttributeValues as Record<string, unknown>;
        expect(exprValues[':gsi2pk']).toBe('CONTACT_LOOKUPS');
        // GSI2SK format: CONTACT#{personId}#{platform}#{normalizedValue}
        expect(exprValues[':gsi2sk']).toBe('CONTACT#alice-id#email#alice@example.com');
        // createdAt must be a non-empty ISO-8601 string
        const createdAt = exprValues[':createdAt'];
        expect(typeof createdAt).toBe('string');
        expect(createdAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('contact with two identifiers → two UpdateCommands sent, updated=2', async () => {
        const item = makeContact('bob-id', [
            { platform: 'email', value: 'bob@example.com' },
            { platform: 'discord', value: 'user-456' },
        ]);

        const result = await processContacts([item], TABLE_NAME, docClient, false);

        expect(result.updated).toBe(2);
        expect(result.errors).toBe(0);
        expect(sendMock).toHaveBeenCalledTimes(2);

        // First identifier: email
        const cmd1 = sentCommands[0] as { input: Record<string, unknown> };
        expect(cmd1.input.Key).toEqual({ PK: 'CONTACT_LOOKUP#email#bob@example.com', SK: 'CONTACT#bob-id' });
        const vals1 = cmd1.input.ExpressionAttributeValues as Record<string, unknown>;
        expect(vals1[':gsi2sk']).toBe('CONTACT#bob-id#email#bob@example.com');

        // Second identifier: discord
        const cmd2 = sentCommands[1] as { input: Record<string, unknown> };
        expect(cmd2.input.Key).toEqual({ PK: 'CONTACT_LOOKUP#discord#user-456', SK: 'CONTACT#bob-id' });
        const vals2 = cmd2.input.ExpressionAttributeValues as Record<string, unknown>;
        expect(vals2[':gsi2sk']).toBe('CONTACT#bob-id#discord#user-456');
    });

    test('identifier value is normalized to lowercase — uppercase input is lowercased in keys', async () => {
        // createLookupKeys normalizes to lowercase+trim; Alice@Example.Com → alice@example.com
        const item = makeContact('carol-id', [{ platform: 'email', value: 'Carol@Example.Com' }]);

        await processContacts([item], TABLE_NAME, docClient, false);

        const sentCommand = sentCommands[0] as { input: Record<string, unknown> };
        expect(sentCommand.input.Key).toEqual({ PK: 'CONTACT_LOOKUP#email#carol@example.com', SK: 'CONTACT#carol-id' });
        const vals = sentCommand.input.ExpressionAttributeValues as Record<string, unknown>;
        expect(vals[':gsi2sk']).toBe('CONTACT#carol-id#email#carol@example.com');
    });

    test('contact with zero identifiers → nothing sent, all counts 0', async () => {
        // identifiers array with 0 items: for-loop body never executes
        // Note: this bypasses Zod schema validation since contactSchema.pick requires min(1),
        // but we test the runtime behavior for safety.
        const item: ContactProfileItem = {
            PK:          'CONTACT#empty-id',
            SK:          'PROFILE',
            personId:    'empty-id',
            identifiers: [],
        };

        // contactSchema.pick({ personId, identifiers }) will fail because identifiers min(1)
        // So this item should produce an error (parse failure), not a no-op
        const result = await processContacts([item], TABLE_NAME, docClient, false);

        expect(result.errors).toBe(1);
        expect(result.updated).toBe(0);
        expect(sendMock).not.toHaveBeenCalled();
    });

    test('ConditionalCheckFailedException (err.name check) → skipped++, no error', async () => {
        // When the lookup row already has GSI2PK (condition: attribute_not_exists(GSI2PK) fails),
        // DynamoDB throws an error with name='ConditionalCheckFailedException' — treat as already backfilled.
        const ccfError = new Error('The conditional request failed');
        ccfError.name = 'ConditionalCheckFailedException';
        sendMock.mockImplementation(async (_cmd: unknown) => {
            throw ccfError;
        });

        const item = makeContact('dave-id', [{ platform: 'email', value: 'dave@example.com' }]);

        const result = await processContacts([item], TABLE_NAME, docClient, false);

        expect(result.skipped).toBe(1);
        expect(result.updated).toBe(0);
        expect(result.errors).toBe(0);
    });

    test('ConditionalCheckFailedException on second identifier of same contact → skipped=1 updated=1', async () => {
        // First identifier succeeds, second triggers the condition failure
        let callCount = 0;
        sendMock.mockImplementation(async (_cmd: unknown) => {
            callCount++;
            if(callCount === 2) {
                const ccfError = new Error('The conditional request failed');
                ccfError.name = 'ConditionalCheckFailedException';
                throw ccfError;
            }
        });

        const item = makeContact('eve-id', [
            { platform: 'email', value: 'eve@example.com' },
            { platform: 'discord', value: 'user-789' },
        ]);

        const result = await processContacts([item], TABLE_NAME, docClient, false);

        expect(result.skipped).toBe(1);
        expect(result.updated).toBe(1);
        expect(result.errors).toBe(0);
    });

    test('non-conditional DynamoDB error → errors++, updated remains 0', async () => {
        sendMock.mockImplementation(async (_cmd: unknown) => {
            throw new Error('DynamoDB update failed: ProvisionedThroughputExceededException');
        });
        const item = makeContact('frank-id', [{ platform: 'email', value: 'frank@example.com' }]);

        const result = await processContacts([item], TABLE_NAME, docClient, false);

        expect(result.errors).toBe(1);
        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(0);
    });

    test('dry-run path → updated++, stdout write called, no DynamoDB call', async () => {
        const item = makeContact('grace-id', [{ platform: 'email', value: 'grace@example.com' }]);

        const result = await processContacts([item], TABLE_NAME, docClient, true);

        expect(result.updated).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.errors).toBe(0);
        expect(sendMock).not.toHaveBeenCalled();
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; stdoutSpy is always called once before this assertion
        const written = stdoutSpy.mock.calls[0]![0] as string;
        expect(written).toContain('[dry-run]');
        expect(written).toContain('CONTACT_LOOKUP#email#grace@example.com');
        expect(written).toContain('CONTACT_LOOKUPS');
        // GSI2SK format: CONTACT#{personId}#{platform}#{normalizedValue}
        expect(written).toContain('CONTACT#grace-id#email#grace@example.com');
    });

    test('dry-run with two identifiers → updated=2, stdout called twice, no DynamoDB calls', async () => {
        const item = makeContact('henry-id', [
            { platform: 'email', value: 'henry@example.com' },
            { platform: 'discord', value: 'henry-discord' },
        ]);

        const result = await processContacts([item], TABLE_NAME, docClient, true);

        expect(result.updated).toBe(2);
        expect(result.errors).toBe(0);
        expect(sendMock).not.toHaveBeenCalled();
        expect(stdoutSpy).toHaveBeenCalledTimes(2);
    });

    test('two contacts each with one identifier → two sends, updated=2', async () => {
        const items: ContactProfileItem[] = [
            makeContact('alice-id', [{ platform: 'email', value: 'alice@example.com' }]),
            makeContact('bob-id', [{ platform: 'bsky', value: 'did:plc:abcdef' }]),
        ];

        const result = await processContacts(items, TABLE_NAME, docClient, false);

        expect(result.updated).toBe(2);
        expect(result.errors).toBe(0);
        expect(sendMock).toHaveBeenCalledTimes(2);

        // Verify second contact's GSI2SK
        const cmd2 = sentCommands[1] as { input: Record<string, unknown> };
        const vals2 = cmd2.input.ExpressionAttributeValues as Record<string, unknown>;
        expect(vals2[':gsi2sk']).toBe('CONTACT#bob-id#bsky#did:plc:abcdef');
    });

    test('contact with invalid personId (not kebab-case) → parse error → errors++, no send', async () => {
        // Inject an item with a personId that won't pass contactIdSchema validation
        const item: ContactProfileItem = {
            PK:          'CONTACT#INVALID_ID',
            SK:          'PROFILE',
            personId:    'INVALID_ID', // uppercase fails contactIdSchema
            identifiers: [{ platform: 'email', value: 'bad@example.com' }],
        };

        const result = await processContacts([item], TABLE_NAME, docClient, false);

        expect(result.errors).toBe(1);
        expect(result.updated).toBe(0);
        expect(sendMock).not.toHaveBeenCalled();
    });

    test('empty items array → all counts are 0, send not called', async () => {
        const result = await processContacts([], TABLE_NAME, docClient, false);

        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.errors).toBe(0);
        expect(sendMock).not.toHaveBeenCalled();
    });

    test('mix: one valid, one already-backfilled (conditional fail), one parse-error → skipped=1 errors=1 updated=1', async () => {
        let callCount = 0;
        sendMock.mockImplementation(async (_cmd: unknown) => {
            callCount++;
            if(callCount === 2) {
                // Second send → ConditionalCheckFailedException
                const ccfError = new Error('ConditionalCheckFailedException');
                ccfError.name = 'ConditionalCheckFailedException';
                throw ccfError;
            }
        });

        const items: ContactProfileItem[] = [
            makeContact('alice-id', [{ platform: 'email', value: 'alice@example.com' }]),    // valid → updated
            makeContact('bob-id', [{ platform: 'discord', value: 'bob-discord' }]),            // conditional fail → skipped
            {
                PK:          'CONTACT#INVALID',
                SK:          'PROFILE',
                personId:    'INVALID',  // fails parse
                identifiers: [{ platform: 'email', value: 'x@x.com' }],
            },
        ];

        const result = await processContacts(items, TABLE_NAME, docClient, false);

        expect(result.updated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.errors).toBe(1);
        expect(sendMock).toHaveBeenCalledTimes(2);
    });
});
