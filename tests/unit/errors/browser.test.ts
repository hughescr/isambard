import { describe, expect, test } from 'bun:test';
import { BrowserError, BrowserNavigateTimeoutError } from '@/errors/browser';
import { ErrorCode } from '@/errors/codes';

describe('browser errors', () => {
    test('BrowserError keeps its concrete name and default code', () => {
        const error = new BrowserError('browser failed');
        expect(error.name).toBe('BrowserError');
        expect(error.code).toBe(ErrorCode.BROWSER_ERROR);
    });

    test('navigation timeout includes the failed URL, attempt count, and recovery state', () => {
        const error = new BrowserNavigateTimeoutError('https://example.org/a', 3);
        expect(error.name).toBe('BrowserNavigateTimeoutError');
        expect(error.code).toBe(ErrorCode.BROWSER_NAVIGATE_TIMEOUT);
        expect(error.message).toBe('navigate(https://example.org/a) timed out after 3 attempts; view closed, next call will lazy-reinit');
        expect(error.context).toEqual({ url: 'https://example.org/a', attempts: 3 });
    });
});
