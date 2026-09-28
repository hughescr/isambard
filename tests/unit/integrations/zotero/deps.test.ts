import { describe, expect, test } from 'bun:test';
import okFixture from '../../../fixtures/zotero/crossref-works-select-ok.json';
import { TEST_API_KEY, fakeClock, json, recordingFetch } from '../../../helpers/zotero-fake';
import * as zotero from '@/integrations/zotero';
import { createZoteroDeps } from '@/integrations/zotero/deps';

const CONFIG = { apiKey: TEST_API_KEY, groupId: 42, userId: 7, maxStoredFileBytes: 1234 };

describe('createZoteroDeps', () => {
    test('builds one client for the configured group and passes the limits through', async () => {
        const { fetch, calls } = recordingFetch(() => json([], { headers: { 'Total-Results': '0' } }));

        const deps = createZoteroDeps(CONFIG, { fetch });
        await deps.client.getItems(['ABCD2345']);

        expect(deps.client).toBeInstanceOf(zotero.ZoteroClient);
        expect(calls[0].url).toStartWith('https://api.zotero.org/groups/42/items?');
        expect(calls[0].headers.get('Zotero-API-Key')).toBe(TEST_API_KEY);
        expect(deps.maxStoredFileBytes).toBe(1234);
        expect(deps.izzyUserId).toBe(7);
    });

    test('the metadata lookups share the injected fetch, and the mailto reaches Crossref', async () => {
        const { fetch, calls } = recordingFetch(call => (call.url.startsWith('https://api.crossref.org/')
            ? json(okFixture)
            : new Response('<feed></feed>', { status: 200 })));

        const deps = createZoteroDeps({ ...CONFIG, crossrefMailto: 'izzy@example.com' }, { fetch });
        const dois = await deps.metadata.lookupDois(['10.1038/nature14539']);
        const ids = await deps.metadata.lookupArxiv(['1706.03762']);

        expect(dois.has('10.1038/nature14539')).toBe(true);
        expect(ids.size).toBe(0);
        expect(calls[0].headers.get('User-Agent')).toContain('mailto:izzy@example.com');
        expect(calls[1].url).toStartWith('https://export.arxiv.org/api/query?');
    });

    test('the injected clock drives arXiv spacing', async () => {
        const clock = fakeClock();
        const { fetch } = recordingFetch(() => new Response('<feed></feed>', { status: 200 }));

        const deps = createZoteroDeps(CONFIG, { fetch, sleep: clock.sleep, now: clock.now });
        await deps.metadata.lookupArxiv(['1706.03762']);
        await deps.metadata.lookupArxiv(['1706.03762']);

        expect(clock.sleeps).toEqual([3000]);
    });

    test('the addPapers lock runs one task at a time', async () => {
        const deps = createZoteroDeps(CONFIG);
        let running = 0;
        let peak = 0;
        const task = async () => {
            running++;
            peak = Math.max(peak, running);
            await Promise.resolve();
            running--;
        };

        await Promise.all([deps.addPapersLock(task), deps.addPapersLock(task), deps.addPapersLock(task)]);

        expect(peak).toBe(1);
        expect(deps.addPapersLock.concurrency).toBe(1);
    });

    test('the barrel exports the factory', () => {
        expect(zotero.createZoteroDeps).toBe(createZoteroDeps);
    });
});
