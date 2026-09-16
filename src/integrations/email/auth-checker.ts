import type { AuthCheckResult, VerificationResults } from '@/integrations/email/types';

/**
 * Extract the domain from an email address or a bare domain string.
 * 'user@example.com' → 'example.com'
 * 'example.com' → 'example.com'
 * '<user@example.com>' → 'example.com'
 * Returns empty string if input is empty or malformed.
 */
function extractDomain(emailOrDomain: string): string {
    // Stryker disable next-line llm: .replaceAll with a /g-flagged regex is identical to .replace with the same regex — both replace every match.
    const cleaned = emailOrDomain.trim().replaceAll(/^<|>$/g, '');
    const domainStart = cleaned.indexOf('@') + 1;
    // Stryker disable next-line llm: .slice(x) and .substring(x) agree for the non-negative domainStart.
    return cleaned.slice(domainStart);
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
    if(!verificationResults) {
        return { spfPass: false, dkimPass: false };
    }

    const fromDomain = extractDomain(fromAddress);
    // Stryker disable next-line llm: fromDomain is always a string, and for a string !x and x === '' agree for every value.
    if(!fromDomain) {
        return { spfPass: false, dkimPass: false };
    }
    const normalizedFromDomain = fromDomain.toLowerCase();

    const spfPass  = typeof verificationResults.spf === 'string'
      && verificationResults.spf.toLowerCase() === normalizedFromDomain;
    const dkimPass = typeof verificationResults.dkim === 'string'
      && verificationResults.dkim.toLowerCase() === normalizedFromDomain;

    return { spfPass, dkimPass };
}
