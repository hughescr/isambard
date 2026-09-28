import { describe, expect, test } from 'bun:test';
import { parseCitationMeta } from '@/integrations/zotero/html-meta';

const PAGE = 'https://journal.example.org/articles/42';
const ACCESSED = '2026-09-27T12:00:00.000Z';

function page(head: string, body = ''): string {
    return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe('parseCitationMeta', () => {
    test('reads Highwire citation tags into a journal article', () => {
        const meta = parseCitationMeta(page(`
            <meta name="citation_title" content="Deep  learning &amp; you">
            <meta name="citation_author" content="LeCun, Yann">
            <meta name="citation_author" content="Yoshua Bengio">
            <meta name="citation_author" content="Consortium">
            <meta name="citation_publication_date" content="2015/05/27">
            <meta name="citation_journal_title" content="Nature">
            <meta name="citation_volume" content="521">
            <meta name="citation_issue" content="7553">
            <meta name="citation_firstpage" content="436">
            <meta name="citation_lastpage" content="444">
            <meta name="citation_pdf_url" content="/articles/42.pdf">
        `), PAGE, ACCESSED);

        expect(meta.doi).toBeUndefined();
        expect(meta.arxiv).toBeUndefined();
        expect(meta.pdfUrl).toBe('https://journal.example.org/articles/42.pdf');
        expect(meta.item).toEqual({
            itemType: 'journalArticle',
            fields:   {
                title:            'Deep learning & you',
                date:             '2015/05/27',
                url:              PAGE,
                accessDate:       ACCESSED,
                publicationTitle: 'Nature',
                volume:           '521',
                issue:            '7553',
                pages:            '436-444',
            },
            creators: [
                { creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' },
                { creatorType: 'author', firstName: 'Yoshua', lastName: 'Bengio' },
                { creatorType: 'author', name: 'Consortium' },
            ],
            pdfCandidates: ['https://journal.example.org/articles/42.pdf'],
        });
    });

    test('a conference title gives a conference paper; a lone first page is the page range', () => {
        const meta = parseCitationMeta(page(`
            <META NAME="Citation_Title" CONTENT="Attention">
            <meta name="citation_conference_title" content="NeurIPS">
            <meta name="citation_date" content="2017">
            <meta name="citation_firstpage" content="5998">
        `), PAGE, ACCESSED);

        expect(meta.item.itemType).toBe('conferencePaper');
        expect(meta.item.fields).toEqual({ title: 'Attention', date: '2017', url: PAGE, accessDate: ACCESSED, conferenceName: 'NeurIPS', pages: '5998' });
        expect(meta.item.pdfCandidates).toEqual([]);
    });

    test('citation_publication_date wins over citation_date', () => {
        const meta = parseCitationMeta(page('<meta name="citation_date" content="2001"><meta name="citation_publication_date" content="2002">'), PAGE, ACCESSED);

        expect(meta.item.fields.date).toBe('2002');
    });

    test('falls back to a webpage from og tags, then <title>', () => {
        const og = parseCitationMeta(page(`
            <title>Ignored</title>
            <meta property="og:title" content="OG title">
            <meta property="og:site_name" content="Example Site">
        `), PAGE, ACCESSED);
        expect(og.item).toEqual({
            itemType:      'webpage',
            fields:        { title: 'OG title', url: PAGE, accessDate: ACCESSED, websiteTitle: 'Example Site' },
            creators:      [],
            pdfCandidates: [],
        });

        const titled = parseCitationMeta(page('<title>\n  A   plain\n page </title>'), PAGE, ACCESSED);
        expect(titled.item.fields).toEqual({ title: 'A plain page', url: PAGE, accessDate: ACCESSED });
    });

    test('an empty page is a webpage with only its URL', () => {
        expect(parseCitationMeta('', PAGE, ACCESSED).item).toEqual({
            itemType:      'webpage',
            fields:        { url: PAGE, accessDate: ACCESSED },
            creators:      [],
            pdfCandidates: [],
        });
    });

    test.each([
        ['citation_doi', '<meta name="citation_doi" content="doi:10.1038/nature14539">'],
        ['dc.identifier', '<meta name="dc.identifier" content="ISSN 1234"><meta name="DC.Identifier" content="https://doi.org/10.1038/nature14539">'],
        ['prism.doi', '<meta name="prism.doi" content="10.1038/nature14539">'],
    ])('finds a DOI in %s', (_label, head) => {
        const meta = parseCitationMeta(page(head), PAGE, ACCESSED);

        expect(meta.doi).toBe('10.1038/nature14539');
        expect(meta.item.fields.DOI).toBe('10.1038/nature14539');
    });

    test('citation_doi wins over dc.identifier and prism.doi', () => {
        const meta = parseCitationMeta(page(`
            <meta name="prism.doi" content="10.3333/c">
            <meta name="dc.identifier" content="10.2222/b">
            <meta name="citation_doi" content="10.1111/a">
        `), PAGE, ACCESSED);

        expect(meta.doi).toBe('10.1111/a');
    });

    test('dc.identifier wins over prism.doi, and a non-DOI citation_doi is ignored', () => {
        const meta = parseCitationMeta(page(`
            <meta name="citation_doi" content="not a doi">
            <meta name="prism.doi" content="10.3333/c">
            <meta name="dc.identifier" content="10.2222/b">
        `), PAGE, ACCESSED);

        expect(meta.doi).toBe('10.2222/b');
    });

    test('finds an arXiv id', () => {
        const meta = parseCitationMeta(page('<meta name="citation_arxiv_id" content="1706.03762v7">'), PAGE, ACCESSED);

        expect(meta.arxiv).toEqual({ id: '1706.03762', version: 'v7' });
    });

    test('ignores an invalid arXiv id and an unresolvable PDF URL', () => {
        const meta = parseCitationMeta(page('<meta name="citation_arxiv_id" content="nope"><meta name="citation_pdf_url" content="http://[bad">'), PAGE, ACCESSED);

        expect(meta.arxiv).toBeUndefined();
        expect(meta.pdfUrl).toBeUndefined();
    });

    test('stops at </head>: body meta and titles are ignored', () => {
        const meta = parseCitationMeta(page('<title>Head title</title>', '<meta name="citation_doi" content="10.1038/body"><title>Body</title>'), PAGE, ACCESSED);

        expect(meta.doi).toBeUndefined();
        expect(meta.item.fields.title).toBe('Head title');
    });

    test('stops at <body> when there is no </head>', () => {
        const meta = parseCitationMeta('<html><meta name="citation_title" content="T"><body><meta name="citation_doi" content="10.1038/body">', PAGE, ACCESSED);

        expect(meta.item.fields.title).toBe('T');
        expect(meta.doi).toBeUndefined();
    });

    test('a title cut off by truncation is still used', () => {
        const meta = parseCitationMeta('<html><head><title>Cut  off', PAGE, ACCESSED);

        expect(meta.item.fields.title).toBe('Cut off');
    });

    test('an empty title is ignored in favour of the next one', () => {
        const meta = parseCitationMeta(page('<title>  </title><title>Second</title>'), PAGE, ACCESSED);

        expect(meta.item.fields.title).toBe('Second');
    });

    test('tolerates a prefix truncated mid-tag', () => {
        const meta = parseCitationMeta('<html><head><meta name="citation_title" content="Kept"><meta name="citation_doi" cont', PAGE, ACCESSED);

        expect(meta.item.fields.title).toBe('Kept');
        expect(meta.doi).toBeUndefined();
    });

    test('ignores meta tags without a name or content, and blank values', () => {
        const meta = parseCitationMeta(page('<meta charset="utf-8"><meta name="citation_title"><meta name="citation_journal_title" content="   "><meta content="orphan">'), PAGE, ACCESSED);

        expect(meta.item.itemType).toBe('webpage');
        expect(meta.item.fields).toEqual({ url: PAGE, accessDate: ACCESSED });
    });
});
