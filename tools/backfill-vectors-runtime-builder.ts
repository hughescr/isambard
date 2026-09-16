import type { BackfillDependencies } from './backfill-vectors';
import type {
    createDynamoDBClient,
    DynamoDBClientHolder,
    loadEmbedder,
    MemoryToolBackend,
    ModelQuant,
    ModelSlug,
    VectorIndex
} from '@/storage';

type ClientBundle = ReturnType<typeof createDynamoDBClient>;

export interface BackfillPlatform {
    createClient:    () => ClientBundle
    createHolder:    (client: ClientBundle['client'], docClient: ClientBundle['docClient']) => DynamoDBClientHolder
    createBackend:   (holder: DynamoDBClientHolder, tableName: string) => MemoryToolBackend
    openVectorIndex: (dbPath: string) => Promise<VectorIndex>
    loadModel:       (model: { slug: ModelSlug, quant: ModelQuant }) => ReturnType<typeof loadEmbedder>
    now:             () => number
    sleep:           (ms: number) => Promise<void>
    write:           (message: string) => void
    info:            (details: Record<string, unknown>) => void
}

export function sleepForRateLimit(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

export function clientDestroyer(client: { destroy: () => void }): () => void {
    return () => {
        client.destroy();
    };
}

export function createBackfillDependencies(platform: BackfillPlatform): BackfillDependencies {
    return {
        openStorage: () => {
            const { client, docClient, tableName } = platform.createClient();
            const holder = platform.createHolder(client, docClient);
            return {
                backend: platform.createBackend(holder, tableName),
                destroy: clientDestroyer(client),
            };
        },
        openVectorIndex: platform.openVectorIndex,
        loadModel:       platform.loadModel,
        now:             platform.now,
        sleep:           platform.sleep,
        write:           platform.write,
        info:            platform.info,
    };
}
