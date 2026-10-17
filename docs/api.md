# Local API contract

Status: draft design; no endpoint or provider integration is implemented. The
shape is [openapi.yaml](openapi.yaml), OpenAPI 3.1.1. This page supplies operational
and cross-field rules that a schema alone cannot enforce. See [agent policy](agents.md).
Generate future types, mocks, and Postman requests from the contract. No Postman
workspace or provider connection is needed to inspect this design.

## Browser access

Base origin: `http://127.0.0.1:3000`; prefix `/api/v1`. This is the personal UI's
internal API. UTF-8 JSON only except events; maximum request body 128 KiB. Responses
use `Cache-Control: no-store` and a generated `X-Request-ID`. Prompts never appear
in URLs. Validate Host even on bootstrap and disable CORS.

`GET /session` sets an HttpOnly, SameSite=Strict local cookie and returns a CSRF
token. Use Secure under HTTPS. All other operations require the cookie; writes
also require `X-CSRF-Token` and an Origin exactly matching the configured origin.
Missing session is 401; denied Host/origin/CSRF is 403. There are no accounts;
trusted local processes remain in the trust boundary. Refresh can bootstrap a new
session without losing history. Public/LAN exposure needs a separate design.

## Resources

| Operation | Behavior |
| --- | --- |
| GET /session | Bootstrap session and CSRF without provider calls. |
| GET /providers | Three provider entries with server-configured model-profile catalogs; no keys or live checks. |
| GET /conversations | Cursor page, default 20/max 100; newest updated first with UUID tie-break. |
| POST /conversations | Create blank conversation; 201 and Location. |
| GET /conversations/{conversation_id} | Conversation metadata. |
| DELETE /conversations/{conversation_id} | Logical cascade deletion; 204 including absent IDs; 409 while active. |
| GET /conversations/{conversation_id}/messages | Cursor page in stable chronological sequence. |
| POST /conversations/{conversation_id}/runs | Atomically save prompt, agent/configuration snapshot, and queued run. |
| GET /runs/{run_id} | Snapshot, lineage, bounded artifacts and spawn decisions; never start/resume work. |
| PUT /runs/{run_id}/cancellation | Cancel active run and descendants atomically; repeats return current state. |
| GET /runs/{run_id}/events | Replay durable progress without starting work. |
| GET /conversations/{conversation_id}/export | Versioned JSON including terminal run trees; 409 while active. |

Cursors are opaque and endpoint/conversation scoped. Invalid cursors return 400.
Lists return `items` and nullable `next_cursor`. Conversation pages are live views;
updates may move entries. Message sequences are stable. Deletion invalidates cursors.

## Root agents and profiles

`RunCreate.agents` contains `AgentDefinition` objects: a run-scoped UUID `agent_id`,
name (1–80 characters), server catalog `profile_id`, and optional concise role.
Agent identity is independent of provider and model. Repeated providers and
profiles are legal; duplicate agent IDs are not. Clients cannot submit model IDs,
credentials, parent IDs, or runtime lineage. Catalog profile IDs are globally unique.

Quick has one root agent and no synthesizer. Team has two to six roots and requires
`synthesizer_agent_id` to identify one of them. Its base plan is `n` drafts, `n`
peer reviews, and one synthesis: `2n+1` calls. The default three-root team still has
seven base calls. Children do not add root votes or peer reviewers. When fewer than
two root drafts survive, skip peer reviews. Never silently substitute a synthesizer.

Each provider catalog may contain multiple profiles. A profile exposes its ID,
model ID, configured safe input capacity, readiness, and delegation compatibility.
Readiness means local configuration, not proven availability. Mark delegation
supported only after the adapter/profile's internal tool-request round trip has
been checked. The design does not use vendor-native agent or subagent services.
The first live acceptance requires a compatible delegating profile for each of
OpenAI, Anthropic, and Gemini; that compatibility is not implemented or asserted now.

## Run admission, context and limits

