/**
 * Targeted kills for surviving/uncovered mutants in src/agent/zotero/files.ts (#157).
 *
 * Kept separate from files.test.ts so this group's work does not conflict with parallel work on
 * that file. Some tests here go around the real ZoteroClient with a minimal stub (cast through
 * `unknown`) to reach branches the real client never produces (e.g. an indeterminate cleanup
 * outcome with no detail), and some gate a fake response with a deferred promise to measure the
 * exact concurrency cap of an internal `pLimit`.
 */
/* eslint-disable n/no-sync -- real filesystem fixtures: node:fs/promises is globally mocked in tests/setup.ts, and these tests exercise real syscalls */
import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    attachPdfs,
    downloadAttachments,
    forceExtension,
    storePdfs,
    type ZoteroFileDeps
} from '../../../../src/agent/zotero/files';
import type { UrlFetchResult } from '../../../../src/agent/zotero/url-fetch';
import { ZoteroFileError } from '../../../../src/errors';
import * as zoteroUtils from '../../../../src/utils';
import { FakeZoteroServer, STORAGE, clientFor, json, status, type RecordedCall } from '../../../helpers/zotero-fake';

// Taken at load, before any spy: a spy on the barrel also rebinds the module's own export.
const realOpenContainedForRead = zoteroUtils.openContainedForRead;

const PDF = new TextEncoder().encode('%PDF-1.7 kill bytes');
const PARENT = 'PRNT9999';

function md5(bytes: Uint8Array): string {
    // eslint-disable-next-line sonarjs/hashing -- the md5 Zotero's file protocol uses as a content identity
    return createHash('md5').update(bytes).digest('hex');
}

let base: string;
let counter = 0;

beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'zotero-files-kill-'));
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

/** A fresh root directory for one test. */
function freshRoot(): string {
    counter++;
    const root = path.join(base, `root-${counter}`);
    mkdirSync(root);
    return root;
}

function pathOf(call: RecordedCall): string {
    return new URL(call.url).pathname.replace('/groups/6692257', '');
}

function setup(configure?: (server: FakeZoteroServer) => void, overrides: Partial<ZoteroFileDeps> = {}) {
    const server = new FakeZoteroServer();
    server.addItem({ key: PARENT, itemType: 'journalArticle', title: 'Parent' });
    configure?.(server);
    const deps: ZoteroFileDeps = {
        client:             clientFor(server),
        root:               freshRoot(),
        maxStoredFileBytes: 1000,
        fetchPdf:           async (url): Promise<UrlFetchResult> => ({ finalUrl: url, kind: 'pdf', bytes: PDF, truncated: false }),
        now:                () => 1_700_000_000_000,
        ...overrides,
    };
    return { server, deps };
}

function attachment(server: FakeZoteroServer, key: string, data: Record<string, unknown> = {}, file?: Uint8Array): void {
    server.addItem({ key, itemType: 'attachment', parentItem: PARENT, linkMode: 'imported_file', contentType: 'application/pdf', filename: 'paper.pdf', title: 'PDF', md5: null, ...data });
    if(file) {
        server.storeFile(key, file);
    }
}

/** Rewrites one entry's field in the JSON body of a GET /items response; other calls pass through untouched. */
function withRewrittenItem(server: FakeZoteroServer, key: string, patch: (entry: { key: string }) => Record<string, unknown>): void {
    const original = server.respond.bind(server);
    server.override = (call) => {
        const response = original(call);
        if(call.method !== 'GET' || pathOf(call) !== '/items') {
            return response;
        }
        return response.json().then((body: { key: string }[]) => json(
            body.map(entry => (entry.key === key ? { ...entry, ...patch(entry) } : entry)),
            { headers: { 'Total-Results': response.headers.get('Total-Results')!, 'Last-Modified-Version': '1' } }
        ));
    };
}

