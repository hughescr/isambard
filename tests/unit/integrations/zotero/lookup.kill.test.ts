/**
 * Kills surviving/uncovered mutants from the 2026-09-28 `bun mutate` run (#157, group "lookup") in
 * src/integrations/zotero/{arxiv,crossref,identifiers}.ts. Each test's comment names the mutant it
 * targets (file:line, mutator, replacement) and the specific behaviour that distinguishes it from the
 * original. Mutants judged equivalent are instead disabled at the source with a `// Stryker disable`
 * comment explaining why; none are re-tested here.
 */
import { describe, expect, test } from 'bun:test';
import { json, recordingFetch, type FakeHandler } from '../../../helpers/zotero-fake';
import { ZoteroMetadataError } from '@/errors';
import { ArxivResolver } from '@/integrations/zotero/arxiv';
import { CrossrefResolver } from '@/integrations/zotero/crossref';
import {
    doiIdentityKey,
    identityKeys,
    normalizeArxivId,
    normalizeDoi
} from '@/integrations/zotero/identifiers';

async function caught(promise: Promise<unknown>): Promise<ZoteroMetadataError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(ZoteroMetadataError);
        return error as ZoteroMetadataError;
    }
    throw new Error('expected a rejection');
}

describe('identifiers.ts regex anchoring', () => {
    // identifiers.ts:12 DOI_PREFIX Regex → /doi:\s*/i (drops the `^` anchor). An anchored prefix only
    // strips "doi:" at the very start; a value that already looks like a DOI but happens to contain
    // "doi:" later must be left alone.
    test('DOI_PREFIX only strips a leading "doi:", not one embedded further in', () => {
        expect(normalizeDoi('10.1038/doi:foo')).toBe('10.1038/doi:foo');
    });

    // identifiers.ts:13 DOI_URL_PREFIX Regex → drops the `^` anchor. An anchored prefix only fires the
    // doi.org-URL branch when the value actually starts with the URL; otherwise normalizeDoi falls
    // through to the plain `doi:` prefix branch instead.
    test('DOI_URL_PREFIX only matches a leading doi.org URL, not one embedded further in', () => {
        expect(normalizeDoi('doi:10.1038/https://doi.org/x')).toBe('10.1038/https://doi.org/x');
    });

    // identifiers.ts:15 ARXIV_NEW_STYLE Regex → `(v\d)?` (drops the `+`, so only a single version digit
    // is accepted).
    test('ARXIV_NEW_STYLE accepts a multi-digit version', () => {
        expect(normalizeArxivId('1706.03762v12')).toEqual({ id: '1706.03762', version: 'v12' });
    });

    // identifiers.ts:16 ARXIV_OLD_STYLE Regex → `(v\d)?` (drops the `+`).
    test('ARXIV_OLD_STYLE accepts a multi-digit version', () => {
        expect(normalizeArxivId('hep-th/9901001v12')).toEqual({ id: 'hep-th/9901001', version: 'v12' });
    });

    // identifiers.ts:16 ARXIV_OLD_STYLE Regex → drops the trailing `$` anchor, so trailing garbage
    // after a valid id no longer prevents a match.
    test('ARXIV_OLD_STYLE requires the match to reach the end of the string', () => {
        expect(normalizeArxivId('hep-th/9901001trailing')).toBeUndefined();
    });

    // identifiers.ts:17 ARXIV_PREFIX Regex → drops the `^` anchor. An anchored prefix only strips
    // "arxiv:" when it is the very start; a garbage-prefixed value must stay rejected.
    test('ARXIV_PREFIX only strips a leading "arxiv:", not one embedded further in', () => {
        expect(normalizeArxivId('xarxiv:hep-th/9901001')).toBeUndefined();
    });

    // identifiers.ts:18 ARXIV_URL_PREFIX Regex → drops the `^` anchor.
    test('ARXIV_URL_PREFIX only matches a leading arxiv.org URL, not one embedded further in', () => {
        expect(normalizeArxivId('xhttps://arxiv.org/abs/hep-th/9901001')).toBeUndefined();
    });

    // identifiers.ts:19 PDF_SUFFIX Regex → `/\.pdf/i` (drops the trailing `$`), so a ".pdf" anywhere in
    // the value gets stripped, not only a genuine trailing suffix.
    test('PDF_SUFFIX only strips a trailing ".pdf", not one embedded further in', () => {
        expect(normalizeArxivId('1706.03762.pdfv7')).toBeUndefined();
    });

    // identifiers.ts:103 minted-DOI Regex → drops the `^` anchor.
    test('the arXiv-minted-DOI pattern only matches at the start of the DOI', () => {
        expect(doiIdentityKey('x10.48550/arXiv.1706.03762')).toBe('doi:x10.48550/arxiv.1706.03762');
    });

    // identifiers.ts:103 minted-DOI Regex → drops the trailing `$` anchor. `.+` does not match `\n`
    // without the `s` flag, so anchoring at `$` is what makes a DOI with trailing content after a
    // newline fail entirely rather than matching just the part before it.
    test('the arXiv-minted-DOI pattern requires the capture to reach the end of the string', () => {
        expect(doiIdentityKey('10.48550/arXiv.1706.03762\nEXTRA')).toBe('doi:10.48550/arxiv.1706.03762\nextra');
    });
});

