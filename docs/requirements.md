# Product requirements — first personal release

Status: a local-only, mock-first v1 implementation on branch
`codex/project-traceability` in this working tree now realizes the executable
subset of these requirements documented in RLOG-010 through RLOG-017 of the
[requirement log](logs/requirements.md). The v1 implementation is
**uncommitted and unpublished** at this checkpoint and is not available from a
fresh clone of the public remote. Live-provider integration remains unverified
(no automated live E2E). Requirement IDs below are stable references.

## Purpose and decisions

Proofestra gives one person a familiar chat interface with optional independent
answers and cross-review from multiple model providers. It should make material
disagreements and missing evidence visible. Agreement never guarantees accuracy.

**Confirmed by the user:** personal, single-user, self-hosted web application;
bring your own provider credentials; OpenAI, Anthropic, and Gemini supported
together in the first live version; multiple agents may share a provider and use
the same or different configured models; every provider's agents can request
subagents; fully Apache 2.0 open-source core.
The latest direction expands provider/tool coverage and automatic use of provider
agent tools; compatibility must be established for each integration.
The user confirmed all tool surfaces: built-in API tools, local agent
apps/SDKs/CLIs, functions/MCP/local executors, and supported hosted agent services.
The user also requested shared agent skills, plugins and custom MCP support so
connected providers can use authorized compatible extensions through the harness.

**Proposed defaults:** local machine deployment, text-only conversations, one
agent per provider in the default three-agent team, tools/helpers enabled for Team
and disabled for Quick, backend-specific credential setup, local history, and the
limits below. Add validated API/SDK/CLI/MCP/hosted integrations in stages;
design coverage does not establish live compatibility.
[Agent policy](agents.md), [tools](tools.md), [scaling](scaling.md), and
[provider capabilities](provider-capabilities.md) define detailed boundaries;
[shared extensions](extensions.md) covers skills, plugin bundles and custom MCP.
The current phase produces requirements, design, and an interactive mockup only.

## Priorities

Must means a required core behavior for the relevant implementation milestone.
The first live milestone covers the three core API adapters and validated API
tools; SDK/CLI candidates follow compatibility checks. Should can follow that
milestone. Later denotes a further extension; no runtime capability exists yet.

