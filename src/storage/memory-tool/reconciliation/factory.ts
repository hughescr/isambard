import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBClientHolder } from '../../client-holder';
import { reconciliationAccess, type MemoryToolBackend } from '../backend';
import { runTagIndexReconciliation, type ReconcilerDeps, type ReconcilerOptions } from './reconciler';
import { createTagIndexReconciliationScheduler, type TagIndexReconciliationScheduler } from './scheduler';
import type { ReconciliationConfig, ReconciliationResult } from './types';

/** Bind a memory backend's private reconciliation operations at the storage boundary. */
export function createMemoryTagIndexReconciliationScheduler(
    backend: MemoryToolBackend,
    config: ReconciliationConfig,
    deps: {
        docClient:          DynamoDBDocumentClient | DynamoDBClientHolder
        tableName:          string
        runReconciliation?: (deps: ReconcilerDeps, options: ReconcilerOptions) => Promise<ReconciliationResult>
    }
): TagIndexReconciliationScheduler {
    const { tagIndex } = backend[reconciliationAccess]();
    return createTagIndexReconciliationScheduler({
        config,
        runReconciliation: deps.runReconciliation ?? runTagIndexReconciliation,
        reconcilerDeps:    {
            docClient: deps.docClient,
            tableName: deps.tableName,
            tagIndex,
            getMemory: path => backend.get(path),
        },
    });
}
