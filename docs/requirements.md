# Product requirements — first personal release

Status: design proposal. No application or live integration is implemented.
Requirement IDs below are stable references for design and later implementation.

## Purpose and decisions

Proofestra gives one person a familiar chat interface with optional independent
answers and cross-review from multiple model providers. It should make material
disagreements and missing evidence visible. Agreement never guarantees accuracy.

**Confirmed by the user:** personal, single-user, self-hosted web application;
bring your own provider credentials; OpenAI, Anthropic, and Gemini supported
together in the first live version; multiple agents may share a provider and use
the same or different configured models; every provider's agents can request
subagents; fully Apache 2.0 open-source core.

**Proposed defaults:** local machine deployment, text-only conversations, one
agent per provider in the default three-agent team, helpers enabled for Team and
disabled for Quick, environment-based credential setup, local history, and the
limits below. These can change before implementation. [Agent policy](agents.md)
defines shared orchestration rules; no provider-native autonomous system is assumed.
The current phase produces requirements, design, and an interactive mockup only.

## Priorities

Must means required before the first personal live release. Should means useful
but can follow that release. Later is deliberately outside the first release.

| ID | Priority | Requirement |
| --- | --- | --- |
| UX-01 | Must | Create and reopen conversations, send text, and read a clear final answer in a familiar chat layout. |
| UX-02 | Must | Select Quick or Team and helper permission before sending; show root agent identities, model profiles/providers, base calls, possible helper costs, and shared limits. Label helper-enabled Quick as “Quick + helpers”. |
| UX-03 | Must | Show concise progress, cancellation, completed stages, missing stages, and a terminal outcome without exposing private reasoning. |
| UX-04 | Must | Keep the final answer prominent; allow expanding root drafts, review findings, and parent/child progress with distinct agent/profile/model labels and provenance. |
| UX-05 | Must | Support keyboard operation, visible focus, readable contrast, and progress/error text that does not rely on color alone. |
| AG-01 | Must | Quick has one root and no root peer-review or synthesis stage. Helpers are off by default, giving exactly one invocation and no retries; opt-in helpers preserve the unreviewed label. |
| AG-02 | Must | Team supports 2–6 roots with unique agent IDs; provider/model repetition is allowed. Default to three roots, one each from OpenAI, Anthropic, and Gemini. Select the synthesizer by root agent ID. |
| AG-03 | Must | Produce root drafts from the same frozen history; drafting descendants inherit that branch's scope and cannot see other root drafts. Finish the root-draft barrier before any cross-review. |
| AG-04 | Must | After drafting, each successful root reviews the other available root drafts once; then the selected root synthesizes. Child outputs are parent artifacts, not extra root reviewers or votes. |
| AG-05 | Must | The base Team workflow plans n root drafts + n root reviews + one synthesis: 2n+1 invocations, seven for the default roots. Helpers, continuations, and retries add invocations within the shared cap. |
| AG-06 | Must | Reviews identify concise proposed corrections and disagreements; synthesis must preserve material unresolved issues and missing checks. |
| AG-07 | Must | Treat model output as untrusted. Only validated structured helper requests may invoke preapproved bounded delegation; output cannot widen permissions, change run configuration, enable external tools, or obtain secrets. |
| AG-08 | Must | Freeze all prior user/final-answer turns and the current prompt once for every agent. Never silently trim or summarize history per provider. Reject an oversized context before dispatch; preserve a partial result if an unexpected later-stage context overflow occurs. |
| AG-09 | Must | Every root and child can request harness-managed text-only subagents within shared quotas; a child's default model profile is its parent's. Alternate profiles must be preapproved by the user for that run. |
| AG-10 | Must | Children inherit the parent branch and stage permissions and may delegate only within remaining depth/quotas. Persist parent ID, depth, task scope, model profile, outcomes, and concise artifacts; expose no private reasoning. |
| AG-11 | Must | Validate spawn requests atomically and deduplicate repeated spawn callbacks. Denial creates no child or child invocation and produces a notice; the requesting invocation and any later parent continuation still count. An accepted child failure makes the run partial. |
| PR-01 | Must | Provide live adapters for OpenAI, Anthropic, and Gemini behind the same invocation and failure interface. |
| PR-02 | Must | Read provider keys and a catalog of explicit model profiles from server configuration. Multiple profiles per provider are supported; the user selects a profile per root and approves any alternate child profiles. UI shows readiness and model names, never raw keys. |
| PR-03 | Must | Start and browse the app without provider calls, model discovery requests, or credentials; real requests require an explicit user send in live mode. |
| PR-04 | Must | Normalize unavailable models, missing keys, authentication errors, rate limits, provider failures, timeouts, and missing usage. |
| PR-05 | Must | Allow multiple agents to select the same or different server-configured profiles without editing application code; never switch to an unapproved paid model. |
| CT-01 | Must | Enforce shared invocation/output/deadline limits, global and per-provider concurrency, root/descendant quotas, per-parent child quotas, and maximum depth across the whole tree. |
| CT-02 | Must | Reserve an invocation and maximum output before dispatch. Count all root/child invocations, parent continuations, and retries. Accept a child only with allowance for that child, parent continuation, and remaining nominal root stages. |
| CT-03 | Must | Retry at most once per step only for an explicitly rejected rate-limit/transient request known not to have begun generation, within all limits; never automatically retry an ambiguously sent request, authentication error, or validation error. |
| CT-04 | Must | Stop cancels the entire tree, prevents new descendants/continuations, and attempts cancellation of outstanding requests; disclose possible provider charges. |
| CT-05 | Must | Preserve usable partial results and distinguish completed, partial, failed, canceled, and interrupted runs; never invent a missing response. |
| CT-06 | Must | Show observed usage separately from estimates and unknown values; never present an estimate as a billing guarantee or unknown monetary usage as $0. |
| CT-07 | Must | Waiting parents release global and per-provider execution slots; children and continuations use the same bounded scheduler without deadlock or quota bypass. |
| EV-01 | Must | Mark model-supplied URLs and citations as unverified; do not claim the app opened or checked them. |
| EV-02 | Must | Use wording such as “team review completed” with its scope; never use an accuracy guarantee, consensus score, or “verified answer” badge. |
| PV-01 | Must | Before live submission, disclose provider destinations for root and allowed child profiles, branch history, and cross-provider review/synthesis material. Descendants cannot expand that destination allowlist. |
| PV-02 | Must | Keep credentials server-side and out of browser responses, conversation storage, portable exports, and logs; show safe error messages. |
| PV-03 | Must | Persist conversation text, drafts, findings, run configuration, outcomes, and usage locally; persist no private chain-of-thought. |
| PV-04 | Must | Export one conversation as versioned portable JSON with content and provenance but without credentials or internal request headers. |
| PV-05 | Must | Delete a conversation and its associated local records after its runs are terminal; reject deletion while a run is active and explain how to cancel it. |
| PV-06 | Must | Default to local-only access for this single-user release; public internet exposure and multi-user identity require a separate design. |
| DV-01 | Must | Keep deterministic mock mode available without credentials or paid calls for development, demos, and default checks. |
| DV-02 | Must | Mark mock screens and simulated answers clearly; no real provider request may originate from the design prototype. |
| DV-03 | Must | Keep UI, orchestration, adapters, review workflow, history/export, self-hosting, and evaluation tooling fully Apache 2.0. |
| NX-01 | Should | Add a simple history search and optional light/dark appearance after core flows work. |
| NX-02 | Later | Add retrieval, attachments, tools, more providers, shared workspaces, hosted service, and separately licensed enterprise extensions. |

