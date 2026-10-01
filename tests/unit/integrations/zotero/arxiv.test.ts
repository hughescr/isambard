import { describe, expect, test } from 'bun:test';
import { deferred, fakeClock, recordingFetch, status, type FakeClock, type FakeHandler, type RecordedCall } from '../../../helpers/zotero-fake';
import { ZoteroMetadataError } from '@/errors';
import { ArxivResolver } from '@/integrations/zotero/arxiv';
import { identityKeys } from '@/integrations/zotero/identifiers';
import type { MappedItem } from '@/integrations/zotero/item-fields';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const API_URL = 'https://export.arxiv.org/api/query';
const ABS_URL = 'https://arxiv.org/abs/';

async function fixture(name: string): Promise<string> {
    return Bun.file(new URL(`../../../fixtures/zotero/${name}`, import.meta.url)).text();
}

const ABS_ATTENTION = await fixture('arxiv-abs-1706.03762.html');
const ABS_MALDACENA = await fixture('arxiv-abs-hep-th-9711200.html');

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

function setup(handler: FakeHandler, gated?: ReturnType<typeof gatedSleep>) {
    const clock = fakeClock();
    clock.advance(NOW);
    const { fetch, calls } = recordingFetch(handler, clock);
    const signals: number[] = [];
    const resolver = new ArxivResolver({
        fetch,
        sleep:         gated === undefined ? clock.sleep : async ms => gated.sleep(clock, ms),
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

function html(body: string): Response {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

/** An abs-page answer per id: the page when listed, a 404 otherwise. */
function pages(map: Record<string, string | undefined>): (id: string) => Response {
    return (id) => {
        const page = map[id];
        return page === undefined ? status(404, 'not found') : html(page);
    };
}

/** Routes the export API and the abs pages (by id) to their own handlers. */
function route(api: (call: RecordedCall) => Response | Promise<Response>, abs: (id: string, call: RecordedCall) => Response | Promise<Response>): FakeHandler {
    return (call) => {
        if(call.url.startsWith(API_URL)) {
            return api(call);
        }
        return abs(call.url.slice(ABS_URL.length), call);
    };
}

async function lookupOne(resolver: ArxivResolver, id: string): Promise<MappedItem | undefined> {
    const found = await resolver.lookupIds([id]);
    return found.get(id);
}

/** An abs answer: `special` for the one id, the Attention page for any other. */
function absExcept(special: string, answer: () => Response, otherwise: () => Response): (id: string) => Response {
    return (id) => {
        if(id === special) {
            return answer();
        }
        return otherwise();
    };
}

const throttled = () => status(429, 'slow down');

/** A response whose body fails mid-transfer, after delivering part of it. */
function brokenBody(code: number, partial: string): Response {
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(partial));
            controller.error(new Error('connection reset'));
        },
    }), { status: code });
}

/** Counts `cancel()` calls on the body and makes each one reject. */
function failingCancel(code: number, headers: Record<string, string> = {}): { response: Response, cancelled: () => number } {
    let count = 0;
    const response = status(code, 'x', headers);
    Object.defineProperty(response, 'body', {
        value: {
            cancel: async () => {
                count += 1;
                throw new Error('cancel failed');
            },
        },
    });
    return { response, cancelled: () => count };
}

/** A sleep whose first call after `arm()` waits for `gate`; every other call advances the clock at once. */
function gatedSleep() {
    const gate = deferred<void>();
    const sleeping = deferred<void>();
    let armed = false;
    return {
        gate,
        sleeping,
        arm:   () => { armed = true; },
        sleep: async (clock: FakeClock, ms: number) => {
            if(armed) {
                armed = false;
                sleeping.resolve();
                await gate.promise;
                clock.advance(ms);
                return;
            }
            await clock.sleep(ms);
        },
    };
}

function apiCalls(calls: RecordedCall[]): RecordedCall[] {
    return calls.filter(call => call.url.startsWith(API_URL));
}

