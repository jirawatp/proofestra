# Architecture direction

Proofestra is a planned, friendly chat application that lets a user assemble an AI team across model providers. Agents produce independent answers, review material disagreements, and help a synthesizer present an answer with evidence and remaining uncertainty.

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
| Provider adapters | Consistent model invocation, capability reporting, normalized failures, and usage accounting. |
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

## Evidence and evaluation records

Record source URL or document identity, publisher or origin where available, retrieval time, relevant excerpt or location, associated claim, and verification status. Separate a model-supplied citation from a source the application has retrieved and checked. A working URL alone does not establish support for a claim.

Store useful operational records such as stage outcomes, concise findings, latency, model identifier, provider, usage, and estimated cost. Do not request or log private chain-of-thought. Retain user content and source excerpts only under the configured privacy and retention policy.

## Reliability and control

- Apply an overall run deadline plus per-call timeouts, output limits, maximum calls, and a cost or token budget. Cost estimates may differ from provider billing.
- Retry only bounded, eligible transient failures. Account for duplicate requests and avoid silently exceeding the budget.
- Propagate cancellation to outstanding work where supported. Explain when a provider may still process an already-sent request.
- Allow useful partial answers when an agent fails, while showing which agents and review steps completed. Never present a skipped review as completed verification.
- Use explicit stage states such as queued, running, completed, failed, timed out, and canceled. Preserve enough state to explain an incomplete run.
- Keep provider errors separate from answer-quality judgments. Provider availability should not be mistaken for evidence about correctness.

## Privacy and security direction

Before sending content, show which configured providers may receive the prompt, conversation context, attachments, or excerpts. A review stage can transmit another agent's output to an additional provider; include that in the disclosure and controls. Provider retention and training policies must be checked during implementation, not assumed to match each other.

Keep credentials on the server or in user-controlled secure storage, out of browser bundles, exported chats, and logs. Support minimum necessary context, configurable retention, deletion, and redaction. Self-hosting controls application storage; it does not prevent an external model provider from receiving enabled requests.

Tools that can change external state should be a later, separately designed capability with clear user authorization. The first runnable slice should only generate and review text.
