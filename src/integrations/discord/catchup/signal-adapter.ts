import { logger } from '@hughescr/logger';
import type { CatchUpCompletionSignal, CatchUpInProgressSignal } from './session-runner';
import { createMemoryPath, type MemoryToolBackend } from '@/storage';

/**
 * Adapter interface for catch-up signal persistence.
 * Provides methods to store and retrieve catch-up completion and in-progress signals.
 */
export interface CatchUpSignalAdapter {
    /** Store catch-up completion signal */
    storeCompletionSignal:  (signal: CatchUpCompletionSignal) => Promise<void>
    /** Load catch-up completion signal */
    loadCompletionSignal:   () => Promise<CatchUpCompletionSignal | null>
    /** Store catch-up in-progress signal */
    storeInProgressSignal:  (signal: CatchUpInProgressSignal) => Promise<void>
    /** Load catch-up in-progress signal */
    loadInProgressSignal:   () => Promise<CatchUpInProgressSignal | null>
    /** Delete catch-up in-progress signal */
    deleteInProgressSignal: () => Promise<void>
}

/**
 * Creates a catch-up signal adapter that uses the memory tool backend for persistence.
 *
 * All methods swallow errors and log them, allowing catch-up operations to continue
 * even if signal persistence fails.
 *
 * @param memoryBackend - Memory tool backend for storage operations
 * @returns Adapter with methods for managing catch-up signals
 */
export function createCatchUpSignalAdapter(memoryBackend: MemoryToolBackend): CatchUpSignalAdapter {
    return {
        storeCompletionSignal: async (signal: CatchUpCompletionSignal) => {
            // Stryker disable BlockStatement: Catch-only-logs — emptying catch body is equivalent (error still swallowed)
            try {
                const path = createMemoryPath('/state/catchup-completion');
                const existing = await memoryBackend.get(path);
                const content = JSON.stringify(signal);
                await (existing ? memoryBackend.update(path, { content }) : memoryBackend.create({ path, content, contentType: 'application/json' }));
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error({
                    error: errorMsg,
                    msg:   'Failed to store catch-up completion signal',
                });
                /* Stryker restore all */
                // Don't re-throw - allow catch-up to continue
            }
            // Stryker restore BlockStatement
        },
        loadCompletionSignal: async () => {
            try {
                const path = createMemoryPath('/state/catchup-completion');
                const result = await memoryBackend.get(path);
                if(!result) {
                    return null;
                }
                return JSON.parse(result.content) as CatchUpCompletionSignal;
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error({
                    error: errorMsg,
                    msg:   'Failed to load catch-up completion signal',
                });
                /* Stryker restore all */
                return null;
            }
        },
        storeInProgressSignal: async (signal: CatchUpInProgressSignal) => {
            // Stryker disable BlockStatement: Catch-only-logs — emptying catch body is equivalent (error still swallowed)
            try {
                const path = createMemoryPath('/state/catchup-inprogress');
                const existing = await memoryBackend.get(path);
                const content = JSON.stringify(signal);
                await (existing ? memoryBackend.update(path, { content }) : memoryBackend.create({ path, content, contentType: 'application/json' }));
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error({
                    error: errorMsg,
                    msg:   'Failed to store catch-up in-progress signal',
                });
                /* Stryker restore all */
                // Don't re-throw - allow catch-up to continue
            }
            // Stryker restore BlockStatement
        },
        loadInProgressSignal: async () => {
            try {
                const path = createMemoryPath('/state/catchup-inprogress');
                const result = await memoryBackend.get(path);
                if(!result) {
                    return null;
                }
                return JSON.parse(result.content) as CatchUpInProgressSignal;
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error({
                    error: errorMsg,
                    msg:   'Failed to load catch-up in-progress signal',
                });
                /* Stryker restore all */
                return null;
            }
        },
        deleteInProgressSignal: async () => {
            // Stryker disable BlockStatement: Catch-only-logs — emptying catch body is equivalent (error still swallowed)
            try {
                const path = createMemoryPath('/state/catchup-inprogress');
                await memoryBackend.delete(path);
            } catch (error) {
                /* Stryker disable all: Defensive error handling */
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error({
                    error: errorMsg,
                    msg:   'Failed to delete catch-up in-progress signal',
                });
                /* Stryker restore all */
                // Don't re-throw - allow catch-up to continue
            }
            // Stryker restore BlockStatement
        },
    };
}
