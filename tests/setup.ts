// Test setup and configuration
/* eslint-disable import-x/order -- imports are intentionally interleaved with mock.module() calls to ensure correct mock ordering */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mock, type Mock } from 'bun:test';

type ContentItem = CallToolResult['content'][number];

/** Narrow an MCP content item to text type and return the text string. Throws if not text. */
export function textContent(item: ContentItem): string {
    if(item.type !== 'text') {
        throw new Error(`Expected text content, got ${item.type}`);
    }
    return item.text;
}

// Mock SST Resource - MUST be mutable so tests can customize values
export const mockSstResource: Record<string, { value?: unknown, name?: string }> = {
    App:                  { value: 'test-app' },
    DiscordToken:         { value: 'test-discord-token' },
    ClaudeApiKey:         { value: 'test-claude-api-key' },
    ClaudeCodeOAuthToken: { value: 'test-oauth-token' },
    DiscordHomeGuildId:   { value: 'test-guild-123' },
    DiscordApplicationId: { value: 'test-app-id' },
    IsambardMainModel:    { value: 'sonnet' },
    IsambardMemory:       { name: 'IsambardMemory' },
    // Planned integrations (commented out - not yet implemented):
    // CaldavUrl:                     { value: 'https://caldav.icloud.com' },
    // CaldavUsername:                { value: 'test@icloud.com' },
    // SmtpHost:                      { value: 'mail.example.com' },
    // SmtpPort:                      { value: '587' },
    // EmailUser:                     { value: 'test@example.com' },
    // BoxClientId:                   { value: 'test-box-client-id' },
};

