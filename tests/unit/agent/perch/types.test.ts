import { describe, test, expect } from 'bun:test';
import {
    PerchSlotSchema,
    SuggestionLevelSchema,
    PerchSlotConfigSchema,
    type PerchSlot,
    type SuggestionLevel
} from '@/agent/perch/types';

describe.concurrent('PerchSlotSchema', () => {
    test('should validate all valid perch slots', () => {
        const validSlots: PerchSlot[] = [
            'pre-dawn',
            'mid-morning',
            'afternoon',
            'evening',
            'late-night',
            'unscheduled',
        ];

        for(const slot of validSlots) {
            const result = PerchSlotSchema.safeParse(slot);
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data).toBe(slot);
            }
        }
    });

    test('should reject invalid perch slot strings', () => {
        const invalidSlots = ['', 'invalid', 'morning', 'night', 'dawn'];

        for(const slot of invalidSlots) {
            const result = PerchSlotSchema.safeParse(slot);
            expect(result.success).toBe(false);
        }
    });

    test('should validate exact string "pre-dawn"', () => {
        const result = PerchSlotSchema.safeParse('pre-dawn');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('pre-dawn');
        }
    });

    test('should validate exact string "evening"', () => {
        const result = PerchSlotSchema.safeParse('evening');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('evening');
        }
    });

    test('should validate exact string "late-night"', () => {
        const result = PerchSlotSchema.safeParse('late-night');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('late-night');
        }
    });

    test('should validate exact string "afternoon"', () => {
        const result = PerchSlotSchema.safeParse('afternoon');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('afternoon');
        }
    });

    test('should validate exact string "mid-morning"', () => {
        const result = PerchSlotSchema.safeParse('mid-morning');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('mid-morning');
        }
    });

    test('should validate exact string "unscheduled"', () => {
        const result = PerchSlotSchema.safeParse('unscheduled');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('unscheduled');
        }
    });
});

describe.concurrent('SuggestionLevelSchema', () => {
    test('should validate all valid suggestion levels', () => {
        const validLevels: SuggestionLevel[] = [
            'strongly_suggestive',
            'moderate',
            'open',
            'light_touch',
        ];

        for(const level of validLevels) {
            const result = SuggestionLevelSchema.safeParse(level);
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data).toBe(level);
            }
        }
    });

    test('should reject invalid suggestion level strings', () => {
        const invalidLevels = ['', 'invalid', 'strong', 'weak', 'high'];

        for(const level of invalidLevels) {
            const result = SuggestionLevelSchema.safeParse(level);
            expect(result.success).toBe(false);
        }
    });

    test('should validate exact string "open"', () => {
        const result = SuggestionLevelSchema.safeParse('open');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('open');
        }
    });

    test('should validate exact string "light_touch"', () => {
        const result = SuggestionLevelSchema.safeParse('light_touch');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('light_touch');
        }
    });

    test('should validate exact string "strongly_suggestive"', () => {
        const result = SuggestionLevelSchema.safeParse('strongly_suggestive');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('strongly_suggestive');
        }
    });

    test('should validate exact string "moderate"', () => {
        const result = SuggestionLevelSchema.safeParse('moderate');
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe('moderate');
        }
    });
});

describe.concurrent('PerchSlotConfigSchema', () => {
    test('should validate complete PerchSlotConfig', () => {
        const validConfig = {
            slot:      'pre-dawn' as const,
            startHour: 5,
            endHour:   7,
            level:     'strongly_suggestive' as const,
            hint:      'Time for morning digest',
        };

        const result = PerchSlotConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(validConfig);
        }
    });

    test('should reject config with empty hint', () => {
        const configWithEmptyHint = {
            slot:      'pre-dawn',
            startHour: 5,
            endHour:   7,
            level:     'strongly_suggestive',
            hint:      '',
        };

        const result = PerchSlotConfigSchema.safeParse(configWithEmptyHint);
        expect(result.success).toBe(false);
    });

    test('should reject config with startHour < 0', () => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: -1,
            endHour:   7,
            level:     'strongly_suggestive',
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject config with startHour > 23', () => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: 24,
            endHour:   7,
            level:     'strongly_suggestive',
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject config with endHour < 0', () => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: 5,
            endHour:   -1,
            level:     'strongly_suggestive',
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject config with endHour > 23', () => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: 5,
            endHour:   24,
            level:     'strongly_suggestive',
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should accept startHour = 0 (boundary)', () => {
        const config = {
            slot:      'pre-dawn',
            startHour: 0,
            endHour:   2,
            level:     'strongly_suggestive',
            hint:      'Midnight start',
        };

        const result = PerchSlotConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    test('should accept startHour = 23 (boundary)', () => {
        const config = {
            slot:      'late-night',
            startHour: 23,
            endHour:   1,
            level:     'moderate',
            hint:      'Late evening',
        };

        const result = PerchSlotConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    test('should accept endHour = 0 (boundary)', () => {
        const config = {
            slot:      'late-night',
            startHour: 22,
            endHour:   0,
            level:     'moderate',
            hint:      'End at midnight',
        };

        const result = PerchSlotConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    test('should accept endHour = 23 (boundary)', () => {
        const config = {
            slot:      'evening',
            startHour: 20,
            endHour:   23,
            level:     'light_touch',
            hint:      'Late evening',
        };

        const result = PerchSlotConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    test('should reject config with fractional startHour', () => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: 5.5,
            endHour:   7,
            level:     'strongly_suggestive',
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject config with fractional endHour', () => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: 5,
            endHour:   7.5,
            level:     'strongly_suggestive',
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject config without slot field', () => {
        const invalidConfig = {
            // slot missing
            startHour: 5,
            endHour:   7,
            level:     'strongly_suggestive',
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should reject config without level field', () => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: 5,
            endHour:   7,
            // level missing
            hint:      'Test',
        };

        const result = PerchSlotConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('should accept valid config with all enum values', () => {
        const slots: PerchSlot[] = ['pre-dawn', 'mid-morning', 'afternoon', 'evening', 'late-night', 'unscheduled'];
        const levels: SuggestionLevel[] = ['strongly_suggestive', 'moderate', 'open', 'light_touch'];

        for(const slot of slots) {
            for(const level of levels) {
                const config = {
                    slot,
                    startHour: 10,
                    endHour:   12,
                    level,
                    hint:      'Test hint',
                };

                const result = PerchSlotConfigSchema.safeParse(config);
                expect(result.success).toBe(true);
            }
        }
    });

    test('should reject empty object', () => {
        const result = PerchSlotConfigSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    test('should reject object with extra fields only', () => {
        const result = PerchSlotConfigSchema.safeParse({
            extraField: 'value',
        });
        expect(result.success).toBe(false);
    });
});
