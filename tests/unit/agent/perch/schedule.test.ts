import { describe, test, expect } from 'bun:test';
import { getSlotForHour, getSlotConfig, getNextSlot, SLOT_CONFIGS } from '@/agent/perch/schedule';
import type { PerchSlot } from '@/agent/perch/types';

describe.concurrent('getSlotForHour', () => {
    describe.concurrent('pre-dawn slot (5-7am)', () => {
        test.each<[number, PerchSlot]>([
            [5, 'pre-dawn'],
            [6, 'pre-dawn'],
        ])('hour %d should return %s', (hour, expected) => {
            expect(getSlotForHour(hour)).toBe(expected);
        });
    });

    describe.concurrent('mid-morning slot (9-11am)', () => {
        test.each<[number, PerchSlot]>([
            [9, 'mid-morning'],
            [10, 'mid-morning'],
        ])('hour %d should return %s', (hour, expected) => {
            expect(getSlotForHour(hour)).toBe(expected);
        });
    });

    describe.concurrent('wikipedia slot (12pm-2pm)', () => {
        test.each<[number, PerchSlot]>([
            [12, 'wikipedia'],
            [13, 'wikipedia'],
        ])('hour %d should return %s', (hour, expected) => {
            expect(getSlotForHour(hour)).toBe(expected);
        });
    });

    describe.concurrent('afternoon slot (2-4pm)', () => {
        test.each<[number, PerchSlot]>([
            [14, 'afternoon'],
            [15, 'afternoon'],
        ])('hour %d should return %s', (hour, expected) => {
            expect(getSlotForHour(hour)).toBe(expected);
        });
    });

    describe.concurrent('evening slot (6-8pm)', () => {
        test.each<[number, PerchSlot]>([
            [18, 'evening'],
            [19, 'evening'],
        ])('hour %d should return %s', (hour, expected) => {
            expect(getSlotForHour(hour)).toBe(expected);
        });
    });

    describe.concurrent('late-night slot (11pm-1am, spans midnight)', () => {
        test.each<[number, PerchSlot]>([
            [23, 'late-night'],
            [0, 'late-night'],
            [1, 'late-night'],
        ])('hour %d should return %s', (hour, expected) => {
            expect(getSlotForHour(hour)).toBe(expected);
        });
    });

    describe.concurrent('unscheduled hours', () => {
        test.each<[number, PerchSlot]>([
            [2, 'unscheduled'],
            [3, 'unscheduled'],
            [4, 'unscheduled'],
            [7, 'unscheduled'],
            [8, 'unscheduled'],
            [11, 'unscheduled'],
            [16, 'unscheduled'],
            [17, 'unscheduled'],
            [20, 'unscheduled'],
            [21, 'unscheduled'],
            [22, 'unscheduled'],
        ])('hour %d should return %s', (hour, expected) => {
            expect(getSlotForHour(hour)).toBe(expected);
        });
    });

    describe.concurrent('hour validation', () => {
        test('should accept hour 0 (midnight)', () => {
            expect(getSlotForHour(0)).toBe('late-night');
        });

        test('should accept hour 23 (11pm)', () => {
            expect(getSlotForHour(23)).toBe('late-night');
        });

        test('should throw RangeError for negative hour', () => {
            expect(() => getSlotForHour(-1)).toThrow(RangeError);
            expect(() => getSlotForHour(-1)).toThrow('Hour must be between 0 and 23, got -1');
        });

        test('should throw RangeError for hour >= 24', () => {
            expect(() => getSlotForHour(24)).toThrow(RangeError);
            expect(() => getSlotForHour(24)).toThrow('Hour must be between 0 and 23, got 24');
        });

        test('should throw RangeError for hour > 24', () => {
            expect(() => getSlotForHour(25)).toThrow(RangeError);
            expect(() => getSlotForHour(25)).toThrow('Hour must be between 0 and 23, got 25');
        });
    });

    describe.concurrent('boundary conditions', () => {
        test('hour 4 should be unscheduled (before pre-dawn)', () => {
            expect(getSlotForHour(4)).toBe('unscheduled');
        });

        test('hour 7 should be unscheduled (after pre-dawn)', () => {
            expect(getSlotForHour(7)).toBe('unscheduled');
        });

        test('hour 8 should be unscheduled (before mid-morning)', () => {
            expect(getSlotForHour(8)).toBe('unscheduled');
        });

        test('hour 11 should be unscheduled (after mid-morning)', () => {
            expect(getSlotForHour(11)).toBe('unscheduled');
        });

        test('hour 16 should be unscheduled (after afternoon)', () => {
            expect(getSlotForHour(16)).toBe('unscheduled');
        });

        test('hour 17 should be unscheduled (before evening)', () => {
            expect(getSlotForHour(17)).toBe('unscheduled');
        });

        test('hour 20 should be unscheduled (after evening)', () => {
            expect(getSlotForHour(20)).toBe('unscheduled');
        });

        test('hour 22 should be unscheduled (before late-night)', () => {
            expect(getSlotForHour(22)).toBe('unscheduled');
        });

        test('hour 2 should be unscheduled (after late-night)', () => {
            expect(getSlotForHour(2)).toBe('unscheduled');
        });
    });

    describe.concurrent('complete hour coverage', () => {
        test('all hours 0-23 should return a valid slot', () => {
            for(let hour = 0; hour < 24; hour++) {
                const slot = getSlotForHour(hour);
                expect(slot).toBeDefined();
                expect(typeof slot).toBe('string');
            }
        });
    });
});

