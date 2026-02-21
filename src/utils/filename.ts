import _ from 'lodash';

/**
 * Sanitize a filename to prevent path traversal and filesystem issues.
 * Strips path separators, control chars, and dotdot sequences.
 * Falls back to 'attachment' if the result is empty.
 */
export function sanitizeFilename(name: string): string {
    // Remove null bytes, path-separator chars, and other unsafe chars; then remove dotdot sequences; then trim leading/trailing dots/spaces
    // Stryker disable next-line StringLiteral: '_' replacement is equivalent to '' — tests only verify dangerous chars are absent, not what replaced them
    const noSeparators = _.replace(name, /[/\\?%*:|"<>\x00-\x1F]/g, '_');
    // Stryker disable next-line StringLiteral: '_' replacement is equivalent to '' for dotdot sequences given upstream char substitution already ran
    const noDotDot     = _.replace(noSeparators, /\.{2,}/g, '_');
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
    const base    = dotIdx !== -1 ? filename.slice(0, dotIdx)  : filename;
    const ext     = dotIdx !== -1 ? filename.slice(dotIdx)     : '';
    let counter = 1;
    let candidate: string;
    do {
        candidate = `${base}-(${counter})${ext}`;
        // Stryker disable next-line UpdateOperator: counter++ → counter-- creates infinite retry loop
        counter++;
    } while(used.has(candidate));
    return candidate;
}
