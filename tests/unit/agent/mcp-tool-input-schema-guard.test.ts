/**
 * Guard: every field a tool advertises to the model as optional must be omittable at the SDK's
 * input validator.
 *
 * The Claude Agent SDK's `createSdkMcpServer()` hands each tool's raw zod shape to its bundled MCP
 * server, which wraps it in the object schema of the zod copy bundled inside the SDK. That object
 * schema is what `tools/call` validates arguments against, while `tools/list` advertises a JSON
 * schema generated from the same shape. When the project's zod and the bundled zod disagree about
 * a field's optionality (zod 4.6 marks `.default()` fields `optin: "defaulted"`, which the bundled
 * zod 4.4 object treats as required), the model is told a field is optional and is then rejected
 * for omitting it — "expected nonoptional, received undefined". Handler-level unit tests call the
 * handler directly and never see it, so this guard checks every registered tool of every server.
 */
import { describe, expect, test } from 'bun:test';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import * as agent from '../../../src/agent';
import { listSdkTools } from '../../helpers/sdk-mcp-client';

/** The object schema the SDK's `tools/call` handler validates a tool's arguments against. */
interface RegisteredToolInstance {
    _registeredTools: Record<string, {
        inputSchema: {
            safeParseAsync: (args: unknown) => Promise<{ success: true } | { success: false, error: { issues: { path: PropertyKey[] }[] } }>
        }
    }>
}

// Construction only registers tools, so empty stand-ins are enough for every dependency; no
// handler runs in this file. The memory server gets truthy vector deps so its conditional
// semantic_search tool is registered too.
const serverFactories: Record<string, () => McpSdkServerConfigWithInstance> = {
    createBrowserMCPServer:       () => agent.createBrowserMCPServer({} as never),
    createBskyMCPServer:          () => agent.createBskyMCPServer({} as never),
    createCaldavMCPServer:        () => agent.createCaldavMCPServer({} as never),
    createContactsMCPServer:      () => agent.createContactsMCPServer({} as never),
    createDiscordInboxMCPServer:  () => agent.createDiscordInboxMCPServer({} as never, {} as never),
    createDiscordMCPServer:       () => agent.createDiscordMCPServer({} as never),
    createEmailMCPServer:         () => agent.createEmailMCPServer({} as never),
    createHealthMCPServer:        () => agent.createHealthMCPServer({} as never),
    createMediaMCPServer:         () => agent.createMediaMCPServer(),
    createMemoryMCPServer:        () => agent.createMemoryMCPServer({} as never, { vectorIndex: {} as never, embedder: {} as never }),
    createPersonContextMCPServer: () => agent.createPersonContextMCPServer({} as never),
    createWikipediaMCPServer:     () => agent.createWikipediaMCPServer(),
};

describe('SDK MCP tool input schema guard', () => {
    test('the guard covers every MCP server factory the agent barrel exports', () => {
        const byName = (a: string, b: string): number => a.localeCompare(b);
        const exported = Object.keys(agent).filter(name => /^create\w+MCPServer$/.test(name)).toSorted(byName);

        expect(exported).toEqual(Object.keys(serverFactories).toSorted(byName));
    });

    test('the memory server stand-ins register the conditional semantic_search tool', async () => {
        const tools = await listSdkTools(serverFactories.createMemoryMCPServer());

        expect(tools.map(tool => tool.name)).toContain('semantic_search');
    });

    test('every field a registered SDK tool advertises as optional is accepted when omitted', async () => {
        const perTool = await Promise.all(Object.entries(serverFactories).map(async ([factoryName, create]) => {
            const server = create();
            const registered = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
            const advertisedTools = await listSdkTools(server);
            return Promise.all(advertisedTools.map(async (advertised) => {
                const required = new Set(advertised.inputSchema.required);
                // The same object schema, parsed the same way, as the SDK's tools/call input validation.
                const parsed = await registered[advertised.name].inputSchema.safeParseAsync({});
                const rejectedFields = parsed.success ? [] : parsed.error.issues.map(issue => String(issue.path[0]));
                return rejectedFields.filter(name => !required.has(name)).map(field => `${factoryName}: ${advertised.name}.${field}`);
            }));
        }));
        const toolResults = perTool.flat();

        expect(toolResults.length).toBeGreaterThan(80);
        expect(toolResults.flat()).toEqual([]);
    });
});