/** Runs `fn` until `condition` holds or the microtask budget runs out, without any real timer. */
async function pumpUntil(condition: () => boolean, maxTicks = 50): Promise<void> {
    for(let i = 0; i < maxTicks && !condition(); i++) {
        // eslint-disable-next-line no-await-in-loop -- each iteration must observe the previous microtask's effect before deciding whether to pump again
        await Promise.resolve();
    }
}

/** Frees every currently-queued deferred task and clears the queue. */
function releaseAll(releases: (() => void)[]): void {
    for(const release of releases.splice(0)) {
        release();
    }
}

/** A promise that stays pending, and registers its own resolver into `releases`, until `releaseAll` runs. */
function gate(releases: (() => void)[]): Promise<void> {
    return new Promise<void>((resolve) => {
        releases.push(resolve);
    });
}

describe('imported_url is a stored link mode', () => {
    test('an imported_url attachment downloads like imported_file', async () => {
        const { deps } = setup(s => attachment(s, 'ATTU2345', { linkMode: 'imported_url' }, PDF));

        const result = await downloadAttachments(deps, ['ATTU2345']);

        expect(result.skipped).toEqual([]);
        expect(result.files).toHaveLength(1);
    });
});

describe('forceExtension', () => {
    test('appends the extension even when it already appears mid-name', () => {
        expect(forceExtension('paper.pdfx', '.pdf')).toBe('paper.pdfx.pdf');
    });
});

