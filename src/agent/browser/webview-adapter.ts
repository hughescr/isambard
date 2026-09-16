/**
 * WebView Adapter — wraps Bun.WebView behind the BrowserAdapter interface.
 *
 * Key responsibilities:
 *  - Lazy init: constructs Bun.WebView only on first method call.
 *  - Platform precheck: rejects on non-darwin when backend resolves to webkit.
 *  - Evaluate mutex: serializes evaluate() calls (Bun.WebView only allows one at a time).
 *  - Console ring buffer: captures up to 200 page console entries (cleared on reinit).
 *  - Idempotent close(): safe to call multiple times; re-initialises on next call.
 *  - Scroll pre-validation: rejects NaN/Infinity before touching the view.
 *  - Navigate timeout recovery: races navigate() against navigationTimeoutMs; on timeout
 *    calls reload() up to 2 more times; on third timeout closes the view so lazy-reinit
 *    fires on next tool call (persistent dataStore survives so cookies/sessions come back).
 */
import { logger } from '@hughescr/logger';
import type { BrowserAdapter, ClickOptions, ConsoleLogEntry } from './types';
import { BrowserError, BrowserNavigateTimeoutError } from '@/errors';

// ============================================================================
// Config
// ============================================================================

/**
 * Configuration for the WebView adapter.
 * Note: maxScreenshotBytes and maxTextBytes are NOT here — they are enforced
 * at the MCP server layer, not inside the adapter.
 */
export interface WebViewAdapterConfig {
    backend:             'auto' | 'webkit' | 'chrome'
    viewportWidth:       number
    viewportHeight:      number
    navigationTimeoutMs: number
    actionTimeoutMs:     number
    dataStorePath?:      string
    chromePath?:         string
}

// ============================================================================
// Internal Bun.WebView shape (minimal — only what we use)
// ============================================================================

interface WebViewOptions {
    width:      number
    height:     number
    backend?:   string | { type: string, path?: string }
    headless?:  boolean
    console?:   (type: string, ...args: unknown[]) => void
    dataStore?: { directory: string }
}

interface RawWebView {
    readonly url:     string
    readonly title:   string
    readonly loading: boolean
    navigate(url: string): Promise<void>
    reload(): Promise<void>
    goBack(): Promise<void>
    goForward(): Promise<void>
    evaluate(expr: string): Promise<unknown>
    click(selector: string, opts?: ClickOptions): Promise<void>
    click(x: number, y: number): Promise<void>
    type(text: string): Promise<void>
    press(key: string, opts?: { modifiers?: string[] }): Promise<void>
    scroll(dx: number, dy: number): Promise<void>
    scrollTo(selector: string, opts?: { block?: 'start' | 'center' | 'end', timeout?: number }): Promise<void>
    screenshot(opts?: { format?: 'png' | 'jpeg', quality?: number, encoding?: string }): Promise<Buffer | string>
    resize(w: number, h: number): void
    close(): void
}

// WebViewFactory is file-local (not exported) — tests inject via factory parameter
type WebViewFactory = (opts: WebViewOptions) => RawWebView;

// ============================================================================
// Constants
// ============================================================================

const CONSOLE_RING_BUFFER_SIZE = 200;
const WAIT_FOR_SELECTOR_POLL_MS = 50;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Creates a BrowserAdapter wrapping a Bun.WebView instance.
 *
 * @param config         - Browser configuration (no size caps — those live in the MCP layer).
 * @param webViewFactory - Optional factory for tests to inject a fake WebView.
 *                         Defaults to `(opts) => new Bun.WebView(opts)`.
 * @param delayFn        - Optional async delay function for tests to inject a fake timer.
 *                         Defaults to a real setTimeout-based delay.
 */
