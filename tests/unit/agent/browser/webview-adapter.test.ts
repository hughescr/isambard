// Tests for createWebViewAdapter — fake Bun.WebView injected via factory parameter
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { type WebViewAdapterConfig, createWebViewAdapter } from '../../../../src/agent/browser/webview-adapter';
import { BrowserNavigateTimeoutError } from '../../../../src/errors/browser';

// ---------------------------------------------------------------------------
// Fake Bun.WebView
// ---------------------------------------------------------------------------

interface FakeWebViewOptions {
    width:      number
    height:     number
    backend?:   string | { type: string, path?: string }
    headless?:  boolean
    console?:   (type: string, ...args: unknown[]) => void
    dataStore?: { directory: string }
}

class FakeWebView {
    readonly constructorOptions: FakeWebViewOptions;

    private _url     = '';
    private _title   = '';
    private _loading = false;
    private _closed  = false;

    // Test helpers to set state
    setLoading(v: boolean): void { this._loading = v; }

    // Spy-able methods
    navigate   = mock(async (_url: string): Promise<void> => {
        this._url     = _url;
        this._loading = false;
    });

    reload = mock(async (): Promise<void> => {});

    goBack = mock(async (): Promise<void> => {});

    goForward = mock(async (): Promise<void> => {});

    evaluate = mock(async (expr: string): Promise<unknown> => expr); // returns expression string by default

    click = mock(async (..._args: unknown[]): Promise<void> => {});

    type = mock(async (_text: string): Promise<void> => {});

    press = mock(async (_key: string, _opts?: unknown): Promise<void> => {});

    scroll = mock(async (_dx: number, _dy: number): Promise<void> => {});

    scrollTo = mock(async (_sel: string, _opts?: unknown): Promise<void> => {});

    // Returns a Buffer to match the real Bun.WebView { encoding: 'buffer' } call
    screenshot = mock(async (_opts?: unknown): Promise<Buffer> => Buffer.from('fake-image-data'));

    resize = mock((_w: number, _h: number): void => {});

    close = mock((): void => { this._closed = true; });

    get url()     { return this._closed ? '' : this._url; }

    get title()   { return this._closed ? '' : this._title; }

    get loading() { return this._closed ? false : this._loading; }

    constructor(opts: FakeWebViewOptions) {
        this.constructorOptions = opts;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake delay that resolves immediately — for tests that don't exercise timeout logic. */
const immediateDelay = async (_ms: number): Promise<void> => {};

/**
 * A controllable delay seam.
 * Each call to fakeDelay(ms) enqueues a { ms, resolve } entry in delayCalls.
 * Test code can manually resolve entries to simulate timer firing.
 */
interface DelayCall { ms: number, resolve: () => void }
function makeControllableDelay() {
    const delayCalls: DelayCall[] = [];
    const fakeDelay = (ms: number): Promise<void> => new Promise<void>((resolve) => {
        delayCalls.push({ ms, resolve });
    });
    return { delayCalls, fakeDelay };
}

// WebViewAdapterConfig no longer includes maxScreenshotBytes/maxTextBytes
const defaultConfig: WebViewAdapterConfig = {
    backend:             'webkit',
    viewportWidth:       1280,
    viewportHeight:      800,
    navigationTimeoutMs: 30_000,
    actionTimeoutMs:     10_000,
};

let fakeView: FakeWebView;

function makeFactory() {
    return mock((opts: FakeWebViewOptions): FakeWebView => {
        fakeView = new FakeWebView(opts);
        return fakeView;
    });
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — lazy init', () => {
    test('does not construct FakeWebView until first method call', () => {
        const factory = makeFactory();
        createWebViewAdapter(defaultConfig, factory, immediateDelay);
        expect(factory).not.toHaveBeenCalled();
    });

    test('constructs FakeWebView on first navigate call', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        expect(factory).toHaveBeenCalledTimes(1);
    });

    test('reuses existing FakeWebView on subsequent calls', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.navigate('https://example.com/2');
        expect(factory).toHaveBeenCalledTimes(1);
    });