describe('identifiers.ts other survivors', () => {
    // identifiers.ts:70 ConditionalExpression → false (`version === undefined ? {id} : {id,version}`
    // always takes the `version` branch). `toEqual` treats a missing key and an explicit
    // `version: undefined` as equal, so the distinguishing check has to look at the object's own keys.
    test('an id with no version has no `version` property at all, not one set to undefined', () => {
        expect(Object.hasOwn(normalizeArxivId('1706.03762')!, 'version')).toBe(false);
    });

    // identifiers.ts:172 MethodExpression → `rawLine` (drops `.trim()`). A stray leading space on an
    // extra-field line must not defeat the anchored DOI_PREFIX/ARXIV_PREFIX gates.
    test('a leading space on an extra-field line is trimmed before the DOI/arXiv gate', () => {
        expect([...identityKeys({ extra: '  DOI: 10.1038/nature14539' })]).toEqual(['doi:10.1038/nature14539']);
    });

    // identifiers.ts:175 ConditionalExpression → true (`ARXIV_PREFIX.test(line)` always taken in the
    // else-if). A bare id with no "arXiv:" prefix must not be picked up from `extra`, even though
    // normalizeArxivId would happily parse it once handed to it directly.
    test('a bare id in extra with no "arXiv:" prefix is not read as an identity', () => {
        expect(identityKeys({ extra: '1706.03762' }).size).toBe(0);
    });
});

function crossrefSetup(handler: FakeHandler) {
    const { fetch, calls } = recordingFetch(handler);
    return {
        resolver: new CrossrefResolver({ fetch, now: () => Date.parse('2026-09-27T12:00:00.000Z'), timeoutSignal: () => new AbortController().signal }),
        calls,
    };
}

function worksResponse(items: unknown[]): Response {
    return json({ status: 'ok', 'message-type': 'work-list', message: { items } });
}

async function mapOne(fields: Record<string, unknown>) {
    const { resolver } = crossrefSetup(() => worksResponse([{ DOI: '10.1234/x', title: ['T'], ...fields }]));
    const found = await resolver.lookupDois(['10.1234/x']);
    return found.get('10.1234/x')!;
}

describe('crossref.ts survivors', () => {
    // crossref.ts:22 MAX_REASON_CHARS NumberLiteralValue → 299. Exact-length assertion (the existing
    // suite only checks `toStartWith` and an upper bound, which 299 also satisfies).
    test('a rejection reason longer than 300 characters is truncated to exactly 300', async () => {
        const reason = 'x'.repeat(305);
        const { resolver } = crossrefSetup(() => json({ status: 'failed', message: [{ message: reason }] }, { status: 400 }));

        const error = await caught(resolver.lookupDois(['10.1234/x']));

        expect(error.message).toBe(`Crossref rejected the request: ${'x'.repeat(300)}`);
    });

    // crossref.ts:109 ConditionalExpression → false (`body === null` half of the not-an-object guard).
    // A `null` response body must still be recognised as "not a rejection" so it falls through to the
    // shape-validation error, instead of crashing on `record.status` with `record` being `null`.
    test('a null response body is an unexpected shape, not a crash or a false rejection', async () => {
        const { resolver } = crossrefSetup(() => json(null));

        const error = await caught(resolver.lookupDois(['10.1234/x']));

        expect(error.message).toBe('unexpected Crossref response shape');
    });

    // crossref.ts:117 ConditionalExpression → true (`first !== null` half of the message-extraction
    // guard). `record.message[0]` being `null` (as opposed to absent) must still read as "no reason
    // given", not crash trying to read `.message` off `null`.
    test('a rejection message array holding null reads as "no reason given"', async () => {
        const { resolver } = crossrefSetup(() => json({ status: 'failed', message: [null] }, { status: 400 }));

        const error = await caught(resolver.lookupDois(['10.1234/x']));

        expect(error.message).toBe('Crossref rejected the request: no reason given');
    });

    // crossref.ts:127 ConditionalExpression → false, and 127 NumberLiteralValue → -1 (both turn off the
    // `i === 0` special case in the date-parts join, so every part — including the year — gets
    // `padStart(2, '0')`). A 4-digit year hides this because padding to 2 is a no-op; a single-digit
    // year does not.
    test('the first date-part (the year) is never zero-padded, even when short', async () => {
        const item = await mapOne({ issued: { 'date-parts': [[5]] } });

        expect(item.fields.date).toBe('5');
    });

    // crossref.ts:140 Regex → `/<(\/)jats:(?:p|title|sec)\b/g` (drops the `?` on the slash group, so
    // only closing tags convert). An unconverted opening tag drops the paragraph break the closing tag
    // alone would have inserted, running adjacent words together.
    test('a JATS opening tag becomes a paragraph break, not just its matching closing tag', async () => {
        const item = await mapOne({ 'abstract': 'A<jats:p>B</jats:p>C' });

        expect(item.fields.abstractNote).toBe('A B C');
    });
});

