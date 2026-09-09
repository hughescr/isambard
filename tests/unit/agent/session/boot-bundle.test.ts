import { afterEach, describe, expect, jest, test } from 'bun:test';
import { IdentityCache } from '@/agent/identity-cache';
import {
    createBootBundleBuilder,
    formatBootBundle,
    type BootBundleParts,
    type BootContextSource,
    type TaskListSource
} from '@/agent/session/boot-bundle';

const T0 = new Date('2026-09-04T22:07:00Z');
const NOW = () => T0.getTime();

function makeContextBuilder(overrides: Partial<BootContextSource> = {}): BootContextSource {
    return {
        loadHotState:          jest.fn().mockResolvedValue(''),
        loadRecentEventsSince: jest.fn().mockResolvedValue([]),
        buildPerchContext:     jest.fn().mockResolvedValue(''),
        ...overrides,
    };
}

function makeTaskListReader(summary: string | undefined = undefined): TaskListSource {
    return { buildTaskListSummary: jest.fn().mockResolvedValue(summary) };
}

const emptyInput = { lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [] };

afterEach(() => {
    jest.restoreAllMocks();
});

describe('formatBootBundle — conversation fresh', () => {
    const baseParts: BootBundleParts = {
        role:        'conversation',
        kind:        'fresh',
        identity:    'I am Isambard.',
        recentUsers: [],
        lostTasks:   [],
        undelivered: [],
        activeTasks: [],
    };

    test('header names the role and kind; reset notice always present for fresh', () => {
        const text = formatBootBundle(baseParts);

        expect(text).toBe([
            '[BOOT BUNDLE · conversation · fresh]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
            '## Identity\nI am Isambard.',
        ].join('\n\n'));
    });

    test('renders the ambient time header between the reset notice and the first section', () => {
        const text = formatBootBundle({ ...baseParts, timeHeader: '## Current Time\n- UTC: now\n- Perch: idle\n- Quota: 5-hour 42%' });

        expect(text).toBe([
            '[BOOT BUNDLE · conversation · fresh]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
            '## Current Time\n- UTC: now\n- Perch: idle\n- Quota: 5-hour 42%',
            '## Identity\nI am Isambard.',
        ].join('\n\n'));
    });

    test('section order: identity, current focus, events, task list, channels, background tasks, recently talking to, lost tasks, undelivered', () => {
        const text = formatBootBundle({
            ...baseParts,
            currentFocus:    'Working on P6.',
            events:          '- /events/1 (1h ago): did a thing',
            taskListSummary: 'Working on: refactor',
            channelList:     '#general, #random',
            activeTasks:     ['refactor the boot bundle'],
            recentUsers:     ['craig'],
            lostTasks:       ['old task'],
            undelivered:     ['envelope-1'],
        });

        const indices = [
            '## Identity',
            '## Current focus',
            '## Events (last 24h)',
            '## Task list',
            '## Channels',
            '## Background tasks\n',
            '## Recently talking to',
            '## Background tasks lost at restart',
            '## Envelopes without a delivered response',
        ].map(heading => text.indexOf(heading));

        expect(indices.every(i => i > -1)).toBe(true);
        for(let i = 1; i < indices.length; i++) {
            expect(indices[i]).toBeGreaterThan(indices[i - 1]);
        }
    });

    test('omits current focus, events, task list and channels when not provided', () => {
        const text = formatBootBundle(baseParts);

        expect(text).not.toContain('## Current focus');
        expect(text).not.toContain('## Events');
        expect(text).not.toContain('## Task list');
        expect(text).not.toContain('## Channels');
    });

    test('renders lost/undelivered/recentUsers/activeTasks sections only when non-empty', () => {
        const empty = formatBootBundle(baseParts);
        expect(empty).not.toContain('## Recently talking to');
        expect(empty).not.toContain('## Background tasks lost at restart');
        expect(empty).not.toContain('## Envelopes without a delivered response');
        expect(empty).not.toContain('## Background tasks\n');

        const full = formatBootBundle({
            ...baseParts,
            recentUsers: ['craig'],
            lostTasks:   ['task-a'],
            undelivered: ['envelope-a'],
            activeTasks: ['task-b'],
        });
        expect(full).toContain('## Recently talking to\ncraig');
        expect(full).toContain('## Background tasks lost at restart\ntask-a');
        expect(full).toContain('## Envelopes without a delivered response\nenvelope-a');
        expect(full).toContain('## Background tasks\ntask-b');
    });

    test('joins multiple items within one list section with a newline', () => {
        const text = formatBootBundle({
            ...baseParts, lostTasks: ['task-a', 'task-b'],
        });

        expect(text).toContain('## Background tasks lost at restart\ntask-a\ntask-b');
    });

    test('a non-resume kind with every section empty still renders the header and reset notice — the empty-resume short-circuit is resume-only', () => {
        const text = formatBootBundle({
            role: 'conversation', kind: 'fresh', recentUsers: [], lostTasks: [], undelivered: [], activeTasks: [],
        });

        expect(text).toBe([
            '[BOOT BUNDLE · conversation · fresh]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
        ].join('\n\n'));
    });
});

