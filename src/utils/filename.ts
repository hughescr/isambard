/**
 * Sanitize a filename to prevent path traversal and filesystem issues.
 * Strips path separators, control chars, and dotdot sequences.
 * Falls back to 'attachment' if the result is empty.
 */
export function sanitizeFilename(name: string): string {
    // Remove null bytes, path-separator chars, and other unsafe chars; then remove dotdot sequences; then trim leading/trailing dots/spaces
    const noSeparators = name.replaceAll(/[/\\?%*:|"<>\u0000-\u001F]/g, '_');
    const noDotDot     = noSeparators.replaceAll(/\.{2,}/g, '_');
    let start = 0;
    let end   = noDotDot.length;
    while(noDotDot[start] === '.' || noDotDot[start] === ' ') {
        start++;
    }
    while(noDotDot[end - 1] === '.' || noDotDot[end - 1] === ' ') {
        end--;
    }
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
    // Stryker disable next-line llm: slice(0, n) and substring(0, n) are identical for n >= 0, and dotIdx is guaranteed >= 0 in this branch (the -1 case takes the other ternary arm).
    const base    = dotIdx === -1 ? filename  : filename.slice(0, dotIdx);
    const ext     = dotIdx === -1 ? ''     : filename.slice(dotIdx);
    // Each occupied candidate is a distinct member of the finite `used` set, so a
    // monotonically increasing suffix must eventually find an available name.
    // Stryker disable next-line llm: the for-update expression value is discarded, so prefix and postfix increment of the local counter are indistinguishable.
    for(let counter = 1; ; counter++) {
        const candidate = `${base}-(${counter})${ext}`;
        if(!used.has(candidate)) {
            return candidate;
        }
    }
}
