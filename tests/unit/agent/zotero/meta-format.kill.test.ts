/**
 * Mutation-kill tests for #157's `meta-format` survivor group: `src/integrations/zotero/html-meta.ts`
 * and `src/agent/zotero/format.ts`. Each test targets one or more specific surviving mutants (see the
 * comment above it); genuinely equivalent mutants are marked in the production source with `// Stryker
 * disable` instead, and are not re-tested here.
 */
import { describe, expect, test } from 'bun:test';
import { formatAttachment, formatCreators, itemFields, summarizeItem } from '@/agent/zotero/format';
import type { ZoteroItem } from '@/integrations/zotero';
import { parseCitationMeta } from '@/integrations/zotero/html-meta';

const PAGE = 'https://journal.example.org/articles/42';
const ACCESSED = '2026-09-27T12:00:00.000Z';

function page(head: string, body = ''): string {
    return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function item(data: Record<string, unknown>, meta: Record<string, unknown> = {}): ZoteroItem {
    return { key: 'ABCD2345', version: 3, meta, data: { key: 'ABCD2345', version: 3, itemType: 'journalArticle', ...data } };
}

describe('parseCitationMeta (html-meta.ts)', () => {
    // Kills line 41 ConditionalExpression->true (`title === undefined`): without the guard, a second
    // <title> would reset titleText and overwrite an already-captured first title. Also kills line 52
    // ConditionalExpression->true (`titleText !== undefined` in ontext): without it, the whitespace
    // text node between the two titles leaks into titleText, tainting the second title's capture.
    test('keeps the first non-empty title, ignoring a later one', () => {
        const meta = parseCitationMeta(page(`
            <title>First</title>
            <meta name="unrelated" content="x">
            <title>Second</title>
        `), PAGE, ACCESSED);

        expect(meta.item.fields.title).toBe('First');
    });

    // Kills line 43 ConditionalExpression->true (`name === 'meta'`): a non-<meta> tag that happens to
    // carry name/content attributes must not be read as citation metadata.
    test('only reads name/content attributes off an actual <meta> tag', () => {
        const meta = parseCitationMeta(page('<link name="citation_journal_title" content="FakeJournal">'), PAGE, ACCESSED);

        expect(meta.item.itemType).toBe('webpage');
        expect(meta.item.fields.publicationTitle).toBeUndefined();
    });

    // General coverage: entity decoding inside <title> element text (not attribute content, which the
    // existing suite already covers). Note: htmlparser2's Tokenizer defaults decodeEntities to true, so
    // the `{ decodeEntities: true }` ObjectLiteral mutant at line 64 is equivalent and marked in source.
    test('decodes an HTML entity inside <title> text', () => {
        const meta = parseCitationMeta(page('<title>Cats &amp; Dogs</title>'), PAGE, ACCESSED);

        expect(meta.item.fields.title).toBe('Cats & Dogs');
    });

    // Kills line 57 EqualityOperator->`name !== 'title'` and the four `</head>`-pause mutants at lines
    // 60-61 (ConditionalExpression->false, StringLiteral->'', BlockStatement->{}, CallExpression->';').
    // Each disables the head-close pause; with no wrapping <body> tag, the redundant body-open pause
    // (line 39-40, unmutated) can no longer mask the loss, so a trailing meta tag leaks through.
    test('pauses at </head> even without a wrapping <body> tag', () => {
        const meta = parseCitationMeta('<html><head><title>Head title</title></head><meta name="citation_doi" content="10.1038/hidden">', PAGE, ACCESSED);

        expect(meta.doi).toBeUndefined();
        expect(meta.item.fields.title).toBe('Head title');
    });

    // Kills line 74 NumberLiteralValue 1->2 (`value.slice(comma + 1)`): with no space after the comma,
    // skipping an extra character drops the first letter of the first name.
    test('parses a citation_author with no space after the comma', () => {
        const meta = parseCitationMeta(page('<meta name="citation_author" content="Turing,Alan">'), PAGE, ACCESSED);

        expect(meta.item.creators).toEqual([{ creatorType: 'author', firstName: 'Alan', lastName: 'Turing' }]);
    });

    // Kills line 74 MethodExpression (`.trim()` dropped from `value.slice(0, comma)`): a space before
    // the comma would leak into the last name without the trim.
    test('trims a citation_author last name padded before the comma', () => {
        const meta = parseCitationMeta(page('<meta name="citation_author" content="Turing , Alan">'), PAGE, ACCESSED);

        expect(meta.item.creators).toEqual([{ creatorType: 'author', firstName: 'Alan', lastName: 'Turing' }]);
    });

    // Kills line 138 ConditionalExpression->false (`firstPage === undefined`): without a first page, no
    // 'pages' field should be set at all (not an empty-string one from joining two undefineds).
    test('omits pages entirely for a journal article with no first page', () => {
        const meta = parseCitationMeta(page('<meta name="citation_journal_title" content="Nature">'), PAGE, ACCESSED);

        expect(meta.item.fields).not.toHaveProperty('pages');
    });

    // Kills lines 142-144 ConditionalExpression->false (`doi/arxiv/pdfUrl === undefined`): each spreads
    // an explicit `{ x: undefined }` instead of omitting the key, which toBeUndefined() alone can't see.
    test('omits the doi, arxiv and pdfUrl keys entirely when none are present', () => {
        const meta = parseCitationMeta('', PAGE, ACCESSED);

        expect(Object.keys(meta)).toEqual(['item']);
    });

    // Kill-review follow-up: an empty citation meta is not recorded, so it cannot shadow a later
    // non-empty value of the same name.
    test('skips an empty citation meta so a later value of the same name is read', () => {
        const meta = parseCitationMeta(page('<meta name="citation_title" content="  "><meta name="citation_title" content="Real title">'), PAGE, ACCESSED);

        expect(meta.item.fields.title).toBe('Real title');
    });

    // Kill-review follow-up: a <meta> with content but neither name nor property (http-equiv, say) is
    // ignored rather than recorded under no key or tripping the parse.
    test('ignores a meta with content but no name or property', () => {
        const meta = parseCitationMeta(page('<meta http-equiv="refresh" content="5"><meta property="citation_doi" content="10.1038/prop">'), PAGE, ACCESSED);

        expect(meta.doi).toBe('10.1038/prop');
    });
});

describe('itemFields (format.ts)', () => {
    // Kills line 18 StringLiteral->'' for 'version', 'creators', 'tags', 'collections', 'relations',
    // and line 19 StringLiteral->'' for 'deleted': each must stay excluded even when given as a string.
    test('excludes every non-editable key, not just a mutated one', () => {
        expect(itemFields({
            title: 'Kept', version: 'v', creators: 'c', tags: 't', collections: 'co', relations: 'r', deleted: 'd',
        })).toEqual({ title: 'Kept' });
    });
});

describe('formatCreators (format.ts)', () => {
    // Kills line 53 ConditionalExpression->true (`typeof name === 'string'`): a non-string name with no
    // lastName must still be dropped, not stringified into the output.
    test('drops a creator whose name is not a string and has no lastName', () => {
        expect(formatCreators([{ creatorType: 'organization', name: 123 }])).toBe('');
    });

    // Kills line 54 ConditionalExpression->true and StringLiteral->"Stryker was here!" (`lastName !== ''`):
    // an empty-string lastName must not be treated as present.
    test('drops a creator with an empty-string lastName', () => {
        expect(formatCreators([{ creatorType: 'author', firstName: 'Ada', lastName: '' }])).toBe('');
    });

    // Kills line 55 NoCoverage StringLiteral->"Stryker was here!" (the ternary's '' alternate): a
    // creator with a lastName but no firstName must render as the bare surname.
    test('renders a lastName-only creator without a stray initials suffix', () => {
        expect(formatCreators([{ creatorType: 'author', lastName: 'Curie' }])).toBe('Curie');
    });

    // Kills line 58 ConditionalExpression->false, StringLiteral->"Stryker was here!" and
    // BlockStatement->{} (`if(label === '') { return []; }`): a creator with no usable name must be
    // dropped rather than contributing a stray empty entry to the joined string.
    test('drops a creator with no usable name from a multi-creator list', () => {
        expect(formatCreators([{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }, {}])).toBe('Lovelace, A.');
    });

    // Kills line 61 ConditionalExpression->false (`typeof creatorType !== 'string'`): a creator with no
    // creatorType at all must render as a bare label, not "label (undefined)".
    test('renders a creator with no creatorType as a bare label', () => {
        expect(formatCreators([{ firstName: 'Ada', lastName: 'Lovelace' }])).toBe('Lovelace, A.');
    });

    // Kill-review follow-up: a null creator is dropped (not destructured, which would throw), and so is
    // any non-object, including a function whose own `name` property would otherwise become a label.
    test('drops null, primitive and function creators', () => {
        function Smith(): void {
            // A creator that is not a plain object.
        }
        expect(formatCreators([null, 'Jones', 7, true, Smith, { lastName: 'Doe' }])).toBe('Doe');
    });

    // Kill-review follow-up: initials come from each whitespace-separated token, however much
    // whitespace separates them, and an all-whitespace first name gives no initials at all.
    test('takes one initial per whitespace-separated first-name token', () => {
        expect(formatCreators([
            { firstName: '  John \t Ronald  Reuel ', lastName: 'Tolkien' },
            { firstName: '   ', lastName: 'Curie' },
            { firstName: '', lastName: 'Noether' },
        ])).toBe('Tolkien, J. R. R.; Curie; Noether');
    });
});

describe('tagNames via summarizeItem (format.ts)', () => {
    // Kills line 80 ConditionalExpression->true (`typeof tag === 'string'`): a non-string tag value must
    // be filtered out, not passed through.
    test('drops a non-string tag value', () => {
        const summary = summarizeItem(item({ tags: [{ tag: 'ml' }, { tag: 42 }, {}] }), 1);

        expect(summary.tags).toEqual(['ml']);
    });
});

describe('formatAttachment (format.ts)', () => {
    // Kills line 170 ConditionalExpression->true (`linkMode === 'imported_file' || linkMode === 'imported_url'`):
    // an md5 alone must not report hasFile when linkMode doesn't say the file is actually stored.
    test('reports no file for an unstored linkMode even when md5 is present', () => {
        const attachment = item({ itemType: 'attachment', linkMode: 'linked_file', md5: 'abc123' });

        expect(formatAttachment(attachment, undefined, 1).hasFile).toBe(false);
    });
});