describe('formatBootBundle — conversation compact', () => {
    const baseParts: BootBundleParts = {
        role:        'conversation',
        kind:        'compact',
        identity:    'I am Isambard.',
        recentUsers: [],
        lostTasks:   [],
        undelivered: [],
        activeTasks: [],
    };

    test('exact text: header, reset notice, identity, current focus, events, task list, active tasks', () => {
        const text = formatBootBundle({
            ...baseParts,
            currentFocus:    'Working on P6.',
            events:          '- /events/1 (5m ago): did a thing',
            taskListSummary: 'Working on: refactor',
            activeTasks:     ['refactor the boot bundle'],
        });

        expect(text).toBe([
            '[BOOT BUNDLE · conversation · compact]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
            '## Identity\nI am Isambard.',
            '## Current focus\nWorking on P6.',
            '## Events since you last knew\n- /events/1 (5m ago): did a thing',
            '## Task list\nWorking on: refactor',
            '## Background tasks\nrefactor the boot bundle',
        ].join('\n\n'));
    });

    test('never renders channels, recently talking to, lost tasks or undelivered, even when provided', () => {
        const text = formatBootBundle({
            ...baseParts,
            channelList: '#general',
            recentUsers: ['craig'],
            lostTasks:   ['should-not-appear'],
            undelivered: ['should-not-appear-either'],
        });

        expect(text).not.toContain('## Channels');
        expect(text).not.toContain('## Recently talking to');
        expect(text).not.toContain('## Background tasks lost at restart');
        expect(text).not.toContain('## Envelopes without a delivered response');
    });
});

describe('formatBootBundle — conversation resume', () => {
    const baseParts: BootBundleParts = {
        role:        'conversation',
        kind:        'resume',
        recentUsers: [],
        lostTasks:   [],
        undelivered: [],
        activeTasks: [],
    };

    test('everything empty renders \'\' — no header, no reset notice, nothing', () => {
        expect(formatBootBundle(baseParts)).toBe('');
    });

    test('an empty resume stays empty even with a time header — the header is not a section worth waking on', () => {
        expect(formatBootBundle({ ...baseParts, timeHeader: '## Current Time\n- UTC: now' })).toBe('');
    });

    test('a non-empty resume still carries the time header', () => {
        const text = formatBootBundle({ ...baseParts, timeHeader: '## Current Time\n- UTC: now', activeTasks: ['active-1'] });

        expect(text).toBe([
            '[BOOT BUNDLE · conversation · resume]',
            '## Current Time\n- UTC: now',
            '## Background tasks\nactive-1',
        ].join('\n\n'));
    });

    test('never renders a reset notice, identity, current focus, task list or channels, even when provided', () => {
        const text = formatBootBundle({
            ...baseParts,
            identity:        'I am Isambard.',
            currentFocus:    'Working on P6.',
            taskListSummary: 'Working on: refactor',
            channelList:     '#general',
            recentUsers:     ['craig'],
            lostTasks:       ['lost-1'],
        });

        expect(text).not.toContain('Working memory was reset');
        expect(text).not.toContain('## Identity');
        expect(text).not.toContain('## Current focus');
        expect(text).not.toContain('## Task list');
        expect(text).not.toContain('## Channels');
        expect(text).not.toContain('## Recently talking to');
    });

    test('exact text with only events present', () => {
        const text = formatBootBundle({ ...baseParts, events: '- /events/1 (10m ago): did a thing' });

        expect(text).toBe([
            '[BOOT BUNDLE · conversation · resume]',
            '## Events since you last knew\n- /events/1 (10m ago): did a thing',
        ].join('\n\n'));
    });

    test('renders lost tasks, undelivered and active tasks when present', () => {
        const text = formatBootBundle({
            ...baseParts, lostTasks: ['lost-1'], undelivered: ['undelivered-1'], activeTasks: ['active-1'],
        });

        expect(text).toBe([
            '[BOOT BUNDLE · conversation · resume]',
            '## Background tasks lost at restart\nlost-1',
            '## Envelopes without a delivered response\nundelivered-1',
            '## Background tasks\nactive-1',
        ].join('\n\n'));
    });
});

