/**
 * Utility Error Classes
 *
 * Error classes for utility operations.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

/**
 * Why a path was refused. The last five come from `utils/contained-fs.ts` (#157): a hard-linked
 * file, a symlinked or non-directory ancestor, a directory moved during a write, a file over the
 * caller's byte cap, and a platform without the libc bindings it needs.
 */
export type PathSecurityReason = 'outside_cwd' | 'is_symlink' | 'not_found' | 'not_file' | 'hardlinked' | 'not_directory' | 'changed_during_write' | 'too_large' | 'unsupported_platform';

/**
 * Error thrown when a file path fails security validation.
 */
export class PathSecurityError extends IsambardError {
    declare public readonly context: { path: string, reason: PathSecurityReason };

    constructor(message: string, path: string, reason: PathSecurityReason) {
        super(message, ErrorCode.PATH_SECURITY_ERROR, { path, reason });
        this.name = 'PathSecurityError';
    }
}

/**
 * Error thrown when a media processing operation fails.
 * Covers HEIC/image conversion, ffprobe metadata extraction,
 * ffmpeg spectrogram generation, video download, and subtitle extraction.
 */
export class MediaProcessingError extends IsambardError {
    declare public readonly context: { operation: string, detail?: string };

    constructor(message: string, operation: string, detail?: string, cause?: unknown) {
        super(
            message,
            ErrorCode.MEDIA_PROCESSING_ERROR,
            { operation, ...(detail === undefined ? {} : { detail }) }
        );
        this.name = 'MediaProcessingError';
        if(cause !== undefined) {
            this.cause = cause;
        }
    }
}
