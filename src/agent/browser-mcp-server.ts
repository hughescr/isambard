/**
 * Browser MCP Server
 *
 * Exposes browser automation tools to the Claude agent via MCP.
 * URL safety is enforced by validateUrl() from host-guard before any navigation.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { validateUrl, type BrowserAdapter, type BrowserHostPolicy } from './browser';
import { mcpErrorResult, mcpJsonResult, mcpTextResult } from './mcp-helpers';

// ============================================================================
// Deps
// ============================================================================

export interface BrowserMCPServerDeps {
    adapter:            BrowserAdapter
    policy:             BrowserHostPolicy
    maxScreenshotBytes: number
    maxTextBytes:       number
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes, cutting at a valid
 * codepoint boundary. If the requested cut falls mid-codepoint, walks backwards
 * to the previous valid start byte to avoid emitting a U+FFFD replacement char.
 * The truncation marker suffix is appended unconditionally when truncation occurs.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, 'utf8');
    if(buf.length <= maxBytes) {
        return text;
    }
    // Walk backwards while buf[cutPos] is a UTF-8 continuation byte (10xxxxxx).
    // buf[cutPos] is the byte we'd be DROPPING — if it's a continuation,
    // we're mid-sequence and need to back up to find the start byte.
    let cutPos = maxBytes;
    // Buffer.from(string) starts at a valid UTF-8 byte, so the walk stops at
    // index zero without a separate bound check. An absent index also stops it.
    // Stryker disable NumberLiteralValue,llm: the `?? 0` fallback only fires when cutPos leaves the buffer (negative or non-integer maxBytes), and 0, 1 and -1 all fail `& 0xC0 === 0x80` identically, so the loop exits at the same cutPos
    // eslint-disable-next-line no-bitwise -- bit-masking idiom for UTF-8 continuation byte detection
    while(((buf[cutPos] ?? 0) & 0xC0) === 0x80) {
        cutPos--;
    }
    // Stryker restore NumberLiteralValue,llm
    const bytesSaved = buf.length - cutPos;
    return `${buf.subarray(0, cutPos).toString('utf8')}[truncated — ${bytesSaved} bytes omitted]`;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an MCP server providing browser automation tools.
 *
 * All navigate calls are validated through validateUrl() before reaching the adapter.
 * Screenshot size and text content size are bounded by the provided limits.
 */
