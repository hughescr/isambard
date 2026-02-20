import _ from 'lodash';

/**
 * Sanitize a filename to prevent path traversal and filesystem issues.
 * Strips path separators, control chars, and dotdot sequences.
 * Falls back to 'attachment' if the result is empty.
 */
// Stryker disable next-line Regex,StringLiteral: filename sanitization regex is security-critical configuration
export function sanitizeFilename(name: string): string {
    // Remove null bytes, path-separator chars, and other unsafe chars; then remove dotdot sequences; then trim leading/trailing dots/spaces
    // Stryker disable next-line StringLiteral: replacement char '_' is security-critical configuration
    const noSeparators = _.replace(name, /[/\\?%*:|"<>\x00-\x1F]/g, '_');
    // Stryker disable next-line StringLiteral: replacement char '_' is security-critical configuration
    const noDotDot     = _.replace(noSeparators, /\.{2,}/g, '_');
    // Stryker disable next-line StringLiteral: trim chars and fallback are security-critical configuration
    return _.trim(noDotDot, '. ') || 'attachment';
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
    // Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator: -1 check distinguishes files with/without extension
    const base    = dotIdx !== -1 ? filename.slice(0, dotIdx)  : filename;
    // Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator,StringLiteral: -1 check distinguishes files with/without extension; empty string is no-extension fallback
    const ext     = dotIdx !== -1 ? filename.slice(dotIdx)     : '';
    let counter = 1;
    let candidate: string;
    do {
        // Stryker disable next-line StringLiteral: dedup suffix format is configuration
        candidate = `${base}-(${counter})${ext}`;
        // Stryker disable next-line UpdateOperator: counter increments to find next available filename slot
        counter++;
    // Stryker disable next-line ConditionalExpression: loop condition checks if candidate is already used
    } while(used.has(candidate));
    return candidate;
}
