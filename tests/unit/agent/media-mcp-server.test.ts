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
interface RegisteredToolInstance { _registeredTools: Partial<Record<string, RegisteredTool>>, server: { _serverInfo: { version: string } } }

function getRegisteredTool(server: ReturnType<typeof createMediaMCPServer>, toolName: string): RegisteredTool {
    const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
    if(!registeredTool) {
        throw new Error(`Tool ${toolName} not found`);
    }
    return registeredTool;
}

function getToolHandler(server: ReturnType<typeof createMediaMCPServer>, toolName: string) {
    return getRegisteredTool(server, toolName).handler;
}

test('missing registered tools are rejected by the lookup guard', () => {
    expect(() => getRegisteredTool(createMediaMCPServer(), 'missing-tool')).toThrow('Tool missing-tool not found');
});

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
    const registeredTool = getRegisteredTool(server, toolName);
    expect(registeredTool.description).toBe(expectedDescription);
});

test.each([
    ['analyzeVideoFromUrl', ['url', 'outputDir', 'alt']],
    ['analyzeLocalVideo', ['videoPath', 'outputDir', 'alt']],
    ['getVideoFrames', ['videoPath', 'startTime', 'endTime', 'count']],
    ['generateSpectrogramFromAudio', ['filePath']],
])('tool %s should have correct input schema fields', (toolName, expectedFields) => {
    const server         = createMediaMCPServer();
    const registeredTool = getRegisteredTool(server, toolName);
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

    test('should permit an output directory whose name contains dot-dot', async () => {
        const processVideoSpy = spyOn(utils, 'processVideo').mockRejectedValue(new Error('mocked subprocess error'));
        try {
            const handler = getToolHandler(createMediaMCPServer(), 'analyzeVideoFromUrl');
            const result = await handler({ url: 'https://example.com/video.m3u8', outputDir: 'recordings/..archive' });
            expect(processVideoSpy).toHaveBeenCalled();
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

    test('should permit an output directory whose name contains dot-dot', async () => {
        const pathSpy = spyOn(utils, 'validateFilePath').mockResolvedValue('/safe/video.mp4');
        const processSpy = spyOn(utils, 'processLocalVideo').mockRejectedValue(new Error('mocked subprocess error'));
        try {
            const handler = getToolHandler(createMediaMCPServer(), 'analyzeLocalVideo');
            const result = await handler({ videoPath: 'video.mp4', outputDir: 'recordings/..archive' });
            expect(processSpy).toHaveBeenCalled();
            expect(textContent(result.content[0])).not.toContain('Output directory must be within the working directory');
        } finally {
            processSpy.mockRestore();
            pathSpy.mockRestore();
        }
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
        const registeredTool = getRegisteredTool(server, 'getVideoFrames');
        const countSchema    = registeredTool.inputSchema.shape.count as { safeParse: (v: unknown) => { success: boolean } };
        const parseResult    = countSchema.safeParse(21);
        expect(parseResult.success).toBe(false);
    });

    test('should accept frame count at the max', () => {
        const server         = createMediaMCPServer();
        const registeredTool = getRegisteredTool(server, 'getVideoFrames');
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

const sampleFrame: Awaited<ReturnType<typeof utils.generateSpectrogram>> = {
    filename:     'frame-1.png',
    mediaType:    'image/png',
    base64Data:   'cG5n',
    originalSize: 3,
};

const sampleAnalysis: Awaited<ReturnType<typeof utils.processVideo>> = {
    metadata: {
        duration:       10,
        width:          640,
        height:         360,
        videoCodec:     'h264',
        frameRate:      30,
        subtitleTracks: [],
    },
    frames:           [sampleFrame],
    metadataMarkdown: '# Video metadata',
    outputDir:        'output',
};

describe('media tool result contracts', () => {
    test('URL analysis returns the generated metadata and frames', async () => {
        const processSpy = spyOn(utils, 'processVideo').mockResolvedValue(sampleAnalysis);
        try {
            const result = await getToolHandler(createMediaMCPServer(), 'analyzeVideoFromUrl')({
                url: 'https://example.com/video.mp4', outputDir: 'output', alt: 'A meeting',
            });
            expect(processSpy).toHaveBeenCalledWith('https://example.com/video.mp4', 'output', expect.objectContaining({ alt: 'A meeting' }));
            expect(result).toEqual({ content: [
                { type: 'text', text: '# Video metadata' },
                { type: 'image', data: 'cG5n', mimeType: 'image/png' },
            ] });
        } finally {
            processSpy.mockRestore();
        }
    });

    test('local analysis returns the generated metadata and frames', async () => {
        const pathSpy = spyOn(utils, 'validateFilePath').mockResolvedValue('/safe/video.mp4');
        const processSpy = spyOn(utils, 'processLocalVideo').mockResolvedValue(sampleAnalysis);
        try {
            const result = await getToolHandler(createMediaMCPServer(), 'analyzeLocalVideo')({
                videoPath: 'video.mp4', outputDir: 'output', alt: 'A meeting',
            });
            expect(processSpy).toHaveBeenCalledWith('/safe/video.mp4', 'output', expect.objectContaining({ alt: 'A meeting' }));
            expect(result).toEqual({ content: [
                { type: 'text', text: '# Video metadata' },
                { type: 'image', data: 'cG5n', mimeType: 'image/png' },
            ] });
        } finally {
            processSpy.mockRestore();
            pathSpy.mockRestore();
        }
    });

    test('frame extraction reports empty results and returns extracted images', async () => {
        const pathSpy = spyOn(utils, 'validateFilePath').mockResolvedValue('/safe/video.mp4');
        const framesSpy = spyOn(utils, 'extractFramesInRange').mockResolvedValue([]);
        try {
            const handler = getToolHandler(createMediaMCPServer(), 'getVideoFrames');
            const args = { videoPath: 'video.mp4', startTime: 1, endTime: 4, count: 2 };
            const empty = await handler(args);
            expect(empty.isError).toBe(true);
            expect(textContent(empty.content[0])).toBe('Error: No frames could be extracted in the specified range');

            framesSpy.mockResolvedValue([sampleFrame]);
            const frames = await handler(args);
            expect(framesSpy).toHaveBeenCalledWith('/safe/video.mp4', 1, 4, 2, expect.any(Function));
            expect(frames).toEqual({ content: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }] });
        } finally {
            framesSpy.mockRestore();
            pathSpy.mockRestore();
        }
    });

    test('spectrogram returns the generated image', async () => {
        const pathSpy = spyOn(utils, 'validateFilePath').mockResolvedValue('/safe/audio.wav');
        const spectrogramSpy = spyOn(utils, 'generateSpectrogram').mockResolvedValue(sampleFrame);
        try {
            const result = await getToolHandler(createMediaMCPServer(), 'generateSpectrogramFromAudio')({ filePath: 'audio.wav' });
            expect(spectrogramSpy).toHaveBeenCalledWith('/safe/audio.wav', expect.any(Function));
            expect(result).toEqual({ content: [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }] });
        } finally {
            spectrogramSpy.mockRestore();
            pathSpy.mockRestore();
        }
    });
});
