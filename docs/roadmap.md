# Roadmap

This is a proposed development sequence, not a release commitment. The repository is currently a documentation-only starter.

## 1. First runnable slice: deterministic mock team

Build the smallest complete experience before choosing a broad integration surface:

- One local chat screen with a user message, a single-agent mode, and a two-agent review mode.
- Deterministic mock adapters that produce independent first responses, a reviewer finding, and a synthesized result.
- Visible progress, cancellation, one review round, a run deadline, and an explicit call budget.
- Source and uncertainty labels, including a mock unsupported citation that remains unverified.
- A partial-failure case in which one mock agent times out and the final response explains the missing review.
- An export containing the conversation, concise findings, evidence status, and usage summary without credentials or private reasoning traces.

**Done when:** a contributor can run the documented slice, follow a successful and a failed team run, cancel work, and see accurate completion and verification labels. Add focused tests for stage transitions, limit enforcement, cancellation, failure handling, and safe exports.

## 2. Opt-in integration with two providers

- Select two providers based on supported capabilities, privacy controls, cost, and contributor needs. Keep adapters replaceable and model selection configurable.
- Add explicit credential configuration and disclose the content sent to each provider, including cross-provider review content.
- Keep real calls disabled until configured. Preserve mock mode for development and tests without paid requests.
- Normalize streaming or completed responses, provider errors, deadlines, and available usage information.
- Demonstrate independent first answers followed by a bounded review and synthesis.

**Done when:** an opt-in integration run completes with both providers, reports actual usage when available, identifies estimates clearly, and handles either provider being unavailable. No paid calls should be required for the default test suite.

## 3. Measure whether review helps

Create a small versioned evaluation set with factual, reasoning, conflicting-evidence, unanswerable, and misleading-citation cases. Use clear scoring guidance and independent human review where judgment is needed.

Compare the same tasks under a single-model baseline and the team workflow. Record the exact configuration and versions, repeat runs where useful, and report:

- Answer correctness and material error rate.
- Citation validity and whether cited content supports the associated claim.
- Appropriate uncertainty and willingness to leave a question unresolved.
- Latency, token usage, estimated cost, and failure rate.
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