| ID | Priority | Requirement |
| --- | --- | --- |
| UX-01 | Must | Create and reopen conversations, send text, and read a clear final answer in a familiar chat layout. |
| UX-02 | Must | Select mode, helper policy, and tool selection separately from permission grants; show agent/profile/backend identities, base plan, effective limits, and usage visibility. Label Quick tool/helper opt-ins without implying peer review. |
| UX-03 | Must | Show concise progress, cancellation, completed stages, missing stages, and a terminal outcome without exposing private reasoning. |
| UX-04 | Must | Keep the final answer prominent; allow expanding root drafts, review findings, and parent/child progress with distinct agent/profile/model labels and provenance. |
| UX-05 | Must | Support keyboard operation, visible focus, readable contrast, and progress/error text that does not rely on color alone. |
| AG-01 | Must | Quick has one root and no root peer-review or synthesis stage. Tools/helpers are off by default; only with both off is the baseline exactly one observable provider request with no retries. Opt-ins may add work and preserve the unreviewed label. |
| AG-02 | Must | Team has at least two roots with unique agent IDs; provider/model repetition is allowed. Personal root limit defaults to six and is server-policy configurable. Default to three roots, one per core provider; choose synthesis by root agent ID. |
| AG-03 | Must | Produce root drafts from the same frozen history; drafting descendants inherit that branch's scope and cannot see other root drafts. Finish the root-draft barrier before any cross-review. |
| AG-04 | Must | The default small-team plan has each successful root review other available root drafts once, then the selected root synthesizes. Record actual review coverage. Child/tool outputs are parent artifacts, not extra root reviewers or votes. |
| AG-05 | Must | For the small all-peer plan only, base work is 2n+1 root requests: seven for default roots. Tools, descendants, continuations, and retries add work. Larger-team bounded review/hierarchical synthesis needs a recorded plan, not this universal formula. |
| AG-06 | Must | Reviews identify concise proposed corrections and disagreements; synthesis must preserve material unresolved issues and missing checks. |
| AG-07 | Must | Treat model/tool output as untrusted. Freeze route/tool/backend/profile/destination allowlists and initial grant references; revalidate current grants before dispatch. Models cannot amend allowlists/grants, widen permissions, change policy, enable unregistered tools, or obtain secrets. |
| AG-08 | Must | Freeze all prior user/final-answer turns and the current prompt once for every agent. Never silently trim or summarize history per provider. Reject an oversized context before dispatch; preserve a partial result if an unexpected later-stage context overflow occurs. |
| AG-09 | Must | Roots/children can request scoped helpers within shared policy; default to the parent profile/backend. Alternate destinations/profiles/backends require prior approval. Use harness-managed nesting when native nesting is unsupported; otherwise report unsupported, never false parity. |
| AG-10 | Must | Children inherit the parent branch and stage permissions and may delegate only within remaining depth/quotas. Persist parent ID, depth, task scope, model profile, outcomes, and concise artifacts; expose no private reasoning. |
| AG-11 | Must | Validate spawn requests atomically and deduplicate repeated spawn callbacks. Denial creates no child or child invocation and produces a notice; the requesting invocation and any later parent continuation still count. An accepted child failure makes the run partial. |
| PR-01 | Must | Provide the first three live API adapters for OpenAI, Anthropic, and Gemini behind normalized interfaces, while keeping provider IDs extensible rather than a product-wide closed enum. |
| PR-02 | Must | Server catalogs support multiple explicit model profiles per provider. Execution backend is separate from provider/profile/agent identity. UI selects registered profiles/backends and shows readiness; credentials never appear in it. |
| PR-03 | Must | Start and browse the app without provider calls, model discovery requests, or credentials; real requests require an explicit user send in live mode. |
| PR-04 | Must | Normalize unavailable models/tools/backends, missing credentials, authentication errors, rate limits, execution failures, timeouts, and missing usage. |
| PR-05 | Must | Allow multiple agents to select the same or different server-configured profiles without editing application code; never switch to an unapproved paid model. |
| PR-06 | Must | Register declared model/tool/backend capabilities and observed validation status. Additional plugins or OpenAI-compatible adapters are candidates until contract tests pass; never promise all models or tools. |
| PR-07 | Must | Distinguish direct API, client-executed function/local MCP, native SDK/CLI job, and hosted agent service candidate backends; declare scope, deadline/cancel behavior, credentials, and usage visibility before admission. |
| PR-08 | Must | Native (vendor-CLI) backends are a distinct backend kind (`native_cli`) with reserved backend IDs (`codex-local-cli`, `antigravity-local-cli`), each bound to its own api shape. Dispatch is keyed by the frozen backend ID: a native ID never reaches a provider API adapter, never falls back to one or to a mock in Live, and a profile cannot swap one for the other by relabeling (validated at catalog load and re-checked at dispatch). |
| PR-09 | Must | A native backend is admitted only when every tool-surface control is proven for the installed CLI version; otherwise readiness is `unverified` with an exact, fixed reason code and the run is refused (`backend_not_ready`). `GET /providers` exposes only sanitized states (reason code, `vendor_managed` credentials, subscription billing, unproven control IDs), never a path, version, login state or vendor text. Admission freezes the native policy (backend, model, policy ID, CLI version, permissions, accounting) into the run; dispatch refuses a missing or mismatched policy. |
| PR-10 | Must | Codex runs only through a supervised, bounded `codex exec` subprocess that uses the vendor-managed existing ChatGPT login. The app never reads, stores, forwards or bridges that login or any token; creates no new login, grant, persistent setting or access; and never falls back to a paid API. Policy is invocation-only: ignore user config and rules, ephemeral session, read-only sandbox, approvals never, explicit known executable (no `$PATH`), empty per-job scratch cwd, minimal credential-free environment, prompt on stdin, tool/web/hooks/apps/MCP/delegation switches applied and re-verified by a pre-launch preflight, exact pinned model, one turn, and one wall-clock budget shared by the pre-launch probes and the job. The model must be CONFIRMED by the CLI's own transcript (a transcript that never reports the pinned model fails; requested is not executed). The resolved executable is identified by realpath plus device/inode/size/mtime and a changed identity invalidates the preflight cache and is refused before launch. Cancel/timeout sends a best-effort SIGKILL to the job's process group and then settles within a bounded grace; a descendant that left the group is NOT contained, so a job that finishes with such an escapee (or cannot be reaped) is reported `containment_unverified` and its external work is `unknown`, never claimed stopped. Subscription-only: every job first passes the vendor's own `login status` and proceeds only on the exact ChatGPT message (an API-key, token, cloud-credential, unknown or unreadable state is refused before launch, and `forced_login_method="chatgpt"` is also passed), because dropping inherited API variables does not stop a cached API-key login from selecting paid API billing. A read-only sandbox alone is not a no-tools proof. **Status: execution is blocked (`unverified`, `tool_surface_unproven`)** because the installed 0.163.0 does not prove tools off (see DLOG-018). |
| PR-11 | Must | Only allowlisted native events are interpreted. Reasoning, plan and diagnostic items are discarded unread; any tool, command, file, MCP or web item, unknown event, malformed line, extra turn, model mismatch or oversized answer kills the job and fails the step with a fixed message. Vendor failure text is classified into fixed categories and never stored or shown. Native output never enters messages, logs or exports except the final answer text. |
| PR-12 | Must | Antigravity stays explicitly `unverified`/disabled and can only refuse until the installed protocol, no-tools controls, AI-credit overage state and officially supported use are established. No guessed flags, no login/update/migration, no Gemini API substitution. |
| PR-13 | Must | Native accounting is honest: a native job counts toward `max_native_jobs` (admission and dispatch) and `max_native_job_seconds`; internal usage visibility is `opaque`; vendor-reported tokens are recorded as reported or unknown; cost is never reported as $0; subscription quota is never presented as API credit. The CLI cannot enforce an output-token ceiling, so a native job is admitted only for an explicit `bounds_mode=bounded_job` with `allow_unknown_internal_usage=true` and only for requested controls it can enforce (`deadline`, `context_isolation`, `harness_invocations`); anything else is refused 422 `unsupported_bounds` before a job starts. A job that reports output above the requested ceiling fails its step (charged at least the reservation plus the reported excess, totals unknown) rather than completing within budget, and an over-bound answer fails instead of being truncated. Native usage at invocation, step and run level is never `simulated`, never a zero job count, and never a false zero for unknown internal model/tool counts. |
| TL-01 | Must | Automatically route among registered, ready, compatible, preapproved tools. Use a current-profile tool directly or, only with helpers enabled, delegate to an approved helper/profile. Tools ON/helpers OFF creates no managed child; never silently replace roots/synthesis or add destinations. |
| TL-02 | Must | Discover catalog metadata lazily and shortlist a bounded top-K relevant tools; never place the entire catalog in every prompt. Record selection/routing decisions. |
| TL-03 | Must | Tool selection does not grant permission. Existing task grants authorize matching reads, sandbox execution, and reversible workspace work automatically; do not prompt again for each covered call. |
| TL-04 | Must | For missing/revoked/exceeded scope, pause on the exact action within frozen allowed routes/destinations and record the user's decision. Approval never mints blanket grants or amends allowlists; broader route/provider/destination choices need a new configured run. Never silently install, authenticate, or enable unrestricted CLI approval. |
| TL-05 | Must | Include search/retrieval, code, scoped files, functions, MCP and native agent tools in the design. Activate each only after backend compatibility and policy checks; provider-managed tools and client execution are different trust boundaries. |
| TL-06 | Must | Use backend-supported credential flows with the user's approved account/key; never scrape or reuse another application's session tokens. A selected tool with missing credentials or incompatible capabilities must not execute. |
| EX-01 | Must | Provide one shared harness catalog with global and workspace scopes for skills, plugins and custom MCP. Every connected provider is eligible for authorized compatible shared capabilities without separate manual per-vendor installation. Scope discovery never grants use. |
| EX-02 | Must | A skill is versioned instructions/resources and optional scripts. Load metadata first, then relevant instructions/resources progressively within context limits. Skill content is untrusted guidance, not policy or permission; scripts require the registered executor and current action grant. |
| EX-03 | Must | A plugin is a versioned manifest bundling references to skills/tools/MCP/backends. Import/enable trusted definitions deliberately, validate referenced versions/digests and declared capabilities, and execute no install/startup scripts merely by import. Vendor plugin formats require explicit tested importers, not assumed universal compatibility. |
| EX-04 | Must | Broker custom MCP centrally: supervised local STDIO and remote negotiated supported HTTP transports with configured auth/destinations. Normalize tools/results and declare transport/capability compatibility; do not assume each provider's hosted connector accepts every custom server. |
| EX-05 | Must | Expose shared namespaced capabilities through each model's function/tool adapter where compatible. Otherwise use an existing approved capable helper only when enabled, or report unavailable. Never silently replace roots, install per-vendor copies, bypass frozen route/grant boundaries or universalize vendor-exclusive hosted tools. |
| EX-06 | Must | Resolve stable IDs with namespace/scope; reject collisions or require explicit disambiguation, never silent overwrite. Collision-checked provider aliases respect wire-name/length limits and map to the same logical IDs, version/digest, grants and provenance; secret references stay central. |
| EX-07 | Must | Pin immutable catalog/extension versions/digests; never hot-swap active definitions. Recheck current enablement/grants before loading/dispatch. Disabled/revoked/removed/superseded versions block pending dispatch unless the pinned version is explicitly retained enabled and authorized. Stop running work where supported; record loaded context and uncertain completion without erasure/rollback claims. |
| EX-08 | Must | Keep MCP/backend secrets out of prompts, committed/exported manifests, provider arguments and logs. Scripts/tools use scoped executors, shared budgets and isolated approval control. Shared registration never shares root-draft scratch/handles/results: isolate per-branch state or reject the route. Export safe IDs/versions/digests, resource references and action provenance, not raw secret-bearing traces. |
| CT-01 | Must | Advertise effective server-policy limits and validate run settings before dispatch. Enforce observable request/tool/native-job ledgers, output/deadline/concurrency limits, tree quotas, and declared backend control limits. Personal defaults are not fixed product ceilings. |
| CT-02 | Must | Reserve observable provider requests and output before dispatch, including root/child/continuation/retry work. Accept helpers/tools/native jobs only with applicable ledger allowance and protected remaining root work/parent continuation. |
| CT-03 | Must | Harness retries default to at most once per logical step, only after an explicit pre-generation transient rejection within limits. Never automatically retry ambiguous sent requests or authentication/validation errors; native internal retries have separately declared visibility/control. |
| CT-04 | Must | Stop prevents new harness work and attempts cancellation throughout the tree/jobs. Record unconfirmed native cancellation or continuing remote work; never promise rollback, complete inner control, or avoidance of already-incurred charges. |
| CT-05 | Must | Preserve usable partial results and distinguish completed, partial, failed, canceled, and interrupted runs; never invent a missing response. |
| CT-06 | Must | Show observed usage separately from estimates and unknown values; never present an estimate as a billing guarantee or unknown monetary usage as $0. |
| CT-07 | Must | Waiting parents/tools/jobs/approvals release local global/provider execution slots; children and continuations share bounded scheduling without deadlock or quota bypass. |
| CT-08 | Must | One native job is not one total model call. Record observed tool operations/native jobs separately from harness-dispatched provider requests; native internal counts and token/cost values may be null with explicit visibility. Strict policy rejects a job if its required scope/deadline cannot be supported. |
| EV-01 | Must | Separate retrieval status from claim support. Unretrieved model citations remain unverified; tool/provider retrieval may be recorded with origin/status/time, but retrieved content is still support-unverified until a distinct support check is recorded. |
| EV-02 | Must | Use wording such as “team review completed” with its scope; never use an accuracy guarantee, consensus score, or “verified answer” badge. |
| PV-01 | Must | Before live submission disclose root/helper/backend/tool destinations, relevant data scopes, and cross-provider review material. Inherited grants cannot expand destinations, filesystem scope, or permissions. |
| PV-02 | Must | Keep credentials server-side and out of browser responses, conversation storage, portable exports, and logs; show safe error messages. |
| PV-03 | Must | Persist conversation text, drafts, findings, run configuration, outcomes, and usage locally; persist no private chain-of-thought. |
| PV-04 | Must | Export one conversation as versioned portable JSON with content and provenance but without credentials or internal request headers. |
| PV-05 | Must | Delete a conversation and its associated local records after its runs are terminal; reject deletion while a run is active and explain how to cancel it. |
| PV-06 | Must | Default to local-only access for this single-user release; public internet exposure and multi-user identity require a separate design. |
| DV-01 | Must | Keep deterministic mock mode available without credentials or paid calls for development, demos, and default checks. |
| DV-02 | Must | Mark mock screens and simulated answers clearly; no real provider request may originate from the design prototype. |
| DV-03 | Must | Keep UI, orchestration, provider/tool/backend adapters, review workflow, history/export, self-hosting, and evaluation tooling fully Apache 2.0. |
| NX-01 | Should | Add a simple history search and optional light/dark appearance after core flows work. |
| NX-02 | Later | Add validated provider plugins, measured large-team plans, shared workspaces, hosting, and separately licensed enterprise extensions; registry design does not assert these integrations already work. (First-class file attachments were previously included here and are now in scope as AT-01..AT-05.) |
| AT-01 | Must | Accept per-conversation file uploads via native picker, paste, and drag-drop; stream to a signed-conversation blob store behind a store-wide upload gate (concurrency 1, 120 s deadline, bounded queue); enforce per-upload / per-store / per-count limits; sniff MIME; accept and store the bytes (traversal, ZIP bombs, encrypted or unsupported archives are refused at ANALYSIS, AT-03, and stay download-only); map known @fastify/multipart / @fastify/busboy error codes to 4xx. |
| AT-02 | Must | Route each attachment per effective profile capability and validated metadata: native image / PDF where the vendor documents inline support and dimensions or page count (at most 20 pages) are validated; native audio / video only for Gemini, only with a validated finite duration (at most 120 s each and in aggregate per call), validated streams, and supported codecs; bounded extracted text (PDF via Poppler; DOCX/PPTX/ODF text; XLSX stored cell values, with formulas never evaluated and dates as serial numbers, and a cell that depends on a shared string dropped by the parser caps makes the result Partial (truncated) rather than full text; plain-text ZIP entries; code/text) where native routing is unavailable; otherwise an honest attachment-only placeholder with a specific reason. OpenAI and Anthropic never receive audio/video and say so. Audio/video are never transcribed: coverage reads `Metadata only — no transcription`. Unverified, missing, or unbounded metadata must not escalate into a native-analysis claim. |
| AT-03 | Must | Bound every extractor by output size and time. PDF and media probing run as fixed-binary, no-shell, bounded subprocesses (media only through the read-only blob file descriptor); Office and ZIP parsing run in a resource-limited, terminable worker thread. Abort, timeout, or client disconnect kills the child or awaits worker termination BEFORE the upload gate is released and before any `ready` row is published. Reject DTD/entity declarations, non-UTF-8 or pathologically nested XML, traversal/absolute/duplicate/symlink/encrypted/multi-disk/ZIP64 entries, bad CRCs, local/central header disagreement, and excessive ratios or sizes; never recurse into nested archives, write extracted bytes to disk, or execute uploaded content. Never render HTML / SVG / XML / office previews as active content; media is previewed only after structural validation; sandboxed preview enforces its own strict CSP that the global `onSend` hook preserves. |
| AT-04 | Must | Freeze per-run, per-agent attachment routes at admission over the union of historical and current attachments (history first) and project the same typed `MessageContentPart[]` into every draft / review / synthesis / follow-up. Historical user turns re-send their actual native bytes or bounded extracted text under the frozen routes — they are NOT reduced to `attachment_only` placeholders. Admission and dispatch use one shared conservative token reserve, per-call byte/second budgets, and a native-token budget of at most 50% of the profile's safe input. Uploaded file content is untrusted data: every adapter frames it with the same notice before extracted text and before native parts. |
| AT-05 | Must | Exports and runs persist only attachment metadata (id, display name, sniffed MIME, byte size, hash, state, coverage, and validated page/duration/stream/format/normalized-MIME metadata) — never raw bytes, base64, extracted text, blob paths, or credentials. `GET /api/v1/providers` exposes only the booleans `pdf_text_extraction` and `media_metadata_probe`, never a path, version, or environment value. |