    test('triggers lazy-init on evaluate call', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.evaluate('1 + 1');
        expect(factory).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Constructor options mapping
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — constructor mapping', () => {
    test('passes width and height from config', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, viewportWidth: 1920, viewportHeight: 1080 },
            factory,
            immediateDelay
        );
        await adapter.navigate('https://example.com');
        expect(fakeView.constructorOptions.width).toBe(1920);
        expect(fakeView.constructorOptions.height).toBe(1080);
    });

    test('passes webkit backend when config.backend is webkit', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, backend: 'webkit' },
            factory,
            immediateDelay
        );
        await adapter.navigate('https://example.com');
        expect(fakeView.constructorOptions.backend).toBe('webkit');
    });

    test('passes dataStore when dataStorePath is provided', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, dataStorePath: '/tmp/test-profile' },
            factory,
            immediateDelay
        );
        await adapter.navigate('https://example.com');
        expect(fakeView.constructorOptions.dataStore).toEqual({ directory: '/tmp/test-profile' });
    });

    test('omits dataStore when dataStorePath is not provided', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        expect(fakeView.constructorOptions.dataStore).toBeUndefined();
    });

    test('wires console callback when constructing', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        expect(typeof fakeView.constructorOptions.console).toBe('function');
    });

    test('omits backend when config.backend is auto', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, backend: 'auto' },
            factory,
            immediateDelay
        );
        await adapter.navigate('https://example.com');
        expect(fakeView.constructorOptions.backend).toBeUndefined();
    });

    test('passes chrome string backend when config.backend is chrome and no chromePath', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, backend: 'chrome' },
            factory,
            immediateDelay
        );
        await adapter.navigate('https://example.com');
        expect(fakeView.constructorOptions.backend).toBe('chrome');
    });

    test('passes chrome object backend when config.backend is chrome and chromePath is set', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, backend: 'chrome', chromePath: '/usr/bin/chromium' },
            factory,
            immediateDelay
        );
        await adapter.navigate('https://example.com');
        expect(fakeView.constructorOptions.backend).toEqual({ type: 'chrome', path: '/usr/bin/chromium' });
    });
});

// ---------------------------------------------------------------------------
// State getters — before init
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — state getters before init', () => {
    test('url returns empty string before any call', () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        expect(adapter.url).toBe('');
    });

    test('title returns empty string before any call', () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        expect(adapter.title).toBe('');
    });

    test('loading returns false before any call', () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        expect(adapter.loading).toBe(false);
    });

    test('isClosed returns true before any call (view is null, never inited)', () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        // view === null before first method call, so isClosed === true
        expect(adapter.isClosed).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// State getters — after init
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — state getters after init', () => {
    test('url delegates to underlying view after init', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        expect(adapter.url).toBe('https://example.com');
    });

    test('loading delegates to underlying view after init', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        // FakeWebView.navigate sets loading = false after navigate
        expect(adapter.loading).toBe(false);
    });

    test('loading returns true when view is loading', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        fakeView.setLoading(true);
        expect(adapter.loading).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// close() — idempotency and isClosed
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — close', () => {
    test('isClosed flips to true after close()', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        adapter.close();
        expect(adapter.isClosed).toBe(true);
    });

    test('close() is idempotent — calling twice does not throw', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        adapter.close();
        expect(() => adapter.close()).not.toThrow();
    });

    test('close() without init does not throw', () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        expect(() => adapter.close()).not.toThrow();
        expect(adapter.isClosed).toBe(true);
    });

    test('url returns empty string after close()', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        adapter.close();
        expect(adapter.url).toBe('');
    });

    test('title returns empty string after close()', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        adapter.close();
        expect(adapter.title).toBe('');
    });

    test('loading returns false after close()', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        adapter.close();
        expect(adapter.loading).toBe(false);
    });

    test('navigate after close re-inits a new view', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        adapter.close();
        await adapter.navigate('https://example.com/2');
        expect(factory).toHaveBeenCalledTimes(2);
        expect(adapter.isClosed).toBe(false);
    });

    test('close() calls view.close() on the underlying view', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const closeSpy = spyOn(fakeView, 'close');
        adapter.close();
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    test('close() calls view.close() exactly once even when called twice', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const closeSpy = spyOn(fakeView, 'close');
        adapter.close();
        adapter.close();
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Platform precheck
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — platform precheck', () => {
    let originalPlatform: string;

    beforeEach(() => {
        originalPlatform = process.platform;
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    });

    test('throws on non-darwin when backend is webkit', () => {
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, backend: 'webkit' },
            factory,
            immediateDelay
        );
        expect(adapter.navigate('https://example.com')).rejects.toThrow(/macOS/i);
    });

    test('does not throw on darwin when backend is webkit', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, backend: 'webkit' },
            factory,
            immediateDelay
        );
        expect(adapter.navigate('https://example.com')).resolves.toBeUndefined();
    });

    test('does not throw on non-darwin when backend is chrome', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
        const factory = makeFactory();
        const adapter = createWebViewAdapter(
            { ...defaultConfig, backend: 'chrome' },
            factory,
            immediateDelay
        );
        expect(adapter.navigate('https://example.com')).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Evaluate mutex — serializes concurrent calls
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — evaluate mutex', () => {
    test('two concurrent evaluate() calls resolve in order without throwing', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);

        await adapter.evaluate('1'); // trigger init so fakeView is set

        let firstResolve!: () => void;
        const firstDone = new Promise<void>((resolve) => {
            firstResolve = resolve;
        });

        // Swap out evaluate to be async and controllable
        fakeView.evaluate = mock(async (expr: string): Promise<unknown> => {
            if(expr === 'slow') {
                await firstDone;
            }
            return expr;
        });

        const p1 = adapter.evaluate('slow');
        const p2 = adapter.evaluate('fast');

        firstResolve();
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe('slow');
        expect(r2).toBe('fast');
    });
});