## Proposed operating limits

These are initial engineering defaults, not measured performance or spend claims.
Record the effective limits with each run and reject invalid configurations before
any provider call. Output budgets bound output tokens, not input charges or money.

| Limit | Initial default | Behavior |
| --- | --- | --- |
| Maximum invocations | Quick without helpers: 1; otherwise 32 | Counts roots, all descendants, parent continuations, and retries; base Team calls are 2n+1. |
| Global / per-provider concurrent calls | 3 / 2 | Waiting parents release slots; repeated-provider roots still share that provider's limit. |
| Root agents | Quick: 1; Team: 2–6 | Identity is independent of provider/model. |
| Total / spawned agents | 12 / 6 | Both limits apply across the entire run. |
| Children per agent | 2 over its lifetime | Root and child agents share the same rule. |
| Maximum child depth | 2, roots at depth 0 | A depth-2 agent's spawn is denied without dispatch. |
| Overall deadline | 300 seconds | Includes waiting, children, continuations, retries, and every stage. |
| Per-call timeout | 45 seconds | Also bounded by the remaining overall time. |
| Output per call | 2,048 tokens | Adapter must translate and enforce the provider's supported output limit. |
| Total output allowance | 65,536 tokens | Shared across every invocation; reserve maximum output before dispatch. |
| Safe rejected-request retries | At most 1 per logical step | Includes its initial/continuation sequence; disabled for plain Quick, and only before generation within shared limits. |

Release a token reservation using reported usage only when the adapter can safely
account for it. Missing or uncertain usage retains the reserved maximum for limit
accounting, including a timed-out dispatched attempt. Record that conservatism as
an estimate. A helper request or retry can be refused when any allowance is missing,
even if other quotas remain. Before accepting a spawn, reserve child work and its
parent continuation while protecting remaining nominal root stages. Budget cannot
be reset by nesting or choosing another provider. Child creation is an idempotent
scheduler action, not a browser-authorized external action.

On failure, continue only with available material and remaining limits. A Team run
with one draft skips peer reviews and may synthesize within budget; with no draft,
end failed. Any missing planned review, provider failure, original-draft fallback,
or accepted child failure means partial, even if synthesis succeeds. A denied spawn
is a visible notice and does not create a failed child. If synthesis fails or cannot
be scheduled,
show available drafts/findings without calling them a synthesized final answer.
At the overall deadline, abort local work and retain available drafts as partial,
or end failed if none exist. Cancellation stays canceled despite late callbacks.
After a process restart, mark the unfinished run and all active descendants
interrupted and do not resume automatically. Only a successful root workflow and
all accepted child work can be completed; completion never establishes correctness.

