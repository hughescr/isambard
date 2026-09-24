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
import { type DynamoDBClientHolder, resolveDocClientGetter } from '../client-holder';
import { epochSecondsSchema, type EpochSeconds } from './types';
import { withDynamoTimeout } from '@/storage/dynamo-retry';

export interface DynamoDBKey {
    PK: string
    SK: string
}

export interface DeleteItemOptions {
    operation?: string
    condition?: Pick<DeleteCommandInput, 'ConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'>
}

/**
 * Abstract base class wrapping common DynamoDB table operations.
 * Concrete repositories should extend this class.
 *
 * Accepts either a {@link DynamoDBClientHolder} (production — swappable on reconnect)
 * or a raw {@link DynamoDBDocumentClient} (tests — static, never swapped).
 *
 * The `docClient` getter calls through to the holder on every operation so that a
 * `holder.swap()` during DynamoDB reconnect is picked up immediately without
 * restarting backends.
 *
 * When `timeoutMs` is provided to the constructor, all DynamoDB operations
 * that also receive an `operation` string will be wrapped with `withDynamoTimeout`.
 * Existing subclasses that don't pass `timeoutMs` retain original behaviour (no timeout).
 *
 * `getItem`/`query`/`scan` return raw `Record<string, unknown>` values — this class has no
 * knowledge of any subclass's row shape. Subclasses are responsible for validating (typically
 * with a zod schema) whatever they read before treating it as typed data.
 */
export abstract class DynamoTableAccess {
    private readonly getDocClientFn: () => DynamoDBDocumentClient;
    protected readonly tableName:    string;
    protected readonly timeoutMs?:   number;

    constructor(client: DynamoDBDocumentClient | DynamoDBClientHolder, tableName: string, timeoutMs?: number) {
        this.getDocClientFn = resolveDocClientGetter(client);
        this.tableName = tableName;
        this.timeoutMs = timeoutMs;
    }

    /** Returns the current live DynamoDBDocumentClient. */
    protected get docClient(): DynamoDBDocumentClient {
        return this.getDocClientFn();
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

    protected async getItem(key: DynamoDBKey, operation?: string): Promise<Record<string, unknown> | undefined> {
        const params: GetCommandInput = {
            TableName: this.tableName,
            Key:       key,
        };
        if(this.timeoutMs !== undefined && operation !== undefined) {
            const result = await withDynamoTimeout(
                () => this.docClient.send(new GetCommand(params)),
                { timeoutMs: this.timeoutMs, operation }
            );
            return result.Item;
        }
        const result = await this.docClient.send(new GetCommand(params));
        return result.Item;
    }

    protected async deleteItem(key: DynamoDBKey, options: DeleteItemOptions = {}): Promise<void> {
        const params: DeleteCommandInput = {
            TableName: this.tableName,
            Key:       key,
            ...options.condition,
        };
        await (this.timeoutMs !== undefined && options.operation !== undefined
            ? withDynamoTimeout(() => this.docClient.send(new DeleteCommand(params)), { timeoutMs: this.timeoutMs, operation: options.operation })
            : this.docClient.send(new DeleteCommand(params)));
    }

    protected async query(params: Omit<QueryCommandInput, 'TableName'>, operation?: string): Promise<Record<string, unknown>[]> {
        const command = new QueryCommand({
            TableName: this.tableName,
            ...params,
        });
        if(this.timeoutMs !== undefined && operation !== undefined) {
            const result = await withDynamoTimeout(
                () => this.docClient.send(command),
                { timeoutMs: this.timeoutMs, operation }
            );
            return result.Items ?? [];
        }
        const result = await this.docClient.send(command);
        return result.Items ?? [];
    }

    protected async updateItem(
        params: Omit<UpdateCommandInput, 'TableName'>,
        operation: string
    ): Promise<UpdateCommandOutput> {
        const command = new UpdateCommand({ TableName: this.tableName, ...params });
        if(this.timeoutMs !== undefined) {
            return withDynamoTimeout(
                // Stryker disable next-line llm: then(r => r) forwards the same value or rejection; its extra microtask cannot change this timeout race.
                () => this.docClient.send(command),
                { timeoutMs: this.timeoutMs, operation }
            );
        }
        return this.docClient.send(command);
    }

    protected async scan(
        params: Omit<ScanCommandInput, 'TableName'>,
        operation: string
    ): Promise<Record<string, unknown>[]> {
        // Stryker disable next-line llm: params omits TableName and tableName is a string, so reversing the spread or appending an empty string changes nothing.
        const command = new ScanCommand({ TableName: this.tableName, ...params });
        if(this.timeoutMs !== undefined) {
            const result = await withDynamoTimeout(
                () => this.docClient.send(command),
                { timeoutMs: this.timeoutMs, operation }
            );
            return result.Items ?? [];
        }
        const result = await this.docClient.send(command);
        return result.Items ?? [];
    }

    /**
     * Constructs the DynamoDB `TTL` attribute value (epoch seconds, floored) for an item that
     * should expire `duration` after `base`. `base` may be a `Date` or an epoch-millisecond
     * number (e.g. `Date.now()`, or a persisted row's `createdAt` to recompute the original
     * expiry). The one shared constructor for every backend's row expiry — see EpochSeconds.
     */
    public static expiresAt(base: Date | number, duration: { days?: number, hours?: number }): EpochSeconds {
        const baseMs = base instanceof Date ? base.getTime() : base;
        const seconds = Math.floor(baseMs / 1000) + (duration.days ?? 0) * 86_400 + (duration.hours ?? 0) * 3600;
        return epochSecondsSchema.parse(seconds);
    }
}
