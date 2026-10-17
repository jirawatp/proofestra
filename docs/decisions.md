# Design decisions

Recorded 17 October 2026. This file separates the user's decisions from proposed
engineering defaults. Requirements and design do not establish implementation.

## Confirmed direction

| Decision | Consequence |
| --- | --- |
| Personal, single-user, self-hosted web app | Start with one local instance; no account system or billing in the first version. |
| Bring your own API credentials | Keys remain on the server; provider use may be billed by the provider. |
| OpenAI, Anthropic, Gemini together in the first live version | All three adapters are release requirements, even though individual runs can use fewer providers. |
| Multiple agents may share a provider | Agent IDs are independent of provider/model; same-provider agents can share a profile or select different configured models. |
| Every agent can request subagents | All three adapters support the same harness-managed delegation; child agents can also delegate within shared limits. |
| Broad provider/tool coverage and automatic use of agent tools | Use extensible capability registries; individual provider/model/tool combinations need validation before availability is claimed. |
| All provider tool surfaces in design scope | Cover built-in API tools, local agent apps/SDKs/CLIs, functions/MCP/local executors, and supported hosted agent services; activate tested integrations in stages. |
| Friendly chat with independent cross-review | Keep final answers readable and make drafts, findings, uncertainty, and failures inspectable. |
| Full Apache 2.0 core | UI, orchestration, adapters, verification, history/export, self-hosting, and evaluation stay open. |

## Proposed defaults for implementation

The user confirmed all tool surfaces, including API tools and SDK/CLI agent
backends. Hosted agent services are also in design scope; individual integrations
remain candidates until validated. The three core API adapters remain the first
live milestone; API tools precede validated SDK/CLI and hosted backends.

| Default | Reason |
| --- | --- |
| Separate provider, profile, backend and agent identities | Repeat providers/models freely; agent IDs address roots and synthesis. Backends declare different execution/credential boundaries. |
| Default three roots and one all-peer review round | Seven base root requests; 2n+1 applies only to this small-team plan. Larger bounded fanout/hierarchical plans must record coverage. |
| Quick tools/helpers OFF; Team tools AUTO and helpers ON | Quick has exactly one observable request/no retry only when both are OFF; opt-ins add work without root peer review. |
| Automatic capability routing within prior grants | Use ready current-profile tools; fallback creating a managed helper requires helpers enabled. Tools ON/helpers OFF creates no managed child; never silently change roots, synthesis, destinations, installs or authentication. |
| Lazy bounded top-K tool selection | Registry breadth must not load every tool into every prompt; selection is separate from permission. |
| Reuse matching task grants | Covered reads, sandbox and reversible workspace work proceed automatically. Pause only on missing/revoked/exceeded grants or consequential actions outside them. |
| Fixed allowlists, current permission checks | Freeze route/tool/backend/profile/destination allowlists and initial grant references. Recheck validity/revocation before dispatch; exact-action approval inside those routes creates no blanket grant. Broader allowlist/provider/destination choices need a new user-configured run. |
| Inherit child profile/backend and narrowed scope | Alternates need user preapproval; tool/model output cannot expand permissions or destinations. |
| Backend-specific server credential setup; mock default | API keys, approved SDK/CLI account flows and local MCP have different requirements; no other-app session scraping or blanket approval modes. |
| Personal defaults: 32 requests, 64 observed tool operations, 4 native jobs | Separate ledgers; root/child/continuation/retry requests count when observable. Native inner model/tool counts may be unknown; one job is not one total call. |
| Personal managed-tree defaults: 6 roots, 12 total, 6 spawned, 2 children/parent, depth 2 | Configurable finite caps cover managed nodes, not opaque native inner agents; the demo's six-root editor cap does not constrain the product. |
| Concurrency 3 global/2 per provider; run 300s; request 45s; native job 120s | Controls cover observable harness work; native scope/deadline support is checked, otherwise strict policy refuses the job. |
| Output 2,048/request and 65,536 total | Bound observable scheduling/requested output; report native inner tokens/cost as unknown when unavailable. No opaque internal cap or rollback guarantee. |
| Reserve remaining root work before accepting children | A spawn needs room for child work and parent continuation. Waiting parents release slots so children can progress. |
| React/Vite + TypeScript, Fastify/Node, SQLite | One local application process with simple persistence and explicit run control. |
| Stage events over SSE | Reload/reconnect can recover progress without duplicating model calls. |
| One global active run | Simpler personal cost and concurrency control. |
| Entire visible history or explicit context rejection | Every agent sees the same frozen history; no hidden trimming. |
| Local history until deliberate deletion | No hidden retention service or automatic data upload; backups/exports remain the user's responsibility. |
| Search, code, files, functions/MCP and native tools inside explicit grants | Retrieval status is separate from claim support; retrieved sources are not automatically verified evidence. |

Detailed limits and failure semantics are in [requirements](requirements.md) and
[agent policy](agents.md). The scheduler deduplicates spawn callbacks; denial is a
notice without a child or additional provider call; the requesting call still
counts, as does any subsequent parent continuation. An accepted child's failure
makes the run partial. Stop prevents new harness work and attempts whole-tree/job
cancellation; native inner work may remain unconfirmed and completed actions are
not rolled back. Restart interrupts active work without automatic resume.

Native capabilities do not have identical semantics. In particular, documented
[Gemini CLI subagents](https://geminicli.com/docs/core/subagents/) cannot spawn
other subagents. Use approved harness-managed nesting or report unsupported.
Additional provider plugins and OpenAI-compatible adapters remain candidates until
contract tests pass. See [tool policy](tools.md), [scaling](scaling.md), and
[provider capabilities](provider-capabilities.md). Choices remain provisional.

## Remaining implementation decisions

- Choose explicit currently available model profiles and confirm safe input/output
  capacities, tool/delegation capabilities, backend mappings and SDK versions.
- Validate each API/SDK/CLI/MCP/hosted connector's compatibility, approved
  credentials, execution grants, internal usage visibility and stop behavior.
- Pin compatible runtime/dependency versions and choose a SQLite driver/migration
  implementation. No packages are installed by these design documents.
- Validate proposed limits, same-provider controls, parent/child visibility,
  lazy catalogs, automatic routing, grant boundaries and native jobs through mocks.
- Add a versioned price table only if useful; show unknown cost honestly until then.
- Review provider data handling for the actual API products/accounts selected.

No model credentials or paid evaluation are needed to review the design. The next
build milestone is the mock-backed chat, persistent local history, and run state
machine. Live adapters follow once those behaviors are checked. See [roadmap](roadmap.md).
