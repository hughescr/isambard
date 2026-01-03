// Test setup and configuration
import { mock } from 'bun:test';
import { assign, replace, padStart, isDate, isArray } from 'lodash';

// Mock AWS SDK before any imports - we test OUR code, not AWS SDK
// This eliminates cold-start costs entirely
class MockDynamoDBClient {
    config: Record<string, unknown>;
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

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@hughescr/logger', () => ({
    logger: mockLogger,
}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup, doesn't need await
mock.module('@/agent/text-generator', () => ({
    generateText:                 mockGenerateText,
    generateTextWithSystemPrompt: mockGenerateTextWithSystemPrompt,
}));

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
