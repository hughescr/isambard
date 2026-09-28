/**
 * Zotero Error Classes
 *
 * Hierarchical error classes for the Zotero Web API v3 integration (#157), plus the Crossref and
 * arXiv metadata lookups it uses. All errors extend ZoteroError which extends IsambardError.
 *
 * Messages are written for Izzy to act on. No message or context ever carries the API key or a
 * request header.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

// ============================================================================
// Base Zotero Error
// ============================================================================

/**
 * Base error class for all Zotero integration errors: a 400/428/other 4xx response, or a
 * response whose shape the client does not recognise.
 */
export class ZoteroError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.ZOTERO_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'ZoteroError';
    }
}

// ============================================================================
// Zotero Subclass Errors
// ============================================================================

/** 401/403: the key is invalid or lacks access to the group. */
export class ZoteroAuthError extends ZoteroError {
    constructor(message: string, context?: { status?: number, path?: string }) {
        super(message, ErrorCode.ZOTERO_AUTH_ERROR, context);
        this.name = 'ZoteroAuthError';
    }
}

/** 404: the item, collection or file does not exist. */
export class ZoteroNotFoundError extends ZoteroError {
    constructor(message: string, context?: { path?: string }) {
        super(message, ErrorCode.ZOTERO_NOT_FOUND, context);
        this.name = 'ZoteroNotFoundError';
    }
}

/** 412: a version precondition failed. */
export class ZoteroVersionConflictError extends ZoteroError {
    constructor(message: string, context?: { currentVersion?: number, path?: string }) {
        super(message, ErrorCode.ZOTERO_VERSION_CONFLICT, context);
        this.name = 'ZoteroVersionConflictError';
    }
}

/** 429/503, or a shared Backoff/Retry-After deadline further away than the wait budget. */
export class ZoteroRateLimitError extends ZoteroError {
    declare public readonly context: { retryAfterMs: number, overBudget: boolean };

    constructor(message: string, context: { retryAfterMs: number, overBudget: boolean }) {
        super(message, ErrorCode.ZOTERO_RATE_LIMITED, context);
        this.name = 'ZoteroRateLimitError';
    }

    /** How long, in ms, Zotero asked us to wait. */
    get retryAfterMs(): number {
        return this.context.retryAfterMs;
    }

    /** True when the wait exceeds the client's budget, so the call fails fast instead of waiting. */
    get overBudget(): boolean {
        return this.context.overBudget;
    }
}

/** 5xx (other than 503), 409 "library locked", a timeout or a network failure. */
export class ZoteroServerError extends ZoteroError {
    declare public readonly context: { status?: number, timeout?: boolean, idempotent: boolean, path?: string };

    constructor(message: string, context: { status?: number, timeout?: boolean, idempotent: boolean, path?: string }) {
        super(message, ErrorCode.ZOTERO_SERVER_ERROR, context);
        this.name = 'ZoteroServerError';
    }

    /** Whether the failed request was safe to repeat. */
    get idempotent(): boolean {
        return this.context.idempotent;
    }
}

/** 413: Zotero storage is full, or the file exceeds the plan limit. */
export class ZoteroQuotaError extends ZoteroError {
    constructor(message: string, context?: { status?: number, path?: string }) {
        super(message, ErrorCode.ZOTERO_QUOTA_EXCEEDED, context);
        this.name = 'ZoteroQuotaError';
    }
}

/** Why a file upload or download failed. */
export type ZoteroFileErrorReason = 'no_file' | 'too_large' | 'not_pdf' | 'md5_mismatch' | 'already_has_file' | 'upload_failed' | 'download_failed' | 'bad_content_type';

/** A file upload or download failed. */
export class ZoteroFileError extends ZoteroError {
    declare public readonly context: { reason: ZoteroFileErrorReason, limit?: number, status?: number, key?: string };

    constructor(message: string, context: { reason: ZoteroFileErrorReason, limit?: number, status?: number, key?: string }) {
        super(message, ErrorCode.ZOTERO_FILE_ERROR, context);
        this.name = 'ZoteroFileError';
    }

    get reason(): ZoteroFileErrorReason {
        return this.context.reason;
    }
}

/** A URL fetch was blocked by the host policy, resolved to a blocked address, or failed. */
export class ZoteroUrlFetchError extends ZoteroError {
    constructor(message: string, context: { url: string, reason?: string, status?: number }) {
        super(message, ErrorCode.ZOTERO_URL_FETCH_ERROR, context);
        this.name = 'ZoteroUrlFetchError';
    }
}

/** A Crossref or arXiv lookup failed, or the service rejected the request. */
export class ZoteroMetadataError extends ZoteroError {
    constructor(message: string, context: { source: 'crossref' | 'arxiv', status?: number, reason?: string }) {
        super(message, ErrorCode.ZOTERO_METADATA_ERROR, context);
        this.name = 'ZoteroMetadataError';
    }
}
