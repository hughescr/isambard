/**
 * History providers public API.
 *
 * Exports the cross-platform history coordinator and its supporting types.
 * Platform-specific provider implementations live in their respective integration
 * modules and register themselves via PersonHistoryCoordinatorOptions.providers.
 */

// Types
export type {
    BskyHistoryQuery,
    DiscordHistoryScope,
    HistoryEntry,
    HistoryFailureCategory,
    HistoryFetchFailure,
    HistoryFetchParams,
    HistoryFetchResult,
    HistoryScope,
    KnownPlatform,
    PersonHistoryCoverage,
    PersonHistoryFailure,
    PersonHistoryResult,
    PlatformHistoryProvider
} from './types';

export { KNOWN_HISTORY_PLATFORMS } from './types';

// Coordinator
export { PersonHistoryCoordinator } from './coordinator';