describe.concurrent('getSlotConfig', () => {
    describe.concurrent('scheduled slots', () => {
        test('should return config for pre-dawn', () => {
            const config = getSlotConfig('pre-dawn');
            expect(config).toBeDefined();
            expect(config?.slot).toBe('pre-dawn');
            expect(config?.startHour).toBe(5);
            expect(config?.endHour).toBe(7);
            expect(config?.level).toBe('strongly_suggestive');
            expect(config?.hint).toContain('Craig wakes around 7am');
        });

        test('should return config for mid-morning', () => {
            const config = getSlotConfig('mid-morning');
            expect(config).toBeDefined();
            expect(config?.slot).toBe('mid-morning');
            expect(config?.startHour).toBe(9);
            expect(config?.endHour).toBe(11);
            expect(config?.level).toBe('moderate');
            expect(config?.hint).toContain('Morning work hours');
        });

        test('should return config for wikipedia', () => {
            const config = getSlotConfig('wikipedia');
            expect(config).toBeDefined();
            expect(config?.slot).toBe('wikipedia');
            expect(config?.startHour).toBe(12);
            expect(config?.endHour).toBe(14);
            expect(config?.level).toBe('moderate');
            expect(config?.hint).toContain('Lunchtime breadth exploration');
        });

        test('should return config for afternoon', () => {
            const config = getSlotConfig('afternoon');
            expect(config).toBeDefined();
            expect(config?.slot).toBe('afternoon');
            expect(config?.startHour).toBe(14);
            expect(config?.endHour).toBe(16);
            expect(config?.level).toBe('open');
            expect(config?.hint).toContain('Afternoon');
        });

        test('should return config for evening', () => {
            const config = getSlotConfig('evening');
            expect(config).toBeDefined();
            expect(config?.slot).toBe('evening');
            expect(config?.startHour).toBe(18);
            expect(config?.endHour).toBe(20);
            expect(config?.level).toBe('light_touch');
            expect(config?.hint).toContain('Evening hours');
        });

        test('should return config for late-night', () => {
            const config = getSlotConfig('late-night');
            expect(config).toBeDefined();
            expect(config?.slot).toBe('late-night');
            expect(config?.startHour).toBe(23);
            expect(config?.endHour).toBe(1);
            expect(config?.level).toBe('moderate');
            expect(config?.hint).toContain('Late night');
        });
    });

    describe.concurrent('unscheduled slot', () => {
        test('should return undefined for unscheduled', () => {
            const config = getSlotConfig('unscheduled');
            expect(config).toBeUndefined();
        });
    });

    describe.concurrent('config properties', () => {
        test('all configs should have required properties', () => {
            for(const config of SLOT_CONFIGS) {
                expect(config.slot).toBeDefined();
                expect(typeof config.slot).toBe('string');
                expect(typeof config.startHour).toBe('number');
                expect(typeof config.endHour).toBe('number');
                expect(config.startHour).toBeGreaterThanOrEqual(0);
                expect(config.startHour).toBeLessThanOrEqual(23);
                expect(config.endHour).toBeGreaterThanOrEqual(0);
                expect(config.endHour).toBeLessThanOrEqual(23);
                expect(config.level).toBeDefined();
                expect(typeof config.hint).toBe('string');
                expect(config.hint.length).toBeGreaterThan(0);
            }
        });

        test('all suggestion levels should be valid', () => {
            const validLevels = ['strongly_suggestive', 'moderate', 'open', 'light_touch'];
            for(const config of SLOT_CONFIGS) {
                expect(validLevels).toContain(config.level);
            }
        });
    });

    describe.concurrent('slot config consistency', () => {
        test('getSlotConfig should return same config as in SLOT_CONFIGS', () => {
            for(const config of SLOT_CONFIGS) {
                const retrieved = getSlotConfig(config.slot);
                expect(retrieved).toEqual(config);
            }
        });
    });
});

