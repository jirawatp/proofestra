# Continue Proofestra

Checkpoint: 17 October 2026. Start here in a new chat, coding agent, or checkout.
Everything needed for this handoff is committed in the repository; the original
chat, a local ZIP, temporary browser tabs, and machine-specific paths are not needed.

## Get this checkpoint

Repository: [jirawatp/proofestra](https://github.com/jirawatp/proofestra).
Traceability branch: `codex/project-traceability`, created from
[`7a23553`](https://github.com/jirawatp/proofestra/commit/7a235536be0a8df835f2f897a07f5f436eef2bbe).
This branch carries project history, continuation instructions, and subsequent
design revisions; it does not merge itself into `main`. Use the newest checkpoint on the branch and inspect actual Git
status/history before editing.

For a new machine:

```sh
git clone --branch codex/project-traceability https://github.com/jirawatp/proofestra.git
cd proofestra
git status
```

For an existing checkout, preserve local changes first. Fetch the branch, switch
to it, and use a fast-forward-only update when appropriate; never reset unrelated
work to recover this checkpoint. Repository access is enough to read the design;
no model credentials are required.

## Current state

- **Completed:** public repository, full Apache 2.0 core licensing, requirements,
  architecture and API contract, provider capability research, review/evaluation
  plan, and standalone interactive simulated chat design.
- **Not implemented:** the application server, persistent history, real run
  coordinator, live model/tool adapters, credential handling, or production tests.
- **Current interface:** open [the mockup](docs/prototype/index.html) directly in
  a browser. It uses presets, stores chat in tab memory, and makes no provider calls.
  Its demo export is not the future backend's portable export implementation.
- **History:** `7a23553` records the broad tool design; `1374641` adds traceability.
  The containing revision adds shared skills/plugins/custom MCP scope and design.
  Git HEAD and the dated logs identify the latest checkpoint. [Design review](docs/design-review.md) records the checks and limitations;
  historical passes are evidence for that snapshot, not proof that future edits pass.

## Decisions to preserve

The user confirmed a personal self-hosted web app using their own credentials,
with OpenAI, Anthropic, and Gemini together in the first live release. Users may
add multiple agents from the same provider and profile. Eligible agents can spawn
bounded nested helpers. The registry should accommodate many providers and tools.

All tool surfaces are confirmed design scope: built-in API tools, local agent
apps/SDKs/CLIs, functions/MCP/local executors, and supported hosted agent services.
Automatic routing selects a compatible current-profile tool or an approved helper
within existing permissions. Capability selection never grants permission, silently
adds a provider, or replaces the chosen root/synthesizer. Helpers-off must be honored
by managed and native routes. Compatibility is established per adapter in stages.

The user also confirmed shared agent skills, plugin bundles, and custom MCP servers
usable across connected providers. Register once in a global/workspace catalog;
adapters load eligible skill instructions and project shared tools through the
harness broker. Preserve package identity, pinned versions/digests, namespaces,
central secrets, current enablement/grants, and per-root-branch scratch isolation.
Skill content does not grant execution permission. Native import formats and
provider-exclusive tools still require compatible adapters or permitted delegation.

Keep provider, profile, backend, tool, and agent identities separate. Preserve
independent root drafting, scoped children, invocation-scoped spawn deduplication,
bounded scheduling, and cancellation. Matching grants allow automatic work;
missing scope needs a concrete user decision. Agent-controlled tools must not
access the approval control surface. Separate observable requests, tools, jobs,
and unknown native usage. Personal defaults are configurable, not fixed product
ceilings. Agreement and tool retrieval never guarantee correctness.

The entire published core remains Apache 2.0. The commercial direction is optional
managed hosting, administration, support, and separately identified add-ons; no
commercial service or paid model run has been launched.

## Read in this order

1. [Project instructions](AGENTS.md) and [history index](docs/logs/README.md).
2. [Current requirements](docs/requirements.md) and [current decisions](docs/decisions.md).
3. [Architecture](docs/architecture.md), [technical design](docs/technical-design.md),
   [agent policy](docs/agents.md), [tool policy](docs/tools.md),
   [shared extensions](docs/extensions.md), and [scaling](docs/scaling.md).
4. [API semantics](docs/api.md) and [OpenAPI contract](docs/openapi.yaml).
5. [Experience](docs/experience.md), [review evidence](docs/design-review.md),
   [evaluation](docs/evaluation.md), and [roadmap](docs/roadmap.md).

Use the specifications for current behavior and the dated logs for why it changed.
Historical entries do not override later accepted changes or direct user instructions.

## Recommended next work

The next implementation milestone is a mock-backed personal chat app with local
history and a durable run state machine. This is the next proposed task, not code
already present. The design default is TypeScript, React/Vite, Fastify/Node, SQLite,
and REST with SSE; dependencies, explicit versions, and a SQLite driver are still
to be selected. Future source layout is described in the technical design.

Start with deterministic adapters and a complete chat/history/run flow. Derive
validation and types from the contract. Preserve same-provider identities,
root-draft isolation, cancellation/restart interruption, idempotency, budgets,
tool routing/grants, and export provenance as the coordinator is added. Use the
stable acceptance scenarios A1–A25 and requirement IDs to select meaningful tests.
The shared-extension slice adds EX-01–EX-08: use deterministic skills, plugin
bundles, and custom MCP fixtures before installing or connecting real packages.
Do not equate the browser mock's timers/state with a durable backend implementation.

Live integration follows the mock milestone. Check current official documentation,
pin model/SDK profiles, and test supported authentication, tool compatibility,
permission boundaries, usage visibility, and cancellation before promoting an
adapter. Provider documentation checked on 17 October 2026 is research evidence,
not a permanent availability guarantee. No credentials or paid runs are needed
to continue the design or mock implementation.

## Open implementation choices

| Choice | Current position |
| --- | --- |
| Runtime, packages, SQLite driver/migrations | Stack is proposed; pin versions and choose a driver at implementation. |
| Exact models and native backends | Broad scope confirmed; actual profiles, auth, compatibility and admission need validation. |
| Approval isolation | Required boundary; choose and test an implementation outside agent-operated UI/CLI access. |
| Shared extension formats and broker | Skill loader, manifest/import adapters, supported MCP protocol versions/transports, lifecycle and branch isolation remain to implement and test. |
| Deployment limits and price data | Personal defaults only; measure before tuning and report unknown costs honestly. |
| Large-team review | All-peer small-team baseline; bounded review/hierarchical synthesis need separate fixtures. |
| Commercial features | Preserve Apache 2.0 core; select optional offerings after user and cost evidence. |

## Keep the next handoff current

For each material scope, decision, or design change, update the current spec and
append a stable-ID entry to the appropriate [log](docs/logs/README.md). Reference
requirements, affected files, evidence/validation, and any superseded log entry.
Record the actual result and unresolved work here before handing off. Commit and
push the requested branch, then verify the remote revision; a local-only commit
is not available on another machine. Do not put secrets, private chats, runtime
traces, or local absolute paths into the public handoff.

## Prompt for another chat or agent

> Continue the Proofestra repository at `jirawatp/proofestra`, branch
> `codex/project-traceability`. Read `AGENTS.md`, `CONTINUE.md`, and `docs/logs/README.md`,
> inspect Git status and history, then read the relevant current specifications.
> The project currently has requirements/design and a simulated interface; there
> is no live backend or provider integration. Preserve confirmed scope and Apache
> 2.0 core licensing. Follow my current request, record material changes with stable
> requirement/log references, validate the changed work, and update the handoff.