Require an `Idempotency-Key` UUID for each intended run. Persist the key and
normalized request digest for the conversation lifetime. Same key/payload returns
the original snapshot with 200 and Location, including after restart; changed
payload returns 409 `idempotency_conflict`. Resolve replay before the one-global-
active-run guard. A distinct start while any run is active returns 409 `run_in_progress`.
Persist prompt, configuration, key/digest, run and initial event atomically.

`execution_mode` defaults to mock. Live requires server enablement and configured
selected/allowed profiles. Delegation defaults enabled for Team and disabled for
Quick; `allowed_profile_ids` is the user's frozen allowlist for alternate child
profiles, default empty (inheritance only). Models cannot expand that permission.
Before live submission, disclose every possible destination from root and allowed
helper profiles, including cross-provider tasks/results. Enabling delegation
requires supported profiles. Reject invalid or unavailable
configuration with 422 before dispatch. A start returns queued, not an answer.

The current prompt has at most 16,000 characters. `all_history_v1` freezes every
visible prior user/final-answer turn plus this prompt and records their message IDs.
No hidden trimming or summarization is allowed. Preflight configured safe capacities
with instructions, output reserve, root peer artifacts and bounded delegation input.
Reject 422 `context_too_large` before any call if the base workflow cannot fit.
Each spawn/continuation is checked again; deny an oversized child branch or preserve
a partial result if later required stage input cannot fit. Children inherit the same
frozen history plus a scoped task and permitted branch artifacts; during drafting,
no current peer-root drafts enter that branch. Review branches receive only the
review stage's authorized material. No provider-specific silent truncation.

| Effective limit | Proposed default/ceiling |
| --- | --- |
| All dispatched invocations | 32; includes roots, children, parent continuations and safe retries |
| Concurrent invocations | 3 global, at most 2 per provider across all profiles/agents |
| Overall / per-call deadline | 300 / 45 seconds; child work shares the run deadline |
| Requested output | 2,048 tokens per invocation, 65,536 aggregate allowance |
| Root / total / spawned agents | 6 / 12 / 6 |
| Accepted children per agent / depth | 2 over the agent's lifetime / 2 with roots at depth 0 |
| Rejected-request retries | At most 1 per logical step, inside every other limit |

Quick with helpers disabled has one invocation and no retry; explicitly enabling
helpers uses the shared 32-invocation defaults while preserving one root and no
root peer review/synthesis. `base_planned_calls` stays 1. Team base counts are 5,
7, 9, 11, or 13. A base plan is not a promise of the eventual dynamic call count.

Reserve attempts and maximum output atomically before dispatch, including batches.
Only retry an explicit safe rejection known to precede generation, never an
ambiguous sent request/timeout. Unknown usage stays unknown; retain conservative
output reservations. Output ceilings bound scheduling/requested output, not input
charges or a monetary billing guarantee. Dollar estimates need a dated price source.

## Bounded internal delegation

Adapters normalize a model's `spawn_subagent` request to `SpawnRequest`. The server
supplies the run, parent agent, parent step, parent invocation and provider tool-call
IDs; the model
supplies only a bounded task/name and optional profile selection. There is no public
spawn endpoint or browser-authorized tool execution, and no arbitrary external tool.

Deduplicate by `(run_id, parent_agent_id, step_id, parent_invocation_id, provider_tool_call_id)` plus
normalized request digest. Matching replays return the original decision/child;
changed payload gets an `invalid_request` denial without changing that decision or
creating another child. The same tool-call ID in another parent invocation is a new
request under the lifetime quotas. IDs alone cannot select another parent or run.
Malformed arguments are recorded as a safe denial with a null normalized request.

