/**
 * Drive an in-process Claude Agent SDK MCP server (`createSdkMcpServer()`) through a real MCP
 * client, so tool arguments pass through the server's own `tools/call` request handler — the
 * handler the SDK forwards the CLI's `mcp_message` control requests into.
 *
 * Calling a registered tool's `handler` directly skips that handler's input validator. That
 * validator wraps each tool's raw zod shape in the object schema of the zod copy bundled inside
 * the SDK, which can disagree with the project's zod about which fields may be omitted (a
 * `.default()` field is advertised as optional yet rejected when absent — "expected nonoptional,
 * received undefined"). Tests that must see what the model sees go through here instead.
 */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- test-only helper; the MCP client is a devDependency by design
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- test-only helper; the MCP client is a devDependency by design
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- test-only helper; the MCP client is a devDependency by design
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

async function withSdkMcpClient<T>(server: McpSdkServerConfigWithInstance, use: (client: Client) => Promise<T>): Promise<T> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    const client = new Client({ name: 'sdk-mcp-test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
        return await use(client);
    } finally {
        await client.close();
    }
}

/**
 * Call one tool with raw, unparsed arguments exactly as the model would send them.
 * @param server The SDK MCP server config returned by a `create*MCPServer()` factory
 * @param name The registered tool name
 * @param args The raw tool arguments
 * @returns The tool result, including the `isError` result an input-validation failure produces
 */
export async function callSdkTool(server: McpSdkServerConfigWithInstance, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return withSdkMcpClient(server, async client => client.callTool({ name, arguments: args }, CallToolResultSchema) as Promise<CallToolResult>);
}

/**
 * List the tools exactly as the server advertises them to the model (`tools/list`).
 * @param server The SDK MCP server config returned by a `create*MCPServer()` factory
 * @returns The advertised tool definitions, including their JSON input schemas
 */
export async function listSdkTools(server: McpSdkServerConfigWithInstance): Promise<Tool[]> {
    return withSdkMcpClient(server, async (client) => {
        const listed = await client.listTools();
        return listed.tools;
    });
}
