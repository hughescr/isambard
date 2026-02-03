// Test setup and configuration
import { mock } from 'bun:test';
import {
    assign,
    constant,
    replace,
    padStart,
    isDate,
    isArray,
    noop,
    chain,
    startsWith,
    slice,
    includes,
    split,
    last,
    compact,
    join,
    filter,
    forEach
} from 'lodash';

// Mock SST Resource - MUST be mutable so tests can customize values
export const mockSstResource: Record<string, { value: unknown }> = {
    App:                      { value: 'test-app' },
    DiscordToken:             { value: 'test-discord-token' },
    ClaudeApiKey:             { value: 'test-claude-api-key' },
    ClaudeCodeOAuthToken:     { value: 'test-oauth-token' },
    DiscordHomeGuildId:       { value: 'test-guild-123' },
    DiscordMonitoredChannels: { value: '' },
    DynamoDBTableName:        { value: 'IsambardMemory' },
    DynamoDBEndpoint:         { value: undefined },
};

// Helper to reset SST Resource to defaults
export function resetMockSstResource(): void {
    mockSstResource.App = { value: 'test-app' };
    mockSstResource.DiscordToken = { value: 'test-discord-token' };
    mockSstResource.ClaudeApiKey = { value: 'test-claude-api-key' };
    mockSstResource.ClaudeCodeOAuthToken = { value: 'test-oauth-token' };
    mockSstResource.DiscordHomeGuildId = { value: 'test-guild-123' };
    mockSstResource.DiscordMonitoredChannels = { value: '' };
    mockSstResource.DynamoDBTableName = { value: 'IsambardMemory' };
    mockSstResource.DynamoDBEndpoint = { value: undefined };
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('sst', () => ({
    Resource: mockSstResource,
}));

// Mock AWS SDK before any imports - we test OUR code, not AWS SDK
// This eliminates cold-start costs entirely
class MockDynamoDBClient {
    config:          Record<string, unknown>;
    middlewareStack: {
        add: (middleware: unknown, options: unknown) => void
    };

    constructor(config: Record<string, unknown>) {
        this.config = {
            maxAttempts: async () => config.maxAttempts ?? 3,
            region:      async () => config.region ?? 'us-west-2',
            endpoint:    config.endpoint
                ? async () => {
                    const url = new URL(config.endpoint as string);
                    return { hostname: url.hostname, port: Number(url.port) || 8000, protocol: url.protocol };
                }
                : undefined,
        };

        // Mock middleware stack for timing middleware
        this.middlewareStack = {
            add: noop,
        };
    }
}

class MockDynamoDBDocumentClient {
    static from(client: unknown, options?: unknown) {
        const instance = new MockDynamoDBDocumentClient();
        (instance as unknown as { _fromOptions: unknown })._fromOptions = options;
        (instance as unknown as { _client: unknown })._client = client;
        return instance;
    }

    // send must be on prototype for aws-sdk-client-mock compatibility
    // (mockClient accesses Client.prototype.send)
    async send(_command: unknown): Promise<unknown> {
        return {};
    }
}
// Add sinon-compatible properties for aws-sdk-client-mock
// eslint-disable-next-line @typescript-eslint/unbound-method -- Intentionally modifying prototype
assign(MockDynamoDBDocumentClient.prototype.send, {
    isSinonProxy: false,
    restore:      undefined,
});

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: MockDynamoDBClient,
}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: MockDynamoDBDocumentClient,
    GetCommand:             class GetCommand { constructor(public input: unknown) {} },
    PutCommand:             class PutCommand { constructor(public input: unknown) {} },
    QueryCommand:           class QueryCommand { constructor(public input: unknown) {} },
    DeleteCommand:          class DeleteCommand { constructor(public input: unknown) {} },
    UpdateCommand:          class UpdateCommand { constructor(public input: unknown) {} },
    BatchWriteCommand:      class BatchWriteCommand { constructor(public input: unknown) {} },
    ScanCommand:            class ScanCommand { constructor(public input: unknown) {} },
}));

