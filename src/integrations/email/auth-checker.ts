import _ from 'lodash';
import { parse } from 'tldts';
import type { AuthCheckResult } from '@/integrations/email/types';

/**
 * Extract the organizational domain (eTLD+1) from a domain string using tldts.
 * For relaxed alignment: mail.example.com → example.com
 * Uses the Public Suffix List for correct eTLD+1 extraction.
 * Returns null if the domain cannot be resolved to a registrable domain (e.g., bare TLD).
 */
function orgDomain(domain: string): string | null {
    // Stryker disable next-line StringLiteral,ObjectLiteral,ArrayDeclaration,BooleanLiteral: tldts parse options are configuration constants
    const result = parse(domain, { validHosts: [], allowPrivateDomains: true });
    return result.domain ?? null;
}

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
    // Stryker disable next-line Regex: anchor mutations produce equivalent results — tldts/orgDomain treats malformed mid-bracket inputs as non-alignable regardless
    const cleaned = _.replace(_.trim(emailOrDomain), /^<|>$/g, '');
    const atIdx = cleaned.indexOf('@');
    // Stryker disable next-line ConditionalExpression,EqualityOperator,MethodExpression: atIdx boundary distinguishes address from bare domain; tldts parses email addresses natively so slice is equivalent
    return atIdx >= 0 ? cleaned.slice(atIdx + 1) : cleaned;
}

/**
 * Parse Authentication-Results header for SPF and DKIM results with domain alignment.
 * Used to determine if an allowlisted sender's email is authenticated.
 * Allowlist bypass requires: sender on allowlist AND (spfPass OR dkimPass).
 *
 * Alignment rules (relaxed, per RFC 7489):
 * - SPF: spf=pass AND smtp.mailfrom domain has same org domain as From:
 * - DKIM: dkim=pass AND header.d domain has same org domain as From:
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
    const fromOrg = orgDomain(_.toLower(fromDomain));
    // Stryker disable next-line ConditionalExpression,BlockStatement: Guard is defensive — null fromOrg means from domain is a bare TLD, cannot align with anything
    if(!fromOrg) {
        return { spfPass: false, dkimPass: false };
    }

    const parts = _.split(authenticationResults, ';');

    let spfPass  = false;
    let dkimPass = false;

    for(const part of parts) {
        const normalized = _.trim(part);

        // Check SPF pass with alignment
        if(/\bspf=pass\b/i.test(normalized)) {
            // Extract smtp.mailfrom=<value> — may include angle-bracket address or bare email
            const mailfromMatch = /\bsmtp\.mailfrom=([^\s;]+)/i.exec(normalized);
            if(mailfromMatch) {
                const mailfromDomain = extractDomain(_.toLower(mailfromMatch[1]));
                const mailfromOrg    = mailfromDomain ? orgDomain(mailfromDomain) : null;
                if(mailfromOrg && mailfromOrg === fromOrg) {
                    spfPass = true;
                }
            }
        }

        // Check DKIM pass with alignment
        if(/\bdkim=pass\b/i.test(normalized)) {
            // Extract header.d=<domain>
            const headerdMatch = /\bheader\.d=([^\s;]+)/i.exec(normalized);
            if(headerdMatch) {
                const dkimDomain = _.toLower(headerdMatch[1]);
                const dkimOrg    = dkimDomain ? orgDomain(dkimDomain) : null;
                if(dkimOrg && dkimOrg === fromOrg) {
                    dkimPass = true;
                }
            }
        }
    }

    return { spfPass, dkimPass };
}
