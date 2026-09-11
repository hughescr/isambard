/**
 * The per-turn ambient lines (docs/plans/session-peers-and-quota.md block 4): the other
 * session's one-line summary and the shared-subscription quota line, composed purely from the
 * two ledgers. No clock is read — `now` is passed in, exactly as every envelope builder does.
 */
import { describe, expect, it } from 'bun:test';
import { QUOTA_LINE_PREFIX, composeAmbientLines, withAmbientLines, type ComposeAmbientLinesParams } from '@/agent/session/ambient-lines';
import { initialLedger, type Ledger, type LedgerQuota, type LedgerTask, type LedgerTurn } from '@/agent/session/ledger';
import type { ProviderSnapshot } from '@/agent/session/quota-poller';

const TIMEZONE = 'America/Los_Angeles';
// tests/setup.ts mocks Intl.DateTimeFormat with a fixed, DST-free -8 offset for this zone, so
// every stamp below is UTC-8 rather than the real September (PDT) offset.
/** Wednesday 2026-09-09, 14:07 in {@link TIMEZONE}. */
const NOW = new Date('2026-09-09T22:07:00Z');
/** Same local day as {@link NOW}: 14:02. */
const TODAY_1402 = new Date('2026-09-09T22:02:00Z');
/** Same local day as {@link NOW}: 15:00. */
const TODAY_1500 = new Date('2026-09-09T23:00:00Z');
/** The next local day: Thursday 09:00. */
const THU_0900 = new Date('2026-09-10T17:00:00Z');

function turn(overrides: Partial<LedgerTurn> = {}): LedgerTurn {
    return { id: 'turn-1', kind: 'discord', startedAt: NOW, phase: null, interrupting: false, ...overrides };
}

function task(overrides: Partial<LedgerTask> = {}): LedgerTask {
    return {
        id:          'task-1',
        taskType:    'local_agent',
        kind:        'subagent',
        description: 'some work',
        background:  true,
        startedAt:   NOW,
        status:      'running',
        ...overrides,
    };
}

function ledger(role: Ledger['role'], overrides: Partial<Ledger> = {}): Ledger {
    return { ...initialLedger(role), ...overrides };
}

function compose(overrides: Partial<ComposeAmbientLinesParams> = {}): string[] {
    return composeAmbientLines({ self: ledger('conversation'), now: NOW, timezone: TIMEZONE, ...overrides });
}

