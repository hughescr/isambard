import { describe, test, expect, spyOn } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMediaMCPServer } from '../../../src/agent/media-mcp-server';
import * as utils from '../../../src/utils';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

function getToolHandler(server: ReturnType<typeof createMediaMCPServer>, toolName: string) {
    const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive guard: Record index returns undefined at runtime when key is missing
    if(!registeredTool) {
        throw new Error(`Tool ${toolName} not found`);
    }
    return registeredTool.handler;
}

test('should create server with correct properties', () => {
    const server = createMediaMCPServer();
    expect(server.name).toBe('media');
    expect(server.instance).toBeDefined();
    expect(server.type).toBe('sdk');
    expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
});

test.each([
    ['analyzeVideoFromUrl', 'Download and analyze a video from a URL. Extracts scene-based frames, metadata, and subtitles/transcription.'],
    ['analyzeLocalVideo', 'Analyze a video file already saved to disk. Extracts scene-based frames, metadata, and subtitles/transcription.'],
    ['getVideoFrames', 'Extract additional frames from a previously downloaded video. Use to focus on specific time ranges.'],
    ['generateSpectrogramFromAudio', 'Generate an audio spectrogram image from a video or audio file. Useful for identifying speech patterns and audio content.'],
])('tool %s should have correct description', (toolName, expectedDescription) => {
    const server         = createMediaMCPServer();
    const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
    expect(registeredTool).toBeDefined();
    expect(registeredTool.description).toBe(expectedDescription);
});

test.each([
    ['analyzeVideoFromUrl', ['url', 'outputDir', 'alt']],
    ['analyzeLocalVideo', ['videoPath', 'outputDir', 'alt']],
    ['getVideoFrames', ['videoPath', 'startTime', 'endTime', 'count']],
    ['generateSpectrogramFromAudio', ['filePath']],
])('tool %s should have correct input schema fields', (toolName, expectedFields) => {
    const server         = createMediaMCPServer();
    const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
    expect(registeredTool).toBeDefined();
    for(const field of expectedFields) {
        expect(registeredTool.inputSchema.shape[field]).toBeDefined();
    }
});

// analyzeVideoFromUrl tool — path validation
describe('analyzeVideoFromUrl tool — path validation', () => {
    test('should return error when outputDir contains path traversal', async () => {
        const server  = createMediaMCPServer();
        const handler = getToolHandler(server, 'analyzeVideoFromUrl');
        const result = await handler({ url: 'https://example.com/video.m3u8', outputDir: '../../../tmp/evil' });
        expect(result.isError).toBe(true);
        expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
    });

    test('should return error when outputDir is an absolute path outside cwd', async () => {
        const server  = createMediaMCPServer();
        const handler = getToolHandler(server, 'analyzeVideoFromUrl');
        const result = await handler({ url: 'https://example.com/video.m3u8', outputDir: '/etc/evil' });
        expect(result.isError).toBe(true);
        expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
    });

    test('should NOT return path error when outputDir is within cwd', async () => {
        // Spy on processVideo to avoid real subprocess calls while still verifying the guard passes
        const processVideoSpy = spyOn(utils, 'processVideo').mockRejectedValue(new Error('mocked subprocess error'));
        try {
            const server  = createMediaMCPServer();
            const handler = getToolHandler(server, 'analyzeVideoFromUrl');
            // outputDir 'output' is a valid relative path — guard passes and processVideo is invoked (mocked)
            const result = await handler({ url: 'https://example.com/video.m3u8', outputDir: 'output' });
            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).not.toContain('Output directory must be within the working directory');
        } finally {
            processVideoSpy.mockRestore();
        }
    });
});