## Proposed operating limits

These are personal deployment defaults, not product-wide ceilings or measured
capacity/spend claims. Server policy configures finite caps, advertises them, and
checks run settings. The demo editor's six-root cap applies only to the demo.
Record effective limits and visibility per run. Output budgets govern observable
scheduling/requested output, not all opaque native work, input charges, or money.

| Limit | Initial default | Behavior |
| --- | --- | --- |
| Harness-dispatched provider requests | Quick with tools/helpers both OFF: 1; otherwise 32 | Includes visible root/child/continuation/retry requests; does not claim a cap on opaque native internals. |
| Observed tool operations / native jobs | 64 / 4 | Separate units; one native job can contain many or unknown internal model/tool calls. |
| Global / per-provider concurrent calls | 3 / 2 | Waiting parents release slots; repeated-provider roots still share that provider's limit. |
| Root agents | Quick: 1; personal Team cap: 6 | Configurable server policy; identity is independent of provider/model/backend. |
| Managed total / spawned agents | 12 / 6 | Covers harness-managed nodes; opaque native inner agents have separate/unknown visibility. |
| Children per agent | 2 over its lifetime | Root and child agents share the same rule. |
| Maximum child depth | 2, roots at depth 0 | Deny at the effective configured limit; native nesting may be unavailable sooner. |
| Overall deadline | 300 seconds | Includes waiting, children, continuations, retries, and every stage. |
| Per-call timeout | 45 seconds | Also bounded by the remaining overall time. |
| Per-native-job deadline | 120 seconds | Within the run deadline; require compatible enforcement or strict-policy rejection. |
| Output per call | 2,048 tokens | Adapter must translate and enforce the provider's supported output limit. |
| Total output allowance | 65,536 tokens | Reserve for observable requests; unknown native inner tokens remain unknown. |
| Safe rejected-request retries | At most 1 per logical step | Includes its initial/continuation sequence; disabled for the tools/helpers-OFF Quick baseline. |

