/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import _ from 'lodash';
import { createTaskPersistenceCoordinator } from '@/agent/task-persistence-coordinator';
import type { TaskSessionBackend } from '@/storage/task-session/backend';
import { createSessionId } from '@/storage/task-session/types';
import type { TaskDirectoryCopier } from '@/agent/task-directory-copier';
import type { Logger } from '@hughescr/logger';

describe('TaskPersistenceCoordinator', () => {
    let mockBackend: TaskSessionBackend;
    let mockCopier: TaskDirectoryCopier;
    let mockLogger: Logger;

    beforeEach(() => {
        mockBackend = {
            getCurrentSessionId:   mock(() => Promise.resolve(undefined)),
            setCurrentSessionId:   mock(() => Promise.resolve()),
            clearCurrentSessionId: mock(() => Promise.resolve()),
        } as unknown as TaskSessionBackend;

        mockCopier = {
            copyTaskDirectory: mock(() => Promise.resolve(false)),
        };

        mockLogger = {
            debug: mock(_.noop),
            info:  mock(_.noop),
            warn:  mock(_.noop),
            error: mock(_.noop),
        } as unknown as Logger;
    });

    describe('prepareNewSession', () => {
        it('should return false when no previous session exists', async () => {
            // Setup: No previous session
            mockBackend.getCurrentSessionId = mock(() => Promise.resolve(undefined));

            const coordinator = createTaskPersistenceCoordinator({
                backend: mockBackend,
                copier:  mockCopier,
                logger:  mockLogger,
            });

            const newSessionId = '11111111-1111-4111-8111-111111111111';
            const result = await coordinator.prepareNewSession(newSessionId);

            // Should return false (no tasks copied)
            expect(result).toBe(false);

            // Should check for previous session
            expect(mockBackend.getCurrentSessionId).toHaveBeenCalledTimes(1);

            // Should NOT copy tasks
            expect(mockCopier.copyTaskDirectory).not.toHaveBeenCalled();

            // Should store new session ID
            expect(mockBackend.setCurrentSessionId).toHaveBeenCalledTimes(1);
            expect(mockBackend.setCurrentSessionId).toHaveBeenCalledWith(
                createSessionId(newSessionId)
            );

            // Should log debug message about starting fresh
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    newSessionId,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg: expect.stringContaining('No previous session'),
                })
            );
        });

        it('should return true when previous session exists and copy succeeds', async () => {
            // Setup: Previous session exists
            const previousSessionId = createSessionId('00000000-0000-0000-0000-000000000000');
            mockBackend.getCurrentSessionId = mock(() => Promise.resolve(previousSessionId));
            mockCopier.copyTaskDirectory = mock(() => Promise.resolve(true));

            const coordinator = createTaskPersistenceCoordinator({
                backend: mockBackend,
                copier:  mockCopier,
                logger:  mockLogger,
            });

            const newSessionId = '11111111-1111-4111-8111-111111111111';
            const result = await coordinator.prepareNewSession(newSessionId);

            // Should return true (tasks copied)
            expect(result).toBe(true);

            // Should check for previous session
            expect(mockBackend.getCurrentSessionId).toHaveBeenCalledTimes(1);

            // Should copy tasks
            expect(mockCopier.copyTaskDirectory).toHaveBeenCalledTimes(1);
            expect(mockCopier.copyTaskDirectory).toHaveBeenCalledWith(
                previousSessionId,
                createSessionId(newSessionId)
            );

            // Should store new session ID
            expect(mockBackend.setCurrentSessionId).toHaveBeenCalledTimes(1);
            expect(mockBackend.setCurrentSessionId).toHaveBeenCalledWith(
                createSessionId(newSessionId)
            );

            // Should log info message about success
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    previousSessionId,
                    newSessionId,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg: expect.stringContaining('Task persistence complete'),
                })
            );
        });

        it('should return false when previous session exists but copy fails (no source dir)', async () => {
            // Setup: Previous session exists but no task directory to copy
            const previousSessionId = createSessionId('00000000-0000-0000-0000-000000000000');
            mockBackend.getCurrentSessionId = mock(() => Promise.resolve(previousSessionId));
            mockCopier.copyTaskDirectory = mock(() => Promise.resolve(false));

            const coordinator = createTaskPersistenceCoordinator({
                backend: mockBackend,
                copier:  mockCopier,
                logger:  mockLogger,
            });

            const newSessionId = '11111111-1111-4111-8111-111111111111';
            const result = await coordinator.prepareNewSession(newSessionId);

            // Should return false (no tasks copied)
            expect(result).toBe(false);

            // Should check for previous session
            expect(mockBackend.getCurrentSessionId).toHaveBeenCalledTimes(1);

            // Should attempt to copy tasks
            expect(mockCopier.copyTaskDirectory).toHaveBeenCalledTimes(1);

            // Should still store new session ID
            expect(mockBackend.setCurrentSessionId).toHaveBeenCalledTimes(1);
            expect(mockBackend.setCurrentSessionId).toHaveBeenCalledWith(
                createSessionId(newSessionId)
            );

            // Should log debug message (not info)
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    previousSessionId,
                    newSessionId,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg: expect.stringContaining('no tasks to copy'),
                })
            );
        });

        it('should return false and log warning when backend.getCurrentSessionId throws', async () => {
            // Setup: Backend throws error
            const testError = new Error('DynamoDB connection failed');
            mockBackend.getCurrentSessionId = mock(() => Promise.reject(testError));

            const coordinator = createTaskPersistenceCoordinator({
                backend: mockBackend,
                copier:  mockCopier,
                logger:  mockLogger,
            });

            const newSessionId = '11111111-1111-4111-8111-111111111111';
            const result = await coordinator.prepareNewSession(newSessionId);

            // Should return false (task persistence failed)
            expect(result).toBe(false);

            // Should log warning with error message
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    newSessionId,
                    error: testError.message,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:   expect.stringContaining('Task persistence failed'),
                })
            );

            // Should NOT throw
            // (test passes if we reach here without exception)
        });

        it('should return false and log warning when backend.setCurrentSessionId throws', async () => {
            // Setup: setCurrentSessionId throws
            const previousSessionId = createSessionId('00000000-0000-0000-0000-000000000000');
            mockBackend.getCurrentSessionId = mock(() => Promise.resolve(previousSessionId));
            mockCopier.copyTaskDirectory = mock(() => Promise.resolve(true));
            const testError = new Error('DynamoDB write failed');
            mockBackend.setCurrentSessionId = mock(() => Promise.reject(testError));

            const coordinator = createTaskPersistenceCoordinator({
                backend: mockBackend,
                copier:  mockCopier,
                logger:  mockLogger,
            });

            const newSessionId = '11111111-1111-4111-8111-111111111111';
            const result = await coordinator.prepareNewSession(newSessionId);

            // Should return false
            expect(result).toBe(false);

            // Should log warning
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    newSessionId,
                    error: testError.message,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:   expect.stringContaining('Task persistence failed'),
                })
            );
        });

        it('should return false and log warning when copier.copyTaskDirectory throws', async () => {
            // Setup: Copier throws error
            const previousSessionId = createSessionId('00000000-0000-0000-0000-000000000000');
            mockBackend.getCurrentSessionId = mock(() => Promise.resolve(previousSessionId));
            const testError = new Error('Filesystem error');
            mockCopier.copyTaskDirectory = mock(() => Promise.reject(testError));

            const coordinator = createTaskPersistenceCoordinator({
                backend: mockBackend,
                copier:  mockCopier,
                logger:  mockLogger,
            });

            const newSessionId = '11111111-1111-4111-8111-111111111111';
            const result = await coordinator.prepareNewSession(newSessionId);

            // Should return false
            expect(result).toBe(false);

            // Should log warning
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    newSessionId,
                    error: testError.message,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:   expect.stringContaining('Task persistence failed'),
                })
            );
        });

        it('should return false and log warning when session ID is invalid (not UUID)', async () => {
            const coordinator = createTaskPersistenceCoordinator({
                backend: mockBackend,
                copier:  mockCopier,
                logger:  mockLogger,
            });

            const invalidSessionId = 'not-a-uuid';
            const result = await coordinator.prepareNewSession(invalidSessionId);

            // Should return false
            expect(result).toBe(false);

            // Should log warning with validation error (Zod error message format)
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    newSessionId: invalidSessionId,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    error:        expect.stringContaining('Session ID must be a valid UUID'),
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:          expect.stringContaining('Task persistence failed'),
                })
            );
        });
    });
});
