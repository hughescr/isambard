/**
 * Utility Error Classes
 *
 * Error classes for utility operations.
 */

import { ErrorCode } from './codes';
import { IsambardError } from './base';
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
