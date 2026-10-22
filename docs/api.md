# Local API contract

Status: implemented subset in this working tree on branch
`codex/project-traceability` — **uncommitted and unpublished**, so a fresh
clone of the public remote does not include it. [openapi.yaml](openapi.yaml)
defines request and response shapes: every operation there is labelled
`x-proofestra-status: implemented_v1` (served, and checked against real responses by
`tests/integration/openapi_contract.test.ts`) or `design_only` (not served); this
page defines application invariants. See [agents](agents.md), [tools](tools.md), [shared
extensions](extensions.md), [scaling](scaling.md), and [provider
capabilities](provider-capabilities.md).

## Implementation status (2026-10-21)

**Implemented in v1 (routed by `src/server/routes/`, covered by
`tests/integration/`):**

- `GET /api/v1/session`, cookie + CSRF token issuance.
- `GET /api/v1/providers` (adds `capabilities: {pdf_text_extraction,
  media_metadata_probe}`: booleans only, whether the bounded local PDF/media
  parsers are installed; never a path, version, or environment value; the
  top-level `live_enabled` is unchanged; `catalog_source` is
  `{source, file_configured}` and never carries the profiles-file path;
  `native_backends` lists sanitized native CLI states: `backend_id`, `provider`,
  `kind: "native_cli"`, `readiness`, a fixed `reason_code`, `credentials:
  "vendor_managed"`, `billing: "subscription_quota_cost_unknown"`, `tool_surface`
  and the unproven control IDs; never a path, version, login state or vendor text;
  runs on a non-`configured` native profile are refused 422 `backend_not_ready`,
  a Live run with a native agent additionally requires `tool_policy.bounds_mode:
  "bounded_job"`, `allow_unknown_internal_usage: true` and `required_controls`
  within `deadline`, `context_isolation`, `harness_invocations` or is refused 422
  `unsupported_bounds`, native output reported above the requested ceiling fails
  that step, and an admitted run's snapshot carries the frozen `native_backends[]`
  policy),
  `GET /api/v1/runtime-policy`.
- `GET/POST /api/v1/conversations`, `GET` and `DELETE /api/v1/conversations/:id`,
  `GET /api/v1/conversations/:id/messages`,
  `GET /api/v1/conversations/:id/runs`,
  `GET /api/v1/conversations/:id/export`.
- `POST /api/v1/conversations/:id/runs`, `GET /api/v1/runs/:id`,
  `PUT /api/v1/runs/:id/cancellation`, `GET /api/v1/runs/:id/events` (SSE
  with `Last-Event-ID` replay, monotonic sequence guards, snapshot
  fallback).
- `POST /api/v1/conversations/:id/attachments` (multipart upload behind a
  store-wide gate; per-upload / per-store / per-count limits enforced;
  known @fastify/multipart / @fastify/busboy error codes mapped to
  `400 too_many_files` (`FST_FILES_LIMIT`), `413 attachment_limit`
  (`FST_REQ_FILE_TOO_LARGE` and the composer/store quotas), and
  `400 multipart_malformed`
  (`ERR_STREAM_PREMATURE_CLOSE`, `FST_PARTS_LIMIT`, `FST_FIELDS_LIMIT`,
  `FST_PROTO_VIOLATION`)); the row flips to `ready` only after multipart
  EOF; cleanup never unlinks `ready` or already-bound blobs.
  Upload error statuses (all `{error:{code,message,request_id}}`): `400
  validation_failed` (bad id, no or extra file part), `409 attachment_limit`
  (draft-count cap reached), `413 attachment_limit` (size/composer/store
  quota while streaming), `415 mime_mismatch` (declared MIME contradicts the
  sniffed bytes), `429 upload_busy` (store-wide gate queue full), `499
  client_closed_request` (client went away), `504 upload_timeout` (120 s
  deadline), `507 attachment_quota` (local store already at its cap), and
  `409 attachment_removed` (the row was DELETEd while processing).
