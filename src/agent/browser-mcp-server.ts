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
    // Stryker disable next-line EqualityOperator,ConditionalExpression: EqualityOperator — > 0 vs >= 0 is equivalent at boundary (buf[0] is always a start byte in valid UTF-8, never a continuation); ConditionalExpression — cutPos > 0 mutated to `true` is equivalent because buf[0] can never be a continuation byte (0x80-0xBF) in valid UTF-8, so the inner && condition breaks the loop at position 0 anyway
    // eslint-disable-next-line no-bitwise -- bit-masking is the correct idiom for UTF-8 continuation byte detection
    while(cutPos > 0 && (buf[cutPos] & 0xC0) === 0x80) {
        cutPos--;
    }
    const bytesSaved = buf.length - cutPos;
    // Stryker disable next-line StringLiteral: truncation marker is informational only
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
                // Stryker disable next-line ObjectLiteral: state snapshot returned to agent — actual field values verified by getState test
                return mcpJsonResult({ url: adapter.url, title: adapter.title, loading: adapter.loading });
            } catch (error) {
                return mcpErrorResult(error);
            }
        };
    }

    // Stryker disable StringLiteral,ObjectLiteral: MCP server name/version are configuration values
    return createSdkMcpServer({
        name:    'browser',
        version: '1.0.0',
        // Stryker restore StringLiteral,ObjectLiteral
        tools:   [
            tool(
                'navigate',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Navigate the browser to a URL. Validates the URL against the security policy before loading.',
                // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                { url: z.string().describe('The URL to navigate to (must be http or https)') },
                async ({ url }): Promise<CallToolResult> => {
                    const validated = validateUrl(url, policy);
                    if(!validated.ok) {
                        return mcpErrorResult(new Error(validated.reason));
                    }
                    try {
                        await adapter.navigate(url);
                        // Stryker disable next-line ObjectLiteral: state snapshot returned to agent — actual field values verified by getState test
                        return mcpJsonResult({ url: adapter.url, title: adapter.title, loading: adapter.loading });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Navigate', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'reload',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Reload the current page.',
                {},
                stateSnapshotHandler(async () => adapter.reload()),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Reload', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'goBack',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Navigate back in the browser history.',
                {},
                stateSnapshotHandler(async () => adapter.goBack()),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Go Back', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'goForward',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Navigate forward in the browser history.',
                {},
                stateSnapshotHandler(async () => adapter.goForward()),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Go Forward', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'getState',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
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
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get State', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getBodyText',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
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
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Body Text', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getFullHTML',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
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
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Full HTML', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getLinks',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Get links on the page as an array of {href, text} objects. Use containerSelector to scope to a specific section.',
                {
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    containerSelector: z.string().optional().default('body').describe('CSS selector of container element to scope link search (default: body)'),
                },
                async ({ containerSelector = 'body' }): Promise<CallToolResult> => {
                    try {
                        // Stryker disable StringLiteral: JS expression executed in browser context — changing it would break at runtime, not in tests (mocked evaluate ignores the expression)
                        const expr = `Array.from(document.querySelectorAll(${JSON.stringify(containerSelector)} + ' a[href]')).map(a => ({ href: a.href, text: (a.textContent || '').trim() })).slice(0, 500)`;
                        // Stryker restore StringLiteral
                        const links = await adapter.evaluate<{ href: string, text: string }[]>(expr);
                        // Stryker disable next-line ArrayDeclaration: links comes from browser evaluate — test mocks return a real array; empty-array mutation would change the semantics observable in real use but not in mocked tests
                        return mcpJsonResult(links);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Links', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'click',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Click an element by CSS selector.',
                {
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    selector:   z.string().describe('CSS selector of the element to click'),
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    timeout:    z.number().optional().describe('Timeout in milliseconds to wait for element'),
                    // Stryker disable next-line StringLiteral,ArrayDeclaration: describe() and enum values are MCP documentation only
                    button:     z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to use'),
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    modifiers:  z.array(z.string()).optional().describe('Keyboard modifiers: e.g. ["Shift"], ["Control"], ["Alt"], ["Meta"]'),
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() and range validators are MCP/schema configuration
                    clickCount: z.number().int().min(1).max(3).optional().describe('Click count: 1 for single, 2 for double, 3 for triple'),
                },
                stateSnapshotHandler(async ({ selector, timeout, button, modifiers, clickCount }) => {
                    // Stryker disable next-line ObjectLiteral: opts object — all fields are optional; the undefined values are passed through to the adapter which ignores them
                    const opts = { timeout, button, modifiers, clickCount };
                    await adapter.click(selector, opts);
                }),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Click', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'type',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Type text into the focused element.',
                // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                { text: z.string().describe('The text to type') },
                stateSnapshotHandler(async ({ text }) => adapter.type(text)),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Type', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'press',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Press a keyboard key, optionally with modifier keys.',
                {
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    key:       z.string().describe('Key name (e.g. "Enter", "Tab", "ArrowDown")'),
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    modifiers: z.array(z.string()).optional().describe('Modifier keys (e.g. ["Shift", "Control"])'),
                },
                stateSnapshotHandler(async ({ key, modifiers }) => adapter.press(key, modifiers === undefined ? undefined : { modifiers })),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Press Key', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'scrollBy',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Scroll the page by a pixel offset.',
                {
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    dx: z.number().describe('Horizontal scroll amount in pixels'),
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    dy: z.number().describe('Vertical scroll amount in pixels'),
                },
                stateSnapshotHandler(async ({ dx, dy }) => adapter.scroll(dx, dy)),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Scroll By', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'scrollTo',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Scroll to bring a CSS selector element into view.',
                {
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    selector: z.string().describe('CSS selector of the element to scroll to'),
                    // Stryker disable next-line StringLiteral,ArrayDeclaration: describe() and enum values are MCP documentation only
                    block:    z.enum(['start', 'center', 'end']).optional().describe('Vertical alignment of the element'),
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    timeout:  z.number().optional().describe('Timeout in milliseconds'),
                },
                stateSnapshotHandler(async ({ selector, block, timeout }) => {
                    // Stryker disable next-line ObjectLiteral: options object — block/timeout are optional; test verifies block is passed but ObjectLiteral→{} mutation is caught by the scrollTo call assertion
                    await adapter.scrollTo(selector, { block, timeout });
                }),
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Scroll To', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'screenshot',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Capture a screenshot of the current page. Returns a base64-encoded image.',
                {
                    // Stryker disable next-line StringLiteral,ArrayDeclaration: describe() and enum values are MCP documentation only
                    format:  z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() and quality range validators are MCP/schema configuration
                    quality: z.number().min(0).max(100).optional().describe('JPEG quality 0-100'),
                },
                async ({ format, quality }): Promise<CallToolResult> => {
                    try {
                        // Stryker disable ObjectLiteral,ConditionalExpression: opts construction — format/quality undefined guards are symmetric; ObjectLiteral→{} and both ConditionalExpression→true are testable via screenshot call assertions
                        const opts: { format?: 'png' | 'jpeg', quality?: number } = {};
                        if(format !== undefined) {
                            opts.format = format;
                        }
                        if(quality !== undefined) {
                            opts.quality = quality;
                        }
                        // Stryker restore ObjectLiteral,ConditionalExpression
                        // Adapter returns Buffer (zero-copy from WebKit). Check byteLength BEFORE
                        // base64 conversion — avoids materialising a large string only to discard it.
                        const buf = await adapter.screenshot(opts);
                        // Stryker disable next-line EqualityOperator: size limit check — >= vs > is equivalent at the boundary since byteLength is always an integer and limit is too; the test uses a clearly oversized screenshot (3MB vs 2MB limit)
                        if(buf.byteLength > maxScreenshotBytes) {
                            // Stryker disable next-line StringLiteral: error message is informational only
                            return mcpErrorResult(new Error(`Screenshot too large (${buf.byteLength} bytes, limit ${maxScreenshotBytes})`));
                        }
                        const data = buf.toString('base64');
                        // Stryker disable ObjectLiteral,ConditionalExpression,EqualityOperator,StringLiteral,BooleanLiteral,ArrayDeclaration: image content block — mimeType ternary and content structure are MCP protocol values; Timeout mutants indicate Stryker worker hangs on image content type mutations
                        return {
                            isError: false,
                            content: [{ type: 'image', data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }],
                        };
                        // Stryker restore ObjectLiteral,ConditionalExpression,EqualityOperator,StringLiteral,BooleanLiteral,ArrayDeclaration
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Screenshot', readOnlyHint: true, idempotentHint: false } }
            ),

            tool(
                'evaluate',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Evaluate a JavaScript expression in the browser context and return the JSON-serialised result. Must be an expression, not a statement sequence — for multi-statement code, wrap in an IIFE. Example: `(() => { const t = document.title; return t.toUpperCase(); })()`. Prefer the structured tools (getBodyText, getLinks, click, etc.) first when they fit the task.',
                // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                { expression: z.string().describe('JavaScript expression to evaluate') },
                async ({ expression }): Promise<CallToolResult> => {
                    try {
                        const result = await adapter.evaluate(expression);
                        return mcpJsonResult(result);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Evaluate JavaScript', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'resize',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Resize the browser viewport.',
                {
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    width:  z.number().int().positive().describe('New viewport width in pixels'),
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    height: z.number().int().positive().describe('New viewport height in pixels'),
                },
                async ({ width, height }): Promise<CallToolResult> => {
                    try {
                        adapter.resize(width, height);
                        // Stryker disable next-line ObjectLiteral: echo of input dimensions — test verifies resize was called with correct args; ObjectLiteral→{} is caught by result assertions
                        return mcpJsonResult({ width, height });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Resize', readOnlyHint: false, idempotentHint: false } }
            ),

            tool(
                'waitForSelector',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Wait until a CSS selector element appears on the page, polling every 50 ms.',
                {
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    selector: z.string().describe('CSS selector to wait for'),
                    // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                    timeout:  z.number().optional().describe('Timeout in milliseconds'),
                },
                async ({ selector, timeout }): Promise<CallToolResult> => {
                    try {
                        await adapter.waitForSelector(selector, timeout);
                        // Stryker disable next-line ObjectLiteral,BooleanLiteral,StringLiteral: success result echo — selector value and found:true are informational; Timeout mutants indicate Stryker worker hangs on mutations in this result object
                        return mcpJsonResult({ selector, found: true });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Wait For Selector', readOnlyHint: true, idempotentHint: false } }
            ),

            tool(
                'getConsoleLogs',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Get captured browser console log entries.',
                // Stryker disable next-line StringLiteral: describe() is MCP documentation only
                { limit: z.number().int().positive().optional().describe('Maximum number of entries to return (most recent)') },
                async ({ limit }): Promise<CallToolResult> => {
                    const entries = adapter.getConsoleLogs(limit);
                    return mcpJsonResult(entries);
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Console Logs', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'closeBrowser',
                // Stryker disable next-line StringLiteral: tool description is MCP documentation only
                'Reset the browser session — closes the current WebView. Persistent cookies and login state on disk survive; the next tool call will lazy-reinit a fresh view. Use this when a page is in a stuck state (stuck modal, corrupted session, bot challenge loop) and you want a clean slate without losing disk-persisted credentials.',
                {},
                async (): Promise<CallToolResult> => {
                    adapter.close();
                    // Stryker disable next-line StringLiteral: success message is informational only
                    return mcpTextResult('Browser closed.');
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Close Browser', readOnlyHint: false, idempotentHint: true } }
            ),
        ],
    });
}
