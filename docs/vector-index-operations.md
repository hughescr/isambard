# Vector index operations

The memory vector index (`memory-vec.sqlite`, `src/storage/memory-vec-store/`) is derived data: DynamoDB is the record of truth, and the index can always be rebuilt from it. This page covers running the maintenance tools against the live file, backups, and rollback. See [architecture.md](architecture.md) ("Memory vector index") for the design.

## Running tools while Izzy is live

Every connection to the vector database sets `PRAGMA busy_timeout = 5000` and then `PRAGMA journal_mode = WAL` (`src/storage/memory-vec-store/connection.ts`), and every write transaction is IMMEDIATE. So the backfill and the orphan prune can run while Izzy has the file open:

- Readers never block on a writer, and a writer never blocks readers.
- When two connections want to write at once, the second one waits, synchronously, for up to 5 s. `bun:sqlite` is synchronous, so while Izzy is waiting its event loop is blocked for that time. The tools keep every transaction short (one row, one page of TTL updates, or one prune batch of at most 500 rows), so real waits are milliseconds.
- A wait longer than 5 s still fails with `database is locked`. That is a bounded wait, not a delivery guarantee. In Izzy the indexer retries SQLite busy/locked and embedding failures in memory for up to three total attempts, after 250 ms then 500 ms; a newer write for the same memory supersedes a pending retry. It logs and drops an exhausted or non-transient failure (`AsyncIndexer job failed: dropping and continuing`), and the next backfill repairs it. This retry state is process-local, so a restart also relies on a later write or backfill. In a tool, the failure is counted and the tool exits non-zero.

WAL notes:

- WAL adds `memory-vec.sqlite-wal` and `memory-vec.sqlite-shm` beside the database. They must stay beside it, and even read-only openers need them. **Never move or delete them while any process has the database open.**
- Committed pages can sit in the `-wal` file until a checkpoint, so a plain `cp` of `memory-vec.sqlite` while Izzy runs can miss committed data. Use the online backup below.
- WAL needs shared memory: keep the database on a local disk, never on a network or synced filesystem.
- The first open by #129 code switches the file to WAL, and the setting persists in the file header. If the switch cannot happen (for example, another connection holds a lock for more than 5 s), Izzy logs `Vector index could not switch to WAL; continuing in rollback-journal mode` and keeps running. busy_timeout still applies in that mode.

## TTL expiry (automatic)

Each row stores its memory's DynamoDB `TTL`. Queries hide expired rows immediately, and Izzy deletes them at startup and then every hour (`Pruned expired vector-index rows` at info level when there were any). This makes no DynamoDB reads. It runs only while the vector index is open, which needs the embedder to load. If the embedder is disabled, nothing is pruned or indexed until it is fixed.

TTL pruning deliberately does **not** create delete tombstones. A backfill page read after expiry only calls the non-inserting `setTtls`; a page read before expiry can at most restore the row with its already-expired TTL, which queries hide and the next hourly prune removes. A tombstone at the row's source version would permit that same-version upsert, while an invented newer marker could suppress a legitimate recreate.

## Search cost with selective filters (#135)

A semantic query may rerun local KNN with progressively more candidates when the nearest vectors are expired, outside the requested layer, or have malformed legacy paths. When sqlite-vec's 4096-candidate ceiling is reached on a larger index, the query makes one exact local Hamming-distance scan instead of returning a misleadingly short result. This can raise synchronous SQLite query latency for selective searches, but requires neither a rebuild of the live index nor additional DynamoDB reads. TTL and layer visibility stay the same.

## Drift cleanup runbook (#129)

Only Craig runs these steps. Izzy stays running throughout. Run every tool from the develop checkout, unsandboxed, under `sst shell --`, against the same stage Izzy uses.

**Always pass `--db-path` pointing at the live file Izzy uses.** Izzy's working directory is `scratch/`, and the config default is `memory-vec.sqlite`, so the file is `<repo>/scratch/memory-vec.sqlite`. Confirm it against Izzy's `Vector index initialized at …` startup log line. The tools' own default resolves relative to the checkout the tool runs from, which is a different file if you run from `running/`.

Below, `DB=/Users/craig/code/hughescr/isambard/scratch/memory-vec.sqlite`. Adjust it if the startup log says otherwise.

0. **Deploy.** Merge, deploy to `running/`, and restart Izzy. In the startup log, check for `Vector index initialized at …` and `Vector index prune scheduler started`, and make sure there is **no** `could not switch to WAL` warning. The first open adds the `ttl` and `source_updated_at` columns (instant; existing rows read NULL) and switches the file to WAL. Check it:

   ```bash
   /opt/homebrew/opt/sqlite3/bin/sqlite3 "$DB" 'PRAGMA journal_mode;'   # expect: wal
   ```

1. **Back up, online and WAL-safe.** Do not `cp` the file.

   ```bash
   BACKUP="$DB.pre-129-$(date +%Y%m%d%H%M).sqlite"
   /opt/homebrew/opt/sqlite3/bin/sqlite3 "$DB" ".backup '$BACKUP'"
   /opt/homebrew/opt/sqlite3/bin/sqlite3 "$BACKUP" 'PRAGMA quick_check; SELECT count(*) FROM memory_vectors;'
   ```

   `.backup` uses SQLite's online backup API and does not need the vec0 module.

