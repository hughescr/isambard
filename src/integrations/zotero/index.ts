/**
 * Zotero integration (#157): a Web API v3 client pinned to the shared group library, plus the
 * Crossref, arXiv and page-metadata lookups used to add papers.
 */

export {
    normalizeDoi,
    normalizeArxivId,
    classifyUrl,
    doiIdentityKey,
    urlIdentityKey,
    identityKeys,
    type ArxivId,
    type ClassifiedUrl,
    type IdentitySource
} from './identifiers';
export { textToNoteHtml } from './note-html';
export { fitToTemplate, type MappedCreator, type MappedItem, type NewItemData } from './item-fields';
export { parseCitationMeta, type CitationMeta } from './html-meta';
