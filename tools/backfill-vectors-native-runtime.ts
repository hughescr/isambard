import { logger } from '@hughescr/logger';
import { Resource } from 'sst';
import type { BackfillDependencies } from './backfill-vectors';
import { createBackfillDependencies, sleepForRateLimit } from './backfill-vectors-runtime-builder';
import { loadDynamoDBConfig } from '@/config';
import {
    createDynamoDBClient,
    DynamoDBClientHolder,
    loadEmbedder,
    MemoryToolBackend,
    VectorIndex
} from '@/storage';

export interface BackfillNativeServices {
    resource:     typeof Resource
    loadConfig:   typeof loadDynamoDBConfig
    createClient: typeof createDynamoDBClient
    Holder:       typeof DynamoDBClientHolder
    Backend:      typeof MemoryToolBackend
    Index:        typeof VectorIndex
    loadModel:    typeof loadEmbedder
    now:          () => number
    sleep:        (ms: number) => Promise<void>
    write:        (message: string) => void
    info:         (details: Record<string, unknown>) => void
}

export const productionBackfillServices: BackfillNativeServices = {
    resource:     Resource,
    loadConfig:   loadDynamoDBConfig,
    createClient: createDynamoDBClient,
    Holder:       DynamoDBClientHolder,
    Backend:      MemoryToolBackend,
    Index:        VectorIndex,
    loadModel:    loadEmbedder,
    now:          Date.now,
    sleep:        sleepForRateLimit,
    write:        (message) => { process.stdout.write(message); },
    info:         (details) => { logger.info(details); },
};

export function createNativeBackfillDependencies(services: BackfillNativeServices = productionBackfillServices): BackfillDependencies {
    return createBackfillDependencies({
        createClient:    () => services.createClient(services.loadConfig(services.resource)),
        createHolder:    (client, docClient) => new services.Holder(client, docClient),
        createBackend:   (holder, tableName) => new services.Backend(holder, tableName),
        openVectorIndex: dbPath => services.Index.open(dbPath),
        loadModel:       model => services.loadModel(model),
        now:             () => services.now(),
        sleep:           ms => services.sleep(ms),
        write:           (message) => { services.write(message); },
        info:            (details) => { services.info(details); },
    });
}
