import { describe, expect, mock, test } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserAdapter, BrowserHostPolicy } from '../../../src/agent/browser/types';
import { createBrowserMCPServer, truncateToBytes } from '../../../src/agent/browser-mcp-server';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool> }

// ---------------------------------------------------------------------------
// Fake BrowserAdapter
// ---------------------------------------------------------------------------

function makeFakeAdapter(overrides: Partial<BrowserAdapter> = {}): BrowserAdapter {
    return {
        url:      'https://example.com',
        title:    'Example',
        loading:  false,
        isClosed: false,

        navigate:        mock(async (): Promise<void> => {}),
        reload:          mock(async (): Promise<void> => {}),
        goBack:          mock(async (): Promise<void> => {}),
        goForward:       mock(async (): Promise<void> => {}),
        waitForSelector: mock(async (): Promise<void> => {}),
        getConsoleLogs:  mock(() => []),
        evaluate:        mock(async (): Promise<unknown> => '') as BrowserAdapter['evaluate'],
        click:           mock(async (): Promise<void> => {}),
        type:            mock(async (): Promise<void> => {}),
        press:           mock(async (): Promise<void> => {}),
        scroll:          mock(async (): Promise<void> => {}),
        scrollTo:        mock(async (): Promise<void> => {}),
        // screenshot returns Buffer (FIX 13 — adapter no longer returns base64 string)
        screenshot:      mock(async (): Promise<Buffer> => Buffer.from('base64screenshot')),
        resize:          mock((): void => {}),
        close:           mock((): void => {}),
        ...overrides,
    };
}

const noPolicy: BrowserHostPolicy = {};
const policy2mb = { maxScreenshotBytes: 2_000_000, maxTextBytes: 100_000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callTool(
    server: ReturnType<typeof createBrowserMCPServer>,
    name: string,
    args: Record<string, unknown> = {}
) {
    const registeredTools: Partial<Record<string, RegisteredTool>> = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
    const tool = registeredTools[name];
    if(tool === undefined) {
        throw new Error(`Tool '${name}' not found`);
    }
    return tool.handler(args);
}

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------

describe('browserMcpServer — navigate', () => {
    test('navigate calls adapter.navigate and returns state', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'navigate', { url: 'https://example.com' });
        expect(adapter.navigate).toHaveBeenCalledWith('https://example.com');
        expect(result.isError).toBeFalsy();
    });

    test('navigate rejects blocked URLs before calling adapter', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'navigate', { url: 'http://127.0.0.1' });
        expect(adapter.navigate).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
    });

    test('navigate rejects non-http schemes', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'navigate', { url: 'file:///etc/passwd' });
        expect(adapter.navigate).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
    });

    test('navigate returns error when adapter.navigate throws', async () => {
        const adapter = makeFakeAdapter({
            navigate: mock(async (): Promise<void> => { throw new Error('NXDOMAIN'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'navigate', { url: 'https://example.com' });
        expect(result.isError).toBe(true);
    });

    test('navigate returns url/title/loading on success', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'navigate', { url: 'https://example.com' });
        expect(result.isError).toBeFalsy();
        expect(textContent(result.content[0])).toContain('example.com');
    });
});

// ---------------------------------------------------------------------------
// reload / goBack / goForward
// ---------------------------------------------------------------------------

describe('browserMcpServer — reload/goBack/goForward', () => {
    test('reload calls adapter.reload', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'reload');
        expect(adapter.reload).toHaveBeenCalled();
        expect(result.isError).toBeFalsy();
    });

    test('reload returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            reload: mock(async (): Promise<never> => { throw new Error('reload failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'reload');
        expect(result.isError).toBe(true);
    });

    test('goBack calls adapter.goBack', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'goBack');
        expect(adapter.goBack).toHaveBeenCalled();
        expect(result.isError).toBeFalsy();
    });

    test('goBack returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            goBack: mock(async (): Promise<never> => { throw new Error('goBack failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'goBack');
        expect(result.isError).toBe(true);
    });

    test('goForward calls adapter.goForward', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'goForward');
        expect(adapter.goForward).toHaveBeenCalled();
        expect(result.isError).toBeFalsy();
    });

    test('goForward returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            goForward: mock(async (): Promise<never> => { throw new Error('goForward failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'goForward');
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getState
// ---------------------------------------------------------------------------