// analyzeLocalVideo tool — path validation
describe('analyzeLocalVideo tool — path validation', () => {
    test('should return error when videoPath contains path traversal', async () => {
        const server  = createMediaMCPServer();
        const handler = getToolHandler(server, 'analyzeLocalVideo');
        const result = await handler({ videoPath: '../../../etc/passwd', outputDir: 'output' });
        expect(result.isError).toBe(true);
        expect(textContent(result.content[0])).toMatch(/outside the working directory|SECURITY/u);
    });

    test('should return error when outputDir contains path traversal', async () => {
        const server  = createMediaMCPServer();
        const handler = getToolHandler(server, 'analyzeLocalVideo');
        const result = await handler({ videoPath: 'video.mp4', outputDir: '../../../tmp/evil' });
        expect(result.isError).toBe(true);
        expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
    });

    test('should return error when outputDir is an absolute path outside cwd', async () => {
        const server  = createMediaMCPServer();
        const handler = getToolHandler(server, 'analyzeLocalVideo');
        const result = await handler({ videoPath: 'video.mp4', outputDir: '/etc/evil' });
        expect(result.isError).toBe(true);
        expect(textContent(result.content[0])).toContain('Output directory must be within the working directory');
    });
});

// getVideoFrames tool — path validation and frame count cap
describe('getVideoFrames tool — path validation and frame count cap', () => {
    test('should return error when videoPath contains path traversal', async () => {
        const server  = createMediaMCPServer();
        const handler = getToolHandler(server, 'getVideoFrames');
        const result = await handler({ videoPath: '../../../etc/passwd', startTime: 0, endTime: 5, count: 3 });
        expect(result.isError).toBe(true);
        expect(textContent(result.content[0])).toMatch(/outside the working directory|SECURITY/u);
    });

    test('should return error when endTime is not greater than startTime', async () => {
        // Spy on validateFilePath to bypass file system checks, letting us test the time guard in isolation
        const validateFilePathSpy = spyOn(utils, 'validateFilePath').mockResolvedValue('/safe/video.mp4');
        try {
            const server  = createMediaMCPServer();
            const handler = getToolHandler(server, 'getVideoFrames');
            const result = await handler({ videoPath: 'video.mp4', startTime: 5, endTime: 3, count: 3 });
            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('endTime must be greater than startTime');
        } finally {
            validateFilePathSpy.mockRestore();
        }
    });

    test('should return error when endTime equals startTime', async () => {
        // Spy on validateFilePath to bypass file system checks, letting us test the time guard in isolation
        const validateFilePathSpy = spyOn(utils, 'validateFilePath').mockResolvedValue('/safe/video.mp4');
        try {
            const server  = createMediaMCPServer();
            const handler = getToolHandler(server, 'getVideoFrames');
            const result = await handler({ videoPath: 'video.mp4', startTime: 5, endTime: 5, count: 3 });
            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('endTime must be greater than startTime');
        } finally {
            validateFilePathSpy.mockRestore();
        }
    });

    test('should reject frame count exceeding max via Zod schema', () => {
        const server         = createMediaMCPServer();
        const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.getVideoFrames;
        const countSchema    = registeredTool.inputSchema.shape.count as { safeParse: (v: unknown) => { success: boolean } };
        const parseResult    = countSchema.safeParse(21);
        expect(parseResult.success).toBe(false);
    });

    test('should accept frame count at the max', () => {
        const server         = createMediaMCPServer();
        const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools.getVideoFrames;
        const countSchema    = registeredTool.inputSchema.shape.count as { safeParse: (v: unknown) => { success: boolean } };
        const parseResult    = countSchema.safeParse(20);
        expect(parseResult.success).toBe(true);
    });
});

// generateSpectrogramFromAudio tool — path validation
describe('generateSpectrogramFromAudio tool — path validation', () => {
    test('should return error when videoPath contains path traversal', async () => {
        const server  = createMediaMCPServer();
        const handler = getToolHandler(server, 'generateSpectrogramFromAudio');
        const result = await handler({ filePath: '../../../etc/passwd' });
        expect(result.isError).toBe(true);
        expect(textContent(result.content[0])).toMatch(/outside the working directory|SECURITY/u);
    });
});
