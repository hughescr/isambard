export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function booleanValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}
export function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function dateValue(value: unknown): Date | undefined {
    if(typeof value !== 'string') {
        return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
export function scopeLabel(value: unknown): { id?: string, displayName?: string } | undefined {
    const raw = asRecord(value);
    const id = stringValue(raw?.id);
    const displayName = stringValue(raw?.display_name);
    return id === undefined && displayName === undefined ? undefined : { id, displayName };
}
