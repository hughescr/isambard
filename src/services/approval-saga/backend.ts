import { logger } from '@hughescr/logger';
import { approvalSagaSchema, type ApprovalSaga, type ApprovalSagaState } from './types';
import { DynamoTableAccess, createPrefixedKey } from '@/storage';

const SAGA_PK        = 'APPROVAL#SAGA';
const SAGA_SK_PREFIX = 'SAGA';

const TTL_DAYS = 30;

function sagaSK(id: string): string {
    return createPrefixedKey(SAGA_SK_PREFIX, id);
}

/**
 * DynamoDB backend for persisting approval saga state.
 * Makes admin approval workflows durable across service outages.
 */
export class ApprovalSagaBackend extends DynamoTableAccess {
    /**
     * Persist a new approval saga with a 30-day TTL.
     */
    async create(saga: ApprovalSaga): Promise<void> {
        await this.putItem({
            PK:  SAGA_PK,
            SK:  sagaSK(saga.id),
            ...saga,
            TTL: ApprovalSagaBackend.expiresAt(Date.now(), { days: TTL_DAYS }),
        });
    }

    /**
     * Retrieve a saga by ID. Returns undefined if not found.
     */
    async get(id: string): Promise<ApprovalSaga | undefined> {
        const item = await this.getItem({
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
            logger.warn({ id, newState }, 'ApprovalSagaBackend.updateState: saga not found');
            return;
        }

        const updated: ApprovalSaga = {
            ...saga,
            ...extra,
            state:     newState,
            updatedAt: new Date().toISOString(),
        };

        await this.putItem({
            PK: SAGA_PK,
            SK: sagaSK(id),
            ...updated,
        });
    }

    /**
     * List all sagas that are in the given state.
     */
    async listByState(state: ApprovalSagaState): Promise<ApprovalSaga[]> {
        const items = await this.query({
            KeyConditionExpression:    '#pk = :pk',
            FilterExpression:          '#state = :state',
            ExpressionAttributeNames:  { '#pk': 'PK', '#state': 'state' },
            ExpressionAttributeValues: {
                ':pk':    SAGA_PK,
                ':state': state,
            },
        });

        const results: ApprovalSaga[] = [];
        for(const item of items) {
            const parsed = approvalSagaSchema.safeParse(item);
            if(parsed.success) {
                results.push(parsed.data);
            } else {
                // Stryker disable next-line llm: zod's ZodError.toString() is defined as () => this.message, so both spellings log the identical string.
                logger.warn({ item, error: parsed.error.message }, 'ApprovalSagaBackend.listByState: failed to parse saga');
            }
        }
        return results;
    }
}