Release a token reservation using reported usage only when the adapter can safely
account for it. Missing or uncertain usage retains the reserved maximum for limit
accounting, including a timed-out dispatched attempt. Record that conservatism as
an estimate. A helper request or retry can be refused when any allowance is missing,
even if other quotas remain. Before accepting a spawn, reserve child work and its
parent continuation while protecting remaining nominal root stages. Budget cannot
be reset by nesting or choosing another provider. Child creation is an idempotent
scheduler action, not a browser-authorized external action.
Tool selection and permission are separate checks. Freeze route/tool/backend/profile/
destination allowlists and initial grant references, then recheck current validity
and revocation before dispatch. A covered action proceeds automatically. Missing
scope within an allowed route can receive a recorded exact-action user decision;
the approval endpoint creates no blanket grant and permits no model amendment.
Broader allowlist/provider/destination changes require a new user-configured run.
Native jobs need
supported scope/deadline controls, or strict policy refuses them. Record opaque
inner counts as null and record what is observed; do not convert unknown costs to
zero or describe a job launch as one total model call. Native stop can be best
effort and cannot undo completed file, network, or hosted actions.

On failure, continue only with available material and remaining limits. A Team run
with one draft skips peer reviews and may synthesize within budget; with no draft,
end failed. Any missing planned review, provider failure, original-draft fallback,
or accepted child failure means partial, even if synthesis succeeds. A denied spawn
is a visible notice and does not create a failed child. If synthesis fails or cannot
be scheduled,
show available drafts/findings without calling them a synthesized final answer.
At the overall deadline, stop harness scheduling and retain available drafts as partial,
or end failed if none exist. Cancellation stays canceled despite late callbacks.
After a process restart, mark the unfinished run and all active descendants
interrupted and do not resume automatically. Only a successful root workflow and
all accepted child work can be completed; completion never establishes correctness.

