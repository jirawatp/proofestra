# Proofestra

**One chat. Many minds. Better answers.**

Proofestra is a planned open-source AI chat and agent harness. The goal is a
friendly conversation where individually configured agents work independently,
challenge each other's answers, and help the user understand the evidence and
remaining uncertainty. Agents can share a provider or use different providers and
models; each can request bounded helpers and use compatible registered tools.
The design aims to support many providers and tools through an extensible registry.
Skills, plugins and custom MCP servers belong to a shared harness catalog, so
connected providers can use authorized compatible capabilities without separate
manual installations for each vendor.

> **Status: requirements and design.** This repository contains the product
> requirements, technical/API design, and a standalone interactive mockup with
> simulated answers. The production chat application, backend, provider
> integrations, and verification tools are not implemented. There is no package
> or hosted service.

## The experience we want to build

1. Ask a question in a familiar chat interface.
2. Choose one agent for a quick response, or configure a team within your server's limits.
3. Let agents form independent initial answers before seeing their peers' work.
4. Compare claims, investigate disagreements, and check evidence when suitable
   tools or sources are available.
5. Read a consolidated answer with supporting sources, unresolved disagreements,
   limitations, and a clear record of which agents participated.

Every agent has its own identity. Two agents may use the same provider and model,
or different configured models from that provider. An agent can request scoped
subagents within the run's shared permissions, budget, and depth limits. Helper
results stay visible as part of their parent branch, without extra voting weight.

Automatic tool routing selects ready, compatible tools within the task's existing
grants. The agent can use its current profile's tool or, when helpers are enabled,
delegate to a preapproved helper/profile. Tools ON with helpers OFF cannot create
a managed child. Reads, sandbox work, and reversible workspace changes covered by
the grant can proceed without repeated prompts. Actions outside the grant need a
specific approval. This never silently changes a root or synthesizer, adds a
provider destination, installs software, or signs into an account. Run allowlists
stay fixed. Recheck grants before each action; missing scope inside an allowed
route can receive an exact-action approval, without creating a blanket grant.
Broader provider, route, or destination choices need a new user-configured run.

A skill supplies versioned instructions and resources, loaded as needed; loading
it grants no execution permission. A trusted plugin manifest bundles references
to skills, tools, MCP servers and backends. A central MCP broker exposes shared
namespaced tools through each provider's adapter, or an already authorized helper
when the current profile cannot use them. Helper enablement and grants still apply.
Shared registration does not share root-draft scratch, handles or results; each
branch needs isolated tool state or the route is unavailable.
Vendor-exclusive hosted tools and vendor plugin formats do not become universally
compatible. See the [shared extension design](docs/extensions.md).

Multiple models agreeing does **not** guarantee correctness. Models can share
mistakes, cite nonexistent sources, and influence each other. Proofestra should
make uncertainty visible and measure whether review improves answers, rather
than treating consensus as proof.

## Planned open-source core

- Chat interface, conversation history, and portable exports.
- Configurable agent roles, model choices, and provider adapters.
- Extensible tool and execution-backend registries, with automatic scoped routing.
- Shared global/workspace skills, trusted plugin bundles and custom MCP integration.
- Independent drafting, cross-review, and synthesis.
- Bounded subagents with capability checks and explicit native-backend limitations.
- Evidence provenance and transparent verification outcomes.
- User-controlled call limits, timeouts, and cost budgets.
- Self-hosting with users' own provider credentials.

These are planned capabilities, not a list of completed features. Hosted model
providers may charge for usage and apply their own data policies. Self-hosting
the harness would not by itself keep prompts local when remote providers are used.
Provider-managed API tools, client-executed functions/MCP, native SDK/CLI agents,
and hosted agent services have different permissions, accounting, and cancellation
behavior. The user confirmed all tool surfaces in the design: API tools, local
agent apps/SDKs/CLIs, MCP/local tools, and hosted agent services where supported.
Individual integrations remain candidates until tested. No universal model/tool
compatibility or access to another application's signed-in session is promised.

## Start here