describe('formatBootBundle — perch fresh/compact', () => {
    const baseParts: BootBundleParts = {
        role:        'perch',
        kind:        'fresh',
        identity:    'I am Isambard.',
        recentUsers: [],
        lostTasks:   [],
        undelivered: [],
        activeTasks: [],
    };

    test('order: header, reset notice, identity, task list, perch context, lost, undelivered — no channels/recently-talking-to/background-tasks', () => {
        const text = formatBootBundle({
            ...baseParts,
            taskListSummary: 'Working on: perch task',
            perchContext:    '## Current Time\n- 2026-09-04...',
            lostTasks:       ['lost-a'],
            undelivered:     ['undelivered-a'],
            recentUsers:     ['craig'],
            activeTasks:     ['active-a'],
        });

        expect(text).toBe([
            '[BOOT BUNDLE · perch · fresh]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
            '## Identity\nI am Isambard.',
            '## Task list\nWorking on: perch task',
            '## Current Time\n- 2026-09-04...',
            '## Background tasks lost at restart\nlost-a',
            '## Envelopes without a delivered response\nundelivered-a',
        ].join('\n\n'));
        expect(text).not.toContain('## Channels');
        expect(text).not.toContain('## Recently talking to');
        expect(text).not.toContain('## Background tasks\n');
    });

    test('renders the ambient time header ahead of identity, alongside the perch context\'s own bare header', () => {
        const text = formatBootBundle({
            ...baseParts,
            timeHeader:   '## Current Time\n- UTC: now\n- Conversation: replying in #general',
            perchContext: '## Current Time\n- 2026-09-04...',
        });

        expect(text).toBe([
            '[BOOT BUNDLE · perch · fresh]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
            '## Current Time\n- UTC: now\n- Conversation: replying in #general',
            '## Identity\nI am Isambard.',
            '## Current Time\n- 2026-09-04...',
        ].join('\n\n'));
    });

    test('omits task list and perch context sections when not provided', () => {
        const text = formatBootBundle(baseParts);

        expect(text).toBe([
            '[BOOT BUNDLE · perch · fresh]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
            '## Identity\nI am Isambard.',
        ].join('\n\n'));
    });

    test('compact is unchanged from fresh (same sections, different kind label)', () => {
        const text = formatBootBundle({ ...baseParts, kind: 'compact', taskListSummary: 'Working on: perch task' });

        expect(text).toBe([
            '[BOOT BUNDLE · perch · compact]',
            'Working memory was reset (compaction or restart); this bundle re-seeds it.',
            '## Identity\nI am Isambard.',
            '## Task list\nWorking on: perch task',
        ].join('\n\n'));
    });
});

describe('formatBootBundle — perch resume', () => {
    const baseParts: BootBundleParts = {
        role:        'perch',
        kind:        'resume',
        recentUsers: [],
        lostTasks:   [],
        undelivered: [],
        activeTasks: [],
    };

    test('everything empty renders \'\'', () => {
        expect(formatBootBundle(baseParts)).toBe('');
    });

    test('never renders identity, task list or perch context, even when provided', () => {
        const text = formatBootBundle({
            ...baseParts, identity: 'I am Isambard.', taskListSummary: 'Working on: perch task', perchContext: '## Current Time\n- x', lostTasks: ['lost-1'],
        });

        expect(text).not.toContain('Working memory was reset');
        expect(text).not.toContain('## Identity');
        expect(text).not.toContain('## Task list');
        expect(text).not.toContain('## Current Time');
    });

    test('exact text with lost tasks, undelivered and active tasks', () => {
        const text = formatBootBundle({
            ...baseParts, lostTasks: ['lost-a'], undelivered: ['undelivered-a'], activeTasks: ['active-a'],
        });

        expect(text).toBe([
            '[BOOT BUNDLE · perch · resume]',
            '## Background tasks lost at restart\nlost-a',
            '## Envelopes without a delivered response\nundelivered-a',
            '## Background tasks\nactive-a',
        ].join('\n\n'));
    });
});

