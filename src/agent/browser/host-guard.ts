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
import { InvariantViolationError } from '@/errors';

// ============================================================================
// Result types
// ============================================================================

interface ValidateUrlOk    { ok: true, url: URL }
interface ValidateUrlError { ok: false, reason: string }
type ValidateUrlResult = ValidateUrlOk | ValidateUrlError;

// ============================================================================
// Helpers — IP range checks
// ============================================================================

/** Split a dotted-decimal IPv4 string into four octets as numbers, or return null. */
// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns number[] | null
function ipv4Octets(addr: string): number[] | null {
    const parts = addr.split('.');
    // Stryker disable ConditionalExpression,EqualityOperator,BlockStatement: defensive guard — only called after isIPv4() which already validates 4 octets; unreachable through public API
    if(parts.length !== 4) {
        return null;
    }
    // Stryker restore ConditionalExpression,EqualityOperator,BlockStatement
    const nums = parts.map(p => Number.parseInt(p, 10));
    // Stryker disable ConditionalExpression,LogicalOperator,ArrowFunction,MethodExpression,BlockStatement: defensive guard — only called after isIPv4() which ensures valid 0-255 octets; range checks are unreachable through public API
    if(nums.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
        return null;
    }
    // Stryker restore ConditionalExpression,LogicalOperator,ArrowFunction,MethodExpression,BlockStatement
    return nums;
}

/** Returns true if the IPv4 address is in a blocked private/loopback/link-local range. */
function isBlockedIPv4(addr: string): boolean {
    const octs = ipv4Octets(addr);
    if(octs === null) {
        // Stryker disable next-line BooleanLiteral: defensive guard — only called after isIPv4() which ensures valid input; null return from ipv4Octets is unreachable through public API
        return false;
    }
    // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — isIPv4() ensures exactly 4 octets; unreachable in practice
    if(octs.length !== 4) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('isBlockedIPv4', 'ipv4Octets returned array without exactly 4 elements');
    }
    const [a, b, c, d] = octs as [number, number, number, number];

    // Zero address: 0.0.0.0
    if(a === 0 && b === 0 && c === 0 && d === 0) {
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
    // Stryker disable next-line Regex: Stryker generates the same regex as replacement — equivalent mutant
    if(/^fe[89ab]/i.test(lower)) {
        return true;
    }
    // IPv6 ULA: fc00::/7 — first byte is 0xfc (11111100) or 0xfd (11111101)
    // Stryker disable next-line Regex: Stryker generates the same regex as replacement — equivalent mutant
    if(/^f[cd]/i.test(lower)) {
        return true;
    }

    // IPv4-mapped IPv6: ::ffff:0:0/96
    // Two encodings:
    //   dotted-quad:  ::ffff:127.0.0.1
    //   hex groups:   ::ffff:7f00:1 or ::ffff:7F00:0001
    // Both are SSRF bypass vectors — extract the embedded IPv4 and re-check.
    // Stryker disable next-line Regex: case-insensitive prefix check — equivalent mutant
    const mappedPrefix = /^::ffff:/i;
    // Stryker disable next-line ConditionalExpression: equivalent mutant — for non-::ffff: addresses, extractMappedV4 always returns null (Bun URL parser normalises to hex; raw inputs don't match our patterns), so the if-body produces no effect regardless
    if(mappedPrefix.test(lower)) {
        const embeddedV4 = extractMappedV4(addr.slice(7)); // skip '::ffff:'
        if(embeddedV4 !== null && isBlockedIPv4(embeddedV4)) {
            return true;
        }
    }

    return false;
}

/**
 * Extract an embedded IPv4 address from the portion after '::ffff:'.
 * Handles two forms:
 *   dotted-quad:  '127.0.0.1'
 *   hex groups:   '7f00:1' (two colon-separated 16-bit hex groups)
 * Returns the dotted-quad string or null if unrecognised.
 */
// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns string | null
function extractMappedV4(rest: string): string | null {
    // Try dotted-quad form first: four decimal octets separated by dots
    // Stryker disable next-line Regex: dotted-quad pattern — alternative regex would also match four groups of digits with dots
    // Stryker disable ConditionalExpression,BlockStatement: Bun URL normalises ::ffff:1.2.3.4 → ::ffff:hex:hex so the dotted-quad branch is unreachable via URL parser; kept for defensive raw-input coverage
    if(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest)) {
        return rest;
    }
    // Stryker restore ConditionalExpression,BlockStatement
    // Try hex-group form: two groups of 1-4 hex chars separated by a colon
    // e.g. 7f00:1 → 127.0.0.1; a9fe:a9fe → 169.254.169.254
    // Stryker disable next-line Regex: hex group pattern — equivalent regex would match same strings
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
    if(hexMatch === null) {
        return null;
    }
    // Each 16-bit group → two 8-bit octets. Use Math.floor(x / 256) and x % 256 to avoid bitwise ops.
    // capture groups: [1] = hi word, [2] = lo word — if you change the regex structure, update the destructure indices
    const [, hiStr, loStr] = hexMatch;
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: invariant guard — regex has two capture groups; both are always present when hexMatch !== null
    if(hiStr === undefined || loStr === undefined) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('parseHexIPv4', 'regex capture groups absent despite hexMatch !== null');
    }
    const hi = Number.parseInt(hiStr, 16);
    const lo = Number.parseInt(loStr, 16);
    // Stryker disable next-line ArithmeticOperator: division by 256 extracts high byte (equivalent to >> 8 for 0-65535)
    const hiHigh = Math.floor(hi / 256);
    // Stryker disable next-line ArithmeticOperator: modulo 256 extracts low byte (equivalent to & 0xff for 0-65535)
    const hiLow = hi % 256;
    // Stryker disable next-line ArithmeticOperator: division by 256 extracts high byte
    const loHigh = Math.floor(lo / 256);
    // Stryker disable next-line ArithmeticOperator: modulo 256 extracts low byte
    const loLow = lo % 256;
    return `${hiHigh}.${hiLow}.${loHigh}.${loLow}`;
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
        const suffix = pattern.slice(1); // '.example.com'
        // hostname must end with this suffix AND have at least one char before it.
        // Guards against bare domain match and suffix-hijack attacks:
        //   hostname = 'foo.example.com'         → ends with '.example.com' ✓
        //   hostname = 'example.com'              → does NOT end with '.example.com' ✗
        //   hostname = 'evil.example.com.net'     → ends with '.net', not '.example.com' ✗
        // Stryker disable next-line ConditionalExpression,EqualityOperator: hostname.length > suffix.length guards against a hostname that IS the suffix (e.g. '.example.com') which cannot occur in practice since URL hostnames never start with '.'
        return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === pattern;
}

