# Product requirements — first personal release

Status: design proposal. No application or live integration is implemented.
Requirement IDs below are stable references for design and later implementation.

## Purpose and decisions

Proofestra gives one person a familiar chat interface with optional independent
answers and cross-review from multiple model providers. It should make material
disagreements and missing evidence visible. Agreement never guarantees accuracy.

**Confirmed by the user:** personal, single-user, self-hosted web application;
bring your own provider credentials; OpenAI, Anthropic, and Gemini supported
together in the first live version; fully Apache 2.0 open-source core.

**Proposed defaults:** local machine deployment, text-only conversations, one
agent per provider in the default team, environment-based credential setup,
local history, and the limits below. These can change before implementation.
The current phase produces requirements, design, and an interactive mockup only.

## Priorities

Must means required before the first personal live release. Should means useful
but can follow that release. Later is deliberately outside the first release.

| ID | Priority | Requirement |
| --- | --- | --- |
| UX-01 | Must | Create and reopen conversations, send text, and read a clear final answer in a familiar chat layout. |
| UX-02 | Must | Select Quick or Team before sending; show participating providers, selected models, planned calls, and active limits. |
| UX-03 | Must | Show concise progress, cancellation, completed stages, missing stages, and a terminal outcome without exposing private reasoning. |
| UX-04 | Must | Keep the final answer prominent; allow expanding initial drafts and review findings with their agent/model labels. |
| UX-05 | Must | Support keyboard operation, visible focus, readable contrast, and progress/error text that does not rely on color alone. |
| AG-01 | Must | Quick uses one selected enabled agent for one draft, with no review or synthesis stage. |
| AG-02 | Must | Team enables two or three configured agents; default to one each from OpenAI, Anthropic, and Gemini. |
| AG-03 | Must | Produce all initial drafts from the same frozen conversation context, without peer drafts in any initial request. |
| AG-04 | Must | After drafting, each successful drafting agent reviews the other available drafts once; then one selected agent synthesizes. |
| AG-05 | Must | A full Team run with n agents plans n drafts + n reviews + one synthesis: 2n+1 calls, seven for the default three-agent team. |
| AG-06 | Must | Reviews identify concise proposed corrections and disagreements; synthesis must preserve material unresolved issues and missing checks. |
| AG-07 | Must | Treat provider output as untrusted text; it cannot change configuration, enable tools, request secrets, or authorize actions. |
| AG-08 | Must | Freeze all prior user/final-answer turns and the current prompt once for every agent. Never silently trim or summarize history per provider. Reject an oversized context before dispatch; preserve a partial result if an unexpected later-stage context overflow occurs. |
| PR-01 | Must | Provide live adapters for OpenAI, Anthropic, and Gemini behind the same invocation and failure interface. |
| PR-02 | Must | Read keys and explicit model IDs from server configuration; UI shows configured/missing status and model names, never raw keys. |
| PR-03 | Must | Start and browse the app without provider calls, model discovery requests, or credentials; real requests require an explicit user send in live mode. |
| PR-04 | Must | Normalize unavailable models, missing keys, authentication errors, rate limits, provider failures, timeouts, and missing usage. |
| PR-05 | Should | Allow choosing other explicitly configured models without editing application code; no automatic switch to a different paid model. |
| CT-01 | Must | Enforce a run-wide call cap, output-token budget, per-call output cap, per-call timeout, overall deadline, and concurrency limit. |
| CT-02 | Must | Reserve a call and its maximum output allowance before scheduling; every dispatched attempt, including retries, consumes the call cap. |
| CT-03 | Must | Retry at most once per step only for an explicitly rejected rate-limit/transient request known not to have begun generation, within all limits; never automatically retry an ambiguously sent request, authentication error, or validation error. |
| CT-04 | Must | Stop scheduling when canceled or out of budget/deadline; cancel outstanding requests where possible and disclose possible provider charges. |
| CT-05 | Must | Preserve usable partial results and distinguish completed, partial, failed, canceled, and interrupted runs; never invent a missing response. |
| CT-06 | Must | Show observed usage separately from estimates and unknown values; never present an estimate as a billing guarantee or unknown monetary usage as $0. |
| EV-01 | Must | Mark model-supplied URLs and citations as unverified; do not claim the app opened or checked them. |
| EV-02 | Must | Use wording such as “team review completed” with its scope; never use an accuracy guarantee, consensus score, or “verified answer” badge. |
| PV-01 | Must | Before live submission, disclose that enabled providers receive the prompt and selected history, and reviewers/synthesizer may receive other agents' output. |
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
| Maximum dispatched calls | Quick: 1; Team: 9 including retries | Quick has no retries; Team plans 5 or 7 calls. Remaining capacity is bounded recovery allowance. |
| Concurrent calls | 3 | Draft and review stages may run in parallel within their stage. |
| Overall deadline | 180 seconds | Includes queueing, retries, and every stage. |
| Per-call timeout | 45 seconds | Also bounded by the remaining overall time. |
| Output per call | 2,048 tokens | Adapter must translate and enforce the provider's supported output limit. |
| Total output allowance | 16,384 tokens | Reserve maximum output for a call before sending it. |
| Safe rejected-request retries | At most 1 per logical step | Only when no generation began; also requires remaining calls, time, and output allowance. |

