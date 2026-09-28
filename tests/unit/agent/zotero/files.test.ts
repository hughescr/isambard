/* eslint-disable n/no-sync -- real filesystem fixtures: node:fs/promises is globally mocked in tests/setup.ts, and these tests exercise real syscalls */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    attachPdfs,
    downloadAttachments,
    forceExtension,
    lastPathSegment,
    storePdfs,
    type ZoteroFileDeps
} from '../../../../src/agent/zotero/files';
import type { UrlFetchResult } from '../../../../src/agent/zotero/url-fetch';
import { ZoteroFileError } from '../../../../src/errors';
import { FakeZoteroServer, STORAGE, clientFor, json, status, type RecordedCall } from '../../../helpers/zotero-fake';

const PDF = new TextEncoder().encode('%PDF-1.7 paper bytes');
const PARENT = 'PRNT2345';

function md5(bytes: Uint8Array): string {
    // eslint-disable-next-line sonarjs/hashing -- the md5 Zotero's file protocol uses as a content identity
    return createHash('md5').update(bytes).digest('hex');
}

let base: string;
let outside: string;
let counter = 0;

beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'zotero-files-test-'));
    outside = path.join(base, 'outside');
    mkdirSync(outside);
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
    const fetched: string[] = [];
    const deps: ZoteroFileDeps = {
        client:             clientFor(server),
        root:               freshRoot(),
        maxStoredFileBytes: 1000,
        fetchPdf:           async (url): Promise<UrlFetchResult> => {
            fetched.push(url);
            return { finalUrl: url, kind: 'pdf', bytes: PDF, truncated: false };
        },
        now: () => 1_700_000_000_000,
        ...overrides,
    };
    return { server, deps, fetched };
}

function attachment(server: FakeZoteroServer, key: string, data: Record<string, unknown> = {}, file?: Uint8Array): void {
    server.addItem({ key, itemType: 'attachment', parentItem: PARENT, linkMode: 'imported_file', contentType: 'application/pdf', filename: 'paper.pdf', title: 'PDF', md5: null, ...data });
    if(file) {
        server.storeFile(key, file);
    }
}

function fileRequests(server: FakeZoteroServer): RecordedCall[] {
    return server.calls.filter(call => call.url.startsWith(`${STORAGE}/download/`));
}

describe('forceExtension and lastPathSegment', () => {
    test('appends a missing or different extension and keeps a matching one', () => {
        expect(forceExtension('paper', '.pdf')).toBe('paper.pdf');
        expect(forceExtension('Paper.PDF', '.pdf')).toBe('Paper.PDF');
        expect(forceExtension('x.command', '.pdf')).toBe('x.command.pdf');
        expect(forceExtension('../../etc/passwd', '.txt')).toBe('____etc_passwd.txt');
        expect(forceExtension('a'.repeat(200), '.pdf')).toBe(`${'a'.repeat(150)}.pdf`);
    });

    test('decodes the last non-empty path segment', () => {
        expect(lastPathSegment('https://x.test/a/My%20Paper.pdf')).toBe('My Paper.pdf');
        expect(lastPathSegment('https://x.test/a/dir/')).toBe('dir');
        expect(lastPathSegment('https://x.test/')).toBe('download');
        expect(lastPathSegment('https://x.test/bad%E0%A4%A')).toBe('bad%E0%A4%A');
    });
});

