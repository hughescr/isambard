import { describe, test, expect } from 'bun:test';
import {
    type BaselineMeta,
    type SliceStamp,
    CACHE_KEY_PREFIX,
    DEFAULT_INCREMENTAL_PATH,
    DEFAULT_META_PATH,
    MAX_ANNOTATIONS,
    OVERDUE_DAYS,
    REFRESH_RUNS_COMMAND,
    SEED_COMMAND,
    SLICE_COUNT,
    USAGE,
    bucketFiles,
    collectSurvivors,
    dropSurvivors,
    emptyMeta,
    escapeData,
    escapeProperty,
    evaluateGate,
    fenceFor,
    finishSlice,
    fingerprintOfKey,
    loadMeta,
    parseArgs,
    parseJson,
    pickSlice,
    positivePatterns,
    selectFiles,
    serializeMeta,
    sliceOf
} from '../../../tools/mutation-baseline-core';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const NOW_ISO = '2026-11-17T12:00:00.000Z';
const FP = 'Linux-bun1.4.4-lockaaaa';
const OLD_FP = 'Linux-bun1.4.3-lockbbbb';
const DAY_MS = 86_400_000;

/** One file per slice: `P[i]` belongs to slice `i` (guarded by the first test). */
const P = [
    'src/f7.ts', 'src/f14.ts', 'src/f17.ts', 'src/f0.ts', 'src/f11.ts', 'src/f2.ts', 'src/f13.ts',
    'src/f3.ts', 'src/f6.ts', 'src/f27.ts', 'src/f8.ts', 'src/f1.ts', 'src/f4.ts', 'src/f39.ts',
] as const;

/** Every slice populated. */
const ALL_FILES: string[] = [...P];

function stamp(fingerprint: string, refreshedAt: string, runId = '1'): SliceStamp {
    return { fingerprint, refreshedAt, runId };
}

function metaOf(slices: Record<string, SliceStamp> = {}): BaselineMeta {
    return { schema: 1, sliceCount: 14, slices };
}

/** Stamps every slice 0..13 with the given fingerprint at `at`. */
function allStamped(fingerprint: string, at = '2026-11-16T00:00:00.000Z'): Record<string, SliceStamp> {
    return Object.fromEntries(P.map((_, i) => [String(i), stamp(fingerprint, at)]));
}

function keyFor(fingerprint: string): string {
    return `${CACHE_KEY_PREFIX}${fingerprint}-develop-abc-1-1`;
}