describe.concurrent('getNextSlot', () => {
    describe.concurrent('when currently in a named slot, returns next in SLOT_CONFIGS order', () => {
        test('from pre-dawn → mid-morning', () => {
            // pre-dawn is hours 5-6
            expect(getNextSlot(5)).toBe('mid-morning');
            expect(getNextSlot(6)).toBe('mid-morning');
        });

        test('from mid-morning → wikipedia', () => {
            // mid-morning is hours 9-10
            expect(getNextSlot(9)).toBe('wikipedia');
            expect(getNextSlot(10)).toBe('wikipedia');
        });

        test('from wikipedia → afternoon', () => {
            // wikipedia is hours 12-13
            expect(getNextSlot(12)).toBe('afternoon');
            expect(getNextSlot(13)).toBe('afternoon');
        });

        test('from afternoon → evening', () => {
            // afternoon is hours 14-15
            expect(getNextSlot(14)).toBe('evening');
            expect(getNextSlot(15)).toBe('evening');
        });

        test('from evening → late-night', () => {
            // evening is hours 18-19
            expect(getNextSlot(18)).toBe('late-night');
            expect(getNextSlot(19)).toBe('late-night');
        });

        test('from late-night → pre-dawn (wraparound)', () => {
            // late-night spans hours 23, 0, 1
            expect(getNextSlot(23)).toBe('pre-dawn');
            expect(getNextSlot(0)).toBe('pre-dawn');
            expect(getNextSlot(1)).toBe('pre-dawn');
        });
    });

    describe.concurrent('when between slots (unscheduled), returns next upcoming slot', () => {
        test('hour 2 → pre-dawn (hours 2-4 are between late-night and pre-dawn)', () => {
            expect(getNextSlot(2)).toBe('pre-dawn');
            expect(getNextSlot(3)).toBe('pre-dawn');
            expect(getNextSlot(4)).toBe('pre-dawn');
        });

        test('hour 7 → mid-morning (hours 7-8 are after pre-dawn, before mid-morning)', () => {
            expect(getNextSlot(7)).toBe('mid-morning');
            expect(getNextSlot(8)).toBe('mid-morning');
        });

        test('hour 11 → wikipedia (hour 11 is after mid-morning, before wikipedia)', () => {
            expect(getNextSlot(11)).toBe('wikipedia');
        });

        test('hour 16 → evening (hours 16-17 are after afternoon, before evening)', () => {
            expect(getNextSlot(16)).toBe('evening');
            expect(getNextSlot(17)).toBe('evening');
        });

        test('hour 20 → late-night (hours 20-22 are after evening, before late-night)', () => {
            expect(getNextSlot(20)).toBe('late-night');
            expect(getNextSlot(21)).toBe('late-night');
            expect(getNextSlot(22)).toBe('late-night');
        });
    });

    describe.concurrent('hour validation', () => {
        test('should throw RangeError for negative hour', () => {
            expect(() => getNextSlot(-1)).toThrow(RangeError);
            expect(() => getNextSlot(-1)).toThrow('Hour must be between 0 and 23, got -1');
        });

        test('should throw RangeError for hour >= 24', () => {
            expect(() => getNextSlot(24)).toThrow(RangeError);
            expect(() => getNextSlot(24)).toThrow('Hour must be between 0 and 23, got 24');
        });

        test('should throw RangeError for hour > 24', () => {
            expect(() => getNextSlot(25)).toThrow(RangeError);
            expect(() => getNextSlot(25)).toThrow('Hour must be between 0 and 23, got 25');
        });
    });

    describe.concurrent('all 24 hours return a named slot (never unscheduled)', () => {
        test.each<number>(Array.from({ length: 24 }, (_, i) => i))(
            'hour %d returns a named (non-unscheduled) slot',
            (hour: number) => {
                const slot = getNextSlot(hour);
                expect(slot).not.toBe('unscheduled');
                expect(typeof slot).toBe('string');
            }
        );
    });
});
