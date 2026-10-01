/**
 * Builds the Zotero dependencies once per process (#157, design §10). One `ZoteroClient` is shared
 * by the conversation and perch sessions, so the Backoff/Retry-After deadline and the item-template
 * memo are shared too; the Crossref and arXiv resolvers likewise share arXiv's request spacing. No
 * network call is made here, so startup never depends on Zotero being up.
 */

import pLimit, { type LimitFunction } from 'p-limit';
import { ArxivResolver } from './arxiv';
import { ZoteroClient } from './client';
import { CrossrefResolver } from './crossref';
import type { MappedItem } from './item-fields';
import type { FetchLike } from './types';
import type { ZoteroConfig } from '@/config';

export interface ZoteroMetadataLookup {
    /** Keyed by lowercased DOI; unknown DOIs are absent. */
    lookupDois:  (dois: string[]) => Promise<Map<string, MappedItem>>
    /** Keyed by version-less arXiv id; unknown ids are absent. */
    lookupArxiv: (ids: string[]) => Promise<Map<string, MappedItem>>
}

export interface ZoteroDeps {
    client:             ZoteroClient
    metadata:           ZoteroMetadataLookup
    /** Cap for Zotero-storage downloads, local-file uploads, and PDFs fetched by URL. */
    maxStoredFileBytes: number
    /** Izzy's own Zotero user id, to label authorship. */
    izzyUserId:         number
    /** Serialises addPapers across both sessions so a duplicate check and its create cannot interleave. */
    addPapersLock:      LimitFunction
}

/** Test seams: the network and the clock. */
export interface ZoteroDepsOverrides {
    fetch?: FetchLike
    sleep?: (ms: number) => Promise<void>
    now?:   () => number
}

export function createZoteroDeps(config: ZoteroConfig, overrides: ZoteroDepsOverrides = {}): ZoteroDeps {
    // Equivalent to branching on config.crossrefMailto === undefined: CrossrefResolver reads deps.mailto
    // by plain property access, so passing `mailto: undefined` behaves exactly like omitting the key.
    const crossref = new CrossrefResolver({ ...overrides, mailto: config.crossrefMailto });
    const arxiv = new ArxivResolver(overrides);
    return {
        client:   new ZoteroClient({ apiKey: config.apiKey, groupId: config.groupId, ...overrides }),
        metadata: {
            lookupDois:  async dois => crossref.lookupDois(dois),
            lookupArxiv: async ids => arxiv.lookupIds(ids),
        },
        maxStoredFileBytes: config.maxStoredFileBytes,
        izzyUserId:         config.userId,
        addPapersLock:      pLimit(1),
    };
}
