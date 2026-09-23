import { describe, expect, it } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { Conductor } from '../../../../src/agent/session/conductor';
import { buildBootEnvelope, buildCompactEnvelope, buildPeerEnvelope } from '../../../../src/agent/session/envelope';
import { ENVELOPE_KINDS, type Envelope, type EnvelopeMeta, type JournalEntry, type SessionQuery } from '../../../../src/agent/session/types';
import type { SystemEvent } from '../../../../src/agent/types';
import { FakeQuery } from '../../../helpers/fake-query';

// Compile-time-only assertions live in this file; each `describe`/`it` below carries exactly
// one runtime `expect` so `jest/expect-expect` is satisfied without pretending these are
// behavioural tests.

describe('SessionQuery', () => {
    it('is satisfiable by FakeQuery with no `as` casts', () => {
        const q: SessionQuery = new FakeQuery();

        expect(q).toBeInstanceOf(FakeQuery);
    });

    it('is assignable from the real SDK Query by return-type covariance', () => {
        type RealQueryAssignable = Query extends SessionQuery ? true : never;
        // The runtime value of `ok` is only ever reachable at all when the type alias above
        // resolved to `true` — if `Query` stopped structurally satisfying `SessionQuery`, this
        // line would fail to compile rather than fail at runtime, so the assertion is not
        // trivial: it can only run once the compiler has already proven the type-level claim.
        const ok: RealQueryAssignable = true;

        // eslint-disable-next-line sonarjs/no-trivial-assertions -- see comment above: reachability of this line IS the assertion; `ok` is only constructible when the type alias resolved to `true`
        expect(ok).toBe(true);
    });
});

describe('ENVELOPE_KINDS', () => {
    it('lists exactly the 10 envelope kinds, including \'task\' (R2) and \'peer\' (session-peers block 2) — an \'each\' table-driven test over an emptied array would silently run zero cases rather than fail, so this pins the full contents directly', () => {
        expect(ENVELOPE_KINDS).toEqual(['discord', 'perch', 'notification', 'catchup', 'wrapup', 'resume', 'compact', 'boot', 'task', 'peer']);
    });
});

