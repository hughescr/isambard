/**
 * Batch DOI lookup through Crossref's `/works` filter (#157, design §5.2): one request for every DOI
 * in a call, mapped to Zotero item types and fields. A DOI Crossref does not know is simply absent
 * from the result. A `validation-failure` body (for example a `select` field Crossref no longer
 * accepts) is a typed error, never "not found" for every DOI.
 */

import { convert } from 'html-to-text';
import { z } from 'zod';
import type { MappedCreator, MappedItem } from './item-fields';
import type { FetchLike } from './types';
import { ZoteroMetadataError } from '@/errors';

/**
 * Only fields in the valid-select list Crossref itself returned (2026-09-27). `select` stays because
 * it drops `reference[]`, about 4x the payload.
 */
export const CROSSREF_SELECT = 'DOI,type,title,author,editor,container-title,short-container-title,volume,issue,page,issued,ISSN,ISBN,publisher,publisher-location,abstract,link,URL,event';

const WORKS_URL = 'https://api.crossref.org/works';
const USER_AGENT = 'Isambard (+https://github.com/hughescr/isambard';
const MAX_REASON_CHARS = 300;

export interface CrossrefDeps {
    fetch?:         FetchLike
    /** Sent in the User-Agent so requests join Crossref's polite pool. */
    mailto?:        string
    now?:           () => number
    /** Default 30 s. */
    timeoutMs?:     number
    timeoutSignal?: (ms: number) => AbortSignal
}

const personSchema = z.looseObject({
    given:  z.string().nullish(),
    family: z.string().nullish(),
    name:   z.string().nullish(),
});

const stringList = z.array(z.string()).nullish();

const workSchema = z.looseObject({
    DOI:                     z.string(),
    type:                    z.string().nullish(),
    title:                   stringList,
    author:                  z.array(personSchema).nullish(),
    editor:                  z.array(personSchema).nullish(),
    'container-title':       stringList,
    'short-container-title': stringList,
    volume:                  z.string().nullish(),
    issue:                   z.string().nullish(),
    page:                    z.string().nullish(),
    issued:                  z.looseObject({ 'date-parts': z.array(z.array(z.number().nullable())).nullish() }).nullish(),
    ISSN:                    stringList,
    ISBN:                    stringList,
    publisher:               z.string().nullish(),
    'publisher-location':    z.string().nullish(),
    'abstract':              z.string().nullish(),
    link:                    z.array(z.looseObject({ URL: z.string(), 'content-type': z.string().nullish() })).nullish(),
    URL:                     z.string().nullish(),
    event:                   z.looseObject({ name: z.string().nullish() }).nullish(),
});

const worksResponseSchema = z.looseObject({
    message: z.looseObject({ items: z.array(workSchema) }),
});

type CrossrefWork = z.infer<typeof workSchema>;
type Person = z.infer<typeof personSchema>;

const ITEM_TYPES = new Map<string, string>([
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
]);

/** Where each item type keeps `publisher`, for the types that rename it. */
const PUBLISHER_FIELD = new Map<string, string>([
    ['preprint', 'repository'],
    ['report', 'institution'],
    ['thesis', 'university'],
    ['dataset', 'repository'],
    ['standard', 'organization'],
    ['document', 'publisher'],
]);

/** The parsed body, or undefined for a body that is not JSON (an error page, say). */
function parseJson(text: string): unknown {
    // Stryker disable BlockStatement: an empty catch still falls off the end of the function, which implicitly returns undefined — identical to `return undefined`
    try {
        return JSON.parse(text) as unknown;
    } catch{
        return undefined;
    }
}

// Stryker restore BlockStatement
/** Crossref's rejection message for a failed request, or undefined when the body is not a rejection. */
function rejectionReason(body: unknown): string | undefined {
    if(typeof body !== 'object' || body === null) {
        return undefined;
    }
    const record = body as Record<string, unknown>;
    if(record.status !== 'failed' && record['message-type'] !== 'validation-failure') {
        return undefined;
    }
    const first: unknown = Array.isArray(record.message) ? record.message[0] : undefined;
    const message = typeof first === 'object' && first !== null ? (first as { message?: unknown }).message : undefined;
    return typeof message === 'string' ? message.slice(0, MAX_REASON_CHARS) : 'no reason given';
}

/**
 * `YYYY[-MM[-DD]]` from Crossref's `date-parts`, or `''` when there are none. Equivalent-mutant
 * simplification: the empty-parts guard used to `return undefined` explicitly, but `set()` (the only
 * caller) drops falsy values, so the `''` this produces without the guard is already indistinguishable
 * from `undefined` at the only call site — the guard was dead weight.
 */
function dateFrom(work: CrossrefWork): string {
    const parts = (work.issued?.['date-parts']?.[0] ?? []).filter(part => part !== null);
    return parts.map((part, i) => (i === 0 ? String(part) : String(part).padStart(2, '0'))).join('-');
}

function creator(person: Person, creatorType: string): MappedCreator | undefined {
    if(person.family) {
        return { creatorType, firstName: person.given ?? '', lastName: person.family };
    }
    const name = person.name ?? person.given;
    return name ? { creatorType, name } : undefined;
}

/** JATS abstract markup to plain text: block elements become breaks, then all whitespace collapses. */
function plainAbstract(abstract: string): string {
    const blocks = abstract.replaceAll(/<(\/?)jats:(?:p|title|sec)\b/g, '<$1p');
    // Stryker disable next-line ObjectLiteral: wordwrap only inserts line breaks at whitespace, which the trailing `.replaceAll(/\s+/g, ' ')` collapses right back out — the option is unobservable in the returned text
    return convert(blocks, { wordwrap: false }).replaceAll(/\s+/g, ' ').trim();
}