## Acceptance scenarios

| Scenario | Expected result and covered IDs |
| --- | --- |
| A1 — First visit with no keys | Mock chat works; provider status says missing; no startup calls or secret entry field appears. (PR-02/03, DV-01/02) |
| A2 — Quick response | Select an Anthropic API profile with tools/helpers OFF and send once after disclosure. One draft request is planned with no retry; provider/model/backend labels show no peer review. (UX-02, AG-01, PV-01) |
| A3 — Default root workflow | Select three roots and synthesis by agent ID; disable helpers/tools in this fixture. Capture identical initial history without peer drafts, then three reviews after the barrier and one synthesis. Report seven base requests. (AG-02/03/04/05) |
| A4 — Shared mistake or disagreement | Mock drafts agree on an unsupported claim or disagree. Final view preserves uncertainty and unverified citations without an accuracy badge. (AG-06, EV-01/02) |
| A5 — One provider fails | Other drafts survive. Missing drafting/review participation is shown; available synthesis is labeled partial. A failed synthesis leaves labeled drafts/findings. (PR-04, CT-05) |
| A6 — Budget or timeout reached | The next attempt is refused before dispatch if any required allowance is unavailable. All dispatched retries count; missing usage stays conservative; a required synthesis reservation cannot be spent by an optional retry. (CT-01/02/03/06) |
| A7 — Cancel an active tree/job | Stop while helpers/tools/native work are active. No new harness child/tool/job/continuation starts; attempt supported cancellation. Preserve canceled state and disclose unknown remote stop or completed side effects. (CT-04/05) |
| A8 — Untrusted tool/model content | Text asks for keys, a new provider, or broader file access. It cannot alter configuration/grants; only validated registered actions inside existing scope can execute. (AG-07, TL-03/04, PV-02) |
| A9 — History, export, deletion | Reopen a saved conversation; export its content and provenance without a planted test secret; active deletion is rejected, then succeeds after cancellation reaches terminal state. (PV-03/04/05) |
| A10 — Restart while running | Saved run and active descendants become interrupted and offer a new user-initiated run; no automatic live requests occur. (PR-03, CT-05) |
| A11 — Keyboard and error state | Complete mode selection, send, inspect findings, cancel, and reopen history with keyboard and visible focus; errors remain understandable without color. (UX-01/03/04/05) |
| A12 — Unequal model context windows | Preflight shared history, instructions, worst-case peer/helper artifacts, and reserved output against selected root and preapproved helper profiles' safe capacities. Reject unsafe work before dispatch; never send different hidden histories. An unexpected later overflow preserves partial material and names the missing stage. (AG-03/08, CT-05, PV-01) |
| A13 — Same-provider agents | Create two OpenAI roots with distinct IDs using the same profile, then different OpenAI profiles. Both participate independently; synthesis targets an agent ID; concurrency respects the effective advertised provider limit (personal default two). (AG-02, PR-02/05, CT-07) |
| A14 — Nested helpers and rejection | Under personal defaults, accept a child/grandchild; reject depth-2 spawning, a third lifetime child, unapproved profile/backend, or exhausted quota without a child/call. Parent calls/continuations count. Deduplicate within an invocation; reused tool IDs in different invocations stay distinct. Native recursion gaps use permitted harness fallback or report unsupported. (AG-09/10/11, CT-01/02) |
| A15 — Slots, independence, and failures | Saturate slots with parents waiting on children; children and continuations still progress within limits. Drafting descendants cannot access other root drafts; cross-review waits for root draft completion. An accepted child timeout makes the final run partial. (AG-03/04/11, CT-07) |
| A16 — Quick tools/helpers | Both OFF gives one request. Opt in to tools or “Quick + helpers”; additional work is visible and budgeted without root peer review or a verified badge. (AG-01/05, UX-02, EV-02) |
| A17 — Automatic capability routing | Search/code uses a ready current-profile tool or an approved capable helper when enabled. With tools ON/helpers OFF, a direct eligible tool executes, but unavailable capability creates no managed child and returns a notice. Missing credentials/incompatibility never execute; record route/destination without root/synthesis swaps. (TL-01/05/06, PR-06/07) |
| A18 — Existing grant and exact action | Covered read/sandbox/reversible workspace actions execute without repeated prompts; revocation is rechecked before dispatch. Missing scope in a frozen allowed route pauses for an exact-action decision, which cannot authorize different arguments or mint a blanket grant. Broader routes/providers/destinations require a new run; denial installs/authenticates nothing. (AG-07, TL-03/04) |
| A19 — Native opaque usage | A simulated native job reports unknown internal requests/tokens/cost. Show one job, observed events, nullable inner counts and visibility; do not claim one total model call or complete cancellation. Reject under strict policy when required scope/deadline is unsupported. (CT-04/06/08) |
| A20 — Catalog and policy scaling | Register many providers/tools and a policy allowing more than six roots. Lazy shortlist top-K tools, enforce advertised finite runtime caps, and record review coverage. Default/demo limits must not become hard product enums/ceilings; an untested integration stays unavailable. (PR-06, TL-02, CT-01) |
| A21 — Shared progressive skill | Make one global and one workspace skill available to OpenAI/Anthropic/Gemini fixtures under the same catalog IDs. Load only relevant selected resources, respect workspace scope/context limits, and reject a skill's permission-expansion instruction. A script remains inert until a scoped authorized action. (EX-01/02/06/08) |
| A22 — Trusted plugin bundle | Import a mock manifest referencing versioned skills/tools/MCP/backends once. Reject untrusted, invalid or digest-mismatched references without installation, startup execution or per-vendor copies. Vendor formats without a tested importer remain unsupported. (EX-03/06/08) |
| A23 — Shared custom MCP | Mock local STDIO/negotiated HTTP servers expose one logical tool across provider adapters with collision-checked wire aliases. Reuse registration but isolate drafting branches' scratch/handles/results; reject a route unable to do so. Incompatible transport/missing auth/unavailable server dispatches nothing; secrets stay out of model-visible data/export. (EX-01/04/05/06/08, AG-03) |
| A24 — Incapable profile and helper policy | A compatible profile uses an authorized shared tool directly; an incapable profile routes only to an existing approved helper when enabled. Helpers OFF, missing grant or vendor-exclusive unavailable capability creates no child or silent root/destination change. (EX-05, TL-01/04) |
| A25 — Extension lifecycle and namespace | Pin version/digest; an update cannot hot-swap it. Disable/revoke/remove/supersede blocks pending actions unless the old pinned version remains explicitly enabled/authorized. Reject namespace/alias collisions and invalid wire lengths. Cancel attempts supported interruption; retain loaded-context/uncertain-completion records and safe provenance without secrets. (EX-06/07/08, CT-04) |
| A26 — Bounded attachment analysis | Upload the synthetic fixtures (text/scanned/encrypted PDFs, hostile ZIPs, DOCX/XLSX/PPTX/ODT including DTD and external-entity files, valid and hostile media). Real parsers yield full/partial/unsupported/encrypted/failed coverage as the fixture manifests state; hostile files are refused, never recursed, decoded or executed; media reads `Metadata only — no transcription`; a disconnect during parsing aborts and awaits the child/worker before the next upload; intercepted OpenAI/Anthropic/Gemini payloads for every draft, review, synthesis and follow-up carry the native bytes or framed extracted text, with unsupported media refused with a stated reason. No live call. (AT-01..AT-05, AG-07, CT-01/05) |