// Helper to reset SST Resource to defaults
export function resetMockSstResource(): void {
    mockSstResource.App = { value: 'test-app' };
    mockSstResource.DiscordToken = { value: 'test-discord-token' };
    mockSstResource.ClaudeApiKey = { value: 'test-claude-api-key' };
    mockSstResource.ClaudeCodeOAuthToken = { value: 'test-oauth-token' };
    mockSstResource.DiscordHomeGuildId = { value: 'test-guild-123' };
    mockSstResource.DiscordApplicationId = { value: 'test-app-id' };
    mockSstResource.IsambardMainModel = { value: 'sonnet' };
    mockSstResource.IsambardMemory = { name: 'IsambardMemory' };
    // Planned integrations (commented out - not yet implemented):
    // mockSstResource.CaldavUrl = { value: 'https://caldav.icloud.com' };
    // mockSstResource.CaldavUsername = { value: 'test@icloud.com' };
    // mockSstResource.SmtpHost = { value: 'mail.example.com' };
    // mockSstResource.SmtpPort = { value: '587' };
    // mockSstResource.EmailUser = { value: 'test@example.com' };
    // mockSstResource.BoxClientId = { value: 'test-box-client-id' };
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
            add: () => undefined,
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
// eslint-disable-next-line @typescript-eslint/unbound-method -- intentionally accessing prototype method for augmentation, not invocation
Object.assign(MockDynamoDBDocumentClient.prototype.send, {
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
    TransactWriteCommand:   class TransactWriteCommand { constructor(public input: unknown) {} },
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

// Mock query from Claude Agent SDK
// text-generator.ts uses query() for text generation
// Default: returns a single assistant event with mock text + result event
async function* defaultMockQueryImpl(_params: unknown) {
    yield {
        type:    'assistant',
        message: { content: [{ type: 'text', text: 'Mock agent response' }] },
    };
    yield { type: 'result', subtype: 'success' };
}

export const mockQuery = mock(defaultMockQueryImpl);

// Import real SDK functions to re-export them alongside our mocks
// This must be done BEFORE mock.module() to get the real implementations
import * as realAgentSdk from '@anthropic-ai/claude-agent-sdk';
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    // Pass through real SDK functions that aren't mocked
    createSdkMcpServer: realAgentSdk.createSdkMcpServer,
    tool:               realAgentSdk.tool,
    // Replace query with a controllable mock
    query:              mockQuery,
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
// Also export resetTmpDirForTesting so tests can reset the singleton without going through the mock
export { originalGenerateText, originalGenerateTextWithSystemPrompt };
export const resetTmpDirForTesting = realTextGeneratorModule.resetTmpDirForTesting;

// Create controllable mocks that DEFAULT to calling real implementations
// Tests that need to override (like presence-flow.test.ts) can mockImplementation()
// Tests that need real behavior (like text-generator.test.ts) get real code via SDK mock
export const mockGenerateText = mock(originalGenerateText);
export const mockGenerateTextWithSystemPrompt = mock(originalGenerateTextWithSystemPrompt);

// Mock logger to silence output and allow test assertions
// Create a mock that satisfies both the logger interface and provides mock methods
type MockLoggerMethod = Mock<(...args: unknown[]) => typeof mockLogger>;

// Need to declare mockLogger variable first, then assign to it
// This allows methods to return mockLogger (self-reference)
export const mockLogger: {
    debug: MockLoggerMethod
    info:  MockLoggerMethod
    warn:  MockLoggerMethod
    error: MockLoggerMethod
    child: Mock<() => typeof mockLogger>
} = {
    debug: undefined as unknown as MockLoggerMethod,
    info:  undefined as unknown as MockLoggerMethod,
    warn:  undefined as unknown as MockLoggerMethod,
    error: undefined as unknown as MockLoggerMethod,
    child: undefined as unknown as Mock<() => typeof mockLogger>,
};

// Now assign the actual mocks after mockLogger is declared
mockLogger.debug = mock((..._args: unknown[]) => mockLogger);
mockLogger.info = mock((..._args: unknown[]) => mockLogger);
mockLogger.warn = mock((..._args: unknown[]) => mockLogger);
mockLogger.error = mock((..._args: unknown[]) => mockLogger);
mockLogger.child = mock(() => mockLogger);

// Mock helpers for Discord handlers
export function createMockBotStateManager() {
    return {
        shouldUpdatePresence:   mock(() => true),
        updateActivityPhase:    mock(() => undefined),
        clearActivityPhase:     mock(() => undefined),
        getMode:                mock(() => 'idle' as const),
        goIdle:                 mock(() => undefined),
        startProcessingMessage: mock(() => undefined),
        getSessionType:         mock((isDM: boolean) => (isDM ? 'dm' : 'guild')),
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

// Export original for tests that need real behavior
export { originalWithDiscordRetry, originalClassifyDiscordError };

// Create controllable mock that DEFAULTS to executing immediately without retry delays
// For handler tests: operations run without delays
// For retry.test.ts: they can use the real function via deps injection anyway
export const mockWithDiscordRetry = mock(async <T>(
    operation: () => Promise<T>,
    _options?: unknown
): Promise<T> => {
    // By default, just execute the operation once without any retry logic
    return operation();
});

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('@/integrations/discord/retry', () => ({
    withDiscordRetry:     mockWithDiscordRetry,
    classifyDiscordError: originalClassifyDiscordError,
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

// No-op placeholder for backward compatibility with tests that call resetPathValidatorMocks
// Path validator is no longer globally mocked - tests use real implementation with mockFsPromises
export function resetPathValidatorMocks(): void {
    // No-op - path validator uses real implementation
}

// Mock node:fs/promises to avoid filesystem I/O cold-start cost
// Returns in-memory fake filesystem without calling real FS APIs
interface MockFsEntry { type: 'file' | 'dir' | 'symlink', content?: string, target?: string }
const mockFs = new Map<string, MockFsEntry>();

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
        isDirectory:    () => entry.type === 'dir',
        isFile:         () => entry.type === 'file',
        isSymbolicLink: () => false,
    };
};

const originalLstatImpl = async (path: string) => {
    const entry = mockFs.get(path);
    if(!entry) {
        const err = new Error(`ENOENT: no such file or directory, lstat '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
    }
    return {
        isDirectory:    () => entry.type === 'dir',
        isFile:         () => entry.type === 'file',
        isSymbolicLink: () => entry.type === 'symlink',
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
    // eslint-disable-next-line sonarjs/slow-regex, regexp/no-super-linear-move -- test-only regex; path strings are short and well-controlled, no DoS risk
    const normalizedPath = path.replace(/\/+$/, '');

    // Find all direct children of this directory
    const entries = [...mockFs.entries()];
    const directChildren = entries.filter(([childPath]: [string, MockFsEntry]) => {
        // Must start with parent path
        if(!childPath.startsWith(`${normalizedPath}/`)) {
            return false;
        }
        // Get the relative path after the parent
        const relative = childPath.slice(normalizedPath.length + 1);
        // Only include direct children (no nested slashes)

        return relative.length > 0 && !relative.includes('/');
    });
    // eslint-disable-next-line sonarjs/function-return-type -- callback returns string or Dirent-like object depending on withFileTypes option; matches node:fs readdir signature
    return directChildren.map(([childPath, childEntry]: [string, MockFsEntry]): string | { name: string, isDirectory: () => boolean, isFile: () => boolean, isSymbolicLink: () => boolean } => {
        const parts = childPath.split('/');
        const name = parts.at(-1) ?? '';
        if(options?.withFileTypes) {
            return {
                name,
                isDirectory:    () => childEntry.type === 'dir',
                isFile:         () => childEntry.type === 'file',
                isSymbolicLink: () => childEntry.type === 'symlink',
            };
        }
        return name;
    });
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
        const parts = path.split('/').filter(Boolean);
        const isAbsolute = path.startsWith('/');

        for(let i = 0; i < parts.length; i++) {
            const pathParts = parts.slice(0, i + 1);
            const currentPath = isAbsolute
                ? `/${pathParts.join('/')}`
                : pathParts.join('/');

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
    const keys = [...mockFs.keys()];
    const toDelete = keys.filter((key: string) => key === _path || key.startsWith(`${_path}/`));
    for(const key of toDelete) {
        mockFs.delete(key);
    }
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

};

const originalSymlinkImpl = async (target: string, path: string) => {
    mockFs.set(path, { type: 'symlink', target });
};

// Counter for mkdtemp to ensure unique directories
let mkdtempCounter = 0;
const originalMkdtempImpl = async (prefix: string): Promise<string> => {
    mkdtempCounter++;
    const dirPath = `${prefix}mock${mkdtempCounter}`;
    mockFs.set(dirPath, { type: 'dir' });
    return dirPath;
};

export const mockFsPromises = {
    access:    mock(originalAccessImpl),
    stat:      mock(originalStatImpl),
    lstat:     mock(originalLstatImpl),
    readdir:   mock(originalReaddirImpl),
    readFile:  mock(originalReadFileImpl),
    writeFile: mock(originalWriteFileImpl),
    mkdir:     mock(originalMkdirImpl),
    rm:        mock(originalRmImpl),
    unlink:    mock(originalUnlinkImpl),
    cp:        mock(originalCpImpl),
    symlink:   mock(originalSymlinkImpl),
    mkdtemp:   mock(originalMkdtempImpl),
};

// Export a helper to reset the mock filesystem between tests
export function resetMockFs(): void {
    mockFs.clear();
    mkdtempCounter = 0;
    // Restore original implementations and clear call history
    mockFsPromises.access.mockReset();
    mockFsPromises.access.mockImplementation(originalAccessImpl);
    mockFsPromises.stat.mockReset();
    mockFsPromises.stat.mockImplementation(originalStatImpl);
    mockFsPromises.lstat.mockReset();
    mockFsPromises.lstat.mockImplementation(originalLstatImpl);
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
    mockFsPromises.symlink.mockReset();
    mockFsPromises.symlink.mockImplementation(originalSymlinkImpl);
    mockFsPromises.mkdtemp.mockReset();
    mockFsPromises.mkdtemp.mockImplementation(originalMkdtempImpl);
}

// Reset only paths matching a prefix - for test isolation
export function resetMockFsPrefix(prefix: string): void {
    for(const key of mockFs.keys()) {
        if(key.startsWith(prefix)) {
            mockFs.delete(key);
        }
    }
    // Restore original implementations and clear call history
    mockFsPromises.access.mockReset();
    mockFsPromises.access.mockImplementation(originalAccessImpl);
    mockFsPromises.stat.mockReset();
    mockFsPromises.stat.mockImplementation(originalStatImpl);
    mockFsPromises.lstat.mockReset();
    mockFsPromises.lstat.mockImplementation(originalLstatImpl);
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
    mockFsPromises.symlink.mockReset();
    mockFsPromises.symlink.mockImplementation(originalSymlinkImpl);
    mockFsPromises.mkdtemp.mockReset();
    mockFsPromises.mkdtemp.mockImplementation(originalMkdtempImpl);
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
    'Pacific/Auckland':    13,
};

// Short timezone abbreviations for mock (fixed, no DST — matches test fixture offsets above)
const TIMEZONE_ABBRS: Record<string, string> = {
    UTC:                   'UTC',
    'America/Los_Angeles': 'PST',
    'America/New_York':    'EST',
    'Europe/London':       'GMT',
    'Asia/Tokyo':          'JST',
    'Pacific/Kwajalein':   'MHT',
    'Pacific/Auckland':    'NZDT',
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

        // Handle weekday formatting
        if(this.options.weekday === 'long') {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            return days[d.getUTCDay()];
        }

        // Handle hour-only formatting
        if(this.options.hour && !this.options.minute && !this.options.second) {
            return String(d.getUTCHours()).padStart(2, '0');
        }

        // Default to ISO-like format without Z
        return d.toISOString().replace('Z', '');
    }

    formatToParts(date?: Date | number): Intl.DateTimeFormatPart[] {
        const d = this.applyOffset(date);

        // Handle weekday formatting
        if(this.options.weekday === 'long') {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            return [
                { type: 'weekday', value: days[d.getUTCDay()] },
            ];
        }

        // Handle hour-only formatting
        if(this.options.hour && !this.options.minute && !this.options.second) {
            return [
                { type: 'hour', value: String(d.getUTCHours()).padStart(2, '0') },
            ];
        }

        // Handle timeZoneName: 'short' formatting (used by Luxon for ZZZZ format token)
        if(this.options.timeZoneName === 'short') {
            const tz = this.options.timeZone ?? 'UTC';
            const abbr = TIMEZONE_ABBRS[tz] ?? `GMT${this.tzOffset >= 0 ? '+' : ''}${this.tzOffset}`;
            return [
                { type: 'timeZoneName', value: abbr },
            ];
        }

        // Default full date-time format
        return [
            { type: 'year', value: String(d.getUTCFullYear()) },
            { type: 'literal', value: '-' },
            { type: 'month', value: String(d.getUTCMonth() + 1).padStart(2, '0') },
            { type: 'literal', value: '-' },
            { type: 'day', value: String(d.getUTCDate()).padStart(2, '0') },
            { type: 'literal', value: ', ' },
            { type: 'hour', value: String(d.getUTCHours()).padStart(2, '0') },
            { type: 'literal', value: ':' },
            { type: 'minute', value: String(d.getUTCMinutes()).padStart(2, '0') },
            { type: 'literal', value: ':' },
            { type: 'second', value: String(d.getUTCSeconds()).padStart(2, '0') },
        ];
    }

    private applyOffset(date?: Date | number): Date {
        const d = date instanceof Date ? new Date(date) : new Date(date ?? Date.now());
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
        return Array.isArray(locales) ? locales : [locales];
    }
};
