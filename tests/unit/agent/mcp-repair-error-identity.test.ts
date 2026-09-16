import { expect, mock, spyOn, test } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createCaldavMCPServer } from '../../../src/agent/caldav-mcp-server';
import { createContactsMCPServer } from '../../../src/agent/contacts-mcp-server';
import { createInboxMCPServer } from '../../../src/agent/inbox-mcp-server';
import { createMediaMCPServer } from '../../../src/agent/media-mcp-server';
import * as mediaUtils from '../../../src/utils';
import { mockLogger } from '../../setup';

interface RegisteredServer {
    instance: unknown
}

function handler(server: RegisteredServer, name: string): (args: Record<string, unknown>) => Promise<CallToolResult> {
    const instance = server.instance as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }> };
    return instance._registeredTools[name].handler;
}

async function expectDiagnosticIdentity(server: RegisteredServer, name: string, args: Record<string, unknown>): Promise<void> {
    mockLogger.warn.mockClear();
    const result = await handler(server, name)(args);
    expect(result.isError).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith({ tool: name, error: 'backend failed' }, 'MCP tool error');
}

const throwBackendError = () => {
    throw new Error('backend failed');
};

test('calendar tool failures retain the operation name in diagnostic logs', async () => {
    expect.assertions(6);
    const unused = {} as unknown;
    const server = createCaldavMCPServer({
        client:      unused as Parameters<typeof createCaldavMCPServer>[0]['client'],
        registry:    unused as Parameters<typeof createCaldavMCPServer>[0]['registry'],
        resolveUser: mock(async () => {
            throwBackendError();
            return { status: 'not_found' as const };
        }),
    });
    await expectDiagnosticIdentity(server, 'getCalendarEvents', { user: 'Alice', startDate: '2026-01-01', endDate: '2026-01-02' });
    await expectDiagnosticIdentity(server, 'getUpcomingEvents', { user: 'Alice' });
    await expectDiagnosticIdentity(server, 'listUserCalendars', { user: 'Alice' });
});

test('contact tool failures retain the operation name in diagnostic logs', async () => {
    expect.assertions(10);
    const backend = new Proxy({}, { get: () => throwBackendError });
    const server = createContactsMCPServer({
        backend:                    backend as Parameters<typeof createContactsMCPServer>[0]['backend'],
        sendContactApprovalRequest: async () => { throwBackendError(); },
    });
    await expectDiagnosticIdentity(server, 'lookupContact', { query: 'Alice' });
    await expectDiagnosticIdentity(server, 'lookupContactId', { personId: 'alice', platform: 'email' });
    await expectDiagnosticIdentity(server, 'requestContactCreate', { displayName: 'Alice', identifiers: [{ platform: 'email', value: 'alice@example.com' }] });
    await expectDiagnosticIdentity(server, 'requestContactUpdate', { personId: 'alice' });
    await expectDiagnosticIdentity(server, 'listContacts', {});
});

test('inbox tool failures retain the operation name in diagnostic logs', async () => {
    expect.assertions(10);
    const failures = new Proxy({}, { get: () => throwBackendError });
    const server = createInboxMCPServer(
        failures as Parameters<typeof createInboxMCPServer>[0],
        failures as Parameters<typeof createInboxMCPServer>[1]
    );
    await expectDiagnosticIdentity(server, 'getUnreadOverview', {});
    await expectDiagnosticIdentity(server, 'getChannelSummary', { channelId: '123' });
    await expectDiagnosticIdentity(server, 'fetchMessages', { channelId: '123', messageIds: ['1'] });
    await expectDiagnosticIdentity(server, 'markAsRead', { channelId: '123', messageIds: ['1'] });
    await expectDiagnosticIdentity(server, 'markChannelRead', { channelId: '123' });
});

test('media tool failures retain the operation name in diagnostic logs', async () => {
    expect.assertions(8);
    const pathSpy = spyOn(mediaUtils, 'validateFilePath').mockResolvedValue('/safe/video.mp4');
    const videoSpy = spyOn(mediaUtils, 'processVideo').mockRejectedValue(new Error('backend failed'));
    const localSpy = spyOn(mediaUtils, 'processLocalVideo').mockRejectedValue(new Error('backend failed'));
    const framesSpy = spyOn(mediaUtils, 'extractFramesInRange').mockRejectedValue(new Error('backend failed'));
    const spectrogramSpy = spyOn(mediaUtils, 'generateSpectrogram').mockRejectedValue(new Error('backend failed'));
    try {
        const server = createMediaMCPServer();
        await expectDiagnosticIdentity(server, 'analyzeVideoFromUrl', { url: 'https://example.com/video.mp4', outputDir: 'output' });
        await expectDiagnosticIdentity(server, 'analyzeLocalVideo', { videoPath: 'video.mp4', outputDir: 'output' });
        await expectDiagnosticIdentity(server, 'getVideoFrames', { videoPath: 'video.mp4', startTime: 0, endTime: 2, count: 2 });
        await expectDiagnosticIdentity(server, 'generateSpectrogramFromAudio', { filePath: 'video.mp4' });
    } finally {
        spectrogramSpy.mockRestore();
        framesSpy.mockRestore();
        localSpy.mockRestore();
        videoSpy.mockRestore();
        pathSpy.mockRestore();
    }
});
