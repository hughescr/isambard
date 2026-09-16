import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockLogger } from '../../../setup';
import { registerAllCommands } from '@/integrations/discord/register-commands';

describe('registerAllCommands', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
    });

    afterEach(() => {
        mock.restore();
    });

    test('skips an empty builder list with its diagnostic and never writes the command set', async () => {
        const set = mock(async () => undefined);
        const client = { application: { commands: { set } } };

        await registerAllCommands(client as never, []);

        expect(set).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith('No slash command builders provided — skipping registration');
    });

    test('serializes every builder, replaces the command set, and reports the registered count', async () => {
        const set = mock(async () => undefined);
        const first = { toJSON: mock(() => ({ name: 'first' })) };
        const second = { toJSON: mock(() => ({ name: 'second' })) };
        const client = { application: { commands: { set } } };

        await registerAllCommands(client as never, [() => first as never, () => second as never]);

        expect(set).toHaveBeenCalledWith([{ name: 'first' }, { name: 'second' }]);
        expect(mockLogger.info).toHaveBeenNthCalledWith(1, 'Registering slash commands...');
        expect(mockLogger.info).toHaveBeenNthCalledWith(2, { count: 2, msg: 'Slash commands registered' });
    });

    test('contains builder and Discord failures while preserving the error message', async () => {
        const failure = new Error('Discord is unavailable');
        const set = mock(async () => {
            throw failure;
        });
        const client = { application: { commands: { set } } };

        await expect(registerAllCommands(client as never, [() => ({ toJSON: mock(() => ({ name: 'first' })) }) as never]))
            .resolves.toBeUndefined();

        expect(mockLogger.error).toHaveBeenCalledWith({
            error: 'Discord is unavailable',
            msg:   'Failed to register slash commands — bot continues without updated commands',
        });
    });

    test('stringifies a non-Error rejection, preserving an empty message rather than substituting a placeholder', async () => {
        // Rejecting with '' (not an Error) exercises the String(err) branch with a falsy
        // stringified value, distinguishing it from a `String(err) || 'Unknown error'` fallback.
        const set = mock(async () => {
            throw '';
        });
        const client = { application: { commands: { set } } };

        await expect(registerAllCommands(client as never, [() => ({ toJSON: mock(() => ({ name: 'first' })) }) as never]))
            .resolves.toBeUndefined();

        expect(mockLogger.error).toHaveBeenCalledWith({
            error: '',
            msg:   'Failed to register slash commands — bot continues without updated commands',
        });
    });
});