describe('browserMcpServer — getState', () => {
    test('getState returns url, title, loading, isClosed', async () => {
        const adapter = makeFakeAdapter({ url: 'https://foo.com', title: 'Foo', loading: true });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'getState');
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(textContent(result.content[0])) as { url: string, title: string, loading: boolean, isClosed: boolean };
        expect(parsed.url).toBe('https://foo.com');
        expect(parsed.title).toBe('Foo');
        expect(parsed.loading).toBe(true);
        expect(parsed.isClosed).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getBodyText
// ---------------------------------------------------------------------------

describe('browserMcpServer — getBodyText', () => {
    test('getBodyText calls evaluate with exact body textContent expression', async () => {
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<string> => 'page content') as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'getBodyText');
        expect(adapter.evaluate).toHaveBeenCalledWith(
            'document.getElementsByTagName("body")[0].textContent'
        );
        expect(result.isError).toBeFalsy();
        // short text should be returned unchanged (no truncation marker)
        expect(textContent(result.content[0])).toBe('page content');
    });

    test('getBodyText truncates to maxTextBytes (UTF-8 bytes) with marker showing omitted byte count', async () => {
        const longText = 'x'.repeat(200);
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<string> => longText) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, maxTextBytes: 100, maxScreenshotBytes: 2_000_000 });
        const result = await callTool(server, 'getBodyText');
        expect(result.isError).toBeFalsy();
        const output = textContent(result.content[0]);
        // first 100 bytes (=100 ASCII chars) should be x's, not the full 200
        expect(output.startsWith('x'.repeat(100))).toBe(true);
        expect(output.startsWith('x'.repeat(101))).toBe(false);
        // verify exact byte count in the truncation marker (200 - 100 = 100 bytes omitted)
        expect(output).toContain('100 bytes omitted');
    });

    test('getBodyText truncates emoji-heavy string at byte boundary (multi-byte chars)', async () => {
        // Each 🎉 emoji is 4 UTF-8 bytes. 10 emojis = 40 bytes.
        const emojiText = '🎉'.repeat(10); // 40 bytes total
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<string> => emojiText) as BrowserAdapter['evaluate'],
        });
        // Cap at 20 bytes — fits exactly 5 emojis (5×4=20 bytes)
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, maxTextBytes: 20, maxScreenshotBytes: 2_000_000 });
        const result = await callTool(server, 'getBodyText');
        expect(result.isError).toBeFalsy();
        const output = textContent(result.content[0]);
        // Truncated portion must be valid UTF-8 (no corrupted byte sequences)
        // The part before [truncated must be valid emoji chars only
        const beforeTruncation = output.split('[truncated')[0] ?? '';
        // Each char in the truncated prefix should be valid (Buffer.from round-trip)
        expect(Buffer.from(beforeTruncation, 'utf8').toString('utf8')).toBe(beforeTruncation);
        // Should have truncation marker
        expect(output).toContain('[truncated');
        expect(output).toContain('bytes omitted');
    });

    test('getBodyText does not truncate text exactly at the limit', async () => {
        const exactText = 'x'.repeat(100);
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<string> => exactText) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, maxTextBytes: 100, maxScreenshotBytes: 2_000_000 });
        const result = await callTool(server, 'getBodyText');
        expect(textContent(result.content[0])).toBe(exactText);
        expect(textContent(result.content[0])).not.toContain('[truncated');
    });

    test('getBodyText returns error when evaluate throws', async () => {
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<never> => { throw new Error('JS error'); }) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'getBodyText');
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getFullHTML
// ---------------------------------------------------------------------------

