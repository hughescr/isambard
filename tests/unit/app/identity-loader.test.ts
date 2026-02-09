import { describe, test, expect, beforeEach } from 'bun:test';
import { mockLogger } from '../../setup';
import type { ContextBuilder } from '@/agent/context-builder';
import { loadIdentityContext } from '@/app/identity-loader';

describe('loadIdentityContext', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
    });

    test('should return undefined when no oauthToken provided', async () => {
        const result = await loadIdentityContext(undefined);
        expect(result).toBeUndefined();
    });

    test('should return default string when oauthToken provided but no contextBuilder', async () => {
        const result = await loadIdentityContext('test-token');
        expect(result).toBe('Isambard - AI Assistant');
    });

    test('should return identity from contextBuilder.loadCoreIdentity() when both available', async () => {
        const mockContextBuilder = {
            // eslint-disable-next-line lodash/prefer-constant -- async mock must return Promise
            loadCoreIdentity: async () => 'Custom Identity',
        } as unknown as ContextBuilder;

        const result = await loadIdentityContext('test-token', mockContextBuilder);
        expect(result).toBe('Custom Identity');
    });

    test('should return default string when loadCoreIdentity returns empty string', async () => {
        const mockContextBuilder = {
            // eslint-disable-next-line lodash/prefer-constant -- async mock must return Promise
            loadCoreIdentity: async () => '',
        } as unknown as ContextBuilder;

        const result = await loadIdentityContext('test-token', mockContextBuilder);
        expect(result).toBe('Isambard - AI Assistant');
    });

    test('should return default string when loadCoreIdentity throws error', async () => {
        const mockContextBuilder = {
            loadCoreIdentity: async () => {
                throw new Error('Load failed');
            },
        } as unknown as ContextBuilder;

        const result = await loadIdentityContext('test-token', mockContextBuilder);
        expect(result).toBe('Isambard - AI Assistant');
    });

    test('should log warning when loadCoreIdentity throws error', async () => {
        const mockContextBuilder = {
            loadCoreIdentity: async () => {
                throw new Error('Load failed');
            },
        } as unknown as ContextBuilder;

        await loadIdentityContext('test-token', mockContextBuilder);
        expect(mockLogger.warn).toHaveBeenCalledWith('Failed to load identity context: Load failed');
    });

    test('should handle non-Error thrown values', async () => {
        const mockContextBuilder = {
            loadCoreIdentity: async () => {
                throw 'string error'; // eslint-disable-line @typescript-eslint/only-throw-error -- Testing non-Error throw handling
            },
        } as unknown as ContextBuilder;

        const result = await loadIdentityContext('test-token', mockContextBuilder);
        expect(result).toBe('Isambard - AI Assistant');
        expect(mockLogger.warn).toHaveBeenCalledWith('Failed to load identity context: string error');
    });
});
