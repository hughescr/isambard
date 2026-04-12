/* eslint-disable sonarjs/no-clear-text-protocols -- test file intentionally uses http:// URLs to verify their rejection or acceptance */
import { describe, expect, test } from 'bun:test';
import { validateUrl } from '../../../../src/agent/browser/host-guard';
import type { BrowserHostPolicy } from '../../../../src/agent/browser/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noPolicy: BrowserHostPolicy = {};

function expectOk(url: string, policy: BrowserHostPolicy = noPolicy): void {
    const result = validateUrl(url, policy);
    expect(result.ok).toBe(true);
}

function expectDenied(url: string, policy: BrowserHostPolicy = noPolicy): void {
    const result = validateUrl(url, policy);
    expect(result.ok).toBe(false);
}

// ---------------------------------------------------------------------------
// Accepted URLs
// ---------------------------------------------------------------------------

describe('validateUrl — accepted URLs', () => {
    test.each([
        'https://example.com',
        'http://example.com',
        'https://example.com/path?query=1',
        'https://8.8.8.8',
        'https://[2001:4860:4860::8888]/',  // Google public DNS v6
    ])('accepts %s', (url) => {
        expectOk(url);
    });

    test('normalises uppercase scheme/host — HTTPS://EXAMPLE.COM', () => {
        expectOk('HTTPS://EXAMPLE.COM');
    });
});

// ---------------------------------------------------------------------------
// Rejected — scheme (including error message format)
// ---------------------------------------------------------------------------

describe('validateUrl — rejected schemes', () => {
    test.each([
        'file:///etc/passwd',
        'about:blank',
        'chrome://settings',
        'chrome-extension://foo/bar',
        'data:text/html,<script>alert(1)</script>',
        'javascript:alert(1)',
        'ws://example.com',
        'wss://example.com',
        'ftp://example.com',
    ])('rejects scheme in %s', (url) => {
        const result = validateUrl(url, noPolicy);
        expect(result.ok).toBe(false);
        if(!result.ok) {
            expect(result.reason).toContain('is not allowed; only http/https');
        }
    });

    test('rejected scheme error message contains the scheme name without colon', () => {
        const result = validateUrl('ftp://example.com', noPolicy);
        expect(result.ok).toBe(false);
        if(!result.ok) {
            // Verifies scheme.slice(0, -1) strips the trailing ':' correctly
            expect(result.reason).toContain("scheme 'ftp'");
            expect(result.reason).not.toContain("scheme 'ftp:'");
        }
    });
});

// ---------------------------------------------------------------------------
// Rejected — parse failures
// ---------------------------------------------------------------------------

describe('validateUrl — parse failures', () => {
    test.each([
        'not a url',
        'http://',
        '',
    ])('rejects unparseable %j', (url) => {
        const result = validateUrl(url, noPolicy);
        expect(result.ok).toBe(false);
        if(!result.ok) {
            expect(result.reason).toContain('invalid URL');
        }
    });
});

// ---------------------------------------------------------------------------
// Rejected — loopback IPv4
// ---------------------------------------------------------------------------

describe('validateUrl — loopback IPv4', () => {
    test.each([
        'http://127.0.0.1',
        'http://127.1.2.3',
        'http://127.255.255.254',
    ])('rejects loopback %s', (url) => {
        expectDenied(url);
    });
});

// ---------------------------------------------------------------------------
// Rejected — loopback IPv6
// ---------------------------------------------------------------------------

describe('validateUrl — loopback IPv6', () => {
    test('rejects http://[::1]/', () => {
        expectDenied('http://[::1]/');
    });
});

// ---------------------------------------------------------------------------
// Rejected — localhost hostnames
// ---------------------------------------------------------------------------

describe('validateUrl — localhost hostnames', () => {
    test.each([
        'http://localhost',
        'http://localhost:8080',
        'http://foo.localhost',
        'http://host.docker.internal',
    ])('rejects localhost-style host in %s', (url) => {
        expectDenied(url);
    });
});

// ---------------------------------------------------------------------------
// Rejected — link-local IPv4 (including cloud metadata)
// ---------------------------------------------------------------------------

describe('validateUrl — link-local IPv4', () => {
    test('rejects http://169.254.1.1', () => {
        expectDenied('http://169.254.1.1');
    });

    test('rejects http://169.254.0.0 (start of range)', () => {
        expectDenied('http://169.254.0.0');
    });

    test('rejects http://169.254.255.255 (end of range)', () => {
        expectDenied('http://169.254.255.255');
    });

    // Cloud metadata service — explicit case per security spec
    test('rejects cloud metadata endpoint http://169.254.169.254/latest/meta-data/', () => {
        expectDenied('http://169.254.169.254/latest/meta-data/');
    });

    test('accepts http://169.255.0.1 (just outside link-local range — different second octet)', () => {
        expectOk('http://169.255.0.1');
    });

    test('accepts http://168.254.0.1 (just outside link-local range — different first octet)', () => {
        expectOk('http://168.254.0.1');
    });
});

