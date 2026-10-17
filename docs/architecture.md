# Architecture direction

Proofestra is a planned, friendly chat application that lets a user assemble an AI team from the same or different model providers. Distinct agents produce initial answers, review disagreements, and help a synthesizer present an answer with evidence and uncertainty. Eligible agents can request bounded subagents and automatically use compatible tools within the task's grants.

This repository contains planning documents and a standalone simulated design prototype. No production app, provider integration, or verification system has been implemented. The proposed implementation stack, data model, and run semantics are recorded in the [technical design](technical-design.md). The [requirements](requirements.md) distinguish confirmed scope from design defaults.

## Product boundaries

- Keep a familiar conversation interface, with a simple choice between a single-agent response and a configurable team review.
- Make the selected agents, review progress, estimated limits, and failures understandable without exposing internal machinery.
- Let the user inspect concise findings, supporting sources, and unresolved disagreements.
- Never describe agreement, a vote, or an automated review as proof that an answer is correct. Models can share errors.
- Treat model output and retrieved content as untrusted input. Neither can authorize tool actions or change application policy.

## Proposed components

| Component | Responsibility |
| --- | --- |
| Chat interface | Conversations, team configuration, progress, cancellation, and accessible answer presentation. |
| Run coordinator | Run state, independent tasks, review stages, budgets, deadlines, and partial results. |
| Agent tree coordinator | Stable agent identities, user-configured roots, nested helper admission, scoped context, parent return/resume, and tree-wide cancellation. |
| Provider adapters | Consistent model invocation, capability reporting, normalized failures, and usage accounting. |
| Capability/tool registry and router | Versioned provider/profile/backend compatibility, filtered tool selection, readiness, destinations, and automatic scoped routing. |
| Permission service and workers | Existing task grants, concrete missing-scope approvals, supervised SDK/CLI/MCP execution, and supported cancellation. |
| Evidence layer | Source metadata, claim-to-source links, citation verification status, and retrieval boundaries. |
| Synthesis layer | Consolidated answers, concise review findings, disagreements, and uncertainty. |
| Storage and export | User-controlled conversation history, retention, portable exports, and self-hosting settings. |

The chat interface, orchestration, provider adapters, verification features, export, and self-hosting support belong to the Apache-2.0 open-source core.

## Proposed response flow

1. **Configure:** Record the user's request, chosen agents and roles, allowed tools, provider destinations, and run limits.
2. **Answer independently:** Give each answering agent the same relevant user context without revealing the other agents' initial answers. This reduces early anchoring but does not guarantee independence of errors.
3. **Compare:** Identify conflicting claims, unsupported assertions, and areas of agreement. Preserve the initial responses for later evaluation.
4. **Review:** Give reviewers the relevant answers and evidence. Ask for concise findings and source-backed corrections, not private reasoning traces.
5. **Check evidence:** When enabled, inspect available sources against the claims they support. Track whether a citation was actually opened and whether its contents support the claim. Flag inaccessible, stale, or unverified sources.
6. **Synthesize:** Produce a clear answer, explain material disagreements or limitations, and link supporting evidence. Keep unresolved claims visibly unresolved.
7. **Finish or stop:** Save the allowed result and usage summary. A canceled or incomplete run must be labeled accordingly.

Start with one bounded review round. Additional review rounds should require an explicit configuration and remain within the same overall limits.

Provider, model profile, and agent are separate concepts. Users can add multiple
agents with identical or different profiles from one provider. A root or child
may delegate within a run-wide allowlist, depth/node quotas, and shared limits.
Helpers report to parents and do not become extra peer-review votes. Observable
provider requests, tool operations, and native jobs have separate ledgers; opaque
internal work is explicitly unknown. See [agents and subagents](agents.md).

Provider IDs and tool catalogs are extensible. The initial three API adapters are
not a closed list. Tools may run on a provider's servers, in a controlled local
executor, or through a registered SDK/CLI worker. Native tools are not interchangeable;
route by tested capability and compatibility. Prefer the current profile's tool,
then an approved capable helper/backend, without adding destinations or permissions.
See [tool policy](tools.md) and [provider research](provider-capabilities.md).

## Evidence and evaluation records

Record source URL or document identity, publisher or origin where available, retrieval time, relevant excerpt or location, associated claim, and verification status. Separate a model-supplied citation from a source the application has retrieved and checked. A working URL alone does not establish support for a claim.

Store useful operational records such as stage outcomes, concise findings, latency, model identifier, provider, usage, and estimated cost. Do not request or log private chain-of-thought. Retain user content and source excerpts only under the configured privacy and retention policy.

## Reliability and control

- Apply finite deployment limits for managed agents, observed requests/tools, native jobs, deadlines, and output reservations. Report enforceable bounds and usage coverage; estimates may differ from provider billing.
- Retry only bounded, eligible transient failures. Account for duplicate requests and avoid silently exceeding the budget.
- Propagate cancellation to outstanding work where supported. Explain when a provider may still process an already-sent request.
- Allow useful partial answers when an agent fails, while showing which agents and review steps completed. Never present a skipped review as completed verification.
- Use explicit stage states such as queued, running, completed, failed, timed out, and canceled. Preserve enough state to explain an incomplete run.
- Keep provider errors separate from answer-quality judgments. Provider availability should not be mistaken for evidence about correctness.
- Reject opaque native routes when they cannot enforce a required bound. An explicitly permitted bounded job may have unknown internal usage; it is not one total model call.

The earlier six-root and depth-two values are personal defaults. Advertise
configurable server ceilings and reject workflows that cannot fit context or
resource limits. Larger teams need bounded review graphs and synthesis stages;
those extensions are designed separately in [scaling](scaling.md).

## Privacy and security direction

Before sending content, show which configured providers may receive the prompt, conversation context, attachments, or excerpts. A review stage can transmit another agent's output to an additional provider; include that in the disclosure and controls. Provider retention and training policies must be checked during implementation, not assumed to match each other.

Keep credentials on the server or in user-controlled secure storage, out of browser bundles, exported chats, and logs. Support minimum necessary context, configurable retention, deletion, and redaction. Self-hosting controls application storage; it does not prevent an external model provider from receiving enabled requests.

The first runnable slice uses deterministic mocks. Live tools follow compatibility
and permission fixtures. Matching task grants allow useful automatic work,
including reversible workspace work. Missing scope pauses a concrete action for
authorization; an agent cannot approve itself. Provider-hosted execution must be
constrained before dispatch, and SDK/CLI workers need supported policy and auth
integration. Stop prevents new local work and requests remote interruption; it
does not reverse external effects or guarantee remote completion has stopped.