describe('browserMcpServer — getFullHTML', () => {
    test('getFullHTML calls evaluate with exact outerHTML expression', async () => {
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<string> => '<html></html>') as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'getFullHTML');
        expect(adapter.evaluate).toHaveBeenCalledWith(
            'document.documentElement.outerHTML'
        );
    });

    test('getFullHTML truncates to maxTextBytes (UTF-8 bytes) with marker', async () => {
        const longHtml = `<html>${'x'.repeat(200_000)}</html>`;
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<string> => longHtml) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, maxTextBytes: 100, maxScreenshotBytes: 2_000_000 });
        const result = await callTool(server, 'getFullHTML');
        expect(textContent(result.content[0])).toContain('[truncated');
    });

    test('getFullHTML returns error when evaluate throws', async () => {
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<never> => { throw new Error('JS error'); }) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'getFullHTML');
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getLinks (FIX 14: containerSelector parameter)
// ---------------------------------------------------------------------------

describe('browserMcpServer — getLinks', () => {
    test('getLinks calls evaluate with IIFE collecting href/text pairs', async () => {
        const links = [{ href: 'https://example.com', text: 'Example' }];
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<typeof links> => links) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'getLinks');
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(textContent(result.content[0])) as typeof links;
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.href).toBe('https://example.com');
    });

    test('getLinks uses default containerSelector "body" when not provided', async () => {
        let capturedExpr = '';
        const adapter = makeFakeAdapter({
            evaluate: mock(async (expr: string): Promise<unknown[]> => {
                capturedExpr = expr;
                return [];
            }) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'getLinks');
        expect(capturedExpr).toContain('"body"');
    });

    test('getLinks uses custom containerSelector when provided', async () => {
        let capturedExpr = '';
        const adapter = makeFakeAdapter({
            evaluate: mock(async (expr: string): Promise<unknown[]> => {
                capturedExpr = expr;
                return [];
            }) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'getLinks', { containerSelector: 'main article' });
        expect(capturedExpr).toContain('"main article"');
    });

    test('getLinks returns error when evaluate throws', async () => {
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<never> => { throw new Error('JS error'); }) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'getLinks');
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// click (FIX 15: modifiers and clickCount)
// ---------------------------------------------------------------------------

describe('browserMcpServer — click', () => {
    test('click calls adapter.click with selector and options', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'click', { selector: 'button#submit', timeout: 5000 });
        expect(adapter.click).toHaveBeenCalledWith('button#submit', expect.objectContaining({ timeout: 5000 }));
    });

    test('click passes modifiers to adapter.click', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'click', { selector: 'a', modifiers: ['Shift'] });
        expect(adapter.click).toHaveBeenCalledWith('a', expect.objectContaining({ modifiers: ['Shift'] }));
    });

    test('click passes clickCount to adapter.click', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'click', { selector: 'p', clickCount: 2 });
        expect(adapter.click).toHaveBeenCalledWith('p', expect.objectContaining({ clickCount: 2 }));
    });

    test('click passes both modifiers and clickCount to adapter.click', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'click', { selector: 'span', modifiers: ['Control'], clickCount: 3 });
        expect(adapter.click).toHaveBeenCalledWith('span', expect.objectContaining({ modifiers: ['Control'], clickCount: 3 }));
    });

    test('click returns error when adapter.click throws', async () => {
        const adapter = makeFakeAdapter({
            click: mock(async (): Promise<never> => { throw new Error('element not found'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'click', { selector: 'button' });
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// type
// ---------------------------------------------------------------------------

describe('browserMcpServer — type', () => {
    test('type calls adapter.type', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'type', { text: 'hello world' });
        expect(adapter.type).toHaveBeenCalledWith('hello world');
    });

    test('type returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            type: mock(async (): Promise<never> => { throw new Error('type failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'type', { text: 'hello' });
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// press
// ---------------------------------------------------------------------------

describe('browserMcpServer — press', () => {
    test('press calls adapter.press with modifiers', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'press', { key: 'Enter', modifiers: ['Shift'] });
        expect(adapter.press).toHaveBeenCalledWith('Enter', { modifiers: ['Shift'] });
    });

    test('press calls adapter.press without modifiers when not provided', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'press', { key: 'Tab' });
        expect(adapter.press).toHaveBeenCalledWith('Tab', undefined);
    });

    test('press returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            press: mock(async (): Promise<never> => { throw new Error('press failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'press', { key: 'Enter' });
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// scrollBy / scrollTo
// ---------------------------------------------------------------------------

describe('browserMcpServer — scrollBy', () => {
    test('scrollBy calls adapter.scroll', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'scrollBy', { dx: 0, dy: 500 });
        expect(adapter.scroll).toHaveBeenCalledWith(0, 500);
    });

    test('scrollBy returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            scroll: mock(async (): Promise<never> => { throw new Error('scroll failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'scrollBy', { dx: 0, dy: 500 });
        expect(result.isError).toBe(true);
    });
});

