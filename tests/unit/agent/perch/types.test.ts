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

    test.each<PerchSlot>([
        'pre-dawn',
        'evening',
        'late-night',
        'afternoon',
        'mid-morning',
        'unscheduled',
    ])('should validate exact string "%s"', (slot) => {
        const result = PerchSlotSchema.safeParse(slot);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe(slot);
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

    test.each<SuggestionLevel>([
        'open',
        'light_touch',
        'strongly_suggestive',
        'moderate',
    ])('should validate exact string "%s"', (level) => {
        const result = SuggestionLevelSchema.safeParse(level);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toBe(level);
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

    test('should accept a one-character hint', () => {
        expect(PerchSlotConfigSchema.safeParse({
            slot:      'pre-dawn',
            startHour: 5,
            endHour:   7,
            level:     'strongly_suggestive',
            hint:      'x',
        }).success).toBe(true);
    });

    test.each<[string, Partial<{ startHour: number, endHour: number }>]>([
        ['startHour < 0', { startHour: -1 }],
        ['startHour > 23', { startHour: 24 }],
        ['endHour < 0', { endHour: -1 }],
        ['endHour > 23', { endHour: 24 }],
    ])('should reject config with %s', (_label, overrides) => {
        const invalidConfig = {
            slot:      'pre-dawn',
            startHour: 5,
            endHour:   7,
            level:     'strongly_suggestive',
            hint:      'Test',
            ...overrides,
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
