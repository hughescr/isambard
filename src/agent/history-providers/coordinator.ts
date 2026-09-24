import { logger } from '@hughescr/logger';
import {
    DEFAULT_MAX_CHARACTERS,
    DEFAULT_MAX_MESSAGES_PER_PLATFORM,
    DEFAULT_MAX_TOTAL_ENTRIES,
    DEFAULT_TIME_WINDOW_MINUTES,
    KNOWN_HISTORY_PLATFORMS,
    type HistoryEntry,
    type HistoryFetchFailure,
    type HistoryFetchResult,
    type HistoryScope,
    type KnownPlatform,
    type PersonHistoryCoverage,
    type PersonHistoryOptions,
    type PersonHistoryResult,
    type PlatformHistoryProvider
} from './types';
import { InvariantViolationError } from '@/errors';
import type { ServiceErrorCategory } from '@/services';
import type { Contact, ContactBackend, PlatformType } from '@/storage';
import { assertNever } from '@/utils';

/**
 * Options for constructing a PersonHistoryCoordinator.
 */
export interface PersonHistoryCoordinatorOptions {
    /** Backend for looking up contacts by name/identifier. */
    contactBackend: ContactBackend
    /** Registered platform-specific history providers. */
    providers:      PlatformHistoryProvider[]
}

interface NormalizedHistoryOptions {
    maxMessages:          number
    maxTotal:             number
    windowMinutes:        number
    maxChars:             number
    platformHint:         PlatformType | undefined
    startTime:            Date | undefined
    endTime:              Date | undefined
    unavailablePlatforms: Partial<Record<KnownPlatform, ServiceErrorCategory>> | undefined
}

function normalizeHistoryOptions(options: PersonHistoryOptions | undefined): NormalizedHistoryOptions {
    return {
        maxMessages:          options?.maxMessagesPerPlatform ?? DEFAULT_MAX_MESSAGES_PER_PLATFORM,
        maxTotal:             options?.maxTotalEntries        ?? DEFAULT_MAX_TOTAL_ENTRIES,
        windowMinutes:        options?.timeWindowMinutes      ?? DEFAULT_TIME_WINDOW_MINUTES,
        maxChars:             options?.maxCharacters          ?? DEFAULT_MAX_CHARACTERS,
        platformHint:         options?.platformHint,
        startTime:            options?.startTime,
        endTime:              options?.endTime,
        unavailablePlatforms: options?.unavailablePlatforms,
    };
}

/** The per-provider fetch window shared by every identifier query. */
interface FetchWindow {
    maxMessages: number
    startTime:   Date
    endTime:     Date
}

/**
 * What the coordinator learned about one registered platform. `not_applicable`
 * means the contact has no identifier there, so the provider was never called.
 */
interface PlatformObservation {
    platform:  KnownPlatform
    queried:   boolean
    coverage:  HistoryFetchResult['coverage'] | 'not_applicable'
    entries:   HistoryEntry[]
    truncated: boolean
    failures:  HistoryFetchFailure[]
}

/** Source label for a platform skipped because service health already reports it down. */
const SERVICE_HEALTH_SOURCE = 'service-health';

/** Source label for a provider promise that rejected instead of returning a result. */
const PROVIDER_SOURCE = 'provider';

/** Closing line of the formatted history block; always kept, even when entries are cut. */
const HISTORY_FOOTER = '--- End of recent history ---';

/**
 * Strip the `_internal` field from a contact before returning to callers.
 * The agent must never see Discord user IDs or Bluesky DIDs directly.
 */
function stripInternal(contact: Contact): Omit<Contact, '_internal'> {
    const { _internal: _, ...rest } = contact;
    return rest;
}

/**
 * Return a human-readable label for a known platform.
 * The exhaustiveness check via assertNever ensures a compile error
 * if a new platform is added to KnownPlatform without updating this switch.
 */
function platformLabel(platform: KnownPlatform): string {
    switch(platform) {
        case 'discord': { return 'discord'; }
        case 'email':   { return 'email'; }
        case 'bsky':    { return 'bsky'; }
        default:        { return assertNever(platform, `Unexpected platform: ${String(platform)}`); }
    }
}

/**
 * Build the typed provider scope from the contact's internal fields.
 * Exhaustive on KnownPlatform: adding a platform fails typecheck until this switch handles it.
 */
function buildHistoryScope(platform: KnownPlatform, internalData: Contact['_internal']): HistoryScope | undefined {
    switch(platform) {
        case 'discord': {
            return internalData?.discordUserId
                ? { platform: 'discord', discordUserId: internalData.discordUserId }
                : undefined;
        }
        case 'email': { return undefined; }
        case 'bsky': {
            return internalData?.bskyDid
                ? { platform: 'bsky', kind: 'direct-conversation', participantDid: internalData.bskyDid }
                : { platform: 'bsky', kind: 'author-feed' };
        }
        default: { return assertNever(platform, `Unexpected history platform: ${String(platform)}`); }
    }
}