describe('storePdfs', () => {
    test('creates every attachment in one batch and uploads each file', async () => {
        const { server, deps } = setup();

        const results = await storePdfs(deps.client, [
            { parentKey: PARENT, title: 'Full Text PDF', filename: 'a.pdf', bytes: PDF },
            { parentKey: PARENT, title: 'Supplement', filename: 'b.pdf', bytes: new TextEncoder().encode('%PDF-1.4 other') },
        ], deps.now);

        expect(results).toEqual([
            { pdf: 'attached', attachmentKey: expect.any(String) },
            { pdf: 'attached', attachmentKey: expect.any(String) },
        ]);
        expect(server.writeTokens).toHaveLength(1);
        const created = JSON.parse(server.calls.find(call => call.method === 'POST' && pathOf(call) === '/items')!.bodyText!) as unknown[];
        expect(created).toEqual([
            { itemType: 'attachment', parentItem: PARENT, linkMode: 'imported_file', title: 'Full Text PDF', contentType: 'application/pdf', filename: 'a.pdf', tags: [], relations: {} },
            { itemType: 'attachment', parentItem: PARENT, linkMode: 'imported_file', title: 'Supplement', contentType: 'application/pdf', filename: 'b.pdf', tags: [], relations: {} },
        ]);
        expect(server.files.get(results[0].attachmentKey!)).toEqual(PDF);
        const authorize = server.calls.find(call => pathOf(call).endsWith('/file') && call.bodyText?.startsWith('md5='))!;
        expect(new URLSearchParams(authorize.bodyText).get('mtime')).toBe('1700000000000');
    });

    test('makes no request for nothing', async () => {
        const { server, deps } = setup();

        expect(await storePdfs(deps.client, [], deps.now)).toEqual([]);
        expect(server.calls).toEqual([]);
    });

    test('reports Zotero already having the bytes', async () => {
        const { deps } = setup((server) => {
            server.override = call => (pathOf(call).endsWith('/file') ? json({ exists: 1 }) : undefined);
        });

        const [result] = await storePdfs(deps.client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], deps.now);

        expect(result).toEqual({ pdf: 'already_stored', attachmentKey: expect.any(String) });
    });

    test('reports an attachment Zotero refused to create', async () => {
        const { deps } = setup((server) => {
            server.override = call => (call.method === 'POST' && pathOf(call) === '/items'
                ? json({ successful: {}, unchanged: {}, failed: { '0': { code: 400, message: 'Parent item not found' } } })
                : undefined);
        });

        const results = await storePdfs(deps.client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], deps.now);

        expect(results).toEqual([{ pdf: 'failed: Parent item not found' }]);
    });

    test('trashes an empty placeholder after a failed upload', async () => {
        const { server, deps } = setup((s) => {
            s.override = call => (call.url.startsWith(`${STORAGE}/upload/`) ? status(400) : undefined);
        });

        const [result] = await storePdfs(deps.client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], deps.now);

        const key = result.attachmentKey!;
        expect(result.pdf).toBe(`failed: Uploading the file for ${key} to Zotero storage failed (HTTP 400); the empty attachment ${key} was moved to the Trash`);
        expect(server.items.get(key)!.data.deleted).toBe(true);
    });

    test('keeps an upload whose registration committed though its response was lost', async () => {
        const { server, deps } = setup((s) => {
            s.override = (call) => {
                if(call.bodyText?.startsWith('upload=') === true) {
                    s.respond(call);
                    return status(500);
                }
                return undefined;
            };
        });

        const [result] = await storePdfs(deps.client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], deps.now);

        expect(result).toEqual({ pdf: 'attached', attachmentKey: expect.any(String) });
        expect(server.items.get(result.attachmentKey!)!.data.deleted).toBeUndefined();
    });

    test('leaves an attachment that changed concurrently', async () => {
        const { server, deps } = setup((s) => {
            s.override = (call) => {
                if(call.bodyText?.startsWith('md5=') === true) {
                    const key = pathOf(call).split('/')[2];
                    s.storeFile(key, new TextEncoder().encode('%PDF-someone else'));
                }
                return undefined;
            };
        });

        const [result] = await storePdfs(deps.client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], deps.now);

        const key = result.attachmentKey!;
        expect(result.pdf).toBe(`failed: Attachment ${key} already has a file; attachment changed concurrently; left as is (key ${key})`);
        expect(server.items.get(key)!.data.deleted).toBeUndefined();
    });

    test('leaves a placeholder it could not re-read', async () => {
        let uploadFailed = false;
        const { deps } = setup((s) => {
            s.override = (call) => {
                if(call.url.startsWith(`${STORAGE}/upload/`)) {
                    uploadFailed = true;
                    return status(403);
                }
                return uploadFailed && call.method === 'GET' ? status(403, 'Forbidden') : undefined;
            };
        });

        const [result] = await storePdfs(deps.client, [{ parentKey: PARENT, title: 'T', filename: 'a.pdf', bytes: PDF }], deps.now);

        expect(result.pdf).toStartWith(`failed: Uploading the file for ${result.attachmentKey!} to Zotero storage failed (HTTP 403); could not re-read the attachment: `);
        expect(result.pdf).toEndWith(`(key ${result.attachmentKey!})`);
    });
});