function absUrls(calls: RecordedCall[]): string[] {
    return calls.filter(call => call.url.startsWith(ABS_URL)).map(call => call.url);
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
                accessDate:     '2026-09-27 12:00:00',
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
                accessDate:     '2026-09-27 12:00:00',
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

    test('an HTTP error other than throttling is a metadata error for the batch, with no fallback', async () => {
        const { resolver, calls } = setup(() => status(400, 'bad'));

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed (HTTP 400)');
        expect(error.context).toEqual({ source: 'arxiv', status: 400 });
        expect(calls).toHaveLength(1);
    });

    test('an API 404 is an error, not a fallback', async () => {
        const { resolver, calls } = setup(route(() => status(404, 'gone'), pages({ '1706.03762': ABS_ATTENTION })));

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed (HTTP 404)');
        expect(calls).toHaveLength(1);
    });

    test('when both the export API and the abs page answer 503 the error names both', async () => {
        const { resolver } = setup(() => status(503, 'busy'));

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: export API HTTP 503; abs page for 1706.03762 HTTP 503');
        expect(error.context).toEqual({ source: 'arxiv', status: 503 });
    });

    test('a network failure on both is a metadata error without a status', async () => {
        const { resolver } = setup(() => {
            throw new TypeError('fetch failed');
        });

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: export API fetch failed; abs page for 1706.03762 fetch failed');
        expect(error.context).toEqual({ source: 'arxiv' });
    });

    test('a non-Error rejection is described as a string', async () => {
        const { resolver } = setup(() => {
            throw 'socket closed';
        });

        const error = await caught(resolver.lookupIds(['1706.03762']));
        expect(error.message).toBe('arXiv lookup failed: export API socket closed; abs page for 1706.03762 socket closed');
    });

    test('stamps accessDate in Zotero\'s form with the milliseconds dropped, never toISOString\'s', async () => {
        const { resolver, clock } = setup(feed);
        clock.advance(11_133);

        const found = await resolver.lookupIds(['1706.03762']);

        expect(found.get('1706.03762')?.fields.accessDate).toBe('2026-09-27 12:00:11');
    });

    test('defaults to wall-clock time and a real abort signal', async () => {
        const { fetch, calls } = recordingFetch(feed);
        const resolver = new ArxivResolver({ fetch });

        const found = await resolver.lookupIds(['1706.03762']);

        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
        const accessDate = found.get('1706.03762')?.fields.accessDate ?? '';
        expect(accessDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        const accessed = Date.parse(`${accessDate.replace(' ', 'T')}Z`);
        expect(Math.abs(accessed - Date.now())).toBeLessThan(60_000);
    });

    test('API author mapping is unchanged by the MappedCreator refactor', async () => {
        const xml = '<feed><entry><id>http://arxiv.org/abs/2101.00001</id><author><name>Mary Jane  Smith</name></author><author><name>Prince</name></author></entry></feed>';
        const { resolver } = setup(() => new Response(xml, { status: 200 }));

        const found = await resolver.lookupIds(['2101.00001']);

        expect(found.get('2101.00001')?.creators).toEqual([
            { creatorType: 'author', firstName: 'Mary Jane', lastName: 'Smith' },
            { creatorType: 'author', name: 'Prince' },
        ]);
    });
});

