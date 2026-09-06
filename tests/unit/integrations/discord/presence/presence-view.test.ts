import { describe, test, expect } from 'bun:test';
import { FakeClock } from '../../../../helpers/fake-clock';
import { type Ledger, initialLedger  } from '@/agent';
import {
    composePresence,
    renderPresenceText,
    createPresenceThrottle,
    planPresenceUpdate,
    type PresenceView
} from '@/integrations/discord/presence/presence-view';

/** A minimal conversation-kind turn open since `startedAt`, with an optional explicit phase. */
function openTurn(overrides: Partial<Ledger['turn']> = {}): NonNullable<Ledger['turn']> {
    return {
        id:           'turn-1',
        kind:         'discord',
        startedAt:    new Date(0),
        phase:        null,
        interrupting: false,
        ...overrides,
    };
}

function task(kind: string, id: string): Ledger['tasks'][number] {
    return { id, taskType: kind, kind: kind as Ledger['tasks'][number]['kind'], description: 'x', startedAt: new Date(0) };
}

describe('presence-view', () => {
    describe('composePresence', () => {
        test('conversation turn only: live [conversation], prefix 💬', () => {
            const conversation: Ledger = { ...initialLedger('conversation'), turn: openTurn() };
            const perch: Ledger = initialLedger('perch');

            const view = composePresence([conversation, perch]);

            expect(view.live).toEqual(['conversation']);
            expect(view.prefix).toBe('💬');
            expect(view.activeRole).toBe('conversation');
        });

        test('perch turn only: live [perch], prefix 🦉', () => {
            const conversation: Ledger = initialLedger('conversation');
            const perch: Ledger = { ...initialLedger('perch'), turn: openTurn({ kind: 'perch' }) };

            const view = composePresence([conversation, perch]);

            expect(view.live).toEqual(['perch']);
            expect(view.prefix).toBe('🦉');
            expect(view.activeRole).toBe('perch');
        });

        test('both turns open: prefix 💬🦉, conversation phase wins', () => {
            const convPhase = { type: 'thinking' as const, startedAt: new Date(1) };
            const perchPhase = { type: 'responding' as const, startedAt: new Date(2) };
            const conversation: Ledger = { ...initialLedger('conversation'), turn: openTurn({ phase: convPhase }) };
            const perch: Ledger = { ...initialLedger('perch'), turn: openTurn({ kind: 'perch', phase: perchPhase }) };

            const view = composePresence([conversation, perch]);

            expect(view.live).toEqual(['conversation', 'perch']);
            expect(view.prefix).toBe('💬🦉');
            expect(view.activeRole).toBe('conversation');
            expect(view.phase).toBe(convPhase);
        });

        test('neither turn open: prefix 💤, phase idle, activeRole null', () => {
            const conversation: Ledger = initialLedger('conversation');
            const perch: Ledger = initialLedger('perch');

            const view = composePresence([conversation, perch]);

            expect(view.live).toEqual([]);
            expect(view.prefix).toBe('💤');
            expect(view.phase).toEqual({ type: 'idle', since: expect.any(Date) as unknown as Date });
            expect(view.activeRole).toBeNull();
        });

        test('open turn with no phase yet resolves to a synthesized thinking phase at turn.startedAt', () => {
            const startedAt = new Date(5);
            const conversation: Ledger = { ...initialLedger('conversation'), turn: openTurn({ startedAt, phase: null }) };
            const perch: Ledger = initialLedger('perch');

            const view = composePresence([conversation, perch]);

            expect(view.phase).toEqual({ type: 'thinking', startedAt });
        });

        test('task counts: union of both ledgers, zeros omitted, in 🔬 🪾 ⌚ order', () => {
            const conversation: Ledger = {
                ...initialLedger('conversation'),
                turn:  openTurn(),
                tasks: [task('subagent', 't1'), task('subagent', 't2'), task('shell', 't3')],
            };
            const perch: Ledger = {
                ...initialLedger('perch'),
                tasks: [task('workflow', 't4'), task('monitor', 't5')],
            };

            const view = composePresence([conversation, perch]);

            expect(view.prefix).toBe('💬 • 2 🔬 1 🪾 1 ⌚');
        });

        test('task counts omitted entirely when there are none', () => {
            const conversation: Ledger = { ...initialLedger('conversation'), turn: openTurn() };
            const perch: Ledger = initialLedger('perch');

            const view = composePresence([conversation, perch]);

            expect(view.prefix).toBe('💬');
        });

        test('shell tasks are never rendered even alone', () => {
            const conversation: Ledger = { ...initialLedger('conversation'), tasks: [task('shell', 't1')] };
            const perch: Ledger = initialLedger('perch');

            const view = composePresence([conversation, perch]);

            expect(view.prefix).toBe('💤');
        });

        test('compacting true when the conversation ledger is compacting', () => {
            const conversation: Ledger = { ...initialLedger('conversation'), compaction: 'compacting' };
            const perch: Ledger = initialLedger('perch');

            expect(composePresence([conversation, perch]).compacting).toBe(true);
        });

        test('compacting true when the perch ledger is compacting', () => {
            const conversation: Ledger = initialLedger('conversation');
            const perch: Ledger = { ...initialLedger('perch'), compaction: 'compacting' };

            expect(composePresence([conversation, perch]).compacting).toBe(true);
        });

        test('compacting false when neither ledger is compacting', () => {
            const conversation: Ledger = initialLedger('conversation');
            const perch: Ledger = initialLedger('perch');

            expect(composePresence([conversation, perch]).compacting).toBe(false);
        });
    });

    describe('renderPresenceText', () => {
        const baseView: PresenceView = {
            live:       ['conversation'],
            prefix:     '💬',
            compacting: false,
            phase:      { type: 'thinking', startedAt: new Date(0) },
            activeRole: 'conversation',
        };

        test('undefined digest returns just the prefix', () => {
            expect(renderPresenceText(baseView, undefined)).toBe('💬');
        });

        test('joins prefix and digest with a separator', () => {
            expect(renderPresenceText(baseView, 'short digest')).toBe('💬 • short digest');
        });

        test('inserts the compacting marker between prefix and digest', () => {
            const view: PresenceView = { ...baseView, compacting: true };
            expect(renderPresenceText(view, 'thinking hard')).toBe('💬 • compacting • thinking hard');
        });

        test('compacting marker present even with no digest', () => {
            const view: PresenceView = { ...baseView, compacting: true };
            expect(renderPresenceText(view, undefined)).toBe('💬 • compacting');
        });

        test('digest is truncated at a word boundary to fit the 128 code-unit budget', () => {
            const longDigest = 'word '.repeat(40).trim(); // way over budget, all spaces
            const result = renderPresenceText(baseView, longDigest);

            expect(result.length).toBeLessThanOrEqual(128);
            expect(result).toStartWith('💬 • word word');
            expect(result).toEndWith('…');
        });

        test('digest is dropped when fewer than 12 characters would remain', () => {
            // Build a prefix that leaves less than 12 chars of budget for the digest.
            const bigPrefix = 'X'.repeat(120);
            const view: PresenceView = { ...baseView, prefix: bigPrefix };

            const result = renderPresenceText(view, 'this would not fit');

            expect(result).toBe(bigPrefix);
        });

        test('prefix is never truncated even with a very long digest and a long prefix', () => {
            const bigPrefix = 'X'.repeat(200);
            const view: PresenceView = { ...baseView, prefix: bigPrefix };

            const result = renderPresenceText(view, 'anything at all here');

            expect(result).toBe(bigPrefix);
            expect(result).toHaveLength(200);
        });

        test('digest included when exactly 12 code units remain (the boundary)', () => {
            // 128 - 3 (separator) - 12 (remaining) = 113. "twelve chars" is exactly 12 code
            // units, so it survives truncateToWordBoundary unchanged when it fits.
            const prefix = 'X'.repeat(113);
            const view: PresenceView = { ...baseView, prefix };

            const result = renderPresenceText(view, 'twelve chars');

            expect(result).toBe(`${prefix} • twelve chars`);
        });

        test('digest dropped when exactly 11 code units remain (one below the boundary)', () => {
            // 128 - 3 (separator) - 11 (remaining) = 114
            const prefix = 'X'.repeat(114);
            const view: PresenceView = { ...baseView, prefix };

            const result = renderPresenceText(view, 'twelve chars');

            expect(result).toBe(prefix);
        });
    });

    describe('createPresenceThrottle', () => {
        test('allows the first update with no prior record', () => {
            const clock = new FakeClock(0);
            const throttle = createPresenceThrottle(12_000, clock.now);

            expect(throttle.shouldUpdate()).toBe(true);
        });

        test('blocks an update inside the throttle window after recording', () => {
            const clock = new FakeClock(0);
            const throttle = createPresenceThrottle(12_000, clock.now);

            throttle.record();
            clock.advance(11_999);

            expect(throttle.shouldUpdate()).toBe(false);
        });

        test('allows an update exactly at the throttle window boundary', () => {
            const clock = new FakeClock(0);
            const throttle = createPresenceThrottle(12_000, clock.now);

            throttle.record();
            clock.advance(12_000);

            expect(throttle.shouldUpdate()).toBe(true);
        });
    });

    describe('planPresenceUpdate', () => {
        const idleView: PresenceView = {
            live:       [],
            prefix:     '💤',
            compacting: false,
            phase:      { type: 'idle', since: new Date(0) },
            activeRole: null,
        };
        const activeView: PresenceView = {
            live:       ['conversation'],
            prefix:     '💬',
            compacting: false,
            phase:      { type: 'thinking', startedAt: new Date(0) },
            activeRole: 'conversation',
        };

        test('idle is always applied and recorded even inside the throttle window', () => {
            const clock = new FakeClock(0);
            const throttle = createPresenceThrottle(12_000, clock.now);
            throttle.record();
            clock.advance(1);

            const plan = planPresenceUpdate(idleView, throttle);

            expect(plan).toEqual({ kind: 'idle' });
            // Recording resets the window: a subsequent active plan right after is blocked.
            expect(planPresenceUpdate(activeView, throttle)).toBeNull();
        });

        test('active is blocked inside the throttle window and does not record', () => {
            const clock = new FakeClock(0);
            const throttle = createPresenceThrottle(12_000, clock.now);
            throttle.record();
            clock.advance(1);

            const plan = planPresenceUpdate(activeView, throttle);

            expect(plan).toBeNull();
            // Not recorded: the window is unchanged, so it's still blocked a moment later too.
            clock.advance(1);
            expect(planPresenceUpdate(activeView, throttle)).toBeNull();
        });

        test('active is allowed and recorded once the throttle window has passed', () => {
            const clock = new FakeClock(0);
            const throttle = createPresenceThrottle(12_000, clock.now);
            throttle.record();
            clock.advance(12_000);

            const plan = planPresenceUpdate(activeView, throttle);

            expect(plan).toEqual({ kind: 'active', view: activeView });
            // Recorded: immediately blocked again.
            expect(planPresenceUpdate(activeView, throttle)).toBeNull();
        });
    });
});