describe('createBootBundleBuilder — conversation fresh', () => {
    test('reads identity through identityCache.get(); never touches loadCoreIdentity', async () => {
        const loader = jest.fn().mockResolvedValue('identity text');
        const identityCache = new IdentityCache(loader);
        const loadCoreIdentity = jest.fn();
        const contextBuilder = { ...makeContextBuilder(), loadCoreIdentity };
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(loader).toHaveBeenCalledTimes(1);
        expect(text).toContain('identity text');
        expect(loadCoreIdentity).not.toHaveBeenCalled();
    });

    test('asks the injected timeHeader provider for the ambient header and renders it in the bundle', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue('identity text'));
        const contextBuilder = makeContextBuilder();
        const timeHeader = jest.fn(() => '## Current Time\n- Perch: idle since 14:02\n- Quota: 5-hour 42%');
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW, timeHeader,
        });

        const text = await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(timeHeader).toHaveBeenCalledTimes(1);
        expect(text).toContain('## Current Time\n- Perch: idle since 14:02\n- Quota: 5-hour 42%');
    });

    test('calls loadHotState(new Date(now())) and loadRecentEventsSince(24h, 50, new Date(now())) when eventsSinceMs is omitted', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(contextBuilder.loadHotState).toHaveBeenCalledWith(new Date(NOW()));
        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(24 * 60 * 60 * 1000, 50, new Date(NOW()));
    });

    test('respects custom bootEventsWindowMs/bootEventsLimit', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW, bootEventsWindowMs: 1000, bootEventsLimit: 5,
        });

        await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(1000, 5, new Date(NOW()));
    });

    test('a given eventsSinceMs overrides bootEventsWindowMs even for fresh', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        await builder.build({ ...emptyInput, kind: 'fresh', eventsSinceMs: NOW() - 5000 });

        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(5000, 50, new Date(NOW()));
    });

    test('formats loadRecentEventsSince results with formatMemoryPreview into the events section', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder({
            loadRecentEventsSince: jest.fn().mockResolvedValue([
                { path: '/events/1', content: 'deployed the thing', contentType: 'text/plain', metadata: {}, createdAt: T0.toISOString(), updatedAt: T0.toISOString() },
            ]),
        });
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(text).toContain('## Events (last 24h)');
        expect(text).toContain('/events/1');
        expect(text).toContain('deployed the thing');
    });

    test('calls channelListProvider and includes its text when present', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const channelListProvider = jest.fn().mockResolvedValue('#general, #random');
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), channelListProvider, now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(channelListProvider).toHaveBeenCalledTimes(1);
        expect(text).toContain('## Channels\n#general, #random');
    });

    test('passes lostTasks/undelivered/recentUsers/activeTasks through to the rendered text', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({
            kind: 'fresh', lostTasks: ['lost-1'], undelivered: ['undelivered-1'], recentUsers: ['craig'], activeTasks: ['active-1'],
        });

        expect(text).toContain('Working memory was reset');
        expect(text).toContain('## Background tasks lost at restart\nlost-1');
        expect(text).toContain('## Envelopes without a delivered response\nundelivered-1');
        expect(text).toContain('## Recently talking to\ncraig');
        expect(text).toContain('## Background tasks\nactive-1');
    });
});