// ---------------------------------------------------------------------------
// scroll — NaN/Infinity pre-validation
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — scroll validation', () => {
    test('scroll(NaN, 0) rejects before touching the view', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const scrollSpy = spyOn(fakeView, 'scroll');
        expect(adapter.scroll(Number.NaN, 0)).rejects.toThrow(/finite/i);
        expect(scrollSpy).not.toHaveBeenCalled();
    });

    test('scroll(0, Infinity) rejects before touching the view', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const scrollSpy = spyOn(fakeView, 'scroll');
        expect(adapter.scroll(0, Infinity)).rejects.toThrow(/finite/i);
        expect(scrollSpy).not.toHaveBeenCalled();
    });

    test('scroll(-Infinity, 0) rejects before touching the view', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const scrollSpy = spyOn(fakeView, 'scroll');
        expect(adapter.scroll(-Infinity, 0)).rejects.toThrow(/finite/i);
        expect(scrollSpy).not.toHaveBeenCalled();
    });

    test('scroll(0, 0) does not reject', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        expect(adapter.scroll(0, 0)).resolves.toBeUndefined();
    });

    test('scroll(-100, 200) does not reject', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        expect(adapter.scroll(-100, 200)).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Navigation delegation
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — navigation delegation', () => {
    test('navigate delegates to view.navigate', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        expect(fakeView.navigate).toHaveBeenCalledWith('https://example.com');
    });

    test('reload delegates to view.reload', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.reload();
        expect(fakeView.reload).toHaveBeenCalled();
    });

    test('goBack delegates to view.goBack', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.goBack();
        expect(fakeView.goBack).toHaveBeenCalled();
    });

    test('goForward delegates to view.goForward', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.goForward();
        expect(fakeView.goForward).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Navigate timeout recovery — uses injected delay DI seam (no real timers)
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — navigate timeout recovery', () => {
    // Use immediateDelay so the timeout fires right away without real wall-clock waits.
    // Navigate/reload must be hanging (never resolve) for the timeout to win the race.
    const timeoutConfig: WebViewAdapterConfig = { ...defaultConfig, navigationTimeoutMs: 30_000 };

    test('navigate resolves immediately when view.navigate completes before timeout', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        // Default fakeView.navigate resolves immediately — wins the race over immediateDelay
        await adapter.navigate('https://example.com');
        expect(fakeView.navigate).toHaveBeenCalledWith('https://example.com');
        expect(fakeView.reload).not.toHaveBeenCalled();
    });

    test('navigate calls reload() after first timeout — immediateDelay fires, navigate hangs', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init'); // trigger init

        // navigate hangs forever so immediateDelay wins — timeout fires
        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        // First reload resolves immediately (stops escalation after one timeout)
        let reloadCallCount = 0;
        fakeView.reload = mock(async (): Promise<void> => {
            reloadCallCount++;
            if(reloadCallCount > 1) {
                return new Promise(() => {}); // hang subsequent reloads
            }
        });

        await adapter.navigate('https://example.com');
        expect(fakeView.reload).toHaveBeenCalledTimes(1);
    });

    test('navigate calls reload() twice after second timeout', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init'); // trigger init

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        // First reload hangs (triggers second timeout), second reload resolves immediately
        let reloadCount = 0;
        fakeView.reload = mock(async (): Promise<void> => {
            reloadCount++;
            if(reloadCount === 1) {
                return new Promise(() => {}); // hang on first reload
            }
            // second reload resolves immediately (implicit undefined)
        });

        await adapter.navigate('https://example.com');
        expect(fakeView.reload).toHaveBeenCalledTimes(2);
    });

    test('navigate closes view and throws BrowserNavigateTimeoutError after three consecutive timeouts', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init'); // trigger init

        const closeSpy = spyOn(fakeView, 'close');

        // All three attempts hang forever — immediateDelay wins all races
        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        fakeView.reload = mock(async (): Promise<void> => new Promise(() => {}));

        // Await navigate to completion via try/catch — avoids no-confusing-void-expression
        let thrownErr: unknown;
        try {
            await adapter.navigate('https://example.com');
        } catch (err) {
            thrownErr = err;
        }
        expect(thrownErr).toBeInstanceOf(BrowserNavigateTimeoutError);
        expect(closeSpy).toHaveBeenCalledTimes(1);
        // Navigate once + exactly 2 reloads = 3 total attempts
        expect(fakeView.navigate).toHaveBeenCalledTimes(1);
        expect(fakeView.reload).toHaveBeenCalledTimes(2);
    });

    test('navigate throws BrowserNavigateTimeoutError with correct url and attempts=3', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init');

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        fakeView.reload = mock(async (): Promise<void> => new Promise(() => {}));

        let caughtErr: unknown;
        try {
            await adapter.navigate('https://example.com');
        } catch (err) {
            caughtErr = err;
        }
        expect(caughtErr).toBeInstanceOf(BrowserNavigateTimeoutError);
        const err = caughtErr as BrowserNavigateTimeoutError;
        expect(err.context.url).toBe('https://example.com');
        expect(err.context.attempts).toBe(3);
    });

    test('navigate: isClosed is true after timeout-close (view=null) so next call lazy-reinits', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init'); // trigger init

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        fakeView.reload = mock(async (): Promise<void> => new Promise(() => {}));

        // Await via catch to avoid no-confusing-void-expression
        await adapter.navigate('https://example.com').catch(() => {});

        // After timeout-close: view = null so isClosed === true (FIX 4 semantics)
        expect(adapter.isClosed).toBe(true);
    });

    test('navigate: view is lazily reinited on next call after timeout-close', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init'); // trigger init — factory called once

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        fakeView.reload = mock(async (): Promise<void> => new Promise(() => {}));

        // Await via catch to avoid no-confusing-void-expression
        await adapter.navigate('https://example.com').catch(() => {});

        // Reset mocks so next navigate succeeds
        fakeView.navigate = mock(async (): Promise<void> => {});
        // Perform another navigate — should trigger lazy reinit (factory called a second time)
        await adapter.navigate('https://example.com/2');
        expect(factory).toHaveBeenCalledTimes(2);
        expect(adapter.isClosed).toBe(false);
    });

    test('navigate: close() throws during timeout recovery — view=null still set, clean error thrown', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init');

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        fakeView.reload = mock(async (): Promise<void> => new Promise(() => {}));
        fakeView.close = mock((): void => {
            throw new Error('close failed');
        });

        // Should still throw BrowserNavigateTimeoutError, not the close error
        // Use try/catch to await completion without no-confusing-void-expression
        let closeTestErr: unknown;
        try {
            await adapter.navigate('https://example.com');
        } catch (err) {
            closeTestErr = err;
        }
        expect(closeTestErr).toBeInstanceOf(BrowserNavigateTimeoutError);
        // view = null was set despite close() throwing, so isClosed is true
        expect(adapter.isClosed).toBe(true);
    });

    test('navigate: reload() throws /pending/ error — falls back to close+reinit+navigate', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init'); // trigger init — factory called once

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        // reload() throws synchronously with a /pending/i message on first call
        // On the pending-slot fallback, the adapter closes view, reinits, and calls navigate.
        // The second fakeView created by makeFactory will have a real navigate that resolves.
        fakeView.reload = mock((): Promise<void> => {
            throw new Error('reload failed: pending operation in progress');
        });

        await adapter.navigate('https://example.com');

        // Factory should have been called twice: initial + reinit after pending-slot fallback
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test('navigate: reload() throws non-pending error — error propagates out of navigate', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init');

        // First navigate hangs so timeout fires and reload() is called
        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        // reload() throws a network error — NOT a /pending/ conflict
        fakeView.reload = mock((): Promise<void> => {
            throw new Error('network error');
        });

        let caughtErr: unknown;
        try {
            await adapter.navigate('https://example.com');
        } catch (err) {
            caughtErr = err;
        }
        // Non-pending errors should propagate as-is (not wrapped in BrowserNavigateTimeoutError)
        expect(caughtErr).toBeInstanceOf(Error);
        expect((caughtErr as Error).message).toContain('network error');
        // Factory was only called once — no reinit triggered
        expect(factory).toHaveBeenCalledTimes(1);
    });

    test('navigate: reload() throws non-Error plain string with pending — fallback fires on String(err) match', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init');

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        // Throw a plain string (not an Error instance) — exercises the String(err) branch
        // The string contains 'PENDING' which /pending/i should match.
        // We cast a string to Error to satisfy TypeScript's throw-type constraint while
        // still throwing a non-Error value at runtime. The adapter's `error instanceof Error`
        // check returns false and exercises the `String(err)` branch.
        fakeView.reload = mock((): Promise<void> => {
            const nonErrorThrow: unknown = 'PENDING navigation';
            throw nonErrorThrow as Error; // intentional: testing non-Error throw path in startAttempt
        });

        await adapter.navigate('https://example.com');

        // /pending/i matched via String(err) — fallback fired, factory called twice
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test('navigate: reload() throws uppercase PENDING error — case-insensitive regex still matches', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, immediateDelay);
        await adapter.evaluate('init');

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        // All-uppercase PENDING — should match /pending/i
        fakeView.reload = mock((): Promise<void> => {
            throw new Error('PENDING NAVIGATION ALREADY IN FLIGHT');
        });

        await adapter.navigate('https://example.com');

        // Case-insensitive match triggered fallback
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test('navigate: delay is called with navigationTimeoutMs on each attempt', async () => {
        const { delayCalls, fakeDelay } = makeControllableDelay();
        const factory = makeFactory();
        const adapter = createWebViewAdapter(timeoutConfig, factory, fakeDelay);
        // evaluate() doesn't use delay — resolves normally with fakeDelay
        await adapter.evaluate('init'); // trigger init

        fakeView.navigate = mock(async (): Promise<void> => new Promise(() => {}));
        fakeView.reload = mock(async (): Promise<void> => new Promise(() => {}));

        // Helper: drain enough microtask queues for Promise chains to settle
        const drainMicrotasks = async () => {
            for(let i = 0; i < 5; i++) {
                // eslint-disable-next-line no-await-in-loop -- deliberate sequential microtask draining
                await Promise.resolve();
            }
        };

        // Start navigate — it will hang waiting for first delay call
        const navigateP = adapter.navigate('https://example.com');
        await drainMicrotasks();

        // Verify first delay call is for navigationTimeoutMs
        expect(delayCalls).toHaveLength(1);
        expect(delayCalls[0]?.ms).toBe(timeoutConfig.navigationTimeoutMs);

        // Resolve first delay → attempt 1 times out, attempt 2 starts (reload + delay)
        delayCalls[0]?.resolve();
        await drainMicrotasks();

        expect(delayCalls).toHaveLength(2);
        expect(delayCalls[1]?.ms).toBe(timeoutConfig.navigationTimeoutMs);

        // Resolve second delay → attempt 2 times out, attempt 3 starts (reload + delay)
        delayCalls[1]?.resolve();
        await drainMicrotasks();

        expect(delayCalls).toHaveLength(3);
        expect(delayCalls[2]?.ms).toBe(timeoutConfig.navigationTimeoutMs);

        // Resolve third delay → attempt 3 times out → throws BrowserNavigateTimeoutError
        delayCalls[2]?.resolve();

        // Await via catch to avoid no-confusing-void-expression
        let delayTestErr: unknown;
        try {
            await navigateP;
        } catch (err) {
            delayTestErr = err;
        }
        expect(delayTestErr).toBeInstanceOf(BrowserNavigateTimeoutError);
    });
});