## Acceptance scenarios

| Scenario | Expected result and covered IDs |
| --- | --- |
| A1 — First visit with no keys | Mock chat works; provider status says missing; no startup calls or secret entry field appears. (PR-02/03, DV-01/02) |
| A2 — Quick response | Select Anthropic and send once in live mode after the disclosure. One draft call is planned; result labels that provider and model; no review is implied. (UX-02, AG-01, PV-01) |
| A3 — Default root workflow | Select the default three roots and a synthesizer agent ID; disable helpers for this fixture. Capture identical initial history with no peer drafts, then three reviews after the barrier and one synthesis. Report seven base invocations. (AG-02/03/04/05) |
| A4 — Shared mistake or disagreement | Mock drafts agree on an unsupported claim or disagree. Final view preserves uncertainty and unverified citations without an accuracy badge. (AG-06, EV-01/02) |
| A5 — One provider fails | Other drafts survive. Missing drafting/review participation is shown; available synthesis is labeled partial. A failed synthesis leaves labeled drafts/findings. (PR-04, CT-05) |
| A6 — Budget or timeout reached | The next attempt is refused before dispatch if any required allowance is unavailable. All dispatched retries count; missing usage stays conservative; a required synthesis reservation cannot be spent by an optional retry. (CT-01/02/03/06) |
| A7 — Cancel an active tree | Stop while parent/children are active. No child, continuation, or retry starts afterward; attempt cancellation throughout the tree; late output cannot replace canceled state. Explain possible billing. (CT-04/05) |
| A8 — Provider output contains instructions | A draft asking for keys or tool execution remains inert content; configuration and permissions stay unchanged. (AG-07, PV-02) |
| A9 — History, export, deletion | Reopen a saved conversation; export its content and provenance without a planted test secret; active deletion is rejected, then succeeds after cancellation reaches terminal state. (PV-03/04/05) |
| A10 — Restart while running | Saved run and active descendants become interrupted and offer a new user-initiated run; no automatic live requests occur. (PR-03, CT-05) |
| A11 — Keyboard and error state | Complete mode selection, send, inspect findings, cancel, and reopen history with keyboard and visible focus; errors remain understandable without color. (UX-01/03/04/05) |
| A12 — Unequal model context windows | Preflight shared history, instructions, worst-case peer/helper artifacts, and reserved output against selected root and preapproved helper profiles' safe capacities. Reject unsafe work before dispatch; never send different hidden histories. An unexpected later overflow preserves partial material and names the missing stage. (AG-03/08, CT-05, PV-01) |
| A13 — Same-provider agents | Create two OpenAI roots with distinct IDs using the same profile, then different OpenAI profiles. Both participate independently; synthesizer targets an agent ID; provider concurrency never exceeds two. (AG-02, PR-02/05, CT-07) |
| A14 — Nested helpers and rejection | A child spawns a grandchild; a depth-2 spawn, third lifetime child, unapproved alternate profile, or exhausted quota is denied with notice and no child/child invocation. Requesting calls and parent continuations still count. Duplicate a callback within one parent invocation: only one child exists; the same provider-local tool ID in a later invocation remains a distinct request. (AG-09/10/11, CT-01/02) |
| A15 — Slots, independence, and failures | Saturate slots with parents waiting on children; children and continuations still progress within limits. Drafting descendants cannot access other root drafts; cross-review waits for root draft completion. An accepted child timeout makes the final run partial. (AG-03/04/11, CT-07) |
| A16 — Quick helpers | Plain Quick dispatches once. Opt in to “Quick + helpers”; show child/continuation usage and provenance, while adding no root peer reviews or verified badge. (AG-01/05, UX-02, EV-02) |

## Explicit non-goals

The first release does not browse the web, fetch citation URLs, read attachments,
run code, invoke external tools, edit files, or send messages. It does not provide
multi-user accounts, internet-facing authentication, subscriptions, local model
hosting, unbounded autonomy, unlimited review rounds, guaranteed accuracy, or a
provider billing hard cap. Bounded text-only delegation is included; external
tools/actions and vendor-native autonomous systems are not required. No hosted
infrastructure is required for core use.

The product requests useful answers and concise review findings, not private
chain-of-thought. Previous conversation content sent to providers must be visible
in the run's context/provenance record; there is no hidden memory service.

## Decisions to validate during implementation

- Confirm that the proposed limits feel responsive and economical using measured
  mock/live behavior; tune them without weakening explicit user control.
- Choose explicit provider model IDs from current availability and document each
  adapter's output-limit and usage mapping before live acceptance.
- Validate the local persistence and export format against the selected stack.
- Keep retrieval and source-support checking as a later design; the MVP can only
  report model opinions about supplied text, not independently verify sources.