describe('sliceOf / bucketFiles', () => {
    test('maps paths by the first 8 hex chars of sha256, modulo 14', () => {
        expect(sliceOf('a')).toBe(2);
        expect(sliceOf('b')).toBe(4);
        expect(sliceOf('src/a.ts')).toBe(5);
        expect(sliceOf('src/b.ts')).toBe(13);
        expect(sliceOf('tools/x.ts')).toBe(7);
    });

    test('the fixture table puts P[i] in slice i', () => {
        expect(P.map(f => sliceOf(f))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
        expect(SLICE_COUNT).toBe(14);
    });

    test('buckets are 14 sorted lists with empty slices kept', () => {
        const buckets = bucketFiles(['src/b.ts', 'src/a.ts', 'src/f4.ts', 'src/f5.ts']);
        expect(buckets).toHaveLength(14);
        expect(buckets[5]).toEqual(['src/a.ts']);
        expect(buckets[13]).toEqual(['src/b.ts']);
        expect(buckets[12]).toEqual(['src/f4.ts', 'src/f5.ts']);
        expect(buckets[0]).toEqual([]);
    });

    test('does not reorder the caller list', () => {
        const input = ['src/b.ts', 'src/a.ts'];
        bucketFiles(input);
        expect(input).toEqual(['src/b.ts', 'src/a.ts']);
    });
});

describe('positivePatterns / selectFiles', () => {
    const patterns = ['src/**/*.ts', '!src/index.ts', 'tools/**/*.ts'];

    test('positivePatterns drops negations', () => {
        expect(positivePatterns(patterns)).toEqual(['src/**/*.ts', 'tools/**/*.ts']);
    });

    test('keeps matches of positive globs, honours negations, drops the rest, sorts and de-duplicates', () => {
        const selected = selectFiles(patterns, ['tools/z.ts', 'src/index.ts', 'src/a/b.ts', 'README.md', 'src/a/b.ts', 'src/c.ts']);
        expect(selected).toEqual(['src/a/b.ts', 'src/c.ts', 'tools/z.ts']);
    });

    test('a negation only removes what it matches', () => {
        expect(selectFiles(['src/**/*.ts', '!src/gen/**'], ['src/gen/x.ts', 'src/x.ts'])).toEqual(['src/x.ts']);
    });

    test('only a leading ! negates: a ! elsewhere in a glob is an ordinary character', () => {
        expect(positivePatterns(['src/a!b.ts', '!src/c.ts'])).toEqual(['src/a!b.ts']);
        expect(selectFiles(['src/a!b.ts'], ['src/a!b.ts', 'src/ab.ts'])).toEqual(['src/a!b.ts']);
        expect(selectFiles(['src/**/*.ts', '!src/c.ts'], ['src/c.ts', 'src/d.ts'])).toEqual(['src/d.ts']);
        // dropping the first character of this glob still matches the candidate, so a wrong negation test would exclude it
        expect(selectFiles(['**/a!b.ts'], ['src/a!b.ts'])).toEqual(['src/a!b.ts']);
    });

    test('a plain positive glob selects its matches (it is not also treated as a negation)', () => {
        expect(selectFiles(['**/*.ts'], ['src/a.ts', 'README.md'])).toEqual(['src/a.ts']);
    });

    test('no patterns select nothing', () => {
        expect(selectFiles([], ['src/a.ts'])).toEqual([]);
    });
});

describe('parseJson / loadMeta / serializeMeta', () => {
    test('parseJson returns undefined for no text, null for malformed text, the value otherwise', () => {
        expect(parseJson(undefined)).toBeUndefined();
        expect(parseJson('{nope')).toBeNull();
        expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    });

    test('emptyMeta has no stamps', () => {
        expect(emptyMeta()).toEqual({ schema: 1, sliceCount: 14, slices: {} });
    });

    test.each([
        ['a missing file', undefined],
        ['unparseable text', '{bad'],
        ['a JSON array', '[]'],
        ['null', 'null'],
        ['a wrong schema', JSON.stringify({ schema: 2, sliceCount: 14, slices: { '2': stamp(FP, NOW_ISO) } })],
        ['a wrong slice count', JSON.stringify({ schema: 1, sliceCount: 13, slices: { '2': stamp(FP, NOW_ISO) } })],
    ])('%s reads as an empty meta', (_name, raw) => {
        expect(loadMeta(raw)).toEqual(emptyMeta());
    });

    test('a valid file round-trips', () => {
        const meta = metaOf({ '0': stamp(FP, NOW_ISO, '77'), '13': stamp(OLD_FP, '2026-11-01T00:00:00.000Z', '5') });
        expect(loadMeta(serializeMeta(meta))).toEqual(meta);
    });

    test('serializeMeta is two-space JSON with a trailing newline', () => {
        expect(serializeMeta(emptyMeta())).toBe('{\n  "schema": 1,\n  "sliceCount": 14,\n  "slices": {}\n}\n');
    });

    test('a legacy toolchain key loads fine and is neither kept nor written back', () => {
        const raw = JSON.stringify({ schema: 1, sliceCount: 14, toolchain: { fingerprint: FP, since: NOW_ISO }, slices: { '2': stamp(FP, NOW_ISO) } });
        const meta = loadMeta(raw);
        expect(meta).toEqual(metaOf({ '2': stamp(FP, NOW_ISO) }));
        expect(serializeMeta(meta)).not.toContain('toolchain');
    });

    test('a missing or non-record slices field reads as no stamps', () => {
        expect(loadMeta(JSON.stringify({ schema: 1, sliceCount: 14 })).slices).toEqual({});
        expect(loadMeta(JSON.stringify({ schema: 1, sliceCount: 14, slices: [] })).slices).toEqual({});
    });

    test('keeps stamps for slices 0, 9, 10 and 13 and drops out-of-range or non-canonical keys', () => {
        const good = stamp(FP, NOW_ISO, '9');
        const slices = { '0': good, '9': good, '10': good, '13': good, '14': good, '99': good, '01': good, '-1': good, x: good, '': good, '1x': good, '100': good };
        const meta = loadMeta(JSON.stringify({ schema: 1, sliceCount: 14, slices }));
        expect(Object.keys(meta.slices).toSorted((a, b) => Number(a) - Number(b))).toEqual(['0', '9', '10', '13']);
    });

    test.each([
        ['a non-record stamp', 'x'],
        ['a stamp without a fingerprint', { refreshedAt: NOW_ISO, runId: '1' }],
        ['a stamp without refreshedAt', { fingerprint: FP, runId: '1' }],
        ['a stamp with an unparseable refreshedAt', { fingerprint: FP, refreshedAt: 'nope', runId: '1' }],
        ['a stamp without a runId', { fingerprint: FP, refreshedAt: NOW_ISO }],
        ['a stamp with a numeric runId', { fingerprint: FP, refreshedAt: NOW_ISO, runId: 1 }],
    ])('drops %s', (_name, bad) => {
        const meta = loadMeta(JSON.stringify({ schema: 1, sliceCount: 14, slices: { '3': bad, '4': stamp(FP, NOW_ISO) } }));
        expect(Object.keys(meta.slices)).toEqual(['4']);
    });

    test('keeps only the three stamp fields', () => {
        const meta = loadMeta(JSON.stringify({ schema: 1, sliceCount: 14, slices: { '3': { ...stamp(FP, NOW_ISO, 'r'), extra: true } } }));
        expect(meta.slices['3']).toEqual({ fingerprint: FP, refreshedAt: NOW_ISO, runId: 'r' });
    });
});

describe('fingerprintOfKey', () => {
    test('extracts the fingerprint from a v2 key', () => {
        expect(fingerprintOfKey(keyFor(FP))).toBe(FP);
        expect(fingerprintOfKey(`${CACHE_KEY_PREFIX}macOS-bun1.4.4-lock0123abcdef-lookup-9-1`)).toBe('macOS-bun1.4.4-lock0123abcdef');
        expect(fingerprintOfKey(`${CACHE_KEY_PREFIX}Linux-bun1.4.3-lockOLD-x`)).toBe('Linux-bun1.4.3-lockOLD');
    });

    test('returns undefined for anything else', () => {
        expect(fingerprintOfKey('stryker-incremental-v1-Linux-bun1.4.4-lockaaaa-x')).toBeUndefined();
        expect(fingerprintOfKey(`${CACHE_KEY_PREFIX}garbage`)).toBeUndefined();
        expect(fingerprintOfKey(`x${keyFor(FP)}`)).toBeUndefined();
    });
});

describe('evaluateGate', () => {
    const gate = (over: Partial<Parameters<typeof evaluateGate>[0]> = {}) => evaluateGate({
        meta:        metaOf(allStamped(FP)),
        files:       ALL_FILES,
        fingerprint: FP,
        matchedKey:  keyFor(FP),
        now:         NOW,
        ...over,
    });
    const daysAgo = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY_MS - extraMs).toISOString();

    test('a fully current baseline is green, with the exact summary', () => {
        const slices = { '5': stamp(FP, '2026-11-16T01:00:00.000Z'), '13': stamp(FP, '2026-11-16T02:00:00.000Z') };
        const result = gate({ meta: metaOf(slices), files: ['src/a.ts', 'src/b.ts'] });
        expect(result.exitCode).toBe(0);
        expect(result.errors).toEqual([]);
        expect(result.message).toBe('Baseline provenance ok');
        expect(result.summary).toBe([
            '## Mutation baseline',
            '',
            `- Matched cache key: \`${keyFor(FP)}\``,
            `- Current toolchain fingerprint: \`${FP}\``,
            '',
            '| Slice | Files | State | Refreshed at | Age (days) |',
            '| --- | --- | --- | --- | --- |',
            '| 5 | 1 | current | 2026-11-16T01:00:00.000Z | 1 |',
            '| 13 | 1 | current | 2026-11-16T02:00:00.000Z | 1 |',
            '',
        ].join('\n'));
    });

    test('the age column is whole days, rounded down', () => {
        const slices = { '0': stamp(FP, daysAgo(0)), '1': stamp(FP, daysAgo(2, -1)), '2': stamp(FP, daysAgo(2, 1)), '3': stamp(FP, daysAgo(30)) };
        const result = gate({ meta: metaOf(slices), files: [P[0], P[1], P[2], P[3]] });
        expect(result.summary).toContain(`| 0 | 1 | current | ${daysAgo(0)} | 0 |\n`);
        expect(result.summary).toContain(`| 1 | 1 | current | ${daysAgo(2, -1)} | 1 |\n`);
        expect(result.summary).toContain(`| 2 | 1 | current | ${daysAgo(2, 1)} | 2 |\n`);
        expect(result.summary).toContain(`| 3 | 1 | current | ${daysAgo(30)} | 30 |\n`);
    });

    test('a matched key of the current toolchain prints no inheritance line', () => {
        expect(gate().summary).not.toContain('inherited from toolchain');
    });

    test('a matched key of another toolchain prints one bold inheritance line naming it', () => {
        const result = gate({ matchedKey: keyFor(OLD_FP) });
        expect(result.summary).toContain(`\n**Baseline inherited from toolchain ${OLD_FP}**\n\n| Slice |`);
        expect(result.exitCode).toBe(0);
    });

    test('an unparseable foreign key is named verbatim', () => {
        const result = gate({ matchedKey: 'stryker-incremental-v2-odd' });
        expect(result.summary).toContain('**Baseline inherited from toolchain stryker-incremental-v2-odd**');
    });

    test('an empty matched key prints none and no inheritance line', () => {
        const result = gate({ matchedKey: '' });
        expect(result.summary).toContain('- Matched cache key: none\n');
        expect(result.summary).not.toContain('inherited from toolchain');
    });

    test('the current toolchain prefix must be at the start of the matched key', () => {
        const result = gate({ matchedKey: `prefix-${keyFor(FP)}` });
        expect(result.summary).toContain('**Baseline inherited from toolchain');
    });

    test('a key that merely starts with the fingerprint text is not the same toolchain', () => {
        const result = gate({ matchedKey: `${CACHE_KEY_PREFIX}${FP}9-develop-1-1` });
        expect(result.summary).toContain('**Baseline inherited from toolchain');
    });

    test('the table lists only non-empty slices with a state per row', () => {
        const slices = { '0': stamp(FP, '2026-11-16T00:00:00.000Z'), '1': stamp(OLD_FP, '2026-11-14T00:00:00.000Z') };
        const result = gate({
            meta:  metaOf(slices),
            files: [P[0], P[1]],
        });
        expect(result.summary).toContain('| 0 | 1 | current | 2026-11-16T00:00:00.000Z | 1 |\n');
        expect(result.summary).toContain(`| 1 | 1 | inherited from ${OLD_FP} | 2026-11-14T00:00:00.000Z | 3 |\n`);
        expect(result.summary).not.toContain('| 2 |');
        expect(result.exitCode).toBe(0);
    });

    test('a non-empty slice with no stamp is INCOMPLETE: red, naming every such slice and the seed command', () => {
        const stamps = allStamped(FP);
        delete stamps['3'];
        delete stamps['11'];
        const result = gate({ meta: metaOf(stamps) });
        const message = `BASELINE INCOMPLETE: slice(s) 3, 11 have never been refreshed. A seed is in progress or needed: ${SEED_COMMAND}`;
        expect(result.exitCode).toBe(1);
        expect(result.message).toBe(message);
        expect(result.errors).toEqual([`::error::${message}`]);
        expect(result.summary.endsWith(`|\n\n**${message}**\n`)).toBe(true);
        expect(result.summary).toContain('| 3 | 1 | never refreshed | - | - |\n');
        expect(SEED_COMMAND).toBe('gh workflow run mutation-baseline.yml --ref develop -f slots=14');
    });

    test('a slice with no files and no stamp does not make the baseline incomplete', () => {
        const stamps = allStamped(FP);
        delete stamps['3'];
        const result = gate({ meta: metaOf(stamps), files: P.filter((_, i) => i !== 3) });
        expect(result.exitCode).toBe(0);
        expect(result.summary).not.toContain('| 3 |');
    });

    test('a meta with no stamps at all is incomplete for every non-empty slice', () => {
        const result = gate({ meta: emptyMeta(), files: ['src/a.ts'] });
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('slice(s) 5 have never');
    });

    test('INCOMPLETE is checked before OVERDUE', () => {
        const stamps = allStamped(OLD_FP, daysAgo(30));
        delete stamps['2'];
        const result = gate({ meta: metaOf(stamps) });
        expect(result.message).toStartWith('BASELINE INCOMPLETE');
        expect(result.errors).toHaveLength(1);
    });

    test('an inherited slice refreshed exactly 10 days ago is not yet overdue', () => {
        const result = gate({ meta: metaOf(allStamped(OLD_FP, daysAgo(OVERDUE_DAYS))) });
        expect(result.exitCode).toBe(0);
        expect(result.errors).toEqual([]);
    });

    test('an inherited slice refreshed 10 days and 1 ms ago is OVERDUE', () => {
        const result = gate({ meta: metaOf(allStamped(OLD_FP, daysAgo(OVERDUE_DAYS, 1))) });
        expect(result.exitCode).toBe(1);
        expect(result.message).toStartWith('BASELINE OVERDUE: ');
    });

    test('a slice on the current fingerprint is never overdue, however old', () => {
        const result = gate({ meta: metaOf(allStamped(FP, daysAgo(30))) });
        expect(result.exitCode).toBe(0);
        expect(result.errors).toEqual([]);
        expect(result.message).toBe('Baseline provenance ok');
    });

    test('one overdue slice among merely inherited and current ones is the only one named', () => {
        const stamps = { ...allStamped(FP, daysAgo(30)), '4': stamp(OLD_FP, daysAgo(11)), '6': stamp(OLD_FP, daysAgo(3)), '9': stamp(OLD_FP, daysAgo(OVERDUE_DAYS)) };
        const result = gate({ meta: metaOf(stamps) });
        const message = `BASELINE OVERDUE: slice(s) 4 (inherited from ${OLD_FP}, refreshed ${daysAgo(11)}) have not been refreshed under toolchain ${FP} within 10 days. Check the nightly refresh runs: ${REFRESH_RUNS_COMMAND}`;
        expect(result.exitCode).toBe(1);
        expect(result.message).toBe(message);
        expect(result.errors).toEqual([`::error::${message}`]);
        expect(result.summary.endsWith(`\n**${message}**\n`)).toBe(true);
        expect(REFRESH_RUNS_COMMAND).toBe('gh run list --workflow mutation-baseline.yml');
    });

    test('every overdue slice is named with its own old fingerprint and refresh time, in slice order', () => {
        const older = 'Linux-bun1.4.0-lockcccc';
        const stamps = { ...allStamped(FP, daysAgo(1)), '4': stamp(OLD_FP, daysAgo(12)), '9': stamp(older, daysAgo(20)) };
        const result = gate({ meta: metaOf(stamps) });
        expect(result.message).toBe(`BASELINE OVERDUE: slice(s) 4 (inherited from ${OLD_FP}, refreshed ${daysAgo(12)}), 9 (inherited from ${older}, refreshed ${daysAgo(20)}) have not been refreshed under toolchain ${FP} within 10 days. Check the nightly refresh runs: ${REFRESH_RUNS_COMMAND}`);
    });

    test('a baseline wholly inherited from an older toolchain is fine while every slice is within 10 days', () => {
        const result = gate({ meta: metaOf(allStamped(OLD_FP, daysAgo(9))) });
        expect(result.exitCode).toBe(0);
        expect(result.summary).toContain(`inherited from ${OLD_FP}`);
    });

    test('an empty slice that is stale is ignored by the overdue check', () => {
        const stamps = { ...allStamped(FP), '3': stamp(OLD_FP, daysAgo(30)) };
        const result = gate({ meta: metaOf(stamps), files: P.filter((_, i) => i !== 3) });
        expect(result.exitCode).toBe(0);
    });

    test('gate returns no meta: it only reads', () => {
        expect(Object.keys(gate())).toEqual(['exitCode', 'summary', 'message', 'errors']);
    });
});