// ---------------------------------------------------------------------------
// Input delegation
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — input delegation', () => {
    test('click delegates to view.click', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.click('button', { timeout: 5000 });
        expect(fakeView.click).toHaveBeenCalledWith('button', { timeout: 5000 });
    });

    test('type delegates to view.type', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.type('hello world');
        expect(fakeView.type).toHaveBeenCalledWith('hello world');
    });

    test('press delegates to view.press', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.press('Enter', { modifiers: ['Shift'] });
        expect(fakeView.press).toHaveBeenCalledWith('Enter', { modifiers: ['Shift'] });
    });
});

// ---------------------------------------------------------------------------
// Screenshot delegation (FIX 13 — returns Buffer)
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — screenshot delegation', () => {
    test('screenshot delegates to view.screenshot with buffer encoding', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const result = await adapter.screenshot({ format: 'jpeg', quality: 80 });
        expect(fakeView.screenshot).toHaveBeenCalledWith({ format: 'jpeg', quality: 80, encoding: 'buffer' });
        expect(result).toBeInstanceOf(Buffer);
    });

    test('screenshot with no options passes only encoding', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const result = await adapter.screenshot();
        expect(fakeView.screenshot).toHaveBeenCalledWith({ encoding: 'buffer' });
        expect(result).toBeInstanceOf(Buffer);
    });
});

