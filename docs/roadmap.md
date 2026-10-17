# Roadmap

This is a proposed development sequence, not a release commitment. Requirements, technical/API design, and a standalone simulated mockup are available; the application backend and provider integrations are not implemented.

The confirmed scope is personal, single-user self-hosting with OpenAI, Anthropic,
and Gemini together in the first live version. Multiple roots may use the same
provider/profile or different configured profiles; every agent can request bounded
subagents. The latest direction adds many providers/tools through extensible
registries and automatic capability routing inside task grants. The user confirmed
all tool surfaces: API tools, local agent apps/SDKs/CLIs, functions/MCP/local tools,
and supported hosted agent services. Compatibility and activation remain staged.
See [requirements](requirements.md), [tools](tools.md), [agent policy](agents.md),
[scaling](scaling.md), and [decisions](decisions.md). Paid calls remain deferred.

## 1. First runnable slice: deterministic mock team

Build the smallest complete experience before choosing a broad integration surface:

- One local chat screen with Quick/Team, distinct agent/profile/backend identities and repeated providers; six roots is a personal/demo default, not a product ceiling.
- Extensible provider/tool/backend catalogs with readiness, validation versions, lazy bounded top-K selection, and simulated search/code/files/MCP/native jobs.
- Deterministic mock adapters that produce independent first responses, a reviewer finding, and a synthesized result.
- Harness-managed helpers: Quick OFF/Team ON, inherited or preapproved profiles/backends, scoped tool grants, and visible parent/child provenance.
- Automatic compatible current-profile tool use; routing that creates a managed helper requires helpers enabled. Tools ON/helpers OFF cannot create a managed child.
- Atomic spawn validation/deduplication, configurable tree quotas and separate request/tool/native-job ledgers; record native inner visibility rather than assuming a job is one call.
- Waiting parents release slots; reserve child and continuation work while preserving remaining nominal root stages. Enforce the independent root-draft barrier across descendants.
- Visible progress, tree cancellation/restart interruption, one root review round, and honest base versus total invocation counts.
- Source and uncertainty labels separating model-only references, tool retrieval, and claim support.
- Existing grants execute covered reads/sandbox/reversible workspace actions without repeated prompts; missing/revoked/exceeded grants pause on the exact action.
- Freeze route/tool/backend/profile/destination allowlists and initial grant references; recheck current permissions before dispatch. Exact-action approval creates no blanket grant; broader allowlist/provider/destination changes need a new run.
- A partial-failure case in which one mock agent times out and the final response explains the missing review.
- An export containing the conversation, concise findings, evidence status, and usage summary without credentials or private reasoning traces.

**Done when:** mock acceptance covers same-provider twins and different same-provider
profiles, root-ID synthesis, nested delegation, denied spawns without a child or child call,
no deadlock with waiting parents, preserved draft independence, accepted-child
failure labeled partial, full-tree cancellation/restart, and safe exports. Plain
Quick with both tools/helpers OFF stays one request; opt-ins remain unreviewed.
The default small all-peer root plan has seven base requests. Verify separate
observable work units, unknown native usage, stop limitations, strict-policy native
rejection, and catalogs/configurable caps beyond the demo's defaults. Test helper-
disabled tool routing, grant revocation, exact-action approval scope, and effective
provider concurrency rather than hardcoding the personal default.

## 2. Core API adapters and validated API tools

- Add OpenAI, Anthropic, and Gemini adapters together. Support multiple explicit model profiles per provider and harness-managed structured delegation requests; validate each against its current official contract.
- Add capability-driven provider-managed tools and client-executed functions/local MCP in stages. Provider IDs remain extensible; additional plugins/OpenAI-compatible adapters stay candidates until tested.
- Add explicit credential configuration and disclose the content sent to each provider, including cross-provider review content.
- Keep real calls disabled until configured. Preserve mock mode for development and tests without paid requests.
- Normalize streaming or completed responses, provider errors, deadlines, and available usage information.
- Demonstrate independent first answers followed by a bounded review and synthesis.
- Demonstrate inherited/preapproved child profiles, shared usage accounting for every descendant/continuation, and safe denial when any quota is unavailable.
- Validate scoped search/code/file routes, backend-specific API credentials, task grants, prompt-injection resistance, and retrieval/support records. Tool selection alone grants no permission.

