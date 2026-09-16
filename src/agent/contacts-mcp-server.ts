import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult, mcpTextResult, withToolErrorHandling } from './mcp-helpers';
import { contactIdentifierSchema, platformTypeSchema, type Contact, type ContactIdentifier, type ContactBackend } from '@/storage';

/**
 * Details for a contact change approval request.
 */
export interface ContactChangeRequest {
    action:             'create' | 'update'
    personId?:          string
    displayName?:       string
    addIdentifiers?:    ContactIdentifier[]
    removeIdentifiers?: ContactIdentifier[]
    notes?:             string
}

/**
 * Options for creating the Contacts MCP server.
 */
interface ContactsMCPServerOptions {
    backend:                     ContactBackend
    sendContactApprovalRequest?: (action: 'create' | 'update', details: ContactChangeRequest) => Promise<void>
}

/**
 * Strip the `_internal` field from a contact before returning to the agent.
 * Izzy must never see Discord user IDs or Bluesky DIDs directly.
 */
function stripInternal(contact: Contact): Omit<Contact, '_internal'> {
    const { _internal: _, ...rest } = contact;
    return rest;
}

/**
 * Creates an MCP server for contact/address book operations.
 *
 * Provides tools for:
 * - Looking up contacts by any identifier (name, email, handle, etc.)
 * - Looking up a specific platform identifier for a contact
 * - Requesting creation of a new contact (routes to admin for approval)
 * - Requesting update to an existing contact (routes to admin for approval)
 * - Listing all known contacts
 *
 * All results strip the `_internal` field so Izzy never sees Discord user IDs
 * or Bluesky DIDs directly — those are internal implementation details.
 */
export function createContactsMCPServer(options: ContactsMCPServerOptions) {
    const { backend, sendContactApprovalRequest } = options;

    return createSdkMcpServer({
        name:    'contacts',
        version: '1.0.0',
        tools:   [
            tool(
                'lookupContact',
                'Look up contacts by any identifier: name, email, handle, nickname, etc. Returns ranked results.',
                {
                    query: z.string().describe('Name, email address, Bluesky handle, Discord name, or any other identifier to search for'),
                },
                withToolErrorHandling('lookupContact', async (args): Promise<CallToolResult> => {
                    const results = await backend.fuzzyLookup(args.query);
                    if(results.length === 0) {
                        return mcpTextResult('No contacts found matching that query.');
                    }
                    return mcpJsonResult(results.map(c => stripInternal(c)));
                }),
                { annotations: { title: 'Look Up Contact', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'lookupContactId',
                'Get the identifier value(s) for a specific contact on a given platform (e.g., their email address or Bluesky handle).',
                {
                    personId: z.string().describe('The personId of the contact (e.g., "craig-hughes")'),
                    platform: platformTypeSchema.describe("Platform to look up: 'name', 'nickname', 'discord', 'email', or 'bsky'"),
                },
                withToolErrorHandling('lookupContactId', async (args): Promise<CallToolResult> => {
                    const contact = await backend.getContact(args.personId as Parameters<typeof backend.getContact>[0]);
                    if(!contact) {
                        return mcpTextResult(`Contact '${args.personId}' not found.`);
                    }
                    // Stryker disable next-line llm: both platforms are schema-validated string primitives, so loose and strict equality are equivalent.
                    const matches = contact.identifiers.filter(id => id.platform === args.platform);
                    // Stryker disable next-line llm: array length is non-negative, so <= 0 and !length are equivalent to === 0.
                    if(matches.length === 0) {
                        return mcpTextResult(`Contact '${args.personId}' has no ${args.platform} identifier.`);
                    }
                    // Stryker disable next-line llm: the zero-length guard returns above, so matches is non-empty here.
                    return mcpJsonResult({ personId: contact.personId, platform: args.platform, values: matches.map(id => id.value) });
                }),
                { annotations: { title: 'Look Up Contact ID', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'requestContactCreate',
                'Request creation of a new contact. Requires admin approval before the contact is saved.',
                {
                    displayName: z.string().describe("The contact's display name (e.g., 'Alice Wonderland')"),
                    identifiers: z.array(contactIdentifierSchema).min(1).describe('At least one identifier for the contact'),
                    notes:       z.string().optional().describe('Optional notes about the contact'),
                },
                withToolErrorHandling('requestContactCreate', async (args): Promise<CallToolResult> => {
                    if(!sendContactApprovalRequest) {
                        return mcpErrorResult('Contact creation requires admin approval but no approval channel is configured');
                    }
                    const request: ContactChangeRequest = {
                        action:         'create',
                        displayName:    args.displayName,
                        addIdentifiers: args.identifiers,
                        notes:          args.notes,
                    };
                    await sendContactApprovalRequest('create', request);
                    return mcpTextResult('Contact creation request sent to admin for approval.');
                }),
                { annotations: { title: 'Request Contact Create', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'requestContactUpdate',
                'Request an update to an existing contact. Requires admin approval before changes are saved.',
                {
                    personId:          z.string().describe('The personId of the contact to update (e.g., "craig-hughes")'),
                    addIdentifiers:    z.array(contactIdentifierSchema).optional().describe('New identifiers to add to the contact'),
                    removeIdentifiers: z.array(z.object({
                        platform: platformTypeSchema.describe("Platform type: 'name', 'nickname', 'discord', 'email', or 'bsky'"),
                        value:    z.string().describe('The identifier value to remove'),
                    })).optional().describe('Identifiers to remove from the contact'),
                    notes: z.string().optional().describe('New notes for the contact (replaces existing notes)'),
                },
                withToolErrorHandling('requestContactUpdate', async (args): Promise<CallToolResult> => {
                    // Verify the contact exists first
                    const contact = await backend.getContact(args.personId as Parameters<typeof backend.getContact>[0]);
                    if(!contact) {
                        return mcpTextResult(`Contact '${args.personId}' not found.`);
                    }

                    if(!sendContactApprovalRequest) {
                        return mcpErrorResult('Contact updates require admin approval but no approval channel is configured');
                    }

                    const request: ContactChangeRequest = {
                        action:            'update',
                        personId:          args.personId,
                        addIdentifiers:    args.addIdentifiers && args.addIdentifiers.length > 0 ? args.addIdentifiers : undefined,
                        removeIdentifiers: args.removeIdentifiers && args.removeIdentifiers.length > 0 ? args.removeIdentifiers : undefined,
                        notes:             args.notes,
                    };
                    await sendContactApprovalRequest('update', request);
                    return mcpTextResult(`Contact update request for '${args.personId}' sent to admin for approval.`);
                }),
                { annotations: { title: 'Request Contact Update', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'listContacts',
                'List all known contacts in the address book.',
                {},
                withToolErrorHandling('listContacts', async (): Promise<CallToolResult> => {
                    const contacts = await backend.listContacts();
                    if(contacts.length === 0) {
                        return mcpTextResult('No contacts in the address book.');
                    }
                    return mcpJsonResult(contacts.map(c => stripInternal(c)));
                }),
                { annotations: { title: 'List Contacts', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
