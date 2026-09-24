export interface QuotaFetchResponse {
    ok:     boolean
    status: number
    json:   () => Promise<unknown>
}
export type QuotaFetch = (url: string, init: { headers: Record<string, string>, signal?: AbortSignal }) => Promise<QuotaFetchResponse>;
