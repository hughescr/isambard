import { describe, test, expect } from 'bun:test';
import { checkVerificationResults } from '@/integrations/email/auth-checker';

describe.concurrent('checkVerificationResults', () => {
    test('undefined verificationResults returns both false', () => {
        expect(checkVerificationResults(undefined, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('empty fromAddress returns both false', () => {
        expect(checkVerificationResults({ spf: 'example.com', dkim: 'example.com' }, '')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('spf domain matches from domain → spfPass true', () => {
        expect(checkVerificationResults({ spf: 'example.com' }, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: false });
    });

    test('spf domain does not match → spfPass false', () => {
        expect(checkVerificationResults({ spf: 'evil.com' }, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('spf is false → spfPass false', () => {
        expect(checkVerificationResults({ spf: false }, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('spf is undefined → spfPass false', () => {
        expect(checkVerificationResults({}, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('dkim domain matches from domain → dkimPass true', () => {
        expect(checkVerificationResults({ dkim: 'example.com' }, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: true });
    });

    test('dkim domain does not match → dkimPass false', () => {
        expect(checkVerificationResults({ dkim: 'evil.com' }, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('dkim is false → dkimPass false', () => {
        expect(checkVerificationResults({ dkim: false }, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('both match → both pass', () => {
        expect(checkVerificationResults({ spf: 'example.com', dkim: 'example.com' }, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: true });
    });

    test('case-insensitive domain comparison', () => {
        expect(checkVerificationResults({ spf: 'EXAMPLE.COM', dkim: 'Example.Com' }, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: true });
    });

    test('subdomain does NOT align (exact matching)', () => {
        expect(checkVerificationResults({ spf: 'mail.example.com', dkim: 'mail.example.com' }, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('angle-bracket fromAddress is stripped before domain extraction', () => {
        expect(checkVerificationResults({ spf: 'example.com' }, '<alice@example.com>')).toEqual({ spfPass: true, dkimPass: false });
    });
});
