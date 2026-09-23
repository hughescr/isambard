import { expect, test } from 'bun:test';
import { createCaldavMCPServer } from '../../../src/agent/caldav-mcp-server';
import { createContactsMCPServer } from '../../../src/agent/contacts-mcp-server';
import { createInboxMCPServer } from '../../../src/agent/inbox-mcp-server';
import { createMediaMCPServer } from '../../../src/agent/media-mcp-server';
import { createMemoryMCPServer } from '../../../src/agent/memory-mcp-server';
import { createPersonContextMCPServer } from '../../../src/agent/person-context-mcp-server';
import { createWikipediaMCPServer } from '../../../src/agent/wikipedia-mcp-server';
import expectedCatalog from './fixtures/mcp-repair-metadata.json';

interface SchemaField {
    description?: string
    shape?:       Record<string, SchemaField>
    unwrap?:      () => SchemaField
    element?:     SchemaField
    safeParse:    (value: unknown) => { success: boolean }
}

interface RegisteredTool {
    description:  string
    annotations?: Record<string, unknown>
    inputSchema:  { shape: Record<string, SchemaField> }
}

interface ServerInstance {
    _registeredTools: Record<string, RegisteredTool>
    server:           { _serverInfo: { version: string } }
}

function fieldMetadata(field: SchemaField): Record<string, unknown> {
    const inner = field.shape === undefined && field.element === undefined ? field.unwrap?.() : field;
    return {
        ...(field.description === undefined ? {} : { description: field.description }),
        ...(inner?.shape === undefined ? {} : { shape: schemaMetadata(inner.shape) }),
        ...(inner?.element === undefined ? {} : { element: fieldMetadata(inner.element) }),
    };
}

function schemaMetadata(shape: Record<string, SchemaField>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(shape).map(([name, field]) => [name, fieldMetadata(field)]));
}

function serverMetadata(server: { name: string, instance: unknown }): unknown {
    const instance = server.instance as ServerInstance;
    return {
        name:    server.name,
        version: instance.server._serverInfo.version,
        tools:   Object.fromEntries(Object.entries(instance._registeredTools).map(([name, registered]) => [name, {
            description: registered.description,
            ...(registered.annotations === undefined ? {} : { annotations: registered.annotations }),
            input:       schemaMetadata(registered.inputSchema.shape),
        }])),
    };
}

test('MCP tool catalog exposes stable descriptions, input help, and annotations', () => {
    // The constructors register tools without accessing their backends. The dummy values
    // keep this a pure registration contract check; no handler is invoked here.
    const unusedBackend = {} as Parameters<typeof createMemoryMCPServer>[0];
    const servers = {
        caldav: serverMetadata(createCaldavMCPServer({
            client:   unusedBackend as unknown as Parameters<typeof createCaldavMCPServer>[0]['client'],
            registry: unusedBackend as unknown as Parameters<typeof createCaldavMCPServer>[0]['registry'],
        })),
        contacts: serverMetadata(createContactsMCPServer({ backend: unusedBackend as unknown as Parameters<typeof createContactsMCPServer>[0]['backend'] })),
        inbox:    serverMetadata(createInboxMCPServer(
            unusedBackend as unknown as Parameters<typeof createInboxMCPServer>[0],
            unusedBackend as unknown as Parameters<typeof createInboxMCPServer>[1]
        )),
        media:          serverMetadata(createMediaMCPServer()),
        memory:         serverMetadata(createMemoryMCPServer(unusedBackend)),
        memorySemantic: (serverMetadata(createMemoryMCPServer(unusedBackend, {
            vectorIndex: unusedBackend as unknown as NonNullable<Parameters<typeof createMemoryMCPServer>[1]>['vectorIndex'],
            embedder:    unusedBackend as unknown as NonNullable<Parameters<typeof createMemoryMCPServer>[1]>['embedder'],
        })) as { tools: Record<string, unknown> }).tools.semantic_search,
        personContext: serverMetadata(createPersonContextMCPServer({ coordinator: unusedBackend as unknown as Parameters<typeof createPersonContextMCPServer>[0]['coordinator'] })),
        wikipedia:     serverMetadata(createWikipediaMCPServer()),
    };
    expect(servers).toEqual(expectedCatalog);
});

test('MCP input schemas enforce the documented nonempty and bounded inputs', () => {
    const unusedBackend = {} as Parameters<typeof createMemoryMCPServer>[0];
    const tools = (server: { instance: unknown }) => (server.instance as ServerInstance)._registeredTools;
    const caldav = tools(createCaldavMCPServer({
        client:   unusedBackend as unknown as Parameters<typeof createCaldavMCPServer>[0]['client'],
        registry: unusedBackend as unknown as Parameters<typeof createCaldavMCPServer>[0]['registry'],
    }));
    expect(caldav.getCalendarEvents.inputSchema.shape.user.safeParse('').success).toBe(false);
    expect(caldav.getCalendarEvents.inputSchema.shape.user.safeParse('Craig').success).toBe(true);

    const contacts = tools(createContactsMCPServer({ backend: unusedBackend as unknown as Parameters<typeof createContactsMCPServer>[0]['backend'] }));
    const identifiers = contacts.requestContactCreate.inputSchema.shape.identifiers;
    expect(identifiers.safeParse([]).success).toBe(false);
    expect(identifiers.safeParse([{ platform: 'email', value: 'alice@example.com' }]).success).toBe(true);

    const context = tools(createPersonContextMCPServer({ coordinator: unusedBackend as unknown as Parameters<typeof createPersonContextMCPServer>[0]['coordinator'] }));
    expect(context.getPersonContext.inputSchema.shape.identifier.safeParse('').success).toBe(false);
    expect(context.getPersonContext.inputSchema.shape.identifier.safeParse('alice@example.com').success).toBe(true);
    expect(context.getPersonContext.inputSchema.shape.timeRange.safeParse({ startTime: '2026-01-01T00:00:00Z' }).success).toBe(true);
    expect(context.getPersonContext.inputSchema.shape.timeRange.safeParse({ startTime: 1 }).success).toBe(false);

    const memory = tools(createMemoryMCPServer(unusedBackend, {
        vectorIndex: unusedBackend as unknown as NonNullable<Parameters<typeof createMemoryMCPServer>[1]>['vectorIndex'],
        embedder:    unusedBackend as unknown as NonNullable<Parameters<typeof createMemoryMCPServer>[1]>['embedder'],
    }));
    const layer = memory.semantic_search.inputSchema.shape.layer;
    expect(layer.safeParse('state').success).toBe(true);
    expect(layer.safeParse('users').success).toBe(false);

    const frames = tools(createMediaMCPServer()).getVideoFrames.inputSchema.shape.count;
    expect(frames.safeParse(20).success).toBe(true);
    expect(frames.safeParse(21).success).toBe(false);
});
