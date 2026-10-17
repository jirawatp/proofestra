# Technical design

Status: proposed design, 17 October 2026. No application backend or API is implemented.
See [requirements](requirements.md), [experience](experience.md), and [API](api.md).
The canonical identity, delegation, and shared-limit policy is in
[agents and subagents](agents.md).

## Deployment and stack

Design default: TypeScript throughout; React with Vite for the chat interface;
Fastify on Node.js for the API, static assets, and bounded run coordinator; SQLite
for local persistence. Use one long-lived server process on one machine. Build
the client into static assets served by the same origin. No external database,
queue service, account system, or commercial service is needed for the core.

This is a recommendation for personal self-hosting, not an installed stack. Pin
supported package, adapter SDK, and Node LTS versions with a lockfile when building.
The standalone prototype has no runtime dependencies and is separate from this stack.

| Choice | Reason and tradeoff |
| --- | --- |
| React + Vite | Interactive UI with static build output; requires a client build. |
| Fastify | Explicit HTTP validation and long-lived scheduler boundary; more setup than a full-stack UI framework. |
| SQLite | Simple local persistence for one owner; multiple instances and network-mounted databases are out of scope. |
| REST + server-sent events | Ordinary writes and replayable one-way progress; token-by-token streaming is later. |
| Direct provider adapters | Preserve provider-specific errors and usage; requires maintaining three compatibility paths. |