/** Format one entry as a single history line. */
function formatEntryLine(entry: HistoryEntry): string {
    const ts = new Date(entry.timestamp);
    // Format as HH:MM if today, else as date
    const now = new Date();
    const sameYear  = ts.getUTCFullYear() === now.getUTCFullYear();
    const sameMonth = ts.getUTCMonth() === now.getUTCMonth();
    const sameDay   = ts.getUTCDate() === now.getUTCDate();
    const isToday   = sameYear && sameMonth && sameDay;
    const timeStr = isToday
        ? `${String(ts.getUTCHours()).padStart(2, '0')}:${String(ts.getUTCMinutes()).padStart(2, '0')}`
        : ts.toISOString().slice(0, 10);
    // Stryker disable next-line llm: summary is a string, so `${summary}` and `${summary || ''}` render identically for every value
    return `[${platformLabel(entry.platform)}] [${timeStr}] ${entry.summary}`;
}

/**
 * Format entries (already sorted most-recent first) into a framed history block
 * no longer than `maxChars`. Whole entry lines are kept, most recent first, until
 * the next one would not fit, so the header and footer always survive. The frame
 * itself is never cut: a budget smaller than the frame yields the frame alone.
 * A NaN budget never cuts anything.
 */
function formatHistoryEntries(displayName: string, entries: HistoryEntry[], maxChars: number): { text: string, truncated: boolean } {
    const header = `--- Recent interactions with ${displayName} ---`;
    const kept: string[] = [];
    // header + '\n' + footer; each kept line adds itself plus one '\n'
    let length = header.length + 1 + HISTORY_FOOTER.length;
    for(const entry of entries) {
        const line = formatEntryLine(entry);
        length += line.length + 1;
        if(length > maxChars) {
            break;
        }
        kept.push(line);
    }
    return { text: [header, ...kept, HISTORY_FOOTER].join('\n'), truncated: kept.length < entries.length };
}

/** Coverage for a platform queried under one or more identifiers. */
function combineCoverage(results: HistoryFetchResult[]): HistoryFetchResult['coverage'] {
    if(results.every(result => result.coverage === 'complete')) {
        return 'complete';
    }
    if(results.every(result => result.coverage === 'unavailable')) {
        return 'unavailable';
    }
    return 'partial';
}

/** An observation for a platform that was not queried. */
function unqueried(platform: KnownPlatform, coverage: PlatformObservation['coverage'], failures: HistoryFetchFailure[]): PlatformObservation {
    return { platform, queried: false, coverage, entries: [], truncated: false, failures };
}

/** Summarise per-platform observations into the caller-facing coverage block. */
function summarizeCoverage(
    providers:      PlatformHistoryProvider[],
    observations:   PlatformObservation[],
    entriesCut:     boolean
): PersonHistoryCoverage {
    const platformsWhere = (predicate: (observation: PlatformObservation) => boolean): KnownPlatform[] =>
        observations.filter(observation => predicate(observation)).map(observation => observation.platform);
    return {
        queried:       platformsWhere(observation => observation.queried),
        unavailable:   platformsWhere(observation => observation.coverage === 'unavailable'),
        partial:       platformsWhere(observation => observation.coverage === 'partial'),
        notConfigured: KNOWN_HISTORY_PLATFORMS.filter(platform => !providers.some(provider => provider.platform === platform)),
        notApplicable: platformsWhere(observation => observation.coverage === 'not_applicable'),
        truncated:     entriesCut || observations.some(observation => observation.truncated),
        failures:      observations.flatMap(observation => observation.failures.map(failure => ({
            platform: observation.platform,
            source:   failure.source,
            category: failure.category,
        }))),
    };
}

/**
 * Coordinates fetching cross-platform interaction history for a person.
 *
 * Given an identifier (name, email, handle), resolves the contact via fuzzy lookup,
 * fans out to registered platform providers in parallel, merges and sorts the results,
 * and returns a formatted string plus a coverage block that says which platforms were
 * consulted, which failed, and which were not configured or not applicable.
 */
export class PersonHistoryCoordinator {
    constructor(private readonly options: PersonHistoryCoordinatorOptions) {}