**Done when:** opt-in acceptance covers all three adapters in plain Quick, bounded
helpers through each adapter, repeated-provider roots using same/different profiles,
and the default root workflow. Include automatic tools, grant reuse without excess
prompts, child/provider/synthesis failure, profile/tool incompatibility or missing
credentials without execution, and shared limit enforcement. Report actual usage where
available and label estimates. Default tests and this design phase require no paid calls.

## 3. Validate native SDK/CLI and hosted-agent candidates

- Register native execution separately from provider/model identity. Pin backend
  versions and test structured progress, approved auth, scope, deadlines, stop and usage.
- Use a ready native tool when supported; otherwise route through an already
  approved capable backend/helper, or report unsupported. No silent installation,
  authentication, session-token scraping, blanket CLI approval, or root replacement.
- Map native subagent limits honestly. Gemini CLI's documented no-recursion rule
  needs permitted harness nesting or an unsupported result, not claimed parity.
- Count job launches, observed operations and harness requests separately; native
  internal calls/tokens/cost may be unknown. Reject strict-policy jobs lacking
  required scope/deadline controls and disclose cancellation/rollback limits.

**Done when:** each promoted backend passes controlled compatibility/policy checks
and has a dated readiness record. API/SDK/CLI/hosted-service capabilities are never
assumed equivalent. This milestone is not approval to run paid jobs during design.

## 4. Measure review and tool usefulness

Create a small versioned evaluation set with factual, reasoning, conflicting-evidence, unanswerable, and misleading-citation cases. Use clear scoring guidance and independent human review where judgment is needed.

Compare tools/helpers-OFF Quick, root-only Team, helper-enabled Team, and automatic
tool-enabled Team using predeclared profiles, backends and grants. Record exact
configurations, versions, review coverage and separate usage ledgers, and report:

- Answer correctness and material error rate.
- Citation validity and whether cited content supports the associated claim.
- Appropriate uncertainty and willingness to leave a question unresolved.
- Latency, tokens/cost/visibility, failure/denial rate, routing quality, unnecessary prompts, and helper/tool/native work.
- Cases where review introduced an error or confidently repeated a shared mistake.

**Done when:** results are reproducible enough to inspect, limitations are documented, and the team mode's quality and cost tradeoffs are visible. Do not assume that adding agents improves accuracy.

## 5. Measured scaling and everyday use

- Improve retrieval provenance and distinct claim-support checks using evaluation findings.
- Add bounded review fanout/hierarchical synthesis for larger configured teams;
  record exactly which claims/answers were reviewed. The small 2n+1 plan is not universal.
- Load larger catalogs lazily; tune advertised server-policy caps from measurements
  without promising unlimited agents, tools, requests, or opaque native control.
- Improve conversation history, accessibility, provider controls, retention, deletion, and exports.
- Expand supported adapters and team configurations as evaluation evidence justifies them.
- Publish self-hosting documentation and a security review appropriate to the implemented features.

**Done when:** users can understand where an answer came from, what was checked, what remains uncertain, and where their content was sent.

## 6. Sustainable open-core offering

Keep the chat interface, orchestration, provider/tool/backend adapters, scoped routing,
verification, export, evaluation and self-hosting fully available under Apache 2.0.
Contributors and commercial users can use/modify the core without a hosted subscription.

Potential paid offerings include managed hosting, operational support, hosted team administration, enterprise identity integrations, and organization-level operational reporting. Document any future proprietary additions as separately licensed components, with a clear boundary from the Apache-2.0 core.

Choose commercial features after observing actual user needs and hosting costs. Avoid promising guaranteed accuracy or paywalling the core verification capability.
