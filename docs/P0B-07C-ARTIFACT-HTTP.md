# P0B-07c — Artifact Metadata and Download API

## Endpoints

Both endpoints require a bearer token accepted by the configured tenant authenticator.

### `GET /v1/tasks/:taskId/artifacts`

The API validates `taskId` as a UUID and first loads the Task through the tenant-scoped
`TaskStore`. A missing Task and a Task owned by another tenant both return the same 404.
Only then does the Artifact store query published Artifact metadata with both `tenant_id` and
`task_id` predicates. The result is ordered by `created_at ASC, id ASC`.

Success returns `{ task_id, artifacts }`. Each entry contains `artifact_id`, `sha256`, `size`,
`media_type`, `created_by`, and `created_at`. A visible Task without published Artifacts returns
`artifacts: []`. Storage keys, filesystem paths, tenant ids, and SQL are not part of the DTO.

### `GET /v1/artifacts/:artifactId`

The API validates `artifactId` as a UUID and calls `PostgresArtifactStore.find()` with the
authenticator-produced `AuthContext`. A missing or foreign-tenant Artifact returns the same 404.
The response uses the persisted media type and exact byte length, and sets
`X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.

The handler then calls `PostgresArtifactStore.get()`. That method reads through the controlled
BlobStore and verifies SHA-256 and size on the exact byte buffer it returns. The HTTP response
is constructed only after the full read and verification succeed; a corrupt/missing blob is
mapped to a sanitized storage error and no body bytes are sent.

## Authorization and visibility

The tenant id comes only from the verified `AuthContext`. Task visibility is established by
`PostgresTaskRepository.get()` before listing. Artifact listing and lookup use tenant-scoped
queries; listing also joins the `blobs` row. Thus staged data, installed orphan files, and
uncommitted database rows are not exposed. Unknown ids and cross-tenant ids share the same 404
response.

## Runtime configuration

Set `EMBER_API_BLOB_ROOT` to an absolute path for the API process to enable Artifact reads. It
must point to the same controlled blob root used by the worker (`EMBER_WORKER_BLOB_ROOT`). If
it is unset, Artifact routes remain authenticated and fail closed with 503. The route does not
accept or derive file paths from request parameters.

## Validation

Automated coverage is in `tests/unit/api-artifact-http.test.ts` and
`tests/integration/http-artifact-api.test.ts`. The integration suite uses a real PostgreSQL
schema plus `LocalBlobStore` to verify committed visibility, tenant isolation, byte/hash
integrity, response headers, and fail-closed corruption handling. Repository-wide validation
results are recorded in the pull request description.

## Known limits

- Upload, deletion, sharing links, and public CDN delivery are out of scope.
- Downloads are buffered in memory up to the existing 32 MiB BlobStore limit. A streamed
  integrity check runs before the response buffer is allocated, then the exact returned buffer
  is checked again to cover a file change between reads.
- The API and worker must share access to the configured local blob root; remote object storage
  is not introduced by this phase.