describe('pickSlice', () => {
    const pick = (meta: BaselineMeta, files: readonly string[] = ALL_FILES) => pickSlice({ meta, files, fingerprint: FP });
    const T1 = '2026-11-01T00:00:00.000Z';
    const T2 = '2026-11-02T00:00:00.000Z';
    const T3 = '2026-11-03T00:00:00.000Z';

    test('an unstamped slice beats everything, lowest index first', () => {
        const stamps = allStamped(OLD_FP, T1);
        delete stamps['6'];
        delete stamps['9'];
        const result = pick(metaOf(stamps));
        expect(result.slice).toBe(6);
        expect(result.exitCode).toBe(0);
    });

    test('an unstamped slice beats a stale one even when the stale one has an older index', () => {
        const stamps = { '0': stamp(OLD_FP, T1), '1': stamp(FP, T3) };
        expect(pick(metaOf(stamps), [P[0], P[1], P[2]]).slice).toBe(2);
    });

    test('a slice stamped under another fingerprint beats a current one, even a much older current one', () => {
        const stamps = { '0': stamp(FP, T1), '1': stamp(OLD_FP, T3), '2': stamp(FP, T1) };
        expect(pick(metaOf(stamps), [P[0], P[1], P[2]]).slice).toBe(1);
    });

    test('among inherited slices the oldest refreshedAt wins over a lower index', () => {
        const stamps = { '0': stamp(OLD_FP, T3), '1': stamp(OLD_FP, T1), '2': stamp(OLD_FP, T2) };
        expect(pick(metaOf(stamps), [P[0], P[1], P[2]]).slice).toBe(1);
    });

    test('slices on two different older fingerprints are ordered by refreshedAt alone', () => {
        const stamps = { '0': stamp(OLD_FP, T2), '1': stamp('Linux-bun1.4.0-lockcccc', T1), '2': stamp(FP, T1) };
        expect(pick(metaOf(stamps), [P[0], P[1], P[2]]).slice).toBe(1);
    });

    test('among current slices the oldest refreshedAt wins over a lower index', () => {
        const stamps = { '0': stamp(FP, T3), '1': stamp(FP, T2), '2': stamp(FP, T1) };
        expect(pick(metaOf(stamps), [P[0], P[1], P[2]]).slice).toBe(2);
    });

    test('equal refreshedAt falls back to the lowest index', () => {
        const stamps = { '3': stamp(FP, T1), '5': stamp(FP, T1), '4': stamp(FP, T1) };
        expect(pick(metaOf(stamps), [P[3], P[4], P[5]]).slice).toBe(3);
    });

    test('refreshedAt orders by instant, not by string', () => {
        const stamps = { '0': stamp(FP, '2026-11-01T01:00:00.000+02:00'), '1': stamp(FP, '2026-11-01T00:30:00.000Z') };
        expect(pick(metaOf(stamps), [P[0], P[1]]).slice).toBe(0);
    });

    test('empty slices are never picked', () => {
        expect(pick(emptyMeta(), [P[7]]).slice).toBe(7);
    });

    test('writes slice and the comma-joined sorted files of that slice to the outputs', () => {
        const result = pick(emptyMeta(), ['src/f5.ts', 'src/f4.ts', 'src/f10.ts', 'src/a.ts']);
        expect(result.slice).toBe(5);
        expect(result.files).toEqual(['src/a.ts']);
        const stampedFirst = pick(metaOf({ '5': stamp(FP, T1) }), ['src/f5.ts', 'src/f4.ts', 'src/f10.ts', 'src/a.ts']);
        expect(stampedFirst.slice).toBe(12);
        expect(stampedFirst.outputs).toBe('slice=12\nglobs=src/f10.ts,src/f4.ts,src/f5.ts\n');
        expect(stampedFirst.files).toEqual(['src/f10.ts', 'src/f4.ts', 'src/f5.ts']);
    });

    test('pick returns no meta: it only reads', () => {
        expect(Object.keys(pick(metaOf({ '2': stamp(OLD_FP, T1) }), [P[2]]))).toEqual(['exitCode', 'slice', 'files', 'outputs', 'summary', 'message']);
        expect(Object.keys(pick(emptyMeta(), []))).toEqual(['exitCode', 'slice', 'files', 'outputs', 'summary', 'message']);
    });

    test('the summary names the slice, its state and its file count', () => {
        expect(pick(emptyMeta(), [P[3], 'src/f19.ts']).message).toBe('Refreshing slice 3 (never refreshed, 2 files)');
        expect(pick(emptyMeta(), [P[3], 'src/f19.ts']).summary).toBe('Refreshing slice 3 (never refreshed, 2 files)\n');
        expect(pick(metaOf({ '3': stamp(OLD_FP, T1) }), [P[3]]).message).toBe(`Refreshing slice 3 (inherited from ${OLD_FP}, 1 files)`);
        expect(pick(metaOf({ '3': stamp(FP, T1) }), [P[3]]).message).toBe('Refreshing slice 3 (current, 1 files)');
    });

    test('an empty file universe picks nothing and fails', () => {
        const result = pick(emptyMeta(), []);
        expect(result).toMatchObject({ exitCode: 1, slice: undefined, files: [], outputs: '' });
        expect(result.message).toBe('No non-empty slice: the mutate globs matched no files');
        expect(result.summary).toBe('No non-empty slice: the mutate globs matched no files\n');
    });
});

