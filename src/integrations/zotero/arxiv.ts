/**
 * Batch arXiv lookup through the export API (#157, design §5.3): one Atom query for every id in a
 * call, parsed with htmlparser2 in XML mode and mapped to Zotero `preprint` items. Ids arXiv does
 * not know are simply absent (arXiv answers them with an error entry, which is skipped).
 *
 * arXiv asks for at most one request every 3 s. Each lookup reserves its slot before sending
 * (`#nextAllowedAt`), so concurrent lookups queue behind each other instead of bursting.
 */

import { Parser } from 'htmlparser2';
import { normalizeArxivId } from './identifiers';
import type { MappedCreator, MappedItem } from './item-fields';
import type { FetchLike } from './types';
import { ZoteroMetadataError } from '@/errors';

const QUERY_URL = 'https://export.arxiv.org/api/query';
const USER_AGENT = 'Isambard (+https://github.com/hughescr/isambard)';
const SPACING_MS = 3000;

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
    authors:     string[]
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
                    entry.authors.push(value);
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
        creators:      entry.authors.map(name => author(name)),
        pdfCandidates: entry.pdfUrl === undefined ? [] : [entry.pdfUrl.replace(/^http:\/\/arxiv\.org\//, 'https://arxiv.org/')],
    };
}

/** Resolves arXiv ids in one request per call, at most one request every 3 s. */
export class ArxivResolver {
    readonly #fetch:         FetchLike;
    readonly #sleep:         (ms: number) => Promise<void>;
    readonly #now:           () => number;
    readonly #timeoutMs:     number;
    readonly #timeoutSignal: (ms: number) => AbortSignal;
    #nextAllowedAt = 0;

    constructor(deps: ArxivDeps) {
        // Stryker disable next-line all: production default; tests always inject a fake fetch (no network in tests)
        this.#fetch = deps.fetch ?? (async (input, init) => fetch(input, init));
        // Stryker disable next-line all: production default; tests inject a fake clock (real timers are banned in tests)
        this.#sleep = deps.sleep ?? (async ms => Bun.sleep(ms));
        this.#now = deps.now ?? (() => Date.now());
        this.#timeoutMs = deps.timeoutMs ?? 30_000;
        this.#timeoutSignal = deps.timeoutSignal ?? (ms => AbortSignal.timeout(ms));
    }

    /**
     * Looks up version-less arXiv ids in one request. The result is keyed by version-less id; an id
     * arXiv does not know is absent. Throws `ZoteroMetadataError` when the call fails.
     */
    async lookupIds(ids: string[]): Promise<Map<string, MappedItem>> {
        const unique = [...new Set(ids)];
        if(unique.length === 0) {
            return new Map();
        }
        const url = new URL(QUERY_URL);
        url.searchParams.set('id_list', unique.join(','));
        url.searchParams.set('max_results', String(unique.length));

        const now = this.#now();
        const sendAt = Math.max(now, this.#nextAllowedAt);
        this.#nextAllowedAt = sendAt + SPACING_MS;
        if(sendAt > now) {
            await this.#sleep(sendAt - now);
        }

        let response: Response;
        try {
            response = await this.#fetch(url.href, { headers: { 'User-Agent': USER_AGENT }, signal: this.#timeoutSignal(this.#timeoutMs) });
        } catch (error) {
            throw new ZoteroMetadataError(`arXiv lookup failed: ${error instanceof Error ? error.message : String(error)}`, { source: 'arxiv' });
        }
        if(!response.ok) {
            await response.body?.cancel();
            throw new ZoteroMetadataError(`arXiv lookup failed (HTTP ${response.status})`, { source: 'arxiv', status: response.status });
        }

        const accessDate = new Date(this.#now()).toISOString();
        const found = new Map<string, MappedItem>();
        for(const entry of parseFeed(await response.text())) {
            const arxiv = normalizeArxivId(entry.id);
            if(arxiv !== undefined) {
                found.set(arxiv.id, mapEntry(arxiv.id, entry, accessDate));
            }
        }
        return found;
    }
}
