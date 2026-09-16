/**
 * Browser URL Host Guard
 *
 * Pure function that validates a URL against a security policy before
 * any browser navigation. Rejects dangerous schemes, loopback/private
 * IP ranges, cloud metadata endpoints, and enforces optional allowlists.
 *
 * Returns a discriminated union — callers use type narrowing. Does NOT throw.
 * The MCP tool layer converts { ok: false } results to mcpErrorResult().
 */
import { isIP, isIPv4 } from 'node:net';
import type { BrowserHostPolicy } from './types';

// ============================================================================
// Result types
// ============================================================================

interface ValidateUrlOk    { ok: true, url: URL }
interface ValidateUrlError { ok: false, reason: string }
type ValidateUrlResult = ValidateUrlOk | ValidateUrlError;

// ============================================================================
// Helpers — IP range checks
// ============================================================================

/** Callers supply either isIPv4-validated hostnames or octets decoded from two hex words. */
function ipv4Octets(addr: string): [number, number, number, number] {
    return addr.split('.').map(part => Number.parseInt(part, 10)) as [number, number, number, number];
}

/** Returns true if the IPv4 address is in a blocked private/loopback/link-local range. */
function isBlockedIPv4(addr: string): boolean {
    const octs = ipv4Octets(addr);
    const [a, b, c, d] = octs;
    return isBlockedIPv4Parts(a, b, c === 0 && d === 0);
}

/** Only the first two octets and whether the tail is zero affect blocked ranges. */
function isBlockedIPv4Parts(a: number, b: number, tailIsZero: boolean): boolean {
    // Zero address: 0.0.0.0
    if(a === 0 && b === 0 && tailIsZero) {
        return true;
    }
    // Loopback: 127.0.0.0/8
    if(a === 127) {
        return true;
    }
    // Link-local: 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
    if(a === 169 && b === 254) {
        return true;
    }
    // RFC1918: 10.0.0.0/8
    if(a === 10) {
        return true;
    }
    // RFC1918: 172.16.0.0/12 (172.16 – 172.31)
    if(a === 172 && b >= 16 && b <= 31) {
        return true;
    }
    // RFC1918: 192.168.0.0/16
    return a === 192 && b === 168;
}

/** Returns true if the IPv6 address (brackets already stripped) is in a blocked range. */
function isBlockedIPv6(addr: string): boolean {
    // Stryker disable next-line MethodExpression: toLowerCase/toUpperCase are equivalent here since all regexes use /i flag; URL.hostname already lowercases the host
    const lower = addr.toLowerCase();

    // Loopback: ::1
    if(lower === '::1') {
        return true;
    }
    // Zero address: ::
    if(lower === '::') {
        return true;
    }
    // Link-local: fe80::/10 — first byte 0xfe, second byte high 2 bits = 10 → 0x80..0xbf
    // i.e. the address starts with fe8, fe9, fea, feb
    if(/^fe[89ab]/i.test(lower)) {
        return true;
    }
    // IPv6 ULA: fc00::/7 — first byte is 0xfc (11111100) or 0xfd (11111101)
    if(/^f[cd]/i.test(lower)) {
        return true;
    }

    // IPv4-mapped IPv6: ::ffff:0:0/96
    // URL parsing normalizes dotted-quad input to two hex groups (for example
    // ::ffff:127.0.0.1 becomes ::ffff:7f00:1). Decode and re-check the IPv4 range.
    // Stryker disable next-line Regex: case-insensitive prefix check — equivalent mutant
    const mappedPrefix = /^::ffff:/i;
    if(mappedPrefix.test(lower) && isBlockedMappedV4(addr.slice(7))) { // skip '::ffff:'
        return true;
    }

    return false;
}

/**
 * Check the two 16-bit words in a URL-normalized mapped IPv4 address.
 * Lower-word octets matter only to the zero-address check, so there is no
 * need to construct a dotted address and then parse those octets again.
 */

function isBlockedMappedV4(rest: string): boolean {
    // Two groups of 1-4 hex chars separated by a colon
    // e.g. 7f00:1 → 127.0.0.1; a9fe:a9fe → 169.254.169.254
    if(!/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(rest)) {
        return false;
    }
    // Stryker disable next-line MethodExpression: complete-match regex guarantees exactly one colon, so indexOf and lastIndexOf agree
    const separator = rest.indexOf(':'); // guaranteed by the complete-match regex
    const hi = Number.parseInt(rest, 16);
    // Stryker disable next-line NumberLiteralValue,MethodExpression: lo only feeds === 0; URL canonicalization strips leading zeroes, making that predicate radix-invariant
    const lo = Number.parseInt(rest.slice(separator + 1), 16);
    // Stryker disable next-line EqualityOperator: Number.parseInt always returns a number, for which === and == agree
    return isBlockedIPv4Parts(Math.floor(hi / 256), hi % 256, lo === 0);
}

// ============================================================================
// Allowlist matching
// ============================================================================

