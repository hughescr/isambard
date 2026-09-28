/**
 * Citation metadata from the `<head>` of an arbitrary page (#157, design §5.4). Pure: the agent
 * layer fetches the page under the browser host policy and passes the (possibly truncated) HTML
 * prefix in. Parsing stops at `</head>` or `<body>`; a prefix cut mid-tag is not an error.
 *
 * The page may name a DOI (`citation_doi`, a DOI-shaped `dc.identifier`, `prism.doi`) or an arXiv id
 * (`citation_arxiv_id`), which the caller resolves through Crossref or arXiv. Otherwise the Highwire
 * `citation_*` tags, then `og:*` tags and `<title>`, describe the item directly.
 */

import { Parser } from 'htmlparser2';
import { normalizeArxivId, normalizeDoi, type ArxivId } from './identifiers';
import type { MappedCreator, MappedItem } from './item-fields';

/** What a page's `<head>` says about the work it presents. */
export interface CitationMeta {
    doi?:    string
    arxiv?:  ArxivId
    /** `citation_pdf_url`, resolved against the page URL. It still has to pass the host policy when fetched. */
    pdfUrl?: string
    /** The page's own description of the item: a journal article, conference paper or webpage. */
    item:    MappedItem
}

function collapse(text: string): string {
    return text.replaceAll(/\s+/g, ' ').trim();
}

/** The `<meta>` values (by lowercased name or property) and the first `<title>` of the head. */
function readHead(html: string): { metas: Map<string, string[]>, title?: string } {
    const metas = new Map<string, string[]>();
    let title: string | undefined;
    let titleText: string | undefined;

    // pause() stops the tokenizer, so nothing after </head> or <body> produces an event; end() then
    // only closes the elements still open (which finishes a <title> cut off by truncation).
    const parser = new Parser({
        onopentag(name, attribs) {
            if(name === 'body') {
                parser.pause();
            } else if(name === 'title' && title === undefined) {
                titleText = '';
            } else if(name === 'meta') {
                const key = (attribs.name ?? attribs.property)?.toLowerCase();
                const content = collapse(attribs.content ?? '');
                // Stryker disable next-line ConditionalExpression: an undefined key can only reach Map.set under this guard's removal, and nothing ever reads metas.get(undefined), so the entry is unobservable.
                if(key !== undefined && content !== '') {
                    metas.set(key, [...metas.get(key) ?? [], content]);
                }
            }
        },
        ontext(text) {
            if(titleText !== undefined) {
                titleText += text;
            }
        },
        onclosetag(name) {
            // Stryker disable next-line ConditionalExpression: <title> is HTML raw-text, so no other tag can close while titleText is set; name is always 'title' whenever titleText !== undefined, making the (name === 'title') half of this guard redundant on its own. (The EqualityOperator flip of the same comparison is NOT equivalent — see "pauses at </head> even without a wrapping <body> tag" below, which kills it.)
            if(name === 'title' && titleText !== undefined) {
                title = collapse(titleText) || undefined;
                titleText = undefined;
            } else if(name === 'head') {
                parser.pause();
            }
        },
    },
    // Stryker disable next-line ObjectLiteral: htmlparser2's Tokenizer defaults decodeEntities to true, so passing `{ decodeEntities: true }` or `{}` here is behaviourally identical.
    { decodeEntities: true });
    parser.write(html);
    parser.end();
    // Stryker disable next-line ConditionalExpression: title is destructured by callers as `const { title } = readHead(...)`, and an explicitly-undefined property reads back identically to an absent one, so always spreading `title` is unobservable.
    return title === undefined ? { metas } : { metas, title };
}

/** A Highwire `citation_author`: "Last, First", "First Last", or a single-token organisation name. */
function parseAuthor(value: string): MappedCreator {
    const comma = value.indexOf(',');
    if(comma !== -1) {
        return { creatorType: 'author', firstName: value.slice(comma + 1).trim(), lastName: value.slice(0, comma).trim() };
    }
    const space = value.lastIndexOf(' ');
    return space === -1
        ? { creatorType: 'author', name: value }
        : { creatorType: 'author', firstName: value.slice(0, space), lastName: value.slice(space + 1) };
}

function resolveUrl(value: string | undefined, base: string): string | undefined {
    if(value === undefined) {
        return undefined;
    }
    try {
        return new URL(value, base).href;
    // eslint-disable-next-line @stylistic/brace-style -- `catch` deliberately on its own line, not `} catch{`: a Stryker `disable next-line` comment placed immediately before "} catch{" attaches to the try block's last statement, not to the catch clause (Babel comment-attachment), so it silently fails to suppress the mutant on the (equivalent) catch body below.
    }
    // Stryker disable next-line BlockStatement: emptying this catch drops only its explicit `return undefined;`; a non-returning function implicitly returns undefined at runtime, so the observable result is identical.
    catch{
        return undefined;
    }
}

/**
 * Reads citation metadata from an HTML prefix. `pageUrl` is the final URL of the page (used for
 * `url` and to resolve a relative `citation_pdf_url`); `accessDate` is an ISO timestamp.
 */
export function parseCitationMeta(html: string, pageUrl: string, accessDate: string): CitationMeta {
    const { metas, title } = readHead(html);
    const first = (key: string) => metas.get(key)?.[0];
    const all = (key: string) => metas.get(key) ?? [];

    const doi = [...all('citation_doi'), ...all('dc.identifier'), ...all('prism.doi')]
        .map(value => normalizeDoi(value))
        .find(value => value !== undefined);
    const arxivValue = first('citation_arxiv_id');
    const arxiv = arxivValue === undefined ? undefined : normalizeArxivId(arxivValue);
    const pdfUrl = resolveUrl(first('citation_pdf_url'), pageUrl);

    const journal = first('citation_journal_title');
    const conference = first('citation_conference_title');
    let itemType = 'webpage';
    if(journal !== undefined) {
        itemType = 'journalArticle';
    } else if(conference !== undefined) {
        itemType = 'conferencePaper';
    }

    const fields: Record<string, string> = {};
    const set = (field: string, value: string | undefined) => {
        if(value !== undefined) {
            fields[field] = value;
        }
    };
    set('title', first('citation_title') ?? first('og:title') ?? title);
    set('date', first('citation_publication_date') ?? first('citation_date'));
    set('url', pageUrl);
    set('accessDate', accessDate);
    set('DOI', doi);
    if(itemType === 'webpage') {
        set('websiteTitle', first('og:site_name'));
    } else {
        set('publicationTitle', journal);
        set('conferenceName', conference);
        set('volume', first('citation_volume'));
        set('issue', first('citation_issue'));
        const firstPage = first('citation_firstpage');
        const lastPage = first('citation_lastpage');
        set('pages', firstPage === undefined ? undefined : [firstPage, lastPage].filter(page => page !== undefined).join('-'));
    }

    return {
        ...doi === undefined ? {} : { doi },
        ...arxiv === undefined ? {} : { arxiv },
        ...pdfUrl === undefined ? {} : { pdfUrl },
        item: {
            itemType,
            fields,
            creators:      all('citation_author').map(value => parseAuthor(value)),
            pdfCandidates: pdfUrl === undefined ? [] : [pdfUrl],
        },
    };
}
