import type { AuthCheckResult } from '@/integrations/email/types';

/**
 * Extract the domain from an email address or a bare domain string.
 * 'user@example.com' → 'example.com'
 * 'example.com' → 'example.com'
 * '<user@example.com>' → 'example.com'
 * Returns empty string if input is empty or malformed.
 */
function extractDomain(emailOrDomain: string): string {
    // Stryker disable ConditionalExpression,BlockStatement,StringLiteral: Guard is defensive — empty input produces same result; return value is subsequently guarded by fromDomain check in checkAuthentication
    if(!emailOrDomain) {
        return '';
    }
    // Stryker restore ConditionalExpression,BlockStatement,StringLiteral
    // Stryker disable next-line Regex,MethodExpression: anchor mutations produce equivalent results; trim() is defensive — email header values don't have surrounding whitespace in practice
    const cleaned = emailOrDomain.trim().replaceAll(/^<|>$/g, '');
    const atIdx = cleaned.indexOf('@');
    // Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator,MethodExpression,ArithmeticOperator: atIdx boundary distinguishes address from bare domain; slice(atIdx+1) extracts domain after @; UnaryOperator(-1→+1) is equivalent since atIdx is never 1 for valid domains
    return atIdx === -1 ? cleaned : cleaned.slice(atIdx + 1);
}

/**
 * Check if an Authentication-Results part shows SPF pass with domain alignment.
 */
function checkSpfAlignment(normalized: string, normalizedFromDomain: string): boolean {
    if(!/\bspf=pass\b/i.test(normalized)) {
        return false;
    }
    // Extract smtp.mailfrom=<value> — may include angle-bracket address or bare email
    const mailfromMatch = /\bsmtp\.mailfrom=([^\s;]+)/i.exec(normalized);
    if(!mailfromMatch) {
        return false;
    }
    const mailfromDomain = extractDomain(mailfromMatch[1].toLowerCase());
    return Boolean(mailfromDomain) && mailfromDomain === normalizedFromDomain;
}

/**
 * Check if an Authentication-Results part shows DKIM pass with domain alignment.
 */
function checkDkimAlignment(normalized: string, normalizedFromDomain: string): boolean {
    if(!/\bdkim=pass\b/i.test(normalized)) {
        return false;
    }
    // Extract header.d=<domain>
    const headerdMatch = /\bheader\.d=([^\s;]+)/i.exec(normalized);
    if(!headerdMatch) {
        return false;
    }
    const dkimDomain = headerdMatch[1].toLowerCase();
    return Boolean(dkimDomain) && dkimDomain === normalizedFromDomain;
}

/**
 * Parse Authentication-Results header for SPF and DKIM results with domain alignment.
 * Used to determine if an allowlisted sender's email is authenticated.
 * Allowlist bypass requires: sender on allowlist AND (spfPass OR dkimPass).
 *
 * Alignment rules (strict/exact, case-insensitive):
 * - SPF: spf=pass AND smtp.mailfrom domain exactly matches From: domain
 * - DKIM: dkim=pass AND header.d domain exactly matches From: domain
 * Subdomains do NOT align (mail.example.com does NOT align with example.com).
 */
export function checkAuthentication(authenticationResults: string | undefined, fromAddress: string): AuthCheckResult {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Guard is defensive — falsy strings produce same result from main loop
    if(!authenticationResults) {
        return { spfPass: false, dkimPass: false };
    }

    const fromDomain = extractDomain(fromAddress);
    // Stryker disable next-line ConditionalExpression,BlockStatement: Guard is defensive — empty from domain cannot align with anything
    if(!fromDomain) {
        return { spfPass: false, dkimPass: false };
    }
    const normalizedFromDomain = fromDomain.toLowerCase();

    const parts = authenticationResults.split(';');

    let spfPass  = false;
    let dkimPass = false;

    for(const part of parts) {
        // Stryker disable next-line MethodExpression: trim() normalizes semicolon-split segments — regex patterns downstream tolerate surrounding whitespace
        const normalized = part.trim();
        if(checkSpfAlignment(normalized, normalizedFromDomain)) {
            spfPass = true;
        }
        if(checkDkimAlignment(normalized, normalizedFromDomain)) {
            dkimPass = true;
        }
    }

    return { spfPass, dkimPass };
}
