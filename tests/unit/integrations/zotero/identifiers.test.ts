/* eslint-disable sonarjs/no-clear-text-protocols -- identifier inputs intentionally include http:// DOI and arXiv links, which real citations still use */
import { describe, expect, test } from 'bun:test';
import {
    classifyUrl,
    doiIdentityKey,
    identityKeys,
    normalizeArxivId,
    normalizeDoi,
    urlIdentityKey
} from '@/integrations/zotero/identifiers';

describe('normalizeDoi', () => {
    test.each([
        ['10.1038/nature14539', '10.1038/nature14539'],
        ['  10.1038/nature14539  ', '10.1038/nature14539'],
        ['doi:10.1038/nature14539', '10.1038/nature14539'],
        ['DOI: 10.1038/nature14539', '10.1038/nature14539'],
        ['https://doi.org/10.1038/nature14539', '10.1038/nature14539'],
        ['http://dx.doi.org/10.1038/nature14539', '10.1038/nature14539'],
        ['HTTPS://DOI.ORG/10.1038/NATURE14539', '10.1038/NATURE14539'],
        ['https://doi.org/10.1000%2F182', '10.1000/182'],
        ['10.123456789/x', '10.123456789/x'],
    ])('%p → %p', (input, expected) => {
        expect(normalizeDoi(input)).toBe(expected);
    });

    test.each([
        '',
        'nature14539',
        '10.103/short-registrant',
        '10.1234567890/too-long-registrant',
        '10.1038/',
        '10.1038/has space',
        'x10.1038/nature14539',
        '10.1038/nature14539 trailing',
        'https://doi.org/%E0%A4%A',
        'https://example.org/10.1038/nature14539',
    ])('rejects %p', (input) => {
        expect(normalizeDoi(input)).toBeUndefined();
    });
});

describe('normalizeArxivId', () => {
    test.each([
        ['1706.03762', { id: '1706.03762' }],
        ['1706.03762v7', { id: '1706.03762', version: 'v7' }],
        ['0704.0001', { id: '0704.0001' }],
        ['arXiv:1706.03762v2', { id: '1706.03762', version: 'v2' }],
        [' ARXIV: 1706.03762 ', { id: '1706.03762' }],
        ['https://arxiv.org/abs/1706.03762v7', { id: '1706.03762', version: 'v7' }],
        ['http://www.arxiv.org/pdf/1706.03762v7.pdf', { id: '1706.03762', version: 'v7' }],
        ['https://export.arxiv.org/abs/1706.03762', { id: '1706.03762' }],
        ['1706.03762.PDF', { id: '1706.03762' }],
        ['hep-th/9901001', { id: 'hep-th/9901001' }],
        ['hep-th/9901001v3', { id: 'hep-th/9901001', version: 'v3' }],
        ['math.GT/0309136', { id: 'math.GT/0309136' }],
    ])('normalizes %p', (input, expected) => {
        expect(normalizeArxivId(input)).toEqual(expected);
    });

    test.each([
        '',
        '1706.037',
        '1706.037621',
        '17060.3762',
        '1706.03762v',
        'x1706.03762',
        '1706.03762x',
        'hep-th/990100',
        'HEP-TH/9901001',
        'math.gt/0309136',
        'math.GTX/0309136',
        'https://example.org/abs/1706.03762',
    ])('rejects %p', (input) => {
        expect(normalizeArxivId(input)).toBeUndefined();
    });
});