Release a token reservation using reported usage only when the adapter can safely
account for it. Missing or uncertain usage retains the reserved maximum for limit
accounting, including a timed-out dispatched attempt. Record that conservatism as
an estimate. The nine-call cap does not promise nine full-size outputs: nine times
2,048 exceeds the total output allowance. A retry can therefore be refused even
when call slots remain. Reserve room for required remaining stages before optional
retries so recovery cannot silently consume the synthesis allowance.

On failure, continue only with available material and remaining limits. A Team run
with one draft skips peer reviews and may synthesize within budget; with no draft,
end failed. Any missing planned review, provider failure, or original-draft fallback
means partial, even if synthesis succeeds. If synthesis fails or cannot be scheduled,
show available drafts/findings without calling them a synthesized final answer.
At the overall deadline, abort local work and retain available drafts as partial,
or end failed if none exist. Cancellation stays canceled despite late callbacks.
After a process restart, mark an unfinished run interrupted and do not resubmit
provider requests automatically. Only a full successful planned workflow is completed.

## Acceptance scenarios

| Scenario | Expected result and covered IDs |
| --- | --- |
| A1 — First visit with no keys | Mock chat works; provider status says missing; no startup calls or secret entry field appears. (PR-02/03, DV-01/02) |
| A2 — Quick response | Select Anthropic and send once in live mode after the disclosure. One draft call is planned; result labels that provider and model; no review is implied. (UX-02, AG-01, PV-01) |
| A3 — Full three-provider team | Select all three and a synthesizer. Capture three initial requests containing identical conversation context and no peer output, then three cross-reviews and one synthesis. UI reports all seven completed stages. (AG-02/03/04/05) |
| A4 — Shared mistake or disagreement | Mock drafts agree on an unsupported claim or disagree. Final view preserves uncertainty and unverified citations without an accuracy badge. (AG-06, EV-01/02) |
| A5 — One provider fails | Other drafts survive. Missing drafting/review participation is shown; available synthesis is labeled partial. A failed synthesis leaves labeled drafts/findings. (PR-04, CT-05) |
| A6 — Budget or timeout reached | The next attempt is refused before dispatch if any required allowance is unavailable. All dispatched retries count; missing usage stays conservative; a required synthesis reservation cannot be spent by an optional retry. (CT-01/02/03/06) |
| A7 — Cancel during review | No new call is scheduled; outstanding cancellation is attempted; late output does not change the terminal canceled result; UI explains possible billing for sent requests. (CT-04/05) |
| A8 — Provider output contains instructions | A draft asking for keys or tool execution remains inert content; configuration and permissions stay unchanged. (AG-07, PV-02) |
| A9 — History, export, deletion | Reopen a saved conversation; export its content and provenance without a planted test secret; active deletion is rejected, then succeeds after cancellation reaches terminal state. (PV-03/04/05) |
| A10 — Restart while running | Saved run becomes interrupted and offers a new user-initiated run; no automatic live requests occur. (PR-03, CT-05) |
| A11 — Keyboard and error state | Complete mode selection, send, inspect findings, cancel, and reopen history with keyboard and visible focus; errors remain understandable without color. (UX-01/03/04/05) |
| A12 — Unequal model context windows | Preflight shared history plus instructions, worst-case review/synthesis artifacts, and reserved output against every selected model's configured safe capacity. Reject before dispatch if it cannot fit; never send different hidden histories. An unexpected later overflow preserves partial material and names the missing stage. (AG-03/08, CT-05, PV-01) |

## Explicit non-goals

The first release does not browse the web, fetch citation URLs, read attachments,
run code, invoke external tools, edit files, or send messages. It does not provide
multi-user accounts, internet-facing authentication, subscriptions, local model
hosting, autonomous agents, unlimited review rounds, guaranteed accuracy, or a
provider billing hard cap. No hosted infrastructure is required for core use.

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