describe('attachPdfs', () => {
    test('fetches a URL source and stores it under the default title', async () => {
        const { server, deps, fetched } = setup();

        const results = await attachPdfs(deps, [{ parentKey: PARENT, source: { url: 'https://papers.test/dl/My%20Paper' } }]);

        expect(fetched).toEqual(['https://papers.test/dl/My%20Paper']);
        expect(results).toEqual([{ parentKey: PARENT, pdf: 'attached', attachmentKey: expect.any(String) }]);
        const stored = server.items.get(results[0].attachmentKey!)!;
        expect(stored.data.title).toBe('Full Text PDF');
        expect(stored.data.filename).toBe('My Paper.pdf');
    });

    test('reads a local file under the root, with a custom title', async () => {
        const { server, deps } = setup();
        mkdirSync(path.join(deps.root, 'papers'));
        writeFileSync(path.join(deps.root, 'papers', 'local.pdf'), PDF);

        const results = await attachPdfs(deps, [{ parentKey: PARENT, source: { path: 'papers/local.pdf' }, title: 'Preprint' }]);

        const stored = server.items.get(results[0].attachmentKey!)!;
        expect(results[0].pdf).toBe('attached');
        expect(stored.data).toMatchObject({ title: 'Preprint', filename: 'local.pdf' });
        expect(server.files.get(stored.key)).toEqual(PDF);
    });

    test('refuses a local file that is not a PDF and creates nothing', async () => {
        const { server, deps } = setup();
        writeFileSync(path.join(deps.root, 'notes.txt'), 'hello');

        const results = await attachPdfs(deps, [{ parentKey: PARENT, source: { path: 'notes.txt' } }]);

        expect(results).toEqual([{ parentKey: PARENT, pdf: 'failed: notes.txt is not a PDF' }]);
        expect(server.calls).toEqual([]);
    });

    test('refuses a path through a symlinked directory', async () => {
        const { deps } = setup();
        writeFileSync(path.join(outside, 'secret.pdf'), PDF);
        symlinkSync(outside, path.join(deps.root, 'linked'));

        const [result] = await attachPdfs(deps, [{ parentKey: PARENT, source: { path: 'linked/secret.pdf' } }]);

        expect(result.pdf).toStartWith('failed: ');
        expect(result.pdf).toContain('linked');
        expect(result).not.toHaveProperty('attachmentKey');
    });

    test('refuses a final symlink and a file over the stored-file cap', async () => {
        const { deps } = setup(undefined, { maxStoredFileBytes: 10 });
        writeFileSync(path.join(outside, 'target.pdf'), PDF);
        symlinkSync(path.join(outside, 'target.pdf'), path.join(deps.root, 'link.pdf'));
        writeFileSync(path.join(deps.root, 'big.pdf'), PDF);

        const results = await attachPdfs(deps, [
            { parentKey: PARENT, source: { path: 'link.pdf' } },
            { parentKey: PARENT, source: { path: 'big.pdf' } },
        ]);

        expect(results.map(result => result.pdf.startsWith('failed: '))).toEqual([true, true]);
        expect(results[1].pdf).toContain('10');
    });

    test('reports a failed URL fetch and still stores the other PDFs in order', async () => {
        const { deps } = setup(undefined, {
            fetchPdf: async (url) => {
                if(url.includes('bad')) {
                    throw new ZoteroFileError('https://bad.test/x is not a PDF (text/html)', { reason: 'not_pdf' });
                }
                return { finalUrl: url, kind: 'pdf', bytes: PDF, truncated: false };
            },
        });

        const results = await attachPdfs(deps, [
            { parentKey: PARENT, source: { url: 'https://bad.test/x' } },
            { parentKey: PARENT, source: { url: 'https://good.test/y.pdf' } },
        ]);

        expect(results).toEqual([
            { parentKey: PARENT, pdf: 'failed: https://bad.test/x is not a PDF (text/html)' },
            { parentKey: PARENT, pdf: 'attached', attachmentKey: expect.any(String) },
        ]);
    });
});

