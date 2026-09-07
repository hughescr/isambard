/**
 * Thin perch-flavoured wrappers around the session core's generic envelope builders
 * (`buildPerchEnvelope`/`buildWrapUpEnvelope`, `@/agent/session` — P6). This module owns no
 * header format of its own: it only maps perch-domain inputs (a {@link PerchSlot}, its
 * {@link PerchSlotConfig}) onto the parameters those builders already expect, so the on-wire
 * `[PERCH ...]`/`[WRAP-UP ...]` text stays byte-for-byte whatever P6 defines.
 *
 * Q12 perch decision (pinned, deliberate): perch turns carry the FULL context every time — the
 * complete `buildPerchContext` block (full day agenda, full service health, top-3 state), passed
 * in whole via {@link BuildPerchSlotEnvelopeParams.perchContext} and rendered verbatim — and
 * receive NONE of the Discord conductor's memory-tuning deltas (`[Calendar]`/`[State changed]`/
 * `[Service health]` sections that render only the CHANGE since a prior turn, `@/agent/session`'s
 * `ContextPolicy`, Q9/Q12). This is a structural fact, not an oversight to fix: perch has no
 * `ContextPolicy` of its own to source a delta from (`sessions.ts`'s `createPerchConductor` never
 * builds one — see its own doc comment), `buildPerchSlotEnvelope`/`buildPerchEnvelope` have no
 * `calendarChanged`/`stateChanged`/`healthNote` parameters to plumb one through even if one
 * existed, and perch runs only a handful of turns per day (one per slot), so each turn's context
 * must be self-contained rather than relying on a previous perch turn's baseline the way a
 * same-day run of Discord conductor turns can.
 *
 * @module agent/perch/envelope
 */
import { formatSlotName } from './prompts';
import { getSlotConfig } from './schedule';
import type { PerchSlot, SuggestionLevel } from './types';
import { buildPerchEnvelope, buildWrapUpEnvelope, type Envelope } from '@/agent/session';

/**
 * Maps a slot's {@link SuggestionLevel} onto the 0-3 scale `buildPerchEnvelope`'s
 * `suggestionLevel` renders as `Suggestion level: N of 3.`. `undefined` (the unscheduled slot,
 * which has no {@link PerchSlotConfig}) maps to 0 — off the bottom of the scale, since there is
 * no suggestion at all outside a defined window.
 */
function suggestionLevelToNumber(level: SuggestionLevel | undefined): number {
    switch(level) {
        case 'strongly_suggestive': {
            return 3;
        }
        case 'moderate': {
            return 2;
        }
        case 'open':
        case 'light_touch': {
            return 1;
        }
        case undefined: {
            return 0;
        }
    }
}

/** Computes a slot's `endsAt`: `maxSessionMinutes` after the trigger that started it. */
export function computeSlotEndsAt(trigger: Date, maxSessionMinutes: number): Date {
    return new Date(trigger.getTime() + maxSessionMinutes * 60_000);
}

/** Inputs to {@link buildPerchSlotEnvelope}. */
export interface BuildPerchSlotEnvelopeParams {
    slot:               PerchSlot
    now:                Date
    timezone:           string
    endsAt:             Date
    timeHeader:         string
    perchContext:       string
    backgroundSummary?: string
}

/**
 * Builds a perch-slot turn envelope: `formatSlotName(slot)` for the header's slot name,
 * `getSlotConfig(slot)`'s hint (empty for the unscheduled slot, which has none) and
 * {@link suggestionLevelToNumber}'s mapping of the slot's suggestion level, delegating the
 * actual header/body rendering to `buildPerchEnvelope` (`@/agent/session`, P6).
 * @param params Perch slot envelope inputs
 * @returns A `perch`-kind {@link Envelope}
 */
export function buildPerchSlotEnvelope(params: BuildPerchSlotEnvelopeParams): Envelope {
    const { slot, now, timezone, endsAt, timeHeader, perchContext, backgroundSummary } = params;
    const config = getSlotConfig(slot);

    return buildPerchEnvelope({
        slotName:        formatSlotName(slot),
        now,
        timezone,
        endsAt,
        suggestionLevel: suggestionLevelToNumber(config?.level),
        backgroundSummary,
        slotHint:        config?.hint ?? '',
        perchContext,
        timeHeader,
    });
}

/** Inputs to {@link buildPerchWrapUpEnvelope}. */
export interface BuildPerchWrapUpEnvelopeParams {
    now:         Date
    leadMinutes: number
}

/**
 * Builds a perch wrap-up envelope: `[WRAP-UP · perch slot ends in N min]`, delegating to
 * `buildWrapUpEnvelope` (`@/agent/session`, P6).
 * @param params Wrap-up envelope inputs
 * @returns A `wrapup`-kind {@link Envelope}
 */
export function buildPerchWrapUpEnvelope(params: BuildPerchWrapUpEnvelopeParams): Envelope {
    return buildWrapUpEnvelope({ minutesLeft: params.leadMinutes, now: params.now });
}