- `GET /api/v1/attachments/policy`,
  `GET /api/v1/conversations/:id/attachments`,
  `GET /api/v1/attachments/:id/preview`,
  `GET /api/v1/attachments/:id/download`,
  `DELETE /api/v1/attachments/:id` (`204`; `404` unknown id; `409
  attachment_bound` for a row already bound to a sent message or no longer
  deletable; `409 attachment_removed` goes to the in-flight upload request, not
  to the DELETE caller; preview /
  download set a strict sandboxed CSP that the global `onSend` hook
  preserves; `X-Content-Type-Options: nosniff`; `Cache-Control: no-store`;
  `Content-Disposition` uses the ASCII fallback + RFC 5987 `filename*=UTF-8''`
  form so filenames with non-ASCII characters remain safe). `GET
  …/preview` returns `422 preview_unavailable` with no raster bytes
  when a raster image's persisted sniffed dimensions are unknown,
  invalid, or exceed the preview-safety caps (per-side 4096 /
  pixel-area 16 Mpx — the same bounds as native eligibility). `GET
  …/download` still serves the same bytes with `Content-Disposition:
  attachment`, so a user-initiated download remains possible while
  eager `<img>` embedding on the preview surface never triggers a
  browser download or decode.

  **Implementation note.** The routes above are exactly what the v1 server
  registers. The longer `/conversations/:id/attachments/:aid/...` forms and
  `GET /conversations/:id/attachments/:aid` are only a design shape and are NOT served by v1. `docs/openapi.yaml` now documents these
  routes as `implemented_v1` (contract-checked against real responses); this page
  remains the authority for their invariants. The export (`GET /conversations/:id/export`, version 1)
  carries `export_version`, `exported_at`, `conversation`, `messages` (with
  attachment refs: metadata only) and `runs` (full snapshots, including
  `context.attachments` refs and `attachment_coverage`); the richer export
  contents described later in this page are design scope.

  **Attachment DTO.** Besides id, display name, sniffed MIME, kind, size, hash,
  state, `extraction_status` (`none | text_extracted | truncated | encrypted |
  unsupported | failed`), and `extraction_coverage {extracted_chars, truncated,
  label}`, the DTO and message refs carry sanitized metadata, each `null` when
  unknown (for media that failed validation, duration/streams may still hold
  probe-reported values: only `normalized_media_mime` signals success): `sniffed_width`/`sniffed_height` (PNG/GIF/WebP), `sniffed_pdf_pages`,
  `sniffed_media_duration_ms`, `sniffed_media_streams_json` (codec_type,
  codec_name, dimensions, channels, sample rate; at most 8 streams),
  `validated_media_format` (ffprobe `format_name`, stored only for a validated
  file), and `normalized_media_mime`
  (set only after a successful probe; `video/quicktime` becomes `video/mov` only
  when validated). Validated audio/video reads `Metadata only — no
  transcription`; nothing is transcribed.

  **Media preview guard.** `GET …/preview` for audio or video returns
  `422 preview_unavailable` (JSON, no media bytes) unless a finite duration, a
  normalized MIME and parseable streams were persisted (audio needs an audio
  stream; video needs at least one video stream and EVERY video stream
  positive and bounded). The server and the client share one rule
  (`isMediaPreviewValidated`). This covers hostile headers (for example 65535×65535), corrupt files,
  unknown durations, and media uploaded before metadata probing existed;
  `…/download` still serves the exact bytes as an attachment. The preview
  Content-Type remains the IANA sniffed MIME. Preview eligibility is structural
  validation only and never implies provider support.

  **Upload cancellation.** Closing the request or the response before the
  response is written aborts parsing: the child process or worker is terminated,
  the row is marked `failed` with code `client_closed_request`, the blob is
  removed, and only then is the store-wide upload gate released. A queued
  upload whose client disconnects never holds the gate. The failed row stays in
  `GET …/attachments` until deleted (the composer hides and deletes it).
  `DELETE /api/v1/attachments/:id` of a row still `uploading` aborts its parse
  (child/worker terminated and awaited) and the original upload request ends
  `409 attachment_removed`. `DELETE /api/v1/conversations/:id` does the same for
  every in-flight upload of that conversation (abort and await, then cascade),
  so an upload racing a conversation delete ends 409, never 500. Media duration
  rule: the container duration must be present and valid (otherwise the file is
  unvalidated), a stream that reports an invalid duration (non-positive,
  unparsable, over 24 h) makes the file unvalidated, and for valid files the
  policy duration is the largest of the container and stream durations.

  **Run context.** A run snapshot's `context.attachment_coverage[]` lists, for
  each agent, every attachment (history first) with `route` (`native_image |
  native_pdf | native_audio | native_video | extracted_text | attachment_only`)
  and a specific `reason` for any non-native route. Creating a run returns
  `409 attachment_pending|attachment_failed|attachment_bound` for a named
  attachment that is not `ready`, and `422 attachment_metadata_invalid` when a
  stored attachment's metadata no longer validates for a native route (remove
  the file and upload it again).

