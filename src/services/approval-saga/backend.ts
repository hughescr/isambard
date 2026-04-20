import { logger } from '@hughescr/logger';
import { approvalSagaSchema, type ApprovalSaga, type ApprovalSagaState } from './types';
import { BaseRepository, createPrefixedKey } from '@/storage';

// Stryker disable StringLiteral: PK/SK key constants are configuration values
const SAGA_PK        = 'APPROVAL#SAGA';
const SAGA_SK_PREFIX = 'SAGA';
// Stryker restore StringLiteral

const TTL_DAYS = 30;

function sagaSK(id: string): string {
    // Stryker disable next-line StringLiteral: SK prefix is a configuration constant
    return createPrefixedKey(SAGA_SK_PREFIX, id);
}

/**
 * DynamoDB backend for persisting approval saga state.
 * Makes admin approval workflows durable across service outages.
 */
export class ApprovalSagaBackend extends BaseRepository<ApprovalSaga> {
    /**
     * Persist a new approval saga with a 30-day TTL.
     */
    async create(saga: ApprovalSaga): Promise<void> {
        await this.putItem({
            // Stryker disable next-line StringLiteral: PK is a configuration constant
            PK:  SAGA_PK,
            SK:  sagaSK(saga.id),
            ...saga,
            TTL: ApprovalSagaBackend.ttlFromDays(TTL_DAYS),
        });
    }

    /**
     * Retrieve a saga by ID. Returns undefined if not found.
     */
    async get(id: string): Promise<ApprovalSaga | undefined> {
        const item = await this.getItem<Record<string, unknown>>({
            // Stryker disable next-line StringLiteral: PK is a configuration constant
            PK: SAGA_PK,
            SK: sagaSK(id),
        });
        if(item === undefined) {
            return undefined;
        }
        return approvalSagaSchema.parse(item);
    }

    /**
     * Update the state of a saga, along with optional extra fields.
     * If the saga is not found, logs a warning and returns (idempotent).
     */
    async updateState(
        id:       string,
        newState: ApprovalSagaState,
        extra?:   Partial<Pick<ApprovalSaga, 'adminUserId' | 'rejectionReason' | 'lastError'>>
    ): Promise<void> {
        const saga = await this.get(id);
        if(saga === undefined) {
            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            logger.warn({ id, newState }, 'ApprovalSagaBackend.updateState: saga not found');
            // Stryker restore ObjectLiteral,StringLiteral
            return;
        }

        const updated: ApprovalSaga = {
            ...saga,
            ...extra,
            state:     newState,
            updatedAt: new Date().toISOString(),
        };

        await this.putItem({
            // Stryker disable next-line StringLiteral: PK is a configuration constant
            PK: SAGA_PK,
            SK: sagaSK(id),
            ...updated,
        });
    }

    /**
     * List all sagas that are in the given state.
     */
    async listByState(state: ApprovalSagaState): Promise<ApprovalSaga[]> {
        // Stryker disable StringLiteral,ObjectLiteral: DynamoDB expression strings and attribute maps are configuration
        const items = await this.query<Record<string, unknown>>({
            KeyConditionExpression:    '#pk = :pk',
            FilterExpression:          '#state = :state',
            ExpressionAttributeNames:  { '#pk': 'PK', '#state': 'state' },
            ExpressionAttributeValues: {
                ':pk':    SAGA_PK,
                ':state': state,
            },
        });
        // Stryker restore StringLiteral,ObjectLiteral

        const results: ApprovalSaga[] = [];
        for(const item of items) {
            const parsed = approvalSagaSchema.safeParse(item);
            if(parsed.success) {
                results.push(parsed.data);
            } else {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.warn({ item, error: parsed.error.message }, 'ApprovalSagaBackend.listByState: failed to parse saga');
                // Stryker restore ObjectLiteral,StringLiteral
            }
        }
        return results;
    }
}
