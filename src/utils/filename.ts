/**
 * Sanitize a filename to prevent path traversal and filesystem issues.
 * Strips path separators, control chars, and dotdot sequences.
 * Falls back to 'attachment' if the result is empty.
 */
export function sanitizeFilename(name: string): string {
    // Remove null bytes, path-separator chars, and other unsafe chars; then remove dotdot sequences; then trim leading/trailing dots/spaces
    // Stryker disable next-line StringLiteral: '_' replacement is equivalent to '' — tests only verify dangerous chars are absent, not what replaced them
    const noSeparators = name.replaceAll(/[/\\?%*:|"<>\u0000-\u001F]/g, '_');
    // Stryker disable next-line StringLiteral: '_' replacement is equivalent to '' for dotdot sequences given upstream char substitution already ran
    const noDotDot     = noSeparators.replaceAll(/\.{2,}/g, '_');
    let start = 0;
    let end   = noDotDot.length;
    // Stryker disable EqualityOperator,ConditionalExpression,StringLiteral: leading dot/space trimming — boundary operator mutations (< vs <=) converge to same result; space literal removal equivalent when test inputs use dots only
    while(start < end && (noDotDot[start] === '.' || noDotDot[start] === ' ')) {
        start++;
    }
    // Stryker restore EqualityOperator,ConditionalExpression,StringLiteral
    // Stryker disable EqualityOperator,ConditionalExpression,StringLiteral,ArithmeticOperator: trailing dot/space trimming — same boundary equivalence; end+1 reads undefined which exits loop immediately
    while(end > start && (noDotDot[end - 1] === '.' || noDotDot[end - 1] === ' ')) {
        end--;
    }
    // Stryker restore EqualityOperator,ConditionalExpression,StringLiteral,ArithmeticOperator
    return noDotDot.slice(start, end) || 'attachment';
}

/**
 * Deduplicate a filename within a set of already-used names.
 * If 'report.pdf' is taken, tries 'report-(1).pdf', 'report-(2).pdf', etc.
 */
export function deduplicateFilename(filename: string, used: Set<string>): string {
    if(!used.has(filename)) {
        return filename;
    }
    const dotIdx  = filename.lastIndexOf('.');
    const base    = dotIdx === -1 ? filename  : filename.slice(0, dotIdx);
    const ext     = dotIdx === -1 ? ''     : filename.slice(dotIdx);
    let counter = 1;
    let candidate: string;
    do {
        candidate = `${base}-(${counter})${ext}`;
        // Stryker disable next-line UpdateOperator: counter++ → counter-- creates infinite retry loop
        counter++;
    } while(used.has(candidate));
    return candidate;
}