**Enforced invariants (regression-tested):** loopback-only `Host`, `Origin`
allowlist, session cookie, `X-CSRF-Token` on mutations; 128 KiB JSON cap;
no-store + `X-Request-ID` on every response; `tool_policy.mode` must be
`"off"` and `delegation.enabled` must be `false` (422 at admission
otherwise); live mode double-gated by `PROOFESTRA_LIVE_ENABLED=1` AND
per-run `execution_mode: "live"`.

**Not implemented in v1 (deferred):** tool execution, delegation /
helper spawning, MCP bridges, SDK/CLI job backends, shared-extension
loading, hosted-service backends, package-manager write endpoints, Postman
workspace tooling. Admission rejects any run that attempts these.

Confirmed design scope includes provider API tools, local agent applications, SDKs
and CLIs, MCP tools, and hosted agent services. Compatibility and implementation
are staged per registered adapter; this scope does not claim live integration.
Shared skills, plugin bundles and custom MCP servers are also confirmed design
scope; no loader, installer or MCP broker is implemented.

## Browser boundary

Default origin is `http://127.0.0.1:3000`, API prefix `/api/v1`. This is a personal,
same-origin UI API. Validate Host, disable CORS, keep prompts out of URLs, and apply
`Cache-Control: no-store` plus a generated `X-Request-ID` to every response. Request
bodies are UTF-8 JSON, maximum 128 KiB; event responses use SSE.

`GET /session` sets an HttpOnly, SameSite=Strict cookie and returns a CSRF token.
Use Secure under HTTPS. All other operations require the cookie; mutations also
require `X-CSRF-Token` and the exact configured Origin. Refresh can bootstrap a
session without losing history. This is not multi-user authentication: trusted
local processes remain in the trust boundary; public/LAN exposure needs another design.

## Resources

| Operation | Semantics |
| --- | --- |
| GET /session | Bootstrap local cookie/CSRF without provider calls. |
| GET /providers | Paginated registered providers and configured profiles; no keys or live checks. |
| GET /capabilities | Paginated catalog filtered by q, provider, profile_id, backend_id, backend_kind or extension_id. |
| GET /extensions | Paginated shared registration metadata filtered by q, extension_id, kind, scope or profile_id. |
| GET /runtime-policy | Versioned personal defaults and finite deployment ceilings; read only. |
| GET /conversations | Cursor page, newest updated first with UUID tie-break. |
| POST /conversations | Create blank conversation; 201 and Location. |
| GET /conversations/{conversation_id} | Read metadata. |
| DELETE /conversations/{conversation_id} | Logical cascade; 204 even when absent; 409 while active. |
| GET /conversations/{conversation_id}/messages | Stable chronological message sequence. |
| POST /conversations/{conversation_id}/runs | Atomically admit a run and freeze its configuration. |
| GET /runs/{run_id} | Current snapshot/lineage plus first page of tool execution records. |
| GET /runs/{run_id}/tool-executions | All tool execution/route records by stable execution sequence, paginated. |
| POST /runs/{run_id}/tool-approvals | Approve/deny one pending exact action; never create a blanket grant. |
| PUT /runs/{run_id}/cancellation | Stop local scheduling and request cancellation across descendants/jobs. |
| GET /runs/{run_id}/events | Replay durable progress; never start or resume work. |
| GET /conversations/{conversation_id}/export | Full versioned logical export after all runs are terminal. |

