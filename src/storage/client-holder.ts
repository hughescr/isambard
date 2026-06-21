import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Grace period (ms) before a swapped-out DynamoDB client is destroyed.
 *
 * In-flight operations on the old connection pool have this window to complete
 * before the underlying sockets are torn down.  5 s is conservative relative to
 * the 30 s requestTimeout configured on the AWS SDK handler.
 */
const SWAP_GRACE_MS = 5000;

/**
 * Holds the live DynamoDB client pair and allows atomic swapping.
 *
 * All backends receive the holder at construction time and call
 * `getDocClient()` per-operation, so a `swap()` during reconnect
 * takes effect on the very next DynamoDB call — no stale references.
 */
export class DynamoDBClientHolder {
    private currentClient:    DynamoDBClient;
    private currentDocClient: DynamoDBDocumentClient;

    /**
     * Timer handle for a deferred `destroy()` of the previously-swapped-out client.
     * Only one pending destroy is tracked at a time; a second `swap()` during the
     * grace window cancels the first timer and starts a fresh one for the new
     * "old" client.
     */
    private pendingDestroyTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * The client waiting to be destroyed once the grace timer fires.
     * Stored so `holder.destroy()` can also synchronously destroy it.
     */
    private pendingDestroyClient: DynamoDBClient | null = null;

    constructor(initialClient: DynamoDBClient, initialDocClient: DynamoDBDocumentClient) {
        this.currentClient    = initialClient;
        this.currentDocClient = initialDocClient;
    }

    /** Returns the current raw DynamoDBClient. */
    getClient(): DynamoDBClient {
        return this.currentClient;
    }

    /** Returns the current DynamoDBDocumentClient. */
    getDocClient(): DynamoDBDocumentClient {
        return this.currentDocClient;
    }

    /**
     * Atomically swaps both clients.
     *
     * The old `DynamoDBClient` is NOT destroyed immediately.  Instead, a
     * {@link SWAP_GRACE_MS}-millisecond timer is scheduled so any in-flight
     * operations on the previous connection pool have time to complete before
     * sockets are torn down.
     *
     * If another `swap()` fires while the previous grace timer is still pending,
     * the earlier timer is cancelled and a fresh timer is started for the most
     * recently displaced client.  Only one pending destroy timer exists at a time.
     *
     * Call {@link destroy} on the holder itself to cancel any pending timer and
     * immediately destroy both the current and previous clients (e.g. on shutdown).
     */
    swap(newClient: DynamoDBClient, newDocClient: DynamoDBDocumentClient): void {
        // Cancel any existing pending destroy timer — the about-to-be-displaced
        // oldClient replaces it in the queue.
        if(this.pendingDestroyTimer !== null) {
            clearTimeout(this.pendingDestroyTimer);
            this.pendingDestroyTimer = null;
            // Eagerly destroy the previously-pending client: a newer displaced client is
            // taking its place in the queue, so there is no reason to keep it alive any
            // longer (it was about to be destroyed when the timer fired anyway).
            this.pendingDestroyClient!.destroy();
            this.pendingDestroyClient = null;
        }

        const oldClient = this.currentClient;
        this.currentClient    = newClient;
        this.currentDocClient = newDocClient;

        // Schedule deferred destroy so in-flight operations can complete.
        this.pendingDestroyClient = oldClient;
        this.pendingDestroyTimer = setTimeout(() => {
            oldClient.destroy();
            this.pendingDestroyTimer  = null;
            this.pendingDestroyClient = null;
        }, SWAP_GRACE_MS);
    }

    /**
     * Synchronously destroys the holder.
     *
     * Cancels any pending grace timer, then destroys both the current client
     * and any previously-swapped-out client that was still within its grace window.
     *
     * Call this from `app.stop()` to prevent timer leaks on graceful shutdown.
     */
    destroy(): void {
        if(this.pendingDestroyTimer !== null) {
            clearTimeout(this.pendingDestroyTimer);
            this.pendingDestroyTimer = null;
        }

        if(this.pendingDestroyClient !== null) {
            this.pendingDestroyClient.destroy();
            this.pendingDestroyClient = null;
        }

        this.currentClient.destroy();
    }
}

/**
 * Normalises a constructor argument that is either a raw `DynamoDBDocumentClient`
 * (used in tests) or a `DynamoDBClientHolder` (production) into a zero-argument
 * getter that always returns the *current* live client.
 *
 * Backends should call this in their constructor and store the returned getter.
 */
export function resolveDocClientGetter(
    clientOrHolder: DynamoDBDocumentClient | DynamoDBClientHolder
): () => DynamoDBDocumentClient {
    if(clientOrHolder instanceof DynamoDBClientHolder) {
        return () => clientOrHolder.getDocClient();
    }
    return () => clientOrHolder;
}