Before accepting, check enabled policy, profile allowlist/readiness/compatibility,
context, depth and lifetime quotas, remaining deadline, and reservations for the
child's initial invocation, parent continuation, and unfinished required root work.
Create the child/decision/reservations atomically. Accepted nodes consume lifetime
quotas even if later failed or canceled. Child profile inherits its parent
unless an alternate profile was preapproved. Child IDs are server generated.
Parents enter `waiting_for_children` and release their concurrency slot; the root
stage cannot complete until descendants settle and the parent continuation finishes.
One parent response batch (keyed by parent_invocation_id) schedules one logical
continuation; duplicate callbacks cannot resume it again. Multiple children may
share that continuation. Its safe retry still counts and uses the step's single
retry allowance across the entire initial/continuation sequence.

A denial creates no child and dispatches no extra model invocation by itself. Its
concise notice can reach the parent's ordinary continuation only if budget remains.
Record accepted/denied decisions and safe reasons visibly. A denied optional spawn
does not alone make a run partial; any accepted child failure does. Exhaustion that
prevents a required root stage still makes the workflow partial/failed.

## State, artifacts and errors

Runs: queued → running → completed, partial, failed, canceled, or interrupted.
`AgentSnapshot` includes stable run-scoped agent ID, parent/root IDs, depth, profile,
provider/model, task, child IDs and runtime status. Steps have unique `step_id` and
`agent_id`; stages include helper work. Invocation records distinguish initial,
continuation and retry calls, with exact dispatched totals. The same provider may
appear in many steps; it is never their identity. Parent links must form an acyclic
tree, match root/depth/child links, and stay inside the same run. Enforce these and
unique IDs, synthesizer membership, effective limits and profile rules in application
validation; JSON Schema cannot express all cross-record relationships.

Completed means all required root work and accepted child work completed, never
factual correctness. Missing Team review, accepted child failure, provider failure
or draft fallback means partial; zero successful root drafts fails. Sources remain
unverified. Synthesis failure exposes labeled drafts. Overall deadline yields
partial with a root draft, failed without one. Cancellation may return completed
if completion won the race; once canceled, late callbacks cannot replace state or
artifacts. Terminal roots cancel unfinished descendants. Run cancellation cancels
the whole tree. Restart marks unfinished runs/agents/steps interrupted with no
automatic resubmission. Provider work already sent may still be billed. SSE
disconnection neither cancels nor duplicates a run.

Errors use `{error: {code, message, request_id, details}}`. 400 is malformed input;
401 missing session; 403 denied Host/origin/CSRF; 404 unknown parent/run; 409 conflict;
413 body too large; 422 semantic/readiness/context validation; 429 local admission
limiting with Retry-After; 500 unexpected internal failure. Field details never echo
sensitive values. Provider/child failures and spawn denials are run data, not HTTP
500 on retrieval. Do not expose vendor payloads, keys, headers or private reasoning.

## Durable progress and export

SSE has increasing numeric IDs scoped to a run. Event names match `EventEnvelope.type`:
`run.started`, `agent.created`, `agent.updated`, `step.updated`, `spawn.decided`, and
`run.finished`. Agent/step events include their IDs and lineage; spawn events carry
the bounded decision. Agent-created events name the profile/task; completed helper
step events include the concise result and usage. Step updates distinguish step
attempts from the run-wide count. Snapshot/export preserve the entire tree, tasks, concise
results, denials, base plan and actual usage. Events carry no raw token stream.

`Last-Event-ID` resumes after its sequence; absent replays after zero. Malformed,
negative or future IDs return 400 before streaming. Persist events until deletion;
comment heartbeats have no IDs. Close after terminal event. A request already at
the terminal ID returns 204; clients fetch the snapshot and stop reconnecting.
Deletion returns 404. Event transitions and stored state are atomic.

Exports contain `export_version: 1`, timestamp, conversation, messages and terminal
run snapshots, including descendants. Disclose that downloads contain user/task
text and review artifacts. Exclude cookies, CSRF tokens, keys, raw HTTP payloads,
infrastructure logs and private reasoning. Import is outside MVP. Deletion is
logical, not forensic erasure of backups, downloads, SQLite pages or provider data.