describe('composeAmbientLines: the other-session line', () => {
    it('renders nothing at all when there is no other ledger and no quota', () => {
        expect(compose()).toEqual([]);
    });

    it('renders `idle since <local time>` from the other ledger\'s last turn end', () => {
        const other = ledger('perch', { lastTurnEndedAt: TODAY_1402 });

        expect(compose({ other })).toEqual(['Perch: idle since 14:02']);
    });

    it('renders a bare `idle` when the other session has not finished a turn on this process', () => {
        expect(compose({ other: ledger('perch') })).toEqual(['Perch: idle']);
    });

    it('labels the conversation ledger `Conversation`', () => {
        expect(compose({ self: ledger('perch'), other: ledger('conversation') })).toEqual(['Conversation: idle']);
    });

    it('stamps an idle time from a previous local day with its weekday', () => {
        const other = ledger('perch', { lastTurnEndedAt: new Date('2026-09-08T22:02:00Z') });

        expect(compose({ other })).toEqual(['Perch: idle since Tue 14:02']);
    });

    it('renders the perch slot and its end time from the open perch turn\'s envelope meta', () => {
        const other = ledger('perch', { turn: turn({ kind: 'perch' }), perch: { slot: 'reflection', endsAt: TODAY_1500 } });

        expect(compose({ other })).toEqual(['Perch: slot "reflection" until 15:00']);
    });

    it('omits the `until` clause when the open perch turn carried no slot end', () => {
        const other = ledger('perch', { turn: turn({ kind: 'perch' }), perch: { slot: 'reflection' } });

        expect(compose({ other })).toEqual(['Perch: slot "reflection"']);
    });

    it('falls back to the phase verb for a perch turn whose envelope carried no slot at all', () => {
        const other = ledger('perch', { turn: turn({ kind: 'perch' }) });

        expect(compose({ other })).toEqual(['Perch: working']);
    });

    it('ignores the sticky perch slot once the perch turn has ended', () => {
        const other = ledger('perch', { perch: { slot: 'reflection', endsAt: TODAY_1500 }, lastTurnEndedAt: TODAY_1402 });

        expect(compose({ other })).toEqual(['Perch: idle since 14:02']);
    });

    it('ignores the sticky perch slot for a non-perch turn running on the perch session', () => {
        const other = ledger('perch', { turn: turn({ kind: 'discord', phase: { type: 'responding', startedAt: NOW } }), perch: { slot: 'reflection' } });

        expect(compose({ other })).toEqual(['Perch: replying']);
    });

    it.each([
        ['responding', { type: 'responding', startedAt: NOW }, 'Conversation: replying'],
        ['thinking', { type: 'thinking', startedAt: NOW }, 'Conversation: thinking'],
        ['compacting', { type: 'compacting', startedAt: NOW }, 'Conversation: compacting'],
        ['using_tool', { type: 'using_tool', toolName: 'Read', startedAt: NOW }, 'Conversation: using Read'],
    ] as const)('renders the %s phase as its own verb', (_name, phase, expected) => {
        const other = ledger('conversation', { turn: turn({ phase }) });

        expect(compose({ self: ledger('perch'), other })).toEqual([expected]);
    });

    it('falls back to `working` for an open turn with no phase yet', () => {
        const other = ledger('conversation', { turn: turn() });

        expect(compose({ self: ledger('perch'), other })).toEqual(['Conversation: working']);
    });

    it('appends the phase digest when the ledger carries a generated synopsis', () => {
        const other = ledger('conversation', { turn: turn({ phase: { type: 'thinking', startedAt: NOW, generatedStatus: 'drafting the reply' } }) });

        expect(compose({ self: ledger('perch'), other })).toEqual(['Conversation: thinking, working on drafting the reply']);
    });

    it('appends no digest for a compacting phase, which carries none', () => {
        const other = ledger('conversation', { turn: turn({ phase: { type: 'compacting', startedAt: NOW, trigger: 'auto' } }) });

        expect(compose({ self: ledger('perch'), other })).toEqual(['Conversation: compacting']);
    });

    it('counts one running workflow', () => {
        const other = ledger('perch', { turn: turn({ kind: 'perch' }), perch: { slot: 'reflection', endsAt: TODAY_1500 }, tasks: [task({ kind: 'workflow' })] });

        expect(compose({ other })).toEqual(['Perch: slot "reflection" until 15:00, 1 workflow running']);
    });

    it('pluralises workflows and counts every other running task separately', () => {
        const other = ledger('perch', {
            tasks: [task({ id: 'w1', kind: 'workflow' }), task({ id: 'w2', kind: 'workflow' }), task({ id: 's1', kind: 'subagent' })],
        });

        expect(compose({ other })).toEqual(['Perch: idle, 2 workflows running, 1 task running']);
    });

    it('pluralises non-workflow tasks', () => {
        const other = ledger('perch', { tasks: [task({ id: 's1' }), task({ id: 's2' })] });

        expect(compose({ other })).toEqual(['Perch: idle, 2 tasks running']);
    });

    it('orders the parts as activity, digest, then task counts', () => {
        const other = ledger('conversation', {
            turn:  turn({ phase: { type: 'responding', startedAt: NOW, generatedStatus: 'summarising' } }),
            tasks: [task({ kind: 'workflow' })],
        });

        expect(compose({ self: ledger('perch'), other })).toEqual(['Conversation: replying, working on summarising, 1 workflow running']);
    });
});

const QUOTA: LedgerQuota = {
    fiveHour: { utilization: 42, resetsAt: TODAY_1500 },
    sevenDay: { utilization: 61, resetsAt: THU_0900 },
    source:   'headers',
    at:       NOW,
};

