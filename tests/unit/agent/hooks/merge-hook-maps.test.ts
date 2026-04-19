import { describe, test, expect } from 'bun:test';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { mergeHookMaps } from '../../../../src/agent/hooks/index';

const makeMatcher = (id: string): HookCallbackMatcher => ({
    hooks: [async () => ({ 'continue': true, _id: id } as { 'continue': boolean })],
});

describe('mergeHookMaps', () => {
    describe('empty inputs', () => {
        test('returns empty object for no maps', () => {
            const result = mergeHookMaps();
            expect(result).toEqual({});
        });

        test('returns copy of single map when no overlap', () => {
            const map = { TaskCreated: [makeMatcher('a')] };
            const result = mergeHookMaps(map);
            expect(result.TaskCreated).toHaveLength(1);
        });
    });

    describe('non-overlapping events', () => {
        test('includes all events from both maps', () => {
            const map1 = { TaskCreated: [makeMatcher('a')] };
            const map2 = { TaskCompleted: [makeMatcher('b')] };
            const result = mergeHookMaps(map1, map2);
            expect(result.TaskCreated).toHaveLength(1);
            expect(result.TaskCompleted).toHaveLength(1);
        });

        test('includes events from three non-overlapping maps', () => {
            const map1 = { Stop: [makeMatcher('stop')] };
            const map2 = { SessionStart: [makeMatcher('start')] };
            const map3 = { PreCompact: [makeMatcher('pre')] };
            const result = mergeHookMaps(map1, map2, map3);
            expect(result.Stop).toHaveLength(1);
            expect(result.SessionStart).toHaveLength(1);
            expect(result.PreCompact).toHaveLength(1);
        });
    });

    describe('overlapping events', () => {
        test('concatenates matchers when two maps share the same event', () => {
            const matcher1 = makeMatcher('first');
            const matcher2 = makeMatcher('second');
            const map1 = { TaskCreated: [matcher1] };
            const map2 = { TaskCreated: [matcher2] };
            const result = mergeHookMaps(map1, map2);
            expect(result.TaskCreated).toHaveLength(2);
            expect(result.TaskCreated?.[0]).toBe(matcher1);
            expect(result.TaskCreated?.[1]).toBe(matcher2);
        });

        test('preserves order across three maps with same event', () => {
            const m1 = makeMatcher('first');
            const m2 = makeMatcher('second');
            const m3 = makeMatcher('third');
            const result = mergeHookMaps({ Stop: [m1] }, { Stop: [m2] }, { Stop: [m3] });
            expect(result.Stop).toHaveLength(3);
            expect(result.Stop?.[0]).toBe(m1);
            expect(result.Stop?.[1]).toBe(m2);
            expect(result.Stop?.[2]).toBe(m3);
        });

        test('handles multiple matchers per event in one map', () => {
            const m1 = makeMatcher('a');
            const m2 = makeMatcher('b');
            const m3 = makeMatcher('c');
            const map1 = { SessionEnd: [m1, m2] };
            const map2 = { SessionEnd: [m3] };
            const result = mergeHookMaps(map1, map2);
            expect(result.SessionEnd).toHaveLength(3);
        });
    });

    describe('null/undefined inputs', () => {
        test('skips undefined maps without throwing', () => {
            const map = { TaskCreated: [makeMatcher('a')] };
            const result = mergeHookMaps(undefined, map);
            expect(result.TaskCreated).toHaveLength(1);
        });

        test('skips null maps without throwing', () => {
            const map = { TaskCompleted: [makeMatcher('b')] };
            const result = mergeHookMaps(null, map);
            expect(result.TaskCompleted).toHaveLength(1);
        });

        test('returns correct result with undefined between two valid maps', () => {
            const m1 = makeMatcher('x');
            const m2 = makeMatcher('y');
            const result = mergeHookMaps({ Stop: [m1] }, undefined, { Stop: [m2] });
            expect(result.Stop).toHaveLength(2);
            expect(result.Stop?.[0]).toBe(m1);
            expect(result.Stop?.[1]).toBe(m2);
        });

        test('returns empty object for only undefined/null maps', () => {
            const result = mergeHookMaps(undefined, null, undefined);
            expect(result).toEqual({});
        });
    });

    describe('isolation', () => {
        test('does not mutate the input maps', () => {
            const m1 = makeMatcher('a');
            const m2 = makeMatcher('b');
            const map1 = { TaskCreated: [m1] };
            const map2 = { TaskCreated: [m2] };
            mergeHookMaps(map1, map2);
            expect(map1.TaskCreated).toHaveLength(1);
            expect(map2.TaskCreated).toHaveLength(1);
        });

        test('returned object is a new object reference', () => {
            const map = { TaskCreated: [makeMatcher('a')] };
            const result = mergeHookMaps(map);
            expect(result).not.toBe(map);
        });
    });
});