// Mock Anthropic SDK to avoid import cold-start cost (~5ms)
class MockAnthropic {
    apiKey: string;

    constructor(config: { apiKey: string }) {
        this.apiKey = config.apiKey;
    }

    messages = {
        create: async () => ({
            id:            'msg_mock',
            type:          'message',
            role:          'assistant',
            content:       [{ type: 'text', text: 'Mock response' }],
            model:         'claude-3-sonnet-20240229',
            stop_reason:   'end_turn',
            stop_sequence: null,
            usage:         { input_tokens: 10, output_tokens: 10 },
        }),
    };
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@anthropic-ai/sdk', () => ({
    'default': MockAnthropic,
    Anthropic: MockAnthropic,
}));

// Mock unstable_v2_prompt from Claude Agent SDK
// Export the mock so text-generator.test.ts can control it
// Other SDK functions (query, createSdkMcpServer, tool) pass through to real implementations
export const mockUnstableV2Prompt = mock<(prompt: string, options: { model: string }) => Promise<{ subtype: string, result?: string }>>(
    async () => ({ subtype: 'success', result: 'Mock agent response' })
);

// Import real SDK functions to re-export them alongside our mock
// This must be done BEFORE mock.module() to get the real implementations
import * as realAgentSdk from '@anthropic-ai/claude-agent-sdk';

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    // Pass through real SDK functions
    query:              realAgentSdk.query,
    createSdkMcpServer: realAgentSdk.createSdkMcpServer,
    tool:               realAgentSdk.tool,
    // Replace unstable_v2_prompt with our controllable mock
    unstable_v2_prompt: mockUnstableV2Prompt,
}));

// Mock text-generator module to claim it before any test file
// Import real implementations AFTER SDK mock is in place (so they use our mocked SDK)
import * as realTextGeneratorModule from '@/agent/text-generator';

// CRITICAL: Capture functions as local variables BEFORE mock.module()
// ESM namespace objects have live bindings, so after mock.module() the namespace
// properties would point to the mocks, causing infinite recursion
const originalGenerateText = realTextGeneratorModule.generateText;
const originalGenerateTextWithSystemPrompt = realTextGeneratorModule.generateTextWithSystemPrompt;

// Export the captured original functions for tests that need to restore call-through
export { originalGenerateText, originalGenerateTextWithSystemPrompt };

// Create controllable mocks that DEFAULT to calling real implementations
// Tests that need to override (like presence-flow.test.ts) can mockImplementation()
// Tests that need real behavior (like text-generator.test.ts) get real code via SDK mock
export const mockGenerateText = mock(originalGenerateText);
export const mockGenerateTextWithSystemPrompt = mock(originalGenerateTextWithSystemPrompt);

// Mock logger to silence output and allow test assertions
// Type the mock functions properly so .mock.calls[n][0] works correctly
export const mockLogger = {
    debug: mock((_obj: Record<string, unknown>) => undefined),
    info:  mock((_obj: Record<string, unknown>) => undefined),
    warn:  mock((_obj: Record<string, unknown>) => undefined),
    error: mock((_obj: Record<string, unknown>) => undefined),
    child: mock(() => { return mockLogger; }),
};

// Mock helpers for Discord handlers
export function createMockBotStateManager() {
    return {
        shouldUpdatePresence:   mock(constant(true)),
        updateActivityPhase:    mock(constant(undefined)),
        clearActivityPhase:     mock(constant(undefined)),
        getMode:                mock(constant('idle' as const)),
        goIdle:                 mock(constant(undefined)),
        startProcessingMessage: mock(constant(undefined)),
        getSessionType:         mock((isDM: boolean) => (isDM ? 'dm' : 'guild')),
    };
}

