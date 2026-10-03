/**
 * Batch arXiv lookup (#157, design §5.3; abs-page fallback #177): one Atom query to the export API
 * for every id in a call, parsed with htmlparser2 in XML mode and mapped to Zotero `preprint`
 * items. Ids arXiv does not know are simply absent (arXiv answers them with an error entry, which
 * is skipped).
 *
 * When the export API is throttled (429), failing (5xx) or breaks in transit (a rejected fetch, a
 * timeout, or a body that fails mid-read), the lookup falls back to one `https://arxiv.org/abs/<id>`
 * request per id, read through the Highwire `citation_*` tags and mapped through the same
 * `mapEntry`, so both sources give the same item identity (preprint, `10.48550/arXiv.<id>` DOI,
 * `arXiv:<id>` archive id, abs URL). The abs page has no journal reference, and its journal DOI
 * (when one exists) only ever appears as `Published version DOI:` in `extra`. Any other API error
 * (a 4xx besides 429) is final: there is no fallback. When the abs page fails too, the one error
 * names both failures; partial fallback results are discarded.
 *
 * Both hosts are called through the injected `fetch` (the global one by default), the same trust as
 * the export API call. Abs URLs are built only from the fixed prefix and an id that already passed
 * `normalizeArxivId`; nothing the page says is ever fetched (`pdfUrl` is always built from the id).
 *
 * arXiv asks for at most one request every 3 s. Each request, API or abs, reserves its slot before
 * sending (`#reserveSlot`), so concurrent lookups queue behind each other instead of bursting, and
 * the 3 s spacing is shared by both hosts. An integer `Retry-After` on a non-OK response starts a
 * per-host cooldown held in memory (a restart clears it, a later shorter one never shortens it, and
 * there is no cap): during an API cooldown lookups go straight to the abs pages, and during an abs
 * cooldown a needed fallback fails at once. Nothing sleeps to wait out a `Retry-After`.
 */

import { Parser } from 'htmlparser2';
import { parseCitationMeta } from './html-meta';
import { normalizeArxivId } from './identifiers';
import type { MappedCreator, MappedItem } from './item-fields';
import { intHeader } from './request';
import { zoteroTimestamp } from './timestamp';
import type { FetchLike } from './types';
import { ZoteroMetadataError } from '@/errors';
import { deadlineFactory, type Deadline } from '@/utils';

const QUERY_URL = 'https://export.arxiv.org/api/query';
const ABS_URL = 'https://arxiv.org/abs/';
const PDF_URL = 'https://arxiv.org/pdf/';
const USER_AGENT = 'Isambard (+https://github.com/hughescr/isambard)';
const SPACING_MS = 3000;
const BACKING_OFF = 'backing off (Retry-After)';
/** An arXiv-minted DOI: it is the item's own DOI already, never a "published version". */
const ARXIV_MINTED_DOI = /^10\.48550\/arxiv\./i;

export interface ArxivDeps {
    fetch?:         FetchLike
    sleep?:         (ms: number) => Promise<void>
    now?:           () => number
    /** Default 30 s. */
    timeoutMs?:     number
    timeoutSignal?: (ms: number) => AbortSignal
}

/** The parts of one Atom `<entry>` the mapping uses. */
interface ArxivEntry {
    id:          string
    title:       string
    summary:     string
    published:   string
    authors:     MappedCreator[]
    pdfUrl?:     string
    doi?:        string
    journalRef?: string
}

function collapse(text: string): string {
    return text.replaceAll(/\s+/g, ' ').trim();
}

