# Roadmap

This is a proposed development sequence, not a release commitment. Requirements, technical/API design, and a standalone simulated mockup are available; the application backend and provider integrations are not implemented.

The confirmed scope is personal, single-user self-hosting with OpenAI, Anthropic,
and Gemini together in the first live version. Multiple roots may use the same
provider/profile or different configured profiles; every agent can request bounded
subagents. See [requirements](requirements.md), [agent policy](agents.md), and
[design decisions](decisions.md) before implementation. Paid calls remain deferred.

## 1. First runnable slice: deterministic mock team

Build the smallest complete experience before choosing a broad integration surface:

- One local chat screen with Quick and Team (2–6 roots), unique agent IDs, same-provider repeats, and a configurable model-profile catalog.
- Deterministic mock adapters that produce independent first responses, a reviewer finding, and a synthesized result.
- Harness-managed text-only helpers for all adapters and child agents: Quick OFF/Team ON by default, inherited or preapproved profiles, and visible parent/child provenance.
- Atomic spawn validation/deduplication, root/child/depth quotas, one shared invocation/output/deadline budget, and global/per-provider concurrency.
- Waiting parents release slots; reserve child and continuation work while preserving remaining nominal root stages. Enforce the independent root-draft barrier across descendants.
- Visible progress, tree cancellation/restart interruption, one root review round, and honest base versus total invocation counts.
- Source and uncertainty labels, including a mock unsupported citation that remains unverified.
- A partial-failure case in which one mock agent times out and the final response explains the missing review.
- An export containing the conversation, concise findings, evidence status, and usage summary without credentials or private reasoning traces.

**Done when:** mock acceptance covers same-provider twins and different same-provider
profiles, root-ID synthesis, nested delegation, denied spawns without a child or child call,
no deadlock with waiting parents, preserved draft independence, accepted-child
failure labeled partial, full-tree cancellation/restart, and safe exports. Plain
Quick stays one invocation; “Quick + helpers” stays unreviewed. The default three
roots have seven base invocations, while all extra work counts toward shared caps.

## 2. Opt-in integration with all three providers

- Add OpenAI, Anthropic, and Gemini adapters together. Support multiple explicit model profiles per provider and harness-managed structured delegation requests; validate each against its current official contract.
- Add explicit credential configuration and disclose the content sent to each provider, including cross-provider review content.
- Keep real calls disabled until configured. Preserve mock mode for development and tests without paid requests.
- Normalize streaming or completed responses, provider errors, deadlines, and available usage information.
- Demonstrate independent first answers followed by a bounded review and synthesis.
- Demonstrate inherited/preapproved child profiles, shared usage accounting for every descendant/continuation, and safe denial when any quota is unavailable.

**Done when:** opt-in acceptance covers all three adapters in plain Quick, bounded
helpers through each adapter, repeated-provider roots using same/different profiles,
and the default root workflow. Include child/provider/synthesis failure, profile
permission rejection, and shared limit enforcement. Report actual usage where
available and label estimates. Default tests and this design phase require no paid calls.

## 3. Measure whether review helps

Create a small versioned evaluation set with factual, reasoning, conflicting-evidence, unanswerable, and misleading-citation cases. Use clear scoring guidance and independent human review where judgment is needed.

Compare plain Quick, root-only Team, and helper-enabled Team using predeclared
profiles, root identities, and child permissions. Record exact configurations,
versions, and base/total invocation counts, repeat runs where useful, and report:

- Answer correctness and material error rate.
- Citation validity and whether cited content supports the associated claim.
- Appropriate uncertainty and willingness to leave a question unresolved.
- Latency, token usage, estimated cost, failure/denial rate, and extra helper/continuation work.
- Cases where review introduced an error or confidently repeated a shared mistake.

**Done when:** results are reproducible enough to inspect, limitations are documented, and the team mode's quality and cost tradeoffs are visible. Do not assume that adding agents improves accuracy.

## 4. Improve evidence and everyday use

- Add a carefully bounded source-retrieval path with provenance and claim-level citation checks.
- Improve conversation history, accessibility, provider controls, retention, deletion, and exports.
- Expand supported adapters and team configurations as evaluation evidence justifies them.
- Publish self-hosting documentation and a security review appropriate to the implemented features.

**Done when:** users can understand where an answer came from, what was checked, what remains uncertain, and where their content was sent.

## 5. Sustainable open-core offering

Keep the chat interface, orchestration, provider adapters, verification, export, and self-hosting fully available under Apache License 2.0. Contributors and commercial users should be able to use and modify that core without a hosted subscription.

Potential paid offerings include managed hosting, operational support, hosted team administration, enterprise identity integrations, and organization-level operational reporting. Document any future proprietary additions as separately licensed components, with a clear boundary from the Apache-2.0 core.

Choose commercial features after observing actual user needs and hosting costs. Avoid promising guaranteed accuracy or paywalling the core verification capability.
