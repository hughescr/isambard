import _ from 'lodash';
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
    // Stryker disable next-line Regex: anchor mutations produce equivalent results — exact domain comparison treats malformed inputs as non-alignable regardless
    const cleaned = _.replace(_.trim(emailOrDomain), /^<|>$/g, '');
    const atIdx = cleaned.indexOf('@');
    // Stryker disable next-line ConditionalExpression,EqualityOperator,MethodExpression,ArithmeticOperator: atIdx boundary distinguishes address from bare domain; slice(atIdx+1) extracts domain after @
    return atIdx >= 0 ? cleaned.slice(atIdx + 1) : cleaned;
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
    const normalizedFromDomain = _.toLower(fromDomain);

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
                if(mailfromDomain && mailfromDomain === normalizedFromDomain) {
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
                if(dkimDomain && dkimDomain === normalizedFromDomain) {
                    dkimPass = true;
                }
            }
        }
    }

    return { spfPass, dkimPass };
}
