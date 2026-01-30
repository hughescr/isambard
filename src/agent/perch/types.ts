/**
 * Perch Time Types
 *
 * Types for autonomous "Perch Time" scheduling - time-based activity
 * scheduling inspired by Strix's Daily Rhythm system.
 */

import { z } from 'zod';

// ============================================================================
// Time Slot Types
// ============================================================================

/**
 * Perch time slots with graduated suggestion levels.
 * - pre-dawn: 5-7am Pacific - STRONGLY SUGGESTIVE (digest prep)
 * - mid-morning: 9-11am - MODERATE
 * - afternoon: 1-3pm - OPEN
 * - evening: 6-8pm - LIGHT TOUCH
 * - late-night: 11pm-1am - MODERATE/PREP
 * - unscheduled: Outside defined windows - base prompt only
 */
export type PerchSlot
    = | 'pre-dawn'
      | 'mid-morning'
      | 'afternoon'
      | 'evening'
      | 'late-night'
      | 'unscheduled';

/**
 * Zod schema for PerchSlot validation.
 */
export const PerchSlotSchema = z.enum([
    'pre-dawn',
    'mid-morning',
    'afternoon',
    'evening',
    'late-night',
    'unscheduled',
]);

/**
 * Suggestion level determines how strongly to recommend time-specific activities.
 */
export type SuggestionLevel = 'strongly_suggestive' | 'moderate' | 'open' | 'light_touch';

/**
 * Zod schema for SuggestionLevel validation.
 */
export const SuggestionLevelSchema = z.enum([
    'strongly_suggestive',
    'moderate',
    'open',
    'light_touch',
]);

/**
 * Configuration for a single perch time slot.
 */
export interface PerchSlotConfig {
    /** Slot identifier */
    slot:      PerchSlot
    /** Start hour in 24-hour format (Pacific time) */
    startHour: number
    /** End hour in 24-hour format (Pacific time) */
    endHour:   number
    /** How strongly to suggest time-specific activities */
    level:     SuggestionLevel
    /** Time-specific hint/guidance text */
    hint:      string
}

/**
 * Zod schema for PerchSlotConfig validation.
 */
export const PerchSlotConfigSchema = z.object({
    slot:      PerchSlotSchema,
    startHour: z.number().int().min(0).max(23),
    endHour:   z.number().int().min(0).max(23),
    level:     SuggestionLevelSchema,
    hint:      z.string().min(1),
});

/**
 * Test mode configuration for perch time.
 */
export interface PerchTestModeConfig {
    /** Whether test mode is enabled */
    enabled:   boolean
    /** Force a specific slot instead of cycling */
    forceSlot?: PerchSlot
}

/**
 * Global perch configuration.
 */
export interface PerchConfig {
    /** Whether perch time is enabled */
    enabled:           boolean
    /** Timezone for schedule (default: America/Los_Angeles) */
    timezone:          string
    /** Minutes between perch triggers (default: 60) */
    intervalMinutes:   number
    /** @deprecated No longer used - cron-parser's H option provides full 0-59 minute range for jitter */
    jitterMinutes:     number
    /** Maximum session duration in minutes (default: 45) */
    maxSessionMinutes: number
    /** Test mode configuration for manual testing */
    testMode?:         PerchTestModeConfig
}

/**
 * Zod schema for PerchConfig validation with defaults.
 */
export const PerchConfigSchema = z.object({
    enabled:           z.boolean().default(true),
    timezone:          z.string().default('America/Los_Angeles'),
    intervalMinutes:   z.number().int().positive().default(60),
    jitterMinutes:     z.number().int().nonnegative().default(15),
    maxSessionMinutes: z.number().int().positive().default(45),
});

/**
 * Scheduler state for tracking pending perch triggers.
 */
export interface PerchSchedulerState {
    /** True if a trigger fired while bot was busy */
    perchPending:        boolean
    /** The slot that was deferred */
    pendingSlot?:        PerchSlot
    /** When the deferred trigger fired */
    pendingTriggerTime?: Date
}

/**
 * Zod schema for PerchSchedulerState validation.
 */
export const PerchSchedulerStateSchema = z.object({
    perchPending:       z.boolean(),
    pendingSlot:        PerchSlotSchema.optional(),
    pendingTriggerTime: z.date().optional(),
});
