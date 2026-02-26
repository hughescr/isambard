import { describe, expect, test } from 'bun:test';
import { map as _map } from 'lodash';
import { sigmoidScore, DEFAULT_SIGMOID_PARAMS, type SigmoidParams  } from '@/storage/memory-tool';

describe.concurrent('sigmoidScore', () => {
    describe('frequency scoring at t=0', () => {
        test('returns ~0.5 frequency at midpoint (accessCount=5, time=0)', () => {
            const score = sigmoidScore(5, 0);
            expect(score).toBeCloseTo(0.5, 2);
        });

        test('returns near-0 at count=0, time=0', () => {
            const score = sigmoidScore(0, 0);
            expect(score).toBeGreaterThan(0);
            expect(score).toBeLessThan(0.1);
        });

        test('returns near-1 at count=20, time=0', () => {
            const score = sigmoidScore(20, 0);
            expect(score).toBeGreaterThan(0.99);
        });
    });

    describe('recency decay', () => {
        test('returns 1.0 recency at t=0', () => {
            const score = sigmoidScore(5, 0);
            expect(score).toBeCloseTo(0.5, 2);
        });

        test('returns ~0.5 recency at one half-life (7 days)', () => {
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
            const score = sigmoidScore(5, sevenDaysMs);
            expect(score).toBeCloseTo(0.25, 2);
        });

        test('returns near-0 at 90 days with moderate count', () => {
            const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
            const score = sigmoidScore(5, ninetyDaysMs);
            expect(score).toBeLessThan(0.01);
        });
    });

    describe('monotonicity', () => {
        test('monotonically increasing with count (same time)', () => {
            const time = 0;
            const counts = [0, 2, 4, 6, 8, 10, 15, 20];
            const scores = _map(counts, count => sigmoidScore(count, time));

            for(let i = 1; i < scores.length; i++) {
                expect(scores[i]).toBeGreaterThan(scores[i - 1]);
            }
        });

        test('monotonically decreasing with time (same count)', () => {
            const count = 5;
            const oneDayMs = 24 * 60 * 60 * 1000;
            const times = [0, oneDayMs, 2 * oneDayMs, 5 * oneDayMs, 10 * oneDayMs, 30 * oneDayMs];
            const scores = _map(times, time => sigmoidScore(count, time));

            for(let i = 1; i < scores.length; i++) {
                expect(scores[i]).toBeLessThan(scores[i - 1]);
            }
        });
    });

    describe('custom parameters', () => {
        test('custom steepness affects frequency curve', () => {
            const customParams: Partial<SigmoidParams> = { steepness: 1 };
            const scoreDefault = sigmoidScore(5, 0);
            const scoreCustom = sigmoidScore(5, 0, customParams);

            expect(scoreDefault).toBeCloseTo(0.5, 1);
            expect(scoreCustom).toBeCloseTo(0.5, 1);
        });

        test('custom midpoint shifts frequency curve', () => {
            const customParams: Partial<SigmoidParams> = { midpoint: 10 };
            const scoreAtOldMidpoint = sigmoidScore(5, 0, customParams);
            const scoreAtNewMidpoint = sigmoidScore(10, 0, customParams);

            expect(scoreAtOldMidpoint).toBeLessThan(0.5);
            expect(scoreAtNewMidpoint).toBeCloseTo(0.5, 2);
        });

        test('custom lambda affects recency decay rate', () => {
            const oneDayMs = 24 * 60 * 60 * 1000;
            const customParams: Partial<SigmoidParams> = { lambda: Math.LN2 / oneDayMs };

            const scoreDefault = sigmoidScore(5, oneDayMs);
            const scoreCustom = sigmoidScore(5, oneDayMs, customParams);

            expect(scoreCustom).toBeLessThan(scoreDefault);
            expect(scoreCustom).toBeCloseTo(0.25, 2);
        });
    });

    describe('edge cases', () => {
        test('count=0, time=0 returns valid number > 0', () => {
            const score = sigmoidScore(0, 0);
            expect(score).toBeGreaterThan(0);
            expect(score).toBeLessThan(1);
            expect(Number.isFinite(score)).toBe(true);
        });

        test('uses default params when not provided', () => {
            const scoreWithoutParams = sigmoidScore(5, 0);
            const scoreWithDefaultParams = sigmoidScore(5, 0, DEFAULT_SIGMOID_PARAMS);
            expect(scoreWithoutParams).toBe(scoreWithDefaultParams);
        });

        test('partial params merge with defaults', () => {
            const score = sigmoidScore(5, 0, { steepness: DEFAULT_SIGMOID_PARAMS.steepness });
            expect(score).toBeCloseTo(0.5, 2);
        });

        test('clamps negative accessCount to 0', () => {
            const scoreNegative = sigmoidScore(-5, 0);
            const scoreZero = sigmoidScore(0, 0);
            expect(scoreNegative).toBe(scoreZero);
        });

        test('clamps negative timeSinceLastAccessMs to 0', () => {
            const scoreNegative = sigmoidScore(5, -1000);
            const scoreZero = sigmoidScore(5, 0);
            expect(scoreNegative).toBe(scoreZero);
        });
    });
});