/** Every `<entry>` in the feed. Feed-level elements (its own title and id) are ignored. */
function parseFeed(xml: string): ArxivEntry[] {
    const entries: ArxivEntry[] = [];
    let entry: ArxivEntry | undefined;
    // Stryker disable next-line StringLiteral: `onopentag` resets `text` before any content-bearing close tag can read it, so this initial value is only ever visible to text seen before the very first open tag, which no case ever reads
    let text = '';
    const parser = new Parser({
        onopentag(name, attribs) {
            text = '';
            if(name === 'entry') {
                entry = {
                    // Stryker disable next-line StringLiteral: an id placeholder only reaches normalizeArxivId(), which rejects any non-id text exactly as it rejects '' — the entry is dropped either way
                    id:        '',
                    title:     '',
                    summary:   '',
                    // Stryker disable next-line StringLiteral: a published placeholder only reaches mapEntry's `^\d{4}-\d{2}-\d{2}` date regex, which any non-date text fails exactly as '' does
                    published: '',
                    authors:   [],
                };
            } else if(entry !== undefined && name === 'link' && attribs.title === 'pdf') {
                entry.pdfUrl = attribs.href;
            }
        },
        ontext(chunk) {
            text += chunk;
        },
        onclosetag(name) {
            if(entry === undefined) {
                return;
            }
            const value = collapse(text);
            switch(name) {
                case 'id': {
                    entry.id = value;
                    break;
                }
                case 'title': {
                    entry.title = value;
                    break;
                }
                case 'summary': {
                    entry.summary = value;
                    break;
                }
                case 'published': {
                    entry.published = value;
                    break;
                }
                case 'name': {
                    entry.authors.push(author(value));
                    break;
                }
                case 'arxiv:doi': {
                    entry.doi = value;
                    break;
                }
                case 'arxiv:journal_ref': {
                    entry.journalRef = value;
                    break;
                }
                case 'entry': {
                    entries.push(entry);
                    entry = undefined;
                    break;
                }
                // Stryker disable next-line ConditionalExpression,BlockStatement: the default case is the last clause in the switch, so an empty default and one that breaks both just end the switch with no effect
                default: {
                    break;
                }
            }
        },
    }, { xmlMode: true, decodeEntities: true });
    parser.write(xml);
    parser.end();
    return entries;
}

/** "First Middle Last" → first/last split on the last space; a single token is a `name`. */
function author(name: string): MappedCreator {
    const space = name.lastIndexOf(' ');
    return space === -1
        ? { creatorType: 'author', name }
        : { creatorType: 'author', firstName: name.slice(0, space), lastName: name.slice(space + 1) };
}

