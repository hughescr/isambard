/**
 * Integration tests for the vector-search feature wiring chain.
 *
 * These 6 tests verify the end-to-end glue between:
 *   config → loadEmbedder → createStorageLayer → MCP semantic_search tool → shutdown order
 *
 * Each test is independent so a regression in one glue point fails exactly that test.
 * All heavy deps (node-llama-cpp, SQLite files, DynamoDB, Discord) are stubbed so
 * total runtime is well under 100 ms.
 *
 * Note: tests/setup.ts (Bun preload) mocks AWS SDK, node-llama-cpp, SST Resource,
 * and @anthropic-ai/claude-agent-sdk globally — those mocks are in effect here.
 */
import '../setup'; // ensures SST mock + node-llama-cpp mock are in effect
import { beforeEach, afterEach, describe, expect, it, mock, spyOn, jest } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    BatchWriteCommand,
    DeleteCommand,
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import * as memoryMcpServerModule from '@/agent/memory-mcp-server';
import * as storageLayerModule from '@/app/storage-layer';
import type { SessionConfig } from '@/config';
import * as configLoaderModule from '@/config/loader';
import * as indexModule from '@/index';
import * as discordBotModule from '@/integrations/discord/bot';
import * as crBackendModule from '@/integrations/discord/channel-registry/backend';
import * as crManagerModule from '@/integrations/discord/channel-registry/manager';
import * as registerCommandsModule from '@/integrations/discord/register-commands';
import * as storageModule from '@/storage';
import * as dynamoClientModule from '@/storage/client';
import { DynamoDBClientHolder } from '@/storage/client-holder';
import * as memoryToolModule from '@/storage/memory-tool';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { createIndexLayer, type MemoryPath } from '@/storage/memory-tool/types';
import * as vecStoreModule from '@/storage/memory-vec-store';
import type { IndexerJob } from '@/storage/memory-vec-store/types';
import * as sessionResumeModule from '@/storage/session-resume';

const sessionConfig: SessionConfig = {
    compactThresholdPercent: 60,
    humanWaitTargetMs:       10_000,
    humanWaitCeilingMs:      30_000,
    bootEventsWindowMs:      24 * 60 * 60 * 1000,
    shutdownTurnWaitMs:      60_000,
    shutdownDeadlineMs:      120_000,
    reopenTaskWaitMs:        120_000,
    debounceMs:              250,
    timezone:                'UTC',
};

// ─── 1. Config wiring ───────────────────────────────────────────────────────
/**
 * The #41 session-host members of a mocked DiscordBot. `ready` never resolves, so app.start()'s
 * `startSessions` never opens a conductor (no real SDK/CLI during tests).
 */
function pendingSessionHost() {
    const ready = new Promise<void>(() => {
        // Deliberately never resolves: the bot never signals readiness in these tests.
    });
    return {
        ready,
        attachSessions:  mock(async () => undefined),
        stopIngress:     mock(() => undefined),
        recoveryAdapter: { recover: mock(async () => undefined) },
    };
}