Pages default to 20 items, maximum 100, with `items` and nullable `next_cursor`.
Cursors are opaque and scoped to endpoint, filters and conversation/run. Invalid
cursors return 400. Conversation pages are live views; updates can move entries.
Message/execution sequences remain stable even as an execution's status changes.
Deletion invalidates associated cursors. Tool pages prevent a large tool history
from being silently dropped from the run snapshot; exports include every record.

## Registry, agents and compatibility

Provider IDs are registered strings, not a fixed enum. OpenAI, Anthropic and Gemini
remain initial integration targets. Additional providers require validated adapter
manifests. Provider/profile registration is operator configuration, not a model
permission or a new browser endpoint. Listing metadata makes no discovery/model call.

An `AgentDefinition` has a run-scoped UUID, name, catalog profile ID and optional
bounded role. Different agents may share a provider, model or profile. Duplicate
agent IDs are invalid. A profile references `execution_backend_id`; backend kinds
are `provider_api`, `agent_sdk_cli`, `mcp_local`, and `hosted_agent`. These describe
different execution and control surfaces, not interchangeable implementations.

Versioned capability entries describe a tool/profile/backend combination, its
compatibility evidence, readiness, authentication needs, permission scopes, egress,
observability and enforceable execution controls. Documented support is distinct
from tested compatibility or current availability. No tool is assumed universal
across a provider's models, API routes, SDK/CLI versions or authentication modes.

## Shared extension catalog

`GET /extensions` returns authorized cached metadata for registered skills, plugin
bundles and custom MCP servers. Register once in the harness and reuse the same
registration across compatible connected profiles. Per-profile projections are
instructions, direct functions, native MCP, a harness bridge, permitted delegation
or unsupported. A connected provider does not imply that every contribution works.
Delegation still requires helpers enabled and an already allowed profile.

The stable configured `extension_id` identifies the registration. It is separate
from package/display names and MCP `serverInfo.name`. Records include kind,
immutable version/SHA-256 digest, sanitized origin/license, trust/status,
global/workspace scope, and compatibility/readiness. Callable capability/tool IDs
use `ext.<extension_id>.<local_id>`; provider wire aliases are deterministic,
collision-checked projections within provider naming limits. Validate the exact
namespace and unique registration/projection identities server-side.
Extension-prefixed records require server-derived provenance. Contribution and
profile arrays in extension metadata are previews capped at 100 entries each;
page `/capabilities?extension_id=...` with profile/provider/backend filters for
callable contributions and their compatibility, rather than treating a preview as
the complete catalog or injecting it all into model context.

Skill metadata describes instructions/resources; advisory `allowed-tools` content
cannot grant execution permission. A bounded internal loader supports instruction
injection when a model has no filesystem access. Scripts use separately permitted
tool execution. A plugin manifest is a harness bundle/import format; native vendor
hooks, authentication and install formats require compatible adapters. Resources
and prompts are not silently converted into callable tools.

MCP metadata names a configured broker registration, declared/negotiated protocol
version and transport adapter, authentication readiness and sanitized endpoint
origin. Supported transports are tested stdio or Streamable HTTP; legacy SSE needs
an explicit adapter. Do not assume a universal initialize/session lifecycle across
protocol families. Private operator configuration holds launch/environment/resource
settings and secret-store references. Browser/model metadata never contains those
settings, raw credential-bearing URLs, tokens or credential references. Remote
origins omit userinfo, paths and queries; stdio has no endpoint origin.

Catalog reads do not fetch package bodies, discover/connect MCP servers, access
credentials, execute hooks/scripts or invoke models. Registration/enablement is
operator configuration in this draft; installer/admin write APIs need a separate
design. There is no model-accessible install or grant endpoint. The existing
`ToolInvocationRequest`, route, grant, approval, budget and idempotency contracts
apply to both native and bridged tool projections; the server derives provenance.