describe('downloadAttachments', () => {
    test('writes an attachment under zotero-files and reuses a matching copy', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTC2345', {}, PDF));

        const first = await downloadAttachments(deps, ['ATTC2345']);
        const second = await downloadAttachments(deps, ['ATTC2345']);

        expect(first).toEqual({ files: [{ attachmentKey: 'ATTC2345', path: 'zotero-files/ATTC2345/paper.pdf', contentType: 'application/pdf', bytes: PDF.length, cached: false }], skipped: [] });
        expect(second.files[0].cached).toBe(true);
        expect(readFileSync(path.join(deps.root, 'zotero-files/ATTC2345/paper.pdf'))).toEqual(Buffer.from(PDF));
        expect(fileRequests(server)).toHaveLength(1);
    });

    test('picks the stored attachments of a parent', async () => {
        const { deps } = setup((s) => {
            attachment(s, 'ATTC2345', {}, PDF);
            attachment(s, 'LINK2345', { linkMode: 'linked_url', contentType: '' });
            s.addItem({ key: 'NTE22345', itemType: 'note', parentItem: PARENT, note: '<p>n</p>' });
        });

        const result = await downloadAttachments(deps, [PARENT]);

        expect(result).toEqual({ files: [{ attachmentKey: 'ATTC2345', parentKey: PARENT, path: 'zotero-files/ATTC2345/paper.pdf', contentType: 'application/pdf', bytes: PDF.length, cached: false }], skipped: [] });
    });

    test('finds a stored PDF past the first page of children', async () => {
        const { deps } = setup((s) => {
            for(let i = 0; i < 100; i++) {
                s.addItem({ itemType: 'note', parentItem: PARENT, note: `n${i}` });
            }
            attachment(s, 'ATTC2345', {}, PDF);
        });

        const result = await downloadAttachments(deps, [PARENT]);

        expect(result.files.map(file => file.attachmentKey)).toEqual(['ATTC2345']);
    });

    test('downloads an attachment once when it and its parent are both asked for', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTC2345', {}, PDF));

        const result = await downloadAttachments(deps, ['ATTC2345', PARENT]);

        expect(result.files).toHaveLength(1);
        expect(result.files[0]).not.toHaveProperty('parentKey');
        expect(fileRequests(server)).toHaveLength(1);
    });

    test('skips what it cannot download, with the reason', async () => {
        const { server, deps } = setup((s) => {
            s.addItem({ key: 'LANE2345', itemType: 'book', title: 'No files' });
            s.addItem({ key: 'NTE22345', itemType: 'note', note: 'n' });
            attachment(s, 'LINK2345', { linkMode: 'linked_file' });
            attachment(s, 'EPUB2345', { contentType: 'application/epub+zip' });
            s.addItem({ key: 'BIGG2345', itemType: 'attachment', parentItem: PARENT, linkMode: 'imported_file', contentType: 'application/pdf' });
        });
        // The fake does not produce `links`; give the big attachment an enclosure length over the cap.
        const original = server.respond.bind(server);
        server.override = (call) => {
            const response = original(call);
            if(call.method !== 'GET' || pathOf(call) !== '/items') {
                return response;
            }
            return response.json().then((body: { key: string, links?: unknown }[]) => json(
                body.map(entry => (entry.key === 'BIGG2345' ? { ...entry, links: { enclosure: { length: 5000 } } } : entry)),
                { headers: { 'Total-Results': response.headers.get('Total-Results')!, 'Last-Modified-Version': '1' } }
            ));
        };

        const result = await downloadAttachments(deps, ['MISS2345', 'LANE2345', 'NTE22345', 'LINK2345', 'EPUB2345', 'BIGG2345']);

        expect(result.files).toEqual([]);
        expect(result.skipped).toEqual([
            { key: 'MISS2345', reason: 'not_found' },
            { key: 'NTE22345', reason: 'not an attachment (note)' },
            { key: 'LINK2345', reason: 'no_stored_file: linked files and links are not stored in Zotero' },
            { key: 'EPUB2345', reason: 'unsupported content type application/epub+zip' },
            { key: 'BIGG2345', reason: 'too_large: 5000 bytes is over the 1000-byte limit' },
            { key: 'LANE2345', reason: 'no_stored_file: no stored PDF, HTML or text attachment within the size limit' },
        ]);
        expect(fileRequests(server)).toEqual([]);
    });

    test('writes nothing when the md5 does not match', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTC2345', {}, PDF));
        server.items.get('ATTC2345')!.data.md5 = md5(new TextEncoder().encode('different'));

        const result = await downloadAttachments(deps, ['ATTC2345']);

        expect(result.skipped).toEqual([{ key: 'ATTC2345', reason: 'The downloaded file for ATTC2345 does not match its md5; nothing was written' }]);
        expect(readdirSync(deps.root)).toEqual([]);
    });

    test('refuses a stored "PDF" that is not one', async () => {
        const { deps } = setup(s => attachment(s, 'ATTC2345', {}, new TextEncoder().encode('<html>')));

        const result = await downloadAttachments(deps, ['ATTC2345']);

        expect(result.skipped).toEqual([{ key: 'ATTC2345', reason: 'The stored file for ATTC2345 is not a PDF' }]);
    });

    test('forces the extension, sanitises the name, and falls back to the title and then the key', async () => {
        const { deps } = setup((s) => {
            attachment(s, 'ATTC2345', { filename: '../evil.command' }, PDF);
            attachment(s, 'HTML2345', { filename: '', title: 'Snapshot', contentType: 'text/html' }, new TextEncoder().encode('<html></html>'));
            attachment(s, 'TEXT2345', { filename: '', title: '', contentType: 'text/plain' }, new TextEncoder().encode('plain'));
        });

        const result = await downloadAttachments(deps, ['ATTC2345', 'HTML2345', 'TEXT2345']);

        expect(result.files.map(file => file.path)).toEqual([
            'zotero-files/ATTC2345/__evil.command.pdf',
            'zotero-files/HTML2345/Snapshot.html',
            'zotero-files/TEXT2345/TEXT2345.txt',
        ]);
    });

    test('downloads a file without an md5 and does not treat an existing copy as cached', async () => {
        const { server, deps } = setup(s => attachment(s, 'ATTC2345', {}, PDF));
        delete server.items.get('ATTC2345')!.data.md5;

        await downloadAttachments(deps, ['ATTC2345']);
        const second = await downloadAttachments(deps, ['ATTC2345']);

        expect(second.files[0].cached).toBe(false);
        expect(fileRequests(server)).toHaveLength(2);
    });

    test('replaces a symlink at the cached path with a regular file, leaving its target alone', async () => {
        const { deps } = setup(s => attachment(s, 'ATTC2345', {}, PDF));
        const target = path.join(outside, 'planted.pdf');
        writeFileSync(target, PDF);
        mkdirSync(path.join(deps.root, 'zotero-files', 'ATTC2345'), { recursive: true });
        symlinkSync(target, path.join(deps.root, 'zotero-files', 'ATTC2345', 'paper.pdf'));

        const result = await downloadAttachments(deps, ['ATTC2345']);

        expect(result.files[0].cached).toBe(false);
        expect(lstatSync(path.join(deps.root, 'zotero-files', 'ATTC2345', 'paper.pdf')).isSymbolicLink()).toBe(false);
        expect(readFileSync(target)).toEqual(Buffer.from(PDF));
    });

    test('two simultaneous downloads of one attachment both succeed', async () => {
        const { deps } = setup(s => attachment(s, 'ATTC2345', {}, PDF));

        const [a, b] = await Promise.all([downloadAttachments(deps, ['ATTC2345']), downloadAttachments(deps, ['ATTC2345'])]);

        expect(a.files).toHaveLength(1);
        expect(b.files).toHaveLength(1);
        expect(readFileSync(path.join(deps.root, 'zotero-files/ATTC2345/paper.pdf'))).toEqual(Buffer.from(PDF));
        expect(readdirSync(path.join(deps.root, 'zotero-files/ATTC2345'))).toEqual(['paper.pdf']);
    });

    test('reports a download that fails', async () => {
        const { deps } = setup(s => attachment(s, 'ATTC2345'));

        const result = await downloadAttachments(deps, ['ATTC2345']);

        expect(result.skipped).toEqual([{ key: 'ATTC2345', reason: 'Attachment ATTC2345 has no stored file' }]);
    });
});
