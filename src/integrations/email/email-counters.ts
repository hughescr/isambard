import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { EmailCounters } from '@/integrations/email/types';

const PK = 'EMAIL#COUNTERS';
const SK = 'STATS';

export class EmailCounterStore {
    private readonly docClient: DynamoDBDocumentClient;
    private readonly tableName: string;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.docClient = docClient;
        this.tableName = tableName;
    }

    /** Get current counter values. Returns { total: 0, unread: 0 } if item doesn't exist. */
    async getCounters(): Promise<EmailCounters> {
        const result = await this.docClient.send(
            new GetCommand({
                TableName: this.tableName,
                Key:       { PK, SK },
            })
        );
        if(!result.Item) {
            return { total: 0, unread: 0 };
        }
        return {
            total:  (result.Item.total as number) ?? 0,
            unread: (result.Item.unread as number) ?? 0,
        };
    }

    /** Reset counters to specific values (IMAP is source of truth). Uses SET expression. */
    async reset(total: number, unread: number): Promise<void> {
        await this.docClient.send(
            new UpdateCommand({
                TableName:                 this.tableName,
                Key:                       { PK, SK },
                UpdateExpression:          'SET #total = :total, #unread = :unread',
                ExpressionAttributeNames:  { '#total': 'total', '#unread': 'unread' },
                ExpressionAttributeValues: { ':total': total, ':unread': unread },
            })
        );
    }
}