Optional run `extension_refs` selects exact already registered authorized content.
Omission uses the existing authorized selection, empty when none. Freeze resolved
versions/digests/scope with the run, with one version per registration; snapshots and exports retain provenance plus
concise per-agent `extension_activations`, also emitted as `extension.activated`.
Activation records identify permitted resources/context placement without copying
all skill bodies/assets into events or exports. Repeated activation reuses the
agent's existing version/resource record rather than adding hidden duplicate context.
Apply package/resource scope, licensing and context-fit checks before loading.

One discovery-active version exists per registration/scope. Retained old content
is not a duplicate default installation; an existing pinned run may use it only
when explicitly retained enabled and authorized. Recheck version/digest, enablement,
revocation, branch/resource scope and current grants before every load/dispatch.
Disable/remove/revoke/supersede invalidates affected pending work and bound approval;
unrelated registry changes do not cancel unaffected pinned runs. Stop affected
running work best-effort, preserving unknown external completion and no automatic replay.

Shared registration does not share root drafts, private results, mutable scratch
or session/resource handles. Keep state and grants per run/root branch; common
preexisting read-only sources may be shared. During independent drafting, a route
without adequate isolation is ineligible. Connection pooling cannot mix credentials,
workspace scope, mutable handles or sibling-branch context.

## Root workflow

Quick has one root, no root peer review, and no synthesizer. Team has at least two
roots within effective deployment policy, with `synthesizer_agent_id` identifying
one of them. The present `all_peers` topology plans n drafts, n reviews and one
synthesis: `base_planned_calls = 2n+1`; three roots still have seven base calls.
This counts root harness calls before delegation/tool continuations, not fixed
runtime work. Children are not extra root votes. Bounded-peer and hierarchical
topologies need later designs and are not accepted enum values yet. Large teams
must still pass context, work and deadline admission; no unbounded scaling is implied.

## Admission, context and dynamic limits

Every start requires an `Idempotency-Key` UUID. Persist its normalized payload
digest for the conversation lifetime. Same key/payload returns the original run
with 200/Location, including after restart; changed payload returns 409
`idempotency_conflict`. Resolve replay before the one-global-active-run guard.
Queued, running, waiting-for-tool/children and awaiting-approval work is active.
Live submissions include expected catalog/policy versions from the displayed
configuration; a version change returns 409 before dispatch. A distinct start
during active work returns 409 `run_in_progress`. Persist prompt,
run, frozen profiles/capabilities/extensions/policy/grants, key/digest and first event atomically.

Execution defaults to mock. Live requires server enablement and compatible,
authorized configured routes. Team defaults to delegation enabled and tool mode
`auto`; Quick defaults to both off. Auto means select a useful eligible route
inside existing scope, not enable all tools. Freeze allowed tool, backend, helper
profile IDs and references to existing task/session grants. Models cannot mint
grants, add destinations or change the selected root synthesizer. Recheck grant
expiration/revocation and scope before every dispatch; broader changes need a new
run. Explain every
possible root/helper/tool destination and data flow before live submission.

`all_history_v1` freezes all visible prior user/final-answer turns plus the new
prompt (maximum 16,000 characters), with exact message IDs. Preflight base work
against configured safe input capacities including instructions and output reserve.
No hidden trimming or summarization. Reject 422 `context_too_large` before dispatch
if the base workflow cannot fit. Recheck actual child/tool/continuation material;
deny an oversized optional route or preserve partial results when required work
cannot finish. Drafting branches never receive current peer-root drafts or children;
review access begins only after the root draft barrier. Opaque runtimes that cannot
preserve required context isolation are ineligible for that workflow.

`GET /runtime-policy` advertises defaults and finite server deployment ceilings.
Requests may lower bounds or choose higher values only within those ceilings; they
cannot enlarge policy by submitting their own limits or remove mandatory server
permission/context controls. Snapshot the policy version
and effective limits. Counts below are personal defaults, not product ceilings:

