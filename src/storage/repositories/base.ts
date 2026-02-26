import {
    type DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand,
    type GetCommandInput,
    type PutCommandInput,
    type DeleteCommandInput,
    type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';

export interface DynamoDBKey {
    PK: string
    SK: string
}

/**
 * Abstract base repository with common DynamoDB operations.
 * Concrete repositories should extend this class.
 */
export abstract class BaseRepository<_T> {
    protected readonly docClient: DynamoDBDocumentClient;
    protected readonly tableName: string;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.docClient = docClient;
        this.tableName = tableName;
    }

    protected async putItem(item: Record<string, unknown>): Promise<void> {
        const params: PutCommandInput = {
            TableName: this.tableName,
            Item:      item,
        };
        await this.docClient.send(new PutCommand(params));
    }

    protected async getItem<R>(key: DynamoDBKey): Promise<R | undefined> {
        const params: GetCommandInput = {
            TableName: this.tableName,
            Key:       key,
        };
        const result = await this.docClient.send(new GetCommand(params));
        return result.Item as R | undefined;
    }

    protected async deleteItem(key: DynamoDBKey): Promise<void> {
        const params: DeleteCommandInput = {
            TableName: this.tableName,
            Key:       key,
        };
        await this.docClient.send(new DeleteCommand(params));
    }

    protected async query<R>(params: Omit<QueryCommandInput, 'TableName'>): Promise<R[]> {
        const result = await this.docClient.send(new QueryCommand({
            TableName: this.tableName,
            ...params,
        }));
        return (result.Items ?? []) as R[];
    }
}
