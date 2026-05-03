/**
 * Config Error Classes
 *
 * Hierarchical error classes for configuration loading and validation.
 * All errors extend IsambardError directly (configuration is not a domain service).
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

// ============================================================================
// Config Validation Error
// ============================================================================

/**
 * Error thrown when configuration schema validation fails at startup.
 * These errors are fatal: the application cannot run with an invalid configuration.
 */
export class ConfigValidationError extends IsambardError {
    declare public readonly context: { validationErrors: { path: string, message: string }[] };

    constructor(prefix: string, validationErrors: { path: string, message: string }[]) {
        super(
            // Stryker disable next-line StringLiteral: error message is informational only
            `${prefix}: ${JSON.stringify(validationErrors)}`,
            ErrorCode.CONFIG_VALIDATION_ERROR,
            { validationErrors }
        );
        // Stryker disable next-line StringLiteral: error name is informational only
        this.name = 'ConfigValidationError';
    }
}
