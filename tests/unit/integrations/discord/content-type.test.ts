import { describe, it, expect } from 'bun:test';
import { inferImageContentType } from '@/integrations/discord/content-type';

describe('inferImageContentType', () => {
    describe('when Discord provides valid image contentType', () => {
        it('uses image/jpeg from Discord', () => {
            expect(inferImageContentType('file.txt', 'image/jpeg')).toBe('image/jpeg');
        });

        it('returns EXACT Discord contentType, not inferred from extension', () => {
            // This test kills mutant: if 'image/' is mutated to 'Stryker was here!',
            // the function would infer from extension instead of using Discord's value.
            // Use .heic extension with image/jpeg from Discord.
            // If mutant survives, would return image/heic (from extension), not image/jpeg (from Discord)
            const result = inferImageContentType('photo.heic', 'image/jpeg');
            expect(result).toBe('image/jpeg'); // Discord's value
            expect(result).not.toBe('image/heic'); // Not from extension
        });

        it('uses image/png from Discord', () => {
            expect(inferImageContentType('file.txt', 'image/png')).toBe('image/png');
        });

        it('uses image/gif from Discord', () => {
            expect(inferImageContentType('file.txt', 'image/gif')).toBe('image/gif');
        });

        it('uses image/webp from Discord', () => {
            expect(inferImageContentType('file.txt', 'image/webp')).toBe('image/webp');
        });

        it('uses image/heic from Discord', () => {
            expect(inferImageContentType('file.txt', 'image/heic')).toBe('image/heic');
        });

        it('uses image/heif from Discord', () => {
            expect(inferImageContentType('file.txt', 'image/heif')).toBe('image/heif');
        });

        it('rejects contentType ending with image/ (not starting)', () => {
            // This tests the _.startsWith mutation (changed to _.endsWith)
            expect(inferImageContentType('photo.png', 'application/image/')).toBe('image/png');
        });

        it('rejects contentType with image/ in the middle', () => {
            expect(inferImageContentType('photo.jpeg', 'text/image/data')).toBe('image/jpeg');
        });

        it('accepts image/ prefix even without extension', () => {
            expect(inferImageContentType('README', 'image/custom')).toBe('image/custom');
        });

        it('returns Discord contentType immediately without continuing to extension lookup', () => {
            // If the return statement is removed, execution continues to extension lookup.
            // For 'file.heic' with 'image/jpeg', if block is removed, lookup would return 'image/heic'.
            const result = inferImageContentType('file.heic', 'image/jpeg');
            expect(result).toBe('image/jpeg'); // Discord's value
            expect(result).not.toBe('image/heic'); // Not from extension
        });
    });

    describe('when Discord provides null/invalid contentType', () => {
        it('infers image/heic from .heic extension', () => {
            expect(inferImageContentType('photo.heic', null)).toBe('image/heic');
        });

        it('infers image/heif from .heif extension', () => {
            expect(inferImageContentType('photo.heif', null)).toBe('image/heif');
        });

        it('infers image/jpeg from .jpg extension', () => {
            expect(inferImageContentType('photo.jpg', null)).toBe('image/jpeg');
        });

        it('infers image/jpeg from .jpeg extension', () => {
            expect(inferImageContentType('photo.jpeg', null)).toBe('image/jpeg');
        });

        it('infers image/png from .png extension', () => {
            expect(inferImageContentType('photo.png', null)).toBe('image/png');
        });

        it('infers image/gif from .gif extension', () => {
            expect(inferImageContentType('photo.gif', null)).toBe('image/gif');
        });

        it('infers image/webp from .webp extension', () => {
            expect(inferImageContentType('photo.webp', null)).toBe('image/webp');
        });

        it('returns application/octet-stream for unknown extension', () => {
            expect(inferImageContentType('document.xyz', null)).toBe('application/octet-stream');
        });

        it('returns application/octet-stream for file without extension', () => {
            expect(inferImageContentType('README', null)).toBe('application/octet-stream');
        });

        it('handles case-insensitive extensions (.HEIC)', () => {
            expect(inferImageContentType('PHOTO.HEIC', null)).toBe('image/heic');
        });

        it('handles case-insensitive extensions (.JPG)', () => {
            expect(inferImageContentType('PHOTO.JPG', null)).toBe('image/jpeg');
        });

        it('handles case-insensitive extensions (.PNG)', () => {
            expect(inferImageContentType('PHOTO.PNG', null)).toBe('image/png');
        });

        it('handles mixed case extensions (.HeIc)', () => {
            expect(inferImageContentType('photo.HeIc', null)).toBe('image/heic');
        });

        it('handles mixed case extensions (.JpEg)', () => {
            expect(inferImageContentType('photo.JpEg', null)).toBe('image/jpeg');
        });
    });

    describe('fallback behavior', () => {
        it('uses Discord contentType as fallback for unknown extension', () => {
            expect(inferImageContentType('file.xyz', 'text/plain')).toBe('text/plain');
        });

        it('uses Discord contentType as fallback when no extension', () => {
            expect(inferImageContentType('README', 'application/pdf')).toBe('application/pdf');
        });

        it('uses octet-stream when both extension and contentType are unknown', () => {
            expect(inferImageContentType('file.xyz', null)).toBe('application/octet-stream');
        });

        it('uses octet-stream when extension is unknown and contentType is null', () => {
            expect(inferImageContentType('document.abc', null)).toBe('application/octet-stream');
        });
    });

    describe('edge cases', () => {
        it('handles filename with multiple dots', () => {
            expect(inferImageContentType('photo.backup.heic', null)).toBe('image/heic');
        });

        it('handles filename with multiple dots and uses last extension', () => {
            expect(inferImageContentType('file.old.png', null)).toBe('image/png');
        });

        it('handles empty filename with extension', () => {
            expect(inferImageContentType('.heic', null)).toBe('image/heic');
        });

        it('handles filename with trailing dot', () => {
            // 'photo.'.split('.').at(-1) returns ''
            expect(inferImageContentType('photo.', null)).toBe('application/octet-stream');
        });

        it('uses exact string comparison for MIME types', () => {
            const result = inferImageContentType('photo.heic', null);
            // This tests that the exact string 'image/heic' is returned, not a variant
            expect(result).toBe('image/heic');
            expect(result).not.toBe('image/HEIC');
            expect(result).not.toBe('image/Heic');
        });

        it('returns exact fallback string for unknown types', () => {
            const result = inferImageContentType('file.xyz', null);
            // This tests the exact fallback string
            expect(result).toBe('application/octet-stream');
            expect(result).not.toBe('application/octetstream');
            expect(result).not.toBe('application/OCTET-STREAM');
        });
    });

    describe('extension extraction logic', () => {
        it('extracts extension correctly with single dot', () => {
            expect(inferImageContentType('file.jpg', null)).toBe('image/jpeg');
        });

        it('extracts last segment when multiple dots present', () => {
            expect(inferImageContentType('my.file.name.png', null)).toBe('image/png');
        });

        it('handles case where split produces single element', () => {
            // 'filename'.split('.').at(-1) returns 'filename' (no dot), mrmime returns undefined
            expect(inferImageContentType('filename', null)).toBe('application/octet-stream');
        });

        it('converts extension to lowercase before matching', () => {
            expect(inferImageContentType('photo.JPEG', null)).toBe('image/jpeg');
        });
    });

    describe('extension-based lookup coverage', () => {
        it('resolves heic extension', () => {
            const result = inferImageContentType('test.heic', null);
            expect(result).toBe('image/heic');
        });

        it('resolves heif extension', () => {
            const result = inferImageContentType('test.heif', null);
            expect(result).toBe('image/heif');
        });

        it('resolves jpg extension', () => {
            const result = inferImageContentType('test.jpg', null);
            expect(result).toBe('image/jpeg');
        });

        it('resolves jpeg extension', () => {
            const result = inferImageContentType('test.jpeg', null);
            expect(result).toBe('image/jpeg');
        });

        it('resolves png extension', () => {
            const result = inferImageContentType('test.png', null);
            expect(result).toBe('image/png');
        });

        it('resolves gif extension', () => {
            const result = inferImageContentType('test.gif', null);
            expect(result).toBe('image/gif');
        });

        it('resolves webp extension', () => {
            const result = inferImageContentType('test.webp', null);
            expect(result).toBe('image/webp');
        });

        it('falls back for unknown extension', () => {
            const result = inferImageContentType('test.unknown', null);
            expect(result).toBe('application/octet-stream');
        });

        it('falls back when no extension present', () => {
            const result = inferImageContentType('testfile', null);
            expect(result).toBe('application/octet-stream');
        });

        it('does not return non-image MIME types from extension lookup', () => {
            // mrmime knows about .txt => text/plain, but we filter to image/ only
            const result = inferImageContentType('file.txt', null);
            expect(result).toBe('application/octet-stream');
        });
    });

    describe('conditional branch coverage', () => {
        it('takes true branch when Discord provides valid image type', () => {
            // if(_.startsWith(...)) → true path
            expect(inferImageContentType('file.txt', 'image/png')).toBe('image/png');
        });

        it('takes false branch when Discord provides non-image type', () => {
            // if(_.startsWith(...)) → false path
            expect(inferImageContentType('file.png', 'text/plain')).toBe('image/png');
        });

        it('takes false branch when Discord provides null', () => {
            // if((null ?? '') .startsWith('image/')) → false path
            expect(inferImageContentType('file.png', null)).toBe('image/png');
        });
    });

    describe('nullish coalescing operator coverage', () => {
        it('uses empty string when discordContentType is null in startsWith check', () => {
            // discordContentType ?? '' → ''
            expect(inferImageContentType('file.png', null)).toBe('image/png');
        });

        it('uses empty string when discordContentType is null in fallback', () => {
            // In fallback: discordContentType ?? 'application/octet-stream' → 'application/octet-stream'
            expect(inferImageContentType('file.xyz', null)).toBe('application/octet-stream');
        });

        it('uses provided contentType when not null in fallback', () => {
            // In fallback: discordContentType ?? 'application/octet-stream' → discordContentType
            expect(inferImageContentType('file.xyz', 'video/mp4')).toBe('video/mp4');
        });
    });

    describe('non-null assertion operator coverage', () => {
        it('safely returns non-null Discord contentType', () => {
            // return discordContentType! when startsWith check passes
            const result = inferImageContentType('file.txt', 'image/svg+xml');
            expect(result).toBe('image/svg+xml');
        });
    });

    describe('mime?.startsWith branch coverage', () => {
        it('takes the mime image/ branch for known image extension', () => {
            // mime is defined and starts with image/ → returns mime
            expect(inferImageContentType('photo.png', null)).toBe('image/png');
        });

        it('skips mime branch for non-image extension known to mrmime', () => {
            // mime is defined but does NOT start with image/ → falls through to fallback
            expect(inferImageContentType('file.txt', null)).toBe('application/octet-stream');
        });

        it('skips mime branch when ext produces undefined from mrmime', () => {
            // mime is undefined (unknown extension) → falls through to fallback
            expect(inferImageContentType('file.zzz', null)).toBe('application/octet-stream');
        });
    });
});
