import { describe, test, expect } from 'bun:test';
import { formatSlotName } from '@/agent/perch/prompts';
import type { PerchSlot } from '@/agent/perch/types';

describe.concurrent('formatSlotName', () => {
    test('is exported and covers every slot', () => {
        const expected: Record<PerchSlot, string> = {
            'pre-dawn':    'Pre-Dawn (5-7am Pacific)',
            'mid-morning': 'Mid-Morning (9-11am Pacific)',
            wikipedia:     'Wikipedia Exploration (12pm-2pm Pacific)',
            afternoon:     'Afternoon (2-4pm Pacific)',
            evening:       'Evening (6-8pm Pacific)',
            'late-night':  'Late Night (11pm-1am Pacific)',
            unscheduled:   'Unscheduled',
        };
        for(const [slot, label] of Object.entries(expected) as [PerchSlot, string][]) {
            expect(formatSlotName(slot)).toBe(label);
        }
    });

    test('throws on an unknown slot', () => {
        const invalidSlot = 'bogus-slot' as PerchSlot;
        expect(() => formatSlotName(invalidSlot)).toThrow('Unknown slot: bogus-slot');
    });
});
