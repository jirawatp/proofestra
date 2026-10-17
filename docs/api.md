# Local API contract

Status: draft design; no endpoint is implemented. The authoritative shape is
[openapi.yaml](openapi.yaml), OpenAPI 3.1.1. This page adds operational semantics.
Generate future types, mocks, and Postman requests from that source. No Postman
workspace or provider connection is needed for this local design review.

## Browser access

Base origin: `http://127.0.0.1:3000`; prefix `/api/v1`. This is the personal UI's
internal API, not a public developer service. UTF-8 JSON only except event streams.
API responses use Cache-Control: no-store and a generated X-Request-ID. Prompts
never appear in URLs.

The browser bootstraps through GET /session, receiving an HttpOnly, SameSite=Strict
session cookie and a CSRF token in JSON. Use Secure under HTTPS. Other operations
require that cookie. Writes also require X-CSRF-Token and Origin exactly matching
the configured origin. Missing/invalid session is 401; invalid origin/CSRF is 403.
Validate Host even on bootstrap and disable CORS. There are no accounts; trusted
local processes remain in the trust boundary. Refresh can bootstrap a new session
without losing persisted conversations.

## Resources

| Operation | Behavior |
| --- | --- |
| GET /session | Bootstrap session and CSRF; never calls providers. |
| GET /providers | Configured model IDs and masked readiness for all three providers; configuration is not verified availability. |
| GET /conversations | Cursor page, default 20/max 100, newest updated first with UUID tie-break. |
| POST /conversations | Create blank conversation; 201 and Location. |
| GET /conversations/{conversation_id} | Conversation metadata. |
| DELETE /conversations/{conversation_id} | Logical cascade deletion; 204 including absent IDs; 409 if active. |
| GET /conversations/{conversation_id}/messages | Cursor page, chronological sequence. |
| POST /conversations/{conversation_id}/runs | Atomically save prompt, snapshot, queued run; 201 and Location. |
| GET /runs/{run_id} | Snapshot and bounded artifacts; never starts/resumes work. |
| PUT /runs/{run_id}/cancellation | Cancel active work atomically; repeats return current terminal state. |
| GET /runs/{run_id}/events | Replay stored progress as SSE; never starts work. |
| GET /conversations/{conversation_id}/export | Versioned JSON with allowed artifacts; 409 if active. |

Cursors are opaque and scoped to endpoint/conversation. Invalid cursor is 400.
Lists return items and nullable next_cursor. Conversation pages are live views;
updates can move records. Message pages use stable sequences. Deletion invalidates
related cursors.

## Runs and safe retries

Require an Idempotency-Key UUID for each intended run. Persist key and normalized
request digest for the conversation lifetime. Same key/payload returns the original
run with 200 and its Location, including after restart. Different payload with the
same key is 409 idempotency_conflict. Resolve replay before the global active-run
guard; a distinct request during any active run is 409 run_in_progress.

Quick selects exactly one provider and plans one call. Team selects two or three
distinct providers and a synthesizer among them, planning 2n+1 calls. The browser
selects providers; the server snapshots configured model IDs. execution_mode
defaults to mock. Live requires server enablement and every selected provider
configured, otherwise 422 before any provider call.

Prompt maximum: 16,000 characters; JSON body maximum: 128 KiB. Reject additional
request properties. Validate cross-field limits, including enough attempts and
output allowance for the nominal workflow. Preserve the original snapshot/limits
on replay. A start returns queued state, not a completed answer.

Context policy all_history_v1 includes all visible prior user/final-answer turns
and the current prompt, frozen once with their message IDs. Preflight each model's
configured safe capacity, including instructions, output reserve, and worst-case
peer artifacts. No hidden history trimming or summarization is allowed. Reject
422 context_too_large before dispatch if it cannot fit; advise starting a new chat.
An unexpected later overflow preserves partial results and names the missing stage.

## Results and errors

Terminal states: completed, partial, failed, canceled, interrupted. Completed
means workflow completion, never factual correctness or verified sources. Quick
is unreviewed; Team names missing/failed stages. Sources remain unverified in MVP.
Zero successful drafts fails; one draft skips peer review and remains partial.
Synthesis failure exposes labeled drafts. Deadline yields partial/failed; restart
interrupts with no automatic resubmission. A provider failure is snapshot data,
not HTTP 500 when retrieving an otherwise valid run.

Cancellation may return completed if completion won the race. Once canceled,
late callbacks cannot replace content/state. Provider work may still be billed.

All errors: `{error: {code, message, request_id, details}}`. Field details never
echo sensitive values. Statuses: 401 missing session, 403 denied origin/CSRF,
404 unknown parent/run, 409 conflict, 413 oversized body, 422 semantic validation,
429 local admission limiting, 500 unexpected internal error. 429 includes
Retry-After; POST retries retain the original key. Never expose raw vendor errors,
credentials, authorization headers, or stack traces.

## Durable progress

SSE uses text/event-stream, numeric increasing IDs scoped to a run, and event names
run.started, step.updated, run.finished. data is an event envelope whose type matches
the SSE event name. Payloads contain bounded status, never raw token streams or
hidden reasoning.

```text
id: 4
event: step.updated
data: {"run_id":"11111111-1111-4111-8111-111111111111","sequence":4,"type":"step.updated","at":"2026-10-17T02:00:00Z","data":{"stage":"draft","provider":"openai","status":"completed"}}

```

Last-Event-ID resumes after that sequence; absent means replay from zero. Malformed,
negative, or future IDs return 400 before opening the stream. Events live until
conversation deletion. Comment heartbeats have no IDs. Close after terminal event.
Clients that already received its ID fetch the snapshot and stop reconnecting;
an event request at that terminal ID returns 204. Deletion returns 404. Dropping
the stream changes no run state. This is stage progress, not token streaming.

## Export

JSON has export_version: 1, exported_at, conversation, messages, and terminal run
snapshots. It contains user text and review artifacts; disclose before download.
Exclude cookies, CSRF tokens, keys, raw HTTP payloads, infrastructure logs, and
hidden reasoning. Provider/model IDs and normalized usage are allowed. Import is
outside MVP. [Technical design](technical-design.md) defines persistence/deletion limits.