interface MutantSpec {
    status:       string
    mutatorName?: string
    replacement?: string
    line?:        number
    column?:      number
}

function mutant(spec: MutantSpec): Record<string, unknown> {
    return {
        id:          'm',
        mutatorName: spec.mutatorName ?? 'ConditionalExpression',
        replacement: spec.replacement ?? 'true',
        location:    { start: { line: spec.line ?? 3, column: spec.column ?? 7 }, end: { line: 3, column: 9 } },
        status:      spec.status,
        coveredBy:   ['t1'],
    };
}

function report(files: Record<string, MutantSpec[]>): { files: Record<string, { language: string, mutants: unknown[] }> } {
    return {
        files: Object.fromEntries(Object.entries(files).map(([file, mutants]) => [file, { language: 'typescript', mutants: mutants.map(m => mutant(m)) }])),
    };
}

describe('collectSurvivors / dropSurvivors', () => {
    test('counts every mutant and lists Survived and NoCoverage in report order', () => {
        const r = report({
            'src/a.ts': [{ status: 'Killed' }, { status: 'Survived', mutatorName: 'A', replacement: 'x', line: 1, column: 2 }],
            'src/b.ts': [{ status: 'NoCoverage', mutatorName: 'B', replacement: 'y', line: 4, column: 5 }, { status: 'Timeout' }, { status: 'Ignored' }],
        });
        expect(collectSurvivors(r)).toEqual({
            total:     5,
            survivors: [
                { file: 'src/a.ts', line: 1, column: 2, mutator: 'A', status: 'Survived', replacement: 'x' },
                { file: 'src/b.ts', line: 4, column: 5, mutator: 'B', status: 'NoCoverage', replacement: 'y' },
            ],
        });
    });

    test('tolerates mutants with missing location, mutator or replacement', () => {
        const r = { files: { 'src/a.ts': { mutants: [{ status: 'Survived' }, { status: 'Survived', location: {} }, { status: 'Survived', location: { start: { line: 'x', column: 'y' } } }] } } };
        const bare = { file: 'src/a.ts', line: 0, column: 0, mutator: 'unknown', status: 'Survived' as const, replacement: '' };
        expect(collectSurvivors(r)).toEqual({ total: 3, survivors: [bare, bare, bare] });
    });

    test('a non-string mutatorName or replacement falls back', () => {
        const r = { files: { 'src/a.ts': { mutants: [{ status: 'Survived', mutatorName: 3, replacement: 4 }] } } };
        expect(collectSurvivors(r)?.survivors[0]).toMatchObject({ mutator: 'unknown', replacement: '' });
    });

    test('ignores non-record mutants and file entries without a mutants array', () => {
        const r = { files: { 'a.ts': { mutants: [null, 'x', 5, []] }, 'b.ts': 'x', 'c.ts': { mutants: 'x' }, 'd.ts': null } };
        expect(collectSurvivors(r)).toEqual({ total: 4, survivors: [] });
    });

    test.each([['undefined', undefined], ['null', null], ['a string', 'x'], ['an array', []], ['an empty object', {}], ['an array files map', { files: [] }], ['a null files map', { files: null }], ['a string files map', { files: 'x' }]])('%s has no usable files map', (_name, bad) => {
        expect(collectSurvivors(bad)).toBeUndefined();
    });

    test('dropSurvivors deletes exactly Survived and NoCoverage entries and keeps every other field', () => {
        const r = {
            schemaVersion: '2',
            thresholds:    { high: 100 },
            files:         {
                'src/a.ts': { language: 'typescript', source: 'x', mutants: [mutant({ status: 'Killed' }), mutant({ status: 'Survived' }), mutant({ status: 'NoCoverage' }), mutant({ status: 'Timeout' })] },
                'src/b.ts': { mutants: [mutant({ status: 'Survived' })] },
                'src/c.ts': 'odd',
                'src/d.ts': { other: 1 },
            },
        };
        const before = JSON.stringify(r);
        const dropped = dropSurvivors(r);
        expect(dropped).toEqual({
            schemaVersion: '2',
            thresholds:    { high: 100 },
            files:         {
                'src/a.ts': { language: 'typescript', source: 'x', mutants: [mutant({ status: 'Killed' }), mutant({ status: 'Timeout' })] },
                'src/b.ts': { mutants: [] },
                'src/c.ts': 'odd',
                'src/d.ts': { other: 1 },
            },
        });
        expect(JSON.stringify(r)).toBe(before);
    });

    test('dropSurvivors returns an unusable report as is', () => {
        const odd = { files: 5 };
        expect(dropSurvivors(odd)).toBe(odd);
        expect(dropSurvivors(undefined)).toBeUndefined();
    });
});