export function createWebViewAdapter(
    config: WebViewAdapterConfig,
    webViewFactory?: WebViewFactory,
    delayFn?: (ms: number) => Promise<void>
): BrowserAdapter {
    // @types/bun (via bun-types) types Bun.WebView; no `any` cast needed.
    // Cast opts to ConstructorOptions: local WebViewOptions.backend is string|{type,path}
    // (wider than Bun.WebView.Backend), but only valid Backend values are ever passed.
    // Cast result to unknown first: Bun.WebView extends EventTarget which RawWebView does not,
    // so TS cannot verify the structural overlap via a direct single cast.
    // boundary cast: Bun.WebView extends EventTarget which RawWebView does not; structural overlap cannot be verified by TS without going through unknown first
    const bunWebView = (opts: WebViewOptions): RawWebView =>
        new Bun.WebView(opts as Bun.WebView.ConstructorOptions) as unknown as RawWebView;
    const factory: WebViewFactory = webViewFactory ?? bunWebView;
    const delay: (ms: number) => Promise<void> = delayFn ?? (ms => new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    }));

    let view:    RawWebView | null = null;

    // Console ring buffer — filled by the constructor callback.
    // Cleared on each reinit so stale logs from a previous session don't bleed through.
    const consoleLogs: ConsoleLogEntry[] = [];

    // Evaluate mutex — chained promise so concurrent calls queue instead of throwing
    let evaluateTail: Promise<unknown> = Promise.resolve();

    // ---- Console callback ----
    function onConsole(type: string, ...args: unknown[]): void {
        if(consoleLogs.length >= CONSOLE_RING_BUFFER_SIZE) {
            consoleLogs.shift();
        }
        consoleLogs.push({ type, args, at: new Date() });
    }

    // ---- ensureView ----
    function ensureView(): RawWebView {
        if(view !== null) {
            return view;
        }

        // Clear stale console logs from the previous session before constructing a new view.
        // FIX 8: without this, logs from before close() bleed through after reinit.
        consoleLogs.length = 0;

        // Platform precheck
        if(config.backend === 'webkit' && process.platform !== 'darwin') {
            throw new BrowserError(
                'Bun.WebView requires macOS when using the WebKit backend. '
                + "On other platforms, set backend: 'chrome'."
            );
        }

        // Build constructor options
        const opts: WebViewOptions = {
            width:   config.viewportWidth,
            height:  config.viewportHeight,
            console: onConsole,
        };

        if(config.backend !== 'auto') {
            opts.backend = (config.backend === 'chrome' && config.chromePath !== undefined)
                ? { type: 'chrome', path: config.chromePath }
                : config.backend;
        }

        if(config.dataStorePath) {
            opts.dataStore = { directory: config.dataStorePath };
        }

        view = factory(opts);
        return view;
    }

    // ---- Navigate with timeout recovery — helpers ----

    // startAttempt: returns the pending Promise for one navigate/reload attempt.
    // On attempt 0 this is navigate(url); on subsequent attempts this is reload(),
    // with a pending-slot fallback (close+reinit+navigate) when reload() throws /pending/i.
    // Returns { promise, view: updatedView } — view may change if a reinit occurred.
    //
    function startAttempt(attempt: number, v: RawWebView, url: string): { promise: Promise<void>, view: RawWebView } {
        if(attempt === 0) {
            return { promise: v.navigate(url), view: v };
        }
        // eslint-disable-next-line sonarjs/no-try-promise -- intentional: catching synchronous throws from reload() before the returned Promise can be awaited (Bun.WebView pending-slot conflict)
        try {
            return { promise: v.reload(), view: v };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if(/pending/i.test(msg)) {
                // Bun.WebView pending-slot conflict: reload() threw synchronously.
                // Close the stuck view, reinit, and fall back to navigate(url).
                logger.warn('reload() failed with pending-slot conflict; closing view and retrying navigate');
                try {
                    v.close();
                } catch{
                    // Silent: v.close() can throw when the view is already in a broken/stuck state
                    // (the same pending-slot conflict that caused reload() to fail). The error from
                    // close() is not actionable — view = null below fires regardless, which causes
                    // ensureView() to allocate a fresh view on the next tool call.
                }
                view = null;
                const fresh = ensureView();
                return { promise: fresh.navigate(url), view: fresh };
            }
            throw error;
        }
    }

    // closeViewForRecovery: hardens the close-on-third-timeout path.
    // Logs any close() error but always nulls the shared view reference so
    // lazy-reinit fires on the next tool call. The persistent dataStore on
    // disk survives so cookies/sessions come back.
    //
    function closeViewForRecovery(v: RawWebView): void {
        try {
            v.close();
        } catch (error) {
            logger.warn(`v.close() threw during navigate timeout recovery: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            view = null;
        }
    }

    // ---- Navigate with timeout recovery ----
    // Races navigate/reload against navigationTimeoutMs.
    // On each timeout: log a warning, swallow the hanging promise to prevent unhandled rejection,
    // then try again (reload or navigate retry depending on what the previous call did).
    // After 3 consecutive timeouts: close the view and throw. Lazy-reinit on next call.
    //
    // Implementation note: Bun.WebView may use different pending slots for navigate()
    // (m_pendingNavigate) and reload() (m_pendingMisc). If reload() throws a /pending/i
    // error synchronously when the original navigate() is still outstanding, we fall back
    // to closing+reiniting and calling navigate(url) again — same escalation shape, cleaner
    // against a stuck pending slot.
    async function navigateWithTimeout(url: string): Promise<void> {
        let v = ensureView();
        const timeoutMs = config.navigationTimeoutMs;

        for(const attempt of [0, 1, 2] as const) {
            const { promise: attemptPromise, view: nextView } = startAttempt(attempt, v, url);
            v = nextView;

            // eslint-disable-next-line no-await-in-loop -- sequential navigation attempts with timeout
            const raceResult = await Promise.race([
                attemptPromise,
                delay(timeoutMs).then((): 'timeout' => 'timeout'),
            ]);

            if(raceResult !== 'timeout') {
                return;
            }

            // Timeout on this attempt — swallow the hanging promise to avoid unhandled rejection
            // then either retry (reload) or close+throw on the third timeout.
            attemptPromise.catch(() => { /* swallow eventual settle of hung promise */ });

            if(attempt < 2) {
                logger.warn(`navigate(${url}) timed out on attempt ${attempt + 1}, retrying with reload()…`);
            } else {
                // Third timeout: close the view so lazy-reinit fires on next tool call.
                logger.warn(`navigate(${url}) timed out 3 times; closing view for lazy-reinit`);
                closeViewForRecovery(v);
                throw new BrowserNavigateTimeoutError(url, 3);
            }
        }
    }

    // ---- State getters ----
    function getUrl(): string {
        return view === null ? '' : view.url;
    }

    function getTitle(): string {
        return view === null ? '' : view.title;
    }

    function getLoading(): boolean {
        return view?.loading === true;
    }

    // ---- Adapter implementation ----
    const adapter: BrowserAdapter = {
        get url()     { return getUrl(); },
        get title()   { return getTitle(); },
        get loading() { return getLoading(); },
        get isClosed() { return view === null; },

        async navigate(url: string): Promise<void> {
            return navigateWithTimeout(url);
        },

        async reload(): Promise<void> {
            const v = ensureView();
            return v.reload();
        },

        async goBack(): Promise<void> {
            const v = ensureView();
            return v.goBack();
        },

        async goForward(): Promise<void> {
            const v = ensureView();
            return v.goForward();
        },

        async evaluate<T = unknown>(expression: string): Promise<T> {
            const v = ensureView();
            // Chain onto the mutex tail so concurrent calls queue and don't collide
            const result = evaluateTail.then(() => v.evaluate(expression)) as Promise<T>;
            // Update the tail: even if result rejects, the next call must still proceed
            // eslint-disable-next-line no-restricted-syntax -- mutex tail update: result rejection is already propagated to the caller; the tail must advance regardless
            evaluateTail = result.catch(() => undefined);
            return result;
        },

        async click(selector: string, options?: ClickOptions): Promise<void> {
            const v = ensureView();
            return v.click(selector, options);
        },

        async type(text: string): Promise<void> {
            const v = ensureView();
            return v.type(text);
        },

        async press(key: string, options?: { modifiers?: string[] }): Promise<void> {
            const v = ensureView();
            return v.press(key, options);
        },

        async scroll(dx: number, dy: number): Promise<void> {
            if(!Number.isFinite(dx) || !Number.isFinite(dy)) {
                throw new TypeError(`scroll() requires finite dx and dy values, got dx=${dx}, dy=${dy}`);
            }
            const v = ensureView();
            return v.scroll(dx, dy);
        },

        async scrollTo(
            selector: string,
            options?: { block?: 'start' | 'center' | 'end', timeout?: number }
        ): Promise<void> {
            const v = ensureView();
            return v.scrollTo(selector, options);
        },

        async screenshot(options?: { format?: 'png' | 'jpeg', quality?: number }): Promise<Buffer> {
            const v = ensureView();
            const opts: { format?: 'png' | 'jpeg', quality?: number, encoding: string } = { encoding: 'buffer' };
            if(options?.format !== undefined) {
                opts.format = options.format;
            }
            if(options?.quality !== undefined) {
                opts.quality = options.quality;
            }
            return v.screenshot(opts) as Promise<Buffer>;
        },

        resize(width: number, height: number): void {
            const v = ensureView();
            v.resize(width, height);
        },

        async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
            const deadline = Date.now() + (timeoutMs ?? config.actionTimeoutMs);
            ensureView(); // ensure init before polling loop

            // FIX 6: acquire the evaluate mutex for a single call per iteration, release,
            // sleep, re-acquire — so concurrent evaluate() calls can interleave during sleep.
            while(Date.now() < deadline) {
                const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
                // eslint-disable-next-line no-await-in-loop -- polling loop intentionally sequential; mutex is released between iterations (FIX 6)
                const found = await adapter.evaluate<boolean>(expr);
                if(found) {
                    return;
                }
                // eslint-disable-next-line no-await-in-loop -- deliberate sequential polling with sleep; sleep releases event loop so concurrent evaluate calls can interleave
                await delay(WAIT_FOR_SELECTOR_POLL_MS);
            }
            throw new BrowserError(`waitForSelector: element '${selector}' not found within timeout`);
        },

        getConsoleLogs(limit?: number): ConsoleLogEntry[] {
            // An omitted limit becomes NaN; slice(NaN) returns a full copy.
            return consoleLogs.slice(-Number(limit));
        },

        close(): void {
            // Null the shared reference first so even a throwing native close
            // leaves the adapter closed and a second close remains idempotent.
            const current = view;
            view = null;
            current?.close();
        },
    };

    return adapter;
}