export function createMockResponseRouter() {
    return {
        routeResponse: mock(async (_sessionType: string, reply: string, channelId: string, _userId: string) => ({
            shouldSend:      !reply.includes('@@NO_RESPONSE@@'),
            content:         replace(reply, '@@NO_RESPONSE@@', ''),
            targetChannelId: channelId,
            isFallback:      false,
        })),
    };
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@hughescr/logger', () => ({
    logger: mockLogger,
}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@/agent/text-generator', () => ({
    generateText:                 mockGenerateText,
    generateTextWithSystemPrompt: mockGenerateTextWithSystemPrompt,
}));

// Mock Discord retry module to allow tests to control retry behavior
// Import real implementations first
import * as realDiscordRetry from '@/integrations/discord/retry';

// Capture original functions before mock.module
const originalWithDiscordRetry = realDiscordRetry.withDiscordRetry;
const originalClassifyDiscordError = realDiscordRetry.classifyDiscordError;
const originalDiscordErrorClassifier = realDiscordRetry.discordErrorClassifier;

// Export original for tests that need real behavior
export { originalWithDiscordRetry, originalClassifyDiscordError };

// Create controllable mock that DEFAULTS to executing immediately without retry delays
// For handler tests: operations run without delays
// For retry.test.ts: they can use the real function via deps injection anyway
export const mockWithDiscordRetry = mock(async <T>(
    operation: () => Promise<T>,
    _operationName: string,
    _options?: unknown
): Promise<T> => {
    // By default, just execute the operation once without any retry logic
    return operation();
});

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('@/integrations/discord/retry', () => ({
    withDiscordRetry:       mockWithDiscordRetry,
    classifyDiscordError:   originalClassifyDiscordError,
    discordErrorClassifier: originalDiscordErrorClassifier,
}));

// Mock heic-convert with mutable indirection for per-test customization
type HeicConvertFn = (options: { buffer: ArrayBufferLike, format: string }) => Promise<Buffer>;

let heicConvertImpl: HeicConvertFn = async _options => Buffer.from('fake-png-data');

export const mockHeicConvert = mock(async (options: { buffer: ArrayBufferLike, format: string }) => {
    return heicConvertImpl(options);
});

export function setHeicConvertImpl(fn: HeicConvertFn): void {
    heicConvertImpl = fn;
}