// ---------------------------------------------------------------------------
// resize delegation
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — resize delegation', () => {
    test('resize delegates to view.resize', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        adapter.resize(1920, 1080);
        expect(fakeView.resize).toHaveBeenCalledWith(1920, 1080);
    });
});

// ---------------------------------------------------------------------------
// scrollTo delegation
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — scrollTo delegation', () => {
    test('scrollTo delegates to view.scrollTo', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        await adapter.scrollTo('#footer', { block: 'start', timeout: 5000 });
        expect(fakeView.scrollTo).toHaveBeenCalledWith('#footer', { block: 'start', timeout: 5000 });
    });
});

// ---------------------------------------------------------------------------
// waitForSelector — polls via evaluate (FIX 6: mutex released between polls)
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — waitForSelector', () => {
    test('waitForSelector resolves when element is immediately present', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        fakeView.evaluate = mock(async (_expr: string): Promise<boolean> => true);
        expect(adapter.waitForSelector('button')).resolves.toBeUndefined();
        expect(fakeView.evaluate).toHaveBeenCalledWith('!!document.querySelector("button")');
    });

    test('waitForSelector rejects when element never appears within 1ms timeout', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        fakeView.evaluate = mock(async (_expr: string): Promise<null> => null);
        // timeout=1ms: evaluate returns null, deadline will be passed on next check
        expect(adapter.waitForSelector('button', 1)).rejects.toThrow(/timeout|not found/i);
    });

    test('waitForSelector releases mutex between polls — concurrent evaluate resolves within one poll', async () => {
        // immediateDelay makes poll sleep instant — test runs fast without real timers
        const shortPollConfig: WebViewAdapterConfig = { ...defaultConfig, actionTimeoutMs: 5000 };
        const factory = makeFactory();
        const adapter = createWebViewAdapter(shortPollConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');

        let pollCount = 0;
        // Evaluate returns false on first call (element absent), then true (element found)
        fakeView.evaluate = mock(async (_expr: string): Promise<boolean> => {
            pollCount++;
            return pollCount > 1;
        });

        // Launch waitForSelector
        const waitP = adapter.waitForSelector('button');

        // A concurrent evaluate call should complete within a short time — the mutex
        // must be released between polls (after each Bun.sleep), not held for the full duration.
        const concurrentResult = await adapter.evaluate<boolean>('document.title');
        expect(typeof concurrentResult).toBe('boolean'); // resolved without hanging (mutex was released between polls)

        await waitP; // waitForSelector should also complete
    });
});

