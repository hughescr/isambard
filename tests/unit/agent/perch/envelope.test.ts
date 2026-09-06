import { describe, test, expect } from 'bun:test';
import {
    buildPerchSlotEnvelope,
    buildPerchWrapUpEnvelope,
    computeSlotEndsAt
} from '@/agent/perch/envelope';

const now = new Date('2026-09-04T22:07:00Z');
const timezone = 'America/Los_Angeles';
const timeHeader = '## Current Time\n- Izzy: 2026-09-04T14:07:00 America/Los_Angeles (Friday afternoon)';

describe('computeSlotEndsAt', () => {
    test('adds maxSessionMinutes (in ms) to the trigger time', () => {
        const endsAt = computeSlotEndsAt(now, 45);
        expect(endsAt).toEqual(new Date(now.getTime() + 45 * 60_000));
    });

    test('uses a distinct duration correctly (ArithmeticOperator survivor guard)', () => {
        const endsAt = computeSlotEndsAt(now, 5);
        expect(endsAt).toEqual(new Date('2026-09-04T22:12:00Z'));
    });
});

describe('buildPerchSlotEnvelope', () => {
    test('renders the perch header with the formatted slot name and ends-at time, timeHeader first in body', () => {
        const endsAt = computeSlotEndsAt(now, 45);
        const envelope = buildPerchSlotEnvelope({
            slot: 'evening', now, timezone, endsAt, timeHeader, perchContext: 'Nothing urgent is pending.',
        });

        const header = '[PERCH · Evening (6-8pm Pacific) slot · 2026-09-04 14:07 PT · ends 14:52]';
        expect(envelope.text.startsWith(`${header}\n\n${timeHeader}`)).toBe(true);
        expect(envelope.kind).toBe('perch');
    });

    test('renders the slot hint and perch context', () => {
        const endsAt = computeSlotEndsAt(now, 45);
        const envelope = buildPerchSlotEnvelope({
            slot: 'pre-dawn', now, timezone, endsAt, timeHeader, perchContext: 'Nothing urgent is pending.',
        });

        expect(envelope.text).toContain('Craig wakes around 7am');
        expect(envelope.text).toContain('Nothing urgent is pending.');
    });

    test('renders a higher suggestion level for a strongly-suggestive slot than a light-touch slot', () => {
        const endsAt = computeSlotEndsAt(now, 45);
        const strong = buildPerchSlotEnvelope({
            slot: 'pre-dawn', now, timezone, endsAt, timeHeader, perchContext: 'context',
        });
        const light = buildPerchSlotEnvelope({
            slot: 'evening', now, timezone, endsAt, timeHeader, perchContext: 'context',
        });

        expect(strong.text).toContain('Suggestion level: 3 of 3.');
        expect(light.text).toContain('Suggestion level: 1 of 3.');
    });

    test('appends a background summary to the suggestion line when given', () => {
        const endsAt = computeSlotEndsAt(now, 45);
        const envelope = buildPerchSlotEnvelope({
            slot: 'afternoon', now, timezone, endsAt, timeHeader, perchContext: 'context', backgroundSummary: 'one task in flight',
        });

        expect(envelope.text).toContain('Suggestion level: 1 of 3. Background: one task in flight');
    });

    test('omits the background clause when no summary is given', () => {
        const endsAt = computeSlotEndsAt(now, 45);
        const envelope = buildPerchSlotEnvelope({
            slot: 'afternoon', now, timezone, endsAt, timeHeader, perchContext: 'context',
        });

        expect(envelope.text).not.toContain('Background:');
    });

    test('omits the hint and uses suggestion level 0 for the unscheduled slot', () => {
        const endsAt = computeSlotEndsAt(now, 45);
        const envelope = buildPerchSlotEnvelope({
            slot: 'unscheduled', now, timezone, endsAt, timeHeader, perchContext: 'context',
        });

        expect(envelope.text).toContain('Suggestion level: 0 of 3.');
        expect(envelope.text).toContain('[PERCH · Unscheduled slot ·');
    });
});

describe('buildPerchWrapUpEnvelope', () => {
    test('renders the wrap-up header with leadMinutes', () => {
        const envelope = buildPerchWrapUpEnvelope({ now, leadMinutes: 5 });

        expect(envelope.text).toContain('[WRAP-UP · perch slot ends in 5 min]');
        expect(envelope.kind).toBe('wrapup');
    });

    test('uses a distinct leadMinutes value correctly (literal survivor guard)', () => {
        const envelope = buildPerchWrapUpEnvelope({ now, leadMinutes: 9 });

        expect(envelope.text).toContain('9 min');
        expect(envelope.text).not.toContain('5 min');
    });
});