describe('escapes and fences', () => {
    test('escapeData encodes %, CR and LF only', () => {
        expect(escapeData('100%\r\nx: a,b')).toBe('100%25%0D%0Ax: a,b');
    });

    test('escapeProperty also encodes colon and comma', () => {
        expect(escapeProperty('a:b,c%\n')).toBe('a%3Ab%2Cc%25%0A');
    });

    test('fenceFor is three backticks, or one more than the longest backtick run', () => {
        expect(fenceFor('')).toBe('```');
        expect(fenceFor('a`b')).toBe('```');
        expect(fenceFor('``')).toBe('```');
        expect(fenceFor('```')).toBe('````');
        expect(fenceFor('a```b``````c`')).toBe('`'.repeat(7));
    });
});

describe('finishSlice', () => {
    const base = {
        strykerExit: 0,
        slice:       4,
        meta:        metaOf({ '1': stamp(OLD_FP, '2026-11-01T00:00:00.000Z', 'old') }),
        fingerprint: FP,
        runId:       '999',
        now:         NOW,
    };

    test('no survivors and exit 0: re-earned, stamps the slice, keeps the report, saves', () => {
        const r = report({ 'src/a.ts': [{ status: 'Killed' }, { status: 'Killed' }], 'src/b.ts': [{ status: 'Timeout' }] });
        const result = finishSlice({ ...base, report: r });
        expect(result.exitCode).toBe(0);
        expect(result.save).toBe(true);
        expect(result.message).toBe('slice 4 re-earned: 3 mutants, 0 survivors');
        expect(result.summary).toBe('slice 4 re-earned: 3 mutants, 0 survivors\n');
        expect(result.annotations).toEqual([]);
        if(!result.save) {
            throw new Error('expected save');
        }
        expect(result.report).toEqual(r);
        expect(result.meta).toEqual(metaOf({
            '1': stamp(OLD_FP, '2026-11-01T00:00:00.000Z', 'old'),
            '4': stamp(FP, NOW_ISO, '999'),
        }));
    });

    test('a non-zero Stryker exit with no survivors changes nothing: exit 2, save false', () => {
        const result = finishSlice({ ...base, strykerExit: 1, report: report({ 'src/a.ts': [{ status: 'Killed' }] }) });
        expect(result).toEqual({
            exitCode:    2,
            save:        false,
            summary:     'Slice 4 not saved: Stryker exited 1 without any Survived or NoCoverage mutant, so this is not a threshold failure.\n',
            message:     'Slice 4 not saved: Stryker exited 1 without any Survived or NoCoverage mutant, so this is not a threshold failure.',
            annotations: [],
        });
    });

    test.each([['undefined', undefined], ['null', null], ['an empty object', {}], ['a numeric files map', { files: 3 }]])('an unusable incremental report (%s) is exit 2 even when Stryker exited 0', (_name, bad) => {
        const result = finishSlice({ ...base, report: bad });
        expect(result.exitCode).toBe(2);
        expect(result.save).toBe(false);
        expect(result.message).toBe('Slice 4 not saved: the incremental report is missing or unreadable.');
    });

    test('survivors with a non-zero exit: removes them, stamps, saves, exit 1', () => {
        const r = report({ 'src/a.ts': [{ status: 'Killed' }, { status: 'Survived', mutatorName: 'StringLiteral', replacement: '"x"', line: 12, column: 5 }], 'src/b.ts': [{ status: 'NoCoverage', mutatorName: 'BlockStatement', replacement: '{}', line: 2, column: 1 }] });
        const result = finishSlice({ ...base, strykerExit: 1, report: r });
        expect(result.exitCode).toBe(1);
        expect(result.save).toBe(true);
        if(!result.save) {
            throw new Error('expected save');
        }
        expect(collectSurvivors(result.report)).toEqual({ total: 1, survivors: [] });
        expect(result.meta.slices['4']).toEqual(stamp(FP, NOW_ISO, '999'));
        expect(result.message).toBe('Slice 4 refreshed with 2 mutant(s) surviving under the current toolchain');
        expect(result.summary).toBe([
            '## Mutation baseline refresh: slice 4',
            '',
            '**Slice 4 refreshed with 2 mutant(s) surviving under the current toolchain.** They were removed from the saved baseline; kill them with tests or the next gate run re-executes them.',
            '',
            'src/a.ts:12:5  StringLiteral  Survived',
            '',
            '```',
            '"x"',
            '```',
            '',
            'src/b.ts:2:1  BlockStatement  NoCoverage',
            '',
            '```',
            '{}',
            '```',
            '',
        ].join('\n'));
        expect(result.annotations).toEqual([
            '::error file=src/a.ts,line=12,col=5::Mutant survived under the current toolchain: StringLiteral (Survived) replaced with "x"',
            '::error file=src/b.ts,line=2,col=1::Mutant survived under the current toolchain: BlockStatement (NoCoverage) replaced with {}',
        ]);
    });

    test('survivors with exit 0 are still removed and reported (threshold not enforced upstream)', () => {
        const result = finishSlice({ ...base, report: report({ 'src/a.ts': [{ status: 'Survived' }] }) });
        expect(result.exitCode).toBe(1);
        expect(result.save).toBe(true);
    });

    test('a replacement containing a backtick run gets a longer fence', () => {
        const result = finishSlice({ ...base, report: report({ 'src/a.ts': [{ status: 'Survived', replacement: 'a ``` b' }] }) });
        expect(result.summary).toContain('\n````\na ``` b\n````\n');
    });

    test('annotation text is single-line and escaped, with the file escaped as a property', () => {
        const result = finishSlice({ ...base, report: report({ 'src/we,ird:name.ts': [{ status: 'Survived', replacement: 'a\n  b 100%', line: 1, column: 1 }] }) });
        expect(result.annotations).toEqual(['::error file=src/we%2Cird%3Aname.ts,line=1,col=1::Mutant survived under the current toolchain: ConditionalExpression (Survived) replaced with a b 100%25']);
        expect(result.summary).toContain('\na\n  b 100%\n');
    });

    test('annotation replacement is trimmed of surrounding whitespace', () => {
        const result = finishSlice({ ...base, report: report({ 'a.ts': [{ status: 'Survived', replacement: '\n  x  \n' }] }) });
        expect(result.annotations[0]).toEndWith('replaced with x');
    });

    test('annotation replacement is cut at 120 characters with an ellipsis, but 120 is kept whole', () => {
        const exact = 'x'.repeat(120);
        const over = 'x'.repeat(121);
        const a = finishSlice({ ...base, report: report({ 'a.ts': [{ status: 'Survived', replacement: exact }] }) });
        const b = finishSlice({ ...base, report: report({ 'a.ts': [{ status: 'Survived', replacement: over }] }) });
        expect(a.annotations[0]).toEndWith(`replaced with ${exact}`);
        expect(b.annotations[0]).toEndWith(`replaced with ${exact}…`);
    });

    test('annotations are capped at 10 while the summary lists every survivor', () => {
        const mutants = Array.from({ length: MAX_ANNOTATIONS + 2 }, (_, i) => ({ status: 'Survived', line: i + 1, column: 1 }));
        const result = finishSlice({ ...base, report: report({ 'a.ts': mutants }) });
        expect(result.annotations).toHaveLength(10);
        expect(result.annotations[9]).toContain('line=10,');
        expect(result.summary).toContain('a.ts:12:1  ');
        expect(result.summary).toEndWith('\n\nAnnotations are capped at 10; every survivor is listed above.\n');
    });

    test('exactly 10 survivors get 10 annotations and no cap note', () => {
        const mutants = Array.from({ length: MAX_ANNOTATIONS }, (_, i) => ({ status: 'Survived', line: i + 1, column: 1 }));
        const result = finishSlice({ ...base, report: report({ 'a.ts': mutants }) });
        expect(result.annotations).toHaveLength(10);
        expect(result.summary).not.toContain('capped');
    });

    test('does not mutate its inputs', () => {
        const r = report({ 'a.ts': [{ status: 'Survived' }] });
        const before = JSON.stringify(r);
        const metaBefore = JSON.stringify(base.meta);
        finishSlice({ ...base, report: r });
        expect(JSON.stringify(r)).toBe(before);
        expect(JSON.stringify(base.meta)).toBe(metaBefore);
    });
});