| Limit | Personal default |
| --- | --- |
| Observable harness invocations / tool operations / native jobs | 32 / 64 / 4 |
| Concurrent harness calls globally / per provider | 3 / 2 across every profile of that provider |
| Overall / per-call / native-job deadline | 300 / 45 / 120 seconds, bounded by remaining run time |
| Output per harness call / aggregate requested output | 2,048 / 65,536 tokens |
| Root / total accepted / spawned agents | 6 / 12 / 6 |
| Direct accepted children over an agent's lifetime / depth | 2 / 2, roots at depth 0 |
| Safe rejection retries | 1 per logical step, across its initial/continuation sequence |

Quick with helpers and tools both off uses one harness call and no retry. Opting
into either uses shared defaults while keeping one unreviewed root. Reserve
harness calls, observable operations, jobs and output before local dispatch;
preserve required unfinished root work and the parent's continuation before optional
work. Accepted nodes consume lifetime quotas even after failure/cancellation.

The 45-second clock covers direct requests and native-job launch acknowledgement.
A separately supervised native job has its own 120-second lifetime, within the
remaining overall deadline; these are distinct control scopes.

A harness invocation is a call Proofestra schedules; one native API request or SDK
query can contain multiple internal model/tool operations. Ledgers distinguish
`harness_invocations`, `tool_operations_observed`, `native_jobs_started`, internal
counts/visibility and estimated/unknown cost. An unknown internal count is null,
not zero and not one. The 32 default never promises a global internal-call cap.

A `strict` route is eligible only when the backend can enforce the requested
controls, including any required internal limits. Otherwise decline it. Explicit
`bounded_job` mode with `allow_unknown_internal_usage: true` may run an opaque job
only with an enforceable launch/job deadline and authorized scope; label its
unobservable internal work and cancellation limits. Backend execution caps are
snapshotted per job. Observations learned after remote execution can exceed a local
admission threshold; report that rather than claiming retrospective enforcement.
Only retry known pre-generation rejections, never ambiguous sent requests or actions
with uncertain side effects. Output limits and estimates do not guarantee billing.

## Tool routing and approvals

Adapters normalize an internal `ToolInvocationRequest` naming a bounded capability,
optional specific tool, scoped task and schema-validated arguments. The server
supplies caller/run/step/invocation IDs. It selects a directly compatible native
tool or a helper route within frozen allowlists, grants and execution controls.
`RouteDecision` records direct, delegated, awaiting_approval, blocked or unavailable.
The server also derives run/root-branch identity and binds resource/session handles
to that context. A model-supplied branch ID or handle is data, never authority to
read another branch or choose its credentials.
Tool-created managed helpers require `delegation.enabled`; auto tool mode cannot
bypass helpers-off. A native backend must also honor disabled helper spawning or
be ineligible, even in bounded-job mode. No eligible route means a visible
limitation, never a fabricated result, new
provider destination or silent synthesizer replacement.

Use a matching task/session grant when it already authorizes the operation,
including appropriate reversible actions. If authorization is missing, pause the
exact action when policy permits approval, or block it. Parents enter
`waiting_for_tool` or `awaiting_approval` and release execution permits; the overall
deadline continues. Approval cannot expand the frozen destination/tool/profile
allowlists or repair an incompatible backend.

`POST /runs/{run_id}/tool-approvals` requires the pending approval ID, execution ID,
SHA-256 digest of the exact normalized nonsecret arguments, and approve/deny. Bind
that pending record to the run/caller, tool/profile/backend, task and policy version.
For extension tools, bind the exact version/digest/namespace and resource scope as
well; changed content cannot reuse an old approval. The trusted approval UI and its credentials must be isolated from agent-controlled
browsers, shells and MCP environments; Origin/CSRF alone does not prove a human
action. The UI displays the complete nonsecret action preview and referenced credential
scope; actual secret values remain server-side. A changed action invalidates approval.
The response only records the decision; dispatch still requires budget and current
run state. Missing/stale/mismatched pending action is 409. An Idempotency-Key replays
the same decision; changed payload/decision conflicts. No double execution or grant
minting is allowed by duplicate callbacks or model-supplied IDs.

Tool executions retain safe argument previews/digests, routes, grants, concise
results, external status and accounting. Raw credentials, headers, hidden reasoning
and unrestricted vendor traces are excluded. A retrieved source gets origin,
retrieval time and location; `retrieved` is not `verified`. Track retrieval and
claim-support assessment separately, with checked/supported/disputed/unknown states.