describe('composeAmbientLines: the quota line', () => {
    it('renders both windows with their reset stamps', () => {
        const self = ledger('conversation', { quota: QUOTA });

        expect(compose({ self })).toEqual(['Quota: Anthropic fallback (SDK/direct) 5-hour 42% used (resets 15:00) · week 61% used (resets Thu 09:00) (source 14:07)']);
    });

    it('omits the quota line entirely when no window is known', () => {
        expect(compose({ self: ledger('conversation'), other: ledger('perch') })).toEqual(['Perch: idle']);
    });

    it('omits the quota line when only per-model windows are known', () => {
        const self = ledger('conversation', { quota: { perModel: { seven_day_opus: { utilization: 12 } }, source: 'poll', at: NOW } });

        expect(compose({ self })).toEqual([]);
    });

    it('renders a window with no reset stamp as a bare percentage', () => {
        const self = ledger('conversation', { quota: { fiveHour: { utilization: 42 }, source: 'headers', at: NOW } });

        expect(compose({ self })).toEqual(['Quota: Anthropic fallback (SDK/direct) 5-hour 42% used (source 14:07)']);
    });

    it('renders the weekly window alone when the five-hour window is unknown', () => {
        const self = ledger('conversation', { quota: { sevenDay: { utilization: 61 }, source: 'headers', at: NOW } });

        expect(compose({ self })).toEqual(['Quota: Anthropic fallback (SDK/direct) week 61% used (source 14:07)']);
    });

    it('rounds utilization to whole percent', () => {
        const self = ledger('conversation', { quota: { fiveHour: { utilization: 42.5 }, sevenDay: { utilization: 61.4 }, source: 'headers', at: NOW } });

        expect(compose({ self })).toEqual(['Quota: Anthropic fallback (SDK/direct) 5-hour 43% used · week 61% used (source 14:07)']);
    });

    it('falls back to the other session\'s quota when this session has seen none', () => {
        const other = ledger('perch', { quota: QUOTA });

        expect(compose({ other })).toEqual([
            'Perch: idle',
            'Quota: Anthropic fallback (SDK/direct) 5-hour 42% used (resets 15:00) · week 61% used (resets Thu 09:00) (source 14:07)',
        ]);
    });

    it('prefers this session\'s own reading of a window when the two ledgers are equally fresh', () => {
        const self = ledger('conversation', { quota: { fiveHour: { utilization: 7 }, sevenDay: { utilization: 8 }, source: 'headers', at: NOW } });
        const other = ledger('perch', { quota: QUOTA });

        expect(compose({ self, other })).toEqual(['Perch: idle', 'Quota: Anthropic fallback (SDK/direct) 5-hour 7% used · week 8% used (source 14:07)']);
    });

    it('takes the other session\'s reading of a window when it is the newer of the two', () => {
        // rate_limit_event frames fold only into the emitting role's ledger, so a quiet
        // conversation can hold an arbitrarily old reading while perch's is current.
        const self = ledger('conversation', { quota: { fiveHour: { utilization: 20 }, source: 'headers', at: TODAY_1402 } });
        const other = ledger('perch', { quota: { fiveHour: { utilization: 80 }, sevenDay: { utilization: 70 }, source: 'headers', at: NOW } });

        expect(compose({ self, other })).toEqual(['Perch: idle', 'Quota: Anthropic fallback (SDK/direct) 5-hour 80% used · week 70% used (source 14:07)']);
    });

    it('keeps this session\'s reading of a window the newer ledger does not carry at all', () => {
        // quotaWindowsFromFrame files only the window that tripped the emit when the frame
        // carries no unifiedWindows, so the newer ledger can legitimately know less.
        const self = ledger('conversation', { quota: { sevenDay: { utilization: 61, resetsAt: THU_0900 }, source: 'headers', at: TODAY_1402 } });
        const other = ledger('perch', { quota: { fiveHour: { utilization: 80 }, source: 'headers', at: NOW } });

        expect(compose({ self, other })).toEqual(['Perch: idle', 'Quota: Anthropic fallback (SDK/direct) 5-hour 80% used · week 61% used (resets Thu 09:00) (source 14:07)']);
    });

    it('keeps this session\'s reading of every window when it is the newer ledger', () => {
        const self = ledger('conversation', { quota: { fiveHour: { utilization: 20 }, source: 'headers', at: NOW } });
        const other = ledger('perch', { quota: { fiveHour: { utilization: 80 }, sevenDay: { utilization: 70 }, source: 'headers', at: TODAY_1402 } });

        expect(compose({ self, other })).toEqual(['Perch: idle', 'Quota: Anthropic fallback (SDK/direct) 5-hour 20% used · week 70% used (source 14:07)']);
    });

    it('appends the shared-subscription note when asked for it', () => {
        const self = ledger('conversation', { quota: QUOTA });

        expect(compose({ self, sharedQuotaNote: true })).toEqual([
            'Quota: Anthropic fallback (SDK/direct) 5-hour 42% used (resets 15:00) · week 61% used (resets Thu 09:00) (source 14:07) · shared with Craig\'s own sessions',
        ]);
    });

    it('renders no note, and no quota line at all, when the note is asked for but nothing is known', () => {
        expect(compose({ sharedQuotaNote: true })).toEqual([]);
    });

    it('every rendered quota line starts with the exported prefix the caller keys the once-note off', () => {
        const self = ledger('conversation', { quota: QUOTA });

        expect(compose({ self })[0]?.startsWith(QUOTA_LINE_PREFIX)).toBe(true);
    });
});

