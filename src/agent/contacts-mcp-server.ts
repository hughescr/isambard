import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult, mcpTextResult } from './mcp-helpers';
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
export interface ContactsMCPServerOptions {
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
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    query: z.string().describe('Name, email address, Bluesky handle, Discord name, or any other identifier to search for'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const results = await backend.fuzzyLookup(args.query);
                        if(results.length === 0) {
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult('No contacts found matching that query.');
                        }
                        return mcpJsonResult(results.map(c => stripInternal(c)));
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Look Up Contact', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'lookupContactId',
                'Get the identifier value(s) for a specific contact on a given platform (e.g., their email address or Bluesky handle).',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    personId: z.string().describe('The personId of the contact (e.g., "craig-hughes")'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    platform: platformTypeSchema.describe("Platform to look up: 'name', 'nickname', 'discord', 'email', or 'bsky'"),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const contact = await backend.getContact(args.personId as Parameters<typeof backend.getContact>[0]);
                        if(!contact) {
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult(`Contact '${args.personId}' not found.`);
                        }
                        const matches = contact.identifiers.filter(id => id.platform === args.platform);
                        if(matches.length === 0) {
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult(`Contact '${args.personId}' has no ${args.platform} identifier.`);
                        }
                        return mcpJsonResult({ personId: contact.personId, platform: args.platform, values: matches.map(id => id.value) });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Look Up Contact ID', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'requestContactCreate',
                'Request creation of a new contact. Requires admin approval before the contact is saved.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    displayName: z.string().describe("The contact's display name (e.g., 'Alice Wonderland')"),
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only; .min(1) is schema configuration
                    identifiers: z.array(contactIdentifierSchema).min(1).describe('At least one identifier for the contact'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    notes:       z.string().optional().describe('Optional notes about the contact'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        if(!sendContactApprovalRequest) {
                            // Stryker disable next-line StringLiteral: error message is informational only
                            return mcpErrorResult('Contact creation requires admin approval but no approval channel is configured');
                        }
                        const request: ContactChangeRequest = {
                            action:         'create',
                            displayName:    args.displayName,
                            addIdentifiers: args.identifiers,
                            notes:          args.notes,
                        };
                        await sendContactApprovalRequest('create', request);
                        // Stryker disable next-line StringLiteral: success message is informational only
                        return mcpTextResult('Contact creation request sent to admin for approval.');
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Request Contact Create', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'requestContactUpdate',
                'Request an update to an existing contact. Requires admin approval before changes are saved.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    personId:          z.string().describe('The personId of the contact to update (e.g., "craig-hughes")'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    addIdentifiers:    z.array(contactIdentifierSchema).optional().describe('New identifiers to add to the contact'),
                    // Stryker disable StringLiteral: describe() is documentation only
                    removeIdentifiers: z.array(z.object({
                        platform: platformTypeSchema.describe("Platform type: 'name', 'nickname', 'discord', 'email', or 'bsky'"),
                        value:    z.string().describe('The identifier value to remove'),
                    })).optional().describe('Identifiers to remove from the contact'),
                    // Stryker restore StringLiteral
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    notes: z.string().optional().describe('New notes for the contact (replaces existing notes)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Verify the contact exists first
                        const contact = await backend.getContact(args.personId as Parameters<typeof backend.getContact>[0]);
                        if(!contact) {
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult(`Contact '${args.personId}' not found.`);
                        }

                        if(!sendContactApprovalRequest) {
                            // Stryker disable next-line StringLiteral: error message is informational only
                            return mcpErrorResult('Contact updates require admin approval but no approval channel is configured');
                        }

                        const request: ContactChangeRequest = {
                            action:            'update',
                            personId:          args.personId,
                            // Stryker disable next-line ConditionalExpression,EqualityOperator: empty-array guard — approval handler treats [] and undefined identically via ?? []
                            addIdentifiers:    args.addIdentifiers && args.addIdentifiers.length > 0 ? args.addIdentifiers : undefined,
                            // Stryker disable next-line ConditionalExpression,EqualityOperator: empty-array guard — approval handler treats [] and undefined identically via ?? []
                            removeIdentifiers: args.removeIdentifiers && args.removeIdentifiers.length > 0 ? args.removeIdentifiers : undefined,
                            notes:             args.notes,
                        };
                        await sendContactApprovalRequest('update', request);
                        // Stryker disable next-line StringLiteral: success message is informational only
                        return mcpTextResult(`Contact update request for '${args.personId}' sent to admin for approval.`);
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Request Contact Update', readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
            ),

            tool(
                'listContacts',
                'List all known contacts in the address book.',
                {},
                async (): Promise<CallToolResult> => {
                    try {
                        const contacts = await backend.listContacts();
                        if(contacts.length === 0) {
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult('No contacts in the address book.');
                        }
                        return mcpJsonResult(contacts.map(c => stripInternal(c)));
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'List Contacts', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