To resume work in a new chat, agent, or machine, read
[CONTINUE.md](CONTINUE.md) and the [project history](docs/logs/README.md).
The `codex/project-traceability` branch contains this checkpoint, based on the
latest product design at `7a23553`. It records current state, next work, confirmed
choices, proposed defaults, and dated changes without requiring the original chat.

| Document | Purpose |
| --- | --- |
| [Continue the project](CONTINUE.md) | Portable checkpoint, setup, reading order, next work, and resume prompt |
| [Project logs](docs/logs/README.md) | Requirement, decision, and design history linked to source revisions |
| [Requirements](docs/requirements.md) | Confirmed scope, priorities, and acceptance scenarios |
| [Interactive mockup](docs/prototype/index.html) | Clickable design with simulated answers and no model calls |
| [Experience design](docs/experience.md) | Chat flow, screen states, visual direction, and accessibility |
| [Architecture](docs/architecture.md) | Proposed components, agent workflow, and trust boundaries |
| [Agent policy](docs/agents.md) | Agent identity, model profiles, delegation, and shared limits |
| [Tool policy](docs/tools.md) | Automatic routing, task grants, execution boundaries, and approvals |
| [Shared extensions](docs/extensions.md) | Skills, plugin bundles, custom MCP, namespaces and lifecycle |
| [Provider capabilities](docs/provider-capabilities.md) | Documented integrations, limitations, and validation status |
| [Scaling](docs/scaling.md) | Configurable policy limits and larger-team workflow plans |
| [Technical design](docs/technical-design.md) | Proposed stack, run states, data model, and security boundaries |
| [API design](docs/api.md) | Planned local API semantics and OpenAPI contract |
| [Evaluation plan](docs/evaluation.md) | How to compare Team with single-agent baselines |
| [Decisions](docs/decisions.md) | Confirmed choices, design defaults, and remaining decisions |
| [Design review](docs/design-review.md) | Checks performed and what remains unverified |
| [Roadmap](docs/roadmap.md) | Milestones and acceptance criteria for a first working version |
| [Business model](docs/business-model.md) | Apache 2.0 core and optional commercial services |
| [Contributing](CONTRIBUTING.md) | How to help while the project takes shape |
| [Security](SECURITY.md) | Project status, disclosure, and security design goals |
| [License](LICENSE) | Full Apache License 2.0 text |

To browse the starter locally:

```sh
git clone https://github.com/jirawatp/proofestra.git
cd proofestra
```

No runtime dependencies or API credentials are needed to read the documents or
open `docs/prototype/index.html` directly in a browser. The mockup uses preset
answers, keeps text in the tab's memory, and makes no provider requests. It is a
design artifact, not the implemented chat application.

The first implementation milestone is a working chat flow with deterministic
mock providers and local history. The first live version will support OpenAI,
Anthropic, and Gemini API adapters together, using server-configured keys and
explicit model profiles. Tools and helpers are off in default Quick: one provider
request, no retries or peer review. Opt-in tools/helpers can add work without
implying review. Default Team uses three roots, one per provider, with automatic
tools and helpers enabled; its small all-peer base workflow has seven requests.

Personal defaults allow six roots, 32 harness-dispatched provider requests, 64
observed tool operations, and four native jobs. Server policy can configure other
limits; the demo editor's six-agent cap is only a demo constraint. A native job can
contain unknown internal calls and is never described as one total model call.
Implementation proceeds from mocks to API tools and then validated SDK/CLI
backends. Shared extension versions/digests are pinned for each run; updates cannot
silently replace active definitions. Disabled, revoked, removed or superseded
versions block pending use unless the pinned version is explicitly kept enabled
and authorized. Loaded instructions and completed effects cannot be erased by Stop.
This remains design only: no skill/plugin installation, MCP connection, live tool
execution or paid provider call is performed by these documents or the mockup.

## License and commercial direction

The contents of this repository are licensed under the [Apache License 2.0](LICENSE).
The open-source core is intended to stay fully Apache 2.0, including the chat UI,
orchestration, provider integrations, and verification workflow.

The proposed open-core business model charges for managed hosting, organizational
administration, support, and operational services. Any future proprietary add-ons
would be separately identified and licensed. See the [business model](docs/business-model.md)
for the proposed boundary; no commercial product is currently available.