// ---------------------------------------------------------------------------
// getConsoleLogs — ring buffer
// ---------------------------------------------------------------------------

describe('createWebViewAdapter — getConsoleLogs', () => {
    test('returns empty array before any console events', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const logs = adapter.getConsoleLogs();
        expect(logs).toEqual([]);
    });

    test('captures console events via the constructor callback', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');

        // Trigger the console callback that was wired to the fake view
        const consoleCb = fakeView.constructorOptions.console!;
        consoleCb('log', 'hello', 'world');

        const logs = adapter.getConsoleLogs();
        expect(logs).toHaveLength(1);
        expect(logs[0]?.type).toBe('log');
        expect(logs[0]?.args).toEqual(['hello', 'world']);
        expect(logs[0]?.at).toBeInstanceOf(Date);
    });

    test('limit parameter restricts number of returned entries', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const consoleCb = fakeView.constructorOptions.console!;
        consoleCb('log', '1');
        consoleCb('log', '2');
        consoleCb('log', '3');

        const logs = adapter.getConsoleLogs(2);
        expect(logs).toHaveLength(2);
    });

    test('limit equal to entry count returns all entries', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const consoleCb = fakeView.constructorOptions.console!;
        consoleCb('log', '1');
        consoleCb('log', '2');
        consoleCb('log', '3');
        // limit === entries.length should return all 3 (not slice)
        const logs = adapter.getConsoleLogs(3);
        expect(logs).toHaveLength(3);
    });

    test('limit greater than entry count returns all entries', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const consoleCb = fakeView.constructorOptions.console!;
        consoleCb('log', '1');
        consoleCb('log', '2');
        // limit=10 > 2 entries → return all 2
        const logs = adapter.getConsoleLogs(10);
        expect(logs).toHaveLength(2);
    });

    test('ring buffer caps at 200 entries', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);
        await adapter.navigate('https://example.com');
        const consoleCb = fakeView.constructorOptions.console!;
        for(let i = 0; i < 250; i++) {
            consoleCb('log', String(i));
        }
        const logs = adapter.getConsoleLogs();
        expect(logs.length).toBeLessThanOrEqual(200);
    });

    // FIX 8: console logs cleared on close + reinit
    test('getConsoleLogs returns empty array after close() and reinit — no stale entries', async () => {
        const factory = makeFactory();
        const adapter = createWebViewAdapter(defaultConfig, factory, immediateDelay);

        // First session: navigate, add console logs
        await adapter.navigate('https://example.com');
        const consoleCb = fakeView.constructorOptions.console!;
        consoleCb('log', 'from first session');
        expect(adapter.getConsoleLogs()).toHaveLength(1);

        // Close the adapter
        adapter.close();

        // Re-open via a new navigate (triggers lazy-reinit with a fresh FakeWebView)
        await adapter.navigate('https://example.com/2');

        // After reinit, console log buffer must be empty — no stale entries from before close
        expect(adapter.getConsoleLogs()).toEqual([]);
    });
});