## Explicit non-goals

The current phase makes no real provider/tool/CLI calls and performs no paid runs.
Multi-user accounts, internet-facing authentication, subscriptions, unbounded
autonomy, universal tool/model support, unlimited resources, guaranteed accuracy,
and a guaranteed provider billing cap are outside the personal core milestone.
Search, code, scoped files, functions, MCP, SDK/CLI and hosted-agent candidates are
included in the design, activated in stages after validation and grants. No hosted
infrastructure is mandatory for core use. The design does not scrape account
sessions, install backends silently, or grant unrestricted CLI execution.
Shared skills/plugins/custom MCP are also design scope, not installed integrations
or automatic compatibility with every vendor's plugin/hosted-tool format.

The product requests useful answers and concise review findings, not private
chain-of-thought. Previous conversation content sent to providers must be visible
in the run's context/provenance record; there is no hidden memory service.

## Decisions to validate during implementation

- Confirm that the proposed limits feel responsive and economical using measured
  mock/live behavior; tune them without weakening explicit user control.
- Choose explicit provider model IDs from current availability and document each
  adapter's output-limit and usage mapping before live acceptance.
- Validate the local persistence and export format against the selected stack.
- Validate backend-specific compatibility, credentials, granted action scopes,
  visibility, and supported cancellation before live use.
