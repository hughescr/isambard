/**
 * Browser Adapter Types
 *
 * Type definitions for the browser automation adapter layer.
 * The BrowserAdapter interface provides a DI seam so tests can inject
 * a fake without touching the Bun.WebView global.
 */

// ============================================================================
// Supporting Types
// ============================================================================

/**
 * Options for element-targeted click operations.
 */
export interface ClickOptions {
    timeout?:    number
    button?:     'left' | 'right' | 'middle'
    modifiers?:  string[]
    clickCount?: number
}

/**
 * Host allowlist policy for the browser URL guard.
 * An empty or absent allowlist means all (non-blocked) hosts are permitted.
 */
export interface BrowserHostPolicy {
    /** Exact hostnames or `*.example.com` wildcard patterns. Empty array = permissive. */
    allowlist?: string[]
}

/**
 * A single page console log entry captured from the browser.
 */
export interface ConsoleLogEntry {
    type: string
    args: unknown[]
    at:   Date
}

// ============================================================================
// BrowserAdapter Interface
// ============================================================================

/**
 * Platform-agnostic browser automation adapter.
 *
 * Matches the real Bun.WebView API subset we use, so tests can inject
 * a fake implementation without touching the Bun global.
 *
 * close() (not dispose()) matches the Bun.WebView lifecycle method name.
 * loading is a readonly boolean getter — required for agent "did page finish?" decisions.
 */
export interface BrowserAdapter {
    // Navigation
    navigate(url: string): Promise<void>
    reload(): Promise<void>
    goBack(): Promise<void>
    goForward(): Promise<void>

    // DOM waiting
    waitForSelector(selector: string, timeoutMs?: number): Promise<void>

    // Console capture
    getConsoleLogs(limit?: number): ConsoleLogEntry[]

    // JavaScript evaluation — serialized via internal mutex, safe to call concurrently.
    evaluate<T = unknown>(expression: string): Promise<T>

    // Input interactions
    click(selector: string, options?: ClickOptions): Promise<void>
    type(text: string): Promise<void>
    press(key: string, options?: { modifiers?: string[] }): Promise<void>

    // Scrolling
    scroll(dx: number, dy: number): Promise<void>
    scrollTo(selector: string, options?: { block?: 'start' | 'center' | 'end', timeout?: number }): Promise<void>

    // Screenshot — returns raw Buffer (zero-copy, mmap-backed on WebKit).
    // The MCP layer checks buf.byteLength against the cap before base64 conversion.
    screenshot(options?: { format?: 'png' | 'jpeg', quality?: number }): Promise<Buffer>

    // Viewport resize — synchronous on caller side, async apply in WebKit
    resize(width: number, height: number): void

    // State getters — read after any await to reflect latest values.
    // Returns '' / '' / false if not yet initialised or after close.
    readonly url:     string
    readonly title:   string
    readonly loading: boolean

    // Lifecycle
    close(): void           // idempotent
    readonly isClosed: boolean
}