describe('createBootBundleBuilder — conversation compact', () => {
    test('fetches identity/state/task-list/events but never the channel list', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue('identity text'));
        const contextBuilder = makeContextBuilder();
        const channelListProvider = jest.fn().mockResolvedValue('#general');
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader('summary'), channelListProvider, now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'compact', eventsSinceMs: NOW() - 2000 });

        expect(channelListProvider).not.toHaveBeenCalled();
        expect(contextBuilder.loadHotState).toHaveBeenCalledWith(new Date(NOW()));
        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(2000, 50, new Date(NOW()));
        expect(text).toContain('## Identity\nidentity text');
        expect(text).toContain('## Task list\nsummary');
        expect(text).not.toContain('## Channels');
    });

    test('omits the events section when loadRecentEventsSince resolves with zero items, even though eventsSinceMs was given', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder({ loadRecentEventsSince: jest.fn().mockResolvedValue([]) });
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'compact', eventsSinceMs: NOW() - 2000 });

        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(2000, 50, new Date(NOW()));
        expect(text).not.toContain('## Events');
    });

    test('joins multiple rendered event previews with a newline between them', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder({
            loadRecentEventsSince: jest.fn().mockResolvedValue([
                { path: '/events/1', content: 'first thing', contentType: 'text/plain', metadata: {}, createdAt: T0.toISOString(), updatedAt: T0.toISOString() },
                { path: '/events/2', content: 'second thing', contentType: 'text/plain', metadata: {}, createdAt: T0.toISOString(), updatedAt: T0.toISOString() },
            ]),
        });
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'compact', eventsSinceMs: NOW() - 2000 });

        expect(text).toContain('/events/1 (now): first thing\n- /events/2 (now): second thing');
    });

    test('omits the events section and fetches no events when eventsSinceMs is not given', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'compact' });

        expect(contextBuilder.loadRecentEventsSince).not.toHaveBeenCalled();
        expect(text).not.toContain('## Events');
    });

    test('lostTasks/undelivered/recentUsers passed to build() never appear in a compact bundle', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue('identity text'));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({
            kind: 'compact', lostTasks: ['lost-1'], undelivered: ['undelivered-1'], recentUsers: ['craig'], activeTasks: ['active-1'],
        });

        expect(text).not.toContain('## Background tasks lost at restart');
        expect(text).not.toContain('## Envelopes without a delivered response');
        expect(text).not.toContain('## Recently talking to');
        expect(text).toContain('## Background tasks\nactive-1');
    });
});

describe('createBootBundleBuilder — conversation resume', () => {
    test('never fetches identity, task list, hot state or the channel list', async () => {
        const identityLoader = jest.fn().mockResolvedValue('identity text');
        const identityCache = new IdentityCache(identityLoader);
        const contextBuilder = makeContextBuilder();
        const taskListReader = makeTaskListReader('summary');
        const channelListProvider = jest.fn().mockResolvedValue('#general');
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader, channelListProvider, now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'resume' });

        expect(identityLoader).not.toHaveBeenCalled();
        expect(taskListReader.buildTaskListSummary).not.toHaveBeenCalled();
        expect(contextBuilder.loadHotState).not.toHaveBeenCalled();
        expect(channelListProvider).not.toHaveBeenCalled();
        expect(text).toBe('');
    });

    test('a non-empty resume carries the ambient header too', async () => {
        const identityCache = new IdentityCache(jest.fn());
        const contextBuilder = makeContextBuilder();
        const timeHeader = jest.fn(() => '## Current Time\n- Perch: idle');
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW, timeHeader,
        });

        const text = await builder.build({ ...emptyInput, kind: 'resume', activeTasks: ['active-1'] });

        expect(text).toContain('## Current Time\n- Perch: idle');
    });

    test('fetches events via eventsSinceMs and renders them, with no reset notice', async () => {
        const identityCache = new IdentityCache(jest.fn());
        const contextBuilder = makeContextBuilder({
            loadRecentEventsSince: jest.fn().mockResolvedValue([
                { path: '/events/1', content: 'deployed the thing', contentType: 'text/plain', metadata: {}, createdAt: T0.toISOString(), updatedAt: T0.toISOString() },
            ]),
        });
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'resume', eventsSinceMs: NOW() - 3000 });

        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(3000, 50, new Date(NOW()));
        expect(text).not.toContain('Working memory was reset');
        expect(text).toContain('deployed the thing');
    });

    test('renders \'\' when eventsSinceMs is omitted and there is nothing else to report', async () => {
        const identityCache = new IdentityCache(jest.fn());
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'resume' });

        expect(contextBuilder.loadRecentEventsSince).not.toHaveBeenCalled();
        expect(text).toBe('');
    });

    test('renders lost tasks/undelivered/active tasks even with no events mark', async () => {
        const identityCache = new IdentityCache(jest.fn());
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({
            kind: 'resume', lostTasks: ['lost-1'], undelivered: [], recentUsers: [], activeTasks: [],
        });

        expect(text).toContain('## Background tasks lost at restart\nlost-1');
    });
});