describe('classifyUrl', () => {
    test.each([
        ['https://doi.org/10.1038/nature14539', { kind: 'doi', doi: '10.1038/nature14539' }],
        ['https://dx.doi.org/10.1038/nature14539', { kind: 'doi', doi: '10.1038/nature14539' }],
        ['https://www.doi.org/10.1038/nature14539', { kind: 'doi', doi: '10.1038/nature14539' }],
        ['https://arxiv.org/abs/1706.03762v7', { kind: 'arxiv', arxiv: { id: '1706.03762', version: 'v7' } }],
        ['https://www.arxiv.org/pdf/1706.03762.pdf', { kind: 'arxiv', arxiv: { id: '1706.03762' } }],
        ['https://export.arxiv.org/abs/hep-th/9901001', { kind: 'arxiv', arxiv: { id: 'hep-th/9901001' } }],
    ])('%p is classified without a page fetch', (url, expected) => {
        expect(classifyUrl(url)).toEqual(expected as ReturnType<typeof classifyUrl>);
    });

    test.each([
        'https://example.org/paper',
        'https://doi.org/not-a-doi',
        'https://arxiv.org/list/cs.LG/recent',
        'https://arxiv.org/abs/not-an-id',
        'https://evil.test/abs/1706.03762',
        'https://evil.test/10.1038/nature14539',
        'not a url',
    ])('%p stays a plain URL', (url) => {
        expect(classifyUrl(url)).toEqual({ kind: 'url', url });
    });
});

describe('identity keys', () => {
    test('doiIdentityKey lowercases and folds arXiv-minted DOIs to the arXiv key', () => {
        expect(doiIdentityKey('10.1038/NATURE14539')).toBe('doi:10.1038/nature14539');
        expect(doiIdentityKey('10.48550/arXiv.1706.03762')).toBe('arxiv:1706.03762');
        expect(doiIdentityKey('10.48550/ARXIV.1706.03762v2')).toBe('arxiv:1706.03762');
        expect(doiIdentityKey('10.48550/arXiv.not-an-id')).toBe('doi:10.48550/arxiv.not-an-id');
    });

    test.each([
        ['https://Example.ORG:443/a/b/?q=1#frag', 'url:https://example.org/a/b?q=1'],
        ['http://example.org:80/', 'url:http://example.org'],
        ['https://example.org:8443/x//', 'url:https://example.org:8443/x'],
        ['https://doi.org/10.1038/Nature14539', 'doi:10.1038/nature14539'],
        ['https://arxiv.org/pdf/1706.03762v7', 'arxiv:1706.03762'],
    ])('urlIdentityKey(%p) = %p', (url, key) => {
        expect(urlIdentityKey(url)).toBe(key);
    });

    test('urlIdentityKey ignores anything that is not an http(s) URL', () => {
        expect(urlIdentityKey('not a url')).toBeUndefined();
        expect(urlIdentityKey('ftp://example.org/x')).toBeUndefined();
    });

    test('identityKeys reads DOI, archiveID, url and extra lines', () => {
        const keys = identityKeys({
            DOI:       '10.1038/Nature14539',
            archiveID: 'arXiv:1706.03762',
            url:       'https://example.org/paper/',
            extra:     'Some note\nDOI: 10.1101/2020.03.22.002386\r\narXiv: hep-th/9901001v2\nPublished version DOI: 10.9999/published',
        });

        expect([...keys].toSorted((a, b) => a.localeCompare(b))).toEqual([
            'arxiv:1706.03762',
            'arxiv:hep-th/9901001',
            'doi:10.1038/nature14539',
            'doi:10.1101/2020.03.22.002386',
            'url:https://example.org/paper',
        ]);
    });

    test('a Published version DOI line alone is not an identity', () => {
        expect(identityKeys({ extra: 'Published version DOI: 10.9999/published' }).size).toBe(0);
    });

    test('identityKeys ignores empty, malformed and non-string values', () => {
        expect(identityKeys({}).size).toBe(0);
        expect(identityKeys({ DOI: '', archiveID: '', url: '', extra: '' }).size).toBe(0);
        expect(identityKeys({ DOI: 'nope', archiveID: 'arXiv:nope', url: 'nope', extra: 'DOI: nope\narXiv: nope' }).size).toBe(0);
        expect(identityKeys({ DOI: 5, archiveID: null, url: {}, extra: ['DOI: 10.1038/x'] }).size).toBe(0);
        expect(identityKeys({ archiveID: '1706.03762' }).size).toBe(0);
    });

    test('an arXiv DOI in the DOI field folds to the same key as the archiveID', () => {
        expect([...identityKeys({ DOI: '10.48550/arXiv.1706.03762', archiveID: 'arXiv:1706.03762' })]).toEqual(['arxiv:1706.03762']);
    });
});