// ---------------------------------------------------------------------------
// Rejected — link-local IPv6
// ---------------------------------------------------------------------------

describe('validateUrl — link-local IPv6', () => {
    test('rejects http://[fe80::1] (canonical link-local)', () => {
        expectDenied('http://[fe80::1]');
    });

    test('rejects http://[fe90::1] (fe90 is also link-local /10)', () => {
        expectDenied('http://[fe90::1]');
    });

    test('rejects http://[fea0::1] (fea0 is also link-local /10)', () => {
        expectDenied('http://[fea0::1]');
    });

    test('rejects http://[feb0::1] (feb0 is also link-local /10)', () => {
        expectDenied('http://[feb0::1]');
    });

    test('rejects mixed-case [FE80::1] (normalised to fe80)', () => {
        expectDenied('http://[FE80::1]');
    });

    test('accepts http://[fec0::1] (fec0 is NOT link-local — fe[c-f] is outside /10)', () => {
        expectOk('http://[fec0::1]');
    });
});

// ---------------------------------------------------------------------------
// Rejected — RFC1918
// ---------------------------------------------------------------------------

describe('validateUrl — RFC1918 private ranges', () => {
    test.each([
        ['http://10.0.0.1',        true],
        ['http://10.255.255.255',  true],
        ['http://172.16.0.1',      true],
        ['http://172.31.255.255',  true],
        ['http://172.32.0.1',      false],  // just outside 172.16-31 range — must be ACCEPTED
        ['http://172.15.255.255',  false],  // just below 172.16 — must be ACCEPTED
        ['http://192.168.1.1',     true],
        ['http://192.168.255.255', true],
        ['http://192.167.255.255', false],  // just below 192.168 — must be ACCEPTED
        ['http://1.16.0.0',        false],  // a≠172 but b=16 — must be ACCEPTED (kills a===172→true mutation)
        ['http://1.168.0.0',       false],  // a≠192 but b=168 — must be ACCEPTED (kills a===192→true mutation)
    ] as const)('%s → blocked=%s', (url, shouldBlock) => {
        if(shouldBlock) {
            expectDenied(url);
        } else {
            expectOk(url);
        }
    });
});

// ---------------------------------------------------------------------------
// Rejected — IPv6 ULA (fc00::/7)
// ---------------------------------------------------------------------------

describe('validateUrl — IPv6 ULA', () => {
    test.each([
        'http://[fc00::1]',
        'http://[fd00::1]',
    ])('rejects ULA address %s', (url) => {
        expectDenied(url);
    });

    test('rejects mixed-case [FC00::1] (normalised to fc00)', () => {
        expectDenied('http://[FC00::1]');
    });

    test('accepts http://[fe00::1] (fe00 is outside ULA fc00::/7)', () => {
        // fe00 first byte 0xfe = 11111110, first 7 bits = 1111111 — NOT fc or fd
        expectOk('http://[fe00::1]');
    });

    test('accepts http://[fb00::1] (fb00 is outside ULA fc00::/7)', () => {
        expectOk('http://[fb00::1]');
    });
});

// ---------------------------------------------------------------------------
// Rejected — zero addresses
// ---------------------------------------------------------------------------

describe('validateUrl — zero addresses', () => {
    test('rejects http://0.0.0.0', () => {
        expectDenied('http://0.0.0.0');
    });

    test('accepts http://0.0.0.1 (only last octet non-zero, not zero address)', () => {
        // Verifies condition is exactly 0.0.0.0 — not 0.0.0.* or 0.0.*.*
        expectOk('http://0.0.0.1');
    });

    test('accepts http://0.0.1.0 (only third octet non-zero, not zero address)', () => {
        // Kills mutation: a===0 && b===0 || c===0 (which would block this)
        expectOk('http://0.0.1.0');
    });

    test('accepts http://0.1.0.0 (only second octet non-zero, not zero address)', () => {
        // Kills mutation: a===0 || b===0 (which would block this since a=0)
        expectOk('http://0.1.0.0');
    });

    test('accepts http://1.0.0.0 (only first octet non-zero, not zero address)', () => {
        // Kills mutation: a===0→true (which would block this since true && 0===0 && 0===0 && 0===0 = true)
        expectOk('http://1.0.0.0');
    });

    test('accepts http://0.0.0.0 is rejected but http://0.1.0.1 is accepted', () => {
        // Extra verification that second octet alone doesn't trigger the block
        expectOk('http://0.1.0.1');
    });

    test('rejects http://[::]', () => {
        expectDenied('http://[::]');
    });
});

