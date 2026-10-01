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
| `ZOTERO_MAX_STORED_FILE_BYTES` | `52428800` (50 MiB) | Largest file downloaded from Zotero storage, uploaded from a local file, or fetched by URL as a PDF. |
| `ZOTERO_CROSSREF_MAILTO` | unset | An email address sent to Crossref in the User-Agent, for its "polite" pool. |

An empty override counts as unset. URL fetches use the browser host allowlist, but Zotero's own byte caps: a URL PDF is capped by `ZOTERO_MAX_STORED_FILE_BYTES` (50 MiB by default, with exactly-at-cap files accepted), and HTML is read up to 1 MiB. The Zotero server does not require browser byte caps. The existing 30 s per-request timeout covers connection, headers and body, but not the preceding DNS lookup; a large PDF from a slow host may time out before reaching the file-size cap.

A URL fetch connects only to the host's checked DNS answers, but it is given all of them, so a host whose IPv6 address is unreachable from here is still fetched over IPv4.

arXiv ids go through the arXiv export API, falling back to the `arxiv.org/abs/<id>` page (one request per id, read through its `citation_*` tags) when the API is throttled (429), failing (5xx) or breaks mid-transfer (a network error, timeout, or a body that fails to read). Any other API error, such as a 400, is reported without a fallback. Both paths give the same item (a `preprint` with the `10.48550/arXiv.<id>` DOI, `arXiv:<id>` archive id and abs URL), so duplicate detection treats them alike; the abs page has no journal reference, and a journal DOI it lists appears only as `Published version DOI:` in `extra`. All arXiv requests share arXiv's 3 s spacing, and an integer `Retry-After` is honoured per host and held in memory (a restart clears it, a later shorter one never shortens it, and nothing waits it out): during an API cooldown lookups go straight to the abs pages, and during an abs cooldown a lookup that needs the fallback fails at once. When both fail the error names both.

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

Storage used by uploads counts against Craig's Zotero storage plan. The per-file cap is not a batch memory bound: loaded PDF buffers are retained until the batched store, so at the defaults a 20-paper `addPapers` call can hold about 1000 MiB and a 10-file `attachPdfs` call about 500 MiB of PDF payload, plus transient copies; fetch concurrency of 3 does not bound that retention.

## Hand-off for the runtime directory

Add `zotero-files/` to `scratch/.gitignore` (next to `attachments/`), so downloaded papers stay out of Izzy's own repository. That directory is Craig's and Izzy's to manage.

## One-off live smoke check

Unit tests use fakes only. Before relying on the integration, run a one-off check against the real group. It writes to the shared library, so run it only with Craig's go-ahead, from a throwaway script outside the repo, with the key read through `op read` into a variable (never printed):

1. Create a collection `izzy-smoke`.
2. `addPapers` with `{arxivId: "1706.03762"}` into that collection. Its 2.2 MB PDF is under the default Zotero file-size cap and should attach, no longer exercising the "too large" path.
3. `attachPdfs` with that PDF's URL on the new item (or a local PDF under the Zotero file-size cap). Record the attachment's `version` and `md5` before and after, to confirm that registering an upload bumps the version and sets `md5` (the failed-upload cleanup relies on this).
4. `addPapers` again with the same arXiv id: expect `exists`.
5. `getItems` on the paper (children and attachment), then `downloadAttachments` (the md5 must match).
6. `updateItems`: add and remove a tag, then edit a field with a stale version to see the conflict.
7. `writeNotes`, then a `manageCollections` rename.
8. `trashOrRestore`: trash, restore, and trash again, for the item and for the collection. If Zotero rejects `deleted` on collections, the tool reports an error; it never falls back to a DELETE.
9. Leave both in the Trash. Craig empties it if he wants to.

Record the results on #157.