describe('Envelope.peer', () => {
    it('carries the peer\'s reply address and, when the cross-session tag named one, its peer-registry name', () => {
        const envelope: Envelope = {
            id:           'p1',
            mode:         'adopted',
            kind:         'peer',
            text:         '[PEER · Izzy-main · 2026-09-09 14:02 PDT]',
            peer:         { from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-main' },
            hostPriority: 'wake',
            createdAt:    new Date('2026-09-09T21:02:00Z'),
        };

        expect(envelope.peer).toEqual({ from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-main' });
    });
});

// Each `@ts-expect-error` below is the assertion: it fails to compile the moment the line under
// it starts type-checking, i.e. the moment the contract it pins stops being enforced by the
// compiler. The runtime `expect` only satisfies `jest/expect-expect`.
describe('envelope contracts (#60)', () => {
    const createdAt = new Date('2026-09-23T00:00:00Z');
    const peer = buildPeerEnvelope({ from: 'uds:/tmp/cc-socks/1.sock', text: 'hi', now: createdAt, timezone: 'UTC', timeHeader: '' });
    const boot = buildBootEnvelope('[BOOT]', createdAt);
    const compact = buildCompactEnvelope(createdAt);

    it('an adopted peer envelope is not assignable to submit()\'s parameter', () => {
        // @ts-expect-error -- an adopted peer turn was already started by the SDK; submitting it would push it a second time
        const submitted: Parameters<Conductor['submit']>[0] = peer;

        expect<unknown>(submitted).toBe(peer);
    });

    it('a boot (accumulation) envelope is not assignable to submit()\'s parameter', () => {
        // @ts-expect-error -- an accumulation envelope never opens a turn
        const submitted: Parameters<Conductor['submit']>[0] = boot;

        expect<unknown>(submitted).toBe(boot);
    });

    it('a query envelope is not assignable to appendWithoutTurn()\'s parameter, while a boot envelope is', () => {
        // @ts-expect-error -- a query envelope opens a turn; appending it would let its bare ack settle nothing
        const appended: Parameters<Conductor['appendWithoutTurn']>[0] = compact;
        const bootAppended: Parameters<Conductor['appendWithoutTurn']>[0] = boot;

        expect<unknown[]>([appended, bootAppended]).toEqual([compact, boot]);
    });

    it('only an adopted peer envelope is assignable to adoptPeerTurn()\'s parameter', () => {
        // @ts-expect-error -- the adopted turn IS this envelope, so it must be a peer envelope
        const adopted: Parameters<Conductor['adoptPeerTurn']>[0] = compact;
        const peerAdopted: Parameters<Conductor['adoptPeerTurn']>[0] = peer;

        expect<unknown[]>([adopted, peerAdopted]).toEqual([compact, peer]);
    });

    it('rejects a discord envelope carrying peer metadata', () => {
        // @ts-expect-error -- peer metadata belongs only to the adopted peer contract
        const discordWithPeer: Envelope = {
            id: 'd1', mode: 'query', kind: 'discord', text: 't', channelId: 'c', authorId: 'a', origin: { kind: 'human' }, hostPriority: 'human', createdAt, peer: { from: 'uds:/tmp/cc-socks/1.sock' },
        };

        expect<unknown>(discordWithPeer).toHaveProperty('peer');
    });

    it('rejects a boot envelope that opens a turn', () => {
        // @ts-expect-error -- a boot envelope is accumulation-only
        const queryingBoot: Envelope = {
            id: 'b1', mode: 'query', kind: 'boot', text: 't', hostPriority: 'accumulate', createdAt,
        };

        expect<unknown>(queryingBoot).toHaveProperty('mode', 'query');
    });

    it('rejects a discord envelope without its channel, author and human origin', () => {
        // @ts-expect-error -- a discord envelope always carries its channel, author and human origin
        const sourcelessDiscord: Envelope = {
            id: 'd2', mode: 'query', kind: 'discord', text: 't', hostPriority: 'human', createdAt,
        };

        expect<unknown>(sourcelessDiscord).not.toHaveProperty('channelId');
    });

    it('has no shouldQuery field on the domain type — the SDK boolean is derived at toSdkUserMessage', () => {
        const withShouldQuery: Envelope = {
            // @ts-expect-error -- shouldQuery is a wire field, not a domain field
            id: 'c1', mode: 'query', kind: 'compact', text: '/compact', hostPriority: 'accumulate', createdAt, shouldQuery: true,
        };

        expect<unknown>(withShouldQuery).toHaveProperty('shouldQuery', true);
    });
});

describe('EnvelopeMeta', () => {
    it('carries queuedAt (distinct from Envelope.createdAt) plus an optional perch slot/endsAt pair', () => {
        const meta: EnvelopeMeta = {
            id:        'e1',
            kind:      'perch',
            queuedAt:  new Date('2026-09-04T12:00:00Z'),
            channelId: 'chan-1',
            perch:     { slot: 'evening', endsAt: new Date('2026-09-04T19:45:00Z') },
        };

        expect(meta.perch?.slot).toBe('evening');
    });
});

describe('JournalEntry', () => {
    it('carries session_ended{sessionId} and shutdown{} members (P8 gap)', () => {
        const ended: JournalEntry = { type: 'session_ended', at: new Date('2026-09-05T00:00:00Z'), sessionId: 'sess-1' };
        const shutdown: JournalEntry = { type: 'shutdown', at: new Date('2026-09-05T00:00:01Z') };

        expect([ended.type, shutdown.type]).toEqual(['session_ended', 'shutdown']);
    });

    it('lets envelope_submitted carry an optional channelId', () => {
        const withChannel: JournalEntry = {
            type: 'envelope_submitted', at: new Date('2026-09-05T00:00:00Z'), envelopeId: 'e1', kind: 'discord', channelId: 'chan-1',
        };
        const withoutChannel: JournalEntry = { type: 'envelope_submitted', at: new Date('2026-09-05T00:00:00Z'), envelopeId: 'e2', kind: 'boot' };

        expect([withChannel.channelId, withoutChannel.channelId]).toEqual(['chan-1', undefined]);
    });

    it('lets turn_completed carry an optional responseText with a truncated flag', () => {
        const entry: JournalEntry = {
            type: 'turn_completed', at: new Date('2026-09-05T00:00:00Z'), envelopeId: 'e1', kind: 'discord', responseText: 'hi', truncated: false,
        };

        expect(entry.responseText).toBe('hi');
    });

    it('lets response_delivered carry channelId and messageIds', () => {
        const entry: JournalEntry = {
            type: 'response_delivered', at: new Date('2026-09-05T00:00:00Z'), envelopeId: 'e1', channelId: 'chan-1', messageIds: ['m1', 'm2'],
        };

        expect(entry.messageIds).toEqual(['m1', 'm2']);
    });

    it('compaction_completed carries only its timestamp: summaries are never persisted', () => {
        const entry: JournalEntry = { type: 'compaction_completed', at: new Date('2026-09-05T00:00:00Z') };

        expect(Object.keys(entry)).toEqual(['type', 'at']);
    });
});

describe('SystemEvent', () => {
    it('narrows the widened subtype union via satisfies', () => {
        const event = {
            type:    'system',
            subtype: 'task_notification',
        } satisfies SystemEvent;

        expect(event.subtype).toBe('task_notification');
    });
});
