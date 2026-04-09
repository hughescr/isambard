/**
 * History providers public API.
 *
 * Exports the cross-platform history coordinator and its supporting types.
 * Platform-specific provider implementations live in their respective integration
 * modules and register themselves via PersonHistoryCoordinatorOptions.providers.
 */

// Types
export type {
    HistoryEntry,
    HistoryFetchParams,
    PlatformHistoryProvider
} from './types';

// Coordinator
export { PersonHistoryCoordinator } from './coordinator';