describe('ArxivResolver abs-page fallback', () => {
    test('falls back to the abs page when the export API answers 429', async () => {
        const { resolver, calls } = setup(route(throttled, pages({ '1706.03762': ABS_ATTENTION })));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(calls.map(call => call.url)).toEqual([`${API_URL}?id_list=1706.03762&max_results=1`, 'https://arxiv.org/abs/1706.03762']);
        expect([...found.keys()]).toEqual(['1706.03762']);
        expect(found.get('1706.03762')).toEqual({
            itemType: 'preprint',
            fields:   {
                title:          'Attention Is All You Need',
                abstractNote:   'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks & more.',
                date:           '2017-06-12',
                repository:     'arXiv',
                archiveID:      'arXiv:1706.03762',
                url:            'https://arxiv.org/abs/1706.03762',
                DOI:            '10.48550/arXiv.1706.03762',
                libraryCatalog: 'arXiv.org',
                accessDate:     '2026-09-27 12:00:00',
            },
            creators: [
                { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
                { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
                { creatorType: 'author', firstName: 'Niki', lastName: 'Parmar' },
                { creatorType: 'author', firstName: 'Aidan N.', lastName: 'Gomez' },
            ],
            pdfCandidates: ['https://arxiv.org/pdf/1706.03762'],
        });
    });

    test.each([
        ['HTTP 500', () => status(500, 'oops')],
        ['HTTP 503', () => status(503, 'busy')],
        ['a rejected fetch', () => {
            throw new TypeError('fetch failed');
        }],
        ['a TimeoutError', () => {
            throw new DOMException('The operation timed out.', 'TimeoutError');
        }],
        ['an AbortError', () => {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }],
    ] as [string, () => Response][])('falls back on %s', async (_name, api) => {
        const { resolver, calls } = setup(route(api, pages({ '1706.03762': ABS_ATTENTION })));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(calls).toHaveLength(2);
        expect(found.get('1706.03762')?.fields.title).toBe('Attention Is All You Need');
    });

    test('falls back when the export API body read fails after 200, returning no partial feed', async () => {
        const { resolver, calls } = setup(route(() => brokenBody(200, FEED.slice(0, 700)), pages({ '1706.03762': ABS_ATTENTION })));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(calls).toHaveLength(2);
        // The partial feed held the v7 PDF link; only the abs page's fixed PDF URL may appear.
        expect([...found.keys()]).toEqual(['1706.03762']);
        expect(found.get('1706.03762')?.pdfCandidates).toEqual(['https://arxiv.org/pdf/1706.03762']);
    });

    test('the fallback item has the same identity keys as the export-API item', async () => {
        const viaApi = await setup(feed).resolver.lookupIds(['1706.03762']);
        const viaAbs = await setup(route(throttled, pages({ '1706.03762': ABS_ATTENTION }))).resolver.lookupIds(['1706.03762']);

        const keys = (item: { fields: Record<string, string> } | undefined) => [...identityKeys(item?.fields ?? {})].toSorted((a, b) => a.localeCompare(b));
        expect(keys(viaAbs.get('1706.03762'))).toEqual(keys(viaApi.get('1706.03762')));
        expect(keys(viaAbs.get('1706.03762'))).toContain('arxiv:1706.03762');
    });

    test('a journal DOI on the abs page is the published version in extra, never the item DOI', async () => {
        const { resolver, calls } = setup(route(throttled, pages({ 'hep-th/9711200': ABS_MALDACENA })));

        const found = await resolver.lookupIds(['hep-th/9711200']);
        const item = found.get('hep-th/9711200');

        expect(calls[1].url).toBe('https://arxiv.org/abs/hep-th/9711200');
        expect(item?.fields.DOI).toBe('10.48550/arXiv.hep-th/9711200');
        expect(item?.fields.extra).toBe('Published version DOI: 10.1023/A:1026654312961');
        expect(item?.fields.date).toBe('1997-11-27');
        expect(item?.fields.archiveID).toBe('arXiv:hep-th/9711200');
        expect(item?.pdfCandidates).toEqual(['https://arxiv.org/pdf/hep-th/9711200']);
    });

    test('an arXiv-minted citation_doi is not repeated as a published version', async () => {
        const page = ABS_ATTENTION.replace('</head>', '<meta name="citation_doi" content="10.48550/ARXIV.1706.03762"></head>');
        const { resolver } = setup(route(throttled, pages({ '1706.03762': page })));

        const item = await lookupOne(resolver, '1706.03762');

        expect(item?.fields.DOI).toBe('10.48550/arXiv.1706.03762');
        expect(item?.fields).not.toHaveProperty('extra');
    });

    test('an id the abs page answers 404 is absent, not an error', async () => {
        const { resolver, calls } = setup(route(throttled, pages({ '1706.03762': ABS_ATTENTION })));

        const found = await resolver.lookupIds(['2101.00001', '1706.03762']);

        expect([...found.keys()]).toEqual(['1706.03762']);
        expect(absUrls(calls)).toEqual(['https://arxiv.org/abs/2101.00001', 'https://arxiv.org/abs/1706.03762']);
    });

    test('a 200 abs page naming another or no arXiv id is absent', async () => {
        const other = ABS_ATTENTION.replace('content="1706.03762"/>', 'content="2101.99999"/>');
        const none = ABS_ATTENTION.replace('<meta name="citation_arxiv_id" content="1706.03762"/>', '');
        const { resolver } = setup(route(throttled, pages({ '2101.00001': other, '2101.00002': none, '1706.03762': ABS_ATTENTION })));

        const found = await resolver.lookupIds(['2101.00001', '2101.00002', '1706.03762']);

        expect([...found.keys()]).toEqual(['1706.03762']);
    });

    test('a versioned matching citation_arxiv_id is accepted', async () => {
        const versioned = ABS_ATTENTION.replace('content="1706.03762"/>', 'content="1706.03762v7"/>');
        const { resolver } = setup(route(throttled, pages({ '1706.03762': versioned })));

        const found = await resolver.lookupIds(['1706.03762']);

        expect([...found.keys()]).toEqual(['1706.03762']);
    });

    test('a year-only citation_date gives no date', async () => {
        const yearOnly = ABS_ATTENTION.replace('content="2017/06/12"', 'content="2017"');
        const { resolver } = setup(route(throttled, pages({ '1706.03762': yearOnly })));

        const item = await lookupOne(resolver, '1706.03762');

        expect(item?.fields).not.toHaveProperty('date');
    });

    test('a page without title or abstract still maps', async () => {
        const bare = '<html><head><meta name="citation_arxiv_id" content="1706.03762"></head></html>';
        const { resolver } = setup(route(throttled, pages({ '1706.03762': bare })));

        const item = await lookupOne(resolver, '1706.03762');

        expect(item?.fields).not.toHaveProperty('title');
        expect(item?.fields).not.toHaveProperty('abstractNote');
        expect(item?.creators).toEqual([]);
    });

    test('duplicate ids cause one abs request each, in input order', async () => {
        const { resolver, calls } = setup(route(throttled, pages({ '1706.03762': ABS_ATTENTION, 'hep-th/9711200': ABS_MALDACENA })));

        const found = await resolver.lookupIds(['hep-th/9711200', '1706.03762', 'hep-th/9711200']);

        expect(absUrls(calls)).toEqual(['https://arxiv.org/abs/hep-th/9711200', 'https://arxiv.org/abs/1706.03762']);
        expect([...found.keys()]).toEqual(['hep-th/9711200', '1706.03762']);
    });

    test('fallback requests keep arXiv\'s 3 s spacing', async () => {
        const { resolver, calls, clock } = setup(route(throttled, pages({ '1706.03762': ABS_ATTENTION, 'hep-th/9711200': ABS_MALDACENA })));

        await resolver.lookupIds(['1706.03762', 'hep-th/9711200']);

        expect(clock.sleeps).toEqual([3000, 3000]);
        expect(calls.map(call => call.at - NOW)).toEqual([0, 3000, 6000]);
        expect(absUrls(calls)).toEqual(['https://arxiv.org/abs/1706.03762', 'https://arxiv.org/abs/hep-th/9711200']);
    });

    test('the abs request sends the User-Agent, Accept text/html and a timeout signal', async () => {
        const { resolver, calls, signals } = setup(route(throttled, pages({ '1706.03762': ABS_ATTENTION })));

        await resolver.lookupIds(['1706.03762']);

        expect(calls[1].headers.get('User-Agent')).toBe('Isambard (+https://github.com/hughescr/isambard)');
        expect(calls[1].headers.get('Accept')).toBe('text/html');
        expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
        expect(signals).toEqual([30_000, 30_000]);
    });

    test('the PDF candidate stays fixed and the page\'s citation_pdf_url is never fetched', async () => {
        const hostile = ABS_ATTENTION.replace('https://arxiv.org/pdf/1706.03762v7', 'https://evil.example/x.pdf');
        const { resolver, calls } = setup(route(throttled, pages({ '1706.03762': hostile })));

        const item = await lookupOne(resolver, '1706.03762');

        expect(item?.pdfCandidates).toEqual(['https://arxiv.org/pdf/1706.03762']);
        expect(calls).toHaveLength(2);
    });

    test('stops at the first failed abs page and reports both failures, discarding partial results', async () => {
        const { resolver, calls } = setup(route(throttled, absExcept('1706.03762', () => status(503, 'busy'), () => html(ABS_MALDACENA))));

        const error = await caught(resolver.lookupIds(['hep-th/9711200', '1706.03762', '2101.00001']));

        expect(error.message).toBe('arXiv lookup failed: export API HTTP 429; abs page for 1706.03762 HTTP 503');
        expect(error.context).toEqual({ source: 'arxiv', status: 503 });
        expect(absUrls(calls)).toEqual(['https://arxiv.org/abs/hep-th/9711200', 'https://arxiv.org/abs/1706.03762']);
    });

    test('a rejected abs fetch gives a combined error without a status', async () => {
        const { resolver } = setup(route(throttled, () => {
            throw new DOMException('The operation timed out.', 'TimeoutError');
        }));

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: export API HTTP 429; abs page for 1706.03762 The operation timed out.');
        expect(error.context).toEqual({ source: 'arxiv' });
    });

    test('a rejected abs body read gives a combined error without a status and no partial page is used', async () => {
        const { resolver } = setup(route(throttled, () => brokenBody(200, ABS_ATTENTION.slice(0, 400))));

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: export API HTTP 429; abs page for 1706.03762 connection reset');
        expect(error.context).toEqual({ source: 'arxiv' });
    });

    test('a rejecting body cancel does not mask the failure or block the fallback', async () => {
        const api = failingCancel(429);
        const abs = failingCancel(503);
        const { resolver } = setup(route(() => api.response, () => abs.response));

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: export API HTTP 429; abs page for 1706.03762 HTTP 503');
        expect(error.context).toEqual({ source: 'arxiv', status: 503 });
        expect(api.cancelled()).toBe(1);
        expect(abs.cancelled()).toBe(1);
    });

    test('a rejecting body cancel on a throttled export API still lets the fallback succeed', async () => {
        const api = failingCancel(429);
        const { resolver } = setup(route(() => api.response, pages({ '1706.03762': ABS_ATTENTION })));

        const found = await resolver.lookupIds(['1706.03762']);

        expect([...found.keys()]).toEqual(['1706.03762']);
        expect(api.cancelled()).toBe(1);
    });

    test('a rejecting body cancel on a 404 abs page does not make the id an error', async () => {
        const gone = failingCancel(404);
        const { resolver } = setup(route(throttled, absExcept('2101.00001', () => gone.response, () => html(ABS_ATTENTION))));

        const found = await resolver.lookupIds(['2101.00001', '1706.03762']);

        expect([...found.keys()]).toEqual(['1706.03762']);
        expect(gone.cancelled()).toBe(1);
    });

    test('cancels the body of a non-fallback API error before throwing', async () => {
        const bad = failingCancel(400);
        const { resolver } = setup(() => bad.response);

        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed (HTTP 400)');
        expect(bad.cancelled()).toBe(1);
    });
});

describe('ArxivResolver Retry-After', () => {
    /** An API that answers 429 with `retryAfter` once, then serves the feed. */
    function throttleOnce(retryAfter?: string) {
        const headers: Record<string, string> = {};
        if(retryAfter !== undefined) {
            headers['Retry-After'] = retryAfter;
        }
        let hits = 0;
        return route(() => {
            hits += 1;
            return hits === 1 ? status(429, 'slow', headers) : feed();
        }, pages({ '1706.03762': ABS_ATTENTION }));
    }

    test('a Retry-After on the export API skips it until then, going straight to the abs pages', async () => {
        const { resolver, calls, clock } = setup(throttleOnce('120'));

        await resolver.lookupIds(['1706.03762']);
        clock.advance(60_000 - (clock.now() - NOW));
        const found = await resolver.lookupIds(['1706.03762']);

        expect(calls.map(call => call.url.split('/')[2])).toEqual(['export.arxiv.org', 'arxiv.org', 'arxiv.org']);
        expect(found.get('1706.03762')?.fields.title).toBe('Attention Is All You Need');
    });

    test.each([
        [119_999, 1],
        [120_000, 2],
        [120_001, 2],
    ])('the export API cooldown ends exactly at its deadline (+%d ms: %d API requests)', async (elapsed, expected) => {
        const { resolver, calls, clock } = setup(throttleOnce('120'));

        await resolver.lookupIds(['1706.03762']);
        clock.advance(elapsed - (clock.now() - NOW));
        await resolver.lookupIds(['1706.03762']);

        expect(apiCalls(calls)).toHaveLength(expected);
    });

    test.each([
        ['absent', undefined],
        ['unparsable', 'soon'],
        ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
        ['negative', '-5'],
        ['fractional', '1.5'],
        ['empty', ''],
    ])('a Retry-After that is %s sets no cooldown', async (_name, header) => {
        const { resolver, calls } = setup(throttleOnce(header));

        await resolver.lookupIds(['1706.03762']);
        await resolver.lookupIds(['1706.03762']);

        expect(apiCalls(calls)).toHaveLength(2);
    });

    test('Retry-After 0 sets no lasting cooldown', async () => {
        const { resolver, calls } = setup(throttleOnce('0'));

        await resolver.lookupIds(['1706.03762']);
        await resolver.lookupIds(['1706.03762']);

        expect(apiCalls(calls)).toHaveLength(2);
    });

    test('Retry-After 7200 keeps the API skipped beyond an hour', async () => {
        const { resolver, calls, clock } = setup(throttleOnce('7200'));

        await resolver.lookupIds(['1706.03762']);
        clock.advance(3_700_000);
        await resolver.lookupIds(['1706.03762']);

        expect(apiCalls(calls)).toHaveLength(1);
    });

    test('a Retry-After on an API error that does not fall back still sets the cooldown', async () => {
        let hits = 0;
        const { resolver, calls } = setup(route(() => {
            hits += 1;
            return hits === 1 ? status(400, 'bad', { 'Retry-After': '120' }) : feed();
        }, pages({ '1706.03762': ABS_ATTENTION })));

        await caught(resolver.lookupIds(['1706.03762']));
        const found = await resolver.lookupIds(['1706.03762']);

        expect(apiCalls(calls)).toHaveLength(1);
        expect(found.has('1706.03762')).toBe(true);
    });

    test('a later shorter Retry-After does not shorten an existing cooldown', async () => {
        const first = deferred<Response>();
        const started = deferred<void>();
        let hits = 0;
        const { resolver, calls, clock } = setup(route(async () => {
            hits += 1;
            if(hits === 1) {
                started.resolve();
                return first.promise;
            }
            return status(429, 'slow', { 'Retry-After': '600' });
        }, pages({ '1706.03762': ABS_ATTENTION })));

        // A is in flight; B reserves the next slot and gets a long cooldown first, then A's short one arrives.
        const a = resolver.lookupIds(['1706.03762']);
        await started.promise;
        const b = resolver.lookupIds(['1706.03762']);
        await b;
        first.resolve(status(429, 'slow', { 'Retry-After': '10' }));
        await a;
        clock.advance(500_000 - (clock.now() - NOW));
        await resolver.lookupIds(['1706.03762']);

        expect(apiCalls(calls)).toHaveLength(2);
    });

    test('a waiting API lookup rechecks the cooldown after its spacing wait', async () => {
        const first = deferred<Response>();
        const started = deferred<void>();
        let hits = 0;
        const sleeper = gatedSleep();
        const { resolver, calls } = setup(route(async () => {
            hits += 1;
            if(hits === 1) {
                started.resolve();
                return first.promise;
            }
            return feed();
        }, pages({ '1706.03762': ABS_ATTENTION })), sleeper);
        sleeper.arm();

        const a = resolver.lookupIds(['1706.03762']);
        await started.promise;
        const b = resolver.lookupIds(['1706.03762']);
        await sleeper.sleeping.promise;
        first.resolve(status(429, 'slow', { 'Retry-After': '120' }));
        await a;
        sleeper.gate.resolve();
        const found = await b;

        expect(apiCalls(calls)).toHaveLength(1);
        expect(found.get('1706.03762')?.fields.title).toBe('Attention Is All You Need');
    });

    test('an export API cooldown is named in the combined error when the abs page also fails', async () => {
        let absHits = 0;
        const { resolver } = setup(route(() => status(429, 'slow', { 'Retry-After': '120' }), () => {
            absHits += 1;
            return absHits === 1 ? html(ABS_ATTENTION) : status(503, 'busy');
        }));

        await resolver.lookupIds(['1706.03762']);
        const error = await caught(resolver.lookupIds(['1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: export API backing off (Retry-After); abs page for 1706.03762 HTTP 503');
        expect(error.context).toEqual({ source: 'arxiv', status: 503 });
    });

    test('an abs Retry-After makes later fallbacks fail fast without an abs request, while a good API lookup still works', async () => {
        let apiHits = 0;
        let absHits = 0;
        const { resolver, calls } = setup(route(() => {
            apiHits += 1;
            return apiHits <= 2 ? status(429, 'slow') : feed();
        }, () => {
            absHits += 1;
            return status(503, 'busy', { 'Retry-After': '60' });
        }));

        const first = await caught(resolver.lookupIds(['1706.03762']));
        const second = await caught(resolver.lookupIds(['1706.03762']));
        const third = await resolver.lookupIds(['1706.03762']);

        expect(first.message).toBe('arXiv lookup failed: export API HTTP 429; abs page for 1706.03762 HTTP 503');
        expect(second.message).toBe('arXiv lookup failed: export API HTTP 429; abs page for 1706.03762 backing off (Retry-After)');
        expect(second.context).toEqual({ source: 'arxiv' });
        expect(absHits).toBe(1);
        expect(apiCalls(calls)).toHaveLength(3);
        expect(third.has('1706.03762')).toBe(true);
    });

    test('an abs cooldown ends exactly at its deadline', async () => {
        let absHits = 0;
        // The API cooldown keeps every later lookup off the API, so only the abs deadline is in play.
        const { resolver, clock } = setup(route(() => status(429, 'slow', { 'Retry-After': '7200' }), () => {
            absHits += 1;
            return absHits === 1 ? status(503, 'busy', { 'Retry-After': '60' }) : html(ABS_ATTENTION);
        }));

        await caught(resolver.lookupIds(['1706.03762']));
        clock.advance(59_999);
        const early = await caught(resolver.lookupIds(['1706.03762']));
        clock.advance(1);
        const found = await resolver.lookupIds(['1706.03762']);

        expect(early.message).toContain('backing off (Retry-After)');
        expect(found.has('1706.03762')).toBe(true);
        expect(absHits).toBe(2);
    });

    test('a 404 with Retry-After stops the next id at its pre-check', async () => {
        const { resolver, calls } = setup(route(throttled, absExcept('2101.00001', () => status(404, 'gone', { 'Retry-After': '30' }), () => html(ABS_ATTENTION))));

        const error = await caught(resolver.lookupIds(['2101.00001', '1706.03762']));

        expect(error.message).toBe('arXiv lookup failed: export API HTTP 429; abs page for 1706.03762 backing off (Retry-After)');
        expect(error.context).toEqual({ source: 'arxiv' });
        expect(absUrls(calls)).toEqual(['https://arxiv.org/abs/2101.00001']);
    });

    test('a waiting abs request rechecks a cooldown set meanwhile', async () => {
        const absResponse = deferred<Response>();
        const started = deferred<void>();
        let apiHits = 0;
        let absHits = 0;
        const sleeper = gatedSleep();
        const { resolver, calls, clock } = setup(route(() => {
            apiHits += 1;
            return status(429, 'slow', { 'Retry-After': '7200' });
        }, async () => {
            absHits += 1;
            if(absHits === 2) {
                started.resolve();
                return absResponse.promise;
            }
            return html(ABS_ATTENTION);
        }), sleeper);

        // Prime: the export API cooldown sends both later lookups straight to the abs pages.
        await resolver.lookupIds(['1706.03762']);
        clock.advance(10_000);
        sleeper.arm();
        const a = resolver.lookupIds(['1706.03762']);
        await started.promise;
        const b = resolver.lookupIds(['1706.03762']);
        await sleeper.sleeping.promise;
        absResponse.resolve(status(503, 'busy', { 'Retry-After': '60' }));
        const failed = await caught(a);
        sleeper.gate.resolve();
        const waited = await caught(b);

        expect(failed.message).toBe('arXiv lookup failed: export API backing off (Retry-After); abs page for 1706.03762 HTTP 503');
        expect(waited.message).toBe('arXiv lookup failed: export API backing off (Retry-After); abs page for 1706.03762 backing off (Retry-After)');
        expect(waited.context).toEqual({ source: 'arxiv' });
        expect(apiHits).toBe(1);
        expect(absUrls(calls)).toHaveLength(2);
    });
});
