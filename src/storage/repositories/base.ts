import {
    type DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    UpdateCommand,
    ScanCommand,
    type GetCommandInput,
    type PutCommandInput,
    type DeleteCommandInput,
    type QueryCommandInput,
    type UpdateCommandInput,
    type UpdateCommandOutput,
    type ScanCommandInput
} from '@aws-sdk/lib-dynamodb';
import { withDynamoTimeout } from '@/storage/dynamo-retry';

export interface DynamoDBKey {
    PK: string
    SK: string
}

/**
 * Abstract base repository with common DynamoDB operations.
 * Concrete repositories should extend this class.
 *
 * When `timeoutMs` is provided to the constructor, all DynamoDB operations
 * that also receive an `operation` string will be wrapped with `withDynamoTimeout`.
 * Existing subclasses that don't pass `timeoutMs` retain original behaviour (no timeout).
 */
export abstract class BaseRepository<_T> {
    protected readonly docClient:  DynamoDBDocumentClient;
    protected readonly tableName:  string;
    protected readonly timeoutMs?: number;

    constructor(docClient: DynamoDBDocumentClient, tableName: string, timeoutMs?: number) {
        this.docClient = docClient;
        this.tableName = tableName;
        this.timeoutMs = timeoutMs;
    }

    protected async putItem(item: Record<string, unknown>, operation?: string): Promise<void> {
        const params: PutCommandInput = {
            TableName: this.tableName,
            Item:      item,
        };
        await (this.timeoutMs !== undefined && operation !== undefined
            ? withDynamoTimeout(() => this.docClient.send(new PutCommand(params)), { timeoutMs: this.timeoutMs, operation })
            : this.docClient.send(new PutCommand(params)));
    }

    protected async getItem<R>(key: DynamoDBKey, operation?: string): Promise<R | undefined> {
        const params: GetCommandInput = {
            TableName: this.tableName,
            Key:       key,
        };
        if(this.timeoutMs !== undefined && operation !== undefined) {
            const result = await withDynamoTimeout(
                () => this.docClient.send(new GetCommand(params)),
                { timeoutMs: this.timeoutMs, operation }
            );
            return result.Item as R | undefined;
        }
        const result = await this.docClient.send(new GetCommand(params));
        return result.Item as R | undefined;
    }

    protected async deleteItem(key: DynamoDBKey, operation?: string): Promise<void> {
        const params: DeleteCommandInput = {
            TableName: this.tableName,
            Key:       key,
        };
        await (this.timeoutMs !== undefined && operation !== undefined
            ? withDynamoTimeout(() => this.docClient.send(new DeleteCommand(params)), { timeoutMs: this.timeoutMs, operation })
            : this.docClient.send(new DeleteCommand(params)));
    }

    protected async query<R>(params: Omit<QueryCommandInput, 'TableName'>, operation?: string): Promise<R[]> {
        const command = new QueryCommand({
            TableName: this.tableName,
            ...params,
        });
        if(this.timeoutMs !== undefined && operation !== undefined) {
            const result = await withDynamoTimeout(
                () => this.docClient.send(command),
                { timeoutMs: this.timeoutMs, operation }
            );
            return (result.Items ?? []) as R[];
        }
        const result = await this.docClient.send(command);
        return (result.Items ?? []) as R[];
    }

    protected async updateItem(
        params: Omit<UpdateCommandInput, 'TableName'>,
        operation: string
    ): Promise<UpdateCommandOutput> {
        const command = new UpdateCommand({ TableName: this.tableName, ...params });
        if(this.timeoutMs !== undefined) {
            return withDynamoTimeout(
                () => this.docClient.send(command),
                { timeoutMs: this.timeoutMs, operation }
            );
        }
        return this.docClient.send(command);
    }

    protected async scan<R>(
        params: Omit<ScanCommandInput, 'TableName'>,
        operation: string
    ): Promise<R[]> {
        const command = new ScanCommand({ TableName: this.tableName, ...params });
        if(this.timeoutMs !== undefined) {
            const result = await withDynamoTimeout(
                () => this.docClient.send(command),
                { timeoutMs: this.timeoutMs, operation }
            );
            return (result.Items ?? []) as R[];
        }
        const result = await this.docClient.send(command);
        return (result.Items ?? []) as R[];
    }

    protected static ttlFromDays(days: number): number {
        return Math.floor(Date.now() / 1000) + days * 86_400;
    }

    protected static ttlFromHours(hours: number): number {
        return Math.floor(Date.now() / 1000) + hours * 3600;
    }
}