/**
 * Returns true if `hostname` matches the given allowlist pattern.
 * - Exact patterns: must equal hostname.
 * - Wildcard patterns `*.example.com`: matches any subdomain of example.com
 *   but NOT bare example.com and NOT suffix attacks like example.com.attacker.net.
 */
function matchesPattern(hostname: string, pattern: string): boolean {
    if(pattern.startsWith('*.')) {
        // Stryker disable next-line ArithmeticOperator: for a length-N string, slice(-N + 1) and slice(1) are identical
        const suffix = pattern.slice(1); // '.example.com'
        // hostname must end with this suffix AND have at least one char before it.
        // Guards against bare domain match and suffix-hijack attacks:
        //   hostname = 'foo.example.com'         → ends with '.example.com' ✓
        //   hostname = 'example.com'              → does NOT end with '.example.com' ✗
        //   hostname = 'evil.example.com.net'     → ends with '.net', not '.example.com' ✗
        return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === pattern;
}

// ============================================================================
// Inner helpers called from validateUrl to keep cyclomatic complexity low
// ============================================================================

function checkHostname(hostname: string): ValidateUrlError | null {
    // Stryker disable next-line llm: hostname is already lowercased by the URL parser (see validateUrl's normalization comment), so toLowerCase() before this equality check cannot change the result for any reachable input
    const isExactLocalhostMatch = hostname === 'localhost';
    if(isExactLocalhostMatch || hostname.endsWith('.localhost')) {
        return { ok: false, reason: `host '${hostname}' is loopback` };
    }
    if(hostname === 'host.docker.internal') {
        return { ok: false, reason: `host 'host.docker.internal' is a container-internal alias` };
    }
    return null;
}

function checkIpRanges(hostname: string): ValidateUrlError | null {
    if(isIPv4(hostname) && isBlockedIPv4(hostname)) {
        return { ok: false, reason: `IP address ${hostname} is in a blocked range (loopback/private/link-local)` };
    }
    // Stryker disable next-line EqualityOperator: net.isIP returns only 0, 4, or 6, so !== 0 and > 0 agree
    if(isIP(hostname) !== 0 && isBlockedIPv6(hostname)) {
        return { ok: false, reason: `IP address ${hostname} is in a blocked range (loopback/private/link-local)` };
    }
    return null;
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Validate a URL string against the browser security policy.
 *
 * Returns { ok: true, url } on success, or { ok: false, reason } on failure.
 * Never throws.
 *
 * @param rawUrl - The URL string to validate.
 * @param policy - Optional host policy (allowlist patterns).
 */

export function validateUrl(rawUrl: string, policy: BrowserHostPolicy): ValidateUrlResult {
    // ---- Parse ----
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch{
        return { ok: false, reason: `invalid URL: ${rawUrl}` };
    }

    // ---- Scheme ----
    const scheme = parsed.protocol; // includes trailing ':'
    if(scheme !== 'http:' && scheme !== 'https:') {
        return { ok: false, reason: `scheme '${scheme.slice(0, -1)}' is not allowed; only http/https` };
    }

    // ---- Hostname normalisation ----
    // URL.hostname in Bun keeps brackets for IPv6 literals (e.g. "[::1]").
    // Strip them so isIP() and our range checks work correctly.
    const rawHostname = parsed.hostname; // already lower-cased by URL parser
    // Stryker disable LogicalOperator,StringLiteral: URL parser enforces matching bracket pairs; && vs || and '['/']' literal mutations are equivalent because malformed brackets are rejected at parse time
    // Stryker disable next-line StringMethodArgSwap: URL parsing admits brackets only as the canonical IPv6 pair, so startsWith/includes and endsWith/includes agree
    const unbracketed = rawHostname.startsWith('[') && rawHostname.endsWith(']')
        ? rawHostname.slice(1, -1)
        : rawHostname;
    // Stryker restore LogicalOperator,StringLiteral

    // Normalise trailing dots: DNS allows trailing dots (e.g. 'localhost.') but some URL
    // parsers preserve them. Strip all trailing dots to prevent bypass attacks where a
    // blocklisted hostname like 'localhost' is sent as 'localhost.' and passes the check.
    let hostname = unbracketed;
    while(hostname.endsWith('.')) {
        hostname = hostname.slice(0, -1);
    }
    if(hostname.length === 0) {
        return { ok: false, reason: `invalid URL: ${rawUrl}` };
    }

    // ---- Blocked hostnames ----
    const hostnameError = checkHostname(hostname);
    if(hostnameError !== null) {
        return hostnameError;
    }

    // ---- IP range checks ----
    const ipError = checkIpRanges(hostname);
    if(ipError !== null) {
        return ipError;
    }

    // ---- Allowlist ----
    const { allowlist } = policy;
    if(allowlist && allowlist.length > 0) {
        const allowed = allowlist.some(pattern => matchesPattern(hostname, pattern));
        if(!allowed) {
            return { ok: false, reason: `host '${hostname}' is not in the allowlist` };
        }
    }

    return { ok: true, url: parsed };
}
