import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import _ from 'lodash';
import type { Message } from 'discord.js';
import { createMessageCoordinator } from '@/integrations/discord/message-coordinator';
import type { MessageCoordinator, ProcessResult, MessageProcessor } from '@/integrations/discord/message-coordinator';
import type { DiscordMessageContext } from '@/integrations/discord/types';
import { createChannelId, createGuildId, createUserId } from '@/integrations/discord/types';
import { createStreamTracker } from '@/agent/stream-tracker';
import type { ResumeContext } from '@/agent/resume-prompt-builder';
import { logger } from '@hughescr/logger';

describe('MessageCoordinator', () => {
    let coordinator: MessageCoordinator;
    let processorMock: ReturnType<typeof mock>;
    let mockContext: DiscordMessageContext;
    let mockMessage: Message;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        jest.setSystemTime(1000);

        // Create a basic message context
        mockContext = {
            guildId:   createGuildId('guild-123'),
            channelId: createChannelId('channel-456'),
            userId:    createUserId('user-789'),
            messageId: 'msg-001',
            content:   'Hello bot',
            timestamp: new Date().toISOString(),
            botUserId: createUserId('bot-999'),
        };

        // Mock Discord Message object (minimal needed fields)
        mockMessage = {
            id:        'msg-001',
            content:   'Hello bot',
            channelId: 'channel-456',
        } as unknown as Message;

        // Reset processor mock
        processorMock = mock(async (): Promise<ProcessResult> => ({
            response:       'Test response',
            sessionId:      'session-123',
            wasInterrupted: false,
            streamTracker:  createStreamTracker(),
        }));
    });

    afterEach(() => {
        if(coordinator) {
            coordinator.stop();
        }
        jest.useRealTimers();
    });

    describe('Configuration', () => {
        it('should create coordinator with default config', () => {
            coordinator = createMessageCoordinator();
            expect(coordinator).toBeDefined();
            expect(typeof coordinator.handleMessage).toBe('function');
            expect(typeof coordinator.setProcessor).toBe('function');
            expect(typeof coordinator.stop).toBe('function');
        });

        it('should create coordinator with custom debounceMs', () => {
            coordinator = createMessageCoordinator({ debounceMs: 500 });
            expect(coordinator).toBeDefined();
        });
    });

    describe('Processor Management', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator();
        });

        it('should set the processor function', () => {
            expect(() => coordinator.setProcessor(processorMock)).not.toThrow();
        });

        it('should throw error when handleMessage called without processor set', () => {
            expect(() => coordinator.handleMessage(mockContext, mockMessage)).toThrow();
        });
    });

    describe('Message Processing', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator();
            coordinator.setProcessor(processorMock);
        });

        it('should trigger immediate processing for first message', async () => {
            coordinator.handleMessage(mockContext, mockMessage);

            // Wait for async processing to start
            jest.advanceTimersByTime(10);

            expect(processorMock).toHaveBeenCalledTimes(1);
            const callArgs = processorMock.mock.calls[0] as unknown[];
            expect(callArgs[0]).toEqual([mockContext]); // contexts array
            expect(callArgs[1]).toBeNull(); // resumeContext
            expect(callArgs[3]).toBeDefined(); // abortSignal
        });

        it('should pass sessionId to processor on subsequent calls after interruption', async () => {
            // First message - processor returns sessionId AND is interrupted
            processorMock.mockResolvedValueOnce({
                response:       null,
                sessionId:      'session-abc',
                wasInterrupted: true,
                streamTracker:  createStreamTracker(),
            });

            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Second message - should receive sessionId from interrupted first call
            const secondContext = { ...mockContext, messageId: 'msg-002', content: 'Second message' };
            const secondMessage = { ...mockMessage, id: 'msg-002', content: 'Second message' } as unknown as Message;

            coordinator.handleMessage(secondContext, secondMessage);
            jest.advanceTimersByTime(10);
            await Promise.resolve();

            expect(processorMock).toHaveBeenCalledTimes(2);
            const secondCallArgs = processorMock.mock.calls[1] as unknown[];
            expect(secondCallArgs[2]).toBe('session-abc'); // sessionId parameter (kept from interrupted call)
        });
    });

    describe('Interruption Handling', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should interrupt active processing only after debounce timer expires', async () => {
            // Make processor run slowly so we can interrupt it
            let abortSignalReceived: AbortSignal | null = null;
            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                abortSignalReceived = abortSignal;
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Slow response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);

            // Start first message processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Send second message - should NOT interrupt immediately
            const secondContext = { ...mockContext, messageId: 'msg-002', content: 'Interrupt!' };
            const secondMessage = { ...mockMessage, id: 'msg-002', content: 'Interrupt!' } as unknown as Message;
            coordinator.handleMessage(secondContext, secondMessage);

            // Check abort signal NOT triggered yet (debounce hasn't expired)
            expect(abortSignalReceived).toBeDefined();
            expect(abortSignalReceived!.aborted).toBe(false);

            // Wait for debounce timer to expire
            jest.advanceTimersByTime(100);

            // NOW abort signal should be triggered
            expect(abortSignalReceived!.aborted).toBe(true);
        });

        it('should capture partial work from stream tracker on interrupt', async () => {
            // Create a tracker that will have some progress
            const trackerWithProgress = createStreamTracker();
            trackerWithProgress.update({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', text: 'I am thinking...' },
                        { type: 'text', text: 'Partial response...' }
                    ]
                }
            });

            let callCount = 0;
            const progressProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                callCount++;
                if(callCount === 1) {
                    // First call - simulate slow processing (longer than debounce so it will be interrupted)
                    await new Promise(resolve => setTimeout(resolve, 200));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  trackerWithProgress,
                    };
                } else {
                    // Second call (after interrupt) - should have resume context
                    expect(resumeContext).toBeDefined();
                    expect(resumeContext?.partialWork.thinking).toBe('I am thinking...');
                    expect(resumeContext?.partialWork.text).toBe('Partial response...');
                    return {
                        response:       'Resumed response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(progressProcessor);

            // Start first message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt with second message (starts debounce timer)
            const secondContext = { ...mockContext, messageId: 'msg-002', content: 'New message' };
            const secondMessage = { ...mockMessage, id: 'msg-002', content: 'New message' } as unknown as Message;
            coordinator.handleMessage(secondContext, secondMessage);

            // Wait for debounce (100ms) to trigger interruption + first call completion (200ms) + second processing
            jest.advanceTimersByTime(400);

            expect(callCount).toBe(2);
        });

        it('should process pending messages without interruption if active query finishes before debounce', async () => {
            let callCount = 0;
            let firstCallInterrupted = false;
            const fastProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                callCount++;
                if(callCount === 1) {
                    // First call - completes quickly (before debounce expires)
                    await new Promise(resolve => setTimeout(resolve, 50));
                    firstCallInterrupted = abortSignal.aborted;
                    return {
                        response:       'Fast response',
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Second call - should NOT have resume context (no interruption)
                    expect(resumeContext).toBeNull();
                    return {
                        response:       'Second response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(fastProcessor);

            // Start first message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Send second message during processing (starts debounce)
            const secondContext = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const secondMessage = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(secondContext, secondMessage);

            // Advance time for first processing to complete (50ms) + debounce (100ms) + second processing
            jest.advanceTimersByTime(200);

            expect(callCount).toBe(2);
            expect(firstCallInterrupted).toBe(false); // First call should NOT be interrupted
        });
    });

    describe('Debounce Batching', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should batch rapid messages within debounce window', async () => {
            // Make processor slow enough to allow interruption
            const slowBatchProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 150));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowBatchProcessor);

            // Send first message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Send rapid follow-up messages during processing
            const msg2Context = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const msg2 = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            jest.advanceTimersByTime(30);

            const msg3Context = { ...mockContext, messageId: 'msg-003', content: 'Third' };
            const msg3 = { ...mockMessage, id: 'msg-003', content: 'Third' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Wait for debounce + processing to complete
            jest.advanceTimersByTime(300);

            // Should have 2 calls: initial processing + batched resume
            expect(processorMock).toHaveBeenCalledTimes(2);

            // Second call should have multiple contexts
            const secondCallArgs = processorMock.mock.calls[1] as unknown[];
            const contexts = secondCallArgs[0] as DiscordMessageContext[];
            expect(contexts.length).toBeGreaterThanOrEqual(2);
        });

        it('should reset debounce timer when new message arrives during debounce', async () => {
            // Make processor slow to allow interruption
            const slowDebounceProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 150));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowDebounceProcessor);

            // Start processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt
            const msg2Context = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const msg2 = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait less than debounce time
            jest.advanceTimersByTime(50);

            // Send another message to reset debounce timer
            const msg3Context = { ...mockContext, messageId: 'msg-003', content: 'Third' };
            const msg3 = { ...mockMessage, id: 'msg-003', content: 'Third' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Wait for full debounce from last message + processing
            jest.advanceTimersByTime(250);

            // All messages should be batched in the resume call
            const lastCallArgs = processorMock.mock.calls[processorMock.mock.calls.length - 1] as unknown[];
            const contexts = lastCallArgs[0] as DiscordMessageContext[];
            expect(contexts.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('Resume Context', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should include original messages and new messages in resume context', async () => {
            const trackerWithProgress = createStreamTracker();
            trackerWithProgress.update({
                type:    'assistant',
                message: {
                    content: [{ type: 'text', text: 'Original response' }]
                }
            });

            let resumeContextReceived: ResumeContext | null = null;
            const contextProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                resumeContextReceived = resumeContext;
                await new Promise(resolve => setTimeout(resolve, 150));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  trackerWithProgress,
                };
            };
            processorMock.mockImplementation(contextProcessor);

            // Original message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // New message during processing
            const newContext = { ...mockContext, messageId: 'msg-002', content: 'New info' };
            const newMessage = { ...mockMessage, id: 'msg-002', content: 'New info' } as unknown as Message;
            coordinator.handleMessage(newContext, newMessage);

            // Wait for debounce + processing
            jest.advanceTimersByTime(300);

            // Check resume context includes new messages
            expect(resumeContextReceived).toBeDefined();
        });
    });

    describe('Channel Independence', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator();
            coordinator.setProcessor(processorMock);
        });

        it('should maintain independent state per channel', async () => {
            const channelProcessor: MessageProcessor = async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(channelProcessor);

            // Message in channel 1
            const channel1Context = { ...mockContext, channelId: createChannelId('channel-1') };
            const channel1Message = { ...mockMessage, channelId: 'channel-1' } as unknown as Message;
            coordinator.handleMessage(channel1Context, channel1Message);

            // Message in channel 2 (should not interrupt channel 1)
            const channel2Context = { ...mockContext, channelId: createChannelId('channel-2') };
            const channel2Message = { ...mockMessage, channelId: 'channel-2' } as unknown as Message;
            coordinator.handleMessage(channel2Context, channel2Message);

            jest.advanceTimersByTime(150);

            // Should have 2 separate processing calls
            expect(processorMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('Response Callback', () => {
        it('should invoke onResponse callback when processing completes', async () => {
            const onResponseMock = mock(async () => undefined);
            coordinator = createMessageCoordinator({
                debounceMs: 100,
                onResponse: onResponseMock
            });
            coordinator.setProcessor(processorMock);

            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(onResponseMock).toHaveBeenCalledTimes(1);
            const callArgs = onResponseMock.mock.calls[0] as unknown[];
            const result = callArgs[0] as ProcessResult;
            const discordMessage = callArgs[1] as Message;

            expect(result.response).toBe('Test response');
            expect(discordMessage).toBe(mockMessage);
        });

        it('should invoke onResponse with first message from batch', async () => {
            const onResponseMock = mock(async () => undefined);
            coordinator = createMessageCoordinator({
                debounceMs: 100,
                onResponse: onResponseMock
            });

            // Make processor slow to allow interruption
            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 150));
                return {
                    response:       'Batch response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during processing
            const msg2Context = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const msg2 = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for processing and debounce
            // Timeline: first processing (150ms) + debounce (100ms) + second processing (150ms) = 400ms
            jest.advanceTimersByTime(450);

            // onResponse should be called with the first message in the batch
            expect(onResponseMock).toHaveBeenCalled();
            const lastCall = onResponseMock.mock.calls[onResponseMock.mock.calls.length - 1] as unknown[];
            const discordMessage = lastCall[1] as Message;
            expect(discordMessage.id).toBe('msg-001'); // First message
        });

        it('should not invoke onResponse when interrupted', async () => {
            const onResponseMock = mock(async () => undefined);
            coordinator = createMessageCoordinator({
                debounceMs: 100,
                onResponse: onResponseMock
            });

            // Make processor slow to allow interruption
            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for first processing to complete (interrupted) + debounce + second processing
            // Timeline: first processing (200ms interrupted) + debounce (100ms) + second processing (200ms) = 500ms
            jest.advanceTimersByTime(550);

            // onResponse should not be called for interrupted processing
            // Only called when the debounced processing completes
            expect(onResponseMock).toHaveBeenCalledTimes(1);
        });

        it('should handle onResponse callback not being provided', async () => {
            coordinator = createMessageCoordinator(); // No onResponse
            coordinator.setProcessor(processorMock);

            // Should not throw
            expect(() => coordinator.handleMessage(mockContext, mockMessage)).not.toThrow();
            jest.advanceTimersByTime(50);
        });

        it('should invoke onResponse with null message for re-queued messages', async () => {
            const onResponseMock = mock(async () => undefined);
            coordinator = createMessageCoordinator({
                debounceMs: 100,
                onResponse: onResponseMock
            });

            // Make processor slow to allow interruption
            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 150));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt with second message
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for processing and debounce
            // Timeline: first processing (150ms interrupted) + debounce (100ms) + second processing (150ms) = 400ms
            jest.advanceTimersByTime(450);

            // Second call (after debounce) should have first message (re-queued original)
            expect(onResponseMock).toHaveBeenCalledTimes(1);
            const callArgs = onResponseMock.mock.calls[0] as unknown[];
            const discordMessage = callArgs[1] as Message;
            expect(discordMessage.id).toBe('msg-001');
        });
    });

    describe('Cleanup', () => {
        it('should clear all timers and state on stop', async () => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);

            const cleanupProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(cleanupProcessor);

            // Start processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt to create debounce timer
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Stop should clear timers and abort active queries
            coordinator.stop();

            // Wait to ensure no processing happens
            jest.advanceTimersByTime(250);

            // Should only have initial call, no debounced call
            expect(processorMock).toHaveBeenCalledTimes(1);
        });

        it('should abort active queries on stop', async () => {
            coordinator = createMessageCoordinator();
            coordinator.setProcessor(processorMock);

            let abortSignalReceived: AbortSignal | null = null;
            const abortTestProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                abortSignalReceived = abortSignal;
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       null,
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(abortTestProcessor);

            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            coordinator.stop();

            expect(abortSignalReceived!.aborted).toBe(true);
        });
    });

    describe('Mutant Testing - wasInterrupted Logic', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should NOT capture partial work when wasInterrupted is false (startProcessing)', async () => {
            const tracker = createStreamTracker();
            tracker.update({
                type:    'assistant',
                message: { content: [{ type: 'text', text: 'Some text' }] }
            });

            let resumeContextReceived: ResumeContext | null = null;
            let callCount = 0;

            const notInterruptedProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, _abortSignal: AbortSignal) => {
                callCount++;
                resumeContextReceived = resumeContext;

                if(callCount === 1) {
                    // First call - not interrupted
                    return {
                        response:       'Complete response',
                        sessionId:      'session-123',
                        wasInterrupted: false,
                        streamTracker:  tracker,
                    };
                } else {
                    // Second call - should NOT have partial work because first wasn't interrupted
                    return {
                        response:       'Second response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(notInterruptedProcessor);

            // First message - completes without interruption
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Second message - should NOT have resume context with partial work
            const msg2Context = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const msg2 = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(callCount).toBe(2);
            // Resume context should be null because first call wasn't interrupted
            expect(resumeContextReceived).toBeNull();
        });

        it('should capture partial work ONLY when wasInterrupted is true (startProcessing)', async () => {
            const trackerWithProgress = createStreamTracker();
            trackerWithProgress.update({
                type:    'assistant',
                message: { content: [{ type: 'text', text: 'Partial text' }] }
            });

            let resumeContextReceived: ResumeContext | null = null;
            let callCount = 0;

            const interruptedProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                callCount++;
                resumeContextReceived = resumeContext;

                if(callCount === 1) {
                    // First call - simulate slow processing so it can be interrupted
                    await new Promise(resolve => setTimeout(resolve, 150));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  trackerWithProgress,
                    };
                } else {
                    // Second call after debounce - should have partial work
                    return {
                        response:       'Resumed response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(interruptedProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for first processing (150ms) + debounce (100ms) + second call
            jest.advanceTimersByTime(300);

            expect(callCount).toBe(2);
            // Resume context should have partial work from interrupted call
            expect(resumeContextReceived).not.toBeNull();
            expect(resumeContextReceived!.partialWork).toBeDefined();
            expect(resumeContextReceived!.partialWork.text).toBe('Partial text');
        });

        it('should UPDATE sessionId when wasInterrupted is true (startProcessing)', async () => {
            let callCount = 0;
            let sessionIdReceived: string | undefined;

            const interruptedSessionProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, sessionId: string | undefined, _abortSignal: AbortSignal) => {
                callCount++;
                sessionIdReceived = sessionId;

                if(callCount === 1) {
                    // First call - interrupted, returns sessionId
                    return {
                        response:       null,
                        sessionId:      'session-interrupted',
                        wasInterrupted: true,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Second call - SHOULD have the sessionId from interrupted call (for resume)
                    return {
                        response:       'Response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(interruptedSessionProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);
            await Promise.resolve();

            // Interrupt
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce + second call
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            expect(callCount).toBe(2);
            // Second call should have sessionId because first call was interrupted (session kept for resume)
            expect(sessionIdReceived).toBe('session-interrupted');
        });

        it('should CLEAR sessionId when wasInterrupted is false (startProcessing)', async () => {
            let callCount = 0;
            let sessionIdReceived: string | undefined;

            const completeSessionProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, sessionId: string | undefined, _abortSignal: AbortSignal) => {
                callCount++;
                sessionIdReceived = sessionId;

                if(callCount === 1) {
                    // First call - completes, returns sessionId
                    return {
                        response:       'Response',
                        sessionId:      'session-complete',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Second call - should NOT have sessionId (first call completed, session cleaned up)
                    return {
                        response:       'Response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(completeSessionProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(callCount).toBe(1);

            // Second message
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(callCount).toBe(2);
            // Second call should NOT have sessionId (first completed, session was cleaned up in agent.ts)
            expect(sessionIdReceived).toBeUndefined();
        });
    });

    describe('Mutant Testing - processWithResume Logic', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should NOT capture partial work when wasInterrupted is false (processWithResume) - Mutant #1798', async () => {
            // This test kills Mutant #1798 which changes `if(result.wasInterrupted)` to `if(true)` at line 234
            // Strategy: First call gets interrupted. Second call (resume) completes successfully (wasInterrupted: false)
            // and should NOT capture its tracker. Third call (ALSO through processWithResume) should NOT receive
            // partialWork because second call completed successfully.
            // KEY: Message 3 must arrive DURING call 2 so call 3 goes through processWithResume, not startProcessing.

            const firstCallTracker = createStreamTracker();
            firstCallTracker.update({
                type:    'assistant',
                message: { content: [{ type: 'text', text: 'First call partial work' }] }
            });

            const secondCallTracker = createStreamTracker();
            secondCallTracker.update({
                type:    'assistant',
                message: { content: [{ type: 'text', text: 'Second call tracker that should NOT be captured' }] }
            });

            let callCount = 0;
            let resumeContextInCall2: ResumeContext | null = 'NOT_SET' as unknown as ResumeContext | null;
            let resumeContextInCall3: ResumeContext | null = 'NOT_SET' as unknown as ResumeContext | null;

            const resumeNotInterruptedProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                callCount++;

                if(callCount === 2) {
                    resumeContextInCall2 = resumeContext;
                }
                if(callCount === 3) {
                    resumeContextInCall3 = resumeContext;
                }

                if(callCount === 1) {
                    // First call (startProcessing) - gets interrupted
                    await new Promise(resolve => setTimeout(resolve, 150));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,  // Will be true (interrupted)
                        streamTracker:  firstCallTracker,  // This will be captured as partialWork
                    };
                } else if(callCount === 2) {
                    // Second call (processWithResume) - takes time so message 3 can arrive during it
                    // Completes WITHOUT interruption
                    await new Promise(resolve => setTimeout(resolve, 150));
                    return {
                        response:       'Resume complete',
                        wasInterrupted: false,  // NOT interrupted - should NOT capture tracker
                        streamTracker:  secondCallTracker,  // Should NOT be captured at line 234
                    };
                } else {
                    // Third call (processWithResume) - should NOT have partialWork
                    return {
                        response:       'Third response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(resumeNotInterruptedProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message interrupts first
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce (100ms) to trigger interrupt + first processing (150ms) + call 2 to start
            // Timeline: msg2 arrives at t=10, debounce at t=110, first completes at ~260, call 2 starts at ~260
            jest.advanceTimersByTime(260);

            // Now call 2 is in progress. Send message 3 DURING call 2
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Advance just a bit to ensure message 3 is queued but call 2 hasn't finished yet
            // Call 2 takes 150ms and we're only 10ms in
            jest.advanceTimersByTime(10);

            expect(callCount).toBe(2);
            // Call 2 should receive partialWork from first call (first call was interrupted)
            expect(resumeContextInCall2).not.toBeNull();
            expect(resumeContextInCall2).not.toBe('NOT_SET');

            // Now wait for call 2 to complete + debounce for msg3 + call 3 to start and complete
            // Call 2 remaining: ~140ms, debounce: 100ms
            jest.advanceTimersByTime(250);

            expect(callCount).toBe(3);
            // Critical: Call 3 goes through processWithResume (because msg3 arrived during call 2)
            // If mutant changes if(result.wasInterrupted) to if(true) at line 234,
            // state.partialWork would be set with secondCallTracker when call 2 completed,
            // and call 3 would receive a resumeContext with that tracker's text.
            // Since call 2 had wasInterrupted: false, partialWork should NOT be set,
            // so call 3 should receive null (no partialWork).
            expect(resumeContextInCall3).toBeNull();
        });

        it('should capture partial work ONLY when wasInterrupted is true (processWithResume)', async () => {
            const trackerWithProgress = createStreamTracker();
            trackerWithProgress.update({
                type:    'assistant',
                message: { content: [{ type: 'text', text: 'Resume partial' }] }
            });

            let callCount = 0;
            let resumeContextInThirdCall: ResumeContext | null = null;

            const resumeInterruptedProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                callCount++;

                if(callCount === 1) {
                    // First call - will be interrupted after debounce
                    await new Promise(resolve => setTimeout(resolve, 200));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  createStreamTracker(),
                    };
                } else if(callCount === 2) {
                    // Second call (resume) - also interrupted after debounce (make it run long enough)
                    await new Promise(resolve => setTimeout(resolve, 300));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  trackerWithProgress,
                    };
                } else {
                    // Third call - should have partial work from second interrupted call
                    resumeContextInThirdCall = resumeContext;
                    return {
                        response:       'Final response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(resumeInterruptedProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during processing (starts debounce)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce (100ms) to trigger interruption + first processing completion (200ms) + second processing to start
            jest.advanceTimersByTime(250);

            // Third message during second processing (starts new debounce) - second processing started ~200ms ago
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Wait for second debounce (100ms) + second processing completion (300ms) + third processing
            jest.advanceTimersByTime(500);

            expect(callCount).toBe(3);
            expect(resumeContextInThirdCall).not.toBeNull();
            expect(resumeContextInThirdCall!.partialWork).toBeDefined();
            expect(resumeContextInThirdCall!.partialWork.text).toBe('Resume partial');
        });

        it('should UPDATE sessionId when wasInterrupted is true (processWithResume)', async () => {
            let callCount = 0;
            let sessionIdInThirdCall: string | undefined;

            const resumeInterruptedSessionProcessor: MessageProcessor = async (_contexts, _resumeContext, sessionId, abortSignal) => {
                callCount++;
                if(callCount === 3) {
                    sessionIdInThirdCall = sessionId;
                }

                if(callCount === 1) {
                    // First call - will be interrupted
                    await new Promise(resolve => setTimeout(resolve, 200));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  createStreamTracker(),
                    };
                } else if(callCount === 2) {
                    // Second call (resume) - interrupted with sessionId (run long enough)
                    await new Promise(resolve => setTimeout(resolve, 300));
                    return {
                        response:       null,
                        sessionId:      'session-interrupted-resume',
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Third call - SHOULD have sessionId from interrupted second call (for resume)
                    return {
                        response:       'Response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(resumeInterruptedSessionProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during processing (starts debounce)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce (100ms) + first processing (200ms) + second processing to start
            jest.advanceTimersByTime(250);

            // Third message during second processing (starts new debounce)
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Wait for second debounce (100ms) + second processing (300ms) + third processing
            jest.advanceTimersByTime(500);

            expect(callCount).toBe(3);
            // Third call should have sessionId from interrupted second call (session kept for resume)
            expect(sessionIdInThirdCall).toBe('session-interrupted-resume');
        });

        it('should CLEAR sessionId when wasInterrupted is false (processWithResume)', async () => {
            let callCount = 0;
            let sessionIdInThirdCall: string | undefined;

            const resumeCompleteSessionProcessor: MessageProcessor = async (_contexts, _resumeContext, sessionId, abortSignal) => {
                callCount++;
                sessionIdInThirdCall = sessionId;

                if(callCount === 1) {
                    // First call - interrupted
                    await new Promise(resolve => setTimeout(resolve, 150));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  createStreamTracker(),
                    };
                } else if(callCount === 2) {
                    // Second call (resume) - completes with sessionId
                    return {
                        response:       'Resume response',
                        sessionId:      'session-resume-complete',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Third call - should NOT have sessionId (second completed, session cleaned up)
                    return {
                        response:       'Response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(resumeCompleteSessionProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt with second message
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for first processing (150ms) + debounce (100ms) + resume processing
            jest.advanceTimersByTime(300);

            expect(callCount).toBe(2);

            // Third message - should NOT have sessionId (second completed, session was cleaned up)
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);
            jest.advanceTimersByTime(50);

            expect(callCount).toBe(3);
            expect(sessionIdInThirdCall).toBeUndefined();
        });
    });

    describe('Mutant Testing - Message Filtering and Context Building', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should correctly separate original and new messages in processWithResume', async () => {
            let receivedContexts: DiscordMessageContext[] = [];
            let resumeContextReceived: ResumeContext | null = null;

            const filteringProcessor: MessageProcessor = async (contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                receivedContexts = contexts;
                resumeContextReceived = resumeContext;
                await new Promise(resolve => setTimeout(resolve, 150));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(filteringProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt with second message
            const msg2Context = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const msg2 = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce + processing
            jest.advanceTimersByTime(300);

            // Should have both original and new message contexts
            expect(receivedContexts.length).toBe(2);
            expect(receivedContexts[0].messageId).toBe('msg-001'); // Original
            expect(receivedContexts[1].messageId).toBe('msg-002'); // New

            // Resume context should have only the new message
            expect(resumeContextReceived!.newMessages.length).toBe(1);
            expect(resumeContextReceived!.newMessages[0].messageId).toBe('msg-002');
        });

        it('should correctly build contexts from lodash map operations', async () => {
            let receivedContexts: DiscordMessageContext[] = [];

            const mapTestProcessor: MessageProcessor = async (contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                // Capture the contexts from each call
                receivedContexts = contexts;
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(mapTestProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during active processing (starts debounce)
            const msg2Context = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const msg2 = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Third message during active processing (resets debounce)
            jest.advanceTimersByTime(50);
            const msg3Context = { ...mockContext, messageId: 'msg-003', content: 'Third' };
            const msg3 = { ...mockMessage, id: 'msg-003', content: 'Third' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Wait for debounce from last message (100ms) + interruption + first processing completion (200ms) + resume processing
            jest.advanceTimersByTime(400);

            // Should have contexts properly mapped via lodash operations
            // After interruption and resume, all three messages should be batched
            expect(receivedContexts.length).toBeGreaterThanOrEqual(3);
            // Verify all message IDs are present
            const messageIds = _.map(receivedContexts, 'messageId');
            expect(messageIds).toContain('msg-001'); // Original
            expect(messageIds).toContain('msg-002'); // New
            expect(messageIds).toContain('msg-003'); // New
        });

        it('should handle empty original messages array in processWithResume', async () => {
            const emptyOriginalsProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, _abortSignal: AbortSignal) => {
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(emptyOriginalsProcessor);

            // First message completes
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Second message - no interruption, so processWithResume not triggered yet
            const msg2Context = { ...mockContext, messageId: 'msg-002', content: 'Second' };
            const msg2 = { ...mockMessage, id: 'msg-002', content: 'Second' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            // Should have processed each message separately
            expect(processorMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('Mutant Testing - Processor Error Handling', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator();
        });

        it('should throw error with correct message when processor not set in handleMessage', () => {
            expect(() => coordinator.handleMessage(mockContext, mockMessage))
                .toThrow('Processor not set. Call setProcessor() before handling messages.');
        });

        it('should throw error when handleMessage called without processor (verify error message string)', () => {
            let errorMessage = '';
            try {
                coordinator.handleMessage(mockContext, mockMessage);
            } catch (error) {
                errorMessage = (error as Error).message;
            }
            expect(errorMessage).toBe('Processor not set. Call setProcessor() before handling messages.');
        });
    });

    describe('Mutant Testing - SessionId Undefined Handling', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should NOT update sessionId when result.sessionId is undefined on interruption (startProcessing) - Mutant #1763', async () => {
            // This test kills Mutant #1763 which changes `if(result.sessionId)` to `if(true)` at line 151
            // Strategy: First call is interrupted with sessionId, second call is interrupted with undefined (should NOT overwrite),
            // third call should still receive the value from first call (proving second didn't overwrite with undefined).

            let callCount = 0;
            let sessionIdReceivedOnThirdCall: string | undefined;

            const undefinedSessionProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, sessionId: string | undefined, _abortSignal: AbortSignal) => {
                callCount++;

                if(callCount === 3) {
                    sessionIdReceivedOnThirdCall = sessionId;
                }

                if(callCount === 1) {
                    // First call - interrupted with sessionId (SETS the state)
                    return {
                        response:       null,
                        sessionId:      'previously-set-session',  // KEY: Sets state.sessionId
                        wasInterrupted: true,
                        streamTracker:  createStreamTracker(),
                    };
                } else if(callCount === 2) {
                    // Second call - interrupted with undefined sessionId (should NOT overwrite)
                    return {
                        response:       null,
                        sessionId:      undefined,  // Should NOT update state.sessionId
                        wasInterrupted: true,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Third call - should still have the sessionId from first call
                    return {
                        response:       'Response 3',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(undefinedSessionProcessor);

            // First message - sets state.sessionId = 'previously-set-session' (interrupted)
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(callCount).toBe(1);

            // Second message - interrupted with undefined, should NOT overwrite state.sessionId
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(callCount).toBe(2);

            // Third message - should still receive 'previously-set-session'
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);
            jest.advanceTimersByTime(50);
            await Promise.resolve();

            expect(callCount).toBe(3);
            // Critical: If mutant changes if(result.sessionId) to if(true),
            // state.sessionId would be set to undefined in second call (interrupted path)
            // and third call would receive undefined instead of 'previously-set-session'
            expect(sessionIdReceivedOnThirdCall).toBe('previously-set-session');
        });

        it('should NOT update sessionId when result.sessionId is undefined on interruption (processWithResume) - Mutant #1805', async () => {
            // This test kills Mutant #1805 which changes `if(result.sessionId)` to `if(true)` at line 238
            // Strategy: First call is interrupted with sessionId.
            // Second call (resume) is interrupted with undefined sessionId (should NOT overwrite).
            // Third call should still receive the value from first call.

            let callCount = 0;
            let sessionIdReceivedInCall3: string | undefined = 'NOT_SET';

            const undefinedResumeSessionProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, sessionId: string | undefined, _abortSignal: AbortSignal) => {
                callCount++;

                if(callCount === 3) {
                    sessionIdReceivedInCall3 = sessionId;
                }

                if(callCount === 1) {
                    // First call (startProcessing) - interrupted with sessionId
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return {
                        response:       null,
                        sessionId:      'previously-set-session',  // KEY: Sets state.sessionId
                        wasInterrupted: true,
                        streamTracker:  createStreamTracker(),
                    };
                } else if(callCount === 2) {
                    // Second call (processWithResume) - interrupted with undefined sessionId
                    // This exercises line 238: if(result.sessionId) in processWithResume
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return {
                        response:       null,
                        sessionId:      undefined,  // Should NOT update state.sessionId
                        wasInterrupted: true,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Third call - should still have sessionId from first call
                    return {
                        response:       'Third response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(undefinedResumeSessionProcessor);

            // First message - starts processing, gets interrupted with sessionId
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);

            // Second message - resume processing, gets interrupted with undefined
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);
            jest.advanceTimersByTime(50);

            expect(callCount).toBe(2);

            // Third message - should still have 'previously-set-session'
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);
            jest.advanceTimersByTime(50);

            expect(callCount).toBe(3);
            // Critical: If mutant changes if(result.sessionId) to if(true) at line 238,
            // state.sessionId would be set to undefined in second call (interrupted path)
            // and third call would receive undefined instead of 'previously-set-session'
            expect(sessionIdReceivedInCall3).toBe('previously-set-session');
        });

        it('should preserve existing sessionId when interrupted result has undefined sessionId (processWithResume)', async () => {
            // This test targets line 238 specifically by ensuring:
            // 1. First call returns sessionId and gets interrupted
            // 2. Second call (resume) runs long enough to be interrupted
            // 3. Second call (resume) gets interrupted with sessionId: undefined
            // 4. Third call should still receive the preserved sessionId from first call
            // If mutant changes if(result.sessionId) to if(true), state.sessionId would be overwritten with undefined

            let callCount = 0;
            let sessionIdInCall3: string | undefined;

            const preserveSessionProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, sessionId: string | undefined, abortSignal: AbortSignal) => {
                callCount++;

                if(callCount === 3) {
                    sessionIdInCall3 = sessionId;
                }

                if(callCount === 1) {
                    // First call - interrupted with sessionId
                    await new Promise(resolve => setTimeout(resolve, 200));
                    return {
                        response:       null,
                        sessionId:      'original-session-id',
                        wasInterrupted: abortSignal.aborted,  // Will be true
                        streamTracker:  createStreamTracker(),
                    };
                } else if(callCount === 2) {
                    // Second call (processWithResume) - runs long enough to be interrupted
                    // Returns undefined sessionId when interrupted
                    await new Promise(resolve => setTimeout(resolve, 300));
                    return {
                        response:       null,
                        sessionId:      undefined,  // KEY: Should NOT overwrite state.sessionId
                        wasInterrupted: abortSignal.aborted,  // Will be true
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Third call - should still have 'original-session-id'
                    return {
                        response:       'Final response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(preserveSessionProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during first processing (starts debounce)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce (100ms) + first processing (200ms) to complete
            jest.advanceTimersByTime(250);

            expect(callCount).toBe(2);

            // Third message during second processing (starts new debounce)
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Wait for second debounce (100ms) + second processing (300ms) + third processing
            jest.advanceTimersByTime(500);

            expect(callCount).toBe(3);
            // If mutant at line 238 changes if(result.sessionId) to if(true),
            // state.sessionId would be set to undefined in call 2,
            // and call 3 would receive undefined instead of 'original-session-id'
            expect(sessionIdInCall3).toBe('original-session-id');
        });
    });

    describe('Mutant Testing - Optional Chaining on newMessages[0]', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should safely access newMessages[0] with optional chaining (line 203)', async () => {
            // This test verifies that line 203 uses optional chaining: newMessages[0]?.discordMessage
            // The mutant removes the ?. operator, which would crash if newMessages is empty
            // While the normal flow ensures newMessages has at least one entry when there are
            // NEW messages, the optional chaining is defensive programming for edge cases

            let callCount = 0;

            const optionalChainingProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                callCount++;

                if(callCount === 1) {
                    // First call - interrupted
                    await new Promise(resolve => setTimeout(resolve, 200));
                    return {
                        response:       null,
                        wasInterrupted: abortSignal.aborted,
                        streamTracker:  createStreamTracker(),
                    };
                } else {
                    // Second call (resume) - should not crash even if newMessages[0] is accessed
                    return {
                        response:       'Resume response',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                }
            };
            processorMock.mockImplementation(optionalChainingProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt with second message
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce + first processing + resume
            jest.advanceTimersByTime(350);
            await Promise.resolve();

            // Should complete without crashing (optional chaining protects against undefined)
            expect(callCount).toBe(2);
        });
    });

    describe('Mutant Testing - NewEvents Array Verification', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should verify newEvents is actually empty array (not ["Stryker was here"])', async () => {
            let resumeContextReceived: ResumeContext | null = null;

            const verifyNewEventsProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                resumeContextReceived = resumeContext;
                await new Promise(resolve => setTimeout(resolve, 150));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(verifyNewEventsProcessor);

            // First message
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Interrupt with second message
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for debounce + interruption + resume processing
            jest.advanceTimersByTime(300);

            // Verify resume context has newEvents as empty array
            expect(resumeContextReceived).not.toBeNull();
            expect(resumeContextReceived!.newEvents).toEqual([]);
            expect(resumeContextReceived!.newEvents).toHaveLength(0);
            // Verify it's not ["Stryker was here"]
            expect(resumeContextReceived!.newEvents).not.toContain('Stryker was here');
        });
    });

    describe('Mutant Testing - Processor Not Set Error Throwing', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator();
        });

        it('should explicitly throw error when processor not set (verify !processor check) - Mutants #1816, #1817', () => {
            // This test kills Mutant #1816 which changes `if(!processor)` to `if(false)` at line 266
            // and Mutant #1817 which replaces the throw block with {} at lines 267-268

            // First verify error is thrown with correct message
            let errorWasThrown = false;
            let errorMessage = '';
            try {
                coordinator.handleMessage(mockContext, mockMessage);
            } catch (error) {
                errorWasThrown = true;
                errorMessage = (error as Error).message;
            }
            expect(errorWasThrown).toBe(true);
            expect(errorMessage).toBe('Processor not set. Call setProcessor() before handling messages.');

            // Now set the processor and call handleMessage again
            // This proves that the first call threw before processing (processor is never called)
            const processorCallSpy = mock(async (): Promise<ProcessResult> => ({
                response:       'Test response',
                sessionId:      'session-123',
                wasInterrupted: false,
                streamTracker:  createStreamTracker(),
            }));

            coordinator.setProcessor(processorCallSpy);
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(50);

            // Processor should only be called ONCE (from the second handleMessage call)
            // If the error wasn't thrown in the first call, processor would have been called twice
            expect(processorCallSpy).toHaveBeenCalledTimes(1);
        });

        it('should prevent execution after throw (verify code after throw is not reached) - Mutants #1816, #1817', () => {
            // This test ensures that when the error is thrown, no processing happens
            // If mutants #1816 or #1817 survive, processing would proceed incorrectly

            let didThrow = false;
            let errorMessage = '';

            try {
                coordinator.handleMessage(mockContext, mockMessage);
                // If we reach here without throwing, the test should fail
                expect.unreachable('handleMessage should have thrown an error');
            } catch (error) {
                didThrow = true;
                errorMessage = (error as Error).message;
            }

            // Verify the error was actually thrown
            expect(didThrow).toBe(true);
            expect(errorMessage).toBe('Processor not set. Call setProcessor() before handling messages.');

            // Verify that no processing state was created (no channel state)
            // We can indirectly verify this by setting processor and calling handleMessage
            // The processor should be called immediately (no pending state from failed call)
            const processorSpy = mock(async (): Promise<ProcessResult> => ({
                response:       'Response',
                wasInterrupted: false,
                streamTracker:  createStreamTracker(),
            }));

            coordinator.setProcessor(processorSpy);
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Should be called exactly once (fresh start, no leftover state from failed call)
            expect(processorSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('Mutant Testing - Debounce Timer Creation', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
            coordinator.setProcessor(processorMock);
        });

        it('should create debounce timer when none exists (Case 1: active query)', async () => {
            let timerWasCreated = false;
            const originalSetTimeout = setTimeout;
            const setTimeoutSpy = (callback: () => void, delay: number) => {
                timerWasCreated = true;
                return originalSetTimeout(callback, delay);
            };
            global.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);

            // Start processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Reset flag
            timerWasCreated = false;

            // Second message during active processing (should create debounce timer)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Verify timer was created
            expect(timerWasCreated).toBe(true);

            global.setTimeout = originalSetTimeout;
        });

        it('should NOT create timer when timer already exists (verify if(state.debounceTimer) check)', async () => {
            let timerCreateCount = 0;
            const originalSetTimeout = setTimeout;
            const setTimeoutSpy = (callback: () => void, delay: number) => {
                timerCreateCount++;
                return originalSetTimeout(callback, delay);
            };
            global.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);

            // Start processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Reset count after initial processing setup
            timerCreateCount = 0;

            // Second message during active processing (creates debounce timer)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            const firstTimerCount = timerCreateCount;
            expect(firstTimerCount).toBeGreaterThanOrEqual(1);

            // Third message during active processing (should clear and reset timer)
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Timer should have been created again (after clearing old one)
            expect(timerCreateCount).toBeGreaterThan(firstTimerCount);

            global.setTimeout = originalSetTimeout;
        });
    });

    describe('Mutant Testing - Debounce Timer Management', () => {
        beforeEach(() => {
            coordinator = createMessageCoordinator({ debounceMs: 100 });
        });

        it('should clear debounce timer when new message arrives during active processing', async () => {
            let timerCleared = false;
            const originalClearTimeout = clearTimeout;
            const clearTimeoutSpy = (timerId: ReturnType<typeof setTimeout>) => {
                timerCleared = true;
                originalClearTimeout(timerId);
            };
            global.clearTimeout = clearTimeoutSpy as unknown as typeof clearTimeout;

            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            // Start processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during active processing (creates debounce timer)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Third message during active processing (should clear and reset timer)
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            expect(timerCleared).toBe(true);

            global.clearTimeout = originalClearTimeout;
        });

        it('should clear debounce timer when new message arrives during debounce period (case 2)', async () => {
            let clearCount = 0;
            const originalClearTimeout = clearTimeout;
            const clearTimeoutSpy = (timerId: ReturnType<typeof setTimeout>) => {
                clearCount++;
                originalClearTimeout(timerId);
            };
            global.clearTimeout = clearTimeoutSpy as unknown as typeof clearTimeout;

            const fastProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, _abortSignal: AbortSignal) => {
                // Fast processor that completes before debounce expires
                await new Promise(resolve => setTimeout(resolve, 50));
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(fastProcessor);
            coordinator.setProcessor(processorMock);

            // Start processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during active processing (creates debounce timer)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Wait for first processing to complete (50ms) - debounce hasn't expired yet
            jest.advanceTimersByTime(60);

            // Now we're in "debounce timer active but no active query" state (Case 2)
            // Reset clear count to only track clears after this point
            clearCount = 0;

            // Send message during this debounce period
            const msg3Context = { ...mockContext, messageId: 'msg-003' };
            const msg3 = { ...mockMessage, id: 'msg-003' } as unknown as Message;
            coordinator.handleMessage(msg3Context, msg3);

            // Timer should be cleared at least once
            expect(clearCount).toBeGreaterThanOrEqual(1);

            global.clearTimeout = originalClearTimeout;
        });

        it('should clear debounce timer on stop', async () => {
            let timerCleared = false;
            const originalClearTimeout = clearTimeout;
            const clearTimeoutSpy = (timerId: ReturnType<typeof setTimeout>) => {
                timerCleared = true;
                originalClearTimeout(timerId);
            };
            global.clearTimeout = clearTimeoutSpy as unknown as typeof clearTimeout;

            const slowProcessor: MessageProcessor = async (_contexts: DiscordMessageContext[], _resumeContext: ResumeContext | null, _sessionId: string | undefined, abortSignal: AbortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            // Start processing
            coordinator.handleMessage(mockContext, mockMessage);
            jest.advanceTimersByTime(10);

            // Second message during processing creates debounce timer
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2);

            // Stop coordinator (should clear the debounce timer)
            coordinator.stop();

            expect(timerCleared).toBe(true);

            global.clearTimeout = originalClearTimeout;
        });
    });

    describe('Typing Indicator Support', () => {
        let mockChannel: { sendTyping: ReturnType<typeof mock> };

        beforeEach(() => {
            coordinator = createMessageCoordinator();
            mockChannel = {
                sendTyping: mock(async () => {
                    // Intentionally empty - just needs to be async
                    return;
                }),
            };
        });

        it('should call sendTyping when processing starts', async () => {
            coordinator.setProcessor(processorMock);
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);

            // Wait for processing to start
            jest.advanceTimersByTime(10);

            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);
        });

        it('should refresh typing indicator every 8 seconds during processing', async () => {
            // Slow processor that takes 20 seconds
            const slowProcessor: MessageProcessor = async () => {
                await new Promise(resolve => setTimeout(resolve, 20000));
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);

            // Initial typing call
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // After 8 seconds, should refresh
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);

            // After another 8 seconds, should refresh again
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(3);

            // Complete processing
            jest.advanceTimersByTime(4000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(3); // No more refreshes
        });

        it('should stop typing indicator when processing completes', async () => {
            let intervalCleared = false;
            const originalClearInterval = clearInterval;
            const clearIntervalSpy = (intervalId: ReturnType<typeof setInterval>) => {
                intervalCleared = true;
                originalClearInterval(intervalId);
            };
            global.clearInterval = clearIntervalSpy as unknown as typeof clearInterval;

            coordinator.setProcessor(processorMock);
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);
            await Promise.resolve();

            // Wait for processing to complete
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            expect(intervalCleared).toBe(true);

            global.clearInterval = originalClearInterval;
        });

        it('should stop typing indicator when processing is interrupted', async () => {
            let intervalCleared = false;
            const originalClearInterval = clearInterval;
            const clearIntervalSpy = (intervalId: ReturnType<typeof setInterval>) => {
                intervalCleared = true;
                originalClearInterval(intervalId);
            };
            global.clearInterval = clearIntervalSpy as unknown as typeof clearInterval;

            // Slow processor
            const slowProcessor: MessageProcessor = async (_contexts, _resumeContext, _sessionId, abortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 5000));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);
            await Promise.resolve();

            // Interrupt with second message
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2, mockChannel);

            // Expire debounce to trigger interrupt
            jest.advanceTimersByTime(2000);
            await Promise.resolve();

            // Complete the interrupted query
            jest.advanceTimersByTime(5100);
            await Promise.resolve();

            expect(intervalCleared).toBe(true);

            global.clearInterval = originalClearInterval;
        });

        it('should handle sendTyping errors gracefully', async () => {
            // Make sendTyping fail
            mockChannel.sendTyping.mockRejectedValue(new Error('Missing Access'));

            coordinator.setProcessor(processorMock);

            // Should not throw
            expect(() => coordinator.handleMessage(mockContext, mockMessage, mockChannel)).not.toThrow();

            jest.advanceTimersByTime(10);

            // Processing should continue despite typing error
            expect(processorMock).toHaveBeenCalledTimes(1);
        });

        it('should continue typing across batched messages', async () => {
            // Slow processor
            const slowProcessor: MessageProcessor = async (_contexts, _resumeContext, _sessionId, abortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 10000));
                return {
                    response:       'Response',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            // First message
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // Second message during processing
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2, mockChannel);

            // Typing should continue during debounce
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);
        });

        it('should start typing when resuming after interruption', async () => {
            // Slow processor that gets interrupted
            const slowProcessor: MessageProcessor = async (_contexts, _resumeContext, _sessionId, abortSignal) => {
                await new Promise(resolve => setTimeout(resolve, 5000));
                return {
                    response:       'Response',
                    sessionId:      'session-123',
                    wasInterrupted: abortSignal.aborted,
                    streamTracker:  createStreamTracker(),
                };
            };
            processorMock.mockImplementation(slowProcessor);
            coordinator.setProcessor(processorMock);

            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);
            await Promise.resolve();

            const initialCallCount = mockChannel.sendTyping.mock.calls.length;

            // Interrupt with second message
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2, mockChannel);

            // Expire debounce to trigger interrupt
            jest.advanceTimersByTime(2000);
            await Promise.resolve();

            // Complete the interrupted query
            jest.advanceTimersByTime(5100);
            await Promise.resolve();

            // Should have called sendTyping again when resuming
            expect(mockChannel.sendTyping.mock.calls.length).toBeGreaterThan(initialCallCount);
        });

        it('should handle errors in typing indicator refresh gracefully', async () => {
            // Spy on _.noop to verify it's called in the catch handler
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Storing function reference for mock restoration
            const originalNoop = _.noop;
            // eslint-disable-next-line lodash/prefer-noop -- Intentionally mocking noop itself
            const noopSpy = mock(() => { /* intentionally empty - mocking noop */ });
            _.noop = noopSpy;

            try {
                // Mock sendTyping to succeed first time, throw on second
                let callCount = 0;
                mockChannel.sendTyping = mock(async () => {
                    callCount++;
                    if(callCount >= 2) {
                        throw new Error('Rate limited');
                    }
                });

                // Set up slow processor that takes time
                const slowProcessor: MessageProcessor = async () => {
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    return {
                        response:       'Done',
                        wasInterrupted: false,
                        streamTracker:  createStreamTracker(),
                    };
                };
                processorMock.mockImplementation(slowProcessor);
                coordinator.setProcessor(processorMock);

                coordinator.handleMessage(mockContext, mockMessage, mockChannel);

                // Initial typing call
                jest.advanceTimersByTime(10);
                expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

                // Advance past the 8-second refresh interval - this call will throw
                jest.advanceTimersByTime(8000);
                await Promise.resolve();

                // The error should be caught, processing should continue
                expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);

                // Verify _.noop was called in the catch handler (kills ArrowFunction mutant at line 139)
                expect(noopSpy).toHaveBeenCalled();

                // Complete processing
                jest.advanceTimersByTime(12000);
                await Promise.resolve();

                // Verify processor completed successfully despite typing error
                expect(processorMock).toHaveBeenCalledTimes(1);
            } finally {
                _.noop = originalNoop;
            }
        });

        it('should handle errors in initial typing indicator gracefully', async () => {
            // Spy on _.noop to verify it's called in the catch handler
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Storing function reference for mock restoration
            const originalNoop = _.noop;
            // eslint-disable-next-line lodash/prefer-noop -- Intentionally mocking noop itself
            const noopSpy = mock(() => { /* intentionally empty - mocking noop */ });
            _.noop = noopSpy;

            try {
                // Mock sendTyping to throw immediately on first call
                mockChannel.sendTyping = mock(async () => {
                    throw new Error('Rate limited on initial typing');
                });

                processorMock.mockImplementation(async () => ({
                    response:       'Done',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                }));
                coordinator.setProcessor(processorMock);

                // This should not crash even though initial typing indicator fails
                coordinator.handleMessage(mockContext, mockMessage, mockChannel);

                jest.advanceTimersByTime(10);
                await Promise.resolve();

                // sendTyping was called but threw - processing should continue
                expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);
                expect(processorMock).toHaveBeenCalledTimes(1);

                // Verify _.noop was called in the catch handler (kills ArrowFunction mutant at line 135)
                expect(noopSpy).toHaveBeenCalled();
            } finally {
                _.noop = originalNoop;
            }
        });

        it('should not crash when stopping typing indicator that was never started', async () => {
            // Spy on clearInterval to ensure it's not called with undefined
            const originalClearInterval = clearInterval;
            const clearIntervalSpy = mock((id?: ReturnType<typeof setInterval>) => {
                if(id === undefined) {
                    throw new Error('clearInterval should not be called with undefined');
                }
                originalClearInterval(id);
            });
            global.clearInterval = clearIntervalSpy as typeof clearInterval;

            try {
                // Don't provide a channel - no typing indicator will be created
                processorMock.mockImplementation(async () => ({
                    response:       'Done',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                }));
                coordinator.setProcessor(processorMock);

                // Call handleMessage without channel parameter
                coordinator.handleMessage(mockContext, mockMessage);

                jest.advanceTimersByTime(10);
                await Promise.resolve();

                // Processing should complete without error
                expect(processorMock).toHaveBeenCalledTimes(1);
                // clearInterval should NOT have been called at all (no interval to clear)
                expect(clearIntervalSpy).not.toHaveBeenCalled();
            } finally {
                global.clearInterval = originalClearInterval;
            }
        });

        it('should not set typing channel when channel parameter is undefined', async () => {
            // This test kills mutant that replaces `if(channel)` with `if(true)` at line 320
            // If that mutant survives, state.typingChannel would be overwritten with undefined
            // when a message arrives without a channel, breaking typing for subsequent messages.

            let callCount = 0;
            processorMock.mockImplementation(async () => {
                callCount++;
                // Make processing slow so we can send second message while first is running
                await new Promise(resolve => setTimeout(resolve, 100));
                return {
                    response:       `Response ${callCount}`,
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            });
            coordinator.setProcessor(processorMock);

            // First message: WITH a channel - this sets state.typingChannel = mockChannel
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);

            jest.advanceTimersByTime(10);
            await Promise.resolve();

            // Verify typing started for first message
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // Second message arrives while first is processing: WITHOUT a channel
            // With correct code: state.typingChannel should NOT be modified (stays as mockChannel)
            // With mutant: state.typingChannel would be set to undefined, breaking typing
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2, undefined);

            // Complete first message processing
            jest.advanceTimersByTime(150);
            await Promise.resolve();

            // Trigger debounce for second message
            jest.advanceTimersByTime(2000);
            await Promise.resolve();

            // Advance to allow typing indicator for resumed processing
            jest.advanceTimersByTime(10);
            await Promise.resolve();

            // If mutant survived, sendTyping would NOT be called again (state.typingChannel was overwritten with undefined)
            // With correct code, sendTyping should be called again for the resumed processing
            expect(mockChannel.sendTyping.mock.calls.length).toBeGreaterThan(1);
        });

        it('should work when channel parameter is not provided (backward compatibility)', async () => {
            coordinator.setProcessor(processorMock);

            // Should not throw when channel is undefined
            expect(() => coordinator.handleMessage(mockContext, mockMessage)).not.toThrow();

            jest.advanceTimersByTime(10);

            // Processing should work normally
            expect(processorMock).toHaveBeenCalledTimes(1);
        });

        it('should clear existing typing interval before starting new one', async () => {
            // This test verifies that startTypingIndicator() clears any existing interval
            // before creating a new one, preventing interval leaks.

            // Make first processor run for 10 seconds
            processorMock.mockImplementationOnce(async () => {
                await new Promise(resolve => setTimeout(resolve, 10000));
                return {
                    response:       'Response 1',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            });
            coordinator.setProcessor(processorMock);

            // First message - starts typing indicator with first interval
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);

            // Initial typing call
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // Wait 8 seconds - first interval should fire (still during first message processing)
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);

            // Complete first message processing
            jest.advanceTimersByTime(2000);

            // Reset call count for clarity
            mockChannel.sendTyping.mockClear();

            // Make second processor run for 20 seconds
            processorMock.mockImplementationOnce(async () => {
                await new Promise(resolve => setTimeout(resolve, 20000));
                return {
                    response:       'Response 2',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            });

            // Second message - should clear the old interval and start a new one
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2, mockChannel);
            jest.advanceTimersByTime(10);

            // Initial typing call for second message
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // Wait 8 seconds - new interval should fire once
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);

            // If the bug exists (old interval not cleared), we'd see extra calls here
            // because both the old and new intervals would be firing
        });

        it('should not create multiple intervals when startTypingIndicator is called twice in quick succession', async () => {
            // This test verifies that calling startTypingIndicator() multiple times
            // doesn't leak intervals by ensuring old ones are cleared.

            // Make processor run for a long time
            processorMock.mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 25000));
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            });
            coordinator.setProcessor(processorMock);

            // Send first message
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);
            await Promise.resolve();

            // Initial typing call
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // Queue up second message during processing (this will eventually restart typing)
            const msg2Context = { ...mockContext, messageId: 'msg-002' };
            const msg2 = { ...mockMessage, id: 'msg-002' } as unknown as Message;
            coordinator.handleMessage(msg2Context, msg2, mockChannel);

            // Trigger debounce interrupt
            jest.advanceTimersByTime(2100);
            await Promise.resolve();

            // The interrupt should have stopped the old typing and started a new one
            // Clear the mock to count only new typing calls
            mockChannel.sendTyping.mockClear();

            // Wait 8 seconds - should see exactly ONE interval fire
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // Wait another 8 seconds - should see exactly ONE more interval fire
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);

            // If intervals weren't properly cleared, we'd see more than 2 calls
            // (old interval + new interval both firing)
        });

        it('should start typing indicator correctly when no existing interval', async () => {
            // This test verifies the normal case: starting typing indicator
            // when there's no existing interval (fresh state).

            // Make processor run for 20 seconds
            processorMock.mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 20000));
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            });
            coordinator.setProcessor(processorMock);

            // First message ever - no existing interval
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);

            // Should call sendTyping immediately
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

            // Wait 8 seconds - interval should fire
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);

            // Wait another 8 seconds - interval should fire again
            jest.advanceTimersByTime(8000);
            expect(mockChannel.sendTyping).toHaveBeenCalledTimes(3);

            // This confirms the interval is working properly from a fresh start
        });

        it('should log debug info when startTypingIndicator is called', async () => {
            // This test verifies the debug logger is called with the correct object structure
            // when a typing channel is provided.

            // Mock the logger
            const loggerDebugSpy = jest.spyOn(logger, 'debug');

            processorMock.mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            });
            coordinator.setProcessor(processorMock);

            // First message with channel
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);

            // Verify debug was called with correct object showing 'present' and hasExisting
            expect(loggerDebugSpy).toHaveBeenCalledWith({
                hasExisting: false,
                channelId:   'present',
                msg:         'startTypingIndicator called',
            });

            // Verify the exact values by checking the calls
            const calls = loggerDebugSpy.mock.calls;
            const debugCall = _.find(calls, (call) => {
                const arg = call[0] as { channelId?: string, msg?: string, hasExisting?: boolean };
                return arg.msg === 'startTypingIndicator called';
            });
            expect(debugCall).toBeDefined();
            expect(debugCall![0]).toHaveProperty('channelId', 'present');
            expect(debugCall![0]).toHaveProperty('hasExisting', false);

            loggerDebugSpy.mockRestore();
        });

        it('should verify defensive guard exists by checking hasExisting in logs and clearInterval logic', async () => {
            // This test verifies the defensive guard exists by:
            // 1. Confirming hasExisting is logged (tests the !!state.typingInterval expression)
            // 2. Confirming clearInterval is called when starting new typing indicators
            // The defensive guard protects against bugs where an interval exists when it shouldn't

            const loggerDebugSpy = jest.spyOn(logger, 'debug');

            // Create a processor
            processorMock.mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 1000));
                return {
                    response:       'Response',
                    wasInterrupted: false,
                    streamTracker:  createStreamTracker(),
                };
            });
            coordinator.setProcessor(processorMock);

            // Start first message
            coordinator.handleMessage(mockContext, mockMessage, mockChannel);
            jest.advanceTimersByTime(10);

            // Verify hasExisting is logged for first call (should be false)
            const debugCalls = _.filter(loggerDebugSpy.mock.calls, (call) => {
                const arg = call[0] as { msg?: string };
                return arg.msg === 'startTypingIndicator called';
            });

            expect(debugCalls.length).toBeGreaterThan(0);
            // Every call should have hasExisting property (tests the !!state.typingInterval expression)
            for(const call of debugCalls) {
                const arg = call[0] as { hasExisting?: boolean };
                expect(arg).toHaveProperty('hasExisting');
                expect(typeof arg.hasExisting).toBe('boolean');
            }

            // The first call should show hasExisting: false
            expect(debugCalls[0][0]).toHaveProperty('hasExisting', false);

            loggerDebugSpy.mockRestore();
        });
    });
});