- Validate shared extension manifests, namespaces, scope resolution, progressive
  resource loading, broker transports, snapshots and lifecycle with mock fixtures.
- Implement retrieval records separately from claim-support checks; evaluate both
  before making quality claims. Larger-team plans need bounded fanout and recorded
  coverage rather than assuming every agent reviews every other agent.

## Development workflow requirements

| ID | Priority | Requirement |
| --- | --- | --- |
| DEV-01 | Must | Use GPT Sol for planner/designer (latest replacement of Fable), Opus 5.5 for reviewer/advisor, and Sonnet 5.5 for worker (originally user-spelled Sonet); verify exact available Cursor names and any Sonnet 5.5 mapping before assigning substantive work. No silent substitutions or claims based only on a rule file. |
| DEV-02 | Must | Always-on project agent rules and a CI/local coverage gate require at least 90% statements, branches, functions and lines over every production TS/TSX source file; report actual measured coverage, use meaningful behavior/failure tests and do not dilute through broad exclusions or trivial tests. |
| DEV-03 | Must | Publication is a human-operator action after consolidated final verification; agents (planner, worker, reviewer) never stage, commit, push, open a pull request, merge or deploy, and no per-task authorization is recorded as a standing rule here (RLOG-023). Subscription-backed (ChatGPT/Antigravity) tests run only through officially supported, already-signed-in vendor surfaces; never a paid API substitute, purchase, new credential/OAuth grant, persistent access, security-setting change, or session-token extraction/reuse. |

See [development policy](development-policy.md) and RLOG-018/019 for evidence and limits.
