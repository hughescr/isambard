import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import type { MemoryToolHandlers } from '@anthropic-ai/sdk/helpers/beta/memory';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
    MemoryToolBackend,
    create,
    view,
    delete_memory,
    insert,
    str_replace,
    rename
} from '../storage/memory-tool';

/**
 * Create a MemoryToolHandlers implementation backed by DynamoDB
 */
export function createDynamoDBMemoryHandlers(
    docClient: DynamoDBDocumentClient,
    tableName: string
): MemoryToolHandlers {
    const backend = new MemoryToolBackend(docClient, tableName);

    return {
        view: (command) => {
            // Convert SDK's Array<number> to tuple [number, number] if present
            const viewRange = command.view_range
                ? ([command.view_range[0], command.view_range[1]] as [number, number])
                : undefined;

            return view(backend, {
                path:       command.path,
                view_range: viewRange,
            });
        },
        create:      command => create(backend, command),
        str_replace: command => str_replace(backend, command),
        insert:      command => insert(backend, command),
        'delete':    command => delete_memory(backend, command),
        rename:      (command) => {
            // SDK uses old_path/new_path, our handlers use path/new_path
            return rename(backend, {
                path:     command.old_path,
                new_path: command.new_path,
            });
        },
    };
}

/**
 * Create a betaMemoryTool ready for use with Claude API
 */
export function createMemoryTool(
    docClient: DynamoDBDocumentClient,
    tableName: string
) {
    const handlers = createDynamoDBMemoryHandlers(docClient, tableName);
    return betaMemoryTool(handlers);
}
