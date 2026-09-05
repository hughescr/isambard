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

afterEach(() => {
    jest.restoreAllMocks();
});

describe('formatBootBundle — conversation', () => {
    const baseParts: BootBundleParts = {
        role:        'conversation',
        resetNotice: false,
        identity:    'I am Isambard.',
        recentUsers: [],
        lostTasks:   [],
        undelivered: [],
        activeTasks: [],
    };

    test('renders the conversation header and identity, nothing else when everything is empty', () => {
        const text = formatBootBundle(baseParts);

        expect(text).toBe('[BOOT BUNDLE · conversation]\n\n## Identity\nI am Isambard.');
    });

    test('renders the reset notice only when resetNotice is true', () => {
        const withNotice = formatBootBundle({ ...baseParts, resetNotice: true });
        const withoutNotice = formatBootBundle(baseParts);

        expect(withNotice).toContain('Working memory was reset (compaction or restart); this bundle re-seeds it.');
        expect(withoutNotice).not.toContain('Working memory was reset');
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
});

describe('formatBootBundle — perch', () => {
    const baseParts: BootBundleParts = {
        role:        'perch',
        resetNotice: false,
        identity:    'I am Isambard.',
        recentUsers: [],
        lostTasks:   [],
        undelivered: [],
        activeTasks: [],
    };

    test('order: header, identity, task list, perch context, lost, undelivered — no channels/recently-talking-to/background-tasks', () => {
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
            '[BOOT BUNDLE · perch]',
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

    test('omits task list and perch context sections when not provided', () => {
        const text = formatBootBundle(baseParts);

        expect(text).toBe('[BOOT BUNDLE · perch]\n\n## Identity\nI am Isambard.');
    });
});

describe('createBootBundleBuilder — conversation', () => {
    test('reads identity through identityCache.get(); never touches loadCoreIdentity', async () => {
        const loader = jest.fn().mockResolvedValue('identity text');
        const identityCache = new IdentityCache(loader);
        const loadCoreIdentity = jest.fn();
        const contextBuilder = { ...makeContextBuilder(), loadCoreIdentity };
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({ lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [], resetNotice: false });

        expect(loader).toHaveBeenCalledTimes(1);
        expect(text).toContain('identity text');
        expect(loadCoreIdentity).not.toHaveBeenCalled();
    });

    test('calls loadHotState(new Date(now())) and loadRecentEventsSince(24h, 50, new Date(now()))', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        await builder.build({ lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [], resetNotice: false });

        expect(contextBuilder.loadHotState).toHaveBeenCalledWith(new Date(NOW()));
        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(24 * 60 * 60 * 1000, 50, new Date(NOW()));
    });

    test('respects custom bootEventsWindowMs/bootEventsLimit', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW, bootEventsWindowMs: 1000, bootEventsLimit: 5,
        });

        await builder.build({ lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [], resetNotice: false });

        expect(contextBuilder.loadRecentEventsSince).toHaveBeenCalledWith(1000, 5, new Date(NOW()));
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

        const text = await builder.build({ lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [], resetNotice: false });

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

        const text = await builder.build({ lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [], resetNotice: false });

        expect(channelListProvider).toHaveBeenCalledTimes(1);
        expect(text).toContain('## Channels\n#general, #random');
    });

    test('passes lostTasks/undelivered/recentUsers/activeTasks/resetNotice through to the rendered text', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'conversation', identityCache, contextBuilder, taskListReader: makeTaskListReader(), now: NOW,
        });

        const text = await builder.build({
            lostTasks: ['lost-1'], undelivered: ['undelivered-1'], recentUsers: ['craig'], activeTasks: ['active-1'], resetNotice: true,
        });

        expect(text).toContain('Working memory was reset');
        expect(text).toContain('## Background tasks lost at restart\nlost-1');
        expect(text).toContain('## Envelopes without a delivered response\nundelivered-1');
        expect(text).toContain('## Recently talking to\ncraig');
        expect(text).toContain('## Background tasks\nactive-1');
    });
});

describe('createBootBundleBuilder — perch', () => {
    test('calls buildPerchContext(new Date(now())) exactly once; never loadHotState/loadRecentEventsSince; omits channels and never calls channelListProvider', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue('identity text'));
        const contextBuilder = makeContextBuilder({ buildPerchContext: jest.fn().mockResolvedValue('## Current Time\n- perch block') });
        const channelListProvider = jest.fn().mockResolvedValue('#general');
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader(), channelListProvider, now: NOW,
        });

        const text = await builder.build({ lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [], resetNotice: false });

        expect(contextBuilder.buildPerchContext).toHaveBeenCalledTimes(1);
        expect(contextBuilder.buildPerchContext).toHaveBeenCalledWith(new Date(NOW()));
        expect(contextBuilder.loadHotState).not.toHaveBeenCalled();
        expect(contextBuilder.loadRecentEventsSince).not.toHaveBeenCalled();
        expect(channelListProvider).not.toHaveBeenCalled();
        expect(text).not.toContain('## Channels');
        expect(text).toContain('## Current Time\n- perch block');
    });

    test('includes the task list section when the reader returns a summary', async () => {
        const identityCache = new IdentityCache(jest.fn().mockResolvedValue(''));
        const contextBuilder = makeContextBuilder();
        const builder = createBootBundleBuilder({
            role: 'perch', identityCache, contextBuilder, taskListReader: makeTaskListReader('Working on: perch stuff'), now: NOW,
        });

        const text = await builder.build({ lostTasks: [], undelivered: [], recentUsers: [], activeTasks: [], resetNotice: false });

        expect(text).toContain('## Task list\nWorking on: perch stuff');
    });
});
