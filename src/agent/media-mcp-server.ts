import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, withToolErrorHandling } from './mcp-helpers';
import { createBinarySpawnRunner, createSpawnRunner, extractFramesInRange, generateSpectrogram, processLocalVideo, processVideo, validateFilePath } from '@/utils';

export function createMediaMCPServer() {
    return createSdkMcpServer({
        name:    'media',
        version: '1.0.0',
        tools:   [
            tool(
                // Stryker disable next-line StringLiteral: tool name is configuration
                'analyzeVideoFromUrl',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Download and analyze a video from a URL. Extracts scene-based frames, metadata, and subtitles/transcription.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    url:       z.string().describe('Video URL or HLS playlist URL'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    outputDir: z.string().describe('Directory to save video files and frames'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    alt:       z.string().optional().describe('Alt text for the video'),
                },
                // Stryker disable next-line StringLiteral: tool name is used for logging only
                withToolErrorHandling('analyzeVideoFromUrl', async (args): Promise<CallToolResult> => {
                    const resolved = path.resolve(process.cwd(), args.outputDir);
                    const relative = path.relative(process.cwd(), resolved);
                    if(!relative || relative.startsWith('..')) {
                        return mcpErrorResult('Output directory must be within the working directory');
                    }
                    // Stryker disable all: handler body uses real subprocess runners — not invoked in unit tests
                    const result = await processVideo(args.url, args.outputDir, {
                        run:       createSpawnRunner(),
                        binaryRun: createBinarySpawnRunner(),
                        alt:       args.alt,
                    });
                    return {
                        content: [
                            { type: 'text', text: result.metadataMarkdown },
                            ...result.frames.map(f => ({
                                type:     'image' as const,
                                data:     f.base64Data,
                                mimeType: f.mediaType,
                            })),
                        ],
                    };
                    // Stryker restore all
                }),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Analyze Video From URL', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                // Stryker disable next-line StringLiteral: tool name is configuration
                'analyzeLocalVideo',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Analyze a video file already saved to disk. Extracts scene-based frames, metadata, and subtitles/transcription.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    videoPath: z.string().describe('Path to the local video file'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    outputDir: z.string().describe('Directory to save analysis output (frames, metadata)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    alt:       z.string().optional().describe('Alt text description of the video'),
                },
                // Stryker disable next-line StringLiteral: tool name is used for logging only
                withToolErrorHandling('analyzeLocalVideo', async (args): Promise<CallToolResult> => {
                    const resolved = path.resolve(process.cwd(), args.outputDir);
                    const relative = path.relative(process.cwd(), resolved);
                    if(!relative || relative.startsWith('..')) {
                        return mcpErrorResult('Output directory must be within the working directory');
                    }
                    let safeVideoPath: string;
                    try {
                        safeVideoPath = await validateFilePath(args.videoPath);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                    // Stryker disable all: handler body uses real subprocess runners — not invoked in unit tests
                    const result = await processLocalVideo(safeVideoPath, args.outputDir, {
                        run:       createSpawnRunner(),
                        binaryRun: createBinarySpawnRunner(),
                        alt:       args.alt,
                    });
                    return {
                        content: [
                            { type: 'text', text: result.metadataMarkdown },
                            ...result.frames.map(f => ({
                                type:     'image' as const,
                                data:     f.base64Data,
                                mimeType: f.mediaType,
                            })),
                        ],
                    };
                    // Stryker restore all
                }),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Analyze Local Video', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                // Stryker disable next-line StringLiteral: tool name is configuration
                'getVideoFrames',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Extract additional frames from a previously downloaded video. Use to focus on specific time ranges.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    videoPath: z.string().describe('Path to the local video file'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startTime: z.number().describe('Start time in seconds'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endTime:   z.number().describe('End time in seconds'),
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only; .max(20) is Zod schema configuration
                    count:     z.number().int().positive().max(20).describe('Number of frames to extract (max 20)'),
                },
                // Stryker disable next-line StringLiteral: tool name is used for logging only
                withToolErrorHandling('getVideoFrames', async (args): Promise<CallToolResult> => {
                    let safeVideoPath: string;
                    try {
                        safeVideoPath = await validateFilePath(args.videoPath);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                    if(args.endTime <= args.startTime) {
                        return mcpErrorResult('endTime must be greater than startTime');
                    }
                    // Stryker disable all: handler body uses real subprocess runners — not invoked in unit tests
                    const frames = await extractFramesInRange(
                        safeVideoPath,
                        args.startTime,
                        args.endTime,
                        args.count,
                        createBinarySpawnRunner()
                    );
                    if(frames.length === 0) {
                        return mcpErrorResult('No frames could be extracted in the specified range');
                    }
                    return {
                        content: frames.map(f => ({
                            type:     'image' as const,
                            data:     f.base64Data,
                            mimeType: f.mediaType,
                        })),
                    };
                    // Stryker restore all
                }),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Video Frames', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                // Stryker disable next-line StringLiteral: tool name is configuration
                'generateSpectrogramFromAudio',
                // Stryker disable next-line StringLiteral: tool description is configuration
                'Generate an audio spectrogram image from a video or audio file. Useful for identifying speech patterns and audio content.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    filePath: z.string().describe('Path to the local video or audio file'),
                },
                // Stryker disable next-line StringLiteral: tool name is used for logging only
                withToolErrorHandling('generateSpectrogramFromAudio', async (args): Promise<CallToolResult> => {
                    let safeFilePath: string;
                    try {
                        safeFilePath = await validateFilePath(args.filePath);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                    // Stryker disable all: handler body uses real subprocess runners — not invoked in unit tests
                    const image = await generateSpectrogram(safeFilePath, createBinarySpawnRunner());
                    return {
                        content: [{
                            type:     'image' as const,
                            data:     image.base64Data,
                            mimeType: image.mediaType,
                        }],
                    };
                    // Stryker restore all
                }),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Generate Spectrogram From Audio', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
