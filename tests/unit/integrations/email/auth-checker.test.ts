import { describe, test, expect } from 'bun:test';
import { checkAuthentication } from '@/integrations/email/auth-checker';

describe.concurrent('checkAuthentication', () => {
    test('undefined input returns both false', () => {
        expect(checkAuthentication(undefined, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('empty string returns both false', () => {
        expect(checkAuthentication('', 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('empty fromAddress returns both false', () => {
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, '')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('fromAddress with bare TLD domain returns both false', () => {
        // 'alice@com' has domain 'com' — exact comparison 'example.com' !== 'com' returns false
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, 'alice@com')).toEqual({ spfPass: false, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // SPF alignment tests
    // -------------------------------------------------------------------
    test('SPF pass with aligned domain returns spfPass true', () => {
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: false });
    });

    test('SPF pass with misaligned domain returns spfPass false', () => {
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=evil@evil.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('SPF pass with missing smtp.mailfrom returns spfPass false', () => {
        const header = 'mx.rungie.com; spf=pass';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('SPF pass with subdomain of From domain does NOT align (exact matching)', () => {
        // mail.example.com !== example.com under exact domain matching
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=alice@mail.example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('SPF pass with From subdomain different from mailfrom domain does NOT align (exact matching)', () => {
        // mail.example.com !== example.com under exact domain matching
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, 'alice@mail.example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // DKIM alignment tests
    // -------------------------------------------------------------------
    test('DKIM pass with aligned domain returns dkimPass true', () => {
        const header = 'mx.rungie.com; dkim=pass header.d=example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: true });
    });

    test('DKIM pass with misaligned domain returns dkimPass false', () => {
        const header = 'mx.rungie.com; dkim=pass header.d=evil.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('DKIM pass with missing header.d returns dkimPass false', () => {
        const header = 'mx.rungie.com; dkim=pass';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('DKIM pass with subdomain of From domain does NOT align (exact matching)', () => {
        // mail.example.com !== example.com under exact domain matching
        const header = 'mx.rungie.com; dkim=pass header.d=mail.example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // Both pass / neither pass
    // -------------------------------------------------------------------
    test('both pass with aligned domains returns both true', () => {
        const header
            = 'mx.rungie.com; spf=pass (sender SPF authorized) smtp.mailfrom=alice@example.com; dkim=pass header.d=example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: true });
    });

    test('neither pass returns both false', () => {
        const header = 'mx.rungie.com; spf=fail smtp.mailfrom=spammer@evil.com; dkim=none';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('SPF fail with DKIM pass (aligned) returns spfPass false, dkimPass true', () => {
        const header = 'mx.rungie.com; spf=fail smtp.mailfrom=spammer@evil.com; dkim=pass header.d=example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: true });
    });

    // -------------------------------------------------------------------
    // Non-pass SPF statuses
    // -------------------------------------------------------------------
    test('spf=softfail is not a pass', () => {
        const header = 'mx.rungie.com; spf=softfail smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('spf=neutral is not a pass', () => {
        const header = 'mx.rungie.com; spf=neutral smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('spf=none is not a pass', () => {
        const header = 'mx.rungie.com; spf=none smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // Case insensitivity
    // -------------------------------------------------------------------
    test('case insensitive: SPF=PASS with aligned domain is treated as pass', () => {
        const header = 'mx.rungie.com; SPF=PASS smtp.mailfrom=alice@example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // Complex real-world header
    // -------------------------------------------------------------------
    test('complex header with parenthetical comments and extra fields still parses correctly', () => {
        const header
            = 'mx.rungie.com; spf=pass (Google: domain of noreply@accounts.google.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=noreply@accounts.google.com; dkim=pass header.i=@accounts.google.com header.s=20230601 header.b=abc123 header.d=accounts.google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=accounts.google.com';
        expect(checkAuthentication(header, 'noreply@accounts.google.com')).toEqual({ spfPass: true, dkimPass: true });
    });

    test('spf=pass with aligned bare domain in smtp.mailfrom returns spfPass true', () => {
        // smtp.mailfrom may be a bare domain (no @)
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: false });
    });

    test('header.d present without dkim=pass does not set dkimPass true', () => {
        // header.d is aligned but dkim=pass is absent — dkimPass must remain false
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=alice@example.com; header.d=example.com';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // Multi-label TLD domains — .co.uk, .com.au
    // -------------------------------------------------------------------
    test('different .co.uk orgs do NOT align (SPF)', () => {
        // alice.co.uk and attacker.co.uk share a TLD but are different organizations
        const header = 'mx.example.com; spf=pass smtp.mailfrom=evil@attacker.co.uk';
        expect(checkAuthentication(header, 'alice@alice.co.uk')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('SPF pass with subdomain does NOT align with parent domain (exact matching)', () => {
        // mail.alice.co.uk !== alice.co.uk under exact domain matching
        const header = 'mx.example.com; spf=pass smtp.mailfrom=sender@mail.alice.co.uk';
        expect(checkAuthentication(header, 'alice@alice.co.uk')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('different .co.uk orgs do NOT align (DKIM)', () => {
        const header = 'mx.example.com; dkim=pass header.d=attacker.co.uk';
        expect(checkAuthentication(header, 'alice@alice.co.uk')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('same .co.uk org aligns (DKIM)', () => {
        const header = 'mx.example.com; dkim=pass header.d=alice.co.uk';
        expect(checkAuthentication(header, 'alice@alice.co.uk')).toEqual({ spfPass: false, dkimPass: true });
    });

    test('different .com.au orgs do NOT align (SPF)', () => {
        const header = 'mx.example.com; spf=pass smtp.mailfrom=evil@attacker.com.au';
        expect(checkAuthentication(header, 'alice@alice.com.au')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('same .com.au org aligns (DKIM)', () => {
        const header = 'mx.example.com; dkim=pass header.d=alice.com.au';
        expect(checkAuthentication(header, 'alice@alice.com.au')).toEqual({ spfPass: false, dkimPass: true });
    });

    // -------------------------------------------------------------------
    // Bare TLD domains — do not align under exact matching
    // -------------------------------------------------------------------
    test('bare TLD-only smtp.mailfrom (co.uk) does not align with any domain', () => {
        // co.uk !== example.com under exact domain matching
        const header = 'mx.example.com; spf=pass smtp.mailfrom=co.uk';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    test('bare TLD-only header.d (co.uk) does not align with any domain', () => {
        const header = 'mx.example.com; dkim=pass header.d=co.uk';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // Angle-bracket stripped from smtp.mailfrom
    // -------------------------------------------------------------------
    test('smtp.mailfrom with angle-bracket wrapped address aligns correctly', () => {
        // Some MTAs emit smtp.mailfrom=<user@example.com>
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=<alice@example.com>';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: true, dkimPass: false });
    });

    test('smtp.mailfrom with angle-bracket wrapped address from different org does not align', () => {
        const header = 'mx.rungie.com; spf=pass smtp.mailfrom=<evil@evil.com>';
        expect(checkAuthentication(header, 'alice@example.com')).toEqual({ spfPass: false, dkimPass: false });
    });

    // -------------------------------------------------------------------
    // Domains with same suffix (e.g. github.io) — exact domain matching distinguishes them
    // -------------------------------------------------------------------
    test('SPF pass for foo.github.io aligns with From: foo.github.io', () => {
        // foo.github.io === foo.github.io — exact match passes
        const header = 'mx.example.com; spf=pass smtp.mailfrom=alice@foo.github.io';
        expect(checkAuthentication(header, 'alice@foo.github.io')).toEqual({ spfPass: true, dkimPass: false });
    });

    test('SPF pass for bar.github.io does NOT align with From: foo.github.io', () => {
        // bar.github.io !== foo.github.io — exact match fails
        const header = 'mx.example.com; spf=pass smtp.mailfrom=attacker@bar.github.io';
        expect(checkAuthentication(header, 'user@foo.github.io')).toEqual({ spfPass: false, dkimPass: false });
    });
});
