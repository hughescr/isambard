/* eslint-disable sonarjs/no-hardcoded-ip -- these tests check resolver answers, which are literal IP addresses by definition */
import { describe, expect, test } from 'bun:test';
import { checkResolvedAddress, validateUrl } from '../../../../src/agent/browser';

const MALFORMED = 'resolver returned a malformed address';

describe('checkResolvedAddress', () => {
    test.each([
        '::ffff:127.0.0.1',
        '::FFFF:127.0.0.1',
        '::ffff:10.1.2.3',
        '::ffff:172.16.0.1',
        '::ffff:192.168.0.1',
        '::ffff:169.254.169.254',
        '::ffff:0.0.0.0',
    ])('blocks the dotted mapped form %s', (raw) => {
        const result = checkResolvedAddress(raw);

        expect(result.ok).toBe(false);
        expect(result).toEqual({ ok: false, reason: expect.stringContaining('is in a blocked range') });
    });

    test.each([
        '0:0:0:0:0:0:0:1',
        '0000:0000:0000:0000:0000:0000:0000:0001',
        '0:0:0:0:0:0:0:0',
        '0:0:0:0:0:ffff:7f00:1',
        '0000:0000:0000:0000:0000:ffff:7f00:0001',
        'FE80:0:0:0:0:0:0:1',
        'FD12:3456::1',
    ])('blocks the expanded IPv6 form %s', (raw) => {
        expect(checkResolvedAddress(raw).ok).toBe(false);
    });

    test.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1'])('blocks the IPv4 address %s', (raw) => {
        expect(checkResolvedAddress(raw)).toEqual({ ok: false, reason: `IP address ${raw} is in a blocked range (loopback/private/link-local)` });
    });

    test('names the canonical address in the blocked reason', () => {
        expect(checkResolvedAddress('::ffff:127.0.0.1')).toEqual({ ok: false, reason: 'IP address ::ffff:7f00:1 is in a blocked range (loopback/private/link-local)' });
    });

    test('returns the canonical form of an IPv6 answer', () => {
        expect(checkResolvedAddress('::ffff:8.8.8.8')).toEqual({ ok: true, address: '::ffff:808:808', family: 6 });
        expect(checkResolvedAddress('2606:4700:4700:0:0:0:0:1111')).toEqual({ ok: true, address: '2606:4700:4700::1111', family: 6 });
    });

    test('returns an IPv4 answer as is, family 4', () => {
        expect(checkResolvedAddress('8.8.8.8')).toEqual({ ok: true, address: '8.8.8.8', family: 4 });
    });

    test.each(['fe80::1%lo0', '2606:4700::1%en0', '010.0.0.1', '127.1', '0x7f.0.0.1', '', 'not-an-ip', '[::1]', '::1]', '1.2.3.4 '])('rejects the malformed answer %p', (raw) => {
        expect(checkResolvedAddress(raw)).toEqual({ ok: false, reason: MALFORMED });
    });

    test.each([
        '::ffff:127.0.0.1',
        '::ffff:8.8.8.8',
        '0:0:0:0:0:0:0:1',
        '0:0:0:0:0:ffff:7f00:1',
        'FE80:0:0:0:0:0:0:1',
        'FD12:3456::1',
        '2606:4700:4700::1111',
    ])('agrees with validateUrl on the IPv6 literal %s', (raw) => {
        expect(checkResolvedAddress(raw).ok).toBe(validateUrl(`http://[${raw}]/`, {}).ok);
    });
});
