# Zotero (#157)

Izzy works in one Zotero library: the shared group **"Izzy-Craig Collab"** (group 6692257, private, owned by Craig; Izzy's account `isambard`, user 21862647, is a plain member). Izzy manages that library on its own, including items Craig added. There are no approval cards. The architecture summary is in [architecture.md](architecture.md#platform-integrations); this page is for the operator.

## Turning it on

The integration is off until the `ZoteroApiKey` SST secret is set. Set it from the checkout Izzy runs from, on the stage it runs under (add `--stage <stage>` if that is not your default stage). Pipe the key in on stdin, so it never appears in a process's command line where `ps` could see it:

```bash
op read 'op://Private/z3okqvyyusudopgkwoezdfkn24/API Key for user 21862647' | bunx sst secret set ZoteroApiKey
```

Then restart Izzy. Both the conversation and perch sessions get the `zotero` MCP server and `mcp__zotero__*` in their allowed tools. Startup makes no Zotero call, so a Zotero outage never blocks startup.

To turn it off, remove the secret (`bunx sst secret remove ZoteroApiKey`) and restart. The secret has an empty placeholder in `sst/secrets.ts`, so an unset or removed secret is an empty value, which counts as off; SST does not refuse to start.

The key never appears in logs, error messages or tool output, and it is only ever sent to `api.zotero.org`. Uploads to and downloads from Zotero's storage host carry no Zotero header.

## Optional overrides

| Env var | Default | Meaning |
|---|---|---|
| `ZOTERO_GROUP_ID` | `6692257` | The only library the client can address (`/groups/<id>`). |
| `ZOTERO_USER_ID` | `21862647` | Izzy's user id; used only to label items as `addedBy: izzy`. |
| `ZOTERO_MAX_STORED_FILE_BYTES` | `52428800` (50 MiB) | Largest file downloaded from Zotero storage, or uploaded from a local file. |
| `ZOTERO_CROSSREF_MAILTO` | unset | An email address sent to Crossref in the User-Agent, for its "polite" pool. |

An empty override counts as unset. URL fetches do **not** use `ZOTERO_MAX_STORED_FILE_BYTES`: they use the browser tool's caps (`browser.maxTextBytes` for HTML, `browser.maxScreenshotBytes` for PDFs, 2,000,000 bytes by default) and its host allowlist. Many papers are bigger than 2 MB, so a PDF fetched by URL often comes back as `pdf: "failed: ... too large ..."` while the paper itself is still added. Craig can drop the PDF in from his desktop, or raise the browser cap.

## What Izzy can and cannot do

The ten tools: `searchLibrary`, `getItems` (fields, abstract, child notes, attachments, and Craig's reader highlights and comments), `listCollections`, `addPapers` (DOI via Crossref, arXiv id via the arXiv API, or URL), `attachPdfs`, `downloadAttachments` (to `zotero-files/<key>/` under Izzy's working directory), `updateItems`, `writeNotes`, `manageCollections`, and `trashOrRestore`.

Rules the code enforces:
- **Only the shared group.** The client builds only `/groups/<ZOTERO_GROUP_ID>/...` paths plus the global item-template endpoint. The key can also reach Izzy's personal library, but nothing in the code addresses `/users/...`.
- **Trash only.** The client has no DELETE or PUT verb. "Delete" means moving an item or collection to the group Trash, which Craig can restore from. Izzy never empties the Trash. If a PDF upload fails, the empty attachment item it created is moved to the Trash, and only after a fresh read shows it unchanged and still empty.
- **No blind overwrites.** Edits to fields, creators, note text, or a collection's name or parent need the version Izzy read. If Craig changed the object since, nothing is written and Izzy gets a conflict naming who changed it. Tag and collection-membership changes are merged into the current item.
- **Batched writes.** Every create or update is one request per 50 objects. Zotero's `Backoff` and `Retry-After` are honoured across both sessions; a wait longer than a minute fails the call instead of stalling.
- **No duplicates.** `addPapers` checks the whole library, Trash included, for the same DOI, arXiv id or URL before creating anything. If that check cannot run, nothing is added.
- **Untrusted content.** Abstracts, notes, annotations, web pages and PDFs are third-party data. Tool results say so, note text Izzy writes is escaped, and downloaded file names are sanitised with a forced extension.
- **Contained files.** Local PDFs for upload are read, and downloads written, only under Izzy's working directory, without following symlinks at any level (`utils/contained-fs.ts`). On a platform other than macOS or Linux the two file tools fail closed and the other tools keep working.

Storage used by uploads counts against Craig's Zotero storage plan.

## Hand-off for the runtime directory

Add `zotero-files/` to `scratch/.gitignore` (next to `attachments/`), so downloaded papers stay out of Izzy's own repository. That directory is Craig's and Izzy's to manage.

## One-off live smoke check

Unit tests use fakes only. Before relying on the integration, run a one-off check against the real group. It writes to the shared library, so run it only with Craig's go-ahead, from a throwaway script outside the repo, with the key read through `op read` into a variable (never printed):

1. Create a collection `izzy-smoke`.
2. `addPapers` with `{arxivId: "1706.03762"}` into that collection. Its PDF is 2.2 MB, so with the default browser cap this exercises the "too large" path.
3. `attachPdfs` with a small local PDF (under 2 MB). Record the attachment's `version` and `md5` before and after, to confirm that registering an upload bumps the version and sets `md5` (the failed-upload cleanup relies on this).
4. `addPapers` again with the same arXiv id: expect `exists`.
5. `getItems` on the paper (children and attachment), then `downloadAttachments` (the md5 must match).
6. `updateItems`: add and remove a tag, then edit a field with a stale version to see the conflict.
7. `writeNotes`, then a `manageCollections` rename.
8. `trashOrRestore`: trash, restore, and trash again, for the item and for the collection. If Zotero rejects `deleted` on collections, the tool reports an error; it never falls back to a DELETE.
9. Leave both in the Trash. Craig empties it if he wants to.

Record the results on #157.