describe('browserMcpServer — scrollTo', () => {
    test('scrollTo calls adapter.scrollTo', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'scrollTo', { selector: '#footer', block: 'start' });
        expect(adapter.scrollTo).toHaveBeenCalledWith('#footer', expect.objectContaining({ block: 'start' }));
    });

    test('scrollTo returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            scrollTo: mock(async (): Promise<never> => { throw new Error('scrollTo failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'scrollTo', { selector: '#footer' });
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

describe('browserMcpServer — screenshot', () => {
    test('screenshot returns image content block on success', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'screenshot');
        expect(result.isError).toBeFalsy();
        expect(result.content[0].type).toBe('image');
        // FIX 13: adapter returns Buffer; MCP layer converts to base64
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrowing image content type at runtime
        const data = (result.content[0] as any).data as string;
        // The fake adapter returned Buffer.from('base64screenshot'), so the base64 of that ASCII is its bytes encoded
        expect(typeof data).toBe('string');
        expect(data.length).toBeGreaterThan(0);
    });

    test('screenshot returns error when buffer byteLength exceeds maxScreenshotBytes', async () => {
        const adapter = makeFakeAdapter({
            // Return a Buffer larger than the 2MB limit
            screenshot: mock(async (): Promise<Buffer> => Buffer.alloc(3_000_000)),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, maxScreenshotBytes: 2_000_000, maxTextBytes: 100_000 });
        const result = await callTool(server, 'screenshot');
        expect(result.isError).toBe(true);
    });

    test('screenshot with format and quality calls adapter.screenshot correctly', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'screenshot', { format: 'jpeg', quality: 80 });
        expect(adapter.screenshot).toHaveBeenCalledWith({ format: 'jpeg', quality: 80 });
    });

    test('screenshot returns error when adapter.screenshot throws', async () => {
        const adapter = makeFakeAdapter({
            screenshot: mock(async (): Promise<never> => { throw new Error('screenshot failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'screenshot');
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// evaluate — description must contain IIFE warning (FIX 4)
// ---------------------------------------------------------------------------

describe('browserMcpServer — evaluate tool description', () => {
    test('evaluate description contains IIFE warning', () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const registeredTools: Partial<Record<string, RegisteredTool>> = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
        const evaluateTool = registeredTools.evaluate;
        expect(evaluateTool).toBeDefined();
        expect(evaluateTool!.description).toContain('IIFE');
    });

    test('evaluate description contains "Prefer the structured tools" hint', () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const registeredTools: Partial<Record<string, RegisteredTool>> = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
        const evaluateTool = registeredTools.evaluate;
        expect(evaluateTool).toBeDefined();
        expect(evaluateTool!.description).toContain('Prefer the structured tools');
    });
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

describe('browserMcpServer — evaluate', () => {
    test('evaluate calls adapter.evaluate and returns JSON result', async () => {
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<number> => 42) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'evaluate', { expression: '1 + 41' });
        expect(adapter.evaluate).toHaveBeenCalledWith('1 + 41');
        expect(result.isError).toBeFalsy();
        expect(textContent(result.content[0])).toContain('42');
    });

    test('evaluate returns error when adapter.evaluate throws', async () => {
        const adapter = makeFakeAdapter({
            evaluate: mock(async (): Promise<never> => { throw new Error('SyntaxError'); }) as BrowserAdapter['evaluate'],
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'evaluate', { expression: 'bad syntax;;;' });
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------

describe('browserMcpServer — resize', () => {
    test('resize calls adapter.resize', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        await callTool(server, 'resize', { width: 1920, height: 1080 });
        expect(adapter.resize).toHaveBeenCalledWith(1920, 1080);
    });

    test('resize returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            resize: mock((): never => { throw new Error('resize failed'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'resize', { width: 1920, height: 1080 });
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// waitForSelector
// ---------------------------------------------------------------------------

describe('browserMcpServer — waitForSelector', () => {
    test('waitForSelector calls adapter.waitForSelector', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'waitForSelector', { selector: '#content', timeout: 5000 });
        expect(adapter.waitForSelector).toHaveBeenCalledWith('#content', 5000);
        expect(result.isError).toBeFalsy();
    });

    test('waitForSelector returns error when adapter throws', async () => {
        const adapter = makeFakeAdapter({
            waitForSelector: mock(async (): Promise<never> => { throw new Error('timeout'); }),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'waitForSelector', { selector: '#missing' });
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getConsoleLogs
// ---------------------------------------------------------------------------

describe('browserMcpServer — getConsoleLogs', () => {
    test('getConsoleLogs calls adapter.getConsoleLogs and returns entries', async () => {
        const entries = [{ type: 'log', args: ['hello'], at: new Date() }];
        const adapter = makeFakeAdapter({
            getConsoleLogs: mock(() => entries),
        });
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'getConsoleLogs', { limit: 50 });
        expect(adapter.getConsoleLogs).toHaveBeenCalledWith(50);
        expect(result.isError).toBeFalsy();
    });
});

// ---------------------------------------------------------------------------
// closeBrowser
// ---------------------------------------------------------------------------

describe('browserMcpServer — closeBrowser', () => {
    test('closeBrowser calls adapter.close', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({ adapter, policy: noPolicy, ...policy2mb });
        const result = await callTool(server, 'closeBrowser');
        expect(adapter.close).toHaveBeenCalled();
        expect(result.isError).toBeFalsy();
    });
});

// ---------------------------------------------------------------------------
// allowlist policy
// ---------------------------------------------------------------------------

describe('browserMcpServer — allowlist policy', () => {
    test('navigate allowed when host matches allowlist', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({
            adapter,
            policy: { allowlist: ['example.com'] },
            ...policy2mb,
        });
        const result = await callTool(server, 'navigate', { url: 'https://example.com' });
        expect(adapter.navigate).toHaveBeenCalled();
        expect(result.isError).toBeFalsy();
    });

    test('navigate rejected when host not in allowlist', async () => {
        const adapter = makeFakeAdapter();
        const server = createBrowserMCPServer({
            adapter,
            policy: { allowlist: ['example.com'] },
            ...policy2mb,
        });
        const result = await callTool(server, 'navigate', { url: 'https://evil.com' });
        expect(adapter.navigate).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// truncateToBytes — comprehensive codepoint boundary tests (FIX 6)
// ---------------------------------------------------------------------------

/**
 * Helper: asserts that the content portion of a truncated result respects the cap
 * and contains no U+FFFD replacement characters.
 */
function assertValidTruncation(result: string, maxBytes: number): void {
    const markerIdx = result.indexOf('[truncated');
    const content = markerIdx === -1 ? result : result.slice(0, markerIdx);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(content).not.toContain('\uFFFD');
}

describe('truncateToBytes — empty and ASCII', () => {
    test('empty string returns empty string', () => {
        expect(truncateToBytes('', 100)).toBe('');
    });

    test('ASCII under cap returns unchanged', () => {
        expect(truncateToBytes('hello', 100)).toBe('hello');
    });

    test('ASCII exactly at cap returns unchanged (early return path)', () => {
        expect(truncateToBytes('hello', 5)).toBe('hello');
    });

    test('ASCII over cap truncates at exactly maxBytes with correct omitted count', () => {
        const result = truncateToBytes('hello world', 5);
        expect(result.startsWith('hello')).toBe(true);
        expect(result).toContain('[truncated');
        expect(result).toContain('6 bytes omitted');
    });

    test('maxBytes=0 with non-empty text returns truncation marker with full byte count', () => {
        const result = truncateToBytes('abc', 0);
        expect(result).toContain('[truncated — 3 bytes omitted]');
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('');
    });
});

describe('truncateToBytes — 2-byte codepoints (é = C3 A9)', () => {
    // 'éé' = 4 bytes; 'éééé' = 8 bytes
    const text = 'éé'; // 4 bytes: [C3 A9 C3 A9]

    test('cap=1 back-walks past continuation byte to 0 — no content before marker', () => {
        const result = truncateToBytes(text, 1);
        assertValidTruncation(result, 1);
        const content = result.split('[truncated')[0] ?? '';
        expect(Buffer.byteLength(content, 'utf8')).toBe(0);
    });

    test('cap=2 is clean boundary (one é) — no back-walk needed', () => {
        const result = truncateToBytes(text, 2);
        expect(result.startsWith('é')).toBe(true);
        assertValidTruncation(result, 2);
    });

    test('cap=3 back-walks from C3 continuation to byte 2 — one é preserved', () => {
        // byte[2] = 0xC3 (start byte of second é — not a continuation), so cut at 2
        // Actually byte[2]=0xC3 is NOT a continuation (not 10xxxxxx), but byte[3]=0xA9 IS continuation
        // So cap=3: buf[3]=0xA9 (0x80 mask), back-walk to 2; cut gives 'é'
        const result = truncateToBytes(text, 3);
        assertValidTruncation(result, 3);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('é');
    });

    test('cap=4 is clean boundary (both é) — returns unchanged', () => {
        expect(truncateToBytes(text, 4)).toBe(text);
    });
});

describe('truncateToBytes — 3-byte codepoints (你 = E4 BD A0)', () => {
    // '你好' = 6 bytes
    const text = '你好';

    test('cap=1 back-walks to 0', () => {
        const result = truncateToBytes(text, 1);
        assertValidTruncation(result, 1);
        const content = result.split('[truncated')[0] ?? '';
        expect(Buffer.byteLength(content, 'utf8')).toBe(0);
    });

    test('cap=2 back-walks to 0', () => {
        const result = truncateToBytes(text, 2);
        assertValidTruncation(result, 2);
        const content = result.split('[truncated')[0] ?? '';
        expect(Buffer.byteLength(content, 'utf8')).toBe(0);
    });

    test('cap=3 is clean boundary (one 你)', () => {
        const result = truncateToBytes(text, 3);
        assertValidTruncation(result, 3);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('你');
    });

    test('cap=4 back-walks to 3', () => {
        const result = truncateToBytes(text, 4);
        assertValidTruncation(result, 4);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('你');
    });

    test('cap=5 back-walks to 3', () => {
        const result = truncateToBytes(text, 5);
        assertValidTruncation(result, 5);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('你');
    });

    test('cap=6 is clean boundary (both chars) — returns unchanged', () => {
        expect(truncateToBytes(text, 6)).toBe(text);
    });
});

describe('truncateToBytes — 4-byte codepoints (🎉 = F0 9F 8E 89)', () => {
    // '🎉🎉🎉' = 12 bytes
    const text = '🎉🎉🎉';

    // Only caps 0, 4, 8, 12 land on clean boundaries; others back-walk
    for(let cap = 0; cap <= 12; cap++) {
        const cleanBoundary = cap % 4 === 0;
        if(cleanBoundary) {
            test(`cap=${cap} is a clean 4-byte emoji boundary — content is exactly ${cap} bytes`, () => {
                const result = truncateToBytes(text, cap);
                if(cap === 12) {
                    // Exactly at limit — returns unchanged
                    expect(result).toBe(text);
                } else {
                    assertValidTruncation(result, cap);
                    const content = result.split('[truncated')[0] ?? '';
                    expect(Buffer.byteLength(content, 'utf8')).toBe(cap);
                }
            });
        } else {
            test(`cap=${cap} back-walks to previous clean boundary — content byte-length <= ${cap} and no U+FFFD`, () => {
                const result = truncateToBytes(text, cap);
                assertValidTruncation(result, cap);
                const content = result.split('[truncated')[0] ?? '';
                // Content must align to 4-byte boundary (floor(cap/4)*4 bytes)
                const expectedContentBytes = Math.floor(cap / 4) * 4;
                expect(Buffer.byteLength(content, 'utf8')).toBe(expectedContentBytes);
            });
        }
    }
});

describe('truncateToBytes — mixed content (a🎉b = 61 F0 9F 8E 89 62)', () => {
    // 'a🎉b' = 6 bytes
    const text = 'a🎉b';

    test('cap=0 — empty content with full-byte truncation marker', () => {
        const result = truncateToBytes(text, 0);
        assertValidTruncation(result, 0);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('');
    });

    test('cap=1 — cuts after ASCII a', () => {
        const result = truncateToBytes(text, 1);
        assertValidTruncation(result, 1);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('a');
    });

    test('cap=2 — back-walks to byte 1 (a only, emoji F0 start at byte 1 is not continuation)', () => {
        // byte[1]=0xF0 is a start byte, byte[2]=0x9F IS continuation → back-walk from cap=2 to 1
        const result = truncateToBytes(text, 2);
        assertValidTruncation(result, 2);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('a');
    });

    test('cap=3 — back-walks to byte 1', () => {
        const result = truncateToBytes(text, 3);
        assertValidTruncation(result, 3);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('a');
    });

    test('cap=4 — back-walks to byte 1', () => {
        const result = truncateToBytes(text, 4);
        assertValidTruncation(result, 4);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('a');
    });

    test('cap=5 — cuts at emoji end (a🎉)', () => {
        const result = truncateToBytes(text, 5);
        assertValidTruncation(result, 5);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('a🎉');
    });

    test('cap=6 — returns unchanged (full string)', () => {
        expect(truncateToBytes(text, 6)).toBe(text);
    });
});

describe('truncateToBytes — maxBytes=1 with 4-byte emoji start', () => {
    test('back-walks all the way to 0 — empty content before truncation marker', () => {
        const result = truncateToBytes('🎉', 1);
        assertValidTruncation(result, 1);
        const content = result.split('[truncated')[0] ?? '';
        expect(content).toBe('');
        expect(result).toContain('[truncated — 4 bytes omitted]');
    });
});

describe('truncateToBytes — bytesSaved accuracy', () => {
    test('bytesSaved in marker reflects actual dropped bytes including back-walked bytes', () => {
        // '🎉'.repeat(10) = 40 bytes; cap=21 → back-walk to 20 (5 emojis) → bytesSaved=20
        const text = '🎉'.repeat(10);
        const result = truncateToBytes(text, 21);
        expect(result).toContain('[truncated — 20 bytes omitted]');
    });

    test('bytesSaved for clean ASCII cut is exact', () => {
        // 'abcde' = 5 bytes; cap=3 → cut at 3 → bytesSaved=2
        const result = truncateToBytes('abcde', 3);
        expect(result).toContain('[truncated — 2 bytes omitted]');
    });
});