describe('createBootBundleBuilder — perch fresh/compact', () => {
    test('calls buildPerchContext(new Date(now())) exactly once; never loadHotState/loadRecentEventsSince; omits channels and never calls channelListProvider', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue('identity text'));
        const contextBuilder = makeContextBuilder({ buildPerchContext: jest.fn().mockResolvedValue('## Current Time\n- perch block') });
        const channelListProvider = jest.fn().mockResolvedValue('#general');
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader(), channelListProvider, now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(contextBuilder.buildPerchContext).toHaveBeenCalledTimes(1);
        expect(contextBuilder.buildPerchContext).toHaveBeenCalledWith(new Date(NOW()));
        expect(contextBuilder.loadHotState).not.toHaveBeenCalled();
        expect(contextBuilder.loadRecentEventsSince).not.toHaveBeenCalled();
        expect(channelListProvider).not.toHaveBeenCalled();
        expect(text).not.toContain('## Channels');
        expect(text).toContain('## Current Time\n- perch block');
    });

    test('asks the injected timeHeader provider for the ambient header and renders it in the bundle', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue('identity text'));
        const contextBuilder = makeContextBuilder();
        const timeHeader = jest.fn(() => '## Current Time\n- Conversation: idle since 14:02\n- Quota: 5-hour 42%');
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW, timeHeader,
        });

        const text = await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(timeHeader).toHaveBeenCalledTimes(1);
        expect(text).toContain('## Current Time\n- Conversation: idle since 14:02\n- Quota: 5-hour 42%');
    });

    test('includes the task list section when the reader returns a summary', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader('Working on: perch stuff'), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'fresh' });

        expect(text).toContain('## Task list\nWorking on: perch stuff');
    });

    test('compact behaves exactly like fresh', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue('identity text'));
        const contextBuilder = makeContextBuilder({ buildPerchContext: jest.fn().mockResolvedValue('## Current Time\n- perch block') });
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'compact' });

        expect(text).toContain('[BOOT BUNDLE · perch · compact]');
        expect(contextBuilder.buildPerchContext).toHaveBeenCalledTimes(1);
    });
});

describe('createBootBundleBuilder — perch resume', () => {
    test('never fetches identity, task list or perch context', async () => {
        const identityLoader = jest.fn().mockResolvedValue('identity text');
        const identityCache = new IdentityCache(identityLoader);
        const contextBuilder = makeContextBuilder();
        const taskListReader = makeTaskListReader('summary');
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader, now: NOW,
        });

        const text = await builder.build({ ...emptyInput, kind: 'resume' });

        expect(identityLoader).not.toHaveBeenCalled();
        expect(taskListReader.buildTaskListSummary).not.toHaveBeenCalled();
        expect(contextBuilder.buildPerchContext).not.toHaveBeenCalled();
        expect(text).toBe('');
    });

    test('a non-empty perch resume carries the ambient header too', async () => {
        const identityCache = new IdentityCache(jest.fn());
        const contextBuilder = makeContextBuilder();
        const timeHeader = jest.fn(() => '## Current Time\n- Conversation: idle');
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW, timeHeader,
        });

        const text = await builder.build({ ...emptyInput, kind: 'resume', activeTasks: ['active-a'] });

        expect(text).toContain('## Current Time\n- Conversation: idle');
    });

    test('renders lost tasks/undelivered/active tasks when present', async () => {
        const identityCache = new IdentityCache(jest.fn());
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({
            kind: 'resume', lostTasks: ['lost-a'], undelivered: ['undelivered-a'], recentUsers: [], activeTasks: ['active-a'],
        });

        expect(text).toBe([
            '[BOOT BUNDLE · perch · resume]',
            '## Background tasks lost at restart\nlost-a',
            '## Envelopes without a delivered response\nundelivered-a',
            '## Background tasks\nactive-a',
        ].join('\n\n'));
    });
});
