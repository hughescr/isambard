/**
 * Utility Error Classes
 *
 * Error classes for utility operations.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';
// eslint-disable-next-line boundaries/dependencies -- PathSecurityReason type defined here to avoid circular dep; errors/utils and utils/path-validator have intentional bidirectional type dependency
import type { PathSecurityReason } from '@/utils/path-validator';

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
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
        this.name = 'MediaProcessingError';
        // Stryker disable next-line ConditionalExpression: setting cause=undefined vs not setting are observationally equivalent
        if(cause !== undefined) {
            this.cause = cause;
        }
    }
}
