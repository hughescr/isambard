import { describe, it, expect } from 'bun:test';
import { MediaProcessingError } from '@/errors';
import { generateSpectrogram } from '@/utils/media/video/spectrogram';
import type { BinarySpawnRunner } from '@/utils/media/video/types';

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function makeSuccessRunner(): BinarySpawnRunner {
    return async (): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => ({
        stdout:   FAKE_PNG,
        stderr:   '',
        exitCode: 0,
    });
}

function makeFailRunner(): BinarySpawnRunner {
    return async (): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => ({
        stdout:   Buffer.alloc(0),
        stderr:   'ffmpeg error: no audio stream',
        exitCode: 1,
    });
}

describe('generateSpectrogram', () => {
    it('returns FetchedImage with png mediaType', async () => {
        const result = await generateSpectrogram('/test/video.mp4', makeSuccessRunner());
        expect(result.mediaType).toBe('image/png');
        expect(result.filename).toBe('spectrogram.png');
        expect(result.base64Data).toBe(FAKE_PNG.toString('base64'));
        expect(result.originalSize).toBe(FAKE_PNG.length);
    });

    it('throws MediaProcessingError when ffmpeg fails', async () => {
        let caught: unknown;
        try {
            await generateSpectrogram('/test/video.mp4', makeFailRunner());
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MediaProcessingError);
        expect((caught as MediaProcessingError).message).toContain('Spectrogram generation failed');
        expect((caught as MediaProcessingError).context.operation).toBe('ffmpeg-spectrogram');
    });

    it('throws when ffmpeg exits zero but stdout is empty', async () => {
        const emptyRunner: BinarySpawnRunner = async (): Promise<{ stdout: Buffer, stderr: string, exitCode: number }> => ({
            stdout:   Buffer.alloc(0),
            stderr:   '',
            exitCode: 0,
        });
        expect(
            generateSpectrogram('/test/video.mp4', emptyRunner)
        ).rejects.toThrow('Spectrogram generation failed');
    });
});
