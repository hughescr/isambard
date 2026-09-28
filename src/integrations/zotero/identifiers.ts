/**
 * DOI and arXiv identifier normalisation, URL classification, and the identity keys addPapers uses
 * to find a paper that is already in the library (#157, design §5.1 and §6.2).
 *
 * Identity keys are plain strings: `doi:<lowercased DOI>`, `arxiv:<lowercased versionless id>` and
 * `url:<normalised URL>`. An arXiv-minted DOI (`10.48550/arXiv.<id>`) and an arxiv.org URL fold to
 * the arXiv key, and a doi.org URL folds to the DOI key, so the same paper reached three ways
 * compares equal.
 */

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const DOI_PREFIX = /^doi:\s*/i;
const DOI_URL_PREFIX = /^https?:\/\/(?:dx\.|www\.)?doi\.org\//i;

const ARXIV_NEW_STYLE = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_OLD_STYLE = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;
const ARXIV_PREFIX = /^arxiv:\s*/i;
const ARXIV_URL_PREFIX = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//i;
const PDF_SUFFIX = /\.pdf$/i;

const DOI_HOSTS = new Set(['doi.org', 'dx.doi.org', 'www.doi.org']);
const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);

/** An arXiv identifier: `id` is version-less (identity); `version` (e.g. `v7`) is kept for fetching the exact PDF. */
export interface ArxivId {
    id:       string
    version?: string
}

/** A classified URL input: doi.org and arxiv.org links resolve without fetching the page. */
export type ClassifiedUrl = { kind: 'doi', doi: string } | { kind: 'arxiv', arxiv: ArxivId } | { kind: 'url', url: string };

/** Fields of a Zotero item (or a resolved candidate) that carry identity. */
export interface IdentitySource {
    DOI?:       unknown
    archiveID?: unknown
    url?:       unknown
    extra?:     unknown
}

/**
 * The bare DOI in `input` (a DOI, `doi:<DOI>`, or a doi.org / dx.doi.org URL), or undefined when it
 * is not DOI-shaped. Case is preserved; compare DOIs lowercased.
 */
export function normalizeDoi(input: string): string | undefined {
    let value = input.trim();
    if(DOI_URL_PREFIX.test(value)) {
        try {
            value = decodeURIComponent(value.replace(DOI_URL_PREFIX, ''));
        } catch{
            return undefined;
        }
    } else {
        value = value.replace(DOI_PREFIX, '');
    }
    return DOI_PATTERN.test(value) ? value : undefined;
}

/**
 * The arXiv id in `input` (a new- or old-style id, `arXiv:<id>`, or an arxiv.org abs/pdf URL, with
 * an optional trailing `.pdf`), or undefined when it is not an arXiv id.
 */
export function normalizeArxivId(input: string): ArxivId | undefined {
    const value = input.trim().replace(ARXIV_PREFIX, '').replace(ARXIV_URL_PREFIX, '').replace(PDF_SUFFIX, '');
    const match = ARXIV_NEW_STYLE.exec(value) ?? ARXIV_OLD_STYLE.exec(value);
    if(!match) {
        return undefined;
    }
    const [, id, version] = match;
    return version === undefined ? { id: id! } : { id: id!, version };
}

/** Classifies a URL input: a doi.org link is a DOI and an arxiv.org abs/pdf link is an arXiv id; anything else is a plain URL. */
export function classifyUrl(url: string): ClassifiedUrl {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch{
        return { kind: 'url', url };
    }
    if(DOI_HOSTS.has(parsed.hostname)) {
        const doi = normalizeDoi(`https://doi.org${parsed.pathname}`);
        if(doi !== undefined) {
            return { kind: 'doi', doi };
        }
    }
    if(ARXIV_HOSTS.has(parsed.hostname)) {
        const arxiv = normalizeArxivId(`https://arxiv.org${parsed.pathname}`);
        if(arxiv !== undefined) {
            return { kind: 'arxiv', arxiv };
        }
    }
    return { kind: 'url', url };
}

/** The identity key for an arXiv id. */
function arxivIdentityKey(arxiv: ArxivId): string {
    return `arxiv:${arxiv.id.toLowerCase()}`;
}

/** The identity key for a DOI: `doi:<lowercased>`, or the arXiv key for an arXiv-minted `10.48550/arXiv.<id>` DOI. */
export function doiIdentityKey(doi: string): string {
    const minted = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
    const arxiv = minted ? normalizeArxivId(minted[1]!) : undefined;
    return arxiv ? arxivIdentityKey(arxiv) : `doi:${doi.toLowerCase()}`;
}

/**
 * The identity key for an http(s) URL: doi.org and arxiv.org links fold to their DOI/arXiv key;
 * anything else is `url:` plus the lowercased scheme and host (default port dropped), the path
 * without trailing slashes, and the query, with the fragment dropped.
 */
export function urlIdentityKey(url: string): string | undefined {
    const classified = classifyUrl(url);
    if(classified.kind === 'doi') {
        return doiIdentityKey(classified.doi);
    }
    if(classified.kind === 'arxiv') {
        return arxivIdentityKey(classified.arxiv);
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch{
        return undefined;
    }
    if(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return undefined;
    }
    let pathname = parsed.pathname;
    while(pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
    }
    return `url:${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

/**
 * Every identity key of an item: from `DOI`, `archiveID` (`arXiv:<id>`), `url`, and the `DOI: …`
 * and `arXiv: …` lines of `extra` (the Zotero connector's and `fitToTemplate`'s convention).
 * `Published version DOI:` lines are not identity: a preprint and its journal version are
 * different items.
 */
export function identityKeys(source: IdentitySource): Set<string> {
    const keys = new Set<string>();
    const addDoi = (value: string) => {
        const doi = normalizeDoi(value);
        if(doi !== undefined) {
            keys.add(doiIdentityKey(doi));
        }
    };
    const addArxiv = (value: string) => {
        const arxiv = normalizeArxivId(value);
        if(arxiv !== undefined) {
            keys.add(arxivIdentityKey(arxiv));
        }
    };

    if(typeof source.DOI === 'string') {
        addDoi(source.DOI);
    }
    if(typeof source.archiveID === 'string' && ARXIV_PREFIX.test(source.archiveID)) {
        addArxiv(source.archiveID);
    }
    if(typeof source.url === 'string') {
        const key = urlIdentityKey(source.url);
        if(key !== undefined) {
            keys.add(key);
        }
    }
    if(typeof source.extra === 'string') {
        for(const rawLine of source.extra.split('\n')) {
            const line = rawLine.trim();
            if(DOI_PREFIX.test(line)) {
                addDoi(line);
            } else if(ARXIV_PREFIX.test(line)) {
                addArxiv(line);
            }
        }
    }
    return keys;
}