// ============================================================================
// Inner helpers called from validateUrl to keep cyclomatic complexity low
// ============================================================================

// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns ValidateUrlError | null
function checkHostname(hostname: string): ValidateUrlError | null {
    if(hostname === 'localhost' || hostname.endsWith('.localhost')) {
        // Stryker disable next-line StringLiteral: error message is informational only
        return { ok: false, reason: `host '${hostname}' is loopback` };
    }
    if(hostname === 'host.docker.internal') {
        // Stryker disable next-line StringLiteral: error message is informational only
        return { ok: false, reason: `host 'host.docker.internal' is a container-internal alias` };
    }
    return null;
}

// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns ValidateUrlError | null
function checkIpRanges(hostname: string): ValidateUrlError | null {
    if(isIPv4(hostname) && isBlockedIPv4(hostname)) {
        // Stryker disable next-line StringLiteral: error message is informational only
        return { ok: false, reason: `IP address ${hostname} is in a blocked range (loopback/private/link-local)` };
    }
    // Stryker disable next-line ConditionalExpression: isIP(hostname)!==0→true is equivalent because isBlockedIPv6() returns false for non-IPv6 strings, so the condition result is unchanged for real hostnames
    if(isIP(hostname) !== 0 && isBlockedIPv6(hostname)) {
        // Stryker disable next-line StringLiteral: error message is informational only
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
// eslint-disable-next-line sonarjs/function-return-type -- intentional discriminated union return type
export function validateUrl(rawUrl: string, policy: BrowserHostPolicy): ValidateUrlResult {
    // ---- Parse ----
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    // eslint-disable-next-line @stylistic/keyword-spacing -- optional catch binding (no parameter) triggers keyword-spacing false positive
    } catch {
        // Stryker disable next-line StringLiteral: error message is informational only
        return { ok: false, reason: `invalid URL: ${rawUrl}` };
    }

    // ---- Scheme ----
    const scheme = parsed.protocol; // includes trailing ':'
    if(scheme !== 'http:' && scheme !== 'https:') {
        // Stryker disable next-line StringLiteral: error message is informational only
        return { ok: false, reason: `scheme '${scheme.slice(0, -1)}' is not allowed; only http/https` };
    }

    // ---- Hostname normalisation ----
    // URL.hostname in Bun keeps brackets for IPv6 literals (e.g. "[::1]").
    // Strip them so isIP() and our range checks work correctly.
    const rawHostname = parsed.hostname; // already lower-cased by URL parser
    // Stryker disable LogicalOperator,StringLiteral: URL parser enforces matching bracket pairs; && vs || and '['/']' literal mutations are equivalent because malformed brackets are rejected at parse time
    const unbracketed = rawHostname.startsWith('[') && rawHostname.endsWith(']')
        ? rawHostname.slice(1, -1)
        : rawHostname;
    // Stryker restore LogicalOperator,StringLiteral

    // Normalise trailing dots: DNS allows trailing dots (e.g. 'localhost.') but some URL
    // parsers preserve them. Strip all trailing dots to prevent bypass attacks where a
    // blocklisted hostname like 'localhost' is sent as 'localhost.' and passes the check.
    let hostname = unbracketed;
    // Stryker disable ConditionalExpression,EqualityOperator,BlockStatement,MethodExpression: trailing-dot stripping loop; BlockStatement/MethodExpression mutations would infinite-loop; ConditionalExpression/EqualityOperator mutations either over-strip or under-strip (caught by trailing-dot tests)
    while(hostname.endsWith('.') && hostname.length > 1) {
        hostname = hostname.slice(0, -1);
    }
    // Stryker restore ConditionalExpression,EqualityOperator,BlockStatement,MethodExpression

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
            // Stryker disable next-line StringLiteral: error message is informational only
            return { ok: false, reason: `host '${hostname}' is not in the allowlist` };
        }
    }

    return { ok: true, url: parsed };
}