References checked during design: [Vite](https://vite.dev/guide/),
[Fastify](https://fastify.dev/docs/latest/Reference/Server/),
[SQLite deployment guidance](https://sqlite.org/whentouse.html), and
[SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).
These establish platform capabilities; the architecture is our design choice.

## Components

```mermaid
flowchart LR
    UI[Browser chat] -->|Same-origin REST and events| API[Local API]
    API --> DB[(SQLite)]
    API --> RUN[Bounded coordinator]
    RUN --> MOCK[Deterministic mock adapters]
    RUN --> OA[OpenAI adapter]
    RUN --> AN[Anthropic adapter]
    RUN --> GE[Gemini adapter]
    RUN --> DB
```

Future layout: `src/web`, `src/server`, `src/core`, `src/providers`, `src/storage`,
and `tests/fixtures`. These directories are not scaffolded yet. Keep orchestration
independent of the HTTP framework. Adapters accept normalized text, an explicit
model ID, output ceiling, deadline, and abort signal. They return text, concise
review findings, available usage, and typed errors. Validate provider output as
untrusted data; never request or retain private chain-of-thought or raw HTTP traces.
Normalize bounded spawn_subagent requests and child tool results through adapters.
Proofestra owns orchestration; provider-native subagent services are not assumed.

## Workflow

Agent identity is independent of provider/model profile. Users may configure
multiple named agents with the same provider, identical profiles, or different
configured models from one provider. Team has two to six roots; the default is
one each from OpenAI, Anthropic, and Gemini. Quick has one root, with helpers off
by default; explicitly enabling helpers does not imply root peer review.
Snapshot agent IDs, roles, profile/model IDs, frozen context, delegation allowlist,
prompt versions, destinations, and limits at run creation.

1. Draft concurrently from the same relevant user context without seeing current peer drafts.
2. After drafting ends, each eligible agent reviews the other successful drafts.
3. One selected root agent synthesizes drafts and concise findings,
   preserving material disagreements, uncertainty, and missing stages.

One review round has a base plan of `2n + 1` root invocations: seven for three
roots. Children, parent continuations, and retries increase actual calls inside
the same budget. Helpers return work to parents and never count as extra root
reviewers. Synthesis targets an agent ID even when roots share provider/model.
No vote or completion badge establishes truth. MVP sources remain unverified.

Eligible roots and children can delegate during drafting, review, or synthesis,
within depth limits. Persist server-derived ancestry and deduplicate spawn delivery.
Waiting parents release global/provider slots. Resume each parent only after its
accepted batch ends. Each root branch stays isolated from current peer drafts
until review; a child finishing cannot bypass the root-draft barrier.

Context policy `all_history_v1` freezes all preceding user/final-assistant turns
and the new prompt, recording their message IDs in the run/export. No hidden
summarization, provider-specific trimming, or memory retrieval occurs. Before
dispatch, check each selected model's configured safe input capacity, including
instructions, reserved output, and worst-case peer artifacts for later stages.
Use local conservative counting when exact counts are unavailable and label the
estimate. Missing safe-capacity configuration blocks Live readiness. If the shared
context cannot fit, reject with `422 context_too_large` and suggest a new chat;
make no provider call. An unexpected later context error yields partial material,
never silent truncation or resubmission with different context.
Children inherit frozen history plus scoped tasks/branch artifacts. Check actual
child tasks and parent tool results before spawn/continuation; refuse unsafe fits
instead of silently dropping history or results.

## State and failures

Runs: `queued` → `running` → exactly one terminal state: `completed`, `partial`,
`failed`, `canceled`, or `interrupted`. Steps: `queued`, `running`, `completed`,
`failed`, `skipped`, `timed_out`, `canceled`, `interrupted`, `waiting_for_children`. Store workflow status separately from
claim/source status. A completed workflow can still have only unverified sources.

Allow one global active run. A different start returns `409 run_in_progress`;
the same idempotency key and payload recover the existing run. Persist prompt,
run, request digest, key, and initial event atomically, then enqueue. Keep provider
calls outside database transactions. State transitions and their events are atomic.

No successful draft means failure. With one draft, skip peer reviews and allow
a clearly partial synthesis or original-draft fallback. Synthesis failure exposes
labeled drafts, never an invented consolidated answer or an unconfigured provider.
An overall timeout yields partial if a draft exists, otherwise failed. Cancellation
wins atomically against late callbacks; already sent provider work may still be billed.
An accepted child failure makes the run partial even when its parent finishes.
Denied spawns create no child and remain visible notices. Run cancellation stops
the full tree; unrecoverable parent termination cancels descendants and prevents
orphan calls or parent continuations after cancellation.

On restart, mark active runs interrupted and preserve artifacts; never automatically
resume or reissue requests, including waiting parents/children. An event-stream disconnect neither cancels nor duplicates
a run. Reloading recovers its snapshot; reconnecting replays persisted progress.

## Limits and accounting

Proposed Team/Quick + helpers defaults: 32 model invocations including roots,
descendants, continuations, and retries; concurrency three globally/two per provider;
300-second overall deadline; 45-second call deadline; 2,048 output tokens per call;
65,536 aggregate output allowance. Quick with helpers off allows one attempt and
no retries. Agent quotas: six roots, twelve total nodes, six children per run,
two direct children per agent lifetime, depth two with roots at zero. These remain
design defaults, not measured capacity, speed, or spend commitments.

Reserve an attempt and output allowance atomically before dispatching each call,
including concurrent batches. Cap subsequent calls to remaining allowance.
Reconcile trusted usage; retain reservations when usage is unknown. Track input
tokens separately. These govern local scheduling and requested output, not a
guarantee about provider billing or enforcement.

Before accepting helpers or retries, reserve remaining nominal root stages plus
child work and the required parent continuation. Waiting parents hold no concurrency
permits. Shared provider limits cover every profile/agent using that provider.
Counts distinguish base plan, reservations, dispatched invocations, and maximum.

At most one retry per step, only after an explicit retryable rejection before
generation, inside the same limits. No automatic retries for ambiguous timeouts
or requests whose processing status is unknown. Unknown costs remain unknown,
never zero. Dollar estimates need a versioned configured price table; no hard
monetary cap is promised.

## Local persistence

| Record | Fields and invariants |
| --- | --- |
| Conversation | UUID, title, creation/update times. |
| Message | UUID, conversation/run IDs, user/assistant role, text, timestamp, stable sequence. |
| Run | UUID, per-conversation unique idempotency key, normalized request digest, mode, execution mode, model/context snapshot, state, limits, usage, terminal reason. |
| Agent | Run-scoped unique ID, parent/root IDs, depth, name, role/task, profile/model/provider snapshot, status. Repeated provider/profile is allowed. |
| Step/invocation | Unique step ID, run/agent/stage, initial/continuation/retry records, state, reservations, concise output, usage/error. |
| Spawn | Durable run/parent/step/parent-invocation/tool-call tuple, request digest, child ID or denial, task/profile, ancestry and reservation outcome. Continuation is unique per parent-invocation batch. |
| Finding/citation | Claim/finding text, source string, provenance, status unverified. |
| Event | Run, monotonic sequence, type, timestamp, bounded payload; unique run/sequence. |

Use foreign keys, migrations, and short transactions. Keep individual drafts and
review notes as run artifacts; chat history contains user prompts and final
presentations. Do not persist HTTP debug payloads. File permissions are owner-only.

Delete/export require terminal runs in the conversation; active work returns 409.
Deletion cascades through logical messages, runs, agent trees, spawn records,
artifacts, events, and keys.
It does not guarantee forensic erasure of SQLite pages, backups, browser copies,
downloaded exports, or provider-side data.

## Security and provider setup

Default loopback listener and canonical origin: `http://127.0.0.1:3000`.
Validate Host, disable CORS, and require matching Origin plus CSRF token for writes.
Use an HttpOnly, SameSite=Strict local session cookie, Secure under HTTPS. This
is a local-browser boundary, not multi-user authentication; trusted local processes
can access it. Public/LAN exposure needs a later authentication/deployment design.

Keys and a catalog of model profiles come from server configuration, with no browser
key editor, database key storage, or exported credentials. The UI shows configured
status, not verified provider availability. Live calls require server enablement
and explicit Live selection. Startup, model discovery, and default tests call no provider.

All three adapters, repeated-provider teams, and bounded delegation belong in the
first live milestone. Profiles may expose multiple explicit model IDs per provider;
never use moving latest defaults. Check delegation capability before enabling it.
During implementation, check authentication,
capabilities, output limits, usage, retention, and errors against current official
provider documentation. This phase validates no vendor API integration.

Render sanitized Markdown/text, reject raw HTML and unsafe URL schemes, and apply
a restrictive content security policy. Exports contain user text: disclose before
download. No telemetry by default; infrastructure logs omit sensitive content.

## Build sequence

Mock flow and persistence → contract/concurrency checks → three opt-in live adapters
→ measured evaluation against single-agent baselines. See [roadmap](roadmap.md) and
[evaluation](evaluation.md). Every component above stays in the Apache-2.0 core.
