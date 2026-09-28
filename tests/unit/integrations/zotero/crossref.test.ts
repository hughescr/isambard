/* eslint-disable sonarjs/no-clear-text-protocols -- the captured Crossref response really carries an http:// PDF link, and the test asserts it is passed through for the host policy to judge */
import { describe, expect, test } from 'bun:test';
import invalidFixture from '../../../fixtures/zotero/crossref-works-select-invalid.json';
import okFixture from '../../../fixtures/zotero/crossref-works-select-ok.json';
import { json, recordingFetch, status, type FakeHandler } from '../../../helpers/zotero-fake';
import { ZoteroMetadataError } from '@/errors';
import { CROSSREF_SELECT, CrossrefResolver } from '@/integrations/zotero/crossref';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const ACCESSED = '2026-09-27T12:00:00.000Z';

function setup(handler: FakeHandler, mailto?: string) {
    const { fetch, calls } = recordingFetch(handler);
    const signals: number[] = [];
    const resolver = new CrossrefResolver({
        fetch,
        now:           () => NOW,
        timeoutSignal: (ms) => {
            signals.push(ms);
            return new AbortController().signal;
        },
        ...mailto === undefined ? {} : { mailto },
    });
    return { resolver, calls, signals };
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

function work(fields: Record<string, unknown>): Record<string, unknown> {
    return { DOI: '10.1234/x', title: ['T'], ...fields };
}

function worksResponse(items: unknown[]): Response {
    return json({ status: 'ok', 'message-type': 'work-list', message: { items } });
}

describe('CrossrefResolver request', () => {
    test('sends one filtered request for every DOI with rows and the select list', async () => {
        const { resolver, calls, signals } = setup(() => json(okFixture));

        await resolver.lookupDois(['10.1038/nature14539', '10.1101/2020.03.22.002386', '10.9999/nonexistent.xyz']);

        expect(calls).toHaveLength(1);
        const url = new URL(calls[0].url);
        expect(`${url.origin}${url.pathname}`).toBe('https://api.crossref.org/works');
        expect(url.searchParams.get('filter')).toBe('doi:10.1038/nature14539,doi:10.1101/2020.03.22.002386,doi:10.9999/nonexistent.xyz');
        expect(url.searchParams.get('rows')).toBe('3');
        expect(url.searchParams.get('select')).toBe(CROSSREF_SELECT);
        expect(calls[0].headers.get('Accept')).toBe('application/json');
        expect(calls[0].headers.get('User-Agent')).toBe('Isambard (+https://github.com/hughescr/isambard)');
        expect(signals).toEqual([30_000]);
    });

    test('a configured mailto joins the user agent for the polite pool', async () => {
        const { resolver, calls } = setup(() => json(okFixture), 'izzy@example.com');

        await resolver.lookupDois(['10.1038/nature14539']);

        expect(calls[0].headers.get('User-Agent')).toBe('Isambard (+https://github.com/hughescr/isambard; mailto:izzy@example.com)');
    });

    test('duplicates, including case variants, are asked for once; no DOIs means no request', async () => {
        const { resolver, calls } = setup(() => json(okFixture));

        const none = await resolver.lookupDois([]);
        expect(none.size).toBe(0);
        expect(calls).toHaveLength(0);

        await resolver.lookupDois(['10.1038/NATURE14539', '10.1038/nature14539']);
        expect(new URL(calls[0].url).searchParams.get('filter')).toBe('doi:10.1038/nature14539');
        expect(new URL(calls[0].url).searchParams.get('rows')).toBe('1');
    });

    test('defaults to wall-clock access dates and a real abort signal', async () => {
        const { fetch, calls } = recordingFetch(() => worksResponse([work({})]));
        const resolver = new CrossrefResolver({ fetch });

        const found = await resolver.lookupDois(['10.1234/x']);

        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
        const accessed = Date.parse(found.get('10.1234/x')?.fields.accessDate ?? '');
        expect(Math.abs(accessed - Date.now())).toBeLessThan(60_000);
    });

    test('the select list only names fields Crossref accepts on /works', () => {
        const valid = /Valid selects for this route are: (.+)$/.exec(invalidFixture.message[0].message)?.[1]?.split(', ');

        for(const field of CROSSREF_SELECT.split(',')) {
            expect(valid).toContain(field);
        }
    });
});

describe('CrossrefResolver responses', () => {
    test('maps the real captured response: a journal article and a posted-content preprint', async () => {
        const { resolver } = setup(() => json(okFixture));

        const found = await resolver.lookupDois(['10.1038/nature14539', '10.1101/2020.03.22.002386', '10.9999/nonexistent.xyz']);

        expect([...found.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual(['10.1038/nature14539', '10.1101/2020.03.22.002386']);
        const article = found.get('10.1038/nature14539')!;
        expect(article.itemType).toBe('journalArticle');
        expect(article.fields).toEqual({
            title:               'Deep learning',
            date:                '2015-05-27',
            DOI:                 '10.1038/nature14539',
            url:                 'https://doi.org/10.1038/nature14539',
            libraryCatalog:      'Crossref',
            accessDate:          ACCESSED,
            publicationTitle:    'Nature',
            journalAbbreviation: 'Nature',
            volume:              '521',
            issue:               '7553',
            pages:               '436-444',
            ISSN:                '0028-0836, 1476-4687',
        });
        expect(article.creators.slice(0, 2)).toEqual([
            { creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' },
            { creatorType: 'author', firstName: 'Yoshua', lastName: 'Bengio' },
        ]);
        expect(article.pdfCandidates).toEqual(['http://www.nature.com/articles/nature14539.pdf']);

        const preprint = found.get('10.1101/2020.03.22.002386')!;
        expect(preprint.itemType).toBe('preprint');
        expect(preprint.fields.repository).toBe('openRxiv');
        expect(preprint.fields.abstractNote).toStartWith('ABSTRACT An outbreak of the novel coronavirus SARS-CoV-2');
        expect(preprint.fields.abstractNote).not.toContain('<');
        expect(preprint.pdfCandidates).toEqual([]);
    });

    test('a DOI missing from a successful response is simply absent (not found)', async () => {
        const { resolver } = setup(() => worksResponse([]));

        const found = await resolver.lookupDois(['10.1038/nature14539']);
        expect(found.size).toBe(0);
    });

    test('a validation-failure body is a rejected request, not "not found"', async () => {
        const { resolver } = setup(() => json(invalidFixture, { status: 400 }));

        const error = await caught(resolver.lookupDois(['10.1038/nature14539']));

        expect(error.message).toStartWith('Crossref rejected the request: Select \'subtype\' specified but there is no such select for this route.');
        expect(error.message.length).toBeLessThanOrEqual('Crossref rejected the request: '.length + 300);
        expect(error.context).toEqual({ source: 'crossref', status: 400, reason: 'request rejected' });
    });

    test('a failed status without a message still reads as a rejection', async () => {
        const { resolver } = setup(() => json({ status: 'failed' }, { status: 200 }));

        const error = await caught(resolver.lookupDois(['10.1038/nature14539']));

        expect(error.message).toBe('Crossref rejected the request: no reason given');
    });

    test('a validation-failure message type alone is a rejection', async () => {
        const { resolver } = setup(() => json({ 'message-type': 'validation-failure', message: [{ message: 'bad filter' }] }, { status: 400 }));

        const error = await caught(resolver.lookupDois(['10.1038/x']));
        expect(error.message).toBe('Crossref rejected the request: bad filter');
    });

    test.each([500, 404])('HTTP %d is a metadata error for the batch', async (code) => {
        const { resolver } = setup(() => status(code, 'down'));

        const error = await caught(resolver.lookupDois(['10.1038/nature14539']));

        expect(error.message).toBe(`Crossref lookup failed (HTTP ${code})`);
        expect(error.context).toEqual({ source: 'crossref', status: code });
    });

    test('a network failure or timeout is a metadata error', async () => {
        const { resolver } = setup(() => {
            throw new TypeError('fetch failed');
        });

        const error = await caught(resolver.lookupDois(['10.1038/nature14539']));

        expect(error.message).toBe('Crossref lookup failed: fetch failed');
        expect(error.context).toEqual({ source: 'crossref' });
    });

    test('an unexpected shape is a metadata error', async () => {
        const { resolver } = setup(() => json({ status: 'ok', message: { items: [{ title: 'no DOI' }] } }));

        const error = await caught(resolver.lookupDois(['10.1038/x']));

        expect(error.message).toBe('unexpected Crossref response shape');
    });

    test('a non-JSON success body is an unexpected shape', async () => {
        const { resolver } = setup(() => status(200, '<html>'));

        const error = await caught(resolver.lookupDois(['10.1038/x']));
        expect(error.message).toBe('unexpected Crossref response shape');
    });
});

describe('Crossref type mapping', () => {
    async function mapOne(fields: Record<string, unknown>) {
        const { resolver } = setup(() => worksResponse([work(fields)]));
        const found = await resolver.lookupDois(['10.1234/x']);
        return found.get('10.1234/x')!;
    }

    test.each([
        ['journal-article', 'journalArticle'],
        ['proceedings-article', 'conferencePaper'],
        ['book', 'book'],
        ['monograph', 'book'],
        ['edited-book', 'book'],
        ['reference-book', 'book'],
        ['book-chapter', 'bookSection'],
        ['book-section', 'bookSection'],
        ['book-part', 'bookSection'],
        ['posted-content', 'preprint'],
        ['report', 'report'],
        ['dissertation', 'thesis'],
        ['dataset', 'dataset'],
        ['standard', 'standard'],
        ['peer-review', 'document'],
        ['constructor', 'document'],
    ])('%s → %s', async (type, itemType) => {
        const item = await mapOne({ type });
        expect(item.itemType).toBe(itemType);
    });

    test('a work without a type is a document', async () => {
        const item = await mapOne({});
        expect(item.itemType).toBe('document');
    });

    const everything = {
        'container-title':       ['Container'],
        'short-container-title': ['Cont.'],
        volume:                  '3',
        issue:                   '4',
        page:                    '10-20',
        ISSN:                    ['1111-2222'],
        ISBN:                    ['978-0', '978-1'],
        publisher:               'Pub',
        'publisher-location':    'Place',
        event:                   { name: 'Conf 2026' },
    };

    test.each([
        ['proceedings-article', { proceedingsTitle: 'Container', conferenceName: 'Conf 2026', pages: '10-20', publisher: 'Pub', place: 'Place' }],
        ['book', { publisher: 'Pub', place: 'Place', ISBN: '978-0 978-1' }],
        ['book-chapter', { bookTitle: 'Container', pages: '10-20', publisher: 'Pub', ISBN: '978-0 978-1' }],
        ['posted-content', { repository: 'Pub' }],
        ['report', { institution: 'Pub' }],
        ['dissertation', { university: 'Pub' }],
        ['dataset', { repository: 'Pub' }],
        ['standard', { organization: 'Pub' }],
        ['other', { publisher: 'Pub' }],
    ])('%s gets its type-specific fields', async (type, expected) => {
        const item = await mapOne({ type, ...everything });

        expect(item.fields).toEqual({ title: 'T', DOI: '10.1234/x', libraryCatalog: 'Crossref', accessDate: ACCESSED, ...expected });
    });

    test.each([
        [[[2015]], '2015'],
        [[[2015, 5]], '2015-05'],
        [[[2015, 5, 7]], '2015-05-07'],
        [[[2015, 12, 31]], '2015-12-31'],
        [[[null]], undefined],
        [[], undefined],
    ])('date-parts %j → %p', async (parts, date) => {
        const item = await mapOne({ issued: { 'date-parts': parts } });
        expect(item.fields.date as string | undefined).toBe(date);
    });

    test('a work with no issued date has no date', async () => {
        const item = await mapOne({ issued: {} });
        expect(item.fields.date).toBeUndefined();
    });

    test('organisation authors use a single name; editors are kept only for books and sections', async () => {
        const people = {
            author: [{ given: 'Ada', family: 'Lovelace' }, { name: 'The Consortium' }, { family: 'Mononym' }, {}],
            editor: [{ given: 'Ed', family: 'Itor' }],
        };

        const article = await mapOne({ type: 'journal-article', ...people });
        expect(article.creators).toEqual([
            { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
            { creatorType: 'author', name: 'The Consortium' },
            { creatorType: 'author', firstName: '', lastName: 'Mononym' },
        ]);

        for(const type of ['book', 'book-chapter']) {
            // eslint-disable-next-line no-await-in-loop -- two sequential cases of one assertion
            const item = await mapOne({ type, ...people });
            expect(item.creators.at(-1)).toEqual({ creatorType: 'editor', firstName: 'Ed', lastName: 'Itor' });
        }
    });

    test('a JATS abstract becomes plain text with paragraphs separated', async () => {
        const item = await mapOne({ 'abstract': '<jats:title>Abstract</jats:title><jats:p>One &amp; <jats:italic>two</jats:italic></jats:p>\n<jats:p>Three</jats:p><jats:sec><jats:p>Four</jats:p></jats:sec>' });

        expect(item.fields.abstractNote).toBe('Abstract One & two Three Four');
    });

    test('an empty abstract or title is left out', async () => {
        const item = await mapOne({ 'abstract': '  ', title: [] });

        expect(item.fields).not.toHaveProperty('abstractNote');
        expect(item.fields).not.toHaveProperty('title');
    });

    test('PDF candidates are the application/pdf links, deduplicated, in order', async () => {
        const item = await mapOne({
            link: [
                { URL: 'https://a.test/1.pdf', 'content-type': 'application/pdf' },
                { URL: 'https://a.test/page', 'content-type': 'text/html' },
                { URL: 'https://a.test/1.pdf', 'content-type': 'application/pdf' },
                { URL: 'https://a.test/2.pdf', 'content-type': 'application/pdf' },
                { URL: 'https://a.test/x' },
            ],
        });

        expect(item.pdfCandidates).toEqual(['https://a.test/1.pdf', 'https://a.test/2.pdf']);
    });

    test('null fields from Crossref are treated as absent', async () => {
        const item = await mapOne({ type: 'journal-article', 'container-title': null, volume: null, ISSN: null, link: null, author: null, 'abstract': null, URL: null });

        expect(item.fields).toEqual({ title: 'T', DOI: '10.1234/x', libraryCatalog: 'Crossref', accessDate: ACCESSED });
        expect(item.creators).toEqual([]);
        expect(item.pdfCandidates).toEqual([]);
    });
});