describe('storePdfs via a stub client', () => {
    test('leaves the not-created default when Zotero reports the create as unchanged, not failed', async () => {
        const client = {
            createItems:          async (items: unknown[]) => ({ successful: [], unchanged: items.map((_, index) => ({ index, key: `STUB${index}` })), failed: [] }),
            uploadAttachmentFile: async () => { throw new Error('should not be called'); },
            cleanupPlaceholders:  async () => { throw new Error('should not be called'); },
        } as unknown as Parameters<typeof storePdfs>[0];

        const results = await storePdfs(client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], () => 0);

        expect(results).toEqual([{ pdf: 'failed: not created' }]);
    });

    test('never calls the client when there is nothing to store', async () => {
        let calls = 0;
        const client = {
            createItems: async () => {
                calls++;
                return { successful: [], unchanged: [], failed: [] };
            },
            uploadAttachmentFile: async () => { throw new Error('should not be called'); },
            cleanupPlaceholders:  async () => { throw new Error('should not be called'); },
        } as unknown as Parameters<typeof storePdfs>[0];

        expect(await storePdfs(client, [], () => 0)).toEqual([]);
        expect(calls).toBe(0);
    });

    test('does not call cleanupPlaceholders when every upload succeeds', async () => {
        let cleanupCalls = 0;
        const client = {
            createItems:          async (items: unknown[]) => ({ successful: items.map((_, index) => ({ index, key: `STUB${index}`, version: 1 })), unchanged: [], failed: [] }),
            uploadAttachmentFile: async () => 'uploaded' as const,
            cleanupPlaceholders:  async () => {
                cleanupCalls++;
                return [];
            },
        } as unknown as Parameters<typeof storePdfs>[0];

        const results = await storePdfs(client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], () => 0);

        expect(results).toEqual([{ pdf: 'attached', attachmentKey: 'STUB0' }]);
        expect(cleanupCalls).toBe(0);
    });

    test('uses the hardcoded changed-concurrently text, not the cleanup outcome detail', async () => {
        const client = {
            createItems:          async (items: unknown[]) => ({ successful: items.map((_, index) => ({ index, key: `STUB${index}`, version: 1 })), unchanged: [], failed: [] }),
            uploadAttachmentFile: async () => { throw new Error('boom'); },
            cleanupPlaceholders:  async (entries: { key: string }[]) => entries.map(entry => ({ key: entry.key, outcome: 'changed', detail: 'a distinguishing detail that is not the hardcoded text' })),
        } as unknown as Parameters<typeof storePdfs>[0];

        const [result] = await storePdfs(client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], () => 0);

        expect(result).toEqual({ pdf: 'failed: boom; attachment changed concurrently; left as is (key STUB0)', attachmentKey: 'STUB0' });
    });

    test('falls back to "state unknown" when an indeterminate outcome carries no detail', async () => {
        const client = {
            createItems:          async (items: unknown[]) => ({ successful: items.map((_, index) => ({ index, key: `STUB${index}`, version: 1 })), unchanged: [], failed: [] }),
            uploadAttachmentFile: async () => { throw new Error('boom'); },
            cleanupPlaceholders:  async (entries: { key: string }[]) => entries.map(entry => ({ key: entry.key, outcome: 'indeterminate' })),
        } as unknown as Parameters<typeof storePdfs>[0];

        const [result] = await storePdfs(client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], () => 0);

        expect(result).toEqual({ pdf: 'failed: boom; state unknown (key STUB0)', attachmentKey: 'STUB0' });
    });

    test('uploads at most two files at a time', async () => {
        let active = 0;
        let maxActive = 0;
        const releases: (() => void)[] = [];
        const client = {
            createItems:          async (items: unknown[]) => ({ successful: items.map((_, index) => ({ index, key: `STUB${index}`, version: 1 })), unchanged: [], failed: [] }),
            uploadAttachmentFile: async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await gate(releases);
                active--;
                return 'uploaded' as const;
            },
            cleanupPlaceholders: async () => [],
        } as unknown as Parameters<typeof storePdfs>[0];

        const pdfs = Array.from({ length: 4 }, (_, i) => ({ parentKey: PARENT, title: 'T', filename: `${i}.pdf`, bytes: PDF }));
        const promise = storePdfs(client, pdfs, () => 0);

        await pumpUntil(() => releases.length >= 2);
        expect(releases).toHaveLength(2);
        releaseAll(releases);

        await pumpUntil(() => releases.length >= 2);
        expect(releases).toHaveLength(2);
        releaseAll(releases);

        const results = await promise;
        expect(results).toHaveLength(4);
        expect(maxActive).toBe(2);
    });

    // Kill-review follow-up: Promise.all → Promise.race would return as soon as the first upload
    // finished, leaving the second PDF's result at its 'failed: not created' default.
    test('waits for every upload before returning', async () => {
        const releases: (() => void)[] = [];
        let uploads = 0;
        const client = {
            createItems:          async (items: unknown[]) => ({ successful: items.map((_, index) => ({ index, key: `STUB${index}`, version: 1 })), unchanged: [], failed: [] }),
            uploadAttachmentFile: async () => {
                uploads++;
                if(uploads === 2) {
                    await gate(releases);
                }
                return 'uploaded' as const;
            },
            cleanupPlaceholders: async () => [],
        } as unknown as Parameters<typeof storePdfs>[0];
        let settled = false;

        const promise = storePdfs(client, [
            { parentKey: PARENT, title: 'A', filename: 'a.pdf', bytes: PDF },
            { parentKey: PARENT, title: 'B', filename: 'b.pdf', bytes: PDF },
        ], () => 0).then((results) => {
            settled = true;
            return results;
        });
        await pumpUntil(() => settled);

        expect(settled).toBe(false);
        expect(releases).toHaveLength(1);
        releaseAll(releases);
        expect(await promise).toEqual([
            { pdf: 'attached', attachmentKey: 'STUB0' },
            { pdf: 'attached', attachmentKey: 'STUB1' },
        ]);
    });

    // Kill-review follow-up: Promise.all → Promise.allSettled would swallow a failure the upload task's
    // own catch cannot absorb (here errorMessage's String() of a prototype-less object throws), leaving
    // an orphan placeholder reported as 'failed: not created' and never cleaned up.
    test('propagates a failure the upload task cannot handle instead of swallowing it', async () => {
        const client = {
            createItems:          async (items: unknown[]) => ({ successful: items.map((_, index) => ({ index, key: `STUB${index}`, version: 1 })), unchanged: [], failed: [] }),
            // The point of the test: a rejection value that cannot even be stringified.
            uploadAttachmentFile: async () => {
                throw Object.create(null);
            },
            cleanupPlaceholders: async () => [],
        } as unknown as Parameters<typeof storePdfs>[0];

        await expect(storePdfs(client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], () => 0)).rejects.toThrow(TypeError);
    });

    // Kill-review follow-up: a successful index outside the batch (an unvalidated Zotero response) is
    // refused before any upload starts, with the stray key named.
    test('refuses a create result whose successful index is outside the batch, before uploading anything', async () => {
        const uploaded: string[] = [];
        const client = {
            createItems: async () => ({
                successful: [{ index: 0, key: 'STUB0', version: 1 }, { index: 1, key: 'STRAY', version: 1 }],
                unchanged:  [],
                failed:     [],
            }),
            uploadAttachmentFile: async (key: string) => {
                uploaded.push(key);
                return 'uploaded' as const;
            },
            cleanupPlaceholders: async () => [],
        } as unknown as Parameters<typeof storePdfs>[0];

        let error: unknown;
        try {
            await storePdfs(client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], () => 0);
        } catch (error_) {
            error = error_;
        }

        expect(error).toBeInstanceOf(ZoteroFileError);
        expect((error as ZoteroFileError).message).toBe('Zotero reported attachment STRAY created at index 1, outside the batch of 1; nothing was uploaded');
        expect((error as ZoteroFileError).context).toEqual({ reason: 'upload_failed', key: 'STRAY' });
        expect(uploaded).toEqual([]);
    });
});