## Delegation and durable identity

`spawn_subagent` remains internal, with a bounded task and optional preapproved
profile. The server derives parent/root/depth. Deduplicate spawn and tool actions by
`(run_id, agent_id, step_id, parent_invocation_id, provider_tool_call_id)` plus digest.
Matching payload replays the original decision; changed payload is denied without
creating/executing another child/action. A vendor tool-call ID reused in a new
parent invocation is a new request within lifetime quotas.

Parents waiting for children release global/provider permits. One logical parent
continuation is scheduled per invocation response batch, not per duplicate callback;
several child/tool results may share it. Children and any continuation consume
budget. Denied optional work alone does not make a run partial; accepted child
failure or required unfinished root work does. Preserve visible denial reasons.
Parent links must be same-run, acyclic, reciprocal and depth-consistent. Enforce
unique IDs, membership, policy limits, grant scope and accounting relationships in
application validation; JSON Schema cannot express all cross-record invariants.

## Completion, cancellation and recovery

Terminal runs are completed, partial, failed, canceled or interrupted. Completed
means the authorized required workflow finished, not factual correctness. Missing
Team reviews, accepted child failure or draft fallback is partial; zero successful
root drafts fails. With one surviving draft, skip peer review. A synthesis failure
exposes labeled drafts. Never silently replace the selected synthesizer.

Stop prevents new local children/tools/continuations and propagates cancellation
across the tree and native jobs. Already completed side effects are not reversed.
If a remote stop cannot be confirmed, preserve `external_status: unknown` or
`orphaned`; never fake canceled external work. Keep workflow terminal state immutable;
separate later external-status/usage reconciliation may append audit events without
resuming the run. Restart interrupts local unfinished work; reconcile known remote
job IDs when possible, otherwise mark unknown/orphaned, with no automatic resubmission.
A disconnected event stream does not stop or duplicate a run. Sent work may be billed.

Errors use `{error: {code, message, request_id, details}}`: 400 malformed input;
401 missing session; 403 denied Host/origin/CSRF; 404 absent resource; 409 conflict;
413 oversized body; 422 semantic/profile/context/control validation; 429 local
admission limiting with Retry-After; 500 unexpected failure. Errors never echo
sensitive values. Specific codes added by DLOG-017: `400 invalid_cursor`
(malformed `?cursor=`), `415 unsupported_media_type` (non-multipart upload),
`422 validation_failed` (a requested run limit above a deployment ceiling), and a
root handler so any unexpected error uses this envelope with a fixed 5xx message
(never the thrown message). A malformed percent-encoded session cookie is treated
as absent: protected routes return 401 `unauthorized` and `GET /session` issues a
fresh session, never 500. The SSE endpoint flushes response headers immediately. Tool denials/provider failures are run data, not retrieval HTTP 500.

## Events, export and deletion

SSE uses increasing run-scoped numeric IDs and typed bounded envelopes. Events
cover runs, agent/step lineage, spawns, extension activation, routes, tool execution, approval and external
reconciliation. Completed helper/tool events include concise permitted results and
accounting; no raw token stream or private reasoning. Persist transitions and events
atomically. `Last-Event-ID` replays after that sequence; absent means zero. Invalid,
negative or future IDs return 400. Comment heartbeats have no IDs. Close at a
workflow terminal event; clients fetch snapshots/pages for later external reconciliation.
For a terminal run, a cursor at the latest stored sequence returns 204. If newer
reconciliation records exist, an explicit replay returns them and closes when
caught up. Deletion returns 404.

Export version 1 includes conversation/messages and complete terminal run trees,
all tool/route/approval records, frozen extension provenance/concise activations,
source provenance and scoped accounting. It is not
a paginated snapshot preview. Downloads contain user/task text; disclose before
export. Delete/export reject active runs with 409. Deletion cascades through local
records, but does not erase backups, SQLite pages, downloads, or provider-side
history; unknown/orphaned external work may continue. Import is outside this design.