export function createBrowserMCPServer(deps: BrowserMCPServerDeps) {
    const { adapter, policy, maxScreenshotBytes, maxTextBytes } = deps;

    /**
     * Wraps an adapter call that returns void into a tool handler that
     * returns the current browser state snapshot on success or an MCP error on failure.
     */
    function stateSnapshotHandler<T>(fn: (args: T) => Promise<void>): (args: T) => Promise<CallToolResult> {
        return async (args: T): Promise<CallToolResult> => {
            try {
                await fn(args);
                return mcpJsonResult({ url: adapter.url, title: adapter.title, loading: adapter.loading });
            } catch (error) {
                return mcpErrorResult(error);
            }
        };
    }

    return createSdkMcpServer({
        name:    'browser',
        version: '1.0.0',
        tools:   [
            tool(
                'navigate',
                'Navigate the browser to a URL. Validates the URL against the security policy before loading.',
                { url: z.string().describe('The URL to navigate to (must be http or https)') },
                async ({ url }): Promise<CallToolResult> => {
                    const validated = validateUrl(url, policy);
                    if(!validated.ok) {
                        return mcpErrorResult(new Error(validated.reason));
                    }
                    try {
                        await adapter.navigate(url);
                        return mcpJsonResult({ url: adapter.url, title: adapter.title, loading: adapter.loading });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Navigate', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'reload',
                'Reload the current page.',
                {},
                stateSnapshotHandler(async () => adapter.reload()),
                { annotations: { title: 'Reload', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'goBack',
                'Navigate back in the browser history.',
                {},
                stateSnapshotHandler(async () => adapter.goBack()),
                { annotations: { title: 'Go Back', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'goForward',
                'Navigate forward in the browser history.',
                {},
                stateSnapshotHandler(async () => adapter.goForward()),
                { annotations: { title: 'Go Forward', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'getState',
                'Get current browser state: url, title, loading flag, and isClosed flag. isClosed: true means there is no active browser session — call navigate to open one. This is true both before any navigation and after closeBrowser.',
                {},
                async (): Promise<CallToolResult> => {
                    return mcpJsonResult({
                        url:      adapter.url,
                        title:    adapter.title,
                        loading:  adapter.loading,
                        isClosed: adapter.isClosed,
                    });
                },
                { annotations: { title: 'Get State', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getBodyText',
                'Get the text content of the page body. Truncated to maxTextBytes if too large.',
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        const text = await adapter.evaluate<string>(
                            'document.getElementsByTagName("body")[0].textContent'
                        );
                        return mcpTextResult(truncateToBytes(String(text), maxTextBytes));
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Get Body Text', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getFullHTML',
                'Get the full outer HTML of the page. Truncated to maxTextBytes if too large.',
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        const html = await adapter.evaluate<string>(
                            'document.documentElement.outerHTML'
                        );
                        return mcpTextResult(truncateToBytes(String(html), maxTextBytes));
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Get Full HTML', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getLinks',
                'Get links on the page as an array of {href, text} objects. Use containerSelector to scope to a specific section.',
                {
                    // Defaulted in the handler's destructuring: the Agent SDK's bundled-zod validator rejects an omitted zod `.default()` field.
                    containerSelector: z.string().optional().describe('CSS selector of container element to scope link search (default: body)'),
                },
                async ({ containerSelector = 'body' }): Promise<CallToolResult> => {
                    try {
                        const expr = `Array.from(document.querySelectorAll(${JSON.stringify(containerSelector)} + ' a[href]')).map(a => ({ href: a.href, text: (a.textContent || '').trim() })).slice(0, 500)`;
                        const links = await adapter.evaluate<{ href: string, text: string }[]>(expr);
                        return mcpJsonResult(links);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Get Links', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'click',
                'Click an element by CSS selector.',
                {
                    selector:   z.string().describe('CSS selector of the element to click'),
                    timeout:    z.number().optional().describe('Timeout in milliseconds to wait for element'),
                    button:     z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to use'),
                    modifiers:  z.array(z.string()).optional().describe('Keyboard modifiers: e.g. ["Shift"], ["Control"], ["Alt"], ["Meta"]'),
                    clickCount: z.number().int().min(1).max(3).optional().describe('Click count: 1 for single, 2 for double, 3 for triple'),
                },
                stateSnapshotHandler(async ({ selector, timeout, button, modifiers, clickCount }) => {
                    const opts = { timeout, button, modifiers, clickCount };
                    await adapter.click(selector, opts);
                }),
                { annotations: { title: 'Click', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'type',
                'Type text into the focused element.',
                { text: z.string().describe('The text to type') },
                stateSnapshotHandler(async ({ text }) => adapter.type(text)),
                { annotations: { title: 'Type', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'press',
                'Press a keyboard key, optionally with modifier keys.',
                {
                    key:       z.string().describe('Key name (e.g. "Enter", "Tab", "ArrowDown")'),
                    modifiers: z.array(z.string()).optional().describe('Modifier keys (e.g. ["Shift", "Control"])'),
                },
                stateSnapshotHandler(async ({ key, modifiers }) => adapter.press(key, modifiers === undefined ? undefined : { modifiers })),
                { annotations: { title: 'Press Key', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'scrollBy',
                'Scroll the page by a pixel offset.',
                {
                    dx: z.number().describe('Horizontal scroll amount in pixels'),
                    dy: z.number().describe('Vertical scroll amount in pixels'),
                },
                stateSnapshotHandler(async ({ dx, dy }) => adapter.scroll(dx, dy)),
                { annotations: { title: 'Scroll By', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'scrollTo',
                'Scroll to bring a CSS selector element into view.',
                {
                    selector: z.string().describe('CSS selector of the element to scroll to'),
                    block:    z.enum(['start', 'center', 'end']).optional().describe('Vertical alignment of the element'),
                    timeout:  z.number().optional().describe('Timeout in milliseconds'),
                },
                stateSnapshotHandler(async ({ selector, block, timeout }) => {
                    await adapter.scrollTo(selector, { block, timeout });
                }),
                { annotations: { title: 'Scroll To', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'screenshot',
                'Capture a screenshot of the current page. Returns a base64-encoded image.',
                {
                    format:  z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
                    quality: z.number().min(0).max(100).optional().describe('JPEG quality 0-100'),
                },
                async ({ format, quality }): Promise<CallToolResult> => {
                    try {
                        const opts: { format?: 'png' | 'jpeg', quality?: number } = {};
                        if(format !== undefined) {
                            // Stryker disable next-line llm: the !== undefined guard plus z.enum(['png','jpeg']) narrow format to two truthy strings, so `|| 'png'` can never change it.
                            opts.format = format;
                        }
                        if(quality !== undefined) {
                            opts.quality = quality;
                        }
                        // Adapter returns Buffer (zero-copy from WebKit). Check byteLength BEFORE
                        // base64 conversion — avoids materialising a large string only to discard it.
                        const buf = await adapter.screenshot(opts);
                        if(buf.byteLength > maxScreenshotBytes) {
                            return mcpErrorResult(new Error(`Screenshot too large (${buf.byteLength} bytes, limit ${maxScreenshotBytes})`));
                        }
                        const data = buf.toString('base64');
                        return {
                            isError: false,
                            content: [{ type: 'image', data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }],
                        };
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Screenshot', readOnlyHint: true, idempotentHint: false } }
            ),

            tool(
                'evaluate',
                'Evaluate a JavaScript expression in the browser context and return the JSON-serialised result. Must be an expression, not a statement sequence — for multi-statement code, wrap in an IIFE. Example: `(() => { const t = document.title; return t.toUpperCase(); })()`. Prefer the structured tools (getBodyText, getLinks, click, etc.) first when they fit the task.',
                { expression: z.string().describe('JavaScript expression to evaluate') },
                async ({ expression }): Promise<CallToolResult> => {
                    try {
                        const result = await adapter.evaluate(expression);
                        return mcpJsonResult(result);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Evaluate JavaScript', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'resize',
                'Resize the browser viewport.',
                {
                    width:  z.number().int().positive().describe('New viewport width in pixels'),
                    height: z.number().int().positive().describe('New viewport height in pixels'),
                },
                async ({ width, height }): Promise<CallToolResult> => {
                    try {
                        adapter.resize(width, height);
                        return mcpJsonResult({ width, height });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Resize', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'waitForSelector',
                'Wait until a CSS selector element appears on the page, polling every 50 ms.',
                {
                    selector: z.string().describe('CSS selector to wait for'),
                    timeout:  z.number().optional().describe('Timeout in milliseconds'),
                },
                async ({ selector, timeout }): Promise<CallToolResult> => {
                    try {
                        await adapter.waitForSelector(selector, timeout);
                        return mcpJsonResult({ selector, found: true });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                { annotations: { title: 'Wait For Selector', readOnlyHint: true, idempotentHint: false } }
            ),

            tool(
                'getConsoleLogs',
                'Get captured browser console log entries.',
                { limit: z.number().int().positive().optional().describe('Maximum number of entries to return (most recent)') },
                async ({ limit }): Promise<CallToolResult> => {
                    const entries = adapter.getConsoleLogs(limit);
                    return mcpJsonResult(entries);
                },
                { annotations: { title: 'Get Console Logs', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'closeBrowser',
                'Reset the browser session — closes the current WebView. Persistent cookies and login state on disk survive; the next tool call will lazy-reinit a fresh view. Use this when a page is in a stuck state (stuck modal, corrupted session, bot challenge loop) and you want a clean slate without losing disk-persisted credentials.',
                {},
                async (): Promise<CallToolResult> => {
                    adapter.close();
                    return mcpTextResult('Browser closed.');
                },
                { annotations: { title: 'Close Browser', readOnlyHint: false, idempotentHint: true } }
            ),
        ],
    });
}
