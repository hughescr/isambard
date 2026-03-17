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