2. **Per-layer backfill.** This fills the missing rows, fixes the stale ones, and stamps TTLs onto unchanged rows. It also stamps the TTL of items that have already expired (but that DynamoDB has not swept yet) onto their existing rows, without embedding them, so the hourly prune removes those rows. The events run stamps the live activity TTLs, so watch its `TTL updated` count.

   Izzy keeps writing while this runs, so a page can be older than a live write. Each row stores the DynamoDB `updatedAt` it reflects, and the backfill never overwrites a row with an older one: a TTL Izzy refreshed after the page was read is kept, and an item Izzy rewrote is reported as `Skipped (index already newer)`. A non-zero count there is expected, not an error.

   ```bash
   sst shell -- bun tools/backfill-vectors.ts --db-path "$DB" --layer identity
   sst shell -- bun tools/backfill-vectors.ts --db-path "$DB" --layer state
   sst shell -- bun tools/backfill-vectors.ts --db-path "$DB" --layer events
   sst shell -- bun tools/backfill-vectors.ts --db-path "$DB" --layer users
   ```

   Add `--force` to the users run only if #58's one-time forced users rewrite has not been done yet. The default pace is 2 RCU/s on GSI1, its provisioned capacity. `--dry-run` previews any step and writes nothing, TTLs included.

3. **Prune dry run.**

   ```bash
   sst shell -- bun tools/prune-vector-orphans.ts --db-path "$DB" | tee prune-dry-run.txt
   ```

   The prefix defaults to `/events/activity/`, the only namespace this tool accepts (`--prefix` may name a directory below it). The run uses strongly consistent, keys-only BatchGetItem reads of 1 RCU per key, paced at 2 RCU/s against the base table's 5. Expect about 30 minutes for about 3.4k rows. Check the printed `Table:`. Expect `Absent (orphans)` to be about 2,343, plus any activity rows DynamoDB has swept since 2026-09-24, and `Present in DynamoDB` to be above 0. `Malformed (untouched)` rows are listed and never deleted.

4. **Prune for real.**

   ```bash
   sst shell -- bun tools/prune-vector-orphans.ts --db-path "$DB" --execute | tee prune-execute.txt
   ```

   The prune recomputes the orphan list at run time. It then re-checks the orphans one paced BatchGetItem at a time and deletes the rows each request found absent as soon as that request returns, before it pauses for the next one, so the rate-limit pause never falls between a re-check and its delete. It deletes a row only if it is still the version it snapshotted (same content hash, `updated_at`, `ttl` and `source_updated_at`). Each successful deletion writes a short-lived (15-minute) delete-time tombstone in that same SQLite transaction, so a stale backfill page read before the prune is refused instead of recreating the orphan. A memory that reappeared in DynamoDB, or was re-indexed in the meantime, is kept and receives no tombstone. The prune refuses to run if every key under the prefix is absent (which usually means the wrong stage, table or credentials). Only `--allow-all-absent` overrides that. The re-check reads the orphans a second time, so allow about 50 minutes in total. The prune writes only the local SQLite file, never DynamoDB. It exits non-zero on any delete error or abort.

5. **Second backfill pass, all layers, no `--force`.**

   ```bash
   sst shell -- bun tools/backfill-vectors.ts --db-path "$DB"
   ```

   Expect `Indexed` to be only the items created during the run, and `TTL updated` to be about 0. That means the index has converged.

6. *(Optional)* Rerun the read-only index-drift measurement. Expect orphans, missing and stale all to be about 0. Rows past their TTL disappear at the next hourly prune.

### Remaining race (documented, not coordinated)

A memory re-created at an orphan's exact path between the prune's strongly consistent re-check read and the delete that follows it, and not yet re-indexed, loses its vector until its next write or the next backfill. The window is the network return of that one BatchGetItem request: the deletes run synchronously as soon as it returns, with no pacing pause or retry in between. Activity paths embed a millisecond timestamp, so this needs a same-path write inside that window. Step 5 repairs it regardless. (A re-creation that has already been re-indexed is safe even with the same content and TTL: the new write's `updatedAt` changes the row's `source_updated_at`, so the generation check keeps it.)

## Restore

Stop Izzy. Then delete `$DB-wal` and `$DB-shm`, copy the backup over `$DB`, and start Izzy again. The index is derived data, so a full rebuild is always possible instead: `sst shell -- bun tools/backfill-vectors.ts --db-path "$DB" --force`.

## Rollback

Reverting the #129 code needs no data step. The old code names its INSERT columns, so it ignores the nullable `ttl` and `source_updated_at` columns, and it opens a WAL-mode file normally. To return the file to rollback journaling, stop Izzy and run:

```bash
/opt/homebrew/opt/sqlite3/bin/sqlite3 "$DB" 'PRAGMA journal_mode=DELETE;'
```