describe('arxiv.ts link-detection survivors', () => {
    function feedWith(entryXml: string): Response {
        return new Response(`<feed>${entryXml}</feed>`, { status: 200 });
    }

    function arxivSetup(handler: FakeHandler) {
        const { fetch } = recordingFetch(handler);
        return new ArxivResolver({ fetch, timeoutSignal: () => new AbortController().signal });
    }

    // arxiv.ts:55 ConditionalExpression → true (`name === 'link'` half of the pdf-link guard). A
    // non-`link` tag carrying `title="pdf"` must not be picked up as the PDF link.
    test('only a <link> tag can set the PDF url, not any tag with title="pdf"', async () => {
        const resolver = arxivSetup(() => feedWith('<entry><id>http://arxiv.org/abs/1706.03762</id><foo title="pdf" href="https://example.org/x.pdf"/></entry>'));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(found.get('1706.03762')?.pdfCandidates).toEqual([]);
    });

    // arxiv.ts:55 ConditionalExpression → true (`attribs.title === 'pdf'` half of the pdf-link guard).
    // A <link> with no title="pdf" (e.g. the feed's own "alternate" self-link) must not be picked up.
    test('only a <link title="pdf"> sets the PDF url, not any <link>', async () => {
        const resolver = arxivSetup(() => feedWith('<entry><id>http://arxiv.org/abs/1706.03762</id><link href="https://example.org/alt" rel="alternate" type="text/html"/></entry>'));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(found.get('1706.03762')?.pdfCandidates).toEqual([]);
    });

    // arxiv.ts:106 ObjectLiteral → {}, and 106 BooleanLiteral → false (both turn off xmlMode). Without
    // xmlMode htmlparser2 lowercases tag names, so a wrongly-cased <Title> would wrongly be read as
    // <title>; with xmlMode (the original), tag names are case-sensitive and <Title> is unrecognised.
    test('the XML parser is case-sensitive: an oddly-cased tag is not read as a known field', async () => {
        const resolver = arxivSetup(() => feedWith('<entry><id>http://arxiv.org/abs/1706.03762</id><Title>Should not be read</Title></entry>'));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(found.get('1706.03762')?.fields).not.toHaveProperty('title');
    });

    // arxiv.ts:108 CallExpression → `;` (drops the `parser.end()` call). Without `.end()`, unclosed
    // tags at the end of a truncated response never fire their closing events, so the entry the XML
    // never explicitly closes is silently dropped instead of being flushed out.
    test('a response body missing its closing tags is still flushed and parsed', async () => {
        const resolver = arxivSetup(() => new Response('<feed><entry><id>http://arxiv.org/abs/1706.03762</id><title>T</title>', { status: 200 }));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(found.size).toBe(1);
        expect(found.get('1706.03762')?.fields.title).toBe('T');
    });

    // Kill-review follow-up: the entry initializer's title/summary placeholders are empty strings, so
    // an entry whose feed omits <title> or <summary> carries no title or abstract rather than a
    // fabricated one.
    test('an entry with no <title> or <summary> has no title or abstractNote field', async () => {
        const resolver = arxivSetup(() => feedWith('<entry><id>http://arxiv.org/abs/1706.03762</id><published>2017-06-12T17:57:34Z</published></entry>'));

        const found = await resolver.lookupIds(['1706.03762']);

        const fields = found.get('1706.03762')?.fields;
        expect(fields?.date).toBe('2017-06-12');
        expect(fields).not.toHaveProperty('title');
        expect(fields).not.toHaveProperty('abstractNote');
    });

    // arxiv.ts:129 Regex → `/\d{4}-\d{2}-\d{2}/` (drops the `^` anchor), so a date-shaped substring
    // anywhere in <published> would be picked up, not only one at the very start.
    test('the published date is only read from the very start of the field', async () => {
        const resolver = arxivSetup(() => feedWith('<entry><id>http://arxiv.org/abs/1706.03762</id><published>Updated: 2020-01-01</published></entry>'));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(found.get('1706.03762')?.fields.date).toBeUndefined();
    });

    // arxiv.ts:147 Regex → drops the `^` anchor on the `http://arxiv.org/` → `https://` rewrite, so an
    // arxiv.org mirror URL embedded inside some other host's URL would also get rewritten.
    test('the http-to-https PDF rewrite only fires at the start of the url, not embedded further in', async () => {
        const resolver = arxivSetup(() => feedWith(
            '<entry><id>http://arxiv.org/abs/1706.03762</id>'
            + '<link title="pdf" href="https://mirror.example.org/proxy?u=http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/></entry>'
        ));

        const found = await resolver.lookupIds(['1706.03762']);

        expect(found.get('1706.03762')?.pdfCandidates).toEqual(['https://mirror.example.org/proxy?u=http://arxiv.org/pdf/1706.03762v7']);
    });
});

