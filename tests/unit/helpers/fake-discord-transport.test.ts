import { describe, expect, it } from 'bun:test';
import { FakeDiscordTransport } from '../../helpers/fake-discord-transport';

describe('FakeDiscordTransport', () => {
    it('records a delivery in sent', async () => {
        const transport = new FakeDiscordTransport();

        await transport.deliver({ envelopeId: 'e1', target: 'chan-1', text: 'hello' });

        expect(transport.sent).toEqual([{ envelopeId: 'e1', target: 'chan-1', text: 'hello' }]);
    });

    it('records multiple distinct deliveries in call order', async () => {
        const transport = new FakeDiscordTransport();

        await transport.deliver({ envelopeId: 'e1', target: 'chan-1', text: 'first' });
        await transport.deliver({ envelopeId: 'e2', target: 'chan-1', text: 'second' });

        expect(transport.sent).toEqual([
            { envelopeId: 'e1', target: 'chan-1', text: 'first' },
            { envelopeId: 'e2', target: 'chan-1', text: 'second' },
        ]);
    });

    it('dedupes a second delivery with the same envelopeId: it is a no-op counted in duplicates', async () => {
        const transport = new FakeDiscordTransport();

        await transport.deliver({ envelopeId: 'e1', target: 'chan-1', text: 'hello' });
        await transport.deliver({ envelopeId: 'e1', target: 'chan-1', text: 'hello-again' });

        expect(transport.sent).toEqual([{ envelopeId: 'e1', target: 'chan-1', text: 'hello' }]);
        expect(transport.duplicates).toBe(1);
    });

    it('failNext rejects exactly one subsequent deliver() call', async () => {
        const transport = new FakeDiscordTransport();
        const boom = new Error('discord unreachable');
        transport.failNext(boom);

        await expect(transport.deliver({ envelopeId: 'e1', target: 'chan-1', text: 'hello' })).rejects.toThrow('discord unreachable');
        expect(transport.sent).toEqual([]);

        await transport.deliver({ envelopeId: 'e1', target: 'chan-1', text: 'hello' });

        expect(transport.sent).toEqual([{ envelopeId: 'e1', target: 'chan-1', text: 'hello' }]);
    });
});