describe('attachPdfs', () => {
    test('a local PDF that grows while it is read is refused, and nothing is created or uploaded', async () => {
        const { server, deps } = setup();
        const file = path.join(deps.root, 'growing.pdf');
        writeFileSync(file, PDF);
        // The real read, with the file appended to on disk just after its size is taken, as a PDF still being written would be.
        spyOn(zoteroUtils, 'openContainedForRead').mockImplementation(async (root, rel, maxBytes) => realOpenContainedForRead(root, rel, maxBytes, {
            io: real => ({
                ...real,
                fstat: async (fd) => {
                    const stat = await real.fstat(fd);
                    appendFileSync(file, ' the rest of the paper');
                    return stat;
                },
            }),
        }));

        const results = await attachPdfs(deps, [{ parentKey: PARENT, source: { path: 'growing.pdf' } }]);

        expect(results).toEqual([{ parentKey: PARENT, pdf: 'failed: File changed while it was being read: growing.pdf' }]);
        expect(server.calls).toEqual([]);
        expect(server.files.size).toBe(0);
    });

    test('derives the filename from the last path segment and forces a .pdf extension', async () => {
        const { server, deps } = setup();
        mkdirSync(path.join(deps.root, 'papers', 'sub'), { recursive: true });
        writeFileSync(path.join(deps.root, 'papers', 'sub', 'paperfile'), PDF);

        const results = await attachPdfs(deps, [{ parentKey: PARENT, source: { path: 'papers/sub/paperfile' } }]);

        const stored = server.items.get(results[0].attachmentKey!)!;
        expect(stored.data.filename).toBe('paperfile.pdf');
    });

    test('creates attachments in input order even though loading may finish out of order', async () => {
        const { server, deps } = setup();
        mkdirSync(path.join(deps.root, 'papers'));
        writeFileSync(path.join(deps.root, 'papers', 'first.pdf'), PDF);
        writeFileSync(path.join(deps.root, 'papers', 'second.pdf'), PDF);

        const results = await attachPdfs(deps, [
            { parentKey: PARENT, source: { path: 'papers/first.pdf' }, title: 'First' },
            { parentKey: PARENT, source: { path: 'papers/second.pdf' }, title: 'Second' },
        ]);

        const created = JSON.parse(server.calls.find(call => call.method === 'POST' && pathOf(call) === '/items')!.bodyText!) as { title: string }[];
        expect(created.map(entry => entry.title)).toEqual(['First', 'Second']);
        expect(results.map(result => result.pdf)).toEqual(['attached', 'attached']);
    });

    test('loads at most three sources at a time', async () => {
        let active = 0;
        let maxActive = 0;
        const releases: (() => void)[] = [];
        const { deps } = setup(undefined, {
            fetchPdf: async (url) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await gate(releases);
                active--;
                return { finalUrl: url, kind: 'pdf', bytes: PDF, truncated: false };
            },
        });
        const inputs = Array.from({ length: 5 }, (_, i) => ({ parentKey: PARENT, source: { url: `https://x.test/${i}.pdf` } }));

        const promise = attachPdfs(deps, inputs);

        await pumpUntil(() => releases.length >= 3);
        expect(releases).toHaveLength(3);
        releaseAll(releases);

        await pumpUntil(() => releases.length >= 2);
        expect(releases).toHaveLength(2);
        releaseAll(releases);

        await promise;
        expect(maxActive).toBe(3);
    });
});