describe('parseArgs', () => {
    const argv = (...rest: string[]) => ['bun', 'tools/mutation-baseline.ts', ...rest];

    test('gate and pick take no flags and default the two paths', () => {
        expect(parseArgs(argv('gate'))).toEqual({ ok: true, args: { command: 'gate', slice: 0, strykerExit: 0, incrementalPath: DEFAULT_INCREMENTAL_PATH, metaPath: DEFAULT_META_PATH } });
        expect(parseArgs(argv('pick'))).toMatchObject({ ok: true, args: { command: 'pick' } });
        expect(DEFAULT_INCREMENTAL_PATH).toBe('reports/stryker-incremental.json');
        expect(DEFAULT_META_PATH).toBe('reports/stryker-baseline-meta.json');
    });

    test('finish needs --slice and --stryker-exit', () => {
        expect(parseArgs(argv('finish', '--slice', '13', '--stryker-exit', '137'))).toEqual({ ok: true, args: { command: 'finish', slice: 13, strykerExit: 137, incrementalPath: DEFAULT_INCREMENTAL_PATH, metaPath: DEFAULT_META_PATH } });
        expect(parseArgs(argv('finish', '--stryker-exit', '0', '--slice', '0'))).toMatchObject({ ok: true, args: { slice: 0, strykerExit: 0 } });
    });

    test('path flags override the defaults', () => {
        expect(parseArgs(argv('gate', '--incremental', 'a.json', '--meta', 'm.json'))).toMatchObject({ ok: true, args: { incrementalPath: 'a.json', metaPath: 'm.json' } });
    });

    test.each([
        ['no command', []],
        ['an unknown command', ['bake']],
        ['finish without flags', ['finish']],
        ['finish without --stryker-exit', ['finish', '--slice', '1']],
        ['finish without --slice', ['finish', '--stryker-exit', '1']],
        ['a slice of 14', ['finish', '--slice', '14', '--stryker-exit', '0']],
        ['a negative slice', ['finish', '--slice', '-1', '--stryker-exit', '0']],
        ['a fractional slice', ['finish', '--slice', '1.5', '--stryker-exit', '0']],
        ['a non-numeric slice', ['finish', '--slice', 'x', '--stryker-exit', '0']],
        ['a non-numeric exit code', ['finish', '--slice', '1', '--stryker-exit', 'x']],
        ['a negative exit code', ['finish', '--slice', '1', '--stryker-exit', '-1']],
        ['an unknown flag', ['gate', '--bogus', '1']],
        ['a flag without a value', ['gate', '--meta']],
        ['a stray positional', ['gate', 'extra']],
    ])('%s is a usage error', (_name, rest) => {
        expect(parseArgs(argv(...rest))).toEqual({ ok: false, message: USAGE });
    });

    test('an invalid --slice on gate is ignored, not an error', () => {
        expect(parseArgs(argv('gate', '--slice', '99'))).toMatchObject({ ok: true, args: { slice: 0 } });
    });

    test('the usage text names the three commands', () => {
        expect(USAGE).toBe('Usage: bun tools/mutation-baseline.ts <gate|pick|finish --slice <0-13> --stryker-exit <code>> [--incremental <path>] [--meta <path>]');
    });
});