    /**
     * Resolve a contact by identifier, using direct platform lookup when a hint is available.
     * Falls back to fuzzy lookup if platform lookup returns nothing or no hint is provided.
     */
    private async resolveContact(identifier: string, platformHint: PlatformType | undefined): Promise<Contact[]> {
        if(platformHint) {
            const direct = await this.options.contactBackend.resolveIdentifier(platformHint, identifier);
            // Stryker disable next-line llm: Contact[] length is a non-negative integer, so > 0 and >= 1 select the same arrays
            if(direct.length > 0) {
                return direct;
            }
        }
        return this.options.contactBackend.fuzzyLookup(identifier);
    }

    /**
     * Observe one provider for a contact: not applicable without a matching identifier,
     * unavailable without a call when service health already reports it down, otherwise
     * queried once per matching identifier. A rejected provider call becomes an
     * unavailable transient result so one platform never hides the others.
     */
    private async observePlatform(
        provider:             PlatformHistoryProvider,
        contact:              Contact,
        window:               FetchWindow,
        unavailablePlatforms: NormalizedHistoryOptions['unavailablePlatforms']
    ): Promise<PlatformObservation> {
        const { platform } = provider;
        const matchingIds = contact.identifiers
            .filter(id => id.platform === platform)
            .map(id => id.value);
        if(matchingIds.length === 0) {
            return unqueried(platform, 'not_applicable', []);
        }

        const knownDown = unavailablePlatforms?.[platform];
        if(knownDown !== undefined) {
            return unqueried(platform, 'unavailable', [{ source: SERVICE_HEALTH_SOURCE, category: knownDown }]);
        }

        const scope = buildHistoryScope(platform, contact._internal);
        const settled = await Promise.allSettled(matchingIds.map(async identifier => provider.fetchHistory({
            identifier,
            ...window,
            ...(scope !== undefined && { scope }),
        })));
        const results = settled.map((outcome): HistoryFetchResult => {
            // Stryker disable next-line llm: PromiseSettledResult has exactly two statuses, so === 'fulfilled' and !== 'rejected' are the same predicate.
            if(outcome.status === 'fulfilled') {
                return outcome.value;
            }
            const reason: unknown = outcome.reason;
            logger.warn({ err: reason, platform }, 'PersonHistoryCoordinator: provider query failed');
            return {
                platform,
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [{ source: PROVIDER_SOURCE, category: 'transient', error: reason }],
            };
        });

        return {
            platform,
            queried:   true,
            coverage:  combineCoverage(results),
            entries:   results.flatMap(result => result.entries),
            truncated: results.some(result => result.truncated),
            failures:  results.flatMap(result => result.failures),
        };
    }

    /**
     * Fetch cross-platform history for a person identified by a fuzzy query.
     *
     * @param identifier - Name, email, handle, or any fuzzy-matchable identifier.
     * @param options    - Optional limits, time window, and platforms known to be down.
     * @returns `contact_not_found`, or `observed` with the matched contact (`_internal` stripped),
     *          the formatted history (undefined when nothing was observed), and the coverage block.
     */
    async getPersonHistory(identifier: string, options?: PersonHistoryOptions): Promise<PersonHistoryResult> {
        const { maxMessages, maxTotal, windowMinutes, maxChars, platformHint, startTime: optStartTime, endTime: optEndTime, unavailablePlatforms } = normalizeHistoryOptions(options);

        // Step 1: resolve the person — use direct platform lookup when hint is available (avoids full-contact scan)
        const contacts = await this.resolveContact(identifier, platformHint);
        if(contacts.length === 0) {
            return { kind: 'contact_not_found' };
        }
        const contact = contacts[0];
        if(contact === undefined) {
            throw new InvariantViolationError('getPersonHistory', 'contacts[0] undefined after contacts.length === 0 guard');
        }

        // Step 2: compute time window — use explicit startTime/endTime when provided, otherwise fall back to windowMinutes
        const endTime   = optEndTime   ?? new Date();
        const startTime = optStartTime ?? new Date(endTime.getTime() - windowMinutes * 60 * 1000);

        // Step 3: observe every registered provider in parallel
        const observations = await Promise.all(this.options.providers.map(async provider =>
            this.observePlatform(provider, contact, { maxMessages, startTime, endTime }, unavailablePlatforms)));

        // Step 4: merge, sort descending (most recent first; stable, so registration order breaks ties), cap, format
        const allEntries = observations.flatMap(observation => observation.entries);
        allEntries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const capped = allEntries.slice(0, maxTotal);

        let history: string | undefined;
        let formatCut = false;
        if(capped.length > 0) {
            const formatted = formatHistoryEntries(contact.displayName, capped, maxChars);
            history   = formatted.text;
            formatCut = formatted.truncated;
        }

        const coverage = summarizeCoverage(this.options.providers, observations, capped.length < allEntries.length || formatCut);
        return { kind: 'observed', person: stripInternal(contact), history, coverage };
    }
}
