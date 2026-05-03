import { describe, test, expect } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import { ConfigValidationError } from '@/errors/config';

describe.concurrent('ConfigValidationError', () => {
    test('should be an instance of ConfigValidationError, IsambardError, and Error', () => {
        const error = new ConfigValidationError('Config validation failed', [{ path: 'app.port', message: 'Invalid number' }]);
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ConfigValidationError('Config validation failed', []);
        expect(error.name).toBe('ConfigValidationError');
    });

    test('should have correct error code', () => {
        const error = new ConfigValidationError('Config validation failed', []);
        expect(error.code).toBe(ErrorCode.CONFIG_VALIDATION_ERROR);
    });

    test('should format message as prefix + JSON', () => {
        const validationErrors = [{ path: 'app.port', message: 'Expected number' }];
        const error = new ConfigValidationError('Config validation failed', validationErrors);
        expect(error.message).toBe(`Config validation failed: ${JSON.stringify(validationErrors)}`);
    });

    test('should store validation errors in context', () => {
        const validationErrors = [{ path: 'discord.botToken', message: '[REDACTED]' }];
        const error = new ConfigValidationError('Config validation failed', validationErrors);
        expect(error.context.validationErrors).toEqual(validationErrors);
    });

    test('should handle empty validation errors array', () => {
        const error = new ConfigValidationError('Config validation failed', []);
        expect(error.context.validationErrors).toEqual([]);
        expect(error.message).toBe('Config validation failed: []');
    });

    test('should handle multiple validation errors', () => {
        const validationErrors = [
            { path: 'app.port',        message: 'Expected number' },
            { path: 'discord.botToken', message: '[REDACTED]' },
        ];
        const error = new ConfigValidationError('Config validation failed', validationErrors);
        expect(error.context.validationErrors).toHaveLength(2);
        expect(error.context.validationErrors[0]?.path).toBe('app.port');
        expect(error.context.validationErrors[1]?.path).toBe('discord.botToken');
    });

    test('should work with DynamoDB config prefix', () => {
        const error = new ConfigValidationError('DynamoDB config validation failed', [{ path: 'tableName', message: 'Required' }]);
        expect(error.message).toContain('DynamoDB config validation failed');
        expect(error.code).toBe(ErrorCode.CONFIG_VALIDATION_ERROR);
    });

    test('should preserve stack trace', () => {
        const error = new ConfigValidationError('Config validation failed', []);
        expect(error.stack).toBeDefined();
    });
});