function providerSnapshot(usedPercent: number, reset = THU_0900): ProviderSnapshot {
    return {
        generatedAt: NOW,
        expiresAt:   new Date(NOW.getTime() + 600_000),
        providers:   [{
            provider:    'codex', status:      'ok', lastAttempt: NOW,
            freshness:   { cached: false, stale: false, ageSeconds: 0 }, errors:      [],
            quotaAfter:  {
                source:        'codex', collectedAt:   NOW, available:     true,
                quotas:        [{ id: 'weekly_primary', slot: 'primary', group: 'general', usedPercent, durationSeconds: 604_800, resetsAt: reset }],
                balances:      [], spendControls: [],
            },
        }, {
            provider:    'deepseek', status:      'ok', lastAttempt: NOW,
            freshness:   { cached: false, stale: false, ageSeconds: 0 }, errors:      [],
            quotaAfter:  {
                source:        'deepseek', collectedAt:   NOW, available:     true, quotas:        [], spendControls: [],
                balances:      [{ kind: 'prepaid', currency: 'USD', total: '9.35', available: true }],
            },
        }],
    };
}

describe('composeAmbientLines: provider reports', () => {
    it('preserves quota id, slot, group, duration and reset while keeping money a balance', () => {
        const line = compose({ providerSnapshot: providerSnapshot(35) })[0] ?? '';
        expect(line).toContain('Codex weekly_primary [group=general, slot=primary, window=1w] 35% used/65% left');
        expect(line).toContain('Deepseek prepaid USD 9.35 balance');
    });

    it('shows burn only for comparable samples in the same reset window', () => {
        const snapshot = providerSnapshot(35);
        const prior = providerSnapshot(25);
        prior.generatedAt = new Date(NOW.getTime() - 3_600_000);
        prior.providers[0].quotaAfter!.collectedAt = prior.generatedAt;
        snapshot.previous = prior;
        expect(compose({ providerSnapshot: snapshot })[0]).toContain('+10.0pp/h shared burn');

        prior.providers[0].quotaAfter!.quotas[0].resetsAt = new Date(THU_0900.getTime() - 1000);
        expect(compose({ providerSnapshot: snapshot })[0]).not.toContain('pp/h');
    });

    it('does not render an expired report as fresh capacity', () => {
        const snapshot = providerSnapshot(35);
        snapshot.expiresAt = new Date(NOW.getTime() - 1);
        expect(compose({ providerSnapshot: snapshot })[0]).toContain('Codex unavailable (stale; ok; 14:07)');
    });
});

describe('withAmbientLines', () => {
    it('returns the header unchanged when there are no lines', () => {
        expect(withAmbientLines('## Current Time\n- UTC: now', [])).toBe('## Current Time\n- UTC: now');
    });

    it('appends each line as one more bullet under the header', () => {
        expect(withAmbientLines('## Current Time\n- UTC: now', ['Perch: idle', 'Quota: 5-hour 42% used']))
            .toBe('## Current Time\n- UTC: now\n- Perch: idle\n- Quota: 5-hour 42% used');
    });
});