type FieldSetter = (field: string, value: string | null | undefined) => void;

/** The fields specific to one item type (design §5.2 type table). */
function setTypeFields(itemType: string, work: CrossrefWork, set: FieldSetter): void {
    const container = work['container-title']?.[0];
    switch(itemType) {
        case 'journalArticle': {
            set('publicationTitle', container);
            set('journalAbbreviation', work['short-container-title']?.[0]);
            set('volume', work.volume);
            set('issue', work.issue);
            set('pages', work.page);
            set('ISSN', work.ISSN?.join(', '));
            break;
        }
        case 'conferencePaper': {
            set('proceedingsTitle', container);
            set('conferenceName', work.event?.name);
            set('pages', work.page);
            set('publisher', work.publisher);
            set('place', work['publisher-location']);
            break;
        }
        case 'book': {
            set('publisher', work.publisher);
            set('place', work['publisher-location']);
            set('ISBN', work.ISBN?.join(' '));
            break;
        }
        case 'bookSection': {
            set('bookTitle', container);
            set('pages', work.page);
            set('publisher', work.publisher);
            set('ISBN', work.ISBN?.join(' '));
            break;
        }
        default: {
            set(PUBLISHER_FIELD.get(itemType)!, work.publisher);
        }
    }
}

function mapWork(work: CrossrefWork, accessDate: string): MappedItem {
    // Stryker disable next-line StringLiteral: the fallback only feeds ITEM_TYPES.get(), whose keys are all fixed known strings — any non-key placeholder here (this one included) misses the map the same way and falls to the `?? 'document'` after it
    const itemType = ITEM_TYPES.get(work.type ?? '') ?? 'document';
    const fields: Record<string, string> = {};
    const set: FieldSetter = (field, value) => {
        if(value) {
            fields[field] = value;
        }
    };

    set('title', work.title?.[0]);
    set('date', dateFrom(work));
    set('DOI', work.DOI);
    set('url', work.URL);
    set('abstractNote', work.abstract ? plainAbstract(work.abstract) : undefined);
    set('libraryCatalog', 'Crossref');
    set('accessDate', accessDate);
    setTypeFields(itemType, work, set);

    const withEditors = itemType === 'book' || itemType === 'bookSection';
    const creators = [
        ...(work.author ?? []).map(person => creator(person, 'author')),
        ...(withEditors ? work.editor ?? [] : []).map(person => creator(person, 'editor')),
    ].filter(entry => entry !== undefined);

    const pdfCandidates = [...new Set((work.link ?? [])
        .filter(link => link['content-type'] === 'application/pdf')
        .map(link => link.URL))];

    return { itemType, fields, creators, pdfCandidates };
}

/** Resolves DOIs through Crossref in one request per call. */
export class CrossrefResolver {
    readonly #fetch:         FetchLike;
    readonly #userAgent:     string;
    readonly #now:           () => number;
    readonly #timeoutMs:     number;
    readonly #timeoutSignal: (ms: number) => AbortSignal;

    constructor(deps: CrossrefDeps) {
        // Stryker disable next-line all: production default; tests always inject a fake fetch (no network in tests)
        this.#fetch = deps.fetch ?? (async (input, init) => fetch(input, init));
        const contact = deps.mailto === undefined ? '' : `; mailto:${deps.mailto}`;
        this.#userAgent = `${USER_AGENT}${contact})`;
        this.#now = deps.now ?? (() => Date.now());
        this.#timeoutMs = deps.timeoutMs ?? 30_000;
        this.#timeoutSignal = deps.timeoutSignal ?? (ms => AbortSignal.timeout(ms));
    }

    /**
     * Looks up every DOI in one request. The result is keyed by lowercased DOI; a DOI Crossref does
     * not know is absent. Throws `ZoteroMetadataError` for a rejected request or a failed call.
     */
    async lookupDois(dois: string[]): Promise<Map<string, MappedItem>> {
        const unique = [...new Set(dois.map(doi => doi.toLowerCase()))];
        if(unique.length === 0) {
            return new Map();
        }
        const url = new URL(WORKS_URL);
        url.searchParams.set('filter', unique.map(doi => `doi:${doi}`).join(','));
        url.searchParams.set('rows', String(unique.length));
        url.searchParams.set('select', CROSSREF_SELECT);

        let response: Response;
        try {
            response = await this.#fetch(url.href, {
                headers: { Accept: 'application/json', 'User-Agent': this.#userAgent },
                signal:  this.#timeoutSignal(this.#timeoutMs),
            });
        } catch (error) {
            throw new ZoteroMetadataError(`Crossref lookup failed: ${error instanceof Error ? error.message : String(error)}`, { source: 'crossref' });
        }

        const body = parseJson(await response.text());
        const reason = rejectionReason(body);
        if(reason !== undefined) {
            throw new ZoteroMetadataError(`Crossref rejected the request: ${reason}`, { source: 'crossref', status: response.status, reason: 'request rejected' });
        }
        if(!response.ok) {
            throw new ZoteroMetadataError(`Crossref lookup failed (HTTP ${response.status})`, { source: 'crossref', status: response.status });
        }
        const parsed = worksResponseSchema.safeParse(body);
        if(!parsed.success) {
            throw new ZoteroMetadataError('unexpected Crossref response shape', { source: 'crossref' });
        }

        const accessDate = new Date(this.#now()).toISOString();
        return new Map(parsed.data.message.items.map(work => [work.DOI.toLowerCase(), mapWork(work, accessDate)]));
    }
}
