import { describe, expect, test } from 'bun:test';
import { fakeClock, recordingFetch, status, type FakeHandler } from '../../../helpers/zotero-fake';
import { ZoteroMetadataError } from '@/errors';
import { ArxivResolver } from '@/integrations/zotero/arxiv';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

/** An Atom feed shaped like export.arxiv.org's, with a feed-level title/id that must be ignored. */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <link href="http://arxiv.org/api/query?id_list=1706.03762" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: id_list=1706.03762</title>
  <id>http://arxiv.org/api/feed-id</id>
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>  The dominant sequence transduction models &amp; more.
  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam  Shazeer</name></author>
    <author><name>Prince</name></author>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/hep-th/9901001v1</id>
    <published>1999-01-01T00:00:00Z</published>
    <title>Old Style</title>
    <summary>S</summary>
    <author><name>A B</name></author>
    <arxiv:doi>10.1016/S0550-3213(99)00001-1</arxiv:doi>
    <arxiv:journal_ref>Nucl.Phys. B550 (1999) 1</arxiv:journal_ref>
    <link title="pdf" href="https://example.org/mirror.pdf" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_nope</id>
    <title>Error</title>
    <summary>incorrect id format for nope</summary>
  </entry>
</feed>`;

function setup(handler: FakeHandler) {
    const clock = fakeClock();
    clock.advance(NOW);
    const { fetch, calls } = recordingFetch(handler, clock);
    const signals: number[] = [];
    const resolver = new ArxivResolver({
        fetch,
        sleep:         clock.sleep,
        now:           clock.now,
        timeoutSignal: (ms) => {
            signals.push(ms);
            return new AbortController().signal;
        },
    });
    return { resolver, calls, clock, signals };
}

function feed(): Response {
    return new Response(FEED, { status: 200, headers: { 'Content-Type': 'application/atom+xml' } });
}

async function caught(promise: Promise<unknown>): Promise<ZoteroMetadataError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(ZoteroMetadataError);
        return error as ZoteroMetadataError;
    }
    throw new Error('expected a rejection');
}

describe('ArxivResolver', () => {
    test('sends one request for every id', async () => {
        const { resolver, calls, signals } = setup(feed);

        await resolver.lookupIds(['1706.03762', 'hep-th/9901001', '1706.03762', 'nope']);

        expect(calls).toHaveLength(1);
        const url = new URL(calls[0].url);
        expect(`${url.origin}${url.pathname}`).toBe('https://export.arxiv.org/api/query');
        expect(url.searchParams.get('id_list')).toBe('1706.03762,hep-th/9901001,nope');
        expect(url.searchParams.get('max_results')).toBe('3');
        expect(calls[0].headers.get('User-Agent')).toBe('Isambard (+https://github.com/hughescr/isambard)');
        expect(signals).toEqual([30_000]);
    });

    test('no ids means no request', async () => {
        const { resolver, calls } = setup(feed);

        const found = await resolver.lookupIds([]);

        expect(found.size).toBe(0);
        expect(calls).toHaveLength(0);
    });

    test('maps each entry to a preprint keyed by its version-less id; absent and error entries are skipped', async () => {
        const { resolver } = setup(feed);

        const found = await resolver.lookupIds(['1706.03762', 'hep-th/9901001', 'nope']);

        expect([...found.keys()]).toEqual(['1706.03762', 'hep-th/9901001']);
        expect(found.get('1706.03762')).toEqual({
            itemType: 'preprint',
            fields:   {
                title:          'Attention Is All You Need',
                abstractNote:   'The dominant sequence transduction models & more.',
                date:           '2017-06-12',
                repository:     'arXiv',
                archiveID:      'arXiv:1706.03762',
                url:            'https://arxiv.org/abs/1706.03762',
                DOI:            '10.48550/arXiv.1706.03762',
                libraryCatalog: 'arXiv.org',
                accessDate:     '2026-09-27T12:00:00.000Z',
            },
            creators: [
                { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
                { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
                { creatorType: 'author', name: 'Prince' },
            ],
            pdfCandidates: ['https://arxiv.org/pdf/1706.03762v7'],
        });
    });

    test('a published DOI and journal reference go to extra; a non-arxiv PDF link is kept as is', async () => {
        const { resolver } = setup(feed);

        const found = await resolver.lookupIds(['hep-th/9901001']);
        const old = found.get('hep-th/9901001');

        expect(old?.fields.extra).toBe('Published version DOI: 10.1016/S0550-3213(99)00001-1\nJournal ref: Nucl.Phys. B550 (1999) 1');
        expect(old?.fields.DOI).toBe('10.48550/arXiv.hep-th/9901001');
        expect(old?.fields.date).toBe('1999-01-01');
        expect(old?.pdfCandidates).toEqual(['https://example.org/mirror.pdf']);
    });

    test('an entry with only a journal reference, no date, title, summary or PDF link still maps', async () => {
        const minimal = '<feed><entry><id>http://arxiv.org/abs/2101.00001</id><arxiv:journal_ref>J 1</arxiv:journal_ref><published>bad</published></entry></feed>';
        const { resolver } = setup(() => new Response(minimal, { status: 200 }));

        const found = await resolver.lookupIds(['2101.00001']);

        expect(found.get('2101.00001')).toEqual({
            itemType: 'preprint',
            fields:   {
                repository:     'arXiv',
                archiveID:      'arXiv:2101.00001',
                url:            'https://arxiv.org/abs/2101.00001',
                DOI:            '10.48550/arXiv.2101.00001',
                libraryCatalog: 'arXiv.org',
                accessDate:     '2026-09-27T12:00:00.000Z',
                extra:          'Journal ref: J 1',
            },
            creators:      [],
            pdfCandidates: [],
        });
    });

    test('a second lookup waits out the rest of arXiv\'s 3 s spacing', async () => {
        const { resolver, calls, clock } = setup(feed);

        await resolver.lookupIds(['1706.03762']);
        clock.advance(1000);
        await resolver.lookupIds(['1706.03762']);
        clock.advance(5000);
        await resolver.lookupIds(['1706.03762']);

        expect(clock.sleeps).toEqual([2000]);
        expect(calls.map(call => call.at - NOW)).toEqual([0, 3000, 8000]);
    });

    test('concurrent lookups reserve successive slots', async () => {
        const { resolver, calls, clock } = setup(feed);

        await Promise.all([resolver.lookupIds(['1706.03762']), resolver.lookupIds(['1706.03762']), resolver.lookupIds(['1706.03762'])]);

        // The first sends at once; each later one reserves the slot 3 s after the previous reservation.
        // (The fake clock advances as soon as a sleep starts, so each waits 3 s from the time it asks.)
        expect(clock.sleeps).toEqual([3000, 3000]);
        expect(calls).toHaveLength(3);
    });

    test('an HTTP error is a metadata error for the batch', async () => {
        const { resolver } = setup(() => status(503, 'busy'));

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed (HTTP 503)');
        expect(error.context).toEqual({ source: 'arxiv', status: 503 });
    });

    test('a network failure is a metadata error', async () => {
        const { resolver } = setup(() => {
            throw new TypeError('fetch failed');
        });

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: fetch failed');
        expect(error.context).toEqual({ source: 'arxiv' });
    });

    test('a non-Error rejection is described as a string', async () => {
        const { resolver } = setup(() => {
            throw 'socket closed';
        });

        const error = await caught(resolver.lookupIds(['1706.03762']));
        expect(error.message).toBe('arXiv lookup failed: socket closed');
    });

    test('defaults to wall-clock time and a real abort signal', async () => {
        const { fetch, calls } = recordingFetch(feed);
        const resolver = new ArxivResolver({ fetch });

        const found = await resolver.lookupIds(['1706.03762']);

        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
        const accessed = Date.parse(found.get('1706.03762')?.fields.accessDate ?? '');
        expect(Math.abs(accessed - Date.now())).toBeLessThan(60_000);
    });
});