describe('arxiv.ts pacing survivors', () => {
    // arxiv.ts:158 NumberLiteralValue → -1 (`#nextAllowedAt = 0` → `-1`). Both values are indistinguishable
    // under a non-negative clock (both floor at `now`), so a deliberately negative `now()` on the very
    // first call is needed to tell `Math.max(now, 0)` apart from `Math.max(now, -1)`.
    test('the initial pacing floor is exactly 0, not -1', async () => {
        const sleeps: number[] = [];
        const { fetch } = recordingFetch(() => new Response('<feed></feed>', { status: 200 }));
        const resolver = new ArxivResolver({
            fetch,
            now:           () => -5,
            sleep:         async (ms) => { sleeps.push(ms); },
            timeoutSignal: () => new AbortController().signal,
        });

        await resolver.lookupIds(['1706.03762']);

        expect(sleeps).toEqual([5]);
    });

    // arxiv.ts:187 AwaitDrop (`this.#sleep(sendAt - now)` no longer awaited). A sleep whose own promise
    // takes several microtask turns to settle must still finish, and be observed to finish, strictly
    // before the request fires — an un-awaited call lets the fetch fire first.
    test('the pacing wait is awaited before the request goes out', async () => {
        const order: string[] = [];
        const sleep = async (ms: number) => {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            order.push(`slept:${ms}`);
        };
        const fetch = async () => {
            order.push('fetched');
            return new Response('<feed></feed>', { status: 200 });
        };
        const resolver = new ArxivResolver({
            now:           () => 1000,
            sleep,
            fetch,
            timeoutSignal: () => new AbortController().signal,
        });

        await resolver.lookupIds(['1706.03762']); // first call: nextAllowedAt starts at 0, now=1000, no sleep needed
        order.length = 0;
        await resolver.lookupIds(['hep-th/9901001']); // second call: must wait out the 3s spacing

        expect(order).toEqual(['slept:3000', 'fetched']);
    });

    // arxiv.ts:197 AwaitDrop (`await response.body?.cancel()` no longer awaited). The cancel must
    // finish, and be observed to finish, strictly before the HTTP error is thrown.
    test('the response body is drained before the HTTP error is thrown', async () => {
        const order: string[] = [];
        const cancel = async () => {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            order.push('cancelled');
        };
        const response = { ok: false, status: 503, body: { cancel } } as unknown as Response;
        const resolver = new ArxivResolver({ fetch: async () => response, timeoutSignal: () => new AbortController().signal });

        await caught(resolver.lookupIds(['1706.03762']));
        order.push('caught');

        expect(order).toEqual(['cancelled', 'caught']);
    });
});