describe('downloadAttachments: ineligible reasons', () => {
    test('excludes an annotation with the same shape of reason as a note', async () => {
        const { deps } = setup((s) => {
            s.addItem({ key: 'ANNT2345', itemType: 'annotation', parentItem: PARENT });
        });

        const result = await downloadAttachments(deps, ['ANNT2345']);

        expect(result).toEqual({ files: [], skipped: [{ key: 'ANNT2345', reason: 'not an attachment (annotation)' }] });
    });

    test('reports the exact reason for a key that does not match the Zotero key pattern', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTK2345', {}, PDF));
        withRewrittenItem(server, 'ATTK2345', () => ({ key: 'bad-key!!' }));

        const result = await downloadAttachments(deps, ['ATTK2345']);

        // Renaming the returned item's key makes the original requested key look not_found too;
        // the renamed item itself is what exercises the key-pattern check.
        expect(result.skipped).toEqual([
            { key: 'ATTK2345', reason: 'not_found' },
            { key: 'bad-key!!', reason: 'invalid attachment key' },
        ]);
    });

    test('downloads a stored file whose enclosure length exactly equals the cap', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTL2345', {}, PDF));
        withRewrittenItem(server, 'ATTL2345', () => ({ links: { enclosure: { length: deps.maxStoredFileBytes } } }));

        const result = await downloadAttachments(deps, ['ATTL2345']);

        expect(result.skipped).toEqual([]);
        expect(result.files).toHaveLength(1);
    });
});

describe('downloadAttachments: parent handling', () => {
    test('reports skipped parents in the order Zotero returned them', async () => {
        const { server, deps } = setup((s) => {
            s.addItem({ itemType: 'book', title: 'A' });
            s.addItem({ itemType: 'book', title: 'B' });
        });
        const [keyA, keyB] = [...server.items.keys()].filter(key => key !== PARENT);

        const result = await downloadAttachments(deps, [keyA, keyB]);

        expect(result.skipped).toEqual([
            { key: keyA, reason: 'no_stored_file: no stored PDF, HTML or text attachment within the size limit' },
            { key: keyB, reason: 'no_stored_file: no stored PDF, HTML or text attachment within the size limit' },
        ]);
    });

    test('does not ask for children when every requested item already resolved directly', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTP2345', {}, PDF));
        const real = clientFor(server);
        let childrenCalls = 0;
        // Bound delegates (not a Proxy): getChildren's own private-field access needs `this` to be
        // the real instance, which a Proxy's trap receiver breaks.
        const countingClient = {
            getItems:    real.getItems.bind(real),
            getChildren: async (keys: string[]) => {
                childrenCalls++;
                return real.getChildren(keys);
            },
            downloadAttachmentFile: real.downloadAttachmentFile.bind(real),
        } as unknown as ZoteroFileDeps['client'];

        const result = await downloadAttachments({ ...deps, client: countingClient }, ['ATTP2345']);

        expect(result.files).toHaveLength(1);
        expect(childrenCalls).toBe(0);
    });

    // Kill-review follow-up: only attachment children are downloadable. A non-attachment child that
    // otherwise looks like a stored PDF must be rejected by ineligible()'s own itemType guard.
    test('never downloads a non-attachment child, even one carrying stored-file fields', async () => {
        const { deps } = setup((s) => {
            s.addItem({ key: 'NTEK2345', itemType: 'note', parentItem: PARENT, note: '<p>n</p>', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'paper.pdf', md5: null });
            s.storeFile('NTEK2345', PDF);
        });

        const result = await downloadAttachments(deps, [PARENT]);

        expect(result.files).toEqual([]);
        expect(result.skipped).toEqual([{ key: PARENT, reason: 'no_stored_file: no stored PDF, HTML or text attachment within the size limit' }]);
    });
});