describe('Vector feature wiring', () => {
    describe('1. Config: loadConfig returns vectorIndex.enabled', () => {
        it('loadConfig() returns vectorIndex.enabled = true by default', () => {
            // Reset the env var so the default (true) is used
            const prev = process.env.VECTOR_INDEX_ENABLED;
            delete process.env.VECTOR_INDEX_ENABLED;

            // Use a minimal resource stub that satisfies the schema
            const resources = {
                NodeEnv:               { value: 'test' },
                LogLevel:              { value: 'info' },
                Port:                  { value: '3000' },
                ClaudeCodeOAuthToken:  { value: 'tok' },
                IsambardMainModel:     { value: 'sonnet' },
                IsambardFallbackModel: { value: 'sonnet' },
                DiscordBotToken:       { value: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB' },
                DiscordApplicationId:  { value: '123456789012345678' },
                DiscordHomeGuildId:    { value: '111222333444555666' },
                AdminDiscordUserId:    { value: '123456789' },
                EmailUser:             { value: undefined },
                EmailPassword:         { value: undefined },
                // Required top-level admin review channel, independent of email (EmailUser stays unset)
                AdminDiscordChannelId: { value: '987654321098765432' },
                WildDuckApiUrl:        { value: undefined },
                BskyHandle:            { value: undefined },
                BskyAppPassword:       { value: undefined },
                TypesafeApiKey:        { value: undefined },
            };

            const cfg = configLoaderModule.loadConfig(resources);

            expect(cfg.vectorIndex).toBeDefined();
            expect(cfg.vectorIndex!.enabled).toBe(true);

            // Restore env
            if(prev !== undefined) {
                process.env.VECTOR_INDEX_ENABLED = prev;
            }
        });
    });

    // ─── 2. Embedder load wiring ────────────────────────────────────────────
    describe('2. Embedder: loadEmbedder called during createApp() with config params', () => {
        const spies: ReturnType<typeof spyOn>[] = [];

        beforeEach(() => {
            spies.length = 0;
        });

        afterEach(() => {
            for(const spy of spies) {
                spy.mockRestore();
            }
            spies.length = 0;
        });

        it('createApp() calls loadEmbedder with modelSlug and modelQuant from config', async () => {
            // We spy on loadEmbedder BEFORE createApp() runs.
            const fakeEmbedder = {
                encode: mock(async (): Promise<{ data: Uint8Array }> => ({ data: new Uint8Array(128) })),
                close:  mock(async () => undefined),
            };

            // Spy on @/storage loadEmbedder
            const loadEmbedderSpy = spyOn(storageModule, 'loadEmbedder').mockResolvedValue(
                fakeEmbedder as unknown as Awaited<ReturnType<typeof storageModule.loadEmbedder>>
            );

            // Stub VectorIndex.open to avoid real SQLite I/O
            const mockVectorIndex = {
                isClosed: false,
                close:    mock(() => undefined),
                getHash:  mock((): string | undefined => undefined),
                upsert:   mock(() => undefined),
                'delete': mock(() => undefined),
                query:    mock(() => []),
            };

            // Stub loadConfig so createApp() doesn't hit real SST Resource bindings
            const mockDocClient = { send: mock(async () => ({ Items: [], Count: 0 })) } as unknown as DynamoDBDocumentClient;
            const mockBot = {
                start:          mock(async () => undefined),
                stop:           mock(async () => undefined),
                triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
            };

            spies.push(
                loadEmbedderSpy,
                spyOn(vecStoreModule.VectorIndex, 'open').mockResolvedValue(
                    mockVectorIndex as unknown as Awaited<ReturnType<typeof vecStoreModule.VectorIndex.open>>
                ),
                spyOn(configLoaderModule, 'loadConfig').mockReturnValue({
                    app:     { nodeEnv: 'test', logLevel: 'info', port: 3000 },
                    agent:   { oauthToken: 'test-oauth-token', mainModel: 'sonnet', fallbackModel: 'sonnet', quota: { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] } },
                    session: sessionConfig,
                    discord: {
                        botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
                        applicationId: '123456789012345678',
                        homeGuildId:   '111222333444555666' as ReturnType<typeof configLoaderModule.loadConfig>['discord']['homeGuildId'],
                    },
                    adminDiscordUserId:    '123456789',
                    adminDiscordChannelId: '987654321098765432' as ReturnType<typeof configLoaderModule.loadConfig>['adminDiscordChannelId'],
                    vectorIndex:           { enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0' },
                }),
                spyOn(discordBotModule, 'createDiscordBot').mockReturnValue(mockBot),
                spyOn(registerCommandsModule, 'registerAllCommands').mockResolvedValue(undefined),
                // @ts-expect-error -- mocking constructor
                spyOn(crBackendModule, 'ChannelRegistryBackend').mockReturnValue({
                    warmCache:     mock(async () => undefined),
                    getChannel:    mock(async () => null),
                    upsertChannel: mock(async () => undefined),
                    listChannels:  mock(async () => []),
                    deleteChannel: mock(async () => undefined),
                }),
                // @ts-expect-error -- mocking constructor
                spyOn(crManagerModule, 'ChannelRegistryManager').mockReturnValue({
                    shouldProcess:      mock(() => true),
                    getChannel:         mock(() => null),
                    warmCache:          mock(async () => undefined),
                    getUnmutedChannels: mock(async () => []),
                    getAllChannels:     mock(() => []),
                }),
                spyOn(dynamoClientModule, 'createDynamoDBClient').mockReturnValue({
                    client:    { destroy: mock(() => undefined) } as unknown as DynamoDBClient,
                    docClient: mockDocClient,
                    tableName: 'IsambardMemory',
                }),
                // @ts-expect-error -- mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({
                    load: mock(async () => undefined),
                }))
            );

            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
            const app = await indexModule.createApp();

            // Verify loadEmbedder was called (config has vectorIndex.enabled=true)
            expect(loadEmbedderSpy).toHaveBeenCalled();
            // The config default is modelSlug='0.6b', modelQuant='Q8_0'
            expect(loadEmbedderSpy).toHaveBeenCalledWith(
                expect.objectContaining({ slug: '0.6b', quant: 'Q8_0' })
            );

            // Clean up
            await app.stop();
        });
    });

    // ─── 3. Storage layer wiring ────────────────────────────────────────────
    describe('3. Storage layer: asyncIndexer and vectorIndex defined when enabled + embedder provided', () => {
        const spies: ReturnType<typeof spyOn>[] = [];

        beforeEach(() => {
            spies.length = 0;
        });

        afterEach(() => {
            for(const spy of spies) {
                spy.mockRestore();
            }
            spies.length = 0;
        });

        it('createStorageLayer() returns asyncIndexer and vectorIndex when config.enabled and embedder provided', async () => {
            // Mock VectorIndex.open to avoid real SQLite I/O
            const mockVectorIndex = {
                isClosed: false,
                close:    mock(() => undefined),
                getHash:  mock((): string | undefined => undefined),
                upsert:   mock(() => undefined),
                'delete': mock(() => undefined),
                query:    mock(() => []),
            };

            spies.push(
                spyOn(dynamoClientModule, 'createDynamoDBClient').mockReturnValue({
                    client:    {} as unknown as DynamoDBClient,
                    docClient: {} as unknown as DynamoDBDocumentClient,
                    tableName: 'TestTable',
                }),
                // @ts-expect-error -- mocking constructor
                spyOn(memoryToolModule, 'MemoryToolBackend').mockImplementation(() => ({
                    get: mock(async () => undefined),
                })),
                // @ts-expect-error -- mocking constructor
                spyOn(sessionResumeModule, 'SessionResumeBackend').mockImplementation(() => ({})),
                spyOn(vecStoreModule.VectorIndex, 'open').mockResolvedValue(
                    mockVectorIndex as unknown as Awaited<ReturnType<typeof vecStoreModule.VectorIndex.open>>
                )
            );

            const fakeEmbedder = {
                encode: mock(async (): Promise<{ data: Uint8Array }> => ({ data: new Uint8Array(128) })),
                close:  mock(async () => undefined),
            };

            const storage = await storageLayerModule.createStorageLayer(
                { tableName: 'TestTable' },
                undefined,
                undefined,
                { enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0' },
                fakeEmbedder
            );

            expect(storage.vectorIndex).toBeDefined();
            expect(storage.asyncIndexer).toBeDefined();

            // Clean up
            void storage.asyncIndexer!.close();
        });
    });

    // ─── 4. MCP tool wiring ─────────────────────────────────────────────────
    describe('4. MCP: semantic_search tool registered when vectorIndex+embedder configured', () => {
        it('createMemoryMCPServer registers semantic_search tool when vectorIndex and embedder provided', () => {
            // createMemoryMCPServer returns a McpSdkServerConfigWithInstance.
            // We introspect via instance._registeredTools — the @modelcontextprotocol/sdk McpServer
            // stores registered tools as a plain object keyed by tool name.
            // NOTE(sdk-internal): _registeredTools is an SDK-internal field. If a future SDK version
            // renames it, this assertion will silently pass against an empty object. Consider migrating
            // to InMemoryTransport + Client.listTools() if that becomes an issue.

            // Build a minimal fake backend
            const fakeBackend = {
                get:               mock(async () => undefined),
                create:            mock(async () => undefined),
                update:            mock(async () => undefined),
                list:              mock(async () => ({ items: [], nextCursor: undefined })),
                search:            mock(async () => ({ items: [] })),
                listByLayer:       mock(async () => ({ items: [], nextCursor: undefined })),
                searchByTimeRange: mock(async () => ({ items: [] })),
                consolidate:       mock(async () => undefined),
                rename:            mock(async () => undefined),
                'delete':          mock(async () => undefined),
                recordAccess:      mock(async () => undefined),
            };

            const fakeVectorIndex = {
                isClosed: false,
                close:    mock(() => undefined),
                getHash:  mock((): string | undefined => undefined),
                upsert:   mock(() => undefined),
                'delete': mock(() => undefined),
                query:    mock(() => []),
            };

            const fakeEmbedder = {
                encode: mock(async (): Promise<{ data: Uint8Array }> => ({ data: new Uint8Array(128) })),
                close:  mock(async () => undefined),
            };

            // With vectorIndex+embedder: semantic_search should be registered
            const serverWithSearch = memoryMcpServerModule.createMemoryMCPServer(
                fakeBackend as unknown as Parameters<typeof memoryMcpServerModule.createMemoryMCPServer>[0],
                {
                    vectorIndex: fakeVectorIndex as Parameters<typeof memoryMcpServerModule.createMemoryMCPServer>[1] extends { vectorIndex?: infer V } ? NonNullable<V> : never,
                    embedder:    fakeEmbedder,
                }
            );

            // Without vectorIndex: semantic_search should NOT be registered
            const serverWithout = memoryMcpServerModule.createMemoryMCPServer(
                fakeBackend as unknown as Parameters<typeof memoryMcpServerModule.createMemoryMCPServer>[0]
            );

            const withSearchTools = (serverWithSearch.instance as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
            const withoutTools = (serverWithout.instance as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};

            expect(Object.hasOwn(withSearchTools, 'semantic_search')).toBe(true);
            expect(Object.hasOwn(withoutTools, 'semantic_search')).toBe(false);
        });
    });

    // ─── 5. Shutdown ordering wiring ────────────────────────────────────────
    describe('5. Shutdown: asyncIndexer.close called before vectorIndex.close', () => {
        const spies: ReturnType<typeof spyOn>[] = [];

        beforeEach(() => {
            spies.length = 0;
        });

        afterEach(() => {
            for(const spy of spies) {
                spy.mockRestore();
            }
            spies.length = 0;
        });

        it.each([false, true])('app.stop() closes the vector index after the async indexer (indexer rejects: %s)', async (indexerRejects) => {
            // We need to create a real app with stubbed vector deps, then stop it and verify order.
            const callOrder: string[] = [];
            const indexerFailure = new Error('Indexer drain failed');
            const destroyHolder = spyOn(DynamoDBClientHolder.prototype, 'destroy');

            const fakeEmbedder = {
                encode: mock(async (): Promise<{ data: Uint8Array }> => ({ data: new Uint8Array(128) })),
                close:  mock(async () => undefined),
            };

            const mockVectorIndex = {
                isClosed:     false,
                close:        mock(() => { callOrder.push('vectorIndex.close'); }),
                getHash:      mock((): string | undefined => undefined),
                upsert:       mock(() => undefined),
                'delete':     mock(() => undefined),
                query:        mock(() => []),
                pruneExpired: mock(() => 0),
            };
            const pruneScheduler = {
                start:   mock(() => { callOrder.push('pruneScheduler.start'); }),
                stop:    mock(() => { callOrder.push('pruneScheduler.stop'); }),
                runOnce: mock(() => undefined),
            };
            const createPruneScheduler = spyOn(vecStoreModule, 'createVectorPruneScheduler').mockReturnValue(pruneScheduler);

            const mockAsyncIndexer = {
                isClosed: false,
                close:    mock(async () => {
                    callOrder.push('asyncIndexer.close');
                    if(indexerRejects) {
                        throw indexerFailure;
                    }
                }),
                enqueue: mock(() => undefined),
                drain:   mock(async () => undefined),
            };

            const mockDocClient = { send: mock(async () => ({ Items: [], Count: 0 })) } as unknown as DynamoDBDocumentClient;
            const firstClient = { destroy: mock(() => undefined) } as unknown as DynamoDBClient;
            const openVectorIndex = spyOn(vecStoreModule.VectorIndex, 'open').mockResolvedValue(
                mockVectorIndex as unknown as Awaited<ReturnType<typeof vecStoreModule.VectorIndex.open>>
            );
            // @ts-expect-error -- mocking constructor
            const createAsyncIndexer = spyOn(vecStoreModule, 'AsyncIndexer').mockImplementation(() => mockAsyncIndexer);
            const createDynamoDBClient = spyOn(dynamoClientModule, 'createDynamoDBClient').mockReturnValue({
                client:    firstClient,
                docClient: mockDocClient,
                tableName: 'IsambardMemory',
            });

            spies.push(
                destroyHolder,
                openVectorIndex,
                createAsyncIndexer,
                createPruneScheduler,
                spyOn(storageModule, 'loadEmbedder').mockResolvedValue(
                    fakeEmbedder as unknown as Awaited<ReturnType<typeof storageModule.loadEmbedder>>
                ),
                spyOn(configLoaderModule, 'loadConfig').mockReturnValue({
                    app:     { nodeEnv: 'test', logLevel: 'info', port: 3000 },
                    agent:   { oauthToken: 'test-oauth-token', mainModel: 'sonnet', fallbackModel: 'sonnet', quota: { pollIntervalMs: 300_000, perchPauseAtPercent: 90, notifyAtPercents: [75, 90] } },
                    session: sessionConfig,
                    discord: {
                        botToken:      'MTIzNDU2Nzg5MDEyMzQ1Njc4.GHIJKL.abcdefghijklmnopqrstuvwxyz0123456789AB',
                        applicationId: '123456789012345678',
                        homeGuildId:   '111222333444555666' as ReturnType<typeof configLoaderModule.loadConfig>['discord']['homeGuildId'],
                    },
                    adminDiscordUserId:    '123456789',
                    adminDiscordChannelId: '987654321098765432' as ReturnType<typeof configLoaderModule.loadConfig>['adminDiscordChannelId'],
                    vectorIndex:           { enabled: true, dbPath: 'test.sqlite', modelSlug: '0.6b', modelQuant: 'Q8_0' },
                }),
                spyOn(discordBotModule, 'createDiscordBot').mockReturnValue({
                    start:          mock(async () => undefined),
                    stop:           mock(async () => undefined),
                    triggerCatchUp: mock(async () => undefined), ...pendingSessionHost(),
                }),
                spyOn(registerCommandsModule, 'registerAllCommands').mockResolvedValue(undefined),
                // @ts-expect-error -- mocking constructor
                spyOn(crBackendModule, 'ChannelRegistryBackend').mockReturnValue({
                    warmCache:     mock(async () => undefined),
                    getChannel:    mock(async () => null),
                    upsertChannel: mock(async () => undefined),
                    listChannels:  mock(async () => []),
                    deleteChannel: mock(async () => undefined),
                }),
                // @ts-expect-error -- mocking constructor
                spyOn(crManagerModule, 'ChannelRegistryManager').mockReturnValue({
                    shouldProcess:      mock(() => true),
                    getChannel:         mock(() => null),
                    warmCache:          mock(async () => undefined),
                    getUnmutedChannels: mock(async () => []),
                    getAllChannels:     mock(() => []),
                }),
                createDynamoDBClient,
                // @ts-expect-error -- mocking constructor
                spyOn(storageModule, 'PersonAllowlist').mockImplementation(() => ({
                    load: mock(async () => undefined),
                }))
            );

            process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
            const app = await indexModule.createApp();
            const stopResult = app.stop();
            expect(app.stop()).toBe(stopResult);
            await (indexerRejects
                ? expect(stopResult).rejects.toBe(indexerFailure)
                : expect(stopResult).resolves.toBeUndefined());
            const repeatedStop = app.stop();
            expect(repeatedStop).toBe(stopResult);
            await (indexerRejects
                ? expect(repeatedStop).rejects.toBe(indexerFailure)
                : expect(repeatedStop).resolves.toBeUndefined());

            // Both must have been called
            expect(callOrder).toContain('asyncIndexer.close');
            expect(callOrder).toContain('vectorIndex.close');

            // The prune scheduler stops first, then asyncIndexer.close, then vectorIndex.close (#129)
            const asyncIdx = callOrder.indexOf('asyncIndexer.close');
            const vecIdx = callOrder.indexOf('vectorIndex.close');
            expect(asyncIdx).toBeLessThan(vecIdx);
            expect(createPruneScheduler).toHaveBeenCalledWith({ vectorIndex: mockVectorIndex, logger: expect.anything() });
            expect(callOrder.indexOf('pruneScheduler.stop')).toBeGreaterThan(-1);
            expect(callOrder.indexOf('pruneScheduler.stop')).toBeLessThan(asyncIdx);
            expect(mockAsyncIndexer.close).toHaveBeenCalledTimes(1);
            expect(mockVectorIndex.close).toHaveBeenCalledTimes(1);
            expect(destroyHolder).toHaveBeenCalledTimes(1);

            if(!indexerRejects) {
                const firstCycleClientCreations = createDynamoDBClient.mock.calls.length;
                const nextVectorIndex = {
                    ...mockVectorIndex,
                    close: mock(() => { callOrder.push('next vectorIndex.close'); }),
                };
                const nextAsyncIndexer = {
                    ...mockAsyncIndexer,
                    close: mock(async () => { callOrder.push('next asyncIndexer.close'); }),
                };
                const nextClient = { destroy: mock(() => undefined) } as unknown as DynamoDBClient;
                openVectorIndex.mockResolvedValue(nextVectorIndex as unknown as Awaited<ReturnType<typeof vecStoreModule.VectorIndex.open>>);
                // @ts-expect-error -- mocking constructor
                createAsyncIndexer.mockImplementation(() => nextAsyncIndexer);
                createDynamoDBClient.mockReturnValue({ client: nextClient, docClient: mockDocClient, tableName: 'IsambardMemory' });

                await app.start();
                expect(callOrder).toContain('pruneScheduler.start');
                await app.stop();
                expect(callOrder.lastIndexOf('pruneScheduler.stop')).toBeLessThan(callOrder.indexOf('next asyncIndexer.close'));

                expect(firstClient).not.toBe(nextClient);
                expect(createDynamoDBClient.mock.calls.length).toBeGreaterThan(firstCycleClientCreations);
                expect(firstClient.destroy).toHaveBeenCalled();
                expect(nextClient.destroy).toHaveBeenCalled();
                expect(openVectorIndex).toHaveBeenCalledTimes(2);
                expect(createAsyncIndexer).toHaveBeenCalledTimes(2);
                expect(mockAsyncIndexer.close).toHaveBeenCalledTimes(1);
                expect(mockVectorIndex.close).toHaveBeenCalledTimes(1);
                expect(nextAsyncIndexer.close).toHaveBeenCalledTimes(1);
                expect(nextVectorIndex.close).toHaveBeenCalledTimes(1);
                expect(callOrder.indexOf('next asyncIndexer.close')).toBeLessThan(callOrder.indexOf('next vectorIndex.close'));
                expect(destroyHolder).toHaveBeenCalledTimes(2);
            }
        });
    });

    // ─── 6. Enqueue wiring ──────────────────────────────────────────────────
    describe('6. Enqueue wiring: MemoryToolBackend enqueues jobs on create/update/delete', () => {
        const ddbMock = mockClient(DynamoDBDocumentClient);

        afterEach(() => {
            ddbMock.reset();
        });

        it('create enqueues upsert, update enqueues upsert, delete enqueues delete — removing any call breaks this test', async () => {
            // Use a real MemoryToolBackend (not mocked constructor) with mock DynamoDB and a mock indexer.
            // This verifies that the three enqueueIndex() calls in backend.ts are actually wired up.
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK:          'DIR#/state',
                    SK:          'FILE#test-item',
                    GSI1PK:      'LAYER#state',
                    GSI1SK:      'UPDATED#2025-01-01T00:00:00.000Z',
                    path:        '/state/test-item',
                    content:     'original content',
                    contentType: 'text/plain',
                    metadata:    {},
                    createdAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:   '2025-01-01T00:00:00.000Z',
                },
            });
            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(UpdateCommand).resolves({});
            ddbMock.on(BatchWriteCommand).resolves({});

            const enqueuedJobs: IndexerJob[] = [];
            const mockIndexer = {
                enqueue: mock((job: IndexerJob) => { enqueuedJobs.push(job); }),
            };

            const backend = new MemoryToolBackend(
                ddbMock as unknown as DynamoDBDocumentClient,
                'TestTable',
                mockIndexer
            );

            // 1. create → should enqueue an 'upsert' job
            const created = await backend.create({
                path:        '/state/test-item' as MemoryPath,
                content:     'original content',
                contentType: 'text/plain',
            });
            const afterCreate = [...enqueuedJobs];
            expect(afterCreate).toHaveLength(1);
            expect(afterCreate[0]).toEqual({
                kind:            'upsert',
                path:            '/state/test-item' as MemoryPath,
                layer:           createIndexLayer('state'),
                content:         'original content',
                ttl:             undefined,
                sourceUpdatedAt: Date.parse(created.updatedAt),
            });

            // 2. update → should enqueue another 'upsert' job
            const updated = await backend.update('/state/test-item' as MemoryPath, { content: 'updated content' });
            const afterUpdate = [...enqueuedJobs];
            expect(afterUpdate).toHaveLength(2);
            expect(afterUpdate[1]).toEqual({
                kind:            'upsert',
                path:            '/state/test-item' as MemoryPath,
                layer:           createIndexLayer('state'),
                content:         'updated content',
                ttl:             undefined,
                sourceUpdatedAt: Date.parse(updated.updatedAt),
            });

            // 3. delete → should enqueue a 'delete' job, stamped with the delete's own version (#134)
            const FIXED_NOW = 1_700_000_000_000;
            jest.useFakeTimers();
            jest.setSystemTime(FIXED_NOW);
            await backend.delete('/state/test-item' as MemoryPath);
            jest.useRealTimers();
            const afterDelete = [...enqueuedJobs];
            expect(afterDelete).toHaveLength(3);
            expect(afterDelete[2]).toEqual({ kind: 'delete', path: '/state/test-item' as MemoryPath, sourceUpdatedAt: FIXED_NOW });
        });
    });
});
