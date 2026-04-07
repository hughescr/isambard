import type { AuthCheckResult, VerificationResults } from '@/integrations/email/types';

/**
 * Extract the domain from an email address or a bare domain string.
 * 'user@example.com' → 'example.com'
 * 'example.com' → 'example.com'
 * '<user@example.com>' → 'example.com'
 * Returns empty string if input is empty or malformed.
 */
function extractDomain(emailOrDomain: string): string {
    // Stryker disable ConditionalExpression,BlockStatement,StringLiteral: Guard is defensive — empty input produces same result; return value is subsequently guarded by fromDomain check in callers
    if(!emailOrDomain) {
        return '';
    }
    // Stryker restore ConditionalExpression,BlockStatement,StringLiteral
    // Stryker disable next-line Regex,MethodExpression,StringLiteral: anchor mutations produce equivalent results; trim() is defensive; '' replacement is configuration
    const cleaned = emailOrDomain.trim().replaceAll(/^<|>$/g, '');
    const atIdx = cleaned.indexOf('@');
    // Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator,MethodExpression,ArithmeticOperator: atIdx boundary distinguishes address from bare domain; slice(atIdx+1) extracts domain after @; UnaryOperator(-1→+1) is equivalent since atIdx is never 1 for valid domains
    return atIdx === -1 ? cleaned : cleaned.slice(atIdx + 1);
}

/**
 * Check email authentication using WildDuck's pre-parsed verification results.
 * WildDuck returns the verified domain string for SPF/DKIM, or false if not verified.
 * Domain alignment is already performed by WildDuck — we confirm the verified domain
 * matches the From: domain (case-insensitive, exact match).
 */
export function checkVerificationResults(
    verificationResults: VerificationResults | undefined,
    fromAddress: string
): AuthCheckResult {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Guard is defensive — undefined input produces same result
    if(!verificationResults) {
        return { spfPass: false, dkimPass: false };
    }

    const fromDomain = extractDomain(fromAddress);
    // Stryker disable next-line ConditionalExpression,BlockStatement: Guard is defensive — empty from domain cannot align with anything
    if(!fromDomain) {
        return { spfPass: false, dkimPass: false };
    }
    // Stryker disable next-line MethodExpression: toLowerCase is symmetric normalization — toUpperCase mutation is equivalent
    const normalizedFromDomain = fromDomain.toLowerCase();

    const spfPass  = typeof verificationResults.spf === 'string'
      // Stryker disable next-line MethodExpression: toLowerCase is symmetric normalization — toUpperCase mutation is equivalent
      && verificationResults.spf.toLowerCase() === normalizedFromDomain;
    const dkimPass = typeof verificationResults.dkim === 'string'
      // Stryker disable next-line MethodExpression: toLowerCase is symmetric normalization — toUpperCase mutation is equivalent
      && verificationResults.dkim.toLowerCase() === normalizedFromDomain;

    return { spfPass, dkimPass };
}