// ---------------------------------------------------------------------------
// IP parsing edge cases (mutation killers for ipv4Octets)
// ---------------------------------------------------------------------------

describe('validateUrl — IPv4 parsing boundaries', () => {
    test('rejects http://256.0.0.1 (octet out of range — Bun URL parser rejects it entirely)', () => {
        // Bun's URL parser treats 256.0.0.1 as an invalid URL, so we get "invalid URL" reason
        const result = validateUrl('http://256.0.0.1', noPolicy);
        expect(result.ok).toBe(false);
        if(!result.ok) {
            expect(result.reason).toContain('invalid URL');
        }
    });

    test('rejects http://10.0.0.1 (RFC1918) and also rejects http://10.0.0.256 (parse error)', () => {
        expectDenied('http://10.0.0.1');
        // 10.0.0.256 — Bun URL parser rejects, returns invalid URL
        const result = validateUrl('http://10.0.0.256', noPolicy);
        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// IPv6 bracket stripping (mutation killers for bracket normalisation)
// ---------------------------------------------------------------------------

describe('validateUrl — IPv6 bracket stripping', () => {
    test('correctly strips brackets from IPv6 address [2001:db8::1]', () => {
        // A valid global-scope IPv6 address should be accepted
        expectOk('https://[2001:db8::1]/');
    });

    test('rejects [::1] after bracket stripping recognises it as loopback', () => {
        // Verifies both startsWith('[') AND endsWith(']') conditions are needed
        expectDenied('http://[::1]');
    });

    test('rejects [fd00::1] after bracket stripping identifies it as ULA', () => {
        // Verifies bracket stripping + ULA check works end-to-end
        expectDenied('http://[fd00::1]');
    });
});

// ---------------------------------------------------------------------------
// IPv4-mapped IPv6 SSRF bypass prevention (FIX 3)
// ---------------------------------------------------------------------------

describe('validateUrl — IPv4-mapped IPv6 (::ffff:0:0/96)', () => {
    // Dotted-quad form
    test('rejects http://[::ffff:127.0.0.1]/ — loopback via mapped IPv4', () => {
        expectDenied('http://[::ffff:127.0.0.1]/');
    });

    // Cloud metadata — explicit comment required by spec
    test('rejects http://[::ffff:169.254.169.254]/ — cloud metadata endpoint via mapped IPv4', () => {
        expectDenied('http://[::ffff:169.254.169.254]/');
    });

    test('rejects http://[::ffff:10.0.0.1]/ — RFC1918 via mapped IPv4', () => {
        expectDenied('http://[::ffff:10.0.0.1]/');
    });

    test('rejects http://[::ffff:192.168.1.1]/ — RFC1918 via mapped IPv4', () => {
        expectDenied('http://[::ffff:192.168.1.1]/');
    });

    test('rejects http://[::ffff:172.16.0.1]/ — RFC1918 via mapped IPv4', () => {
        expectDenied('http://[::ffff:172.16.0.1]/');
    });

    test('rejects http://[::ffff:0.0.0.0]/ — zero address via mapped IPv4', () => {
        expectDenied('http://[::ffff:0.0.0.0]/');
    });

    // Hex-group form: 7f00:1 = 127.0.0.1
    test('rejects http://[::ffff:7f00:1]/ — 127.0.0.1 in hex-group form', () => {
        expectDenied('http://[::ffff:7f00:1]/');
    });

    // Cloud metadata in hex: a9fe:a9fe = 169.254.169.254
    test('rejects http://[::ffff:a9fe:a9fe]/ — 169.254.169.254 in hex-group form', () => {
        expectDenied('http://[::ffff:a9fe:a9fe]/');
    });

    // 192.168.1.1 in hex: c0a8:101
    test('rejects http://[::ffff:c0a8:101]/ — 192.168.1.1 in hex-group form', () => {
        expectDenied('http://[::ffff:c0a8:101]/');
    });

    // Uppercase prefix
    test('rejects http://[::FFFF:127.0.0.1]/ — case-insensitive prefix match', () => {
        expectDenied('http://[::FFFF:127.0.0.1]/');
    });

    // Public IPv4 via mapped form should be ACCEPTED
    test('accepts http://[::ffff:8.8.8.8]/ — public IPv4 via mapped form', () => {
        expectOk('http://[::ffff:8.8.8.8]/');
    });
});

// ---------------------------------------------------------------------------
// Trailing-dot hostname bypass prevention (FIX 7)
// ---------------------------------------------------------------------------

describe('validateUrl — trailing-dot hostname normalisation', () => {
    test('rejects http://localhost./ — trailing dot on loopback hostname', () => {
        expectDenied('http://localhost./');
    });

    test('rejects http://host.docker.internal./ — trailing dot on docker hostname', () => {
        expectDenied('http://host.docker.internal./');
    });

    test('rejects http://foo.localhost./ — trailing dot on *.localhost hostname', () => {
        expectDenied('http://foo.localhost./');
    });

    test('rejects http://169.254.169.254./ — trailing dot on cloud metadata IPv4', () => {
        // Note: URL parser may reject this entirely or pass it through; either path must deny it.
        const result = validateUrl('http://169.254.169.254./', {});
        expect(result.ok).toBe(false);
    });

    test('accepts https://example.com./ with allowlist ["example.com"] — trailing dot normalised', () => {
        const policy = { allowlist: ['example.com'] };
        expectOk('https://example.com./', policy);
    });

    test('accepts https://foo.example.com./ with allowlist ["*.example.com"] — trailing dot normalised', () => {
        const policy = { allowlist: ['*.example.com'] };
        expectOk('https://foo.example.com./', policy);
    });
});

// ---------------------------------------------------------------------------
// Allowlist — exact match
// ---------------------------------------------------------------------------

describe('validateUrl — allowlist exact match', () => {
    const policy: BrowserHostPolicy = { allowlist: ['example.com'] };

    test('accepts https://example.com with exact allowlist', () => {
        expectOk('https://example.com', policy);
    });

    test('rejects https://evil.com with allowlist ["example.com"]', () => {
        expectDenied('https://evil.com', policy);
    });

    test('rejects https://foo.example.com with exact (non-wildcard) allowlist', () => {
        expectDenied('https://foo.example.com', policy);
    });
});

// ---------------------------------------------------------------------------
// Allowlist — wildcard
// ---------------------------------------------------------------------------

describe('validateUrl — allowlist wildcard', () => {
    const policy: BrowserHostPolicy = { allowlist: ['*.example.com'] };

    test('accepts https://foo.example.com with *.example.com allowlist', () => {
        expectOk('https://foo.example.com', policy);
    });

    test('accepts https://a.b.example.com with *.example.com allowlist', () => {
        expectOk('https://a.b.example.com', policy);
    });

    test('rejects https://example.com (bare domain, no subdomain) with *.example.com allowlist', () => {
        // Verifies hostname.length > suffix.length (not >=) — hostname === '.example.com' would be >= but not >
        expectDenied('https://example.com', policy);
    });

    test('rejects classic suffix-match attack https://example.com.attacker.net', () => {
        expectDenied('https://example.com.attacker.net', policy);
    });

    test('rejects https://evil.com with *.example.com allowlist', () => {
        expectDenied('https://evil.com', policy);
    });
});

// ---------------------------------------------------------------------------
// Allowlist — combined exact + wildcard
// ---------------------------------------------------------------------------

describe('validateUrl — allowlist combined patterns', () => {
    const policy: BrowserHostPolicy = { allowlist: ['example.com', '*.foo.net'] };

    test('accepts exact match https://example.com', () => {
        expectOk('https://example.com', policy);
    });

    test('accepts wildcard match https://sub.foo.net', () => {
        expectOk('https://sub.foo.net', policy);
    });

    test('rejects https://other.com not in combined allowlist', () => {
        expectDenied('https://other.com', policy);
    });
});

// ---------------------------------------------------------------------------
// Allowlist — empty array = permissive
// ---------------------------------------------------------------------------

describe('validateUrl — empty allowlist is permissive', () => {
    const emptyPolicy: BrowserHostPolicy = { allowlist: [] };

    test('accepts https://example.com with empty allowlist', () => {
        expectOk('https://example.com', emptyPolicy);
    });

    test('accepts https://8.8.8.8 with empty allowlist', () => {
        expectOk('https://8.8.8.8', emptyPolicy);
    });
});

// ---------------------------------------------------------------------------
// Result shape — discriminated union
// ---------------------------------------------------------------------------

describe('validateUrl — result shape', () => {
    test('success result contains parsed URL object', () => {
        const result = validateUrl('https://example.com/path', noPolicy);
        expect(result.ok).toBe(true);
        if(result.ok) {
            expect(result.url).toBeInstanceOf(URL);
            expect(result.url.hostname).toBe('example.com');
            expect(result.url.pathname).toBe('/path');
        }
    });

    test('failure result contains reason string', () => {
        const result = validateUrl('http://127.0.0.1', noPolicy);
        expect(result.ok).toBe(false);
        if(!result.ok) {
            expect(typeof result.reason).toBe('string');
            expect(result.reason.length).toBeGreaterThan(0);
        }
    });
});