export function resetHeicConvertImpl(): void {
    heicConvertImpl = async () => Buffer.from('fake-png-data');
    mockHeicConvert.mockClear();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('heic-convert', () => ({
    'default': mockHeicConvert,
}));

// Mock node:fs/promises to avoid filesystem I/O cold-start cost
// Returns in-memory fake filesystem without calling real FS APIs
const mockFs = new Map<string, { type: 'file' | 'dir', content?: string }>();

// Define original implementations
const originalAccessImpl = async (path: string) => {
    if(!mockFs.has(path)) {
        const err = new Error(`ENOENT: no such file or directory, access '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    }
};

const originalStatImpl = async (path: string) => {
    const entry = mockFs.get(path);
    if(!entry) {
        const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    }
    return {
        isDirectory: () => entry.type === 'dir',
        isFile:      () => entry.type === 'file',
    };
};

const originalReaddirImpl = async (path: string, options?: { withFileTypes?: boolean }) => {
    const entry = mockFs.get(path);
    if(!entry?.type || entry.type !== 'dir') {
        const err = new Error(`ENOENT: no such file or directory, scandir '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    }

    // Normalize path by removing trailing slashes
    const normalizedPath = replace(path, /\/+$/, '');

    // Find all direct children of this directory
    const entries = Array.from(mockFs.entries());
    const children = chain(entries)
        .filter(([childPath]: [string, { type: 'file' | 'dir', content?: string }]) => {
            // Must start with parent path
            if(!startsWith(childPath, normalizedPath + '/')) {
                return false;
            }
            // Get the relative path after the parent
            const relative = slice(childPath, normalizedPath.length + 1);
            // Only include direct children (no nested slashes)
            return relative && !includes(relative, '/');
        })
        .map(([childPath, childEntry]: [string, { type: 'file' | 'dir', content?: string }]) => {
            const parts = split(childPath, '/');
            const name = last(parts) ?? '';
            if(options?.withFileTypes) {
                return {
                    name,
                    isDirectory: () => childEntry.type === 'dir',
                    isFile:      () => childEntry.type === 'file',
                };
            }
            return name;
        })
        .value();

    return children;
};

const originalReadFileImpl = async (path: string, _encoding?: string) => {
    const entry = mockFs.get(path);
    if(!entry?.type || entry.type !== 'file') {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    }
    return entry.content ?? '';
};

const originalWriteFileImpl = async (path: string, content: string) => {
    mockFs.set(path, { type: 'file', content });
};

const originalMkdirImpl = async (path: string, options?: { recursive?: boolean }) => {
    if(options?.recursive) {
        // Create all parent directories
        const parts = compact(split(path, '/'));
        const isAbsolute = startsWith(path, '/');

        for(let i = 0; i < parts.length; i++) {
            const pathParts = slice(parts, 0, i + 1);
            const currentPath = isAbsolute
                ? '/' + join(pathParts, '/')
                : join(pathParts, '/');

            if(!mockFs.has(currentPath)) {
                mockFs.set(currentPath, { type: 'dir' });
            }
        }
    } else {
        mockFs.set(path, { type: 'dir' });
    }
};

const originalRmImpl = async (_path: string, _options?: { recursive?: boolean, force?: boolean }) => {
    // Clear all entries starting with this path
    const keys = Array.from(mockFs.keys());
    const toDelete = filter(keys, (key: string) => key === _path || startsWith(key, _path + '/'));
    forEach(toDelete, (key: string) => mockFs.delete(key));
};

const originalUnlinkImpl = async (path: string) => {
    // unlink removes a single file
    if(!mockFs.has(path)) {
        const err = new Error(`ENOENT: no such file or directory, unlink '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    }
    mockFs.delete(path);
};

const originalCpImpl = async (_source: string, _dest: string, _options?: unknown) => {
    // cp copies files/directories - for test purposes, just succeed
    return Promise.resolve();
};

export const mockFsPromises = {
    access:    mock(originalAccessImpl),
    stat:      mock(originalStatImpl),
    readdir:   mock(originalReaddirImpl),
    readFile:  mock(originalReadFileImpl),
    writeFile: mock(originalWriteFileImpl),
    mkdir:     mock(originalMkdirImpl),
    rm:        mock(originalRmImpl),
    unlink:    mock(originalUnlinkImpl),
    cp:        mock(originalCpImpl),
};

// Export a helper to reset the mock filesystem between tests
export function resetMockFs(): void {
    mockFs.clear();
    // Restore original implementations and clear call history
    mockFsPromises.access.mockReset();
    mockFsPromises.access.mockImplementation(originalAccessImpl);
    mockFsPromises.stat.mockReset();
    mockFsPromises.stat.mockImplementation(originalStatImpl);
    mockFsPromises.readdir.mockReset();
    mockFsPromises.readdir.mockImplementation(originalReaddirImpl);
    mockFsPromises.readFile.mockReset();
    mockFsPromises.readFile.mockImplementation(originalReadFileImpl);
    mockFsPromises.writeFile.mockReset();
    mockFsPromises.writeFile.mockImplementation(originalWriteFileImpl);
    mockFsPromises.mkdir.mockReset();
    mockFsPromises.mkdir.mockImplementation(originalMkdirImpl);
    mockFsPromises.rm.mockReset();
    mockFsPromises.rm.mockImplementation(originalRmImpl);
    mockFsPromises.unlink.mockReset();
    mockFsPromises.unlink.mockImplementation(originalUnlinkImpl);
    mockFsPromises.cp.mockReset();
    mockFsPromises.cp.mockImplementation(originalCpImpl);
}

// Reset only paths matching a prefix - for test isolation
export function resetMockFsPrefix(prefix: string): void {
    for(const key of mockFs.keys()) {
        if(startsWith(key, prefix)) {
            mockFs.delete(key);
        }
    }
    // Restore original implementations and clear call history
    mockFsPromises.access.mockReset();
    mockFsPromises.access.mockImplementation(originalAccessImpl);
    mockFsPromises.stat.mockReset();
    mockFsPromises.stat.mockImplementation(originalStatImpl);
    mockFsPromises.readdir.mockReset();
    mockFsPromises.readdir.mockImplementation(originalReaddirImpl);
    mockFsPromises.readFile.mockReset();
    mockFsPromises.readFile.mockImplementation(originalReadFileImpl);
    mockFsPromises.writeFile.mockReset();
    mockFsPromises.writeFile.mockImplementation(originalWriteFileImpl);
    mockFsPromises.mkdir.mockReset();
    mockFsPromises.mkdir.mockImplementation(originalMkdirImpl);
    mockFsPromises.rm.mockReset();
    mockFsPromises.rm.mockImplementation(originalRmImpl);
    mockFsPromises.unlink.mockReset();
    mockFsPromises.unlink.mockImplementation(originalUnlinkImpl);
    mockFsPromises.cp.mockReset();
    mockFsPromises.cp.mockImplementation(originalCpImpl);
}

// Note: Tests should call resetMockFs() or resetMockFsPrefix() in their own afterEach hooks
// to prevent memory accumulation. We don't do automatic cleanup here since this is module-level code.

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('node:fs/promises', () => mockFsPromises);

// Mock Intl.DateTimeFormat to avoid timezone API cold-start cost
// Returns predictable fake data without calling real ICU APIs
const TIMEZONE_OFFSETS: Record<string, number> = {
    UTC:                   0,
    'America/Los_Angeles': -8,
    'America/New_York':    -5,
    'Europe/London':       0,
    'Asia/Tokyo':          9,
    'Pacific/Kwajalein':   12,
};

// @ts-expect-error -- Mocking global
Intl.DateTimeFormat = class MockDateTimeFormat {
    private options:  Intl.DateTimeFormatOptions;
    private locale:   string;
    private tzOffset: number;

    constructor(locale?: string, options?: Intl.DateTimeFormatOptions) {
        this.locale = locale ?? 'en-US';
        this.options = options ?? {};

        // Throw for invalid timezones (like real API)
        const tz = this.options.timeZone;
        if(tz && !(tz in TIMEZONE_OFFSETS)) {
            throw new RangeError(`Invalid time zone specified: ${tz}`);
        }
        this.tzOffset = tz ? TIMEZONE_OFFSETS[tz] : 0;
    }

    format(date?: Date | number): string {
        const d = this.applyOffset(date);
        return replace(d.toISOString(), 'Z', '');
    }

    formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
        const d = this.applyOffset(date);
        return [
            { type: 'year', value: String(d.getUTCFullYear()) },
            { type: 'literal', value: '-' },
            { type: 'month', value: padStart(String(d.getUTCMonth() + 1), 2, '0') },
            { type: 'literal', value: '-' },
            { type: 'day', value: padStart(String(d.getUTCDate()), 2, '0') },
            { type: 'literal', value: ', ' },
            { type: 'hour', value: padStart(String(d.getUTCHours()), 2, '0') },
            { type: 'literal', value: ':' },
            { type: 'minute', value: padStart(String(d.getUTCMinutes()), 2, '0') },
            { type: 'literal', value: ':' },
            { type: 'second', value: padStart(String(d.getUTCSeconds()), 2, '0') },
        ];
    }

    private applyOffset(date?: Date | number): Date {
        const d = isDate(date) ? new Date(date) : new Date(date ?? Date.now());
        d.setUTCHours(d.getUTCHours() + this.tzOffset);
        return d;
    }

    resolvedOptions(): Intl.ResolvedDateTimeFormatOptions {
        return {
            locale:          this.locale,
            calendar:        'gregory',
            numberingSystem: 'latn',
            timeZone:        this.options.timeZone ?? 'UTC',
        } as Intl.ResolvedDateTimeFormatOptions;
    }

    static supportedLocalesOf(locales: string | string[]): string[] {
        return isArray(locales) ? locales : [locales];
    }
};
