/**
 * Agent-side Zotero helpers (#157): URL fetching under the browser host policy, the addPapers and
 * file flows, and output shaping. The MCP server in `../zotero-mcp-server.ts` is the only consumer.
 */

export { fetchUnderHostPolicy, type UrlFetchOptions, type UrlFetchResult } from './url-fetch';
export { addPapers, type AddPapersDeps, type AddPapersOptions, type PaperInput, type PaperResult } from './add-papers';
export {
    attachPdfs,
    downloadAttachments,
    storePdfs,
    type AttachPdfInput,
    type DownloadedFile,
    type SkippedDownload,
    type StoredPdf,
    type ZoteroFileDeps
} from './files';
export {
    UNTRUSTED_NOTICE,
    collectionRows,
    formatAnnotation,
    formatAttachment,
    formatNote,
    htmlToText,
    clip,
    itemFields,
    summarizeItem
} from './format';
