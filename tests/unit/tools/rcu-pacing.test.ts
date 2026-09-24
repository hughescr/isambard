import { describe, expect, mock, test } from 'bun:test';
import { paceAfterRead, pacingDelayMs, parseRcuRate, requireConsumedReadUnits } from '../../../tools/rcu-pacing';

describe('requireConsumedReadUnits', () => {
    test('returns the reported units, zero included', () => {
        expect(requireConsumedReadUnits(2.5, 'BatchGetItem')).toBe(2.5);
        expect(requireConsumedReadUnits(0, 'BatchGetItem')).toBe(0);
    });

    test('fails closed, naming the request, when DynamoDB omitted ConsumedCapacity', () => {
        expect(() => requireConsumedReadUnits(undefined, 'GSI1 query for events')).toThrow(
            new Error('GSI1 query for events reported no ConsumedCapacity; refusing to continue without RCU pacing')
        );
    });
});

describe('pacingDelayMs', () => {
    test('owes consumed RCU / rate seconds, less the time already spent', () => {
        expect(pacingDelayMs({ consumedReadUnits: 4, rateLimitRcuPerSec: 2, startedAtMs: 1000, nowMs: 1500 })).toBe(1500);
        expect(pacingDelayMs({ consumedReadUnits: 1, rateLimitRcuPerSec: 4, startedAtMs: 0, nowMs: 0 })).toBe(250);
    });

    test('never goes negative when the request took longer than its budget', () => {
        expect(pacingDelayMs({ consumedReadUnits: 1, rateLimitRcuPerSec: 2, startedAtMs: 0, nowMs: 900 })).toBe(0);
    });
});

describe('paceAfterRead', () => {
    test('sleeps for exactly the owed delay', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        await paceAfterRead({ consumedReadUnits: 3, rateLimitRcuPerSec: 2, startedAtMs: 100, now: () => 600, sleep });
        expect(sleep.mock.calls).toEqual([[1000]]);
    });

    test('does not sleep at all when nothing is owed, including exactly zero', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        await paceAfterRead({ consumedReadUnits: 1, rateLimitRcuPerSec: 2, startedAtMs: 0, now: () => 500, sleep });
        await paceAfterRead({ consumedReadUnits: 0, rateLimitRcuPerSec: 2, startedAtMs: 0, now: () => 0, sleep });
        expect(sleep).not.toHaveBeenCalled();
    });

    test('waits for the sleep before resolving', async () => {
        const gate = Promise.withResolvers<undefined>();
        let resolved = false;
        const pending = paceAfterRead({ consumedReadUnits: 1, rateLimitRcuPerSec: 1, startedAtMs: 0, now: () => 0, sleep: async () => gate.promise })
            .then(() => {
                resolved = true;
                return undefined;
            });
        await Promise.resolve();
        expect(resolved).toBe(false);
        gate.resolve(undefined);
        await pending;
        expect(resolved).toBe(true);
    });
});

describe('parseRcuRate', () => {
    test('accepts positive finite numbers, up to and including the maximum', () => {
        expect(parseRcuRate('2')).toBe(2);
        expect(parseRcuRate('0.5')).toBe(0.5);
        expect(parseRcuRate('5', 5)).toBe(5);
        expect(parseRcuRate('1e6')).toBe(1_000_000);
    });

    test.each([
        [undefined, '(missing)'],
        ['', ''],
        ['0', '0'],
        ['-1', '-1'],
        ['NaN', 'NaN'],
        ['abc', 'abc'],
        ['Infinity', 'Infinity'],
    ])('rejects %p without a maximum', (value, shown) => {
        expect(() => parseRcuRate(value)).toThrow(new Error(`Invalid --rate-limit-rcu-per-sec value: ${shown}. Must be a positive number.`));
    });

    test('rejects a value above the maximum, naming the bound', () => {
        expect(() => parseRcuRate('5.01', 5)).toThrow(new Error('Invalid --rate-limit-rcu-per-sec value: 5.01. Must be a positive number no greater than 5.'));
        expect(() => parseRcuRate('0', 5)).toThrow(new Error('Invalid --rate-limit-rcu-per-sec value: 0. Must be a positive number no greater than 5.'));
    });
});