function mapEntry(id: string, entry: ArxivEntry, accessDate: string): MappedItem {
    const fields: Record<string, string> = {};
    const set = (field: string, value: string | undefined) => {
        if(value) {
            fields[field] = value;
        }
    };
    set('title', entry.title);
    set('abstractNote', entry.summary);
    set('date', /^\d{4}-\d{2}-\d{2}/.exec(entry.published)?.[0]);
    set('repository', 'arXiv');
    set('archiveID', `arXiv:${id}`);
    set('url', `https://arxiv.org/abs/${id}`);
    // The arXiv-minted DOI, as Zotero's own arXiv translator records it.
    set('DOI', `10.48550/arXiv.${id}`);
    set('libraryCatalog', 'arXiv.org');
    set('accessDate', accessDate);
    const extra = [
        entry.doi === undefined ? undefined : `Published version DOI: ${entry.doi}`,
        entry.journalRef === undefined ? undefined : `Journal ref: ${entry.journalRef}`,
    ].filter(line => line !== undefined);
    set('extra', extra.join('\n'));

    return {
        itemType:      'preprint',
        fields,
        creators:      entry.authors,
        pdfCandidates: entry.pdfUrl === undefined ? [] : [entry.pdfUrl.replace(/^http:\/\/arxiv\.org\//, 'https://arxiv.org/')],
    };
}

/**
 * An abs page as an arXiv entry, mapped through `mapEntry` so the identity matches the export API's.
 * The page must name the requested id (a version suffix is fine, parseCitationMeta strips it);
 * otherwise the id counts as absent. The journal DOI, when there is one, is only a published
 * version; an arXiv-minted DOI is dropped because `mapEntry` sets it as the item DOI itself.
 */
function mapAbsPage(id: string, html: string, accessDate: string): MappedItem | undefined {
    // Stryker disable next-line StringLiteral: equivalent; the page URL only feeds meta.item.fields.url and meta.pdfUrl, and mapAbsPage reads neither (mapEntry builds both from the id).
    const meta = parseCitationMeta(html, `${ABS_URL}${id}`, accessDate);
    if(meta.arxiv?.id !== id) {
        return undefined;
    }
    // Stryker disable next-line StringLiteral: equivalent; with no citation_date any non-date fallback string fails mapEntry's YYYY-MM-DD match, so the item gets no date either way.
    const citationDate = meta.item.fields.date ?? '';
    return mapEntry(id, {
        id,
        title:     meta.item.fields.title ?? '',
        summary:   meta.abstract ?? '',
        published: citationDate.replaceAll('/', '-'),
        authors:   meta.item.creators,
        pdfUrl:    `${PDF_URL}${id}`,
        doi:       meta.doi === undefined || ARXIV_MINTED_DOI.test(meta.doi) ? undefined : meta.doi,
    }, accessDate);
}

/** The one error for a lookup whose export API and abs page both failed (`status` only for an HTTP answer from the abs page). */
function absFailure(apiReason: string, id: string, absReason: string, status?: number): ZoteroMetadataError {
    return new ZoteroMetadataError(
        `arXiv lookup failed: export API ${apiReason}; abs page for ${id} ${absReason}`,
        status === undefined ? { source: 'arxiv' } : { source: 'arxiv', status }
    );
}

/** Cancels a response body without ever throwing: a failing cancel must not mask the real outcome. */
async function cancelBody(response: Response | undefined): Promise<void> {
    try {
        await response?.body?.cancel();
    } catch{
        // Best effort only: the response's own status or error is what gets reported.
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Either the items the export API returned, or why the API could not answer (the fallback's cue). */
type ApiOutcome = { found: Map<string, MappedItem> } | { reason: string };

/**
 * Resolves arXiv ids: one export API request per call, falling back to one abs-page request per id
 * when the API is throttled, down or fails in transit. At most one request every 3 s across both.
 */
export class ArxivResolver {
    readonly #fetch:     FetchLike;
    readonly #sleep:     (ms: number) => Promise<void>;
    readonly #now:       () => number;
    readonly #timeoutMs: number;
    readonly #deadline:  (ms: number) => Deadline;
    #nextAllowedAt = 0;
    /** Epoch ms before which the export API is skipped (an integer `Retry-After`); never lowered. */
    #apiBackoffUntil = Number.NEGATIVE_INFINITY;
    /** Epoch ms before which abs pages are not requested; never lowered. */
    #absBackoffUntil = Number.NEGATIVE_INFINITY;

    constructor(deps: ArxivDeps) {
        // Stryker disable next-line all: production default; tests always inject a fake fetch (no network in tests)
        this.#fetch = deps.fetch ?? (async (input, init) => fetch(input, init));
        // Stryker disable next-line all: production default; tests inject a fake clock (real timers are banned in tests)
        this.#sleep = deps.sleep ?? (async ms => Bun.sleep(ms));
        this.#now = deps.now ?? (() => Date.now());
        this.#timeoutMs = deps.timeoutMs ?? 30_000;
        this.#deadline = deadlineFactory(deps.timeoutSignal);
    }

    /**
     * Looks up version-less, already-normalised arXiv ids (`normalizeArxivId(...).id`) with one
     * export API request, or, when the API cannot answer (see the module header), one abs-page
     * request per id. The result is keyed by version-less id; an id arXiv does not know is absent.
     * Throws `ZoteroMetadataError` when the call fails.
     */
    async lookupIds(ids: string[]): Promise<Map<string, MappedItem>> {
        const unique = [...new Set(ids)];
        if(unique.length === 0) {
            return new Map();
        }
        const api = await this.#queryApi(unique);
        return 'found' in api ? api.found : this.#lookupAbsPages(unique, api.reason);
    }

    /** Reserves the next 3 s slot (shared by the API and the abs pages) and waits for it. */
    async #reserveSlot(): Promise<void> {
        const now = this.#now();
        const sendAt = Math.max(now, this.#nextAllowedAt);
        this.#nextAllowedAt = sendAt + SPACING_MS;
        if(sendAt > now) {
            await this.#sleep(sendAt - now);
        }
    }

    /** Starts (or extends, never shortens) a cooldown from an integer `Retry-After` on a non-OK response. */
    #noteRetryAfter(response: Response, endpoint: 'api' | 'abs'): void {
        const seconds = intHeader(response.headers, 'Retry-After');
        if(seconds === undefined) {
            return;
        }
        const until = this.#now() + seconds * 1000;
        if(endpoint === 'api') {
            this.#apiBackoffUntil = Math.max(this.#apiBackoffUntil, until);
        } else {
            this.#absBackoffUntil = Math.max(this.#absBackoffUntil, until);
        }
    }

    /**
     * One export API request for every id. Throttling (429), server errors (5xx) and transport or
     * body-read failures (timeouts and aborts included) are reported as a `reason` so the caller can
     * fall back; any other non-OK status throws.
     */
    async #queryApi(unique: string[]): Promise<ApiOutcome> {
        if(this.#now() < this.#apiBackoffUntil) {
            return { reason: BACKING_OFF };
        }
        await this.#reserveSlot();
        // Another lookup may have been throttled while this one waited for its slot.
        if(this.#now() < this.#apiBackoffUntil) {
            return { reason: BACKING_OFF };
        }
        const url = new URL(QUERY_URL);
        url.searchParams.set('id_list', unique.join(','));
        url.searchParams.set('max_results', String(unique.length));

        let response: Response | undefined;
        // Stryker disable next-line StringLiteral: equivalent; `body` is read only after `response.ok`, and that path always assigns it from `response.text()` first.
        let body = '';
        // The deadline covers reading the body too, so it stands down only once the body is in
        const deadline = this.#deadline(this.#timeoutMs);
        try {
            response = await this.#fetch(url.href, { headers: { 'User-Agent': USER_AGENT }, signal: deadline.signal });
            if(response.ok) {
                body = await response.text();
            }
        } catch (error) {
            await cancelBody(response);
            return { reason: describeError(error) };
        } finally {
            deadline.clear();
        }
        if(!response.ok) {
            this.#noteRetryAfter(response, 'api');
            await cancelBody(response);
            if(response.status === 429 || response.status >= 500) {
                return { reason: `HTTP ${response.status}` };
            }
            throw new ZoteroMetadataError(`arXiv lookup failed (HTTP ${response.status})`, { source: 'arxiv', status: response.status });
        }

        const accessDate = zoteroTimestamp(this.#now());
        const found = new Map<string, MappedItem>();
        for(const entry of parseFeed(body)) {
            const arxiv = normalizeArxivId(entry.id);
            if(arxiv !== undefined) {
                found.set(arxiv.id, mapEntry(arxiv.id, entry, accessDate));
            }
        }
        return { found };
    }

    /**
     * The abs-page fallback: one request per id, one at a time in input order, stopping at the first
     * failure (partial results are discarded). A 404, or a page that names no matching arXiv id,
     * means the id is absent; a failed transfer proves nothing, so it is an error.
     */
    async #lookupAbsPages(unique: string[], apiReason: string): Promise<Map<string, MappedItem>> {
        const accessDate = zoteroTimestamp(this.#now());
        const found = new Map<string, MappedItem>();
        for(const id of unique) {
            // eslint-disable-next-line no-await-in-loop -- arXiv's 3 s spacing makes these requests strictly sequential
            const page = await this.#getAbsPage(id, apiReason);
            if(page !== undefined) {
                const item = mapAbsPage(id, page, accessDate);
                if(item !== undefined) {
                    found.set(id, item);
                }
            }
        }
        return found;
    }

    /**
     * One abs-page request. Resolves with the page for a 200 and with `undefined` for a 404 (the id
     * is absent); every other outcome throws the combined failure. A non-OK answer starts any cooldown
     * its `Retry-After` asks for, and its body is cancelled.
     */
    async #getAbsPage(id: string, apiReason: string): Promise<string | undefined> {
        if(this.#now() < this.#absBackoffUntil) {
            throw absFailure(apiReason, id, BACKING_OFF);
        }
        await this.#reserveSlot();
        // Another lookup may have been throttled while this one waited for its slot.
        if(this.#now() < this.#absBackoffUntil) {
            throw absFailure(apiReason, id, BACKING_OFF);
        }
        let response: Response | undefined;
        let page: string | undefined;
        // The deadline covers reading the body too, so it stands down only once the page is in
        const deadline = this.#deadline(this.#timeoutMs);
        try {
            response = await this.#fetch(`${ABS_URL}${id}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: deadline.signal });
            if(response.status === 200) {
                page = await response.text();
            }
        } catch (error) {
            await cancelBody(response);
            throw absFailure(apiReason, id, describeError(error));
        } finally {
            deadline.clear();
        }
        if(response.status !== 200) {
            this.#noteRetryAfter(response, 'abs');
            await cancelBody(response);
            if(response.status !== 404) {
                throw absFailure(apiReason, id, `HTTP ${response.status}`, response.status);
            }
        }
        return page;
    }
}
