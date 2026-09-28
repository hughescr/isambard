import { describe, expect, test } from 'bun:test';
import * as errors from '@/errors';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import {
    ZoteroError,
    ZoteroAuthError,
    ZoteroNotFoundError,
    ZoteroVersionConflictError,
    ZoteroRateLimitError,
    ZoteroServerError,
    ZoteroQuotaError,
    ZoteroFileError,
    ZoteroUrlFetchError,
    ZoteroMetadataError
} from '@/errors/zotero';

describe('ZoteroError hierarchy', () => {
    test('ZoteroError is an IsambardError with the default code and optional context', () => {
        const error = new ZoteroError('boom', undefined, { status: 400, path: '/items' });
        expect(error).toBeInstanceOf(IsambardError);
        expect(error.name).toBe('ZoteroError');
        expect(error.code).toBe(ErrorCode.ZOTERO_ERROR);
        expect(error.message).toBe('boom');
        expect(error.context).toEqual({ status: 400, path: '/items' });
    });

    test.each([
        ['ZoteroAuthError', () => new ZoteroAuthError('a', { status: 403 }), ErrorCode.ZOTERO_AUTH_ERROR, { status: 403 }],
        ['ZoteroNotFoundError', () => new ZoteroNotFoundError('a', { path: '/items/X' }), ErrorCode.ZOTERO_NOT_FOUND, { path: '/items/X' }],
        ['ZoteroVersionConflictError', () => new ZoteroVersionConflictError('a', { currentVersion: 7 }), ErrorCode.ZOTERO_VERSION_CONFLICT, { currentVersion: 7 }],
        ['ZoteroRateLimitError', () => new ZoteroRateLimitError('a', { retryAfterMs: 5000, overBudget: false }), ErrorCode.ZOTERO_RATE_LIMITED, { retryAfterMs: 5000, overBudget: false }],
        ['ZoteroServerError', () => new ZoteroServerError('a', { status: 502, idempotent: true }), ErrorCode.ZOTERO_SERVER_ERROR, { status: 502, idempotent: true }],
        ['ZoteroQuotaError', () => new ZoteroQuotaError('a', { status: 413 }), ErrorCode.ZOTERO_QUOTA_EXCEEDED, { status: 413 }],
        ['ZoteroFileError', () => new ZoteroFileError('a', { reason: 'too_large', limit: 10 }), ErrorCode.ZOTERO_FILE_ERROR, { reason: 'too_large', limit: 10 }],
        ['ZoteroUrlFetchError', () => new ZoteroUrlFetchError('a', { url: 'https://x.test/', reason: 'blocked' }), ErrorCode.ZOTERO_URL_FETCH_ERROR, { url: 'https://x.test/', reason: 'blocked' }],
        ['ZoteroMetadataError', () => new ZoteroMetadataError('a', { source: 'crossref', status: 500 }), ErrorCode.ZOTERO_METADATA_ERROR, { source: 'crossref', status: 500 }],
    ] as const)('%s has its own name, code and context and extends ZoteroError', (name, make, code, context) => {
        const error = make();
        expect(error).toBeInstanceOf(ZoteroError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error.name).toBe(name);
        expect(error.code).toBe(code);
        expect(error.message).toBe('a');
        expect(error.context).toEqual(context);
    });

    test('rate-limit and file errors expose their typed fields', () => {
        const rateLimited = new ZoteroRateLimitError('wait', { retryAfterMs: 120_000, overBudget: true });
        expect(rateLimited.retryAfterMs).toBe(120_000);
        expect(rateLimited.overBudget).toBe(true);

        const file = new ZoteroFileError('no file', { reason: 'no_file' });
        expect(file.reason).toBe('no_file');

        const server = new ZoteroServerError('x', { idempotent: false, timeout: true });
        expect(server.idempotent).toBe(false);
    });

    test('the barrel exports every Zotero error class', () => {
        expect(errors.ZoteroError).toBe(ZoteroError);
        expect(errors.ZoteroAuthError).toBe(ZoteroAuthError);
        expect(errors.ZoteroNotFoundError).toBe(ZoteroNotFoundError);
        expect(errors.ZoteroVersionConflictError).toBe(ZoteroVersionConflictError);
        expect(errors.ZoteroRateLimitError).toBe(ZoteroRateLimitError);
        expect(errors.ZoteroServerError).toBe(ZoteroServerError);
        expect(errors.ZoteroQuotaError).toBe(ZoteroQuotaError);
        expect(errors.ZoteroFileError).toBe(ZoteroFileError);
        expect(errors.ZoteroUrlFetchError).toBe(ZoteroUrlFetchError);
        expect(errors.ZoteroMetadataError).toBe(ZoteroMetadataError);
    });
});