describe('downloadAttachments: cache freshness', () => {
    test('skips the on-disk cache check entirely when the stored md5 is not a string', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTN2345', {}, PDF));
        delete server.items.get('ATTN2345')!.data.md5;
        const spy = spyOn(zoteroUtils, 'openContainedForRead');

        await downloadAttachments(deps, ['ATTN2345']);

        expect(spy).not.toHaveBeenCalled();
    });

    test('does not reuse a cached copy once the remote md5 changes', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTM2345', {}, PDF));
        await downloadAttachments(deps, ['ATTM2345']);
        server.items.get('ATTM2345')!.data.md5 = md5(new TextEncoder().encode('different bytes'));

        const second = await downloadAttachments(deps, ['ATTM2345']);

        expect(second.skipped).toEqual([{ key: 'ATTM2345', reason: 'The downloaded file for ATTM2345 does not match its md5; nothing was written' }]);
    });
});

describe('downloadAttachments: concurrency and ordering', () => {
    test('downloads at most two files at a time', async () => {
        const keys = ['ATTF2345', 'ATTG2345', 'ATTH2345', 'ATTJ2345'];
        const { server, deps } = setup((s) => {
            for(const key of keys) {
                attachment(s, key, {}, PDF);
                // No md5 on record: cachedCopy's md5 type guard short-circuits before touching the
                // filesystem, so gating the storage fetch below is the only async step in play.
                delete s.items.get(key)!.data.md5;
            }
        });
        let active = 0;
        let maxActive = 0;
        const releases: (() => void)[] = [];
        server.override = (call) => {
            if(call.url.startsWith(`${STORAGE}/download/`)) {
                active++;
                maxActive = Math.max(maxActive, active);
                // Resolve with a permanent (4xx) failure, not the real bytes: a successful download
                // would go on to a real filesystem write, and a 5xx would be retried with a real
                // backoff delay — both are macrotask work this microtask-only pump cannot observe or
                // wait out without a real timer. A 403 fails immediately with no retry.
                return new Promise<Response>((resolve) => {
                    releases.push(() => {
                        active--;
                        resolve(status(403));
                    });
                });
            }
            return undefined;
        };

        const promise = downloadAttachments(deps, keys);

        await pumpUntil(() => releases.length >= 2);
        expect(releases).toHaveLength(2);
        releaseAll(releases);

        await pumpUntil(() => releases.length >= 2);
        expect(releases).toHaveLength(2);
        releaseAll(releases);

        const result = await promise;
        expect(result.skipped).toHaveLength(4);
        expect(maxActive).toBe(2);
    });

    test('reports failed downloads in target order', async () => {
        const { deps } = setup((s) => {
            attachment(s, 'ATTD2345');
            attachment(s, 'ATTE2345');
        });

        const result = await downloadAttachments(deps, ['ATTD2345', 'ATTE2345']);

        expect(result.skipped).toEqual([
            { key: 'ATTD2345', reason: 'Attachment ATTD2345 has no stored file' },
            { key: 'ATTE2345', reason: 'Attachment ATTE2345 has no stored file' },
        ]);
    });
});
