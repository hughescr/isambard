import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AllowlistEntry } from '@/integrations/email/types';
import { DynamoAllowlist } from '@/storage';

const ALLOWLIST_PK   = 'EMAIL#ALLOWLIST';
const ADDR_SK_PREFIX = 'ADDR#';

export class EmailAllowlist extends DynamoAllowlist<AllowlistEntry> {
    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        super(docClient, tableName, {
            pk:         ALLOWLIST_PK,
            skPrefix:   ADDR_SK_PREFIX,
            indexField: 'addresses',
            // Stryker disable next-line StringLiteral: name is only used in log messages
            name:       'Email',
        });
    }

    protected getEntryKey(entry: AllowlistEntry): string {
        return entry.email;
    }

    protected buildItem(entry: AllowlistEntry, normalizedKey: string): Record<string, unknown> {
        return {
            email:   normalizedKey,
            name:    entry.name,
            notes:   entry.notes,
            addedAt: entry.addedAt,
            addedBy: entry.addedBy,
        };
    }

    protected parseItem(item: Record<string, unknown>): AllowlistEntry {
        return {
            email:   item.email as string,
            name:    item.name as string | undefined,
            notes:   item.notes as string | undefined,
            addedAt: item.addedAt as string,
            addedBy: item.addedBy as string,
        };
    }
}
