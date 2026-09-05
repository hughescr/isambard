import { describe, expect, it } from 'bun:test';
import type { AgentStreamEvent, SystemEvent } from '../../../src/agent/types';

// Compile-time-only assertions: the widened SystemEvent.subtype union and the new optional
// ResultEvent fields are checked with `satisfies`. Each describe carries exactly one runtime
// `expect` to satisfy `jest/expect-expect` without pretending these are behavioural tests.

describe('SystemEvent widening', () => {
    it('accepts the three new subtypes and their recorded optional fields', () => {
        const taskNotification = {
            type:    'system',
            subtype: 'task_notification',
            task_id: 'task-1',
            status:  'completed',
            summary: 'done',
            usage:   { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
        } satisfies SystemEvent;

        const backgroundTasksChanged = {
            type:    'system',
            subtype: 'background_tasks_changed',
            tasks:   [{ task_id: 'task-1', task_type: 'local_agent', description: 'do a thing', ambient: false }],
        } satisfies SystemEvent;

        const hookStarted = {
            type:    'system',
            subtype: 'hook_started',
        } satisfies SystemEvent;

        const taskStarted = {
            type:            'system',
            subtype:         'task_started',
            task_type:       'local_agent',
            is_backgrounded: true,
            subagent_type:   'general-purpose',
            ambient:         false,
        } satisfies SystemEvent;

        expect([taskNotification.subtype, backgroundTasksChanged.subtype, hookStarted.subtype, taskStarted.subtype])
            .toEqual(['task_notification', 'background_tasks_changed', 'hook_started', 'task_started']);
    });
});

describe('ResultEvent widening', () => {
    it('accepts is_error, usage, queued_turn_count and the new error subtypes', () => {
        const budgetError = {
            type:              'result',
            subtype:           'error_max_budget_usd',
            is_error:          true,
            queued_turn_count: 0,
        } satisfies AgentStreamEvent;

        const structuredOutputRetriesError = {
            type:     'result',
            subtype:  'error_max_structured_output_retries',
            is_error: true,
        } satisfies AgentStreamEvent;

        const successWithUsage = {
            type:              'result',
            subtype:           'success',
            is_error:          false,
            total_cost_usd:    0.01,
            usage:             { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            queued_turn_count: 2,
        } satisfies AgentStreamEvent;

        expect([budgetError.subtype, structuredOutputRetriesError.subtype, successWithUsage.subtype])
            .toEqual(['error_max_budget_usd', 'error_max_structured_output_retries', 'success']);
    });
});
